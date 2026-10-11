"""Six case slots. This engineering kit adds neither cases nor model samples."""
REGISTRY = {
    "office-evidence": {"family": "office", "status": "IMPLEMENTED", "title": "Reconcile source evidence"},
    "office-data": {"family": "office", "status": "IMPLEMENTED", "title": "Reconcile CSV and deliver files"},
    "office-tools": {"family": "office", "status": "IMPLEMENTED", "title": "Prepare draft and private hold"},
    "office-recovery": {"family": "office", "status": "IMPLEMENTED", "title": "Recover committed tool request"},
    "ui-dashboard": {"family": "ui", "status": "RESERVED_ADAPTER", "title": "Dashboard interaction acceptance"},
    "ui-planner": {"family": "ui", "status": "RESERVED_ADAPTER", "title": "Planner conflict acceptance"},
}
