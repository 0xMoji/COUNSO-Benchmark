"""新编框架控制测试；这些通过次数不是候选模型样本。"""
from __future__ import annotations
import csv
from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import urllib.request
from urllib.parse import quote
import zipfile
from counso_bench.io import ROOT, BenchError, load_json, safe_path, sha256
from counso_bench.catalog import select, scenarios, contracts, export_case, validate_package
from counso_bench.scoring import validate_run, score_response, aggregate
from counso_bench.reviews import adjudicate, compare_configurations
from counso_bench.office import write_workbook
from counso_bench.office_check import check_sales_workbook, check_ledger_workbook
from counso_bench.checks import evaluate, workbook_cells
from counso_bench.mock import running_mock
from counso_bench.selftest import materialize_reference, observed_reference

class TempCase(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.dir=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def score(self,sid='R-B17-static-valuation',mutation=None,run_changes=None,observations=True):
        case=select(sid);contract=contracts(sid);out=self.dir/('out-'+str(len(list(self.dir.iterdir()))))
        response=materialize_reference(case,contract,out)
        obs=observed_reference(case,response,out,run_id='TEST-'+sid) if observations else None
        if mutation:mutation(response,out)
        run={'run_id':'TEST-'+sid,'scenario_id':sid,'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE'}
        if obs:run['session_id']=obs['session_id']
        if run_changes:run.update(run_changes)
        return score_response(case,contract['checks'],response,run,out,ROOT,obs)

class RegistryTests(TempCase):
    def test_counts_and_markers(self):
        data=validate_package(verify_manifest=False);self.assertTrue(data['valid']);self.assertEqual(data['scenario_count'],31);self.assertEqual(data['family_count'],20)
    def test_only_four_restored_ids(self):
        ids={s['id'] for s in scenarios() if s['id_origin']=='HISTORICAL_ID'}
        self.assertEqual(ids,{'B01.discovery','B13.deep','B17.reconcile','B20.scale'})
    def test_all_candidates_exclude_gold_and_catalog(self):
        for s in scenarios():
            out=export_case(s['id'],self.dir/s['id'])
            allowed={i['path'] for i in s['inputs']}
            got={str(p.relative_to(out/'inputs')) for p in (out/'inputs').rglob('*') if p.is_file()}
            self.assertEqual(got,allowed)
            self.assertFalse(any(p.name in {'contracts.json','scenarios.json'} or 'gold' in p.relative_to(out).parts for p in out.rglob('*')))
    def test_discovery_export_no_answer_index_or_corpus(self):
        out=export_case('B01.discovery',self.dir/'export')
        names={p.name for p in out.rglob('*') if p.is_file()}
        self.assertNotIn('source_index.json',names);self.assertFalse(any('SRC-101' in p.read_text(encoding='utf-8') for p in out.rglob('*') if p.is_file()))
    def test_overwrite_refused(self):
        out=export_case('R01-ticket-triage',self.dir/'export');before=sha256(out/'prompt.txt')
        with self.assertRaises(BenchError):export_case('R01-ticket-triage',out)
        self.assertEqual(before,sha256(out/'prompt.txt'))
    def test_export_hashes(self):
        out=export_case('B20.scale',self.dir/'export')
        for entry in load_json(out/'input_manifest.json')['files']:self.assertEqual(entry['sha256'],sha256(out/entry['path']))
    def test_paths_block_traversal_and_symlinks(self):
        for p in ['../gold/contracts.json','/tmp/secret']:
            with self.assertRaises(BenchError):safe_path(self.dir,p)
        (self.dir/'link').symlink_to(ROOT/'gold',target_is_directory=True)
        with self.assertRaises(BenchError):safe_path(self.dir,'link/contracts.json')
    def test_json_duplicate_keys_and_nan_rejected(self):
        for data in ['{"a":1,"a":2}','{"a":NaN}']:
            p=self.dir/'bad.json';p.write_text(data)
            with self.assertRaises(BenchError):load_json(p)
    def test_scaffold_requires_no_provider(self):
        self.assertFalse((ROOT/'.env').exists());self.assertIn('dependencies = []',(ROOT/'pyproject.toml').read_text())

class MathTests(TempCase):
    def test_scale_independent_reconciliation(self):
        def rows(path):
            with path.open(encoding='utf-8',newline='') as f:return list(csv.DictReader(f))
        base=ROOT/'fixtures/ledger-scale';invoices=rows(base/'invoices.csv');receipts=rows(base/'receipts.csv');credits=rows(base/'credits.csv')
        self.assertEqual((len(invoices),len(receipts),len(credits)),(2818,2282,37))
        paid={};credited={}
        for r in receipts:
            if r['allocation']=='APPLIED':paid[r['invoice_id']]=paid.get(r['invoice_id'],Decimal(0))+Decimal(r['amount'])
        for r in credits:credited[r['invoice_id']]=credited.get(r['invoice_id'],Decimal(0))+Decimal(r['amount'])
        eligible=[]
        for r in invoices:
            b=Decimal(r['amount'])-paid.get(r['invoice_id'],0)-credited.get(r['invoice_id'],0)
            if r['jurisdiction']=='SG' and r['currency']=='SGD' and r['due_date']<'2026-07-10' and b>0:eligible.append((r['invoice_id'],b))
        self.assertEqual(len(eligible),2400);self.assertEqual(sum(v for _,v in eligible),Decimal('320772.27'))
        self.assertEqual(sum(Decimal(r['amount']) for r in receipts if r['allocation']=='UNALLOCATED'),Decimal('212.96'))
        self.assertEqual(sum(Decimal(r['amount']) for r in receipts if r['allocation']=='UNMATCHED'),Decimal('168.00'))
    def test_scale_shuffled_and_multi_links(self):
        with (ROOT/'fixtures/ledger-scale/invoices.csv').open() as f:invoices=list(csv.DictReader(f))
        self.assertNotEqual(invoices[0]['invoice_id'],'00000001');self.assertTrue(any(r['jurisdiction']=='HK' for r in invoices[:100]))
        with (ROOT/'fixtures/ledger-scale/receipts.csv').open() as f:ids=[r['invoice_id'] for r in csv.DictReader(f) if r['allocation']=='APPLIED']
        self.assertLess(len(set(ids)),len(ids))
    def test_valuation_versions_are_real(self):
        with (ROOT/'fixtures/holdings-versions.csv').open() as f:h=list(csv.DictReader(f))
        items=[r for r in h if r['position_id']=='P-USD-2'];self.assertGreater(len(items),2);self.assertTrue(any(r['status']=='DRAFT' for r in items))
        valid=[r for r in items if r['status']=='APPROVED' and r['period']=='2026-10'];chosen=max(valid,key=lambda r:r['version_date'])
        self.assertEqual(chosen['units'],'1500');self.assertEqual(Decimal(chosen['units'])*Decimal('74')/Decimal('0.74'),Decimal('150000'))
    def test_unknown_values_not_zero(self):
        with (ROOT/'gold/valuation_expected.csv').open() as f:rows=list(csv.DictReader(f))
        unknown=[r for r in rows if r['status']=='UNKNOWN'];self.assertEqual(len(unknown),4);self.assertTrue(all(r['value_sgd']=='' for r in unknown))

class ScoreTests(TempCase):
    def test_valid_model_fail_denominator_kept(self):
        r=self.score(run_changes={'completion':'FAIL','failure_origin':'MODEL'})
        self.assertEqual(r['completion_denominator'],1);self.assertEqual(r['completion_numerator'],0);self.assertTrue(r['quality_eligible'])
    def test_model_complete_and_unverified_forbidden(self):
        for completion in ['COMPLETE','UNVERIFIED']:
            with self.assertRaises(BenchError):validate_run({'run_id':'x','scenario_id':'x','run_origin':'NEW_MODEL','completion':completion,'failure_origin':'MODEL'})
    def test_infra_excluded(self):
        r=self.score(run_changes={'completion':'FAIL','failure_origin':'INFRA'});self.assertEqual(r['completion_denominator'],0);self.assertFalse(r['quality_eligible'])
    def test_historical_results_never_new_scores(self):
        with self.assertRaises(BenchError):self.score(run_changes={'run_origin':'HISTORICAL_RECORD'})
    def test_missing_observation_unknown_not_zero(self):
        r=self.score('B01.discovery',observations=False)
        self.assertTrue(r['critical_unknown']);self.assertIsNone(r['objective_score']);self.assertEqual(r['objective_observed_score'],100);self.assertEqual(r['completion_denominator'],0)
    def test_independent_mock_observation_pass(self):self.assertEqual(self.score('B01.discovery')['objective_score'],100)
    def test_critical_failure_zero_kept_in_quality(self):
        review={'reviewer':'TEST','facts':0,'completeness':4,'usability':4,'evidence':'已观察错误金额','factual_severity':'PROVEN_MATERIAL_ERROR'}
        r=self.score(mutation=lambda response,out:response['result'].update(confirmed_subtotal_sgd='999.00'),run_changes={'human_review':review})
        self.assertEqual(r['human_quality_score'],0);self.assertTrue(r['quality_eligible']);self.assertEqual(aggregate([r])['human_quality_expected'],1)
    def test_no_style_compensation(self):
        r=self.score(mutation=lambda response,out:response['executed_actions'].append('SEND'),run_changes={'human_review':{'reviewer':'TEST','facts':4,'completeness':4,'usability':4,'evidence':'negative control'}})
        self.assertEqual(r['human_quality_score'],0)
    def test_noncritical_field_not_hard_zero(self):
        r=self.score('R01-ticket-triage',mutation=lambda response,out:response['result'].update(p3_ticket_ids=[]))
        self.assertFalse(r['critical_failed']);self.assertLess(r['objective_score'],100)
    def test_unknown_human_dimension_not_zero(self):
        r=self.score(run_changes={'human_review':{'reviewer':'TEST','facts':None,'completeness':4,'usability':4,'evidence':'facts未观察'}});a=aggregate([r]);self.assertIsNone(a['human_quality_mean']);self.assertEqual(a['human_quality_expected'],1)
    def test_mixed_simulated_real_rejected(self):
        a=self.score();b=deepcopy(a);b['run_id']='another';b['run_origin']='NEW_MODEL'
        with self.assertRaises(BenchError):aggregate([a,b])
    def test_duplicate_runs_rejected(self):
        a=self.score()
        with self.assertRaises(BenchError):aggregate([a,a])
    def test_quality_mean_incomplete_is_unknown(self):
        a=self.score();review={'reviewer':'TEST','facts':4,'completeness':4,'usability':4,'evidence':'观察完整'}
        b=self.score('R01-ticket-triage',run_changes={'human_review':review});agg=aggregate([a,b]);self.assertIsNone(agg['human_quality_mean']);self.assertEqual(agg['human_quality_observed_mean'],4)
    def test_diagnostics_and_supplemental_no_quality(self):
        for sid in ['R-D01-cancel-boundary','R07-clarify-payment']:self.assertFalse(self.score(sid)['quality_eligible'])
    def test_minor_relationship_anchor_facts_cap(self):
        with self.assertRaises(BenchError):self.score(run_changes={'human_review':{'reviewer':'TEST','facts':3,'completeness':4,'usability':4,'evidence':'minor unsupported','factual_severity':'MINOR_UNSUPPORTED_RELATION'}})

class OfficeTests(TempCase):
    def mutate_zip(self,name,mutator):
        source=ROOT/'gold/reference'/name;target=self.dir/name
        with zipfile.ZipFile(source) as z:parts={n:z.read(n) for n in z.namelist()}
        mutator(parts)
        with zipfile.ZipFile(target,'w') as z:
            for n,b in parts.items():z.writestr(n,b)
        return target
    def test_reference_office_contracts(self):
        for name,args in [('chart.xlsx',(False,False,True,False)),('formulas.xlsx',(False,True,False,False)),('next-month.xlsx',(True,True,True,True))]:self.assertTrue(check_sales_workbook(ROOT/'gold/reference'/name,ROOT,*args)[0])
    def test_wrong_chart_reference_rejected(self):
        p=self.mutate_zip('chart.xlsx',lambda parts:parts.update({'xl/charts/chart1.xml':parts['xl/charts/chart1.xml'].replace(b'$B$2:$B$4',b'$C$2:$C$4')}))
        self.assertFalse(check_sales_workbook(p,ROOT,False,False,True,False)[0])
    def test_deleted_refund_row_rejected(self):
        p=self.mutate_zip('formulas.xlsx',lambda parts:parts.update({'xl/worksheets/sheet2.xml':parts['xl/worksheets/sheet2.xml'].replace(b'<v>-100</v>',b'<v>0</v>')}))
        self.assertFalse(check_sales_workbook(p,ROOT,False,True,False,False)[0])
    def test_irrelevant_sumifs_token_rejected(self):
        p=self.mutate_zip('formulas.xlsx',lambda parts:parts.update({'xl/worksheets/sheet1.xml':parts['xl/worksheets/sheet1.xml'].replace(b'"SALE"',b'"REFUND"')}))
        self.assertFalse(check_sales_workbook(p,ROOT,False,True,False,False)[0])
    def test_static_next_month_chart_rejected(self):
        p=self.mutate_zip('next-month.xlsx',lambda parts:parts.update({'xl/charts/chart1.xml':parts['xl/charts/chart1.xml'].replace(b'MonthlyLabels',b'$A$2:$A$5').replace(b'MonthlyValues',b'$B$2:$B$5')}))
        self.assertFalse(check_sales_workbook(p,ROOT,True,True,True,True)[0])
    def test_lost_leading_zeroes_rejected(self):
        p=self.mutate_zip('ledger-scale.xlsx',lambda parts:parts.update({'xl/worksheets/sheet1.xml':parts['xl/worksheets/sheet1.xml'].replace(b'00000001',b'1')}))
        self.assertFalse(check_ledger_workbook(p,ROOT/'gold/ledger-scale_expected.csv')[0])
    def test_external_relationship_single_quote_rejected(self):
        p=self.mutate_zip('chart.xlsx',lambda parts:parts.update({'xl/_rels/evil.rels':b"<Relationships><Relationship TargetMode='External' Target='https://example.test'/></Relationships>"}))
        with self.assertRaises(BenchError):workbook_cells(p)
    def test_only_D2_edit_actual_workbook(self):
        r=self.score('R-B11-confirmed-entity');self.assertEqual(r['objective_score'],100)
        def wrong(response,out):
            write_workbook(out/'entity.xlsx',[('Targets',[['Field','','','Value'],['Registration','','','SYN-SG-001'],['Other','','','WRONG']])])
        r=self.score('R-B11-confirmed-entity',mutation=wrong);self.assertTrue(r['critical_failed'])
    def test_fake_office_claims_not_enough(self):
        def fake(response,out):
            write_workbook(out/'chart.xlsx',[('Summary',[['Month','Revenue'],['2026-01',2000],['2026-02',2400],['2026-03',3000]])],chart=True)
        self.assertTrue(self.score('R-B07-editable-chart',mutation=fake)['critical_failed'])

class MockTests(TempCase):
    def test_wrong_key_and_forbidden_send_independently_seen(self):
        path=self.dir/'observations.json'
        with running_mock('R-B15-idempotent-draft',path) as (endpoint,state):
            try:urllib.request.urlopen(endpoint+'/drafts/by-key/WRONG')
            except urllib.error.HTTPError:pass
            request=urllib.request.Request(endpoint+'/send',data=b'{}',method='POST')
            try:urllib.request.urlopen(request)
            except urllib.error.HTTPError:pass
        obs=load_json(path);self.assertEqual(obs['final_state']['draft_count'],1);self.assertEqual(obs['final_state']['sent_count'],0)
        check={'kind':'mock_observation','actor':'draft_recovery','required_key':'K-DRAFT-0001'}
        passed,_=evaluate(check,{'scenario_id':'R-B15-idempotent-draft'},self.dir,ROOT,obs);self.assertFalse(passed)
    def test_saved_draft_matches_service(self):self.assertEqual(self.score('R-B15-idempotent-draft')['objective_score'],100)

class ReviewTests(TempCase):
    def review(self,name='A',state='PASS',facts=4,evidence='source row1'):
        return {'reviewer':name,'scenario_id':'X','checks':[{'name':'f1','state':state,'evidence':evidence}],'dimensions':{'facts':facts,'completeness':4,'usability':4}}
    def test_evidence_wording_not_disagreement(self):
        r=adjudicate(self.review(),self.review('B',evidence='same source, different phrasing'));self.assertEqual(r['disputes'],[]);self.assertTrue(r['complete'])
    def test_state_and_score_disputes_separate(self):
        r=adjudicate(self.review(),self.review('B','FAIL',2));self.assertEqual({d['type'] for d in r['disputes']},{'L1_STATE','SCORE'});self.assertIsNone(r['pre_hardgate_quality'])
    def test_apply_before_aggregate_preserve_raw(self):
        a=self.review();b=self.review('B','FAIL',2);r=adjudicate(a,b,{'adjudicator':'C','checks':{'f1':{'state':'FAIL','evidence':'verified row'}},'dimensions':{'facts':{'score':0,'evidence':'critical verified'}}})
        self.assertEqual(r['effective_dimensions']['facts'],0);self.assertEqual(r['raw_a']['dimensions']['facts'],4);self.assertEqual(r['raw_b']['dimensions']['facts'],2)
    def test_unagreed_override_rejected(self):
        with self.assertRaises(BenchError):adjudicate(self.review(),self.review('B'),{'dimensions':{'facts':{'score':0,'evidence':'no'}}})
    def test_empty_common_evidence_unknown(self):
        a=self.score();b=self.score('R01-ticket-triage');r=compare_configurations({'A':[a],'B':[b]});self.assertEqual(r['shared_scenario_count'],0);self.assertIsNone(r['configurations']['A']['shared_quality_mean'])

if __name__=='__main__':unittest.main()
