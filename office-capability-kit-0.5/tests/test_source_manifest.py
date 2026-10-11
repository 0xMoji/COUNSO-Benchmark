"""Manifest integrity controls; temporary copies never become package results."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SourceManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="officekit-source-test-")
        self.root = Path(self.temp.name) / "package"
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(".venv", "node_modules", "__pycache__", ".local-runs"))

    def tearDown(self):
        self.temp.cleanup()

    def check_copy(self, expected):
        result = subprocess.run([sys.executable, "-B", str(self.root / "scripts/verify_source.py")],
                                cwd=self.temp.name, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def update_manifest(self, change):
        path = self.root / "SOURCE_MANIFEST.json"
        value = json.loads(path.read_text())
        change(value)
        path.write_text(json.dumps(value))

    def test_clean_copy_verifies_without_environment_dependencies(self):
        self.check_copy(0)

    def test_source_byte_change_and_unlisted_file_are_rejected(self):
        path = self.root / "README.md"
        original = path.read_bytes()
        path.write_bytes(original + b"changed\n")
        self.check_copy(1)
        path.write_bytes(original)
        (self.root / "unexpected.json").write_text("{}")
        self.check_copy(1)

    def test_traversal_duplicate_absolute_and_symlink_entries_are_rejected(self):
        for name in ("../outside.txt", "/outside.txt", "src//officekit/cli.py", "src/./officekit/cli.py", "C:/outside.txt", "file:outside.txt"):
            with self.subTest(name=name):
                original = (self.root / "SOURCE_MANIFEST.json").read_bytes()
                self.update_manifest(lambda value: value["files"][0].update(path=name))
                self.check_copy(1)
                (self.root / "SOURCE_MANIFEST.json").write_bytes(original)
        original = (self.root / "SOURCE_MANIFEST.json").read_bytes()
        self.update_manifest(lambda value: value["files"].append(value["files"][0]))
        self.check_copy(1)
        (self.root / "SOURCE_MANIFEST.json").write_bytes(original)
        path = self.root / "README.md"
        target = Path(self.temp.name) / "outside.txt"
        target.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(target)
        self.check_copy(1)

    def test_generated_local_products_are_not_source_manifest_entries(self):
        local = self.root / ".local-runs/example"
        local.mkdir(parents=True)
        (local / "report.json").write_text("{}")
        self.check_copy(0)
        self.update_manifest(lambda value: value["files"].append({"path": ".local-runs/example/report.json", "bytes": 2, "sha256": hashlib.sha256(b"{}").hexdigest()}))
        self.check_copy(1)


if __name__ == "__main__":
    unittest.main()
