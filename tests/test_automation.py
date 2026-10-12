"""Submission denominator and evidence controls, without candidate model calls."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from counso_bench.automation import (
    VERSION, configuration, prepare, score_auto, score_suite,
    aggregate_auto, compare_reports, validate_manifest, validate_score, markdown_report,
)
from counso_bench.catalog import contracts, select
from counso_bench.io import ROOT, BenchError, write_json, load_json


class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def attempt(self, name='a', repeats=1, cases=None, model='MODEL_A'):
        path = self.path / name
        plan = prepare(path, configuration(model), cases or ['R01-ticket-triage', 'R02-contract-diff'], repeats=repeats)
        return path, plan

    def submit(self, path, entry, mutation=None):
        response = deepcopy(contracts(entry['scenario_id'])['reference_response'])
        response['schema_version'] = VERSION
        if mutation: mutation(response)
        write_json(path / entry['response_path'], response)

    def score(self, response=None, checks=None, **kwargs):
        sid = 'R01-ticket-triage'
        contract = contracts(sid)
        if response is None:
            response = deepcopy(contract['reference_response'])
            response['schema_version'] = VERSION
        run = {'run_id': 'TEST-AUTO', 'scenario_id': sid, 'run_origin': 'SIMULATED',
               'rubric_version': VERSION, 'configuration': configuration('REFERENCE')}
        run.update(kwargs.pop('run_changes', {}))
        return score_auto(select(sid), checks or contract['checks'], response, run, self.path, ROOT, **kwargs)

    def test_manifest_exports_inputs_without_executing_or_answers(self):
        path, manifest = self.attempt()
        self.assertEqual(len(manifest['entries']), 2)
        for entry in manifest['entries']:
            inp = path / entry['input_dir']
            self.assertTrue((inp/'prompt.txt').is_file())
            self.assertEqual(list((path/entry['output_dir']).iterdir()), [])
            self.assertFalse(any('gold' in p.relative_to(inp).parts for p in inp.rglob('*')))
        self.assertEqual(manifest['configuration']['model_identity_source'], 'user_config')

    def test_missing_tasks_do_not_disappear(self):
        path, manifest = self.attempt()
        self.submit(path, manifest['entries'][0])
        report = score_suite(path)
        self.assertEqual(report['planned_count'], 2)
        self.assertEqual(report['submitted_count'], 1)
        self.assertEqual(report['submission_coverage'], .5)
        self.assertEqual(report['main'], {'planned': 2, 'pass': 1, 'fail': 0, 'unknown': 1,
                                          'success_rate_bounds': [.5, 1.]})
        self.assertIn('未提交 1 项', markdown_report(report))

    def test_empty_and_malformed_response_count_as_failed_delivery(self):
        for i, body in enumerate(['', '[]', '{bad', '{}']):
            path, manifest = self.attempt(str(i), cases=['R01-ticket-triage'])
            (path / manifest['entries'][0]['response_path']).write_text(body)
            report = score_suite(path)
            self.assertEqual(report['main']['fail'], 1)
            self.assertEqual(report['main']['planned'], 1)
            self.assertEqual(report['case_reports'][0]['objective_score'], 0)

    def test_known_critical_failure_survives_unknown(self):
        checks = [{'id': 'known', 'kind': 'eq', 'path': 'result.p1_ticket_ids', 'expected': ['WRONG'],
                   'critical': True, 'category': 'facts'},
                  {'id': 'unknown', 'kind': 'mock_observation', 'actor': 'source_discovery',
                   'critical': True, 'category': 'behavior'}]
        report = self.score(checks=checks)
        self.assertEqual(report['task_state'], 'FAIL')
        self.assertEqual(report['objective_score'], 0)
        self.assertTrue(report['critical_unknown'])
        validate_score(report)

    def test_response_array_never_crashes(self):
        report = self.score(response=[])
        self.assertEqual(report['task_state'], 'FAIL')
        validate_score(report)

    def test_human_review_not_accepted_in_new_flow(self):
        with self.assertRaises(BenchError):
            self.score(run_changes={'human_review': {'facts': 4}})

    def test_self_evaluation_never_changes_score(self):
        first = self.score()
        second = self.score(self_review={'facts': 0, 'opinion': 'all wrong'})
        self.assertEqual(first['objective_score'], second['objective_score'])
        self.assertFalse(second['self_evaluation']['included_in_score'])

    def test_browser_observations_and_screenshots_are_bound_to_report(self):
        evidence = self.path / '.assessor' / 'UI'
        evidence.mkdir(parents=True)
        write_json(evidence / 'observations.json', {'passed': True, 'asset_sha256': 'TEST'})
        (evidence / 'render.png').write_bytes(b'first-render')
        first = self.score(self_review={'opinion': 'reference only'})
        (evidence / 'render.png').write_bytes(b'changed-render')
        second = self.score(self_review={'opinion': 'reference only'})
        self.assertEqual(len(first['assessor_evidence']), 2)
        self.assertNotEqual(first['assessor_evidence'], second['assessor_evidence'])
        self.assertNotEqual(first['self_evaluation']['binding'], second['self_evaluation']['binding'])
        self.assertEqual(first['objective_score'], second['objective_score'])

    def test_valid_self_review_cannot_compensate_known_critical_failure(self):
        from counso_bench.semantic_review import TEMPLATE_VERSION
        path, manifest = self.attempt(cases=['R01-ticket-triage'])
        entry = manifest['entries'][0]
        self.submit(path, entry, lambda r: r['result'].update(p1_ticket_ids=[]))
        review = {'template_version': TEMPLATE_VERSION,
                  'dimensions': {k: {'score': 4, 'reason': '候选自行声称正确',
                                     'evidence': [{'path': 'response.json', 'locator': '/result', 'claim': '已提交'}]}
                                 for k in ('facts', 'completeness', 'usability')},
                  'commentary': '候选自评不能覆盖事实失败', 'known_limitations': []}
        write_json(path / entry['output_dir'] / 'self_review.json', review)
        report = score_suite(path)
        case = report['case_reports'][0]
        self.assertTrue(case['self_evaluation']['validation']['valid'])
        self.assertEqual(case['objective_score'], 0)
        self.assertEqual(case['self_evaluation']['reference_quality_cap'], 0)
        self.assertEqual(report['main']['fail'], 1)
        self.assertIn('0 / 0 / 0', markdown_report(report))

    def test_repeats_have_unique_run_ids_and_stay_in_plan(self):
        path, manifest = self.attempt(repeats=3, cases=['R01-ticket-triage'])
        self.assertEqual(len({e['run_id'] for e in manifest['entries']}), 3)
        for entry in manifest['entries']: self.submit(path, entry)
        report = score_suite(path)
        self.assertEqual(report['main']['pass'], 3)

    def test_manifest_tampering_rejected(self):
        _, manifest = self.attempt()
        manifest['entries'].pop()
        with self.assertRaises(BenchError): validate_manifest(manifest)

    def test_exported_input_tampering_rejected(self):
        path, manifest = self.attempt()
        entry = manifest['entries'][0]
        p = path / entry['input_dir'] / 'inputs' / entry['input_hashes'][0]['path']
        p.write_bytes(p.read_bytes() + b'\n')
        with self.assertRaises(BenchError): score_suite(path)

    def test_report_derived_score_tampering_rejected(self):
        report = self.score()
        report['task_state'] = 'FAIL'
        with self.assertRaises(BenchError): validate_score(report)

    def test_duplicate_report_rejected(self):
        path, plan = self.attempt(cases=['R01-ticket-triage'])
        self.submit(path, plan['entries'][0])
        report = score_suite(path)['case_reports'][0]
        with self.assertRaises(BenchError): aggregate_auto([report, report], plan)

    def test_same_task_comparison_and_missing_evidence_bounds(self):
        pa, a = self.attempt('a', model='A')
        pb, b = self.attempt('b', model='B')
        self.submit(pa, a['entries'][0]); self.submit(pb, b['entries'][0])
        result = compare_reports({'A': score_suite(pa), 'B': score_suite(pb)})
        self.assertIn('当前证据不足', result['paired_comparisons'][0]['capabilities']['office_tasks']['conclusion'])

    def test_different_inputs_and_plan_cannot_compare_common_subset(self):
        pa, a = self.attempt('a')
        pb, b = self.attempt('b', cases=['R01-ticket-triage'])
        for entry in a['entries']: self.submit(pa, entry)
        for entry in b['entries']: self.submit(pb, entry)
        with self.assertRaises(BenchError): compare_reports({'A': score_suite(pa), 'B': score_suite(pb)})

    def test_stale_or_wrong_observation_is_unknown(self):
        checks = [{'id': 'obs', 'kind': 'mock_observation', 'actor': 'source_discovery', 'critical': True}]
        r = self.score(checks=checks, observations={'run_id': 'SOME_OTHER_RUN'})
        self.assertTrue(r['critical_unknown'])
        self.assertEqual(r['task_state'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
