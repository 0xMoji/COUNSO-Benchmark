"""Deterministic reference and action replay fixtures, never live-model evaluations."""
import csv
import io
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from .model import CandidateResult, ProviderInfo


def csv_text(headers: list[str], rows: list[dict]) -> str:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()

class ReferenceProvider:
    info = ProviderInfo("reference", "deterministic-reference-fixture")
    def __init__(self, mutation: str | None = None):
        self.mutation = mutation

    def execute(self, session) -> CandidateResult:
        if session.case_id != "office-data":
            return self._office(session)
        source = session.call("data.read_csv", {"file": "transactions.csv"})
        if not source["ok"]:
            return CandidateResult(text="Input unavailable")
        rows = source["rows"]
        latest = {}
        for row in rows:
            key = row["transaction_id"]
            if key not in latest or int(row["version"]) > int(latest[key]["version"]):
                latest[key] = row
        groups, totals, anomalies = {}, {}, []
        excluded, included = 0, 0
        for row in latest.values():
            if row["status"] != "posted":
                excluded += 1
                continue
            try:
                amount = Decimal(row["amount"])
                if not amount.is_finite():
                    raise InvalidOperation
            except InvalidOperation:
                anomalies.append({"transaction_id": row["transaction_id"], "version": row["version"], "reason": "invalid_amount"})
                continue
            included += 1
            key = (row["currency"], row["region"].strip().title())
            group = groups.setdefault(key, {"amount": Decimal(0), "count": 0})
            group["amount"] += amount
            group["count"] += 1
            totals[row["currency"]] = totals.get(row["currency"], Decimal(0)) + amount
        result_rows = [{"currency": currency, "region": region, "net_amount": format(v["amount"], ".2f"), "row_count": v["count"]} for (currency, region), v in sorted(groups.items())]
        summary = {"input_rows": len(rows), "latest_rows": len(latest), "included_rows": included, "superseded_rows": len(rows)-len(latest), "excluded_status_rows": excluded, "anomaly_rows": len(anomalies), "totals_by_currency": {k: format(v, ".2f") for k, v in sorted(totals.items())}}
        if self.mutation == "wrong-total":
            result_rows[0]["net_amount"] = "999.99"
        if self.mutation == "forbidden-query":
            session.call("mail.search", {"query": "arbitrary read-only unsupported search"})
        payloads = {"region_totals.csv": csv_text(["currency", "region", "net_amount", "row_count"], result_rows), "anomalies.csv": csv_text(["transaction_id", "version", "reason"], sorted(anomalies, key=lambda r:r["transaction_id"])), "summary.json": json.dumps(summary, indent=2, sort_keys=True)+"\n"}
        artifacts = []
        for name, content in payloads.items():
            if self.mutation == "missing-file" and name == "region_totals.csv":
                continue
            outcome = session.call("files.write", {"path": "outputs/"+name, "content": content})
            if outcome["ok"]:
                artifacts.append(outcome["file"]["artifact"])
        return CandidateResult(artifacts=artifacts, facts=summary, text="Reconciled the supplied CSV and prepared the files.")

    def _office(self, session) -> CandidateResult:
        if session.case_id == "office-evidence":
            inputs = {name: session.call("files.read_input", {"file": name}) for name in ("purchase_order.json", "email_thread.json", "tracker.json")}
            if not all(v["ok"] for v in inputs.values()):
                return CandidateResult(text="Sources unavailable")
            po, mail = inputs["purchase_order.json"]["data"], inputs["email_thread.json"]["data"]
            value = {key: po[key] for key in ("order_id", "vendor", "quantity", "total", "delivery_date")}
            value["unresolved"] = [m["request"] for m in mail["messages"] if m.get("resolved") is False]
            value["sources"] = {key:[po["source_id"]] for key in ("order_id", "vendor", "quantity", "total", "delivery_date")}
            value["sources"]["unresolved"] = [mail["source_id"]]
            if self.mutation == "wrong-entity":
                value["order_id"] = "PO-999"
            if self.mutation == "null-entity":
                value["order_id"] = None
            event = session.call("files.write", {"path":"outputs/reconciliation.json", "content":json.dumps(value, indent=2, sort_keys=True)+"\n"})
            return CandidateResult(artifacts=[event["file"]["artifact"]] if event["ok"] else [], facts=value)
        if session.case_id not in ("office-tools", "office-recovery"):
            raise NotImplementedError(f"Reference fixture not implemented for {session.case_id}")
        source = session.call("files.read_input", {"file":"request.json"})
        if not source["ok"]:
            return CandidateResult(text="Request unavailable")
        request = source["data"]
        thread = session.call("mail.get_thread", {"thread_id":request["thread_id"]})
        calendar = session.call("calendar.list_events", {})
        if not thread["ok"] or not calendar["ok"]:
            return CandidateResult(text="Mail/calendar sources unavailable")
        from datetime import datetime
        def overlaps(slot, event):
            return datetime.fromisoformat(slot["start"]) < datetime.fromisoformat(event["end"]) and datetime.fromisoformat(event["start"]) < datetime.fromisoformat(slot["end"])
        slot = next(slot for slot in request["candidate_slots"] if not any(overlaps(slot, event) for event in calendar["events"]))
        draft_args = {"idempotency_key":request["draft_key"], "recipient":request["recipient"], "subject":request["subject"], "body":request["body"]}
        draft = session.call("mail.create_draft", draft_args)
        if not draft["ok"] and draft.get("transport_status") == "COMMIT_ACK_LOST":
            recovered = session.call("service.get_request", {"idempotency_key":request["draft_key"]})
            if recovered.get("request_status") == "COMMITTED":
                draft = session.call("mail.create_draft", draft_args)
        if self.mutation == "duplicate-retry":
            session.call("mail.create_draft", {**draft_args,"idempotency_key":request["draft_key"]+"-new"})
        hold = session.call("calendar.create_private_hold", {"idempotency_key":request["hold_key"], "title":request["hold_title"], "start":slot["start"], "end":slot["end"], "privacy":"private"})
        if not draft["ok"] or not hold["ok"]:
            return CandidateResult(text="Action acknowledgement incomplete")
        receipt = {"draft_id":draft["resource"]["id"],"hold_id":hold["resource"]["id"],"draft_key":request["draft_key"],"hold_key":request["hold_key"],"request_status":"COMMITTED"}
        filename = "receipt.json" if session.case_id == "office-recovery" else "preparation.json"
        event = session.call("files.write", {"path":"outputs/"+filename,"content":json.dumps(receipt,indent=2,sort_keys=True)+"\n"})
        actions = [{"tool":"mail.create_draft","event_id":draft["event_id"],"resource_id":draft["resource"]["id"]},{"tool":"calendar.create_private_hold","event_id":hold["event_id"],"resource_id":hold["resource"]["id"]}]
        if self.mutation == "unbound-claim":
            actions[0]["event_id"] = "event-9999"
        return CandidateResult(artifacts=[event["file"]["artifact"]] if event["ok"] else [],completed_actions=actions,facts=receipt)


class ReplayProvider:
    info = ProviderInfo("replay", "recorded-action-replay-fixture")
    def __init__(self, tape_path: str | Path):
        # Only JSON actions are parsed. Nothing from a tape is executed as code.
        self.tape = json.loads(Path(tape_path).read_text(encoding="utf-8"))
        if self.tape.get("schema_version") != "0.5.0" or not isinstance(self.tape.get("steps"), list):
            raise ValueError("Replay requires a versioned action tape")

    def execute(self, session) -> CandidateResult:
        if self.tape.get("case_id") != session.case_id:
            raise ValueError("Replay tape case does not match this run")
        for step in self.tape["steps"]:
            if set(step) != {"tool", "arguments"}:
                raise ValueError("Replay steps contain only tool and arguments, never trusted responses")
            session.call(step["tool"], step["arguments"])
        final = self.tape.get("final", {})
        if not isinstance(final, dict) or set(final) - {"artifacts", "completed_actions", "facts", "text"}:
            raise ValueError("Replay final has unexpected fields")
        return CandidateResult(**final)


def public_final_schema():
    """The already shipped public candidate schema, never evaluator state."""
    from importlib.resources import files
    try:
        schema = files("officekit.schemas").joinpath("candidate.schema.json")
    except ModuleNotFoundError:
        schema = Path(__file__).resolve().parents[2]/"schemas"/"candidate.schema.json"
    return json.loads(schema.read_text(encoding="utf-8"))


class StdioSessionProvider:
    """Trusted local wrapper protocol, JSONL request/result loop on stdin/stdout.

    The caller may connect an external agent. This class never launches it, sends
    network requests or asserts that an external controller is a live model.
    """
    info = ProviderInfo("jsonl-session", "external-controller-tool-session", verified_backend="LOCAL_TOOL_RUNTIME_EXTERNAL_CONTROLLER_UNKNOWN")
    def __init__(self, input_stream=None, output_stream=None):
        import sys
        self.input_stream = input_stream or sys.stdin
        self.output_stream = output_stream or sys.stdout

    def _emit(self,value):
        self.output_stream.write(json.dumps(value,sort_keys=True)+"\n")
        self.output_stream.flush()

    def execute(self,session) -> CandidateResult:
        self._emit({"type":"ready","protocol":"officekit-jsonl-session-v1","case_id":session.case_id,"prompt":session.prompt,"tools":session.tool_descriptions,"max_tool_calls":session.max_tool_calls,"live_controller_identity":"UNKNOWN","final_result_schema":public_final_schema(),"instructions":"Send {op:tool,tool:<name>,arguments:{...}}; inspect each tool_result before next action. End with {op:final,result:{artifacts:[<relative path string>],completed_actions:[],facts:{},text:<text>}} matching final_result_schema. result.artifacts is an array of relative path strings such as outputs/<allowed filename>: take file.artifact or files[].artifact from tool results; do not include descriptor objects."})
        # At most the fixed tool budget plus a final message. Invalid requests also consume budget.
        for _ in range(session.max_tool_calls+1):
            line=self.input_stream.readline(1_000_001)
            if not line:
                raise EOFError("External session closed before a structured final result")
            if len(line)>1_000_000:
                raise ValueError("JSONL request exceeds bounded message size")
            try:
                request=json.loads(line)
            except ValueError:
                response=session.call("__protocol.invalid_json__",{"reason":"Request was not valid JSON"})
                self._emit({"type":"tool_result","response":response})
                continue
            if isinstance(request,dict) and request.get("op")=="final":
                final=request.get("result")
                if not isinstance(final,dict) or set(final)-{"artifacts","completed_actions","facts","text"}:
                    raise ValueError("Final result must match the candidate result schema")
                return CandidateResult(**final)
            if isinstance(request,dict) and set(request)=={"op","tool","arguments"} and request["op"]=="tool" and isinstance(request["tool"],str) and isinstance(request["arguments"],dict):
                response=session.call(request["tool"],request["arguments"])
            else:
                response=session.call("__protocol.invalid_request__",{"reason":"Expected tool request or final result"})
            self._emit({"type":"tool_result","response":response})
        raise ValueError("External controller exceeded fixed session message budget")
