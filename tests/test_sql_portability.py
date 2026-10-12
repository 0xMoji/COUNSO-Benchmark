"""SQL controls remain portable without disabling an authorizer with None."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from counso_bench.checks import evaluate
from counso_bench.io import ROOT


class SQLPortabilityTests(unittest.TestCase):
    def check(self, sql):
        return evaluate({'kind': 'sql_revenue', 'path': 'result.sql'},
                        {'result': {'sql': sql}}, Path(tempfile.gettempdir()), ROOT)

    def test_reference_passes_callable_only_authorizer_implementation(self):
        connect = sqlite3.connect
        class CallableOnly(sqlite3.Connection):
            def set_authorizer(self, callback):
                if not callable(callback):
                    raise sqlite3.DatabaseError('Python 3.10 callable-only authorizer')
                return super().set_authorizer(callback)
        def compatible(*args, **kwargs):
            return connect(*args, factory=CallableOnly, **kwargs)
        with patch('sqlite3.connect', side_effect=compatible):
            self.assertTrue(self.check("SELECT SUM(CAST(amount AS REAL)) FROM transactions WHERE type='SALE'")[0])

    def test_perturbation_policy_still_rejects_constant_and_other_tables(self):
        for sql in ('SELECT 500', 'SELECT COUNT(*) FROM sqlite_master',
                    "SELECT SUM(CAST(amount AS REAL)) FROM transactions; DELETE FROM transactions"):
            with self.subTest(sql=sql):
                self.assertFalse(self.check(sql)[0])
        connect = sqlite3.connect
        class WarningCompat(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                if ';' in sql:
                    raise sqlite3.Warning('You can only execute one statement at a time.')
                return super().execute(sql, *args, **kwargs)
        with patch('sqlite3.connect', side_effect=lambda *a, **k: connect(*a, factory=WarningCompat, **k)):
            self.assertFalse(self.check('SELECT 500; DELETE FROM transactions')[0])


class EvidenceFilenameTests(unittest.TestCase):
    def test_observation_file_names_do_not_embed_run_id_path_characters(self):
        from contextlib import contextmanager
        from copy import deepcopy
        from types import SimpleNamespace
        from counso_bench.catalog import select, contracts
        from counso_bench.io import write_json
        from counso_bench.selftest import observed_reference
        paths = []
        @contextmanager
        def mock_service(sid, path, run_id):
            paths.append(path)
            write_json(path, {'run_id': run_id})
            yield 'http://127.0.0.1:1', SimpleNamespace()
        case = select('R-B15-idempotent-draft')
        response = deepcopy(contracts(case['id'])['reference_response'])
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"draft":{}}'
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'output'; out.mkdir()
            with patch('counso_bench.selftest.running_mock', mock_service), patch('urllib.request.urlopen', return_value=Reply()):
                observed_reference(case, response, out, run_id='attempt:case:1/../../unsafe')
            self.assertEqual(paths[0].parent, out.parent)
            self.assertNotIn(':', paths[0].name)
            self.assertNotIn('unsafe', paths[0].name)
