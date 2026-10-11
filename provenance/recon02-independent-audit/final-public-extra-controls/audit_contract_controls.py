"""Independent bounded controls for pilot-discovered RECON-0.2 contracts.
Synthetic controls are separate from anonymous existing candidate artifacts.
No provider/model labels, candidate API calls, implementation writes or upload.
"""
import argparse,copy,csv,hashlib,json,sys,tempfile,zipfile
from pathlib import Path
import xml.etree.ElementTree as E
P=argparse.ArgumentParser();P.add_argument('--package-root',required=True);P.add_argument('--output-dir',required=True);a=P.parse_args()
root=Path(a.package_root).resolve();dest=Path(a.output_dir).resolve()
if dest.exists():raise SystemExit('Refuse to overwrite audit evidence')
dest.mkdir(parents=True);sys.path.insert(0,str(root))
from counso_bench.catalog import select,contracts,export_case,validate_package
from counso_bench.io import ROOT,BenchError,load_json,dumps,sha256
from counso_bench.checks import evaluate
from counso_bench.scoring import score_response,aggregate
from counso_bench.selftest import materialize_reference,observed_reference
from counso_bench.mock import execution_fingerprint
from counso_bench.reviews import compare_configurations
from counso_bench.revision_semantics import evaluate_equivalence
results=[]
def rec(name,got,want,origin='SYNTHETIC_CONTROL',detail=None):
 results.append({'name':name,'passed':got==want,'got':got,'expected':want,'origin':origin,'detail':detail})
def field(sid,k,v,legacy=False):
 c=next(c for c in contracts(sid)['checks'] if c.get('path')=='result.'+k);r=copy.deepcopy(contracts(sid)['reference_response']);r['result'][k]=v
 return evaluate_equivalence(c,r,dest,root)[1] if legacy else evaluate(c,r,dest,root)[0]
rec('package validates',validate_package(root)['valid'],True)
for v in [['登记号','辖区'],['registration_number','jurisdiction'],['jurisdiction','registration']]:rec('B01 explicit alias '+str(v),field('B01.discovery','entity_disambiguation_fields',v),True)
for v in [['jurisdiction','display_name'],['jurisdiction','contact_name'],['jurisdiction','registration','registration_number']]:rec('B01 wrong field '+str(v),field('B01.discovery','entity_disambiguation_fields',v),False)
st=copy.deepcopy(contracts('B13.deep')['reference_response']['result']['state_evidence'])
alias={'sponsor':'sponsor_approval','commercial':'commercial_approval','data':'data_permission','technical':'technical_account','workspace':'workspace'}
new={alias[k]:list(reversed(v))+['authority-policy'] for k,v in st.items()};rec('B13 public aliases plus support',field('B13.deep','state_evidence',new),True)
for k in st:
 bad=copy.deepcopy(st);bad[k]=['authority-policy'];rec('B13 missing primary '+k,field('B13.deep','state_evidence',bad),False)
bad=copy.deepcopy(st);bad['workspace']=['sales-latest'];rec('B13 sales-only authority',field('B13.deep','state_evidence',bad),False)
bad=copy.deepcopy(st);bad['workspace'].append('no-such-source');rec('B13 invented source',field('B13.deep','state_evidence',bad),False)
bad=copy.deepcopy(st);bad['technical']='technical-ready';bad['sponsor']=['authority-policy'];bad={'technical':bad.pop('technical'),**bad};rec('B13 known missing primary dominates malformed other evidence',field('B13.deep','state_evidence',bad),False)
for k,vals in [('confirmed_subtotal_sgd',['480280','480280.0000','4.8028E5']),('eur_intermediate',['4000','4.000E3'])]:
 for v in vals:rec('B17 equivalent '+k+'='+v,field('B17.reconcile',k,v),True)
for v in ['480280.01','480280.0000000000000000000000000001','NaN','Infinity','-Infinity','abc']:rec('B17 wrong/nonfinite='+v,field('B17.reconcile','confirmed_subtotal_sgd',v),False)
for v in ['120000','124000','4000.01']:rec('B17 new explicit wrong EUR='+v,field('B17.reconcile','eur_intermediate',v),False)
for v in ['period','holding_period','持仓期间']:rec('B17 legacy period='+v,field('B17.reconcile','period_source',v,True),True)
for v in ['filename','version_date','quote_date','period_in_filename']:rec('B17 legacy wrong period='+v,field('B17.reconcile','period_source',v,True),False)
b=dest/'B17-synthetic';r=materialize_reference(select('B17.reconcile'),contracts('B17.reconcile'),b);p=b/r['result']['detail_file'];original=p.read_text();c=next(c for c in contracts('B17.reconcile')['checks'] if c['kind']=='valuation_csv_rows');f=next(c for c in contracts('B17.reconcile')['checks'] if c['kind']=='csv_format')
variants=[('reference',original,True,True),('proper_summary',original+'TOTAL_CONFIRMED,480280,CONFIRMED,,\n',None,True),('wrong_total',original+'TOTAL,480280.01,CONFIRMED,,\n',False,True),('extra_real_prefixed',original+'P-FAKE-9,100,CONFIRMED,,\n',False,True),('extra_real_other_id',original+'NEW-REAL-POSITION,100,CONFIRMED,,\n',False,True),('status_case_only',original.replace('P-SGD-1,100000.00,CONFIRMED,,','P-SGD-1,100000.00,confirmed,,'),None,False),('status_case_and_wrong_amount',original.replace('P-SGD-1,100000.00,CONFIRMED,,','P-SGD-1,100000.01,confirmed,,'),False,False),('status_real_reversal',original.replace('P-SGD-1,100000.00,CONFIRMED,,','P-SGD-1,100000.00,UNKNOWN,,'),False,True),('unknown_zero',original.replace('U-QUOTE,,UNKNOWN,,','U-QUOTE,0,UNKNOWN,,'),False,True),('ragged',original.replace('U-QUOTE,,UNKNOWN,,','U-QUOTE,,UNKNOWN,,,'),None,False),('missing',original.replace('U-QUOTE,,UNKNOWN,,\n',''),False,True)]
for name,text,want,wantfmt in variants:
 p.write_text(text);got=evaluate(c,r,b,root);fmt=evaluate(f,r,b,root);rec('B17 CSV business '+name,got[0],want,detail=got[1]);rec('B17 CSV format '+name,fmt[0],wantfmt,detail=fmt[1])
p.write_text(original)
# A new independent service run, with assessor-pinned receipt before mutations.
b1=dest/'B01-synthetic';r1=materialize_reference(select('B01.discovery'),contracts('B01.discovery'),b1);obs=observed_reference(select('B01.discovery'),r1,b1,run_id='AUDIT-RECON02-NEW-B01');run={'run_id':'AUDIT-RECON02-NEW-B01','scenario_id':'B01.discovery','session_id':obs['session_id'],'run_origin':'NEW_MODEL','completion':'COMPLETE','failure_origin':'NONE','rubric_version':'RECON-0.2','task_revision':select('B01.discovery')['task_revision'],'observation_file_sha256':hashlib.sha256(dumps(obs).encode()).hexdigest()}
rep=score_response(select('B01.discovery'),contracts('B01.discovery')['checks'],r1,run,b1,root,obs);rec('B01 new service real local source reads',rep['objective_score'],100,origin='LOCAL_ASSESSOR_SERVICE_CONTROL',detail={'session_id':obs['session_id'],'fingerprint':obs['execution_fingerprint']})
for k,v in [('run_id','WRONG'),('session_id','WRONG'),('scenario_id','B13.deep'),('execution_fingerprint','OLD')]:
 wrong=copy.deepcopy(obs);wrong[k]=v
 try:score_response(select('B01.discovery'),contracts('B01.discovery')['checks'],r1,run,b1,root,wrong);rejected=False
 except BenchError:rejected=True
 rec('B01 reject wrong '+k,rejected,True)
wrong=copy.deepcopy(obs);wrong['events'].append({'actor':'CANDIDATE','operation':'source_search','query':'edited'})
try:score_response(select('B01.discovery'),contracts('B01.discovery')['checks'],r1,run,b1,root,wrong);rejected=False
except BenchError:rejected=True
rec('B01 reject modified content despite same identity',rejected,True)
# Existing anonymous artifacts only; their factual validity is rechecked here.
blind=Path('/workspace/shared/counso-pilot-20261010/blind-review')
for sample in ['sample-908969935c','sample-1364108c8c']:
 o=blind/sample/'output';response=load_json(o/'response.json');c20=next(c for c in contracts('B20.scale')['checks'] if c['kind']=='xlsx_ledger_contract');g=evaluate(c20,response,o,root);rec('B20 existing anonymous '+sample,g[0],True,origin='EXISTING_ANONYMOUS_CANDIDATE_ARTIFACT',detail={'reason':g[1],'workbook_sha256':sha256(o/response['result']['workbook'])})
# Synthetic nearby corruptions of the formula workbook, not candidate results.
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
o=blind/'sample-908969935c'/'output';rr=load_json(o/'response.json');source=o/rr['result']['workbook'];c20=next(c for c in contracts('B20.scale')['checks'] if c['kind']=='xlsx_ledger_contract')
with zipfile.ZipFile(source) as z:parts={n:z.read(n) for n in z.namelist()}
ws=next(n for n in parts if n.startswith('xl/worksheets/') and n.endswith('.xml'))
for name,want in [('fake_cache',False),('wrong_reference',False),('unsupported_SUM',None),('numeric_ID',False),('lost_zero',False),('text_amount',False),('drop_row',False),('extra_row',False),('duplicate_row_same_refs',False),('duplicate_cell_same_ref',False),('reordered_complete_records',True)]:
 d=dest/name;d.mkdir();changed=dict(parts);x=E.fromstring(changed[ws]);cell=lambda ref:next(e for e in x.findall('.//s:c',NS) if e.get('r')==ref)
 if name=='fake_cache':cell('F2').find('s:v',NS).text='128.62'
 elif name=='wrong_reference':cell('F2').find('s:f',NS).text='ROUND(C2401-D2401-E2401,2)'
 elif name=='unsupported_SUM':cell('F2').find('s:f',NS).text='SUM(C2,-D2,-E2)'
 elif name=='numeric_ID':cell('A2').set('t','n')
 elif name=='lost_zero':cell('A2').find('s:v',NS).text='1'
 elif name=='text_amount':cell('C2').set('t','str')
 elif name=='drop_row':x.find('s:sheetData',NS).remove(x.find('s:sheetData/s:row[@r="2401"]',NS))
 elif name=='extra_row':row=copy.deepcopy(x.find('s:sheetData/s:row[@r="2401"]',NS));row.set('r','2402');[e.set('r',e.get('r').replace('2401','2402')) for e in row.findall('s:c',NS)];x.find('s:sheetData',NS).append(row)
 elif name=='duplicate_row_same_refs':x.find('s:sheetData',NS).append(copy.deepcopy(x.find('s:sheetData/s:row[@r="2"]',NS)))
 elif name=='duplicate_cell_same_ref':row=x.find('s:sheetData/s:row[@r="2"]',NS);row.append(copy.deepcopy(row.find('s:c[@r="A2"]',NS)))
 elif name=='reordered_complete_records':
  sd=x.find('s:sheetData',NS);ra=sd.find('s:row[@r="2"]',NS);rb=sd.find('s:row[@r="2401"]',NS);ca=copy.deepcopy(ra);cb=copy.deepcopy(rb)
  for target,source,rownum in [(ra,cb,'2'),(rb,ca,'2401')]:
   for e in list(target):target.remove(e)
   for e in source:
    e.set('r',e.get('r')[0]+rownum);ff=e.find('s:f',NS)
    if ff is not None:ff.text='ROUND(C'+rownum+'-D'+rownum+'-E'+rownum+',2)'
    target.append(e)
 changed[ws]=E.tostring(x)
 with zipfile.ZipFile(d/rr['result']['workbook'],'w') as z:
  for n,v in changed.items():z.writestr(n,v)
 got=evaluate(c20,rr,d,root);rec('B20 synthetic '+name,got[0],want,detail=got[1])
# Existing fixed-contract outputs: decimal notation and retained key-scope doubt.
blind2=Path('/workspace/shared/counso-pilot-20261010/blind-review-v2')
scope_reports={}
for sample,scope_unknown in [('sample-f874703c20',False),('sample-d3b1e4ceb3',False),('sample-47865c6bec',True)]:
 o=blind2/sample/'output';response=load_json(o/'response.json')
 envelope={'run_id':'CONTROL-REPLAY-'+sample,'scenario_id':'B17.reconcile','run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE','rubric_version':'RECON-0.2','task_revision':'B17-contract-0.2','human_review':{'reviewer':'SYNTHETIC_GATE_CONTROL_NOT_HUMAN','facts':4,'completeness':4,'usability':4,'evidence':'Control envelope only, no human quality claim'}}
 report=score_response(select('B17.reconcile'),contracts('B17.reconcile')['checks'],response,envelope,o,root)
 scope_reports[sample]=report
 rec('B17 existing anonymous '+sample+' known facts no hard failure',report['critical_failed'],False,origin='EXISTING_ANONYMOUS_CANDIDATE_ARTIFACT',detail={'response_sha256':sha256(o/'response.json'),'unknown_or_failed':[x for x in report['checks'] if x['passed'] is not True]})
 rec('B17 existing anonymous '+sample+' scope truthfulness',report['objective_score'] is None,scope_unknown,origin='EXISTING_ANONYMOUS_CANDIDATE_ARTIFACT')
 if scope_unknown:rec('B17 retained scope unknown does not manufacture quality',report['human_quality_score'],None,origin='SYNTHETIC_GATE_CONTROL_WITH_EXISTING_ARTIFACT')
known=scope_reports['sample-f874703c20'];uncertain=scope_reports['sample-47865c6bec']
agg=aggregate([uncertain]);rec('B17 scope unknown full quality mean remains unknown',agg['human_quality_mean'],None);rec('B17 scope unknown quality coverage',agg['human_quality_review_coverage'],0)
comparison=compare_configurations({'CONTROL_KNOWN':[known],'CONTROL_SCOPE_UNKNOWN':[uncertain]});rec('B17 scope unknown common quality set empty',comparison['shared_scenario_count'],0)
o=blind2/'sample-47865c6bec'/'output';response=load_json(o/'response.json');response['result']['confirmed_subtotal_sgd']='480280.01';envelope['run_id']='CONTROL-SCOPE-UNKNOWN-KNOWN-FAIL'
wrong=score_response(select('B17.reconcile'),contracts('B17.reconcile')['checks'],response,envelope,o,root);rec('B17 scope unknown cannot mask known critical failure',wrong['human_quality_score'],0)
envelope.update(run_id='CONTROL-VALID-MODEL-FAIL',completion='FAIL',failure_origin='MODEL');failed=score_response(select('B17.reconcile'),contracts('B17.reconcile')['checks'],response,envelope,o,root);rec('B17 valid model failure stays in denominator',failed['completion_denominator'],1)
# Protect exact fixed prompt/schema/business files rather than only semantics.
export=export_case('B17.reconcile',dest/'B17-export');manifest=load_json(root/'provenance/history/B17-contract-0.2-frozen-manifest.json')
for item in manifest['files']:
 if item['path'] in {'README.txt','input_manifest.json','run_metadata_template.json'}:continue
 rec('B17 preregistered exact bytes '+item['path'],sha256(export/item['path']),item['sha256'])
summary={'execution_identity':{'audit_id':'COUNSO-RECON02-AUDIT-20261010','requested_model':'gpt-6.1-sol','requested_reasoning_effort':'ultra','dispatch_identity_evidence':'Requested model/effort creation parameters accepted; exact backend build/effort attestation unavailable','control_script_sha256':sha256(__file__),'python':sys.version,'package_root':str(root),'manifest_sha256':sha256(root/'provenance/file_manifest.json'),'execution_fingerprint':execution_fingerprint(root),'candidate_model_labels_read':False,'additional_candidate_api_calls':0},'total':len(results),'passed':sum(x['passed'] for x in results),'failed':sum(not x['passed'] for x in results),'checks':results,'notice':'Independent deterministic controls plus two existing anonymous workbook artifacts; no real human review or model ranking.'}
(dest/'audit_contract_controls.py').write_bytes(Path(__file__).read_bytes());(dest/'control-results.json').write_text(dumps(summary));print(dumps({k:v for k,v in summary.items() if k!='checks'}))
raise SystemExit(bool(summary['failed']))
