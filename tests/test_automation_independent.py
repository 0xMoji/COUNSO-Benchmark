"""Independent regression checks for report integrity and observation identity."""
from copy import deepcopy
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
import shutil
import tempfile
import unittest

from counso_bench.automation import (VERSION, aggregate_auto, configuration, derive,
                                     prepare, score_auto, score_suite)
from counso_bench.catalog import contracts, select
from counso_bench.extensions import materialize_extension_reference
from counso_bench.cli import main as cli_main
from counso_bench.io import ROOT, BenchError, write_json, load_json
from counso_bench.mock import execution_fingerprint


class IndependentAutomationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def failed_report(self):
        attempt=self.root/'attempt'
        manifest=prepare(attempt,configuration('CONTROL'),['R01-ticket-triage'])
        entry=manifest['entries'][0]
        response=deepcopy(contracts(entry['scenario_id'])['reference_response'])
        response['schema_version']=VERSION
        response['result']['p1_ticket_ids']=[]
        write_json(attempt/entry['response_path'],response)
        report=score_suite(attempt)['case_reports'][0]
        self.assertEqual(report['task_state'],'FAIL')
        return manifest,report

    def test_aggregate_rejects_missing_business_check(self):
        manifest,report=self.failed_report()
        report['checks']=[c for c in report['checks'] if not c['id'].endswith(':p1_ticket_ids')]
        report.update(derive(report['checks']))
        with self.assertRaises(BenchError):
            aggregate_auto([report],manifest)

    def test_aggregate_rejects_changed_required_check_policy(self):
        manifest,report=self.failed_report()
        check=next(c for c in report['checks'] if c['id'].endswith(':p1_ticket_ids'))
        check['required']=False
        check['critical']=False
        report.update(derive(report['checks']))
        with self.assertRaises(BenchError):
            aggregate_auto([report],manifest)

    def test_aggregate_rejects_case_capability_mismatch(self):
        manifest,report=self.failed_report()
        report['capability']='generative_ui'
        with self.assertRaises(BenchError):
            aggregate_auto([report],manifest)

    def test_observation_requires_nonempty_run_and_observation_sessions(self):
        sid='R-B15-idempotent-draft'
        response=deepcopy(contracts(sid)['reference_response'])
        response['schema_version']=VERSION
        run={'run_id':'NO-SESSION','scenario_id':sid,'run_origin':'SIMULATED','rubric_version':VERSION}
        observations={'origin':'ASSESSOR_MOCK_SERVICE','run_id':run['run_id'],
                      'scenario_id':sid,'execution_fingerprint':execution_fingerprint(ROOT),
                      'events':[{'actor':'CANDIDATE','operation':'draft_lookup','key':'K-DRAFT-0001','found':True}],
                      'final_state':{'draft_count':1,'sent_count':0}}
        checks=[c for c in contracts(sid)['checks'] if c['kind']=='mock_observation']
        for session in [None,'']:
            if session is not None:
                run['session_id']=session
                observations['session_id']=session
            report=score_auto(select(sid),checks,response,run,self.root,ROOT,observations)
            self.assertEqual(report['task_state'],'UNKNOWN')
            self.assertEqual(next(c for c in report['checks'] if c['id']=='B15:lookup_observation')['state'],'UNKNOWN')

    def test_missing_output_directory_stays_in_planned_denominator(self):
        attempt=self.root/'attempt'
        manifest=prepare(attempt,configuration('CONTROL'),['R01-ticket-triage'])
        shutil.rmtree(attempt/manifest['entries'][0]['output_dir'])
        result=score_suite(attempt)
        self.assertEqual(result['main']['planned'],1)
        self.assertEqual(result['main']['unknown'],1)
        self.assertEqual(result['submitted_count'],0)

    def test_directory_artifact_presence_matches_verified_directory(self):
        attempt=self.root/'attempt'
        manifest=prepare(attempt,configuration('CONTROL'),['R-F01-organize-files'])
        entry=manifest['entries'][0]
        case=select(entry['scenario_id'])
        out=attempt/entry['output_dir']
        response=materialize_extension_reference(case,contracts(case['id']),out)
        write_json(attempt/entry['response_path'],response)
        report=score_suite(attempt)['case_reports'][0]
        self.assertEqual(report['task_state'],'PASS')
        self.assertTrue(report['artifact_evidence'][0]['present'])

    def cli_score_with_invalid_optional_json(self, option):
        sid='R01-ticket-triage'
        response=deepcopy(contracts(sid)['reference_response'])
        response['schema_version']=VERSION
        write_json(self.root/'response.json',response)
        write_json(self.root/'run.json',{'run_id':'OPTIONAL-JSON','scenario_id':sid,
                   'run_origin':'SIMULATED','rubric_version':VERSION})
        (self.root/'invalid.json').write_text('{bad')
        target=self.root/'score.json'
        with redirect_stdout(StringIO()),redirect_stderr(StringIO()):
            code=cli_main(['score',sid,'--response',str(self.root/'response.json'),
                           '--run',str(self.root/'run.json'),option,str(self.root/'invalid.json'),
                           '--output',str(target)])
        self.assertEqual(code,0)
        self.assertTrue(target.is_file())
        return load_json(target)

    def test_invalid_optional_self_review_does_not_block_program_score(self):
        report=self.cli_score_with_invalid_optional_json('--self-review')
        self.assertEqual(report['task_state'],'PASS')
        self.assertFalse(report['self_evaluation']['included_in_score'])

    def test_invalid_optional_observation_produces_unknown_report(self):
        report=self.cli_score_with_invalid_optional_json('--observations')
        self.assertEqual(report['task_state'],'UNKNOWN')
        self.assertTrue(any(c['id'].endswith(':observation_identity') and c['state']=='UNKNOWN'
                            for c in report['checks']))


if __name__=='__main__':
    unittest.main()
