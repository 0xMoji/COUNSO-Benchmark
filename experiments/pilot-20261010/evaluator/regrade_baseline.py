"""Explicit old-evidence regrade. Never changes candidate outputs or old evidence.
Old undefined EUR scope and CSV columns abstain. A zero-weight, noncritical CSV
shape assertion preserves real malformed-record failures without post-hoc weights.
"""
from __future__ import annotations
import argparse,csv,json,pathlib,hashlib,copy,sys,importlib.util,importlib,datetime
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE=ROOT.parent/'counso-benchmark-reconstructed'
BASE_MANIFEST='b2482a51843fa341303eb576756ca4c28ffe11da62ed7c57e2a5a2c46383d2e2'
REVISION='PILOT-LEGACY-REGRADE-0.2.1'
class BenchError(Exception): pass

def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def digest(data):return hashlib.sha256(data).hexdigest()
def assert_sha(path,expected,label):
 actual=sha(path)
 if actual!=expected:raise BenchError(label+' hash mismatch')
 return actual

def verify_service_identity(obs,run,scenario_id,fingerprint):
 expected={'origin':'ASSESSOR_MOCK_SERVICE','run_id':run['run_id'],'session_id':run.get('session_id'),'scenario_id':scenario_id,'execution_fingerprint':fingerprint}
 for key,value in expected.items():
  if not value or obs.get(key)!=value:raise BenchError('Original service identity mismatch: '+key)
 return True

def csv_shape(path):
 try:
  with pathlib.Path(path).open(encoding='utf-8-sig',newline='') as f:rows=list(csv.reader(f,strict=True))
  if not rows or not rows[0]:return False,'CSV missing header'
  if len(set(rows[0]))!=len(rows[0]):return False,'CSV duplicate header names'
  errors=[{'logical_record':i+1,'expected_fields':len(rows[0]),'actual_fields':len(row)} for i,row in enumerate(rows[1:],start=1) if len(row)!=len(rows[0])]
  if errors:return False,'CSV ragged logical records: '+json.dumps(errors,ensure_ascii=False)
  return True,'CSV logical records match header width; this is not a semantic column or value judgment'
 except (OSError,csv.Error,UnicodeError) as e:return False,'Unreadable CSV: '+type(e).__name__

def revised_checklist(case_checks,sid):
 out=copy.deepcopy(case_checks)
 if sid=='B17.reconcile':
  for c in out:
   if c['id'] in {'B17.reconcile:eur_intermediate','valuation:itemized'}:
    c['legacy_critical']=c.get('critical',False);c['critical']=False;c['legacy_contract_underdefined']=True
  out.append({'id':'B17.reconcile:csv_rectangularity_observation','kind':'legacy_csv_shape','path':'result.detail_file','category':'format','weight':0,'critical':False,'supplemental_unweighted':True})
 return out

def make_evaluator(helper):
 original=checks.evaluate
 def evaluate(c,response,output_dir,package_root,observations=None):
  if response['scenario_id']=='B17.reconcile':
   if c['id']=='B17.reconcile:eur_intermediate':return None,'UNKNOWN: old public contract does not identify EUR position or aggregation scope; no retroactive use of the new target'
   if c['id']=='valuation:itemized':return None,'UNKNOWN: old public contract did not specify canonical CSV column names/set; use separate shape assertion and independent itemized semantic review'
   if c['kind']=='legacy_csv_shape':return csv_shape(safe_path(output_dir,response['result']['detail_file']))
   if c['id']=='B17.reconcile:period_source':
    handled,passed,reason=helper(c,response,output_dir,package_root,observations)
    if handled and passed is True:return passed,reason
    value=response['result'].get('period_source')
    if not isinstance(value,str):return False,'period_source must satisfy the public string type contract'
    if value in {'version_date','quote_date','filename','entered'}:return False,'Explicit wrong period-source label; target period cannot be determined from version/quote/entry date or filename'
    return None,'UNKNOWN: old period_source was an unrestricted string; unrecognized narrative/source-path wording needs independent source review, not a hidden-label FAIL or automatic PASS'
  handled,passed,reason=helper(c,response,output_dir,package_root,observations)
  return (passed,reason) if handled else original(c,response,output_dir,package_root,observations)
 return evaluate

def load_helper(new_package):
 folder=pathlib.Path(new_package)/'counso_bench';name='counso_recon02_regrade'
 spec=importlib.util.spec_from_file_location(name,folder/'__init__.py',submodule_search_locations=[str(folder)])
 module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
 return importlib.import_module(name+'.revision_semantics').evaluate_equivalence,folder/'revision_semantics.py'

def selftest(evaluate,output):
 import tempfile
 controls=[]
 def record(name,passed,evidence):
  controls.append({'name':name,'passed':bool(passed),'evidence':evidence,'origin':'CONTROL_ONLY_NOT_CANDIDATE_RESULT'})
 with tempfile.TemporaryDirectory(prefix='legacy-regrade-controls-',dir=ROOT/'evaluator') as tmp:
  tmp=pathlib.Path(tmp);response={'scenario_id':'B17.reconcile','result':{'eur_intermediate':'4000','detail_file':'detail.csv'}}
  for value in ['4000','4000.00','120000','124000']:
   response['result']['eur_intermediate']=value;state,reason=evaluate({'id':'B17.reconcile:eur_intermediate','kind':'eq'},response,tmp,BASE)
   record('old_eur_scope_'+value,state is None,reason)
  variants={'different_header':'position_id,sgd_value,comment\nA,10,ok\n','explicit_total':'position_id,value,kind\nA,10,position\nTOTAL_CONFIRMED,10,summary\n','unknown_extra_row':'position_id,value\nA,10\nUNEXPLAINED,20\n'}
  for name,content in variants.items():
   (tmp/'detail.csv').write_text(content);state,reason=evaluate({'id':'valuation:itemized','kind':'csv_exact'},response,tmp,BASE);record('old_csv_semantics_'+name,state is None,reason)
  for name,content,expected in [('rectangular','a,b\n1,2\n',True),('quoted_comma','a,b\n1,"2,3"\n',True),('ragged_extra','a,b\n1,2,3\n',False),('ragged_short','a,b\n1\n',False),('duplicate_header','a,a\n1,2\n',False)]:
   (tmp/'shape.csv').write_text(content);state,reason=csv_shape(tmp/'shape.csv');record('csv_shape_'+name,state is expected,reason)
  for value,expected in [('period',True),('holding_period',True),('holdings-versions.period',None),('valuation_policy.data.holding_period; assess holdings-versions.period',None),('按持仓期间字段判断，不按录入日',None),('Use latest quote date as reporting month',None),('version_date',False),('quote_date',False),('filename',False),('entered',False),(None,False),([],False),({},False)]:
   response['result']['period_source']=value;state,reason=evaluate({'id':'B17.reconcile:period_source','kind':'eq','path':'result.period_source','expected':'holding_period'},response,tmp,BASE);record('old_period_wording_'+str(value),state is expected,reason)
  run={'run_id':'CONTROL-RUN','session_id':'CONTROL-SESSION'};fp=execution_fingerprint(BASE);obs={'origin':'ASSESSOR_MOCK_SERVICE','run_id':'CONTROL-RUN','session_id':'CONTROL-SESSION','scenario_id':'B01.discovery','execution_fingerprint':fp}
  record('matching_original_service_identity',verify_service_identity(obs,run,'B01.discovery',fp),'Same original run/session/scenario/fingerprint accepted')
  for key in ['run_id','session_id','scenario_id','execution_fingerprint']:
   bad=dict(obs);bad[key]='ALTERED';rejected=False
   try:verify_service_identity(bad,run,'B01.discovery',fp)
   except BenchError:rejected=True
   record('reject_wrong_'+key,rejected,'Mutated identity must be rejected before applying semantic corrections')
  f=tmp/'bound-observation.json';f.write_text('{"events":[]}');expected=sha(f);f.write_text('{"events":["forged"]}');rejected=False
  try:assert_sha(f,expected,'observation')
  except BenchError:rejected=True
  record('reject_changed_observation_bytes',rejected,'Hash binding catches content changes even if identity fields were reused')
 result={'revision':REVISION,'controls':controls,'passed':sum(x['passed'] for x in controls),'total':len(controls),'all_passed':all(x['passed'] for x in controls)}
 pathlib.Path(output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 if not result['all_passed']:raise BenchError('Regrade adapter control failed')
 return result

def main():
 global ROOT,BASE,scoring,catalog,checks,execution_fingerprint,BenchError,safe_path
 ap=argparse.ArgumentParser();ap.add_argument('--evidence-root',default=str(ROOT));ap.add_argument('--baseline-package',default=str(BASE));ap.add_argument('--new-package',default=str(ROOT.parent/'counso-benchmark-recon-0.2'));ap.add_argument('--output-dir',required=True);ap.add_argument('--selftest-only',action='store_true');a=ap.parse_args();ROOT=pathlib.Path(a.evidence_root).resolve();BASE=pathlib.Path(a.baseline_package).resolve();dest=pathlib.Path(a.output_dir)
 sys.path.insert(0,str(BASE));scoring=importlib.import_module('counso_bench.scoring');catalog=importlib.import_module('counso_bench.catalog');checks=importlib.import_module('counso_bench.checks');execution_fingerprint=importlib.import_module('counso_bench.mock').execution_fingerprint;io=importlib.import_module('counso_bench.io');BenchError=io.BenchError;safe_path=io.safe_path
 if dest.exists():raise BenchError('Refuse to overwrite existing regrade output directory')
 dest.mkdir(parents=True);assert_sha(BASE/'provenance/file_manifest.json',BASE_MANIFEST,'Frozen baseline manifest');valid=catalog.validate_package(BASE)
 if not valid['valid']:raise BenchError('Frozen baseline changed: '+str(valid['errors']))
 helper,helper_path=load_helper(a.new_package);evaluate=make_evaluator(helper);control=selftest(evaluate,dest/'adapter-controls.json')
 if a.selftest_only:print(json.dumps(control,ensure_ascii=False));return
 exp=json.loads((ROOT/'evaluator/experiment.json').read_text())
 if len(exp['cells'])!=32 or any(c['status']!='SCORED' for c in exp['cells']):raise BenchError('Require complete 32-cell frozen baseline before regrade')
 fp=execution_fingerprint(BASE);scoring.evaluate=evaluate;summary=[]
 for cell in exp['cells']:
  sid=cell['scenario_id'];rawpath=ROOT/'evaluator/results'/cell['run_id']/'score.json';raw=json.loads(rawpath.read_text());output_dir=ROOT/'candidates'/cell['run_id']/'output';responsepath=output_dir/'response.json';runpath=rawpath.parent/'run.json';run=json.loads(runpath.read_text());response=json.loads(responsepath.read_text());obs=None
  assert_sha(responsepath,raw['response_sha256'],'Original response');assert_sha(runpath,raw['run_metadata_sha256'],'Original run metadata')
  for fixture in raw['fixture_hashes']:assert_sha(BASE/'fixtures'/fixture['path'],fixture['sha256'],'Original fixture')
  for artifact in raw['artifact_evidence']:
   if artifact['present']:assert_sha(safe_path(output_dir,artifact['path']),artifact['sha256'],'Original artifact')
  obs_path=None
  if cell.get('service_dir'):
   obs_path=ROOT/'evaluator'/pathlib.Path(cell['service_dir']).name/'observations.json';assert_sha(obs_path,raw['observation_file_sha256'],'Original observation');obs=json.loads(obs_path.read_text());verify_service_identity(obs,run,sid,fp)
  case=catalog.select(sid,BASE);contract=catalog.contracts(sid,BASE);newchecks=revised_checklist(contract['checks'],sid);report=scoring.score_response(case,newchecks,response,run,output_dir,BASE,obs)
  diffs=[];before={c['id']:c for c in raw['checks']}
  for c in report['checks']:
   old=before.get(c['id']);
   if old is None or old['state']!=c['state'] or old.get('critical')!=c.get('critical'):diffs.append({'check_id':c['id'],'before_state':old['state'] if old else 'NOT_PRESENT','after_state':c['state'],'before_critical':old.get('critical') if old else None,'after_critical':c.get('critical'),'reason':c['reason']})
  bindings={'baseline_manifest_sha256':BASE_MANIFEST,'original_execution_fingerprint':fp,'original_score_sha256':sha(rawpath),'response_sha256':sha(responsepath),'run_metadata_sha256':sha(runpath),'observation_file_sha256':sha(obs_path) if obs_path else None,'fixtures':raw['fixture_hashes'],'artifacts':raw['artifact_evidence'],'helper_sha256':sha(helper_path),'regrade_script_sha256':sha(__file__)}
  report.update({'grader_revision':REVISION,'task_revision':'FROZEN-RECON-0.1','evidence_binding':bindings,'corrections':diffs,'original_score_path':str(rawpath),'independent_ai_review_path':str(ROOT/'blind-review'/cell['blind_id']/'review-A.json'),'not_a_new_candidate_run':True,'human_review_status':'NO_REAL_HUMAN_REVIEW','full_external_action_audit':'NOT_AVAILABLE','additional_limit':'Zero-weight CSV shape observation preserves a real format defect without inventing a post-hoc quality weight; old semantic CSV contract and EUR scope remain UNKNOWN.'})
  p=dest/cell['run_id'];p.mkdir();(p/'score.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');summary.append({'run_id':cell['run_id'],'scenario_id':sid,'raw_score':raw['objective_score'],'regraded_score':report['objective_score'],'regraded_known_weight_score':report['objective_observed_score'],'known_weight':report['objective_known_weight'],'possible_weight':report['objective_possible_weight'],'unknown_checks':report['objective_unknown_checks'],'changed_checks':len(diffs),'known_failures':[c['id'] for c in report['checks'] if c['state']=='FAIL'],'score_path':str(p/'score.json')})
 (dest/'summary.json').write_text(json.dumps({'revision':REVISION,'run_count':len(summary),'candidate_reruns':0,'items':summary,'controls':{'passed':control['passed'],'total':control['total']}},ensure_ascii=False,indent=2)+'\n');print(json.dumps({'runs_regraded':len(summary),'output_dir':str(dest),'controls_passed':control['passed']},ensure_ascii=False))
if __name__=='__main__':main()
