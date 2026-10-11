"""Trusted operator host for an existing shell/files agent, with no model API.

The candidate gets the public bundle and the standalone call.py helper only.
The operator keeps the installed core and private output. This is an
instruction-level boundary, not an OS sandbox or a cryptographic attestation.
"""
import copy
import hashlib
import math
from pathlib import Path, PurePosixPath
import shutil
import time
import uuid

from . import __version__
from .agent_call import (BridgeDirectory, PROTOCOL, REQUEST_ID,
                         bridge_supported, checked_path, json_bytes, strict_json)
from .io import artifact, load_fixture, public_resources, sha256_file, write_json
from .model import CandidateResult, ProviderInfo
from .providers import public_final_schema
from .runner import run
from .scoring import score, summarize
from .tools import LocalSession, utc_now

RECEIPT_SCHEMA = "officekit-agent-host-receipt-v1"
PROVENANCE_SCHEMA = "officekit-agent-host-provenance-v1"


class AgentEnvironmentError(RuntimeError):
    def __init__(self, message, status="UNKNOWN"):
        super().__init__(message)
        self.environment_status = status


def _verify_bundle(bundle):
    # Imported lazily: public packaging reads the standalone helper resource.
    from .agent_packages import verify_agent_bundle
    return verify_agent_bundle(bundle)


def _positive(value, label, upper):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= upper:
        raise ValueError(f"{label} must be finite, positive, and no greater than {upper}")


def _roots(public_bundle, private_output):
    public = checked_path(public_bundle, directory=True)
    private = checked_path(private_output, directory=True, allow_missing=True)
    if public == private or public.is_relative_to(private) or private.is_relative_to(public):
        raise ValueError("Operator private output and public bundle must be disjoint directories")
    return public, private


def _environment():
    supported = bridge_supported()
    return {"status": "SUPPORTED" if supported else "UNSUPPORTED",
            "requires": ["python3", "shell", "public file read/write", "running trusted operator host", "POSIX dir_fd/O_NOFOLLOW/flock"],
            "transport": "LOCAL_SYNTHETIC_TOOL_EXECUTION", "live_model": "UNKNOWN",
            "live_services": "UNKNOWN", "external_agent_identity": "UNKNOWN",
            "model_calls": "UNKNOWN", "core_model_calls": 0,
            "isolation": "INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX",
            "candidate_access": "Public bundle, public inputs, call.py, and .bridge only; do not inspect the installed core, private operator run, evaluator, or reference provider"}


def validate_final(value):
    """Validate the public candidate schema without dependencies or coercions."""
    required = {"artifacts", "completed_actions", "facts", "text"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Final result must have exactly artifacts, completed_actions, facts, and text")
    if not isinstance(value["artifacts"], list) or any(not isinstance(item, str) for item in value["artifacts"]):
        raise ValueError("Final artifacts must be an array of relative path strings")
    if len(set(value["artifacts"])) != len(value["artifacts"]):
        raise ValueError("Final artifacts must be unique")
    for item in value["artifacts"]:
        path = PurePosixPath(item)
        if not item or path.is_absolute() or ".." in path.parts or path.as_posix() != item or "\\" in item:
            raise ValueError("Final artifacts must be canonical relative POSIX paths")
    if not isinstance(value["completed_actions"], list):
        raise ValueError("Final completed_actions must be an array")
    for action in value["completed_actions"]:
        if not isinstance(action, dict) or set(action) != {"tool", "event_id", "resource_id"} or any(not isinstance(item, str) for item in action.values()):
            raise ValueError("Final action bindings require only string tool, event_id, and resource_id")
    if not isinstance(value["facts"], dict) or not isinstance(value["text"], str):
        raise ValueError("Final facts must be an object and text a string")
    json_bytes(value)
    return CandidateResult(**copy.deepcopy(value))


class FileAgentProvider:
    info = ProviderInfo("external-agent", "external-agent-file-tool-session", verified_backend="UNKNOWN")

    def __init__(self, bundle, run_id, public_hash, timeout=900, poll_interval=0.05):
        self.bundle = bundle
        self.run_id = run_id
        self.public_hash = public_hash
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.environment_status = "UNKNOWN"
        self.final_accepted = False
        self.request_count = 0
        self.deduplicated_requests = 0
        self._bridge = None

    def _response(self, request_id, kind, **fields):
        return {"protocol": PROTOCOL, "run_id": self.run_id,
                "request_id": request_id, "type": kind, **fields}

    def _reject(self, session, request_id, message):
        response = session.call("__protocol.invalid_agent_request__", {"reason": message})
        return self._response(request_id, "rejected", response=response)

    def _handle(self, session, value):
        request_id = value.get("request_id") if isinstance(value, dict) else None
        if not isinstance(value, dict):
            return self._reject(session, None, "Bridge request root must be a JSON object"), None
        base = {"protocol", "run_id", "request_id", "op"}
        if value.get("protocol") != PROTOCOL or value.get("run_id") != self.run_id or not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            return self._reject(session, request_id if isinstance(request_id, str) else None, "Bridge protocol, run_id, or request_id is invalid"), None
        if value.get("op") == "final" and set(value) == base | {"result"}:
            try:
                final = validate_final(value["result"])
            except (ValueError, TypeError, RecursionError) as exc:
                return self._reject(session, request_id, str(exc)), None
            return self._response(request_id, "accepted", accepted=True), final
        if value.get("op") == "tool" and set(value) == base | {"tool", "arguments"} and isinstance(value["tool"], str) and isinstance(value["arguments"], dict):
            response = session.call(value["tool"], value["arguments"])
            return self._response(request_id, "tool_result", response=response), None
        return self._reject(session, request_id, "Expected one strict tool request or structured final result"), None

    def execute(self, session):
        environment = _environment()
        provenance = {"schema_version": PROVENANCE_SCHEMA, "issuer": "officekit-trusted-operator-host",
                      "run_id": self.run_id, "case_id": session.case_id,
                      "public_manifest_sha256": self.public_hash,
                      "evidence_provenance": "LOCAL_EXECUTED",
                      "candidate_isolation": "INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX"}
        write_json(session.root / "host_provenance.json", provenance)
        if environment["status"] != "SUPPORTED":
            self.environment_status = "UNSUPPORTED"
            raise AgentEnvironmentError("No supported no-follow local file bridge is available", "UNSUPPORTED")
        bridge_path = self.bundle / ".bridge"
        # Fresh bridge creation is a single-host claim. Never reuse prior traffic.
        checked_path(bridge_path, directory=True, allow_missing=True)
        bridge_path.mkdir(mode=0o700)
        cache = {}
        seen_raw = None
        last_response = None
        deadline = time.monotonic() + self.timeout
        try:
            with BridgeDirectory(bridge_path) as bridge:
                self._bridge = bridge
                ready = {"type": "ready", "protocol": PROTOCOL, "run_id": self.run_id,
                         "case_id": session.case_id, "prompt": session.prompt,
                         "tools": session.tool_descriptions, "max_tool_calls": session.max_tool_calls,
                         "final_result_schema": public_final_schema(), "environment": environment,
                         "instructions": "Use python3 call.py tool NAME '{...}' and inspect the real response before the next request. End with python3 call.py final '{...}' or final @submission/candidate.json. Use one agent and one in-flight request. For transport retry reuse the identical request_id; for an actual tool retry use a new request_id and the same service idempotency_key. Final artifacts are relative path strings from file.artifact or files[].artifact. The host acknowledges final acceptance only; grading is private to the operator."}
                bridge.write("ready.json", ready)
                bridge.write("status.json", {"protocol": PROTOCOL, "run_id": self.run_id, "status": "RUNNING"})
                self.environment_status = "SUPPORTED"
                while time.monotonic() < deadline:
                    raw = bridge.read("request.json", missing=True)
                    if raw is None:
                        time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
                        continue
                    digest = hashlib.sha256(raw).hexdigest()
                    if digest == seen_raw:
                        if last_response is not None and bridge.read("response.json", missing=True) is None:
                            self.deduplicated_requests += 1
                            bridge.write("response.json", last_response)
                        time.sleep(min(self.poll_interval, max(0, deadline - time.monotonic())))
                        continue
                    seen_raw = digest
                    try:
                        value = strict_json(raw)
                    except (ValueError, UnicodeError, RecursionError):
                        value = None
                    request_id = value.get("request_id") if isinstance(value, dict) else None
                    fingerprint = hashlib.sha256(json_bytes(value)).hexdigest() if value is not None else digest
                    if isinstance(request_id, str) and request_id in cache:
                        previous_fingerprint, response = cache[request_id]
                        if fingerprint == previous_fingerprint:
                            self.deduplicated_requests += 1
                            last_response = response
                            bridge.write("response.json", response)
                            continue
                        response = self._reject(session, request_id, "request_id cannot be reused with changed request contents")
                        self.request_count += 1
                        response["request_sha256"] = fingerprint
                        last_response = response
                        bridge.write("response.json", response)
                    else:
                        response, final = self._handle(session, value)
                        self.request_count += 1
                        response["request_sha256"] = fingerprint
                        last_response = response
                        if isinstance(request_id, str) and REQUEST_ID.fullmatch(request_id):
                            cache[request_id] = fingerprint, response
                        bridge.write("response.json", response)
                        if final is not None:
                            self.final_accepted = True
                            return final
                    if len(session.ledger) > session.max_tool_calls:
                        raise AgentEnvironmentError("Bounded agent request/tool budget exhausted before a valid final")
                raise AgentEnvironmentError("Trusted operator host timed out before a structured final", "UNKNOWN")
        except Exception as exc:
            self.environment_status = getattr(exc, "environment_status", "UNKNOWN")
            raise
        finally:
            self._bridge = None
            try:
                with BridgeDirectory(bridge_path) as bridge:
                    bridge.write("status.json", {"protocol": PROTOCOL, "run_id": self.run_id,
                                 "status": "CLOSED" if self.final_accepted else self.environment_status})
            except (OSError, ValueError):
                pass  # Never erase an already executed ledger or mask a prior error.


def _manifest(root):
    return {"schema_version": "0.5.0", "hash_algorithm": "sha256",
            "artifacts": [artifact(root, path) for path in sorted(root.rglob("*"))
                          if path.is_file() and path not in (root / "manifest.json", root / "host_receipt.json")],
            "self_hash_excluded": True, "host_receipt_excluded": True}


def host_agent(public_bundle, private_output, max_tool_calls=32, timeout=900, poll_interval=0.05):
    """Block serving bounded real LocalSession calls, then return private report.

    No subprocess controller or model is created. Launch this as the trusted
    operator, give the existing agent only the public directory, then retain
    the returned host_receipt (or host_receipt.json) on the operator side.
    """
    if isinstance(max_tool_calls, bool) or not isinstance(max_tool_calls, int) or not 1 <= max_tool_calls <= 32:
        raise ValueError("Agent host max_tool_calls must be an integer in 1..32")
    _positive(timeout, "Host timeout", 86400)
    _positive(poll_interval, "Poll interval", 10)
    bundle, private = _roots(public_bundle, private_output)
    case_id, _ = _verify_bundle(bundle)
    if private.exists():
        raise ValueError("Output directory must be fresh and nonexistent; existing evidence is never overwritten")
    if (bundle / ".bridge").exists() or (bundle / ".bridge").is_symlink():
        raise ValueError("Public bridge directory must be fresh; another host or prior run already owns it")
    public_hash = sha256_file(bundle / "AGENT_TASK_MANIFEST.json")
    run_id = uuid.uuid4().hex
    provider = FileAgentProvider(bundle, run_id, public_hash, timeout, poll_interval)
    report = run(case_id, provider, private, max_tool_calls=max_tool_calls)
    # Operator-only metadata and receipts are never returned by the bridge.
    report["run_id"] = run_id
    report["agent_bridge"] = {"protocol": PROTOCOL, "run_id": run_id,
                              "environment_status": provider.environment_status,
                              "final_accepted": provider.final_accepted,
                              "max_tool_calls": max_tool_calls,
                              "host_timeout_seconds": timeout,
                              "timing_scope": "HOST_WAIT_WINDOW_NOT_MODEL_LATENCY",
                              "unique_requests": provider.request_count,
                              "deduplicated_requests": provider.deduplicated_requests,
                              "public_manifest_sha256": public_hash,
                              "receipt_trust": "OPERATOR_RETAINED_PRIVATE_RUN_NOT_CRYPTOGRAPHIC_ATTESTATION"}
    if report.get("candidate_error"):
        report["candidate_error"]["environment_status"] = provider.environment_status
    write_json(private / "report.json", report)
    write_json(private / "manifest.json", _manifest(private))
    receipt = {"schema_version": RECEIPT_SCHEMA, "issuer": "officekit-trusted-operator-host",
               "run_id": run_id, "case_id": case_id, "public_manifest_sha256": public_hash,
               "run_manifest_sha256": sha256_file(private / "manifest.json"),
               "report_sha256": sha256_file(private / "report.json"),
               "evidence_provenance": "LOCAL_EXECUTED",
               "trust_boundary": "Operator must supply the original private run and its retained host-issued receipt; candidate-authored ledger, state, report, or receipt is not evidence. Hash binding detects changes, not forgery by someone with private operator filesystem access."}
    write_json(private / "host_receipt.json", receipt)
    # The return is operator-only. Don't insert the receipt into report.json:
    # report and manifest hashes must be acyclic and independently checkable.
    return {**report, "host_receipt": receipt}


def _load(path):
    path = checked_path(path)
    if path.stat().st_size > 10_000_000:
        raise ValueError("Private evidence exceeds bounded read size")
    return strict_json(path.read_bytes())


def verify_host_receipt(public_bundle, private_output, receipt_path=None):
    """Verify only an operator-selected private host run, never a submission.

    An optional separately retained receipt pins the run against later edits.
    Hashes are not signatures. The operator's private-directory provenance is
    the trust root; no candidate claim can convert an import into LOCAL_EXECUTED.
    """
    bundle, private = _roots(public_bundle, private_output)
    checked_path(private, directory=True)
    case_id, fixture = _verify_bundle(bundle)
    stored = _load(private / "host_receipt.json")
    if receipt_path is not None:
        selected = checked_path(receipt_path)
        if selected.is_relative_to(bundle):
            raise ValueError("A candidate public submission cannot supply the trusted operator receipt")
        if _load(selected) != stored:
            raise ValueError("Operator-retained receipt does not match the private host run")
    required = {"schema_version", "issuer", "run_id", "case_id", "public_manifest_sha256", "run_manifest_sha256", "report_sha256", "evidence_provenance", "trust_boundary"}
    if not isinstance(stored, dict) or set(stored) != required or stored.get("schema_version") != RECEIPT_SCHEMA or stored.get("issuer") != "officekit-trusted-operator-host" or stored.get("evidence_provenance") != "LOCAL_EXECUTED" or stored.get("case_id") != case_id or not isinstance(stored.get("run_id"), str) or not re_full_run_id(stored["run_id"]):
        raise ValueError("Expected a host-issued private operator receipt")
    if stored["public_manifest_sha256"] != sha256_file(bundle / "AGENT_TASK_MANIFEST.json") or stored["run_manifest_sha256"] != sha256_file(private / "manifest.json") or stored["report_sha256"] != sha256_file(private / "report.json"):
        raise ValueError("Host receipt hash binding does not match public or private evidence")
    manifest = _load(private / "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("hash_algorithm") != "sha256" or not isinstance(manifest.get("artifacts"), list):
        raise ValueError("Private host manifest is malformed")
    listed = set()
    for item in manifest["artifacts"]:
        if not isinstance(item, dict) or set(item) != {"kind", "artifact", "sha256", "bytes"} or not isinstance(item.get("artifact"), str):
            raise ValueError("Private host manifest artifact is malformed")
        relative = item["artifact"]
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts or path.as_posix() != relative or relative in listed or "\\" in relative:
            raise ValueError("Private manifest contains an escaping or duplicate path")
        listed.add(relative)
        target = checked_path(private / relative)
        if artifact(private, target) != item:
            raise ValueError("Private host artifact integrity mismatch")
    actual = set()
    for target in private.rglob("*"):
        checked_path(target, directory=target.is_dir())
        if target.is_file() and target not in (private / "manifest.json", private / "host_receipt.json"):
            actual.add(target.relative_to(private).as_posix())
    if listed != actual or not {"host_provenance.json", "report.json", "candidate.json", "ledger.json", "state.json", "fixture.json", "prompt.txt", "tools.json", "replay.json"} <= listed:
        raise ValueError("Private host evidence is incomplete or contains unbound files")
    provenance = _load(private / "host_provenance.json")
    if not isinstance(provenance, dict) or provenance.get("schema_version") != PROVENANCE_SCHEMA or provenance.get("issuer") != stored["issuer"] or provenance.get("run_id") != stored["run_id"] or provenance.get("case_id") != case_id or provenance.get("public_manifest_sha256") != stored["public_manifest_sha256"] or provenance.get("evidence_provenance") != "LOCAL_EXECUTED":
        raise ValueError("Private host provenance is not bound to the receipt")
    report = _load(private / "report.json")
    if not isinstance(report, dict) or report.get("run_id") != stored["run_id"] or report.get("case_id") != case_id or report.get("evidence_provenance") != "LOCAL_EXECUTED" or report.get("provider", {}).get("name") != "external-agent" or report.get("core_model_calls") != 0 or report.get("model_calls") != "UNKNOWN" or report.get("agent_bridge", {}).get("public_manifest_sha256") != stored["public_manifest_sha256"]:
        raise ValueError("Expected an external-agent host report bound to this receipt")
    resources = public_resources(case_id)
    if _load(private / "fixture.json") != fixture or (private / "prompt.txt").read_bytes() != resources.joinpath("prompt.txt").read_bytes() or _load(private / "tools.json") != _load(bundle / "tools.json"):
        raise ValueError("Private host task contract does not match the fixed public case")
    for name in fixture["input_files"]:
        if (private / "inputs" / name).read_bytes() != resources.joinpath(name).read_bytes():
            raise ValueError("Private host input does not match the fixed public case")
    ledger = _load(private / "ledger.json")
    state = _load(private / "state.json")
    final = _load(private / "candidate.json")
    if not isinstance(ledger, dict) or ledger.get("evidence_provenance") != "LOCAL_EXECUTED" or not isinstance(ledger.get("events"), list) or not isinstance(state, dict):
        raise ValueError("Private executed ledger/state is malformed")
    validate_final(final)
    return {**report, "host_receipt": stored}


def re_full_run_id(value):
    return len(value) == 32 and all(char in "0123456789abcdef" for char in value)


def _retain_observations(result, candidate_error):
    if not candidate_error:
        return result
    for item in result["atoms"]:
        if item["dimension"] == "business" and item["status"] in ("PASS", "FAIL"):
            continue
        if item["status"] == "FAIL" and item["id"] in ("protocol.offered_tools", "safety.forbidden_effects"):
            continue
        item.update(status="UNKNOWN", error_class="INSTRUMENTATION")
    return summarize(result["atoms"])


def grade_host_agent(public_bundle, private_output, output, receipt_path=None):
    """Independently score immutable verified host evidence with the core rubric."""
    verified = verify_host_receipt(public_bundle, private_output, receipt_path)
    bundle, private = _roots(public_bundle, private_output)
    destination = checked_path(output, directory=True, allow_missing=True)
    if destination.exists():
        raise ValueError("Output directory must be fresh and nonexistent")
    if destination.is_relative_to(bundle) or destination.is_relative_to(private) or bundle.is_relative_to(destination) or private.is_relative_to(destination):
        raise ValueError("Independent grading output must be separate from public and private runs")
    started_at, started_ns = utc_now(), time.perf_counter_ns()
    destination.mkdir(parents=True)
    fixture = load_fixture(verified["case_id"])
    # Copy only hash-verified evidence selected from the operator private run.
    manifest = _load(private / "manifest.json")
    for item in manifest["artifacts"]:
        if item["artifact"] == "report.json":
            continue
        target = destination / item["artifact"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(checked_path(private / item["artifact"]), target)
        if artifact(destination, target) != item:
            raise ValueError("Private host evidence changed while preparing independent grading")
    final = _load(destination / "candidate.json")
    session = LocalSession(destination, fixture, (destination / "prompt.txt").read_text(encoding="utf-8"), _load(destination / "tools.json"))
    session.ledger = _load(destination / "ledger.json")["events"]
    session.state = _load(destination / "state.json")
    result = _retain_observations(score(destination, session, final), verified.get("candidate_error"))
    report = {"schema_version": "0.5.0", "kit_version": __version__, "case_id": verified["case_id"],
              "run_id": verified["run_id"], "run_kind": "INDEPENDENT_VERIFIED_AGENT_HOST_GRADE",
              "provider": verified["provider"], "model_calls": "UNKNOWN", "core_model_calls": 0,
              "external_model_calls": "UNKNOWN", "evidence_provenance": "LOCAL_EXECUTED",
              "candidate_isolation": "INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX",
              "live_model_capability": "UNKNOWN", "live_service_capability": "UNKNOWN",
              "candidate_error": verified.get("candidate_error"), "agent_bridge": verified["agent_bridge"],
              "source_host_receipt": verified["host_receipt"], "old_release_modified": False,
              "rank_stability": "NOT_MEASURED", "result": result,
              "timing": {"started_at": started_at, "finished_at": utc_now(), "duration_ns": time.perf_counter_ns() - started_ns,
                         "clock": "perf_counter_ns", "boundary": "Independent verified private-evidence scoring; excludes external agent execution"},
              "raw_artifacts": [artifact(destination, path) for path in sorted(destination.rglob("*")) if path.is_file()]}
    write_json(destination / "report.json", report)
    write_json(destination / "manifest.json", _manifest(destination))
    return report
