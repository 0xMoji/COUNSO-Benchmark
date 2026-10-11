"""Small semantic checks used in the runner; full wire schemas ship separately."""
from math import isfinite
from .model import ERROR_CLASSES,STATUSES


def validate_atom(value):
    required={"id","dimension","weight","status","error_class","expected","observed","evidence","required_probe_ids","depends_on"}
    if not isinstance(value,dict) or not required<=set(value):raise ValueError("Incomplete typed atom")
    if not isinstance(value["id"],str) or not isinstance(value["dimension"],str):raise ValueError("Atom IDs/dimensions must be strings")
    weight=value["weight"]
    if isinstance(weight,bool) or not isinstance(weight,(int,float)) or not isfinite(weight) or not 0<weight<=100:raise ValueError("Invalid atom weight")
    if value["status"] not in STATUSES:raise ValueError("Invalid factual status")
    if value["status"]=="PASS" and (value["error_class"] is not None or not value["evidence"]):raise ValueError("PASS requires evidence and no error class")
    if value["status"]!="PASS" and value["error_class"] not in ERROR_CLASSES:raise ValueError("FAIL/UNKNOWN requires classified error")
    for key in ("evidence","required_probe_ids","depends_on"):
        if not isinstance(value[key],list):raise ValueError(f"Atom {key} must be an array")
    for evidence in value["evidence"]:
        if not isinstance(evidence,dict) or evidence.get("kind") not in ("artifact","tool_event","state","probe"):raise ValueError("Invalid evidence kind")
        if not any(evidence.get(k) for k in ("artifact","event_id","probe_id")):raise ValueError("Evidence reference is missing")
    return value


def validate_result(value):
    atoms=value["atoms"]
    for a in atoms:validate_atom(a)
    if len({a["id"] for a in atoms})!=len(atoms):raise ValueError("Atom IDs must be unique")
    if sum(a["weight"] for a in atoms)!=100 or value["denominator"]!=100:raise ValueError("Result denominator must remain fixed at 100")
    earned=sum(a["weight"] for a in atoms if a["status"]=="PASS")
    unknown=sum(a["weight"] for a in atoms if a["status"]=="UNKNOWN")
    if value["earned"]!=earned or value["unknown_weight"]!=unknown or value["score_lower"]!=earned or value["score_upper"]!=earned+unknown or value["coverage_percent"]!=100-unknown or value["quality_complete"]!=(unknown==0):raise ValueError("Result aggregate does not match typed facts")
    return value
