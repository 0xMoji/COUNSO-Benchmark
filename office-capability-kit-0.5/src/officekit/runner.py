import json
import platform
import sys
import time
from dataclasses import asdict
from pathlib import Path
from . import __version__
from .io import artifact, load_fixture, public_resources, write_json
from .registry import REGISTRY
from .scoring import score
from .tools import LocalSession, utc_now


def run(case_id, provider, output, max_tool_calls=32):
    if case_id not in REGISTRY:
        raise ValueError(f"Unknown case: {case_id}")
    if REGISTRY[case_id]["family"] == "ui":
        raise ValueError("UI registry entry is reserved for its independent adapter; real browser acceptance is UNKNOWN")
    root = Path(output).absolute()
    if root.exists():
        raise ValueError("Output directory must be fresh and nonexistent; existing evidence is never overwritten")
    started_at, started_ns = utc_now(), time.perf_counter_ns()
    root.mkdir(parents=True)
    fixture = load_fixture(case_id)
    resources = public_resources(case_id)
    prompt = resources.joinpath("prompt.txt").read_text(encoding="utf-8")
    descriptions = json.loads(resources.joinpath("tools.json").read_text(encoding="utf-8"))
    for name in fixture["input_files"]:
        destination = root/"inputs"/name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(resources.joinpath(name).read_bytes())
    (root/"prompt.txt").write_text(prompt, encoding="utf-8")
    write_json(root/"tools.json", descriptions)
    write_json(root/"fixture.json", fixture)
    session = LocalSession(root, fixture, prompt, descriptions, max_tool_calls=max_tool_calls)
    provider_start = time.perf_counter_ns()
    provider_error = None
    try:
        final = provider.execute(session).as_dict()
    except Exception as exc:
        provider_error = {"error_class":"INSTRUMENTATION", "type":type(exc).__name__, "message":str(exc)}
        final = {"artifacts":[], "completed_actions":[], "facts":{}, "text":""}
    provider_duration = time.perf_counter_ns()-provider_start
    session.persist()
    write_json(root/"candidate.json", final)
    write_json(root/"replay.json", {"schema_version":"0.5.0", "case_id":case_id, "steps":[{"tool":e["tool"], "arguments":e["arguments"]} for e in session.ledger], "final":final, "source_provider_kind":provider.info.kind})
    scoring_start = time.perf_counter_ns()
    result = score(root, session, final)
    if provider_error:
        from .scoring import summarize
        for a in result["atoms"]:
            # Business facts are independently decoded from persisted outputs or
            # actual local service state. A later provider fault cannot erase them.
            if a["dimension"]=="business" and a["status"] in ("PASS","FAIL"):
                continue
            if a["status"]=="FAIL" and a["id"] in ("protocol.offered_tools","safety.forbidden_effects"):
                continue  # Verified violations survive a later provider failure.
            a.update(status="UNKNOWN", error_class="INSTRUMENTATION")
        result = summarize(result["atoms"])
    scoring_duration = time.perf_counter_ns()-scoring_start
    finished_at, duration_ns = utc_now(), time.perf_counter_ns()-started_ns
    raw_artifacts = [artifact(root, p) for p in sorted(root.rglob("*")) if p.is_file()]
    report = {"schema_version":"0.5.0", "kit_version":__version__, "case_id":case_id, "run_kind":"LOCAL_TOOL_SESSION_EXTERNAL_CONTROLLER" if provider.info.name=="jsonl-session" else "RECORDED_ACTION_REPLAY" if provider.info.name=="replay" else "ENGINEERING_FIXTURE_ONLY", "provider":asdict(provider.info), "model_calls":"UNKNOWN" if provider.info.name=="jsonl-session" else 0, "core_model_calls":0, "model_calls_scope":"Overall controller calls UNKNOWN for JSONL; core_model_calls counts only officekit itself", "original_action_generation":"UNKNOWN" if provider.info.name=="replay" else "LOCAL_REFERENCE_FIXTURE" if provider.info.name=="reference" else "UNKNOWN", "external_model_calls":"UNKNOWN" if provider.info.name=="jsonl-session" else 0,
              "evidence_provenance":"LOCAL_EXECUTED", "candidate_isolation":"INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX",
              "live_model_capability":"UNKNOWN", "live_service_capability":"UNKNOWN", "old_release_modified":False, "rank_stability":"NOT_MEASURED", "candidate_error":provider_error,
              "capability_boundary":{"local_tool_transport":"EXECUTED_SYNTHETIC","production_service":"UNKNOWN","live_model":"UNKNOWN","iterative_tool_choice":"PLAN_REPLAY_NOT_MEASURED" if provider.info.name=="replay" else "EXTERNAL_CONTROLLER_UNKNOWN" if provider.info.name=="jsonl-session" else "DETERMINISTIC_REFERENCE_ONLY","ui_browser":"UNKNOWN_REPOSITORY_ADAPTER_SEPARATE","os_sandbox":"NOT_PROVIDED"},
              "runtime":{"python":platform.python_version(), "platform":platform.platform(), "argv":sys.argv},
              "timing":{"started_at":started_at,"finished_at":finished_at,"duration_ns":duration_ns,"provider_duration_ns":provider_duration,"scoring_duration_ns":scoring_duration,"clock":"perf_counter_ns","boundary":"Before input materialization through scorer return; excludes Python startup and report/manifest serialization"},
              "result":result,"raw_artifacts":raw_artifacts}
    write_json(root/"report.json", report)
    write_json(root/"manifest.json", {"schema_version":"0.5.0", "hash_algorithm":"sha256", "artifacts":[artifact(root,p) for p in sorted(root.rglob("*")) if p.is_file() and p.name!="manifest.json"], "self_hash_excluded":True})
    return report
