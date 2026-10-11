"""Model-agnostic semantic positive controls and nearby real-error negatives.

All inputs are synthetic controls generated here; no candidate/model labels are
read. Tests also protect exact frozen B17 candidate prompt/schema bytes.
"""
from copy import deepcopy
from decimal import Decimal
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from counso_bench.io import ROOT, BenchError, dumps, load_json, sha256
from counso_bench.catalog import select, contracts, export_case, response_schema
from counso_bench.scoring import score_response, aggregate
from counso_bench.checks import evaluate, workbook_cells
from counso_bench.mock import execution_fingerprint
from counso_bench.selftest import materialize_reference, observed_reference
from counso_bench.schema import validate_response
from counso_bench.build import build
from counso_bench.revision_semantics import evaluate_equivalence, B17_FREEZE_SHA256
from counso_bench.revision_contracts import B17_SCHEMA_TEXT

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


class RevisionControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.dir = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def check(self, sid, field, value, legacy=False):
        contract=contracts(sid); response=deepcopy(contract['reference_response'])
        response['result'][field]=value
        check=next(c for c in contract['checks'] if c.get('path')=='result.'+field)
        if legacy:return evaluate_equivalence(check,response,self.dir,ROOT)[1]
        return evaluate(check,response,self.dir,ROOT)[0]
    def materialize(self, sid):
        case=select(sid); contract=contracts(sid); out=self.dir/sid
        response=materialize_reference(case,contract,out)
        return case,contract,response,out
    def mutate_xlsx(self,path,mutate):
        with zipfile.ZipFile(path) as z: parts={name:z.read(name) for name in z.namelist()}
        xml=ET.fromstring(parts['xl/worksheets/sheet1.xml'])
        mutate(xml,parts)
        parts['xl/worksheets/sheet1.xml']=ET.tostring(xml)
        with zipfile.ZipFile(path,'w') as z:
            for name,body in parts.items():z.writestr(name,body)
    def ledger(self,mutate=None):
        path=self.dir/'ledger.xlsx';shutil.copyfile(ROOT/'gold/reference/ledger-scale.xlsx',path)
        if mutate:self.mutate_xlsx(path,mutate)
        c=next(c for c in contracts('B20.scale')['checks'] if c['kind']=='xlsx_ledger_contract')
        r={'scenario_id':'B20.scale','result':{'workbook':'ledger.xlsx'}}
        return evaluate_equivalence(c,r,self.dir,ROOT)[1]

    def test_entity_explicit_aliases_and_order_positive(self):
        for value in [['registration','jurisdiction'],['jurisdiction','registration_number'],['登记号','辖区']]:
            with self.subTest(value=value):self.assertTrue(self.check('B01.discovery','entity_disambiguation_fields',value))
    def test_entity_nearby_wrong_fields_negative(self):
        for value in [['jurisdiction','display_name'],['jurisdiction','contact_name'],['Jurisdiction','registration'],['jurisdiction','jurisdiction'],['jurisdiction','registration','registration_number']]:
            with self.subTest(value=value):self.assertFalse(self.check('B01.discovery','entity_disambiguation_fields',value))
    def test_public_b01_schema_lists_aliases_and_distractors(self):
        schema=response_schema(select('B01.discovery'))['properties']['result']['properties']['entity_disambiguation_fields']
        self.assertIn('登记号',schema['items']['enum']);self.assertIn('display_name',schema['items']['enum'])
    def test_state_aliases_support_and_order_positive(self):
        value={'sponsor_approval':['authority-policy','sponsor-draft','sponsor-signed'],
               'commercial_approval':['authority-policy','commercial-signed'],
               'data_permission':['data-permission','authority-policy'],
               'technical_account':['workspace-closed','technical-ready'],
               'workspace':['sales-latest','workspace-closed','authority-policy']}
        self.assertTrue(self.check('B13.deep','state_evidence',value))
        r=deepcopy(contracts('B13.deep')['reference_response']);r['result']['state_evidence']=value
        self.assertEqual(validate_response(r,select('B13.deep')),[])
    def test_missing_primary_state_source_negative(self):
        value=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence'])
        for category,source in [('sponsor','sponsor-signed'),('commercial','commercial-signed'),('data','data-permission'),('technical','technical-ready'),('workspace','workspace-closed')]:
            bad=deepcopy(value);bad[category].remove(source)
            with self.subTest(category=category):self.assertFalse(self.check('B13.deep','state_evidence',bad))
    def test_sales_only_cannot_prove_open_workspace(self):
        v=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence']);v['workspace']=['sales-latest']
        self.assertFalse(self.check('B13.deep','state_evidence',v));self.assertFalse(self.check('B13.deep','workspace','OPEN'))
    def test_uninterpretable_state_evidence_unknown(self):
        v=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence']);v['custom_state']=v.pop('technical')
        self.assertIsNone(self.check('B13.deep','state_evidence',v))
        v=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence']);v['sponsor'].append('technical-ready')
        self.assertIsNone(self.check('B13.deep','state_evidence',v))
        # A separate undecidable category must not hide a known missing authority.
        original=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence'])
        malformed={'technical':'technical-ready',**{k:v for k,v in original.items() if k!='technical'}}
        malformed['sponsor']=['authority-policy']
        self.assertFalse(self.check('B13.deep','state_evidence',malformed))
        malformed={'sponsor':['authority-policy'],**{k:v for k,v in original.items() if k!='sponsor'}}
        malformed['technical']='technical-ready'
        self.assertFalse(self.check('B13.deep','state_evidence',malformed))
        duplicated={'technical_account':['technical-ready'],**original};duplicated['sponsor']=['authority-policy']
        self.assertFalse(self.check('B13.deep','state_evidence',duplicated))
    def test_unrelated_unknown_source_is_not_ignored(self):
        v=deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence']);v['sponsor'].append('nonexistent-authority')
        self.assertFalse(self.check('B13.deep','state_evidence',v))
    def test_duplicate_category_and_wrong_array_type_public_schema(self):
        r=deepcopy(contracts('B13.deep')['reference_response']);r['result']['state_evidence']['sponsor_approval']=['sponsor-signed']
        self.assertTrue(validate_response(r,select('B13.deep')))
        r=deepcopy(contracts('B13.deep')['reference_response']);r['result']['state_evidence']['workspace']='workspace-closed'
        self.assertTrue(validate_response(r,select('B13.deep')))
    def test_money_decimal_equivalence_positive(self):
        for field,values in [('confirmed_subtotal_sgd',['480280','480280.0','480280.000']),('eur_intermediate',['4000','4000.00','4E3'])]:
            for value in values:
                with self.subTest(field=field,value=value):self.assertTrue(self.check('B17.reconcile',field,value))
    def test_money_nearby_error_and_nonfinite_negative(self):
        for value in ['480280.01','480280.0000000000000000000000000001','NaN','sNaN','Infinity','-Infinity','abc','']:
            with self.subTest(value=value):self.assertFalse(self.check('B17.reconcile','confirmed_subtotal_sgd',value))
    def test_money_string_schema_remains_required(self):
        r=deepcopy(contracts('B17.reconcile')['reference_response']);r['result']['confirmed_subtotal_sgd']=480280
        self.assertTrue(validate_response(r,select('B17.reconcile')))
    def test_legacy_period_aliases_positive_wrong_labels_negative(self):
        for value in ['period','holding_period','holding.period','holdings.period','持仓期间']:
            self.assertTrue(self.check('B17.reconcile','period_source',value,legacy=True))
        for value in ['filename','quote_date','version_date','period_in_filename','UNKNOWN']:
            self.assertFalse(self.check('B17.reconcile','period_source',value,legacy=True))
    def test_new_period_requires_fixed_enum(self):
        r=deepcopy(contracts('B17.reconcile')['reference_response']);r['result']['period_source']='holding_period'
        self.assertTrue(validate_response(r,select('B17.reconcile')))
        self.assertFalse(self.check('B17.reconcile','period_source','holding_period'))
        self.assertTrue(self.check('B17.reconcile','period_source','period'))
    def test_new_eur_target_strict(self):
        self.assertTrue(self.check('B17.reconcile','eur_intermediate','4000'))
        for value in ['120000','124000','4000.01']:
            self.assertFalse(self.check('B17.reconcile','eur_intermediate',value))
    def test_frozen_b17_prompt_schema_inputs_exact(self):
        out=export_case('B17.reconcile',self.dir/'export')
        manifest=load_json(ROOT/'provenance/history/B17-contract-0.2-frozen-manifest.json')
        self.assertEqual(sha256(ROOT/'provenance/history/B17-contract-0.2-frozen-manifest.json'),B17_FREEZE_SHA256)
        for entry in manifest['files']:
            if entry['path'] in {'README.txt','input_manifest.json','run_metadata_template.json'}:continue
            self.assertEqual(sha256(out/entry['path']),entry['sha256'],entry['path'])
        run=load_json(out/'run_metadata_template.json')
        self.assertEqual(run['task_revision'],'B17-contract-0.2');self.assertEqual(run['rubric_version'],'RECON-0.2')
    def test_generator_catalog_gold_consistency(self):
        root=self.dir/'regenerated';build(root)
        for rel in ['catalog/scenarios.json','gold/contracts.json']:
            self.assertEqual(load_json(root/rel),load_json(ROOT/rel),rel)
        for rel in ['holdings-versions.csv','quotes-versions.csv','valuation_policy.json']:
            self.assertEqual(sha256(root/'fixtures'/rel),sha256(ROOT/'fixtures'/rel))
    def test_new_csv_semantic_decimal_and_row_order_positive(self):
        self.materialize('B17.reconcile');path=self.dir/'B17.reconcile/valuation.csv'
        with path.open() as f:reader=csv.DictReader(f);fields=reader.fieldnames;rows=list(reader)
        for row in rows:
            for field in ['value_sgd','original_value']:
                if row[field]:row[field]=str(Decimal(row[field]).normalize())
        with path.open('w',newline='') as f:w=csv.DictWriter(f,fields);w.writeheader();w.writerows(reversed(rows))
        check=next(c for c in contracts('B17.reconcile')['checks'] if c['kind']=='valuation_csv_rows')
        self.assertTrue(evaluate(check,contracts('B17.reconcile')['reference_response'],path.parent,ROOT)[0])
    def test_new_csv_missing_duplicate_wrong_zero_header_negative(self):
        _,contract,response,out=self.materialize('B17.reconcile');path=out/'valuation.csv'
        with path.open() as f:reader=csv.DictReader(f);fields=reader.fieldnames;original=list(reader)
        check=next(c for c in contract['checks'] if c['kind']=='valuation_csv_rows')
        for mutation in ['missing','duplicate','wrong','unknown_zero','header_order','extra_column','confirmed_native']:
            rows=deepcopy(original);header=list(fields)
            if mutation=='missing':rows.pop()
            elif mutation=='duplicate':rows.append(deepcopy(rows[0]))
            elif mutation=='wrong':rows[0]['value_sgd']='100001.00'
            elif mutation=='unknown_zero':next(r for r in rows if r['status']=='UNKNOWN')['value_sgd']='0'
            elif mutation=='header_order':header.reverse()
            elif mutation=='extra_column':header.append('notes')
            elif mutation=='confirmed_native':next(r for r in rows if r['status']=='CONFIRMED')['original_currency']='EUR'
            with path.open('w',newline='') as f:w=csv.DictWriter(f,header);w.writeheader();w.writerows(rows)
            with self.subTest(mutation=mutation):
                actual = evaluate(check,response,out,ROOT)[0]
                if mutation == 'header_order':self.assertTrue(actual)
                elif mutation == 'extra_column':self.assertIsNone(actual)
                else:self.assertFalse(actual)
                if mutation in {'header_order','extra_column'}:
                    fmt=next(c for c in contract['checks'] if c['kind']=='csv_format')
                    self.assertFalse(evaluate(fmt,response,out,ROOT)[0])
    def test_xlsx_inline_and_str_positive(self):
        self.assertTrue(self.ledger())
        def as_str(xml,parts):
            for cell in xml.findall('.//s:c',NS):
                if cell.get('t')=='inlineStr':
                    value=''.join(t.text or '' for t in cell.findall('.//s:t',NS));ref=cell.get('r');cell.clear();cell.attrib.update(r=ref,t='str');ET.SubElement(cell,'{'+NS['s']+'}v').text=value
        self.assertTrue(self.ledger(as_str))
    def test_xlsx_shared_strings_positive(self):
        def mutate(xml,parts):
            shared=ET.Element('{'+NS['s']+'}sst');index=0
            for cell in xml.findall('.//s:c',NS):
                if cell.get('t')=='inlineStr':
                    value=''.join(t.text or '' for t in cell.findall('.//s:t',NS));ref=cell.get('r');cell.clear();cell.attrib.update(r=ref,t='s');ET.SubElement(cell,'{'+NS['s']+'}v').text=str(index)
                    si=ET.SubElement(shared,'{'+NS['s']+'}si');ET.SubElement(si,'{'+NS['s']+'}t').text=value;index+=1
            parts['xl/sharedStrings.xml']=ET.tostring(shared)
        self.assertTrue(self.ledger(mutate))
    def test_xlsx_numeric_id_or_lost_zero_or_text_amount_negative(self):
        for mutation in ['numeric_id','lost_zero','text_amount','fractional_error']:
            def change(xml,parts):
                ref='C2' if mutation in {'text_amount','fractional_error'} else 'A2';cell=next(c for c in xml.findall('.//s:c',NS) if c.get('r')==ref)
                if mutation=='numeric_id':
                    cell.clear();cell.attrib.update(r=ref,t='n');ET.SubElement(cell,'{'+NS['s']+'}v').text='1'
                elif mutation=='lost_zero':cell.find('.//s:t',NS).text='1'
                elif mutation=='text_amount':cell.set('t','str')
                else:cell.find('s:v',NS).text=str(Decimal(cell.findtext('s:v',namespaces=NS)) + Decimal('.001'))
            with self.subTest(mutation=mutation):self.assertFalse(self.ledger(change))
    def test_xlsx_formula_recalculation_positive(self):
        def change(xml,parts):
            for cell in xml.findall('.//s:c',NS):
                if cell.get('r','').startswith('F') and cell.get('r')!='F1':
                    row=cell.get('r')[1:];ET.SubElement(cell,'{'+NS['s']+'}f').text=f'ROUND(C{row}-D{row}-E{row},2)'
        self.assertTrue(self.ledger(change))
    def test_xlsx_formula_no_cache_positive(self):
        def change(xml,parts):
            cell=next(c for c in xml.findall('.//s:c',NS) if c.get('r')=='F2');cell.remove(cell.find('s:v',NS));ET.SubElement(cell,'{'+NS['s']+'}f').text='ROUND(C2-D2-E2,2)'
        self.assertTrue(self.ledger(change))
    def test_xlsx_formula_false_cache_wrong_reference_wrong_math_negative(self):
        for formula in ['ROUND(C2-D2-E2,2)+0.01','ROUND(C2401-D2401-E2401,2)','ROUND(C2+D2-E2,2)','__import__("os").system("id")']:
            def change(xml,parts):
                cell=next(c for c in xml.findall('.//s:c',NS) if c.get('r')=='F2');ET.SubElement(cell,'{'+NS['s']+'}f').text=formula
            with self.subTest(formula=formula):
                actual=self.ledger(change)
                if '__import__' in formula:self.assertIsNone(actual)
                else:self.assertFalse(actual)
    def test_xlsx_unsupported_formula_unknown(self):
        def change(xml,parts):
            cell=next(c for c in xml.findall('.//s:c',NS) if c.get('r')=='F2');ET.SubElement(cell,'{'+NS['s']+'}f').text='SUM(C2,-D2,-E2)'
        self.assertIsNone(self.ledger(change))
    def test_new_run_revision_enforced_and_aggregate_version_guard(self):
        case,contract,response,out=self.materialize('B17.reconcile')
        run={'run_id':'NEW-CONTROL','scenario_id':case['id'],'run_origin':'NEW_MODEL','completion':'COMPLETE','failure_origin':'NONE'}
        with self.assertRaises(BenchError):score_response(case,contract['checks'],response,run,out,ROOT)
        run['rubric_version']='RECON-0.2'
        with self.assertRaises(BenchError):score_response(case,contract['checks'],response,run,out,ROOT)
        run['task_revision']='B17-contract-0.2'
        report=score_response(case,contract['checks'],response,run,out,ROOT)
        self.assertEqual(report['objective_score'],100);self.assertIsNone(report['human_quality_score'])
        altered=deepcopy(report);altered['task_revision']='RECON-0.1'
        with self.assertRaises(BenchError):aggregate([altered])
    def test_service_run_session_fingerprint_hash_binding(self):
        case,contract,response,out=self.materialize('B01.discovery');obs=observed_reference(case,response,out,run_id='IDENTITY-CONTROL')
        run={'run_id':'IDENTITY-CONTROL','session_id':obs['session_id'],'scenario_id':case['id'],'run_origin':'NEW_MODEL','completion':'COMPLETE','failure_origin':'NONE','rubric_version':'RECON-0.2','task_revision':case['task_revision'],'observation_file_sha256':hashlib.sha256(dumps(obs).encode()).hexdigest()}
        score=score_response(case,contract['checks'],response,run,out,ROOT,obs);self.assertEqual(score['objective_score'],100)
        for field,value in [('run_id','WRONG'),('session_id','WRONG'),('execution_fingerprint','old-fingerprint'),('scenario_id','B13.deep')]:
            changed=deepcopy(obs);changed[field]=value
            with self.subTest(field=field),self.assertRaises(BenchError):score_response(case,contract['checks'],response,run,out,ROOT,changed)
        changed=deepcopy(obs);changed['events'].append({'actor':'CANDIDATE','operation':'source_search','query':'tamper'})
        with self.assertRaises(BenchError):score_response(case,contract['checks'],response,run,out,ROOT,changed)
        changed=deepcopy(run);changed.pop('observation_file_sha256')
        with self.assertRaises(BenchError):score_response(case,contract['checks'],response,changed,out,ROOT,obs)
    def test_helper_unhandled_is_distinct_from_unknown(self):
        malformed={'scenario_id':'B13.deep','result':[]}
        self.assertEqual(evaluate_equivalence({'kind':'eq','path':'result.state_evidence'},malformed,self.dir,ROOT)[0:2],(False,None))
        r=contracts('B13.deep')['reference_response']
        self.assertEqual(evaluate_equivalence({'kind':'eq','path':'result.launch_allowed','expected':False},r,self.dir,ROOT)[0:2],(False,None))
        bad=deepcopy(r);bad['result']['state_evidence']='narrative requiring review'
        self.assertEqual(evaluate_equivalence({'kind':'eq','path':'result.state_evidence'},bad,self.dir,ROOT)[0:2],(True,None))

    def test_new_csv_extra_summary_is_unknown_not_critical_fail(self):
        case,contract,response,out=self.materialize('B17.reconcile');path=out/'valuation.csv';original=path.read_text()
        check=next(c for c in contract['checks'] if c['kind']=='valuation_csv_rows')
        fmt=next(c for c in contract['checks'] if c['kind']=='csv_format')
        for label,status in [('TOTAL_CONFIRMED','CONFIRMED'),('CONFIRMED_SUBTOTAL','CONFIRMED_SUBTOTAL')]:
            path.write_text(original+f'{label},480280.00,{status},,\n')
            self.assertIsNone(evaluate(check,response,out,ROOT)[0])
            self.assertEqual(evaluate(fmt,response,out,ROOT)[0],status=='CONFIRMED')
            run={'run_id':'SUMMARY-CONTROL','scenario_id':case['id'],'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE','human_review':{'reviewer':'SYNTHETIC_CONTROL','facts':4,'completeness':4,'usability':4,'evidence':'Synthetic boundary test, not human review'}}
            report=score_response(case,contract['checks'],response,run,out,ROOT)
            self.assertFalse(report['critical_failed']);self.assertTrue(report['critical_unknown']);self.assertIsNone(report['human_quality_score'])
    def test_new_csv_fake_total_and_real_extra_position_negative(self):
        _,contract,response,out=self.materialize('B17.reconcile');path=out/'valuation.csv';original=path.read_text()
        check=next(c for c in contract['checks'] if c['kind']=='valuation_csv_rows')
        for line in ['TOTAL,480280.01,CONFIRMED,,\n','P-FAKE-9,100,CONFIRMED,,\n','NEW-REAL-POSITION,100,CONFIRMED,,\n']:
            path.write_text(original+line);self.assertFalse(evaluate(check,response,out,ROOT)[0])
        path.write_text(original+'uninterpretable,,NOTE,,\n')
        self.assertIsNone(evaluate(check,response,out,ROOT)[0])
    def test_ragged_csv_format_fail_business_unknown(self):
        _,contract,response,out=self.materialize('B17.reconcile');path=out/'valuation.csv';original=path.read_text()
        check=next(c for c in contract['checks'] if c['kind']=='valuation_csv_rows');fmt=next(c for c in contract['checks'] if c['kind']=='csv_format')
        for content in [original.replace('U-QUOTE,,UNKNOWN,,','U-QUOTE,,UNKNOWN,,,'),original.replace('U-QUOTE,,UNKNOWN,,','U-QUOTE,,UNKNOWN,')]:
            path.write_text(content);self.assertFalse(evaluate(fmt,response,out,ROOT)[0]);self.assertIsNone(evaluate(check,response,out,ROOT)[0])
    def test_shared_money_equivalence_zero_tolerance_without_context_rounding(self):
        c={'kind':'money','path':'v','expected':'999999999999999999999999999999999.00','tolerance':'0.00'}
        self.assertFalse(evaluate(c,{'v':'999999999999999999999999999999999.01'},self.dir,ROOT)[0])
    def test_formula_rounding_and_cycle_boundaries(self):
        from counso_bench.office_check import ledger_formula_value, UnsupportedFormula
        self.assertEqual(ledger_formula_value('ROUND(-1.005,2)',{}),Decimal('-1.01'))
        self.assertEqual(ledger_formula_value('ROUND(1.005,2)',{}),Decimal('1.01'))
        with self.assertRaises(BenchError):ledger_formula_value('C2',{'Ledger!C2':{'type':'n','value':'1','formula':'C2'}})
        with self.assertRaises(UnsupportedFormula):ledger_formula_value('C2+'*3000+'1',{})

    def test_selected_required_maps_pass_and_valid_unknown_scope_unknown(self):
        for field, extras in [('selected_holding_rows',{'U-EUR-FX':'H-U-EUR-FX-CURRENT','U-QUOTE':'H-U-QUOTE-CURRENT'}),('selected_quote_rows',{'U-EUR-FX':'Q-U-EUR-FX-CURRENT'})]:
            expected=deepcopy(contracts('B17.reconcile')['reference_response']['result'][field])
            self.assertTrue(self.check('B17.reconcile',field,expected))
            expected.update(extras)
            self.assertIsNone(self.check('B17.reconcile',field,expected))
            self.assertIsNone(self.check('B17.reconcile',field,expected,legacy=True))
    def test_selected_missing_wrong_and_invalid_extra_source_negative(self):
        for field in ['selected_holding_rows','selected_quote_rows']:
            expected=deepcopy(contracts('B17.reconcile')['reference_response']['result'][field]);missing=deepcopy(expected);missing.pop('P-SGD-1')
            self.assertFalse(self.check('B17.reconcile',field,missing))
            wrong=deepcopy(expected);wrong['P-SGD-1']='nonexistent';self.assertFalse(self.check('B17.reconcile',field,wrong))
        for field,extra in [('selected_holding_rows',{'U-PERIOD':'H-U-PERIOD-CURRENT'}),('selected_holding_rows',{'U-DRAFT':'H-U-DRAFT-CURRENT'}),('selected_holding_rows',{'U-QUOTE':'H-U-EUR-FX-CURRENT'}),('selected_quote_rows',{'U-QUOTE':'Q-U-QUOTE-CURRENT'}),('selected_quote_rows',{'U-QUOTE':'Q-U-QUOTE-STALE-FINAL'}),('selected_quote_rows',{'U-EUR-FX':'NONEXISTENT'})]:
            value=deepcopy(contracts('B17.reconcile')['reference_response']['result'][field]);value.update(extra)
            with self.subTest(field=field,extra=extra):self.assertFalse(self.check('B17.reconcile',field,value))

    def test_csv_out_of_enum_status_format_fail_not_fact_invention(self):
        _,contract,response,out=self.materialize('B17.reconcile');path=out/'valuation.csv';original=path.read_text()
        check=next(c for c in contract['checks'] if c['kind']=='valuation_csv_rows');fmt=next(c for c in contract['checks'] if c['kind']=='csv_format')
        path.write_text(original.replace('P-SGD-1,100000.00,CONFIRMED','P-SGD-1,100000.00,confirmed'))
        self.assertFalse(evaluate(fmt,response,out,ROOT)[0]);self.assertIsNone(evaluate(check,response,out,ROOT)[0])
        path.write_text(original.replace('P-SGD-1,100000.00,CONFIRMED','P-SGD-1,100000.00,UNKNOWN'))
        self.assertTrue(evaluate(fmt,response,out,ROOT)[0]);self.assertFalse(evaluate(check,response,out,ROOT)[0])
        path.write_text(original.replace('P-SGD-1,100000.00,CONFIRMED','P-SGD-1,100000.01,confirmed'))
        self.assertFalse(evaluate(fmt,response,out,ROOT)[0]);self.assertFalse(evaluate(check,response,out,ROOT)[0])

    def test_xlsx_legal_physical_row_order_positive_duplicates_negative(self):
        def reorder(xml,parts):
            data=xml.find('s:sheetData',NS);rows=list(data)
            for row in rows:data.remove(row)
            for row in reversed(rows):data.append(row)
        self.assertTrue(self.ledger(reorder))
        def duplicate_row(xml,parts):
            data=xml.find('s:sheetData',NS);row=next(r for r in data if r.get('r')=='2');data.append(deepcopy(row))
        self.assertFalse(self.ledger(duplicate_row))
        def duplicate_cell(xml,parts):
            data=xml.find('s:sheetData',NS);row=next(r for r in data if r.get('r')=='2');row.append(deepcopy(row[0]))
        self.assertFalse(self.ledger(duplicate_cell))

    def test_selected_scope_unknown_blocks_complete_quality_not_known_errors(self):
        case,contract,response,out=self.materialize('B17.reconcile')
        response['result']['selected_quote_rows']['U-EUR-FX']='Q-U-EUR-FX-CURRENT'
        run={'run_id':'SCOPE-QUALITY-CONTROL','scenario_id':case['id'],'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE','human_review':{'reviewer':'SYNTHETIC_CONTROL','facts':4,'completeness':4,'usability':4,'evidence':'Synthetic review control, not actual human judgment'}}
        report=score_response(case,contract['checks'],response,run,out,ROOT)
        self.assertTrue(report['quality_scope_unknown']);self.assertFalse(report['critical_unknown']);self.assertIsNone(report['human_quality_score']);self.assertIsNone(aggregate([report])['human_quality_mean'])
        response['result']['confirmed_subtotal_sgd']='480280.01'
        report=score_response(case,contract['checks'],response,run,out,ROOT)
        self.assertTrue(report['critical_failed']);self.assertTrue(report['quality_scope_unknown']);self.assertEqual(report['human_quality_score'],0)
        # A determined noncritical error retains the original completeness cap.
        response=deepcopy(contract['reference_response']);response['result']['selected_quote_rows'].pop('P-SGD-1')
        report=score_response(case,contract['checks'],response,run,out,ROOT)
        self.assertFalse(report['quality_scope_unknown']);self.assertEqual(report['human_quality_score'],round(11/3,4))
