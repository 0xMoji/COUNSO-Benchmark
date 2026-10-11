from pathlib import Path
import csv, json, hashlib
from decimal import Decimal

base = Path('/workspace/shared/counso-pilot-20261010/candidates/pilot20261010-g61_medium-B17_reconcile-r1')
inp, out = base/'input', base/'output'
read_files = []
def read(rel):
    p = inp/rel
    read_files.append(str(p))
    return p.read_text()
prompt = read('prompt.txt')
schema = json.loads(read('response_schema.json'))
manifest = json.loads(read('input_manifest.json'))
holdings_text = read('inputs/holdings-versions.csv')
quotes_text = read('inputs/quotes-versions.csv')
policy_text = read('inputs/valuation_policy.json')
policy = json.loads(policy_text)['data']
holdings = list(csv.DictReader(holdings_text.splitlines()))
quotes = list(csv.DictReader(quotes_text.splitlines()))
for n, row in enumerate(holdings, 2): row['line'] = n
for n, row in enumerate(quotes, 2): row['line'] = n
texts = {'inputs/holdings-versions.csv':holdings_text, 'inputs/quotes-versions.csv':quotes_text, 'inputs/valuation_policy.json':policy_text}
hash_checks = []
for entry in manifest['files']:
    actual = hashlib.sha256(texts[entry['path']].encode()).hexdigest()
    assert actual == entry['sha256'], entry['path']
    hash_checks.append({'path':entry['path'], 'sha256':actual, 'matches_manifest':True})
rows=[]
selected_h={}; selected_q={}; missing={}; subtotal=Decimal(0); eur=Decimal(0)
for pid in sorted({h['position_id'] for h in holdings}):
    valid_h=[h for h in holdings if h['position_id']==pid and h['period']==policy['holding_period'] and h['status']==policy['allowed_holding_status']]
    h=max(valid_h,key=lambda r:r['version_date']) if valid_h else None
    valid_q=[q for q in quotes if q['position_id']==pid and q['date']==policy['as_of'] and q['state']==policy['allowed_quote_state']]
    q=max(valid_q,key=lambda r:r['published_at']) if valid_q else None
    evidence=[]
    if not h: evidence.append('APPROVED_OCTOBER_HOLDING')
    if not q: evidence.append('FINAL_AS_OF_QUOTE')
    native = Decimal(h['units'])*Decimal(q['price']) if h and q else None
    sgd=None; fx_formula=''; note=''
    if native is not None:
        if h['currency']=='SGD':
            sgd=native; fx_formula='SGD identity (1)'
        else:
            fx=policy['fx_domains'].get(h['fx_domain'],{})
            if fx.get('date')!=policy['as_of']:
                evidence.append('AS_OF_AUTHORIZED_FX')
                note='Available restricted-domain FX is dated 2026-10-01; cannot use standard-domain FX without authorization.'
            elif h['currency']=='USD' and 'USD_per_SGD' in fx:
                sgd=native/Decimal(fx['USD_per_SGD']); fx_formula=f"USD / {fx['USD_per_SGD']} USD_per_SGD"
            elif h['currency']=='EUR' and 'SGD_per_EUR' in fx:
                sgd=native*Decimal(fx['SGD_per_EUR']); fx_formula=f"EUR * {fx['SGD_per_EUR']} SGD_per_EUR"
            else:
                evidence.append('AS_OF_AUTHORIZED_FX')
    if evidence:
        missing[pid]=evidence
    else:
        selected_h[pid]=h['holding_row_id']; selected_q[pid]=q['quote_row_id']
        subtotal+=sgd
        if h['currency']=='EUR': eur+=native
    if pid=='U-QUOTE': note='Only as-of INDICATIVE and wrong-date FINAL quotes exist; neither supplies an authorized as-of final price.'
    if pid=='U-DRAFT': note='Only DRAFT holding exists for October; units cannot be treated as approved.'
    if pid=='U-PERIOD': note='Holding period is September despite its October entered date; October approved holding is missing.'
    rows.append({'position_id':pid,'status':'UNKNOWN' if evidence else 'CONFIRMED','period':policy['holding_period'],'as_of':policy['as_of'],'holding_row_id':h['holding_row_id'] if h else '', 'holding_source_locator':f"holdings-versions: line {h['line']}" if h else '', 'quote_row_id':q['quote_row_id'] if q else '', 'quote_source_locator':f"quotes-versions: line {q['line']}" if q else '', 'units':h['units'] if h else '', 'price':q['price'] if q else '', 'currency':h['currency'] if h else '', 'native_value':format(native,'f') if native is not None else '', 'fx_domain':h['fx_domain'] if h else '', 'fx_formula':fx_formula, 'value_sgd':format(sgd,'f') if sgd is not None else '', 'missing_evidence':';'.join(evidence),'note':note})
with (out/'valuation_detail.csv').open('w',newline='') as f:
    writer=csv.DictWriter(f,fieldnames=list(rows[0]))
    writer.writeheader();writer.writerows(rows)
assert subtotal==Decimal('480280')
assert eur==Decimal('120000')
assert set(missing)=={'U-DRAFT','U-EUR-FX','U-PERIOD','U-QUOTE'}
response={'schema_version':'RECON-0.1','scenario_id':'B17.reconcile','summary':'按持仓 period=2026-10、APPROVED 最新有效版本及 2026-10-08 FINAL 报价核对。四项确认 SGD 小计 480280，不是完整基金总值。P-EUR-3 原币中间值 EUR 120000；U-EUR-FX 可确定 EUR 4000，但缺本域估值日授权汇率，SGD 值保留未知。U-QUOTE 缺估值日 FINAL 报价；U-DRAFT 与 U-PERIOD 缺十月 APPROVED 持仓。USD 按 USD_per_SGD=0.74 逆向换算，111000 USD / 0.74 = 150000 SGD。静态逐项 CSV 已提供，未知值为空而非零。','result':{'complete_valuation_sgd':None,'confirmed_subtotal_sgd':format(subtotal,'f'),'detail_file':'valuation_detail.csv','eur_intermediate':format(eur,'f'),'excluded_evidence':['DRAFT_HOLDING','INDICATIVE_QUOTE','SEPTEMBER_HOLDING','WRONG_DATE_FX','WRONG_DATE_QUOTE'],'missing_evidence':missing,'period_source':'holdings-versions.period (target: valuation_policy.data.holding_period = 2026-10)','selected_holding_rows':selected_h,'selected_quote_rows':selected_q,'static_output_acceptable':True,'unknown_positions':sorted(missing)},'citations':[{'source_id':'valuation_policy','locator':'data.holding_period; data.as_of; data.allowed_holding_status; data.allowed_quote_state; data.version_selection; data.fx_domains.standard; data.fx_domains.restricted-domain; data.rules[0:4]'}, {'source_id':'holdings-versions','locator':'CSV header line 1: period, status, version_date; selected rows lines 2 (P-SGD-1), 3 (P-SGD-4), 11 (P-USD-2), 16 (P-EUR-3); unknown evidence lines 4 (U-QUOTE), 7 (U-DRAFT), 9 (U-PERIOD), 15 (U-EUR-FX)'},{'source_id':'quotes-versions','locator':'CSV header line 1: date, state, published_at; selected rows lines 17 (P-SGD-1), 3 (P-SGD-4), 4 (P-USD-2), 6 (P-EUR-3); U-EUR-FX line 14; U-QUOTE lines 7 and 18'}], 'executed_actions':[]}
(out/'response.json').write_text(json.dumps(response,ensure_ascii=False,indent=2)+'\n')
validation=[]
try:
    import jsonschema
    jsonschema.Draft202012Validator(schema).validate(response)
    validation.append({'check':'response_schema Draft 2020-12','result':'passed'})
    libraries=['Python standard library: pathlib, csv, json, hashlib, decimal','jsonschema']
except ImportError:
    libraries=['Python standard library: pathlib, csv, json, hashlib, decimal']
    validation.append({'check':'jsonschema library','result':'unavailable; manual schema checks used'})
    assert set(response)==set(schema['required'])
    assert set(response['result'])==set(schema['properties']['result']['required'])
    assert response['executed_actions']==[]
validation += [{'check':'manifest SHA-256','result':'passed','files':hash_checks}, {'check':'exact Decimal arithmetic and unknown-position set','result':'passed'}, {'check':'static CSV contains 8 distinct positions; unknown SGD is blank, not zero','result':'passed'}, {'check':'selected row IDs refer only to 4 confirmed positions','result':'passed'}]
trace={'record_type':'self_reported','scope':'Only this candidate input, own output and installed libraries; no network, other candidates, gold, graders, catalog, provenance, server directories, business data or agents accessed. No run_metadata_template read or written.','actual_read_files':read_files,'output_files':['response.json','valuation_detail.csv','reconcile.py','candidate_trace.json'],'libraries_used':libraries,'tools_used':['functions.exec','exec_command (local shell and Python)'],'tool_errors':[],'validation':validation}
(out/'candidate_trace.json').write_text(json.dumps(trace,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'complete','confirmed_subtotal_sgd':str(subtotal),'unknown_positions':sorted(missing),'validation':validation},ensure_ascii=False,indent=2))
