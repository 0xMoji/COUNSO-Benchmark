import hashlib
import json
from pathlib import Path
from importlib.resources import files

def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def artifact(root: Path, path: Path, kind: str = "artifact") -> dict:
    return {"kind": kind, "artifact": path.relative_to(root).as_posix(), "sha256": sha256_file(path), "bytes": path.stat().st_size}

def public_resources(case_id: str):
    try:
        return files("officekit.tasks").joinpath(case_id)
    except ModuleNotFoundError:
        # Source-tree development only; installed wheels package this directory.
        source_path = Path(__file__).resolve().parents[2] / "tasks" / "office" / case_id
        if source_path.is_dir():
            return source_path
        raise

def load_fixture(case_id: str) -> dict:
    return json.loads(public_resources(case_id).joinpath("fixture.json").read_text(encoding="utf-8"))
