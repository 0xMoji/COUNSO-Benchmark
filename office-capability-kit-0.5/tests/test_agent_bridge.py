"""Deterministic stdlib bridge regression tests; no model, key or network."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from officekit.agent_bridge import (FileAgentProvider, grade_host_agent, host_agent, validate_final,
                                   verify_host_receipt)
from officekit.agent_call import (BridgeDirectory, BridgeError, MAX_MESSAGE_BYTES,
                                 PROTOCOL, json_bytes, preflight, request, strict_json)
from officekit.agent_packages import prepare_agent
from officekit.io import write_json

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    SCHEMA_TOOLING = True
except ImportError:
    SCHEMA_TOOLING = False

EMPTY_FINAL = {"artifacts": [], "completed_actions": [], "facts": {}, "text": ""}


def by_id(report, name):
    return next(item for item in report["result"]["atoms"] if item["id"] == name)


class AgentBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="officekit-agent-bridge-test-")
        self.root = Path(self.temp.name)
        self.jobs = []
        self.serial = 0

    def tearDown(self):
        for job in self.jobs:
            if job["thread"].is_alive():
                try: request(job["bundle"], "final", result=EMPTY_FINAL, timeout=0.2, poll_interval=0.002)
                except Exception: pass
                job["thread"].join(4)
            self.assertFalse(job["thread"].is_alive(), "Bounded host did not terminate")
        self.temp.cleanup()

    def path(self, name):
        self.serial += 1
        return self.root / f"{name}-{self.serial}"

    def start(self, case="office-recovery", timeout=3, budget=32):
        bundle, private = self.path("public"), self.path("private")
        prepare_agent(case, bundle)
        job = {"bundle": bundle, "private": private}
        def serve():
            try: job["report"] = host_agent(bundle, private, max_tool_calls=budget, timeout=timeout, poll_interval=0.002)
            except Exception as exc: job["exception"] = exc
        thread = threading.Thread(target=serve, daemon=True)
        job["thread"] = thread
        self.jobs.append(job)
        thread.start()
        deadline = time.monotonic() + 2
        while not (bundle / ".bridge" / "ready.json").is_file():
            if "exception" in job: raise job["exception"]
            if not thread.is_alive(): return job
            if time.monotonic() > deadline: self.fail("Host did not become ready")
            time.sleep(0.002)
        return job

    def call(self, job, tool, args, request_id=None):
        result = request(job["bundle"], "tool", tool=tool, arguments=args,
                         request_id=request_id, timeout=1, poll_interval=0.002)
        self.assertEqual(result["type"], "tool_result")
        return result["response"]

    def finish(self, job, final=EMPTY_FINAL):
        response = request(job["bundle"], "final", result=final, timeout=1, poll_interval=0.002)
        self.assertEqual(response["type"], "accepted")
        self.assertEqual(set(response), {"protocol", "run_id", "request_id", "request_sha256", "type", "accepted"})
        self.assertTrue(response["accepted"])
        job["thread"].join(2)
        if "exception" in job: raise job["exception"]
        return job["report"]

    def test_real_tool_result_and_standalone_python_helper(self):
        job = self.start("office-evidence")
        helper = job["bundle"] / "call.py"
        command = [sys.executable, "-I", "-S", str(helper), "--bundle", str(job["bundle"])]
        ready = subprocess.run(command + ["preflight"], cwd=self.root, text=True, capture_output=True, timeout=3)
        self.assertEqual(ready.returncode, 0, ready.stderr)
        self.assertEqual(json.loads(ready.stdout)["status"], "READY")
        process = subprocess.run(command + ["tool", "files.read_input", '{"file":"purchase_order.json"}'], cwd=self.root, text=True, capture_output=True, timeout=3)
        self.assertEqual(process.returncode, 0, process.stderr)
        event = json.loads(process.stdout)["response"]
        self.assertTrue(event["ok"])
        self.assertEqual(event["event_id"], "event-0001")
        self.assertIn("order_id", event["data"])
        (job["bundle"] / "submission").mkdir()
        write_json(job["bundle"] / "submission" / "candidate.json", EMPTY_FINAL)
        process = subprocess.run(command + ["final", "@submission/candidate.json"], cwd=self.root, text=True, capture_output=True, timeout=3)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["type"], "accepted")
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(report["provider"]["name"], "external-agent")
        self.assertEqual(report["provider"]["verified_backend"], "UNKNOWN")
        self.assertEqual(report["model_calls"], "UNKNOWN")
        self.assertEqual(report["external_model_calls"], "UNKNOWN")
        self.assertEqual(report["core_model_calls"], 0)
        ledger = json.loads((job["private"] / "ledger.json").read_text())["events"]
        self.assertEqual(ledger[0]["result"]["data"], event["data"])
        self.assertEqual(len(ledger), 1)
        self.assertNotIn("result", json.loads((job["bundle"] / ".bridge" / "response.json").read_text()))

    def test_ack_loss_recovery_uses_real_response_same_service_key(self):
        job = self.start()
        source = self.call(job, "files.read_input", {"file": "request.json"})["data"]
        self.call(job, "mail.get_thread", {"thread_id": source["thread_id"]})
        events = self.call(job, "calendar.list_events", {})["events"]
        from datetime import datetime
        slot = next(s for s in source["candidate_slots"] if not any(datetime.fromisoformat(s["start"]) < datetime.fromisoformat(e["end"]) and datetime.fromisoformat(e["start"]) < datetime.fromisoformat(s["end"]) for e in events))
        args = {"idempotency_key": source["draft_key"], "recipient": source["recipient"], "subject": source["subject"], "body": source["body"]}
        lost = self.call(job, "mail.create_draft", args, "draft-commit")
        self.assertFalse(lost["ok"])
        self.assertEqual(lost["transport_status"], "COMMIT_ACK_LOST")
        # Identical bridge retry returns the same ACK_LOST response and event.
        self.assertEqual(self.call(job, "mail.create_draft", args, "draft-commit"), lost)
        known = self.call(job, "service.get_request", {"idempotency_key": source["draft_key"]})
        self.assertEqual(known["request_status"], "COMMITTED")
        retry = self.call(job, "mail.create_draft", args, "draft-service-retry")
        self.assertTrue(retry["ok"])
        self.assertTrue(retry["deduplicated"])
        self.assertEqual(retry["resource"]["id"], known["resource"]["id"])
        hold = self.call(job, "calendar.create_private_hold", {"idempotency_key": source["hold_key"], "title": source["hold_title"], "start": slot["start"], "end": slot["end"], "privacy": "private"})
        receipt = {"draft_id": retry["resource"]["id"], "hold_id": hold["resource"]["id"], "draft_key": source["draft_key"], "hold_key": source["hold_key"], "request_status": "COMMITTED"}
        written = self.call(job, "files.write", {"path": "outputs/receipt.json", "content": json.dumps(receipt)})
        final = {"artifacts": [written["file"]["artifact"]], "completed_actions": [{"tool": "mail.create_draft", "event_id": retry["event_id"], "resource_id": retry["resource"]["id"]}, {"tool": "calendar.create_private_hold", "event_id": hold["event_id"], "resource_id": hold["resource"]["id"]}], "facts": receipt, "text": "Prepared"}
        report = self.finish(job, final)
        self.assertEqual(report["result"]["earned"], 100)
        state = json.loads((job["private"] / "state.json").read_text())
        self.assertEqual(len(state["drafts"]), 1)
        creates = [event for event in json.loads((job["private"] / "ledger.json").read_text())["events"] if event["tool"] == "mail.create_draft"]
        self.assertEqual(len(creates), 2)
        self.assertTrue(creates[0]["committed"])
        self.assertFalse(creates[1]["committed"])
        retained = self.path("retained-receipt")
        write_json(retained, report["host_receipt"])
        verified = verify_host_receipt(job["bundle"], job["private"], retained)
        self.assertEqual(verified["run_id"], report["run_id"])
        graded = grade_host_agent(job["bundle"], job["private"], self.path("independent-grade"), retained)
        self.assertEqual(graded["result"], report["result"])
        self.assertEqual(graded["run_kind"], "INDEPENDENT_VERIFIED_AGENT_HOST_GRADE")
        self.assertEqual(graded["core_model_calls"], 0)

    def test_response_loss_identical_retry_does_not_execute_twice(self):
        job = self.start("office-data")
        first = self.call(job, "data.read_csv", {"file": "transactions.csv"}, "fixed-id")
        (job["bundle"] / ".bridge" / "response.json").unlink()
        retried = self.call(job, "data.read_csv", {"file": "transactions.csv"}, "fixed-id")
        self.assertEqual(retried, first)
        report = self.finish(job)
        self.assertEqual(len(json.loads((job["private"] / "ledger.json").read_text())["events"]), 1)
        self.assertGreaterEqual(report["agent_bridge"]["deduplicated_requests"], 1)

    def test_terminal_status_does_not_hide_final_response_after_stale_read(self):
        job = self.start("office-data")
        self.call(job, "data.read_csv", {"file": "transactions.csv"})
        stale_response = (job["bundle"] / ".bridge" / "response.json").read_bytes()
        original = BridgeDirectory.read
        main_thread = threading.current_thread()
        injected = []
        def delayed_stale_read(directory, name, missing=False):
            if threading.current_thread() is main_thread and name == "response.json" and not injected:
                injected.append(True)
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    raw = original(directory, "status.json", missing=True)
                    if raw and strict_json(raw).get("status") == "CLOSED":
                        return stale_response
                    time.sleep(0.002)
                self.fail("Host did not publish final response and CLOSED")
            return original(directory, name, missing=missing)
        with patch.object(BridgeDirectory, "read", delayed_stale_read):
            report = self.finish(job)
        self.assertTrue(injected)
        self.assertTrue(report["agent_bridge"]["final_accepted"])
        self.assertIsNone(report["candidate_error"])

    def test_open_response_survives_atomic_replace_without_accepting_alias_or_oversize(self):
        directory = self.path("replace-race-bridge")
        directory.mkdir()
        original_open = os.open
        for old_bytes in (json_bytes({"snapshot": "old"}), b"x" * (MAX_MESSAGE_BYTES + 1)):
            with self.subTest(oversized=len(old_bytes) > MAX_MESSAGE_BYTES):
                old = directory / "response.json"
                old.write_bytes(old_bytes)
                staged = directory / ".replacement.tmp"
                staged.write_bytes(json_bytes({"snapshot": "new"}))
                observed_links = []
                with BridgeDirectory(directory) as bridge:
                    def replace_after_open(path, flags, mode=0o777, *, dir_fd=None):
                        fd = original_open(path, flags, mode, dir_fd=dir_fd)
                        if path == "response.json" and dir_fd == bridge.fd:
                            os.replace(staged, old)
                            observed_links.append(os.fstat(fd).st_nlink)
                        return fd
                    with patch("officekit.agent_call.os.open", replace_after_open):
                        if len(old_bytes) > MAX_MESSAGE_BYTES:
                            with self.assertRaisesRegex(ValueError, "bounded"):
                                bridge.read("response.json")
                        else:
                            self.assertEqual(bridge.read("response.json"), old_bytes)
                    self.assertEqual(observed_links, [0])
                    self.assertEqual(strict_json(bridge.read("response.json")), {"snapshot": "new"})
        foreign = self.path("aliased-response")
        foreign.write_bytes(json_bytes({"private": "must not be read"}))
        (directory / "response.json").unlink()
        os.link(foreign, directory / "response.json")
        with BridgeDirectory(directory) as bridge:
            with self.assertRaisesRegex(ValueError, "unaliased"):
                bridge.read("response.json")
        self.assertEqual(strict_json(foreign.read_bytes()), {"private": "must not be read"})

    def test_request_id_reuse_changed_contents_is_recorded_rejection(self):
        job = self.start("office-data")
        self.call(job, "data.read_csv", {"file": "transactions.csv"}, "same")
        rejected = request(job["bundle"], "tool", tool="files.list", arguments={}, request_id="same", timeout=1, poll_interval=0.002)
        self.assertEqual(rejected["type"], "rejected")
        self.assertFalse(rejected["response"]["ok"])
        report = self.finish(job)
        self.assertEqual(by_id(report, "protocol.offered_tools")["status"], "FAIL")
        self.assertEqual(len(json.loads((job["private"] / "ledger.json").read_text())["events"]), 2)

    def test_killed_helper_releases_single_flight_lock_for_identical_retry(self):
        entered, release = threading.Event(), threading.Event()
        original = FileAgentProvider._handle
        def gated(provider, session, value):
            if isinstance(value, dict) and value.get("request_id") == "killed-helper":
                entered.set()
                release.wait(2)
            return original(provider, session, value)
        with patch.object(FileAgentProvider, "_handle", gated):
            job = self.start("office-data")
            command = [sys.executable, "-I", "-S", str(job["bundle"] / "call.py"), "--bundle", str(job["bundle"]), "--request-id", "killed-helper", "tool", "data.read_csv", '{"file":"transactions.csv"}']
            first = subprocess.Popen(command, cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(entered.wait(1), "Helper did not submit its first real request")
                first.kill()
                first.wait(timeout=2)
                second = subprocess.Popen(command, cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                release.set()
                stdout, stderr = second.communicate(timeout=3)
                self.assertEqual(second.returncode, 0, stderr)
                self.assertEqual(json.loads(stdout)["response"]["event_id"], "event-0001")
            finally:
                release.set()
                if first.poll() is None: first.kill(); first.wait(timeout=2)
                first.stdout.close(); first.stderr.close()
        self.finish(job)
        self.assertEqual(len(json.loads((job["private"] / "ledger.json").read_text())["events"]), 1)

    def test_missing_host_is_unsupported_and_helper_has_no_evaluator_import(self):
        bundle = self.path("unhosted")
        prepare_agent("office-data", bundle)
        with self.assertRaises(BridgeError) as caught:
            request(bundle, "tool", tool="data.read_csv", arguments={"file": "transactions.csv"})
        self.assertEqual(caught.exception.status, "UNSUPPORTED")
        command = [sys.executable, "-I", "-S", str(bundle / "call.py"), "--bundle", str(bundle), "preflight"]
        result = subprocess.run(command, cwd=self.root, text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "UNSUPPORTED")
        self.assertNotIn("import officekit", (bundle / "call.py").read_text().replace("imports officekit", ""))

    def test_host_timeout_is_unknown_environment_not_model_zero(self):
        job = self.start("office-data", timeout=0.08)
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(report["agent_bridge"]["environment_status"], "UNKNOWN")
        self.assertEqual(report["candidate_error"]["environment_status"], "UNKNOWN")
        self.assertEqual(report["result"]["unknown_weight"], 100)
        self.assertEqual(report["model_calls"], "UNKNOWN")
        self.assertEqual(report["core_model_calls"], 0)
        graded = grade_host_agent(job["bundle"], job["private"], self.path("grade-timeout"))
        self.assertEqual(graded["result"]["unknown_weight"], 100)

    def test_unsupported_platform_still_records_unknown_and_receipt(self):
        with patch("officekit.agent_bridge._environment", return_value={"status": "UNSUPPORTED"}):
            job = self.start("office-data")
            job["thread"].join(2)
        report = job["report"]
        self.assertEqual(report["agent_bridge"]["environment_status"], "UNSUPPORTED")
        self.assertEqual(report["result"]["unknown_weight"], 100)
        self.assertEqual(report["model_calls"], "UNKNOWN")
        self.assertEqual(report["core_model_calls"], 0)
        self.assertEqual(verify_host_receipt(job["bundle"], job["private"])["run_id"], report["run_id"])

    def test_verified_wrong_fact_and_violation_survive_timeout(self):
        job = self.start("office-data", timeout=0.3)
        self.call(job, "data.read_csv", {"file": "transactions.csv"})
        wrong = "currency,region,net_amount,row_count\nEUR,East,999.00,2\nUSD,North,90.00,3\nUSD,South,50.00,1\n"
        self.assertTrue(self.call(job, "files.write", {"path": "outputs/region_totals.csv", "content": wrong})["ok"])
        self.assertFalse(self.call(job, "mail.send", {})["ok"])
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(by_id(report, "data.group_totals")["status"], "FAIL")
        self.assertEqual(by_id(report, "data.row_counts")["status"], "PASS")
        self.assertEqual(by_id(report, "protocol.offered_tools")["status"], "FAIL")
        self.assertEqual(by_id(report, "data.summary")["status"], "UNKNOWN")
        self.assertEqual(report["result"]["judgment"], "FAIL")
        graded = grade_host_agent(job["bundle"], job["private"], self.path("grade-proven-wrong"))
        self.assertEqual(graded["result"], report["result"])

    def test_budget_is_bounded_and_final_remains_available_at_limit(self):
        job = self.start("office-data", budget=1)
        self.call(job, "data.read_csv", {"file": "transactions.csv"})
        report = self.finish(job)
        self.assertIsNone(report["candidate_error"])
        job = self.start("office-data", budget=1)
        self.call(job, "data.read_csv", {"file": "transactions.csv"})
        denied = self.call(job, "files.list", {})
        self.assertFalse(denied["ok"])
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(by_id(report, "protocol.offered_tools")["status"], "FAIL")
        ledger = json.loads((job["private"] / "ledger.json").read_text())["events"]
        self.assertEqual(len(ledger), 2)
        self.assertEqual(sum(item["accepted"] for item in ledger), 1)

    def test_malicious_output_path_and_argument_root_have_no_effect(self):
        job = self.start("office-data")
        outside = self.root / "escape.txt"
        for name in ("../../escape.txt", str(outside), "outputs/../escape.txt", "outputs\\escape.txt"):
            self.assertFalse(self.call(job, "files.write", {"path": name, "content": "deny"})["ok"])
        with BridgeDirectory(job["bundle"] / ".bridge") as bridge:
            ready = strict_json(bridge.read("ready.json"))
            malformed = {"protocol": PROTOCOL, "run_id": ready["run_id"], "request_id": "bad-root", "op": "tool", "tool": "files.list", "arguments": []}
            bridge.write("request.json", malformed)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                response = strict_json(bridge.read("response.json"))
                if response.get("request_id") == "bad-root": break
                time.sleep(0.002)
            self.assertEqual(response["type"], "rejected")
        report = self.finish(job)
        self.assertFalse(outside.exists())
        self.assertEqual(by_id(report, "protocol.offered_tools")["status"], "FAIL")
        self.assertTrue(all(not item["committed"] for item in json.loads((job["private"] / "ledger.json").read_text())["events"]))

    def test_request_symlink_and_private_root_symlink_are_rejected(self):
        job = self.start("office-data")
        outsider = self.root / "outsider.json"
        outsider.write_text('{"must_not_be_read":true}')
        (job["bundle"] / ".bridge" / "request.json").symlink_to(outsider)
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(report["result"]["unknown_weight"], 100)
        self.assertEqual(json.loads((job["private"] / "ledger.json").read_text())["events"], [])
        self.assertEqual(outsider.read_text(), '{"must_not_be_read":true}')
        private = self.path("actual-private-parent"); private.mkdir()
        link = self.path("symlink-private-parent"); link.symlink_to(private, target_is_directory=True)
        bundle = self.path("new-public"); prepare_agent("office-data", bundle)
        with self.assertRaisesRegex(ValueError, "Symbolic"):
            host_agent(bundle, link / "run", timeout=0.01)
        with self.assertRaisesRegex(ValueError, "disjoint"):
            host_agent(bundle, bundle / "private", timeout=0.01)
        file_root = self.path("file-root"); file_root.write_text("regular")
        with self.assertRaisesRegex(ValueError, "directory"):
            host_agent(file_root, self.path("run"), timeout=0.01)

    def test_bridge_hardlink_alias_cannot_corrupt_foreign_lock_file(self):
        job = self.start("office-data")
        foreign = self.path("foreign-lock")
        foreign.write_text("untouched")
        os.link(foreign, job["bundle"] / ".bridge" / "client.lock")
        with self.assertRaisesRegex(ValueError, "unaliased"):
            request(job["bundle"], "tool", tool="files.list", arguments={}, timeout=0.1)
        self.assertEqual(foreign.read_text(), "untouched")
        (job["bundle"] / ".bridge" / "client.lock").unlink()
        self.finish(job)

    def test_strict_json_root_and_final_types(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}'):
            with self.assertRaises(ValueError): strict_json(raw)
        for field, bad in (("artifacts", [{}]), ("artifacts", ["../private"]), ("artifacts", ["outputs/x", "outputs/x"]), ("completed_actions", {}), ("completed_actions", [{"tool": "mail.create_draft", "event_id": [], "resource_id": "r"}]), ("facts", []), ("text", None)):
            final = dict(EMPTY_FINAL, **{field: bad})
            with self.assertRaises(ValueError): validate_final(final)
        job = self.start("office-data")
        denied = request(job["bundle"], "final", result=dict(EMPTY_FINAL, artifacts=[{}]), timeout=1, poll_interval=0.002)
        self.assertEqual(denied["type"], "rejected")
        report = self.finish(job)
        self.assertEqual(by_id(report, "protocol.offered_tools")["status"], "FAIL")

    def test_invalid_json_request_root_and_oversize_are_bounded(self):
        job = self.start("office-data")
        with BridgeDirectory(job["bundle"] / ".bridge") as bridge:
            bridge.write("request.json", [])
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                raw = bridge.read("response.json", missing=True)
                if raw: break
                time.sleep(0.002)
            self.assertEqual(strict_json(raw)["type"], "rejected")
        self.finish(job)
        job = self.start("office-data")
        # Match the helper's atomic publication contract. A direct write to the
        # watched request path exposes an empty/partial JSON file before the
        # oversized payload is complete and legitimately logs that rejection.
        bridge_path = job["bundle"] / ".bridge"
        staged = bridge_path / ".oversize-request.tmp"
        staged.write_bytes(b"x" * (MAX_MESSAGE_BYTES + 1))
        os.replace(staged, bridge_path / "request.json")
        job["thread"].join(2)
        report = job["report"]
        self.assertEqual(report["agent_bridge"]["environment_status"], "UNKNOWN")
        self.assertEqual(json.loads((job["private"] / "ledger.json").read_text())["events"], [])
        with self.assertRaisesRegex(ValueError, "bounded"):
            json_bytes({"x": "x" * MAX_MESSAGE_BYTES})

    def test_single_flight_lock_and_no_fabricated_response(self):
        job = self.start("office-data")
        with BridgeDirectory(job["bundle"] / ".bridge") as bridge:
            bridge.acquire("first")
            try:
                with self.assertRaisesRegex(BridgeError, "in flight"):
                    request(job["bundle"], "tool", tool="files.list", arguments={}, timeout=0.1)
            finally: bridge.release()
        self.finish(job)

    def test_receipt_tampering_and_candidate_supplied_receipt_are_rejected(self):
        job = self.start("office-data")
        report = self.finish(job)
        public_receipt = job["bundle"] / "submission" / "receipt.json"
        write_json(public_receipt, report["host_receipt"])
        with self.assertRaisesRegex(ValueError, "candidate"):
            verify_host_receipt(job["bundle"], job["private"], public_receipt)
        pin = self.path("operator-pin"); write_json(pin, dict(report["host_receipt"], run_id="0" * 32))
        with self.assertRaisesRegex(ValueError, "retained"):
            verify_host_receipt(job["bundle"], job["private"], pin)
        ledger = job["private"] / "ledger.json"
        original = ledger.read_bytes()
        write_json(ledger, {"schema_version": "0.5.0", "evidence_provenance": "LOCAL_EXECUTED", "events": [{"made_up": True}]})
        with self.assertRaisesRegex(ValueError, "integrity"):
            verify_host_receipt(job["bundle"], job["private"])
        ledger.write_bytes(original)
        self.assertEqual(verify_host_receipt(job["bundle"], job["private"])["run_id"], report["run_id"])
        with self.assertRaisesRegex(ValueError, "fresh"):
            host_agent(job["bundle"], job["private"], timeout=0.01)
        foreign = self.path("foreign-private"); foreign.mkdir()
        write_json(foreign / "ledger.json", {"evidence_provenance": "LOCAL_EXECUTED", "events": []})
        write_json(foreign / "state.json", {})
        with self.assertRaises(FileNotFoundError):
            verify_host_receipt(job["bundle"], foreign)

    @unittest.skipUnless(SCHEMA_TOOLING, "Optional jsonschema test tooling unavailable; bridge runtime is stdlib only")
    def test_new_agent_host_schema_on_actual_host_and_independent_grade(self):
        registry = Registry()
        schemas = {}
        for path in (ROOT / "schemas").glob("*.json"):
            value = json.loads(path.read_text())
            Draft202012Validator.check_schema(value)
            value["$id"] = path.as_uri()
            schemas[path.name] = value
            registry = registry.with_resource(path.as_uri(), Resource.from_contents(value))
        validator = Draft202012Validator(schemas["agent-host-run.schema.json"], registry=registry)
        job = self.start("office-data")
        actual_host = self.finish(job)
        validator.validate(actual_host)
        validator.validate(json.loads((job["private"] / "report.json").read_text()))
        actual_grade = grade_host_agent(job["bundle"], job["private"], self.path("schema-grade"))
        validator.validate(actual_grade)
        Draft202012Validator(schemas["candidate.schema.json"], registry=registry).validate(json.loads((job["private"] / "candidate.json").read_text()))
        Draft202012Validator(schemas["ledger.schema.json"], registry=registry).validate(json.loads((job["private"] / "ledger.json").read_text()))
        Draft202012Validator(schemas["result.schema.json"], registry=registry).validate(actual_grade["result"])

    def test_host_verifies_static_public_contract_before_execution(self):
        bundle = self.path("tampered-public"); prepare_agent("office-data", bundle)
        (bundle / "tools.json").write_text('{"tools":[]}')
        private = self.path("private-uncreated")
        with self.assertRaisesRegex(ValueError, "changed"):
            host_agent(bundle, private, timeout=0.01)
        self.assertFalse(private.exists())
        self.assertFalse((bundle / ".bridge").exists())
        for timeout in (0, -1, float("inf"), True):
            with self.assertRaises(ValueError): host_agent(bundle, private, timeout=timeout)
        for budget in (0, 33, True):
            with self.assertRaises(ValueError): host_agent(bundle, private, max_tool_calls=budget)


if __name__ == "__main__":
    unittest.main()
