"""Public file handoff and unverified external grading. No code is executed."""
import json
import shutil
import time
from pathlib import Path
from dataclasses import asdict
from . import __version__
from .io import artifact, load_fixture, public_resources, write_json
from .registry import REGISTRY
from .scoring import score
from .tools import LocalSession, utc_now


def materialize_public(case_id, root):
    if case_id not in REGISTRY or REGISTRY[case_id]["family"] != "office":
        raise ValueError("Public office bundle requires one of the four implemented office cases")
    fixture = load_fixture(case_id)
    resources = public_resources(case_id)
    for name in fixture["input_files"]:
        dest = root/"inputs"/name
        dest.parent.mkdir(parents=True,exist_ok=True)
        dest.write_bytes(resources.joinpath(name).read_bytes())
    for name in ("prompt.txt", "tools.json", "fixture.json"):
        (root/name).write_bytes(resources.joinpath(name).read_bytes())
    return fixture


def prepare(case_id, output):
    root = Path(output).absolute()
    if root.exists():
        raise ValueError("Output directory must be fresh and nonexistent")
    root.mkdir(parents=True)
    fixture = materialize_public(case_id,root)
    # Service state is available only through the runtime tools, never the export.
    (root/"fixture.json").unlink()
    write_json(root/"task_manifest.json",{"schema_version":"0.5.0","case_id":case_id,"input_files":fixture["input_files"],"allowed_output_files":fixture["allowed_output_files"],"max_tool_calls":32,"isolation":"INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX","tool_runtime":"officekit session"})
    manifest = {"schema_version":"0.5.0", "case_id":case_id,"bundle_kind":"PUBLIC_SYNTHETIC_TASK_ONLY", "contains_evaluator_gold":False, "contains_credentials":False,
                "artifact_exchange_capability":"FILE_TASKS_ONLY", "iterative_tool_capability":"USE_JSONL_SESSION", "live_model_capability":"UNKNOWN",
                "artifacts":[artifact(root,p) for p in sorted(root.rglob("*")) if p.is_file()]}
    write_json(root/"public_bundle.json",manifest)
    return manifest


def verify_bundle(bundle):
    manifest=json.loads((bundle/"public_bundle.json").read_text(encoding="utf-8"))
    if not isinstance(manifest,dict):raise ValueError("Public bundle manifest must be an object")
    case_id=manifest["case_id"]
    fixture=load_fixture(case_id)
    resources=public_resources(case_id)
    # Fixed cases only. The grader doesn't accept rewritten task inputs or manifests.
    names=["prompt.txt","tools.json","task_manifest.json"]+["inputs/"+name for name in fixture["input_files"]]
    expected_paths=set(names)
    entries=manifest.get("artifacts")
    if not isinstance(entries,list) or any(not isinstance(a,dict) or not isinstance(a.get("artifact"),str) for a in entries):
        raise ValueError("Public bundle artifacts must be structured references")
    listed={a["artifact"]:a for a in entries}
    if set(listed)!=expected_paths:
        raise ValueError("Public bundle manifest does not match this fixed case")
    for rel in names:
        target=bundle/rel
        if target.is_symlink() or not target.is_file() or artifact(bundle,target)["sha256"]!=listed[rel]["sha256"]:
            raise ValueError(f"Public fixture integrity mismatch: {rel}")
        if rel != "task_manifest.json":
            resource=resources.joinpath(rel.removeprefix("inputs/"))
            if target.read_bytes()!=resource.read_bytes():
                raise ValueError(f"Fixed task input was changed: {rel}")
        else:
            expected={"schema_version":"0.5.0","case_id":case_id,"input_files":fixture["input_files"],"allowed_output_files":fixture["allowed_output_files"],"max_tool_calls":32,"isolation":"INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX","tool_runtime":"officekit session"}
            if json.loads(target.read_text(encoding="utf-8"))!=expected:
                raise ValueError("Public task manifest was changed")
    return case_id,fixture


def _load_optional(path, fallback):
    if path is None:
        return fallback, "MISSING"
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")),None
    except (ValueError,UnicodeError,OSError):
        return fallback,"MALFORMED"


def grade(bundle, artifacts_dir, candidate_path, output, ledger_path=None, state_path=None):
    started_at,started_ns=utc_now(),time.perf_counter_ns()
    bundle=Path(bundle).absolute()
    case_id,fixture=verify_bundle(bundle)
    root=Path(output).absolute()
    if root.exists():raise ValueError("Output directory must be fresh and nonexistent")
    root.mkdir(parents=True)
    materialize_public(case_id,root)
    artifacts_dir=Path(artifacts_dir).absolute()
    for name in fixture["allowed_output_files"]:
        source=artifacts_dir/"outputs"/name
        if source.is_symlink() or source.exists() and not source.resolve().is_relative_to(artifacts_dir.resolve()):
            raise ValueError("Candidate output symlinks outside the artifact root are not imported")
        if source.is_file():
            destination=root/"outputs"/name
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,destination)
    candidate,candidate_error=_load_optional(candidate_path,{})
    if not isinstance(candidate,dict):candidate,candidate_error={},"MALFORMED"
    write_json(root/"candidate.json",candidate)
    external_ledger,ledger_error=_load_optional(ledger_path,{"events":[]})
    external_state,state_error=_load_optional(state_path,fixture["mock_state"])
    if not isinstance(external_ledger,dict) or not isinstance(external_ledger.get("events"),list):
        external_ledger,ledger_error={"events":[]},"MALFORMED"
    if not isinstance(external_state,dict):external_state,state_error=fixture["mock_state"],"MALFORMED"
    descriptions=json.loads((root/"tools.json").read_text(encoding="utf-8"))
    session=LocalSession(root,fixture,(root/"prompt.txt").read_text(encoding="utf-8"),descriptions)
    session.evidence_provenance="EXTERNAL_UNVERIFIED"
    safe_events=[]
    for event in external_ledger["events"]:
        required={"event_id","tool","arguments","accepted","committed","effect","status"}
        if not isinstance(event,dict) or not required<=set(event) or not isinstance(event["arguments"],dict) or not isinstance(event["accepted"],bool) or not isinstance(event["committed"],bool) or not all(isinstance(event[k],str) for k in ("event_id","tool","effect","status")):
            ledger_error="MALFORMED"
            continue
        event={k:v for k,v in event.items() if k in {"event_id","tool","arguments","accepted","committed","effect","status","result","error_class","error","started_at","finished_at","duration_ns"}}
        if not isinstance(event.get("result",{}),dict):event["result"]={}
        event["started_at"]="UNKNOWN"
        event["finished_at"]="UNKNOWN"
        event["duration_ns"]="UNKNOWN"
        event["timing_provenance"]="EXTERNAL_UNVERIFIED"
        event.setdefault("error_class",None)
        safe_events.append(event)
    session.ledger=safe_events
    session.state=fixture["mock_state"]  # Unverified external state cannot establish effects/resources.
    write_json(root/"external_ledger.json",external_ledger)
    write_json(root/"external_state.json",external_state)
    session.persist()
    result=score(root,session,candidate)
    if candidate_error:
        from .scoring import summarize
        for a in result["atoms"]:
            if a["id"]=="delivery.claims":a.update(status="FAIL",error_class="FUNCTIONAL_RESULT",observed={"candidate_parse_error":candidate_error})
        result=summarize(result["atoms"])
    duration=time.perf_counter_ns()-started_ns
    report={"schema_version":"0.5.0","kit_version":__version__,"case_id":case_id,"run_kind":"EXTERNAL_FILE_IMPORT", "provider":{"name":"external-file-import","kind":"unverified-artifact-handoff","is_live_model":False,"live_capability":"UNKNOWN"},"model_calls":"UNKNOWN","core_model_calls":0,"external_model_calls":"UNKNOWN", "live_model_capability":"UNKNOWN","live_service_capability":"UNKNOWN","old_release_modified":False,"rank_stability":"NOT_MEASURED",
            "evidence_provenance":"EXTERNAL_UNVERIFIED","external_errors":{"candidate":candidate_error,"ledger":ledger_error,"state":state_error},
            "timing":{"started_at":started_at,"finished_at":utc_now(),"duration_ns":duration,"clock":"perf_counter_ns","boundary":"Before verified bundle read through independent scorer return; excludes report/manifest serialization"},
            "result":result,"raw_artifacts":[artifact(root,p) for p in sorted(root.rglob("*")) if p.is_file()]}
    write_json(root/"report.json",report)
    write_json(root/"manifest.json",{"schema_version":"0.5.0","hash_algorithm":"sha256","artifacts":[artifact(root,p) for p in sorted(root.rglob("*")) if p.is_file() and p.name!="manifest.json"],"self_hash_excluded":True})
    return report


def grade_ui(adapter_report_path, output):
    """Use the same typed aggregate, but an imported browser claim isn't proof.

    The wheel does not contain or launch the repository's Node/browser adapter.
    Actual browser acceptance is kept UNKNOWN on this unverified import route.
    """
    from .contracts import validate_atom
    from .scoring import summarize
    started_at,started_ns=utc_now(),time.perf_counter_ns()
    incoming=json.loads(Path(adapter_report_path).read_text(encoding="utf-8"))
    if not isinstance(incoming,dict):raise ValueError("UI adapter report must be an object")
    if incoming.get("case_id") not in ("ui-dashboard","ui-planner") or incoming.get("schema_version")!="officekit-ui-report-1":
        raise ValueError("Expected a reserved-case officekit UI adapter report")
    atoms=incoming.get("atoms")
    if not isinstance(atoms,list):raise ValueError("UI adapter requires typed atoms")
    for a in atoms:validate_atom(a)
    root=Path(output).absolute()
    if root.exists():raise ValueError("Output directory must be fresh and nonexistent")
    root.mkdir(parents=True)
    write_json(root/"adapter_report.json",incoming)
    evidence=[artifact(root,root/"adapter_report.json")]
    normalized=[]
    for a in atoms:
        normalized.append({**{k:a[k] for k in ("id","dimension","weight","expected","required_probe_ids","depends_on")},"status":"UNKNOWN","error_class":"UNKNOWN_SOURCE","observed":{"unverified_adapter_status":a["status"],"unverified_adapter_observed":a["observed"]},"evidence":evidence})
    result=summarize(normalized)
    report={"schema_version":"0.5.0","kit_version":__version__,"case_id":incoming["case_id"],"run_kind":"UI_ADAPTER_IMPORT_UNVERIFIED",
            "provider":{"name":"ui-adapter-import","kind":"unverified-browser-report","is_live_model":False,"live_capability":"UNKNOWN","requested_model":"UNKNOWN","verified_model":"UNKNOWN","verified_backend":"UNKNOWN"},
            "model_calls":"UNKNOWN","core_model_calls":0,"external_model_calls":"UNKNOWN","live_model_capability":"UNKNOWN","live_service_capability":"UNKNOWN","old_release_modified":False,"rank_stability":"NOT_MEASURED",
            "actual_browser_executed":"UNKNOWN","evidence_provenance":"EXTERNAL_UNVERIFIED","adapter_claims":{"tested_level":incoming.get("tested_level"),"actual_browser_executed":incoming.get("actual_browser_executed")},
            "timing":{"started_at":started_at,"finished_at":utc_now(),"duration_ns":time.perf_counter_ns()-started_ns,"clock":"perf_counter_ns","boundary":"Adapter JSON read through typed aggregate; excludes browser/model execution and report serialization"},
            "result":result,"raw_artifacts":evidence}
    write_json(root/"report.json",report)
    write_json(root/"manifest.json",{"schema_version":"0.5.0","hash_algorithm":"sha256","artifacts":[artifact(root,p) for p in sorted(root.rglob("*")) if p.is_file() and p.name!="manifest.json"],"self_hash_excluded":True})
    return report
