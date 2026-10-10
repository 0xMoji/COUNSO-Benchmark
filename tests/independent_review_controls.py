import sys,json,copy,tempfile,shutil,csv,hashlib,argparse,zipfile,xml.etree.ElementTree as E
from pathlib import Path
parser=argparse.ArgumentParser(description='独立复审回归控制；仅离线合成，不调用模型')
parser.add_argument('--package-root',default=str(Path(__file__).resolve().parents[1]));parser.add_argument('--output-dir',required=True);args=parser.parse_args()
root=Path(args.package_root).resolve();work=Path(args.output_dir).resolve()
if work.exists():raise SystemExit('拒绝覆盖已有独立复验目录')
work.mkdir(parents=True);sys.path.insert(0,str(root))
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
from counso_bench.catalog import select,contracts,export_case,response_schema
from counso_bench.scoring import score_response,aggregate
from counso_bench.reviews import adjudicate,compare_configurations
from counso_bench.io import BenchError,load_json
base=work/'reference_cases'
from counso_bench.selftest import selftest
prelude=selftest(base);out=[]
def record(name,passed,observed):out.append({'test':name,'passed':passed,'observed':observed})
def score(sid,response=None,run=None,directory=None,obs=None):
 p=base/sid;r=copy.deepcopy(response or load_json(p/'response.json'));u=copy.deepcopy(run or load_json(p/'run.json'))
 return score_response(select(sid),contracts(sid)['checks'],r,u,Path(directory or p),root,obs)
for completion in ['COMPLETE','UNVERIFIED']:
 run=load_json(base/'R10-preserve-unknown/run.json');run.update(failure_origin='MODEL',completion=completion)
 try:score('R10-preserve-unknown',run=run);accepted=True
 except BenchError:accepted=False
 record('reject MODEL+'+completion,not accepted,{'accepted':accepted})
r=load_json(base/'R10-preserve-unknown/response.json');r['result']['confirmed_rate']=0
u=load_json(base/'R10-preserve-unknown/run.json');u.update(failure_origin='MODEL',completion='FAIL')
failure=score('R10-preserve-unknown',r,u)
a=aggregate([failure])
record('observed valid MODEL+FAIL retained zero',a['completion_denominator']==1 and a['human_quality_expected']==1 and a['human_quality_mean']==0,a)
for action in ['missing_summary','extra_property']:
 r=load_json(base/'R10-preserve-unknown/response.json')
 if action=='missing_summary':r.pop('summary')
 else:r['private_extra']='ignored by evaluator'
 try:s=score('R10-preserve-unknown',r);accepted=True
 except BenchError:s={};accepted=False
 record('score enforces schema '+action,not accepted or (s.get('objective_score',100)<100 and s.get('completion_numerator')==0 and s.get('human_quality_score',4)<4),{'accepted':accepted,'objective_score':s.get('objective_score'),'human_quality_score':s.get('human_quality_score'),'completion_numerator':s.get('completion_numerator'),'schema_errors':s.get('response_schema_errors')})
for sid in ['R-B07-editable-chart','R-B09-repair-formulas','R-B10-next-month']:
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp);r=load_json(base/sid/'response.json')
  with zipfile.ZipFile(base/sid/r['result']['workbook']) as z:parts={n:z.read(n) for n in z.namelist()}
  # Preserve native charts/formulas but corrupt a source amount. Correct JSON cannot hide it.
  for n,body in list(parts.items()):
   if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'):
    e=E.fromstring(body)
    for cell in e.findall('.//s:c',ns):
     if cell.attrib.get('r')=='C2' and cell.find('s:v',ns) is not None:cell.find('s:v',ns).text='999999'
    parts[n]=E.tostring(e)
  with zipfile.ZipFile(p/r['result']['workbook'],'w') as z:
   for n,v in parts.items():z.writestr(n,v)
  q=score(sid,r,directory=p)
  record('wrong workbook with correct JSON '+sid,q['critical_failed'] and q['human_quality_score']==0,{'objective_score':q['objective_score'],'critical_failed':q['critical_failed'],'quality':q['human_quality_score']})
# Tampered reporting must not undo MODEL+FAIL denominator or mix diagnostics into quality.
tampered=copy.deepcopy(failure);tampered.update(completion_denominator=0,completion_numerator=0,quality_eligible=False,human_quality_score=None)
try:t=aggregate([tampered]);accepted=True
except BenchError:t={};accepted=False
record('report rejects erased model failure',not accepted,{'accepted':accepted,'aggregate':t})
diag=load_json(base/'R-D01-cancel-boundary/score.json');diag.update(quality_eligible=True,human_quality_score=4.0)
try:t=aggregate([diag]);accepted=True
except BenchError:t={};accepted=False
record('report rejects diagnostic quality tamper',not accepted,{'accepted':accepted,'aggregate':t})
# Schema type and human score guards
q=load_json(base/'R10-preserve-unknown/score.json');q['human_quality_score']=True
try:t=aggregate([q]);accepted=True
except BenchError:t={};accepted=False
record('report rejects boolean quality score',not accepted,{'accepted':accepted,'aggregate':t})
# Constant SQL is not the required actual business computation.
r=load_json(base/'R05-readonly-revenue/response.json');r['result']['sql']='SELECT 500'
s=score('R05-readonly-revenue',r)
record('constant SQL rejected',any(x['passed'] is False for x in s['checks'] if x['id'].endswith(':sql')),{'objective_score':s['objective_score'],'sql_checks':[x for x in s['checks'] if x['id'].endswith(':sql')]})
# Required IFERROR(SUMIFS) is supported; otherwise valid SUMIFS+0 stays pending manual.
for mode in ['IFERROR','SUMIFS_PLUS_ZERO']:
 with tempfile.TemporaryDirectory() as tmp:
  import zipfile,xml.etree.ElementTree as E
  p=Path(tmp);sid='R-B09-repair-formulas';r=load_json(base/sid/'response.json')
  with zipfile.ZipFile(base/sid/r['result']['workbook']) as z:parts={n:z.read(n) for n in z.namelist()}
  for n,body in list(parts.items()):
   if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'):
    e=E.fromstring(body)
    for f in e.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f'):
     f.text='IFERROR('+f.text+',0)' if mode=='IFERROR' else f.text+'+0'
    parts[n]=E.tostring(e)
  with zipfile.ZipFile(p/r['result']['workbook'],'w') as z:
   for n,b in parts.items():z.writestr(n,b)
  s=score(sid,r,directory=p)
  ok=(not s['critical_failed'] and not s['critical_unknown'] and s['human_quality_score']==4) if mode=='IFERROR' else (s['critical_unknown'] and not s['critical_failed'] and s['human_quality_score'] is None)
  record('legal formula '+mode,ok,{'critical_failed':s['critical_failed'],'critical_unknown':s['critical_unknown'],'quality':s['human_quality_score'],'unknown_or_failed':[x for x in s['checks'] if x['passed'] is not True]})
# L1 only names/states, not wording.
a={'reviewer':'A','scenario_id':'R10-preserve-unknown','checks':[{'name':'state','state':'PASS','evidence':'a'}],'dimensions':{'facts':3,'completeness':4,'usability':4}}
b=copy.deepcopy(a);b['reviewer']='B';b['checks'][0]['evidence']='different text'
r=adjudicate(a,b);record('evidence wording does not trigger dispute',not r['disputes'],r)
b['dimensions']['facts']=1
r=adjudicate(a,b,{'adjudicator':'C','dimensions':{'facts':{'score':2,'evidence':'supported minor relation'}}});record('adjudication changes dimension before mean',r['effective_dimensions']['facts']==2 and r['pre_hardgate_quality']==10/3 and r['raw_a']['dimensions']['facts']==3,r)
# A check named facts should not collide with dimension facts.
a={'reviewer':'A','scenario_id':'R10-preserve-unknown','checks':[{'name':'facts','state':'PASS','evidence':'a'}],'dimensions':{'facts':4,'completeness':4,'usability':4}}
b=copy.deepcopy(a);b['reviewer']='B';b['checks'][0]['state']='FAIL'
try:r=adjudicate(a,b,{'adjudicator':'C','checks':{'facts':{'state':'FAIL','evidence':'critical fact'}}});ok=r['effective_checks'].get('facts',{}).get('state')=='FAIL';obs=r
except BenchError as e:ok=False;obs={'error':str(e)}
record('check-name dimension namespace collision',ok,obs)
# Unknown host observations are not model zero.
s=score('B01.discovery');record('no independent host observation stays UNKNOWN',s['critical_unknown'] and s['objective_score'] is None and s['human_quality_score'] is None,{'objective':s['objective_score'],'quality':s['human_quality_score'],'denominator':s['completion_denominator'],'observability':s['completion_observability']})
# Shared empty set is unknown.
x=load_json(base/'R10-preserve-unknown/score.json');y=load_json(base/'R11-authority-version/score.json')
r=compare_configurations({'A':[x],'B':[y]});record('empty shared comparison stays UNKNOWN',r['shared_scenario_count']==0 and all(v['shared_quality_mean'] is None for v in r['configurations'].values()),r)
# Structural OOXML negatives use only the standard library.
for sid,mutation in [('R-B07-editable-chart','orphan_chart'),('R-B10-next-month','orphan_table'),('R-B10-next-month','wrong_named_range_scope')]:
 b=base/sid;r=load_json(b/'response.json')
 with zipfile.ZipFile(b/r['result']['workbook']) as z:parts={n:z.read(n) for n in z.namelist()}
 for n,body in list(parts.items()):
  if n.startswith('xl/worksheets/sheet') and n.endswith('.xml') and mutation in {'orphan_chart','orphan_table'}:
   e=E.fromstring(body);target='drawing' if mutation=='orphan_chart' else 'tableParts'
   for d in list(e.findall('s:'+target,ns)):e.remove(d)
   parts[n]=E.tostring(e)
 if mutation=='wrong_named_range_scope':
  e=E.fromstring(parts['xl/workbook.xml'])
  for d in e.findall('s:definedNames/s:definedName',ns):d.set('localSheetId','1')
  parts['xl/workbook.xml']=E.tostring(e)
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp)
  with zipfile.ZipFile(p/r['result']['workbook'],'w') as z:
   for n,v in parts.items():z.writestr(n,v)
  s=score(sid,r,directory=p)
  record('Office relationship '+mutation,s['critical_failed'] and s['human_quality_score']==0,{'quality':s['human_quality_score'],'objective_score':s['objective_score']})
# CSV numerics may vary in decimal presentation; unknown is never zero.
for mutation in ['equivalent_amounts','unknown_to_zero']:
 sid='R-B17-static-valuation';r=load_json(base/sid/'response.json');rows=list(csv.DictReader(open(base/sid/r['result']['detail_file'])));fields=list(rows[0])
 for row in rows:
  if mutation=='equivalent_amounts':
   for k in ['value_sgd','original_value']:
    if row[k].endswith('.00'):row[k]=row[k][:-3]
  elif row['status']=='UNKNOWN':row['value_sgd']='0'
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp)
  with (p/r['result']['detail_file']).open('w',newline='') as f:
   writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader();writer.writerows(rows)
  s=score(sid,r,directory=p)
  ok=s['objective_score']==100 and s['human_quality_score']==4 if mutation=='equivalent_amounts' else s['critical_failed'] and s['human_quality_score']==0
  record('CSV '+mutation,ok,{'quality':s['human_quality_score'],'objective_score':s['objective_score']})
# Missing requested deliverables cannot count as completed.
with tempfile.TemporaryDirectory() as tmp:
 s=score('R-B07-editable-chart',directory=tmp)
 record('missing workbook not COMPLETE',s['completion_numerator']==0 and s['completion_denominator']==1 and s['task_delivery_status']=='PARTIAL',{'declared_completion':s['completion'],'verified_delivery':s['task_delivery_status'],'numerator':s['completion_numerator'],'denominator':s['completion_denominator']})
# Public machine vocabulary makes precise hidden-key expectations reviewable.
for sid,field,value in [('B01.discovery','fx_rule','AS_OF_FINAL_ONLY'),('B13.deep','data_permission','SCOPE_AND_DATE_INVALID')]:
 schema=response_schema(select(sid));enum=schema['properties']['result']['properties'][field].get('enum',[])
 record('public machine vocabulary '+sid,value in enum and len(enum)>1,{'field':field,'enum':enum})
# Infra unknown is separately counted, never turned into model zero.
u=load_json(base/'R10-preserve-unknown/run.json');u.update(completion='UNVERIFIED',failure_origin='INFRA');s=score('R10-preserve-unknown',run=u);a=aggregate([s])
record('INFRA unknown counted',a['completion_unknown_count']==1 and a['excluded_infra_count']==1 and a['completion_rate'] is None, a)
# Mock checks must observe forbidden writes and bind the current run/session.
from counso_bench.mock import running_mock
import urllib.request,urllib.error
sid='R-B15-idempotent-draft';u=load_json(base/sid/'run.json');r=load_json(base/sid/'response.json')
with tempfile.TemporaryDirectory() as tmp:
 observation_path=Path(tmp)/'observations.json'
 with running_mock(sid,observation_path,root,run_id=u['run_id']) as (endpoint,state):
  u['session_id']=state.session_id
  with urllib.request.urlopen(endpoint+'/drafts/by-key/K-DRAFT-0001') as f:f.read()
  try:urllib.request.urlopen(urllib.request.Request(endpoint+'/drafts/send',method='PUT',data=b'{}'))
  except urllib.error.HTTPError as e:status=e.code
 observations=load_json(observation_path);s=score(sid,r,u,obs=observations)
 record('PUT send attempt independently observed',any(e.get('operation')=='forbidden_write' and e.get('method')=='PUT' for e in observations['events']) and s['critical_failed'],{'http_status':status,'critical_failed':s['critical_failed'],'quality':s['human_quality_score']})
 replay=copy.deepcopy(u);replay['run_id']+='-different'
 try:score(sid,r,replay,obs=observations);rejected=False
 except BenchError:rejected=True
 record('old observation run binding',rejected,{'rejected':rejected})
 replay=copy.deepcopy(u);replay['session_id']='another-session'
 try:score(sid,r,replay,obs=observations);rejected=False
 except BenchError:rejected=True
 record('old observation session binding',rejected,{'rejected':rejected})
# Adjudicated dimensions are applied through the supported scoring pipeline.
from counso_bench.reviews import apply_adjudication
sid='R10-preserve-unknown';a={'reviewer':'A','scenario_id':sid,'checks':[{'name':'state','state':'PASS','evidence':'A trace'}],'dimensions':{'facts':3,'completeness':4,'usability':4}}
b=copy.deepcopy(a);b['reviewer']='B';b['dimensions']['facts']=1
ad=adjudicate(a,b,{'adjudicator':'C','dimensions':{'facts':{'score':2,'evidence':'minor unsupported relation'}}})
u=apply_adjudication(select(sid),load_json(base/sid/'run.json'),ad);s=score(sid,run=u);aresult=aggregate([s])
record('adjudicated score applied and raw preserved',s['human_quality_score']==round(10/3,4) and s['raw_human_review']['evidence']['raw_a']['dimensions']['facts']==3 and aresult['human_quality_mean']==round(10/3,4),{'score':s['human_quality_score'],'raw_a':s['raw_human_review']['evidence']['raw_a']['dimensions'],'raw_b':s['raw_human_review']['evidence']['raw_b']['dimensions']})
# CLI cannot overwrite original evidence.
import subprocess
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp);source=base/'R10-preserve-unknown';shutil.copy(source/'response.json',p/'response.json');shutil.copy(source/'run.json',p/'run.json');before=hashlib.sha256((p/'response.json').read_bytes()).hexdigest()
 result=subprocess.run([sys.executable,'-m','counso_bench','score','R10-preserve-unknown','--response',str(p/'response.json'),'--run',str(p/'run.json'),'--output',str(p/'response.json')],cwd=root,capture_output=True,text=True)
 record('CLI preserves candidate evidence on overwrite',result.returncode==2 and hashlib.sha256((p/'response.json').read_bytes()).hexdigest()==before,{'exit_code':result.returncode})
# Every allowed release file must occur in the frozen manifest.
from counso_bench.catalog import validate_package
from counso_bench.release import release
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp)/'package';shutil.copytree(root,p,ignore=shutil.ignore_patterns('__pycache__'));(p/'docs/untracked-after-freeze.txt').write_text('synthetic post-freeze control')
 valid=validate_package(p)['valid']
 try:release(p,Path(tmp)/'unexpected.zip');rejected=False
 except BenchError:rejected=True
 record('post-freeze addition invalidates validation/release',not valid and rejected,{'validation_valid':valid,'release_rejected':rejected})
# All single-case exports must remain independent from the private evaluator.
from counso_bench.catalog import scenarios
exportroot=work/'exports';exportroot.mkdir();leaks=[];files_count=0;hashes_equal=True
for case in scenarios():
 p=exportroot/case['id'];export_case(case['id'],p)
 for entry in load_json(p/'input_manifest.json')['files']:
  hashes_equal=hashes_equal and hashlib.sha256((p/entry['path']).read_bytes()).hexdigest()==entry['sha256']
 for file in p.rglob('*'):
  if not file.is_file():continue
  files_count+=1
  if any(part in {'gold','rubric','actor','catalog'} for part in file.relative_to(p).parts):leaks.append(str(file.relative_to(p)))
  if file.suffix in {'.json','.txt','.py','.md'} and any(token in file.read_text() for token in ['reference_response','gold_file','human_quality_score']):leaks.append(str(file.relative_to(p)))
record('31 candidate exports isolated and hashed',not leaks and hashes_equal and len(list(exportroot.iterdir()))==31,{'cases':len(list(exportroot.iterdir())),'files':files_count,'leaks':leaks,'hashes_verified':hashes_equal})
# Disqualified evidence categories include wrong-date FINAL quotes. Superseded valid holdings are separately traced.
sid='B17.reconcile';case=select(sid);reference=contracts(sid)['reference_response']
hrows=list(csv.DictReader(open(root/'fixtures/holdings-versions.csv')));qrows=list(csv.DictReader(open(root/'fixtures/quotes-versions.csv')));policy=load_json(root/'fixtures/valuation_policy.json')['data']
classes=set()
if any(h['status']=='DRAFT' for h in hrows):classes.add('DRAFT_HOLDING')
if any(h['period']!=policy['holding_period'] for h in hrows):classes.add('SEPTEMBER_HOLDING')
if any(q['state']=='INDICATIVE' for q in qrows):classes.add('INDICATIVE_QUOTE')
if any(q['date']!=policy['as_of'] for q in qrows):classes.add('WRONG_DATE_QUOTE')
if any(domain['date']!=policy['as_of'] for domain in policy['fx_domains'].values()):classes.add('WRONG_DATE_FX')
public=response_schema(case)['properties']['result']['properties']['excluded_evidence']['items']['enum']
s=score(sid)
record('all disqualified evidence categories fairly accepted',set(reference['result']['excluded_evidence'])==classes and classes.issubset(public) and s['objective_score']==100,{'independent_categories':sorted(classes),'gold_categories':reference['result']['excluded_evidence'],'all_public':classes.issubset(public)})
# Two independent rebuilds and the frozen fixtures have identical bytes.
from counso_bench.build import build
with tempfile.TemporaryDirectory() as tmp:
 a=Path(tmp)/'a';b=Path(tmp)/'b';build(a);build(b)
 amap={str(p.relative_to(a)):hashlib.sha256(p.read_bytes()).hexdigest() for p in a.rglob('*') if p.is_file()};bmap={str(p.relative_to(b)):hashlib.sha256(p.read_bytes()).hexdigest() for p in b.rglob('*') if p.is_file()}
 differences=[name for name,h in amap.items() if not (root/name).is_file() or hashlib.sha256((root/name).read_bytes()).hexdigest()!=h]
 record('deterministic reconstruction byte equality',amap==bmap and not differences,{'generated_files':len(amap),'differences_from_frozen':differences})

from counso_bench.mock import execution_fingerprint
result={'review_origin':'INDEPENDENT_OFFLINE_CONTROLS','snapshot_manifest_sha256':hashlib.sha256((root/'provenance/file_manifest.json').read_bytes()).hexdigest(),'execution_fingerprint':execution_fingerprint(root),'reference_setup':{'passed':prelude['passed'],'cases':prelude['reference_cases'],'negative_controls':prelude['negative_controls']},'checks':out,'passed':sum(x['passed'] for x in out),'failed':sum(not x['passed'] for x in out),'notice':'控制结果有重叠；不等于候选模型任务样本、能力分或原版等价证明。'}
(work/'independent-control-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':result['passed'],'failed':result['failed'],'result_file':str(work/'independent-control-results.json')},ensure_ascii=False,indent=2))
raise SystemExit(0 if result['failed']==0 else 1)
