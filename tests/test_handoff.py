"""Public bundle and private evidence boundaries, including real loopback services."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from counso_bench.automation import VERSION, configuration, prepare, score_suite, compare_reports
from counso_bench.catalog import contracts
from counso_bench.handoff import handoff, collect
from counso_bench.io import ROOT, BenchError, load_json, write_json
from counso_bench.mock import running_mock


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.attempt = self.base / 'assessor'
        self.bundle = self.base / 'candidate'
        self.sid = 'R01-ticket-triage'
        self.plan = prepare(self.attempt, configuration('MODEL_A', agent='COUNSO'),
                            [self.sid], origin='SIMULATED')

    def tearDown(self):
        self.tmp.cleanup()

    def submit(self):
        response = deepcopy(contracts(self.sid)['reference_response'])
        response['schema_version'] = VERSION
        write_json(self.bundle / 'output/response.json', response)

    def test_round_trip_collects_only_outputs_and_scores_with_private_config(self):
        handoff(self.attempt, self.sid, self.bundle)
        names = {p.name for p in self.bundle.iterdir()}
        self.assertEqual(names, {'START.md', 'input', 'output', 'ticket.json'})
        self.assertFalse(any(p.name in {'gold', 'counso_bench', 'observations.json', 'run.json'}
                             for p in self.bundle.rglob('*')))
        self.assertEqual(list((self.bundle / 'output').iterdir()), [])
        self.submit()
        write_json(self.bundle / 'run.json', {'configuration': {'model_label': 'FORGED'}})
        write_json(self.bundle / 'service/observations.json', {'events': ['FORGED']})
        collect(self.attempt, self.bundle)
        report = score_suite(self.attempt)
        self.assertEqual(report['main']['pass'], 1)
        self.assertEqual(report['configuration']['model_label'], 'MODEL_A')
        self.assertFalse((self.attempt / self.plan['entries'][0]['observations_path']).exists())

    def test_wrong_attempt_or_repeat_is_rejected_without_importing(self):
        handoff(self.attempt, self.sid, self.bundle)
        self.submit()
        original = load_json(self.bundle / 'ticket.json')
        for field, wrong in [('attempt_id', 'other-attempt'), ('repeat', 2), ('input_sha256', 'wrong')]:
            with self.subTest(field=field):
                write_json(self.bundle / 'ticket.json', {**original, field: wrong})
                with self.assertRaises(BenchError):
                    collect(self.attempt, self.bundle)
                self.assertFalse((self.attempt / self.plan['entries'][0]['response_path']).exists())

    def test_recollection_cannot_overwrite_first_submission(self):
        handoff(self.attempt, self.sid, self.bundle)
        self.submit()
        collect(self.attempt, self.bundle)
        write_json(self.bundle / 'output/response.json', {'changed': True})
        with self.assertRaises(BenchError):
            collect(self.attempt, self.bundle)
        self.assertEqual(score_suite(self.attempt)['main']['pass'], 1)

    def test_empty_and_malformed_submissions_remain_unknown_and_fail(self):
        handoff(self.attempt, self.sid, self.bundle)
        collect(self.attempt, self.bundle)
        self.assertEqual(score_suite(self.attempt)['main']['unknown'], 1)
        other = self.base / 'other-assessor'
        prepare(other, configuration('MODEL_A'), [self.sid], origin='SIMULATED')
        bundle = self.base / 'other-candidate'
        handoff(other, self.sid, bundle)
        (bundle / 'output/response.json').write_text('broken JSON', encoding='utf-8')
        collect(other, bundle)
        self.assertEqual(score_suite(other)['main']['fail'], 1)

    def test_assessor_artifacts_and_resource_overflow_are_rejected(self):
        handoff(self.attempt, self.sid, self.bundle)
        self.submit()
        reserved = self.bundle / 'output/.assessor/fake.json'
        write_json(reserved, {'passed': True})
        with self.assertRaises(BenchError):
            collect(self.attempt, self.bundle)
        reserved.unlink()
        reserved.parent.rmdir()
        with patch('counso_bench.handoff.MAX_TOTAL_BYTES', 1):
            with self.assertRaises(BenchError):
                collect(self.attempt, self.bundle)
        self.assertFalse((self.attempt / self.plan['entries'][0]['response_path']).exists())

    def test_linked_output_is_not_followed(self):
        handoff(self.attempt, self.sid, self.bundle)
        private = self.base / 'private.txt'
        private.write_text('private', encoding='utf-8')
        try:
            (self.bundle / 'output/linked.txt').symlink_to(private)
        except OSError as exc:
            if getattr(exc, 'winerror', None) == 1314:
                self.skipTest('Windows account lacks symlink creation permission')
            raise
        with self.assertRaises(BenchError):
            collect(self.attempt, self.bundle)

    def test_nested_export_and_existing_output_are_rejected(self):
        for path in (self.attempt / 'candidate', ROOT / 'exports/candidate', self.base):
            with self.subTest(path=path), self.assertRaises(BenchError):
                handoff(self.attempt, self.sid, path)

    def test_changing_only_model_preserves_existing_comparison_flow(self):
        handoff(self.attempt, self.sid, self.bundle)
        self.submit()
        collect(self.attempt, self.bundle)
        other = self.base / 'model-b'
        plan = prepare(other, configuration('MODEL_B', agent='COUNSO'), [self.sid], origin='SIMULATED')
        response = load_json(self.bundle / 'output/response.json')
        write_json(other / plan['entries'][0]['response_path'], response)
        result = compare_reports({'A': score_suite(self.attempt), 'B': score_suite(other)})
        self.assertTrue(result['comparability']['same_agent_label'])
        self.assertEqual(result['configurations']['B']['configuration']['model_label'], 'MODEL_B')

    def test_mock_runs_on_assessor_and_only_endpoint_crosses_boundary(self):
        sid = 'R-B15-idempotent-draft'
        attempt = self.base / 'mock-assessor'
        plan = prepare(attempt, configuration('CONTROL'), [sid], origin='SIMULATED')
        entry = plan['entries'][0]
        obs = attempt / entry['observations_path']
        bundle = self.base / 'mock-candidate'
        with self.assertRaises(BenchError):
            handoff(attempt, sid, bundle)
        self.assertFalse(bundle.exists())
        with running_mock(sid, obs, run_id=entry['run_id']) as (endpoint, state):
            write_json(attempt / entry['endpoint_path'], {
                'endpoint': endpoint, 'scenario_id': sid, 'run_id': entry['run_id'],
                'session_id': state.session_id, 'execution_fingerprint': state.execution_fingerprint})
            handoff(attempt, sid, bundle)
            self.assertEqual(load_json(bundle / 'endpoint.json'), {'endpoint': endpoint})
            self.assertFalse(any(p.name == 'observations.json' for p in bundle.rglob('*')))
            result = subprocess.run([sys.executable, '-X', 'utf8', str(bundle / 'input/inputs/mock_client.py'),
                                     '--endpoint', endpoint, 'draft-lookup', 'K-DRAFT-0001'],
                                    cwd=bundle, capture_output=True, check=True)
            draft = json.loads(result.stdout)['draft']
            self.assertEqual(draft['draft_id'], 'DRAFT-0001')
            response = deepcopy(contracts(sid)['reference_response'])
            response['schema_version'] = VERSION
            write_json(bundle / 'output/response.json', response)
            write_json(bundle / 'output' / response['result']['draft_file'], draft)
            collect(attempt, bundle)
        report = score_suite(attempt)
        self.assertTrue(report['case_reports'][0]['observations_identity_verified'])
        self.assertEqual(report['main']['pass'], 1)

    def test_standalone_ui_preview_uses_only_exported_data(self):
        import importlib.util
        sid = 'R-U06-data-update'
        attempt = self.base / 'ui-assessor'
        prepare(attempt, configuration('CONTROL'), [sid], origin='SIMULATED')
        bundle = self.base / 'ui-candidate'
        handoff(attempt, sid, bundle)
        self.assertFalse(any(p.name in {'gold', 'counso_bench'} for p in bundle.rglob('*')))
        entry = bundle / 'output/ui/index.html'
        entry.parent.mkdir()
        entry.write_text('<h1>Preview</h1>', encoding='utf-8')
        spec = importlib.util.spec_from_file_location('public_preview', bundle / 'preview.py')
        preview = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(preview)
        server = preview.create_server(entry, bundle / 'input/inputs', 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f'http://127.0.0.1:{server.server_port}'
        try:
            with urlopen(endpoint + '/data.json?dataset=updated') as response:
                actual = json.load(response)
            expected = load_json(bundle / 'input/inputs/extensions/sales-updated.json')['data']
            self.assertEqual(actual, expected)
            with self.assertRaises(HTTPError) as error:
                urlopen(endpoint + '/%2e%2e/%2e%2e/ticket.json')
            error.exception.close()
            with urlopen(Request(endpoint + '/api/requests', data=b'{"x":1}')) as response:
                self.assertEqual(json.load(response), {'id': 'REQ-0001'})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
