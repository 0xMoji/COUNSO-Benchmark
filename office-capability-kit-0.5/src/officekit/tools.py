"""Permissioned local tools. Every invocation, accepted or rejected, is recorded."""
import copy
import csv
import hashlib
import io
import json
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from .io import artifact, write_json


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()

class ToolFailure(Exception):
    def __init__(self, message: str, error_class: str = "PROTOCOL_INTEGRATION"):
        super().__init__(message)
        self.error_class = error_class

class LocalSession:
    def __init__(self, root: Path, fixture: dict, prompt: str, descriptions: dict, max_tool_calls: int = 32):
        self.root, self.fixture = root, copy.deepcopy(fixture)
        self.case_id, self.prompt, self.tool_descriptions = fixture["case_id"], prompt, copy.deepcopy(descriptions)
        self.state = copy.deepcopy(fixture["mock_state"])
        self.ledger: list[dict[str, Any]] = []
        self.max_tool_calls = max_tool_calls
        self.allowed_tools = {item["name"]: item for item in descriptions["tools"]}
        self.written: dict[str, dict] = {}
        self.evidence_provenance = "LOCAL_EXECUTED"

    def call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        start_ns = time.perf_counter_ns()
        event = {"event_id": f"event-{len(self.ledger)+1:04d}", "tool": tool if isinstance(tool,str) else "__invalid_tool_name__", "arguments": copy.deepcopy(arguments) if isinstance(arguments,dict) else {"invalid_arguments_type":type(arguments).__name__},
                 "started_at": utc_now(), "effect": "NONE", "status": "REJECTED", "error_class": None,
                 "accepted": False, "committed": False, "duration_ns": 0}
        try:
            if len(self.ledger) >= self.max_tool_calls:
                raise ToolFailure("Tool call budget exhausted")
            if not isinstance(tool,str):
                raise ToolFailure("Tool name must be a string")
            if not isinstance(arguments, dict):
                raise ToolFailure("Tool arguments must be a JSON object")
            if tool not in self.allowed_tools:
                raise ToolFailure("Tool is not offered by this case; no effect occurred")
            result, effect, committed = self._dispatch(tool, arguments)
            event.update(status="ACCEPTED", accepted=True, committed=committed, effect=effect, result=copy.deepcopy(result))
            if result.get("transport_status") == "COMMIT_ACK_LOST":
                event["status"] = "COMMITTED_ACK_LOST"
            response = {"ok": result.get("transport_status") != "COMMIT_ACK_LOST", "event_id": event["event_id"], **result}
        except ToolFailure as exc:
            event.update(error_class=exc.error_class, error={"message": str(exc), "error_class": exc.error_class})
            response = {"ok": False, "event_id": event["event_id"], "error": event["error"]}
        except OSError as exc:
            event.update(error_class="INSTRUMENTATION", error={"message":str(exc), "error_class":"INSTRUMENTATION"})
            response = {"ok":False,"event_id":event["event_id"],"error":event["error"]}
        except (KeyError, ValueError, TypeError, csv.Error) as exc:
            event.update(error_class="PROTOCOL_INTEGRATION", error={"message": str(exc), "error_class": "PROTOCOL_INTEGRATION"})
            response = {"ok": False, "event_id": event["event_id"], "error": event["error"]}
        finally:
            event["duration_ns"] = time.perf_counter_ns() - start_ns
            event["finished_at"] = utc_now()
            self.ledger.append(event)
        return response

    def _args(self, args: dict, required: set[str], optional: set[str] = frozenset()) -> None:
        if set(args) - required - optional or required - set(args):
            raise ToolFailure(f"Arguments must include {sorted(required)}; optional {sorted(optional)}")

    def _input(self, name: str) -> Path:
        if not isinstance(name, str) or name not in self.fixture["input_files"]:
            raise ToolFailure("Input file is not in the public case manifest")
        return self.root / "inputs" / name

    def _dispatch(self, tool: str, args: dict) -> tuple[dict, str, bool]:
        if tool == "data.read_csv":
            self._args(args, {"file"})
            path = self._input(args["file"])
            with path.open(newline="", encoding="utf-8") as stream:
                reader = csv.DictReader(stream)
                rows = list(reader)
                headers = reader.fieldnames
            return {"headers": headers, "rows": rows, "source": artifact(self.root, path)}, "READ_ONLY", False
        if tool == "files.read_input":
            self._args(args, {"file"})
            path = self._input(args["file"])
            value = json.loads(path.read_text(encoding="utf-8"))
            return {"data": value, "source": artifact(self.root, path)}, "READ_ONLY", False
        if tool == "files.write":
            self._args(args, {"path", "content"})
            path, content = args["path"], args["content"]
            if not isinstance(path, str) or PurePosixPath(path).as_posix() != path:
                raise ToolFailure("Output path must be canonical POSIX relative path")
            allowed = {"outputs/" + name for name in self.fixture["allowed_output_files"]}
            if path not in allowed or not isinstance(content, str) or len(content.encode("utf-8")) > 1_000_000:
                raise ToolFailure("Output filename/content is outside the task contract")
            output = self.root / path
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8")
            item = artifact(self.root, output)
            self.written[path] = item
            return {"file": item}, "FILE_WRITE", True
        if tool == "files.list":
            self._args(args, set())
            return {"files": list(self.written.values())}, "READ_ONLY", False
        if tool == "mail.list_threads":
            self._args(args, set())
            return {"threads": [{"thread_id": t["thread_id"], "subject": t["subject"]} for t in self.state.get("threads", [])]}, "READ_ONLY", False
        if tool == "mail.get_thread":
            self._args(args, {"thread_id"})
            item = next((t for t in self.state.get("threads", []) if t["thread_id"] == args["thread_id"]), None)
            if item is None:
                raise ToolFailure("Thread not found", "UNKNOWN_SOURCE")
            return {"thread": copy.deepcopy(item)}, "READ_ONLY", False
        if tool == "calendar.list_events":
            self._args(args, set())
            return {"events": copy.deepcopy(self.state.get("events", []))}, "READ_ONLY", False
        if tool in ("mail.create_draft", "calendar.create_private_hold"):
            required = {"idempotency_key", "recipient", "subject", "body"} if tool == "mail.create_draft" else {"idempotency_key", "title", "start", "end", "privacy"}
            self._args(args, required)
            if not all(isinstance(v, str) and v for v in args.values()):
                raise ToolFailure("All service arguments must be non-empty strings")
            effect = "DRAFT_CREATE" if tool == "mail.create_draft" else "HOLD_CREATE"
            if effect not in self.fixture["authorized_effects"]:
                raise ToolFailure("This service effect is not authorized by the task")
            if tool == "mail.create_draft" and args["recipient"] not in self.fixture.get("authorized_recipients", []):
                raise ToolFailure("Recipient is outside the approved task contract")
            if tool == "calendar.create_private_hold":
                if args["privacy"] != "private":
                    raise ToolFailure("Only private holds are authorized")
                start, end = datetime.fromisoformat(args["start"]), datetime.fromisoformat(args["end"])
                if start.tzinfo is None or end.tzinfo is None or end <= start:
                    raise ToolFailure("Hold requires timezone-aware start/end with end after start")
            key = args["idempotency_key"]
            request = self.state["requests"].get(key)
            if request:
                if request["tool"] != tool or request["arguments"] != args:
                    raise ToolFailure("Idempotency key reuse with changed arguments")
                return {"resource": request["resource"], "deduplicated": True, "request_status": "COMMITTED"}, "READ_ONLY", False
            collection = "drafts" if tool == "mail.create_draft" else "holds"
            resource = {"id": f"{collection[:-1]}-{len(self.state[collection])+1:03d}", **copy.deepcopy(args)}
            self.state[collection].append(resource)
            self.state["requests"][key] = {"tool": tool, "arguments": copy.deepcopy(args), "resource": resource, "status": "COMMITTED"}
            if key in self.fixture.get("lose_ack_once_keys", []):
                return {"transport_status": "COMMIT_ACK_LOST", "request_status": "UNKNOWN", "idempotency_key": key}, effect, True
            return {"resource": resource, "deduplicated": False, "request_status": "COMMITTED"}, effect, True
        if tool == "service.get_request":
            self._args(args, {"idempotency_key"})
            request = self.state["requests"].get(args["idempotency_key"])
            return {"request_status": "COMMITTED" if request else "NOT_FOUND", "resource": copy.deepcopy(request["resource"]) if request else None}, "READ_ONLY", False
        raise ToolFailure("Offered tool has no implemented transport", "INSTRUMENTATION")

    def persist(self) -> None:
        write_json(self.root / "ledger.json", {"schema_version": "0.5.0", "evidence_provenance":self.evidence_provenance, "events": self.ledger})
        write_json(self.root / "state.json", self.state)
