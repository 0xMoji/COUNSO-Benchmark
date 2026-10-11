"""Minimal PEP 517 pure-Python wheel/sdist backend, using only Python's stdlib.

No dependency resolution, network access, commands, credentials or SDKs. The
backend packages only the owned core/public fixtures/schemas, not run evidence.
"""
import base64
import csv
import hashlib
import io
import tarfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

NAME = "office_capability_kit"
VERSION = "0.5.0.dev0"
DIST_INFO = f"{NAME}-{VERSION}.dist-info"
ROOT = Path(__file__).resolve().parents[2]
METADATA = "Metadata-Version: 2.1\nName: office-capability-kit\nVersion: 0.5.0.dev0\nSummary: Evidence-typed office fixture runner; not a live model benchmark\nRequires-Python: >=3.11\n\nPrivate development kit. Code and fixture licensing awaits owner approval.\n"
WHEEL = "Wheel-Version: 1.0\nGenerator: officekit-stdlib-backend\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
ENTRY = "[console_scripts]\nofficekit = officekit.cli:main\n"


def get_requires_for_build_wheel(config_settings=None):
    return []


def get_requires_for_build_sdist(config_settings=None):
    return []


def _payload():
    mapping = [(ROOT/"src"/"officekit", "officekit"), (ROOT/"tasks"/"office", "officekit/tasks"), (ROOT/"schemas", "officekit/schemas")]
    for source_root, package_root in mapping:
        for path in sorted(source_root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix in {".py", ".json", ".csv", ".txt"}:
                yield package_root+"/"+path.relative_to(source_root).as_posix(), path.read_bytes()
    yield DIST_INFO+"/METADATA", METADATA.encode()
    yield DIST_INFO+"/WHEEL", WHEEL.encode()
    yield DIST_INFO+"/entry_points.txt", ENTRY.encode()


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    destination = Path(metadata_directory)/DIST_INFO
    destination.mkdir(parents=True, exist_ok=True)
    (destination/"METADATA").write_text(METADATA, encoding="utf-8")
    (destination/"WHEEL").write_text(WHEEL, encoding="utf-8")
    (destination/"entry_points.txt").write_text(ENTRY, encoding="utf-8")
    return DIST_INFO


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    name = f"{NAME}-{VERSION}-py3-none-any.whl"
    record_stream = io.StringIO(newline="")
    record = csv.writer(record_stream, lineterminator="\n")
    with ZipFile(Path(wheel_directory)/name, "w", compression=ZIP_DEFLATED) as wheel:
        for path, content in _payload():
            entry=ZipInfo(path,date_time=(1980,1,1,0,0,0))
            entry.compress_type=ZIP_DEFLATED
            entry.external_attr=0o100644 << 16
            wheel.writestr(entry, content)
            digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
            record.writerow([path,"sha256="+digest,str(len(content))])
        record.writerow([DIST_INFO+"/RECORD", "", ""])
        entry=ZipInfo(DIST_INFO+"/RECORD",date_time=(1980,1,1,0,0,0))
        entry.compress_type=ZIP_DEFLATED
        entry.external_attr=0o100644 << 16
        wheel.writestr(entry,record_stream.getvalue())
    return name


def build_sdist(sdist_directory, config_settings=None):
    prefix = f"{NAME}-{VERSION}"
    name = prefix+".tar.gz"
    with tarfile.open(Path(sdist_directory)/name, "w:gz") as stream:
        paths = [ROOT/"pyproject.toml"]
        for folder in [ROOT/"src"/"officekit",ROOT/"tasks"/"office",ROOT/"schemas"]:
            paths += [p for p in sorted(folder.rglob("*")) if p.is_file() and "__pycache__" not in p.parts and p.suffix in {".py", ".json", ".csv", ".txt"}]
        for path in paths:
            stream.add(path,arcname=prefix+"/"+path.relative_to(ROOT).as_posix())
    return name
