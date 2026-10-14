"""Round-trip source releases and platform-independent execution identity."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from counso_bench.build import build
from counso_bench.catalog import validate_package
from counso_bench.io import load_json, sha256, write_json
from counso_bench.mock import execution_fingerprint
from counso_bench.release import freeze, release


class ReleasePortabilityTests(unittest.TestCase):
    def test_source_zip_round_trip_preserves_frozen_package(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);root=base/'source'
            build(root)
            (root/'.gitattributes').write_bytes(b'* text=auto eol=lf\n')
            freeze(root)
            archive=base/'source.zip';release(root,archive)
            with zipfile.ZipFile(archive) as source:
                self.assertTrue(all(n.startswith('COUNSO-Benchmark/') and '\\' not in n for n in source.namelist()))
                source.extractall(base/'extracted')
            extracted=base/'extracted/COUNSO-Benchmark'
            self.assertTrue(validate_package(extracted)['valid'])
            self.assertEqual(execution_fingerprint(root),execution_fingerprint(extracted))
            paths=[item['path'] for item in load_json(extracted/'provenance/file_manifest.json')['files']]
            self.assertIn('.gitattributes',paths)
            self.assertTrue(all('\\' not in p for p in paths))
            self.assertEqual(paths,sorted(paths))

    def test_execution_identity_uses_portable_paths_and_json_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'fixtures/nested/input.json'
            write_json(path,{'text':'line one\nline two'})
            uppercase=root/'fixtures/Z.json';write_json(uppercase,{'value':1})
            self.assertNotIn(b'\r\n',path.read_bytes())
            expected=[('fixtures/Z.json',sha256(uppercase)),('fixtures/nested/input.json',sha256(path))]
            digest=hashlib.sha256(json.dumps(expected,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
            self.assertEqual(execution_fingerprint(root),digest)
