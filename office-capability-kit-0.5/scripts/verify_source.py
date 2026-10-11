"""Verify this source-only package using Python's standard library.

The manifest hashes only package files and excludes itself. Caller-local build,
environment and run directories are ignored; no network or external state.
"""
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).absolute().parents[1]
MANIFEST = "SOURCE_MANIFEST.json"
LOCAL_ROOTS = {".git", ".venv", ".local-runs", "build", "dist"}


def local_product(parts):
    return (parts[0] in LOCAL_ROOTS or "__pycache__" in parts
            or parts[:3] == ("adapters", "standalone-ui", "node_modules"))


def source_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Invalid source-relative path")
    path = PurePosixPath(name)
    if (path.is_absolute() or path.as_posix() != name
            or any(part in {".", ".."} for part in name.split("/"))
            or local_product(path.parts) or name == MANIFEST):
        raise ValueError("Invalid source-relative path: " + name)
    current = ROOT
    if current.is_symlink():
        raise ValueError("Source root must not be a symlink")
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink source path: " + name)
    if not current.is_file():
        raise ValueError("Missing source file: " + name)
    return current


def inventory(directory=ROOT, parts=()):
    for entry in sorted(directory.iterdir(), key=lambda item: item.name):
        relative = parts + (entry.name,)
        if local_product(relative):
            continue
        if entry.is_symlink():
            raise ValueError("Symlink source path: " + "/".join(relative))
        if entry.is_dir():
            yield from inventory(entry, relative)
        elif entry.is_file():
            name = "/".join(relative)
            if name != MANIFEST:
                yield name
        else:
            raise ValueError("Non-regular source path: " + "/".join(relative))


def verify():
    manifest_path = ROOT / MANIFEST
    if ROOT.is_symlink() or manifest_path.is_symlink():
        raise ValueError("Source root and manifest must not be symlinks")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Source manifest must be an object")
    if manifest.get("schema_version") != 1 or manifest.get("hash_algorithm") != "sha256":
        raise ValueError("Unsupported source manifest")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ValueError("Source manifest files must be a list")
    names = set()
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("Invalid source manifest entry")
        name = item.get("path")
        path = source_path(name)
        if name in names:
            raise ValueError("Duplicate source path: " + name)
        names.add(name)
        content = path.read_bytes()
        if item.get("bytes") != len(content) or item.get("sha256") != hashlib.sha256(content).hexdigest():
            raise ValueError("Changed source bytes: " + name)
    if set(inventory()) != names:
        raise ValueError("Source inventory differs from manifest")
    print("Verified " + str(len(names)) + " source files; manifest excludes itself")


if __name__ == "__main__":
    try:
        verify()
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("Source verification failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
