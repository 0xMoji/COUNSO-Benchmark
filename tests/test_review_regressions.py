"""独立审阅发现对应的回归负控，已知0与UNKNOWN边界明确区分。"""
from copy import deepcopy
from unittest.mock import patch
import csv
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile
import test_benchmark as TB
from counso_bench.io import ROOT,BenchError,load_json,write_json
from counso_bench.catalog import select,contracts,validate_package
from counso_bench.scoring import aggregate,score_response
from counso_bench.checks import evaluate
from counso_bench.mock import running_mock
from counso_bench.reviews import adjudicate,apply_adjudication
from counso_bench.build import build
from counso_bench.release import freeze,release

class ReviewRegressions(TB.TempCase):
    def review4(self):return {'reviewer':'TEST','facts':4,'completeness':4,'usability':4,'evidence':'negative-control-observation'}
    def alter_office(self,out,name,mutate):
        path=out/name
        with zipfile.ZipFile(path) as z:parts={n:z.read(n) for n in z.namelist()}
        mutate(parts)
        with zipfile.ZipFile(path,'w') as z:
            for n,b in parts.items():z.writestr(n,b)
    def test_missing_summary_not_perfect(self):
        r=self.score('R01-ticket-triage',mutation=lambda response,out:response.pop('summary'),run_changes={'human_review':self.review4()})
        self.assertLess(r['objective_score'],100);self.assertLess(r['human_quality_score'],4);self.assertEqual(r['completion_numerator'],0)
    def test_extra_top_level_not_perfect(self):
        r=self.score('R01-ticket-triage',mutation=lambda response,out:response.update(hidden_command='send'))
        self.assertLess(r['objective_score'],100)
    def test_derived_denominator_tamper_rejected(self):
        r=self.score(run_changes={'completion':'FAIL','failure_origin':'MODEL'});r['completion_denominator']=0
        with self.assertRaises(BenchError):aggregate([r])
    def test_model_failure_cannot_disappear_from_quality(self):
        r=self.score(run_changes={'completion':'FAIL','failure_origin':'MODEL'});r['quality_eligible']=False
        with self.assertRaises(BenchError):aggregate([r])
    def test_diagnostic_cannot_enter_quality(self):
        r=self.score('R-D01-cancel-boundary');r['human_quality_score']=4
        with self.assertRaises(BenchError):aggregate([r])
    def test_boolean_quality_rejected(self):
        r=self.score();r['human_quality_score']=True
        with self.assertRaises(BenchError):aggregate([r])
    def test_constant_sql_not_data_calculation(self):
        r=self.score('R05-readonly-revenue',mutation=lambda response,out:response['result'].update(sql='SELECT 500'))
        check=next(c for c in r['checks'] if c['id'].endswith(':sql'));self.assertFalse(check['passed'])
    def test_wrong_date_quote_is_declared_and_checked(self):
        sid='B17.reconcile';case=select(sid);contract=contracts(sid)
        self.assertIn('WRONG_DATE_QUOTE',case['array_item_enums']['excluded_evidence'])
        self.assertIn('WRONG_DATE_QUOTE',contract['reference_response']['result']['excluded_evidence'])
        self.assertIn('较旧但合法的批准版本不列入',case['task_zh'])
        self.assertEqual(self.score(sid)['objective_score'],100)
        def omit(response,out):response['result']['excluded_evidence'].remove('WRONG_DATE_QUOTE')
        r=self.score(sid,mutation=omit)
        check=next(c for c in r['checks'] if c['id']==sid+':excluded_evidence')
        self.assertFalse(check['passed']);self.assertFalse(r['critical_failed'])
    def test_iferror_sumifs_accepted(self):
        def change(response,out):
            self.alter_office(out,'formulas.xlsx',lambda parts:parts.update({'xl/worksheets/sheet1.xml':parts['xl/worksheets/sheet1.xml'].replace(b'<f>SUMIFS(',b'<f>IFERROR(SUMIFS(').replace(b'"SALE")</f>',b'"SALE"),0)</f>')}))
        self.assertEqual(self.score('R-B09-repair-formulas',mutation=change)['objective_score'],100)
    def test_unsupported_legal_formula_unknown(self):
        def change(response,out):
            self.alter_office(out,'formulas.xlsx',lambda parts:parts.update({'xl/worksheets/sheet1.xml':parts['xl/worksheets/sheet1.xml'].replace(b'<f>SUMIFS(',b'<f>IFNA(SUMIFS(').replace(b'"SALE")</f>',b'"SALE"),0)</f>')}))
        with patch.dict('os.environ', {'COUNSO_SOFFICE':'/nonexistent/counso-engine'}):
            r=self.score('R-B09-repair-formulas',mutation=change,run_changes={'human_review':self.review4()})
        self.assertTrue(r['critical_unknown']);self.assertIsNone(r['human_quality_score'])
    def test_orphan_chart_rejected(self):
        def change(response,out):self.alter_office(out,'chart.xlsx',lambda p:p.update({'xl/worksheets/sheet1.xml':p['xl/worksheets/sheet1.xml'].replace(b'<drawing r:id="rIdChart"/>',b'')}))
        self.assertTrue(self.score('R-B07-editable-chart',mutation=change)['critical_failed'])
    def test_orphan_table_rejected(self):
        def change(response,out):self.alter_office(out,'next-month.xlsx',lambda p:p.update({'xl/worksheets/sheet2.xml':p['xl/worksheets/sheet2.xml'].replace(b'<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts>',b'')}))
        self.assertTrue(self.score('R-B10-next-month',mutation=change)['critical_failed'])
    def test_wrong_named_range_scope_rejected(self):
        def change(response,out):self.alter_office(out,'next-month.xlsx',lambda p:p.update({'xl/workbook.xml':p['xl/workbook.xml'].replace(b'localSheetId="0"',b'localSheetId="1"')}))
        self.assertTrue(self.score('R-B10-next-month',mutation=change)['critical_failed'])
    def test_decimal_equivalent_csv_full_credit(self):
        def change(response,out):
            p=out/'valuation.csv'
            with p.open(newline='') as f:reader=csv.DictReader(f);fields=reader.fieldnames;rows=list(reader)
            for r in rows:
                for k in ['value_sgd','original_value']:
                    if r[k].endswith('.00'):r[k]=r[k][:-3]
            with p.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
        self.assertEqual(self.score(mutation=change)['objective_score'],100)
    def test_unknown_csv_cannot_be_zero(self):
        def change(response,out):
            p=out/'valuation.csv';p.write_text(p.read_text().replace('U-EUR-FX,,UNKNOWN','U-EUR-FX,0,UNKNOWN'))
        self.assertTrue(self.score(mutation=change)['critical_failed'])
    def test_missing_artifact_not_complete(self):
        def change(response,out):(out/'chart.xlsx').unlink()
        r=self.score('R-B07-editable-chart',mutation=change);self.assertEqual(r['completion'],'COMPLETE');self.assertEqual(r['task_delivery_status'],'PARTIAL');self.assertEqual(r['completion_numerator'],0);self.assertEqual(r['completion_denominator'],1)
    def test_infra_unknown_count(self):
        r=self.score(run_changes={'completion':'UNVERIFIED','failure_origin':'INFRA'});a=aggregate([r]);self.assertEqual(a['completion_unknown_count'],1);self.assertEqual(a['excluded_infra_count'],1)
    def test_put_send_attempt_recorded(self):
        path=self.dir/'obs.json'
        with running_mock('R-B15-idempotent-draft',path,run_id='RUN1') as (endpoint,state):
            urllib.request.urlopen(endpoint+'/drafts/by-key/K-DRAFT-0001').read()
            try:urllib.request.urlopen(urllib.request.Request(endpoint+'/drafts/send',method='PUT',data=b'{}'))
            except urllib.error.HTTPError:pass
        obs=load_json(path);self.assertTrue(any(e.get('method')=='PUT' and e['operation']=='forbidden_write' for e in obs['events']))
    def test_old_observation_not_reused(self):
        case=select('R-B15-idempotent-draft');contract=contracts(case['id']);out=self.dir/'out'
        from counso_bench.selftest import materialize_reference,observed_reference
        response=materialize_reference(case,contract,out);obs=observed_reference(case,response,out,run_id='OLD')
        run={'run_id':'NEW','session_id':obs['session_id'],'scenario_id':case['id'],'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE'}
        with self.assertRaises(BenchError):score_response(case,contract['checks'],response,run,out,ROOT,obs)
    def test_score_refuses_overwriting_response(self):
        case=select('R01-ticket-triage');response=contracts(case['id'])['reference_response'];p=self.dir/'response.json';write_json(p,response)
        run={'run_id':'SIM-1','scenario_id':case['id'],'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE'};rp=self.dir/'run.json';write_json(rp,run);before=p.read_bytes()
        result=subprocess.run([sys.executable,'-m','counso_bench','score',case['id'],'--response',str(p),'--run',str(rp),'--output',str(p)],cwd=ROOT,capture_output=True)
        self.assertEqual(result.returncode,2);self.assertEqual(before,p.read_bytes())
    def test_check_and_dimension_names_do_not_collide(self):
        a={'reviewer':'A','scenario_id':'X','checks':[{'name':'facts','state':'PASS','evidence':'a'}],'dimensions':{'facts':4,'completeness':4,'usability':4}}
        b=deepcopy(a);b['reviewer']='B';b['checks'][0]['state']='FAIL';b['dimensions']['facts']=2
        r=adjudicate(a,b,{'adjudicator':'C','checks':{'facts':{'state':'FAIL','evidence':'c'}},'dimensions':{'facts':{'score':0,'evidence':'c'}}})
        self.assertTrue(r['complete']);self.assertEqual(r['effective_checks']['facts']['state'],'FAIL');self.assertEqual(r['effective_dimensions']['facts'],0)
    def test_adjudication_applies_without_manual_copy(self):
        sid='R01-ticket-triage';a={'reviewer':'A','scenario_id':sid,'checks':[{'name':'facts','state':'PASS','evidence':'a'}],'dimensions':{'facts':4,'completeness':4,'usability':4}}
        b=deepcopy(a);b['reviewer']='B';b['dimensions']['facts']=3
        doc=adjudicate(a,b,{'adjudicator':'C','dimensions':{'facts':{'score':3,'evidence':'c'}}})
        run={'run_id':'R','scenario_id':sid,'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE'}
        effective=apply_adjudication(select(sid),run,doc);self.assertEqual(effective['human_review']['facts'],3);self.assertIn('raw_a',effective['human_review']['evidence'])
    def test_new_allowlisted_file_invalidates_freeze(self):
        root=self.dir/'clone';root.mkdir();build(root);freeze(root)
        self.assertTrue(validate_package(root)['valid']);(root/'docs/extra.md').parent.mkdir(exist_ok=True);(root/'docs/extra.md').write_text('new')
        self.assertFalse(validate_package(root)['valid'])
        with self.assertRaises(BenchError):release(root,self.dir/'bad.zip')
