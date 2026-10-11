"""UI objective intake and trusted browser-score adapter; never runs model code."""
from __future__ import annotations
import json,pathlib,time
from . import VERSION
from .scoring import utc,sha,validate,summarize

def delivered_path(root,name):
    if not isinstance(name,str) or not name or "\\" in name:raise ValueError('Artifact path must be relative POSIX')
    rel=pathlib.PurePosixPath(name)
    if rel.is_absolute() or any(part in {'.','..'} for part in name.split('/')):raise ValueError('Artifact path escapes or aliases output')
    current=root
    for part in rel.parts:
        current=current/part
        if current.is_symlink():raise ValueError('Artifact file or intermediate directory is a symlink')
    if not current.resolve().is_relative_to(root.resolve()):raise ValueError('Artifact escaped output')
    return current

def package_delivery_errors(case,out,required,declared):
    errors=[];paths={}
    for name in set(required)|set(declared):
        try:
            p=delivered_path(out,name)
            if not p.is_file():errors.append('Declared/required artifact missing: '+name)
            else:paths[name]=p
        except (ValueError,OSError) as exc:errors.append(str(exc)+': '+str(name))
    pub=case/'public/inputs/frame'
    manifest=paths.get('frame/manifest.json')
    if manifest:
        try:
            actual=json.loads(manifest.read_text());expected=json.loads((pub/'manifest.json').read_text())
            if not isinstance(actual,dict):raise ValueError('Manifest must be object')
            for key in ('version','uiEntryPoint','functions','databases'):
                # These exact machine fields are publicly supplied; prose description is free.
                if actual.get(key)!=expected.get(key):errors.append('Public manifest field changed/missing: '+key)
        except (ValueError,OSError,RecursionError) as exc:errors.append('Invalid manifest: '+str(exc))
    for name in required:
        p=paths.get(name);source=pub/name.removeprefix('frame/')
        if not p or name=='frame/manifest.json':continue
        if name=='frame/index.tsx':
            try:
                if not p.read_text(encoding='utf-8').strip():errors.append('Required UI source is empty')
            except (ValueError,OSError) as exc:errors.append('Required UI source unreadable: '+str(exc))
        elif source.is_file():
            try:
                if name.endswith('.json'):
                    if json.loads(p.read_text())!=json.loads(source.read_text()):errors.append('Supplied source data changed: '+name)
                elif p.read_bytes().strip()!=source.read_bytes().strip():errors.append('Supplied declared function/source changed: '+name)
            except (ValueError,OSError,RecursionError) as exc:errors.append('Supplied source unreadable: '+name+': '+str(exc))
    return errors

def objective_ui(case_dir,output_dir,run):
    start=utc();mono=time.monotonic();case=pathlib.Path(case_dir);out=pathlib.Path(output_dir)
    gold=json.loads((case/'evaluator/gold.json').read_text());schema=json.loads((case/'public/response_schema.json').read_text())
    if run.get('case_id')!=gold['case_id'] or run.get('benchmark_version')!=VERSION:raise ValueError('UI run/case/version binding mismatch')
    errors=[];response={}
    try:
        raw=json.loads(delivered_path(out,'response.json').read_text(encoding='utf-8'),parse_constant=lambda x:(_ for _ in ()).throw(ValueError('Nonfinite JSON constant')))
        errors=validate(raw,schema);response=raw if isinstance(raw,dict) else {}
    except (OSError,ValueError,RecursionError) as exc:errors=[type(exc).__name__+': '+str(exc)]
    declared=response.get('artifacts');declared=declared if isinstance(declared,list) and all(isinstance(x,str) for x in declared) else []
    missing=[]
    package_errors=package_delivery_errors(case,out,gold['required_artifacts'],declared)
    undeclared=[name for name in gold['required_artifacts'] if name not in declared]
    delivery=not errors and not package_errors and not undeclared
    ambiguous=run.get('failure_origin') in {'INFRA_AMBIGUOUS','UNKNOWN','PROTOCOL_CONTAMINATION'}
    checks=[]
    for c in gold['checks']:
        e0=c.get('evidence_mode')=='delivery_static'
        state='UNKNOWN' if ambiguous or not e0 else 'PASS' if delivery else 'FAIL'
        reason='Actual browser interaction and bound observer receipt not yet supplied' if not e0 else 'Untrusted/ambiguous execution origin: missing output cannot be attributed to the candidate' if ambiguous else 'Public response and required package paths delivered' if delivery else 'Required delivery/interface missing: '+str({'schema_errors':errors,'package_errors':package_errors,'undeclared':undeclared})
        checks.append({**c,'state':state,'reason':reason,'critical':bool(c.get('critical')) and not e0,'safety':False})
    result=summarize(checks)
    if ambiguous:
        result.update(quality_lower=0,quality_upper=100,quality_complete=None,evidence_coverage=0)
    files={str(p.relative_to(out)):sha(p) for p in out.rglob('*') if p.is_file() and not p.is_symlink()}
    result.update(benchmark_version=VERSION,case_id=gold['case_id'],checks=checks,schema_errors=errors,package_delivery_errors=package_errors,task_delivery_complete=None if ambiguous else delivery,execution_mode='frames_proxy',actual_browser_validation='UNKNOWN',validation_start_at=start,validation_end_at=utc(),validation_duration_ns=int((time.monotonic()-mono)*1e9),all_required_check_coverage=sum(c['state']!='UNKNOWN' for c in checks)/len(checks),evidence={'response_sha256':files.get('response.json'),'artifact_sha256':files,'observations_sha256':None},run_failure_origin=run.get('failure_origin'),execution_contaminated=run.get('failure_origin')=='PROTOCOL_CONTAMINATION')
    return result

def normalize_browser_score(raw,objective,run):
    """Only evaluator-registered UI receipts may produce ``raw``.

    Callers import from a verified CI artifact or a registered independent review,
    not a candidate path. No purported trust bit in candidate JSON is accepted.
    """
    checks=[{**c,'reason':'; '.join(r for t in c.get('tests',[]) for r in t.get('assertion_reasons',[]))} for c in raw['checks']]
    ambiguous=run.get('failure_origin') in {'INFRA_AMBIGUOUS','UNKNOWN','PROTOCOL_CONTAMINATION'}
    lo,hi=raw['score_interval'];exact=raw['exact_score']
    if ambiguous:lo,hi,exact=(0,0,None) if raw['safety_proofs'] else (0,100,None)
    return {**objective,'checks':checks,'quality_lower':lo,'quality_upper':hi,'quality_complete':exact,'evidence_coverage':(100-raw['unknown_weight'])/100 if not ambiguous else 0,'all_required_check_coverage':sum(c['state']!='UNKNOWN' for c in checks)/len(checks) if not ambiguous else 0,'critical_failures':sorted({p['atom_id'] for p in raw['critical_proofs']}),'safety_failures':sorted({p['atom_id'] for p in raw['safety_proofs']}),'unresolved_critical_checks':[c['id'] for c in checks if c.get('critical_pending')],'unknown_check_ids':[c['id'] for c in checks if c['state']=='UNKNOWN'],'task_delivery_complete':raw['complete'] if not ambiguous else None,'actual_browser_validation':'BOUND_ACTUAL_OBSERVER_RECEIPTS','ui_acceptance':raw}
