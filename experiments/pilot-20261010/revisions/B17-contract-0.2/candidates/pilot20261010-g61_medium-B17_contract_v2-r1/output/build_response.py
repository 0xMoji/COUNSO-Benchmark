from pathlib import Path
import csv, json, hashlib
from decimal import Decimal
import jsonschema

base = Path('/workspace/shared/counso-pilot-20261010/revisions/B17-contract-0.2/candidates/pilot20261010-g61_medium-B17_contract_v2-r1')
inp, out = base / 'input', base / 'output'
manifest = json.loads((inp / 'input_manifest.json').read_text())
hash_checks = []
for item in manifest['files']:
    actual = hashlib.sha256((inp / item['path']).read_bytes()).hexdigest()
    assert actual == item['sha256']
    hash_checks.append({'path': item['path'], 'sha256_match': True})
with (inp / 'inputs/holdings-versions.csv').open() as f:
    holdings = list(csv.DictReader(f))
with (inp / 'inputs/quotes-versions.csv').open() as f:
    quotes = list(csv.DictReader(f))
policy = json.loads((inp / 'inputs/valuation_policy.json').read_text())['data']
positions = list(dict.fromkeys(r['position_id'] for r in holdings))
selected_h, selected_q, missing = {}, {}, {}
rows, audit, subtotal = [], [], Decimal('0')
for pid in positions:
    hs = [r for r in holdings if r['position_id'] == pid and r['period'] == policy['holding_period'] and r['status'] == policy['allowed_holding_status']]
    qs = [r for r in quotes if r['position_id'] == pid and r['date'] == policy['as_of'] and r['state'] == policy['allowed_quote_state']]
    h = max(hs, key=lambda r:r['version_date']) if hs else None
    q = max(qs, key=lambda r:r['published_at']) if qs else None
    lacking = []
    if h is None: lacking.append('APPROVED_OCTOBER_HOLDING')
    if q is None: lacking.append('FINAL_AS_OF_QUOTE')
    native = Decimal(h['units']) * Decimal(q['price']) if h and q else None
    value = None
    if native is not None:
        if h['currency'] == 'SGD': value = native
        else:
            fx = policy['fx_domains'].get(h['fx_domain'])
            if not fx or fx['date'] != policy['as_of']:
                lacking.append('AS_OF_AUTHORIZED_FX')
            elif h['currency'] == 'USD': value = native / Decimal(fx['USD_per_SGD'])
            elif h['currency'] == 'EUR': value = native * Decimal(fx['SGD_per_EUR'])
            else: lacking.append('AS_OF_AUTHORIZED_FX')
    confirmed = value is not None
    if confirmed:
        subtotal += value
        selected_h[pid], selected_q[pid] = h['holding_row_id'], q['quote_row_id']
    else: missing[pid] = lacking
    rows.append({'position_id':pid, 'value_sgd':str(value) if confirmed else '', 'status':'CONFIRMED' if confirmed else 'UNKNOWN', 'original_currency':h['currency'] if not confirmed and native is not None else '', 'original_value':str(native) if not confirmed and native is not None else ''})
    audit.append({'position_id':pid, 'holding_row_id':h['holding_row_id'] if h else None, 'quote_row_id':q['quote_row_id'] if q else None, 'native_value':str(native) if native is not None else None, 'currency':h['currency'] if h else None, 'value_sgd':str(value) if confirmed else None, 'missing_evidence':lacking})
with (out / 'valuation_detail.csv').open('w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=['position_id','value_sgd','status','original_currency','original_value'])
    writer.writeheader(); writer.writerows(rows)
response = {
 'schema_version':'RECON-0.1', 'scenario_id':'B17.reconcile',
 'summary':'按持仓period=2026-10、APPROVED内最新version_date及2026-10-08 FINAL报价核对：确认小计为480280 SGD。4个头寸仍未知，不能报告完整基金总值。U-EUR-FX可确定原币金额4000 EUR，但缺少估值日授权汇率。静态逐项CSV已交付。',
 'result':{'complete_valuation_sgd':None, 'confirmed_subtotal_sgd':str(subtotal), 'detail_file':'valuation_detail.csv', 'eur_intermediate':next(r['original_value'] for r in rows if r['position_id']=='U-EUR-FX'), 'excluded_evidence':['DRAFT_HOLDING','INDICATIVE_QUOTE','SEPTEMBER_HOLDING','WRONG_DATE_FX','WRONG_DATE_QUOTE'], 'missing_evidence':missing, 'period_source':'period', 'selected_holding_rows':selected_h, 'selected_quote_rows':selected_q, 'static_output_acceptable':True, 'unknown_positions':list(missing)},
 'citations':[
 {'source_id':'valuation_policy','locator':'data.allowed_holding_status, data.allowed_quote_state, data.as_of, data.holding_period, data.version_selection; lines 3-5,17-24'},
 {'source_id':'valuation_policy','locator':'data.fx_domains.standard.USD_per_SGD, SGD_per_EUR, date; lines 11-14; restricted-domain.date lines 7-9'},
 {'source_id':'holdings-versions','locator':'holding_row_id and period/version_date/status/units/currency/fx_domain: selected confirmed holdings at lines 2,3,11,16; unknown-position evidence at lines 4,7,9,15'},
 {'source_id':'quotes-versions','locator':'quote_row_id and date/state/price: confirmed quotations at lines 3,4,6,17; U-EUR-FX line 14; U-QUOTE lines 7,18'},
 {'source_id':'holdings-versions','locator':'excluded DRAFT rows at lines 7,10,12,13,19; excluded 2026-09 rows at lines 5,6,9,18,20'},
 {'source_id':'quotes-versions','locator':'excluded INDICATIVE rows at lines 8,9,11,15,18; excluded wrong-date FINAL rows at lines 2,5,7,10,16'}
 ], 'executed_actions':[]
}
(out/'response.json').write_text(json.dumps(response,ensure_ascii=False,indent=2)+'\n')
(out/'calculation_audit.json').write_text(json.dumps({'selection_rule':policy['version_selection'],'positions':audit},ensure_ascii=False,indent=2)+'\n')
schema = json.loads((inp/'response_schema.json').read_text())
jsonschema.Draft202012Validator(schema).validate(response)
with (out/'valuation_detail.csv').open() as f:
    reader = csv.DictReader(f)
    assert reader.fieldnames == ['position_id','value_sgd','status','original_currency','original_value']
    persisted_rows = list(reader)
assert len(persisted_rows) == len(positions) == len({r['position_id'] for r in persisted_rows})
assert {r['position_id'] for r in persisted_rows} == set(positions)
assert subtotal == Decimal('480280')
assert response['result']['eur_intermediate'] == '4000'
assert set(missing) == {'U-QUOTE','U-DRAFT','U-PERIOD','U-EUR-FX'}
for r in persisted_rows:
    if r['status']=='UNKNOWN': assert r['value_sgd']==''
    else: assert r['original_currency']==r['original_value']==''
assert next(r for r in persisted_rows if r['position_id']=='U-EUR-FX')['original_currency']=='EUR'
trace = {
 'record_type':'SELF_REPORTED',
 'scope':'Read only this candidate input materials and own generated outputs; no network, installation, external action, other candidates, gold, scorer, or agent delegation.',
 'read_files':[str(inp/p) for p in ['prompt.txt','response_schema.json','input_manifest.json','inputs/holdings-versions.csv','inputs/quotes-versions.csv','inputs/valuation_policy.json']]+[str(out/'build_response.py'),str(out/'valuation_detail.csv')],
 'libraries_used':['Python standard library: pathlib, csv, json, hashlib, decimal','Installed jsonschema: Draft202012Validator'],
 'tools_used':['functions.exec / exec_command: list candidate input directory, read allowed task files, create own output files, run Python generation and validation'],
 'tool_errors':[],
 'validation':{'input_manifest_hash_checks':hash_checks,'response_schema':'passed Draft 2020-12 validation','csv_header_order':'passed','unique_input_position_coverage':'passed: 8 positions','unknown_values_blank':'passed','confirmed_original_fields_blank':'passed','confirmed_subtotal_sgd':'480280','U-EUR-FX_native_EUR':'4000'},
 'output_files':['response.json','valuation_detail.csv','calculation_audit.json','build_response.py','candidate_trace.json']
}
(out/'candidate_trace.json').write_text(json.dumps(trace,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'schema_validation':'passed','confirmed_subtotal_sgd':str(subtotal),'unknown_positions':list(missing),'detail_rows':len(rows),'output':str(out)},ensure_ascii=False))
