"""Coordinator-owned UI batch preparation and service-registered receipt import.

This module never starts a browser or model. JSON trust flags are not credentials.
"""
from __future__ import annotations
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, Mapping
import argparse, copy, datetime, difflib, json, re, shutil, subprocess
from . import VERSION
from .ui_gate import objective_ui, normalize_browser_score
from .ui_scoring import TrustedBrowserReceipt, canonical_sha256, load_ui_contract, score_ui_acceptance

REPOSITORY = '0xMoji/counso-benchmark-reconstructed'
BRANCH = 'eval/counso-ui-probe'
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
PHASES = ('reference-create', 'dashboard-mutations', 'reference-edit', 'planner-mutations')
BATCH_KEYS = {'schema_version','origin','benchmark_version','repository','branch','browser','limits','authority_files','execution','phases','subjects','content_files','preparation'}
SUBJECT_KEYS = {'subject_id','role','case_id','kind','case_dir','output_dir','package_dir','package_files','package_sha256','bundle_sha256','response_sha256','objective_path','delivery_receipt_path','configs','test_matrix','expected','mutation'}
CONFIG_KEYS = {'packageDir','fixtureDir','kind','artifactDir','interfacePath','scopePath','caseId','fixtureId','fixtureHashes','candidatePackageSha256','testIds','fixtureReplacements','actionTimeoutMs','observerModule','observerSha256','hostMetadata','registeredHealthControl','browserChannel','expectedChromeVersion'}

def phase_for_subject(subject_id: str) -> str:
    if subject_id=='ref-dashboard': return 'reference-create'
    if subject_id=='ref-planner': return 'reference-edit'
    if subject_id.startswith('d-'): return 'dashboard-mutations'
    if subject_id.startswith('p-'): return 'planner-mutations'
    raise ValueError('Unregistered subject phase')

def digest(p: Path) -> str: return sha256(p.read_bytes()).hexdigest()
def read_json(p: Path) -> Any: return json.loads(p.read_text(encoding='utf-8'), parse_constant=lambda x: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
def write_json(p: Path, x: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(x, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
def relative(root: Path, p: Path) -> str: return p.relative_to(root).as_posix()
def safe_path(root: Path, name: str, *, require_file: bool = False) -> Path:
    if not isinstance(name,str) or not name or '\\' in name or any(x in ('','.','..') for x in name.split('/')) or PurePosixPath(name).is_absolute(): raise ValueError('Unsafe relative path')
    p=root
    for part in name.split('/'):
        p=p/part
        if p.is_symlink(): raise ValueError('Symlink forbidden')
    if not p.resolve().is_relative_to(root.resolve()): raise ValueError('Path escapes registered root')
    if require_file and not p.is_file(): raise ValueError('Declared file missing: '+name)
    return p

def inventory(root: Path) -> dict[str,str]:
    result={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise ValueError('Symlink forbidden in declared files')
        if p.is_file(): result[relative(root,p)]=digest(p)
    return result

def exact_keys(obj: Any, keys: set[str], label: str) -> None:
    if not isinstance(obj,dict) or set(obj)!=keys: raise ValueError(label+' keys/schema mismatch')

def validate_batch(batch: Any, root: Path, *, verify_files: bool=True) -> dict[str,Any]:
    exact_keys(batch,BATCH_KEYS,'Batch')
    if batch['schema_version']!=1 or batch['origin']!='COORDINATOR_REGISTERED_UI_BATCH' or batch['benchmark_version']!=VERSION or batch['repository']!=REPOSITORY or batch['branch']!=BRANCH: raise ValueError('Batch authority/version mismatch')
    if batch['execution']!={'github_job':'controls','repo_prefix':'platform-screen-control/','active_workflow':'.github/workflows/counso-platform-screen-control.yml','authority_workflow':'.github/workflows/ui-acceptance.yml','setup_npm_seconds':60,'precheck_seconds':60}: raise ValueError('Fixed single-job execution mapping mismatch')
    if batch['browser']!={'channel':'chrome','expected_version':'154.0.8037.97','binary_sha256':'ACTUAL_RECORDED_NOT_YET_FROZEN'}: raise ValueError('Browser contract changed')
    if batch['limits']!={'max_job_seconds':600,'phase_seconds':{'reference-create':90,'dashboard-mutations':90,'reference-edit':120,'planner-mutations':90},'max_subjects':8,'max_configs':16,'no_candidate_execution':True}: raise ValueError('Batch ceiling changed')
    if set(batch['phases'])!=set(PHASES) or not isinstance(batch['subjects'],list) or len(batch['subjects'])>8 or len(batch['subjects'])!=8: raise ValueError('Bounded control batch required')
    for field in ('authority_files','content_files'):
        if not isinstance(batch[field],dict) or not batch[field]: raise ValueError('Missing declared file inventory')
        for name,h in batch[field].items():
            if not HEX.fullmatch(h or ''): raise ValueError('Invalid file hash')
            p=safe_path(root,name,require_file=verify_files)
            if verify_files and digest(p)!=h: raise ValueError('Hash mismatch: '+name)
    if verify_files:
        actual_content={'ci-inputs/'+name:h for name,h in inventory(root/'ci-inputs').items() if name not in ('current-batch.json','current-batch.sha256')}
        if actual_content!=batch['content_files']: raise ValueError('Exhaustive coordinator input inventory mismatch')
    seen=set(); count=0
    for subject in batch['subjects']:
        exact_keys(subject,SUBJECT_KEYS,'Subject')
        sid=subject['subject_id']
        if not isinstance(sid,str) or not re.fullmatch(r'[a-z0-9-]+',sid) or sid in seen: raise ValueError('Subject ID')
        seen.add(sid)
        if subject['role'] not in ('REFERENCE','MUTATION') or subject['kind'] not in ('dashboard','planner') or subject['case_id'] not in ('G-UI-CREATE-M1','G-UI-EDIT-M1'): raise ValueError('Control subjects only')
        expected_case='G-UI-CREATE-M1' if subject['kind']=='dashboard' else 'G-UI-EDIT-M1'
        if subject['case_id']!=expected_case or subject['case_dir']!='dataset/cases/'+expected_case: raise ValueError('Typed case join mismatch')
        if subject['output_dir']!='ci-inputs/packages/'+sid or subject['package_dir']!=subject['output_dir']+'/frame': raise ValueError('Fixed package boundary')
        for field in ('package_sha256','bundle_sha256','response_sha256'):
            if not HEX.fullmatch(subject[field] or ''): raise ValueError('Missing bound digest')
        if canonical_sha256(subject['package_files'])!=subject['package_sha256']: raise ValueError('Package digest definition mismatch')
        if verify_files and inventory(safe_path(root,subject['package_dir']))!=subject['package_files']: raise ValueError('Exhaustive static package inventory mismatch')
        if subject['role']=='REFERENCE' and subject['mutation'] is not None or subject['role']=='MUTATION' and not isinstance(subject['mutation'],dict): raise ValueError('Control origin mismatch')
        if subject['role']=='REFERENCE':
            if sid!=('ref-dashboard' if subject['kind']=='dashboard' else 'ref-planner') or subject['expected']!={'reference_all_applicable':'PASS'}: raise ValueError('Reference control identity')
        else:
            spec=next((m for m in MUTATIONS if m['id']==sid),None)
            if spec is None or subject['kind']!=spec['kind'] or subject['expected']!={'mutation_atoms':spec['atoms'],'required_state':'FAIL','unseen_only':sid=='d-primary-hardcoded'}: raise ValueError('Mutation control identity/expected atoms')
            if verify_files:
                frame=root/subject['case_dir']/'evaluator/reference/frame';source=(frame/'index.tsx').read_text();data=read_json(frame/('dataset.json' if subject['kind']=='dashboard' else 'resources.json'))
                if (root/subject['package_dir']/'index.tsx').read_text()!=mutate(spec,source,data): raise ValueError('Mutation is not the predeclared reference-source transform')
        fixture_ids=[]
        for entry in subject['configs']:
            exact_keys(entry,{'config_path','config_sha256','fixture_id','fixture_files','fixture_sha256','test_ids','test_plan_sha256'},'Config registration')
            config_path=entry['config_path']
            if not config_path.startswith('ci-inputs/configs/'+sid+'/'): raise ValueError('Fixed config boundary')
            p=safe_path(root,config_path,require_file=verify_files)
            if verify_files:
                if digest(p)!=entry['config_sha256']: raise ValueError('Config hash mismatch')
                config=read_json(p);exact_keys(config,CONFIG_KEYS,'Config')
                if config['packageDir']!=subject['package_dir'] or config['candidatePackageSha256']!=subject['package_sha256'] or config['caseId']!=subject['case_id'] or config['kind']!=subject['kind'] or config['fixtureId']!=entry['fixture_id']: raise ValueError('Config typed join mismatch')
                if config['observerModule']!='runtime/acceptance-observer.mjs' or config['observerSha256']!=batch['authority_files'].get(config['observerModule']): raise ValueError('Fixed observer required')
                if config['interfacePath']!='runtime/ui-interface.json' or config['scopePath']!='runtime/ui-scope.json': raise ValueError('Fixed contract required')
                health=config['registeredHealthControl'];exact_keys(health,{'packageDir','packageSha256','bundleSha256','fixtureDir','fixtureSha256','hostMetadata','baselineTestId','baselineTestPlanSha256'},'Health control')
                reference=next(x for x in batch['subjects'] if x['subject_id']==('ref-dashboard' if subject['kind']=='dashboard' else 'ref-planner'))
                baseline=('D-'+entry['fixture_id']+'-baseline') if subject['kind']=='dashboard' else ('P-'+entry['fixture_id']+'-draft_baseline')
                rconfig=next(x for x in reference['configs'] if x['fixture_id']==entry['fixture_id'])
                if health!={'packageDir':reference['package_dir'],'packageSha256':reference['package_sha256'],'bundleSha256':reference['bundle_sha256'],'fixtureDir':config['fixtureDir'],'fixtureSha256':entry['fixture_sha256'],'hostMetadata':config['hostMetadata'],'baselineTestId':baseline,'baselineTestPlanSha256':rconfig['test_plan_sha256'][baseline]}: raise ValueError('Health reference registration mismatch')
                if config['testIds']!=entry['test_ids'] or config['artifactDir']!='ci-results/'+phase_for_subject(sid)+'/'+sid+'/'+entry['fixture_id'] or config['browserChannel']!='chrome' or config['expectedChromeVersion']!=batch['browser']['expected_version']: raise ValueError('Fixed execution config changed')
                if set(config['hostMetadata'])!=set(entry['fixture_files']): raise ValueError('Host metadata keys mismatch')
                for meta in config['hostMetadata'].values():
                    exact_keys(meta,{'revision','canWrite'},'Host file metadata')
                    if not isinstance(meta['revision'],str) or not re.fullmatch(r'[1-9][0-9]*',meta['revision']) or type(meta['canWrite']) is not bool: raise ValueError('Opaque revision/capability invalid')
                fixture=safe_path(root,config['fixtureDir'])
                actual={name:digest(safe_path(fixture,name,require_file=True)) for name in entry['fixture_files']}
                if actual!=entry['fixture_files'] or canonical_sha256({'files':actual,'host_metadata':config['hostMetadata']})!=entry['fixture_sha256'] or config['fixtureHashes']!={entry['fixture_id']:entry['fixture_sha256']}: raise ValueError('Fixture typed hash mismatch')
            fixture_ids.append(entry['fixture_id']);count+=1
        if fixture_ids!=['primary','unseen_same_schema']: raise ValueError('Every control must bind both fixture replays')
    if count>16: raise ValueError('Config limit')
    if seen!={'ref-dashboard','ref-planner',*(m['id'] for m in MUTATIONS)}: raise ValueError('Only the six predeclared mutation identities are authorized')
    expected_jobs={'reference-create':['ref-dashboard'],'dashboard-mutations':sorted(m['id'] for m in MUTATIONS if m['kind']=='dashboard'),'reference-edit':['ref-planner'],'planner-mutations':sorted(m['id'] for m in MUTATIONS if m['kind']=='planner')}
    if batch['phases']!=expected_jobs: raise ValueError('Fixed control allocation mismatch')
    return batch

MUTATIONS = [
 {'id':'d-wrong-chart-geometry','kind':'dashboard','atoms':['D-E2'],'tests':['baseline'],'meaning':'Preserve correct labels and numeric metrics while inverting actual count-driven chart glyph lengths.'},
 {'id':'d-primary-hardcoded','kind':'dashboard','atoms':['D-E2'],'tests':['baseline'],'meaning':'Embed the original public snapshot instead of using same-schema unseen source.'},
 {'id':'d-old-response','kind':'dashboard','atoms':['D-H1'],'tests':['late_result','late_error'],'meaning':'Allow older function result/error to overwrite latest selected scope.'},
 {'id':'p-cumulative-overflow','kind':'planner','atoms':['P-M1'],'tests':['cumulative_capacity','cumulative_demand'],'meaning':'Remove cumulative capacity and demand rejection only.'},
 {'id':'p-false-saved','kind':'planner','atoms':['P-M2'],'tests':['save'],'meaning':'Write with a deliberately stale opaque revision, then falsely claim that draft saved.'},
 {'id':'p-lateack-clears-edits','kind':'planner','atoms':['P-H3'],'tests':['late_ack'],'meaning':'Apply older submitted snapshot to local edits when its acknowledgement arrives.'},
]

def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old)!=1: raise ValueError('Mutation anchor is not unique: '+old[:80])
    return source.replace(old,new,1)

def mutate(spec: Mapping[str,Any], source: str, data: Any) -> str:
    sid=spec['id']
    if sid=='d-wrong-chart-geometry': return replace_once(source,'height:Math.max(2,80*count/maxCount)','height:Math.max(2,80*(maxCount-count)/maxCount)')
    if sid=='d-primary-hardcoded':
        literal=json.dumps(data,separators=(',',':'),ensure_ascii=False)
        source=replace_once(source,'const statuses =', 'const embeddedOriginalSnapshot = '+literal+';\nconst statuses =')
        return replace_once(source,'function accept(s:any,scope:Scope) { source.current=s;', 'function accept(s:any,scope:Scope) { s=embeddedOriginalSnapshot;source.current=s;')
    if sid=='d-old-response':
        source=replace_once(source,'      if(id!==requestId.current)return;','      // deliberate: accept stale function result')
        return replace_once(source,"} catch(e:any) {if(id!==requestId.current)return;setPhase('ERROR');", "} catch(e:any) {setPhase('ERROR');")
    if sid=='p-cumulative-overflow':
        source=replace_once(source,"  if(resourceTotals[key]>roster.available_minutes-roster.committed_minutes)return 'Cumulative planned minutes exceed residual resource/day capacity.';",'  // deliberate: no cumulative capacity guard')
        return replace_once(source,"  if(workTotals[a.work_item_id]>work.remaining_minutes)return 'Cumulative planned minutes exceed remaining work.';",'  // deliberate: no cumulative demand guard')
    if sid=='p-false-saved':
        # Keep real RPC, duplicate-save hold/release, and readback plan operational.
        # On this controlled path the host receives a write but does not commit it.
        return replace_once(source,"   const result:any=await writeFile('./draft.json',JSON.stringify(submitted),{revision:submittedRevision,contentType:'application/json'});", "   const result:any=await writeFile('./draft.json',JSON.stringify(submitted),{revision:submittedRevision+'0',contentType:'application/json'});\n   setAuthority(submitted);authorityRef.current=submitted;setSaveState('Submitted draft saved');return;")
    if sid=='p-lateack-clears-edits':
        return replace_once(source,'{setAuthority(confirmed.draft);authorityRef.current=confirmed.draft;setRevision(confirmed.revision);', '{edit(submitted);setAuthority(confirmed.draft);authorityRef.current=confirmed.draft;setRevision(confirmed.revision);')
    raise ValueError('Undeclared mutation')

def node_preflight(root: Path, package: str, kind: str, fixtures: list[dict[str,Any]]) -> dict[str,Any]:
    # Imported modules are evaluator-owned. Static candidate compilation is not execution.
    script="""import fs from 'node:fs/promises'; import {compileFrame} from './runtime/compiler.mjs';import {buildTestPlan,canonicalSha256} from './runtime/acceptance-driver.mjs';const x=JSON.parse(process.argv[1]);const b=await compileFrame(x.package);const fixtures=[];for(const f of x.fixtures){const source=JSON.parse(await fs.readFile(f.dir+'/'+(x.kind==='dashboard'?'dataset.json':'resources.json'),'utf8'));const draft=x.kind==='planner'?JSON.parse(await fs.readFile(f.dir+'/draft.json','utf8')):null;fixtures.push({id:f.id,plans:buildTestPlan(x.kind,source,draft,f.id).map(t=>({...t,test_plan_sha256:canonicalSha256(t)}))})}console.log(JSON.stringify({bundle_sha256:b.evidence.bundle_sha256,fixtures}));"""
    result=subprocess.run(['node','--input-type=module','-e',script,json.dumps({'package':package,'kind':kind,'fixtures':fixtures})],cwd=root,capture_output=True,text=True,check=True)
    return json.loads(result.stdout)

def delivery_receipt(objective: Mapping[str,Any], subject: Mapping[str,Any], authority: Mapping[str,str]) -> dict[str,Any]:
    prefix='D' if subject['kind']=='dashboard' else 'P'; aid=prefix+'-E0'
    c=next(c for c in objective['checks'] if c['id']==aid)
    ref='objective:'+subject['subject_id'];response=objective['evidence']['response_sha256']
    return {'schema_version':1,'origin':'TRUSTED_DELIVERY_OBSERVER','execution':'delivery_static','receipt_id':subject['subject_id']+':delivery','task_kind':subject['kind'],'test_id':subject['subject_id']+'-delivery','candidate_package_sha256':subject['package_sha256'],'response_present':response is not None,'response_sha256':response,'case_id':subject['case_id'],'interface_sha256':authority['runtime/ui-interface.json'],'scope_sha256':authority['runtime/ui-scope.json'],'observer_sha256':authority['runtime/acceptance-observer.mjs'],'observations':[{'kind':'delivery_checks','capture_method':'evaluator_objective_files','evidence_ref':ref,'artifact_sha256':objective['evidence']['artifact_sha256']}],'assertions':[{'atom_id':aid,'state':c['state'],'oracle':'independent_delivery_schema','predicate':'Public response schema and required unchanged source/package delivered','expected':True,'observed':objective['task_delivery_complete'],'evidence_refs':[ref],'delivery_observed':True,'reason':c['reason']}]}

def authority_inventory(root: Path) -> dict[str,str]:
    files=[]
    for p in (root/'runtime').rglob('*'):
        parts=p.relative_to(root/'runtime').parts
        if any(s in ('node_modules','.build','__pycache__') for s in parts) or p.name=='RUNTIME_BUILD_MANIFEST.json': continue
        if p.is_file(): files.append(p)
    files += list((root/'platform_screen').glob('*.py'))
    files += [root/'VERSION',root/'runtime/ui-scope.json',root/'docs/UI_ACCEPTANCE_PLAN.json',root/'.github/workflows/ui-acceptance.yml']
    for case in ('G-UI-CREATE-M1','G-UI-EDIT-M1'):
        files += [p for p in (root/'dataset/cases'/case).rglob('*') if p.is_file()]
    return {relative(root,p):digest(p) for p in sorted(set(files))}

def prepare(root: Path) -> dict[str,Any]:
    root=root.resolve(); target=root/'ci-inputs'
    if any(target.iterdir()) if target.exists() else False: raise ValueError('ci-inputs already contains a preparation; preserve it before an explicit fresh rebind')
    target.mkdir(exist_ok=True)
    contract=load_ui_contract(root/'runtime/ui-interface.json',root/'runtime/ui-scope.json')
    authority=authority_inventory(root); subjects=[]
    specs=[{'id':'ref-dashboard','kind':'dashboard','role':'REFERENCE'},{'id':'ref-planner','kind':'planner','role':'REFERENCE'}]+[{**m,'role':'MUTATION'} for m in MUTATIONS]
    for spec in specs:
        sid=spec['id'];kind=spec['kind'];case_id='G-UI-CREATE-M1' if kind=='dashboard' else 'G-UI-EDIT-M1';case=root/'dataset/cases'/case_id
        output=target/'packages'/sid;frame=output/'frame';shutil.copytree(case/'evaluator/reference/frame',frame)
        shutil.copyfile(case/'evaluator/reference_response.json',output/'response.json')
        mutation=None
        if spec['role']=='MUTATION':
            source=(frame/'index.tsx').read_text(); data=read_json(frame/('dataset.json' if kind=='dashboard' else 'resources.json'));changed=mutate(spec,source,data);(frame/'index.tsx').write_text(changed)
            patch=''.join(difflib.unified_diff(source.splitlines(True),changed.splitlines(True),fromfile='frozen-reference/index.tsx',tofile='declared-mutation/index.tsx'))
            patch_path=target/'mutations'/f'{sid}.patch';patch_path.parent.mkdir(parents=True,exist_ok=True);patch_path.write_text(patch)
            mutation={**spec,'reference_source_sha256':sha256(source.encode()).hexdigest(),'mutated_source_sha256':sha256(changed.encode()).hexdigest(),'patch_path':relative(root,patch_path),'patch_sha256':digest(patch_path),'candidate_derived':False}
        package_files=inventory(frame)
        fixtures=[]
        for fixture_id,source_dir,metadata_file in [('primary',case/'evaluator/reference/frame','initial_host_files.json'),('unseen_same_schema',case/'evaluator/unseen/frame','unseen_host_files.json')]:
            fd=target/'fixtures'/sid/fixture_id;fd.mkdir(parents=True)
            for name in contract['interface']['tasks'][kind]['source_files']: shutil.copyfile(source_dir/name,fd/name)
            fixtures.append({'id':fixture_id,'dir':relative(root,fd),'host_metadata':read_json(case/'evaluator'/metadata_file)})
        preflight=node_preflight(root,relative(root,frame),kind,fixtures)
        subject={'subject_id':sid,'role':spec['role'],'case_id':case_id,'kind':kind,'case_dir':relative(root,case),'output_dir':relative(root,output),'package_dir':relative(root,frame),'package_files':package_files,'package_sha256':canonical_sha256(package_files),'bundle_sha256':preflight['bundle_sha256'],'response_sha256':digest(output/'response.json'),'objective_path':f'ci-inputs/objective/{sid}.json','delivery_receipt_path':f'ci-inputs/objective/{sid}.delivery.json','configs':[],'test_matrix':[],'expected':{'reference_all_applicable':'PASS'} if spec['role']=='REFERENCE' else {'mutation_atoms':spec['atoms'],'required_state':'FAIL','unseen_only':sid=='d-primary-hardcoded'},'mutation':mutation}
        for f,compiled in zip(fixtures,preflight['fixtures'],strict=True):
            plans=compiled['plans'];file_hashes=inventory(root/f['dir']);fh=canonical_sha256({'files':file_hashes,'host_metadata':f['host_metadata']})
            selected=plans if spec['role']=='REFERENCE' else []
            if spec['role']=='MUTATION': selected=[t for t in plans if any(t['test_id']==('D' if kind=='dashboard' else 'P')+'-'+f['id']+'-'+suffix for suffix in spec['tests'])]
            replacements={}
            if kind=='dashboard':
                data=read_json(root/f['dir']/'dataset.json');data['snapshot_revision']+='-updated-control';data['tickets'][0]['remaining_minutes']+=15;replacements['updated_same_schema']={'dataset.json':data}
            else:
                d=read_json(root/f['dir']/'draft.json');d['allocations'][0]['minutes']+=15;replacements['advanced_authority']={'draft.json':d}
            config={'packageDir':subject['package_dir'],'fixtureDir':f['dir'],'kind':kind,'artifactDir':f'ci-results/{phase_for_subject(sid)}/{sid}/{f["id"]}','interfacePath':'runtime/ui-interface.json','scopePath':'runtime/ui-scope.json','caseId':case_id,'fixtureId':f['id'],'fixtureHashes':{f['id']:fh},'candidatePackageSha256':subject['package_sha256'],'testIds':[t['test_id'] for t in selected],'fixtureReplacements':replacements,'actionTimeoutMs':5000,'observerModule':'runtime/acceptance-observer.mjs','observerSha256':authority['runtime/acceptance-observer.mjs'],'hostMetadata':f['host_metadata'],'browserChannel':'chrome','expectedChromeVersion':'154.0.8037.97'}
            reference=subject if spec['role']=='REFERENCE' else next(x for x in subjects if x['subject_id']==('ref-dashboard' if kind=='dashboard' else 'ref-planner'))
            baseline=('D-'+f['id']+'-baseline') if kind=='dashboard' else ('P-'+f['id']+'-draft_baseline')
            baseline_plan=next(t for t in plans if t['test_id']==baseline)
            config['registeredHealthControl']={'packageDir':reference['package_dir'],'packageSha256':reference['package_sha256'],'bundleSha256':reference['bundle_sha256'],'fixtureDir':f['dir'],'fixtureSha256':fh,'hostMetadata':f['host_metadata'],'baselineTestId':baseline,'baselineTestPlanSha256':baseline_plan['test_plan_sha256']}
            cp=target/'configs'/sid/(f['id']+'.json');write_json(cp,config)
            subject['configs'].append({'config_path':relative(root,cp),'config_sha256':digest(cp),'fixture_id':f['id'],'fixture_files':file_hashes,'fixture_sha256':fh,'test_ids':config['testIds'],'test_plan_sha256':{t['test_id']:t['test_plan_sha256'] for t in selected}})
            # Full matrix intentionally keeps unrun atoms UNKNOWN for narrow mutations.
            subject['test_matrix'] += [{k:v for k,v in t.items() if k in ('test_id','fixture_id','atom_ids','requirements','schedule_id','test_plan_sha256')} for t in plans]
        objective=objective_ui(case,output,{'case_id':case_id,'benchmark_version':VERSION,'failure_origin':'NONE'})
        if objective['task_delivery_complete'] is not True: raise ValueError('Reference-derived control delivery invalid: '+sid)
        write_json(root/subject['objective_path'],objective);write_json(root/subject['delivery_receipt_path'],delivery_receipt(objective,subject,authority));subjects.append(subject)
    content={relative(root,target/name):h for name,h in inventory(target).items()}
    batch={'schema_version':1,'origin':'COORDINATOR_REGISTERED_UI_BATCH','benchmark_version':VERSION,'repository':REPOSITORY,'branch':BRANCH,'browser':{'channel':'chrome','expected_version':'154.0.8037.97','binary_sha256':'ACTUAL_RECORDED_NOT_YET_FROZEN'},'limits':{'max_job_seconds':600,'phase_seconds':{'reference-create':90,'dashboard-mutations':90,'reference-edit':120,'planner-mutations':90},'max_subjects':8,'max_configs':16,'no_candidate_execution':True},'authority_files':authority,'execution':{'github_job':'controls','repo_prefix':'platform-screen-control/','active_workflow':'.github/workflows/counso-platform-screen-control.yml','authority_workflow':'.github/workflows/ui-acceptance.yml','setup_npm_seconds':60,'precheck_seconds':60},'phases':{'reference-create':['ref-dashboard'],'dashboard-mutations':sorted(m['id'] for m in MUTATIONS if m['kind']=='dashboard'),'reference-edit':['ref-planner'],'planner-mutations':sorted(m['id'] for m in MUTATIONS if m['kind']=='planner')},'subjects':subjects,'content_files':content,'preparation':{'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'OFFLINE_STATIC_ONLY','browser_functionality':'UNKNOWN','native_counso':'UNKNOWN','model_trials':0,'package_digest_definition':'SHA256(canonical sorted relative-package-file SHA256 map); response independently bound','fixture_digest_definition':'SHA256(canonical {files: sorted declared source-file raw-byte SHA256 map, host_metadata: revision/canWrite})'}}
    validate_batch(batch,root);write_json(target/'current-batch.json',batch);(target/'current-batch.sha256').write_text(digest(target/'current-batch.json')+'\n');return batch

@dataclass(frozen=True)
class CIArtifactRegistration:
    """Construct only by coordinator after trusted publisher/service observation.

    Not a signature and not parsable from a candidate's document or artifact.
    The independently downloaded artifact root-manifest digest is required.
    """
    repository: str
    commit_sha: str
    run_id: str
    phase: str
    batch_sha256: str
    artifact_manifest_sha256: str
    service_observation: str
    run_attempt: str = '1'
    def __post_init__(self):
        if self.repository!=REPOSITORY or not COMMIT.fullmatch(self.commit_sha) or not self.run_id.isdecimal() or self.phase not in PHASES or not HEX.fullmatch(self.batch_sha256) or not HEX.fullmatch(self.artifact_manifest_sha256) or not self.service_observation.strip() or not self.run_attempt.isdecimal() or int(self.run_attempt)<1: raise ValueError('Independent CI service registration incomplete')


def verify_observation_files(payload: Mapping[str,Any], receipt_path: str, files: Mapping[str,str], artifact_root: Path) -> None:
    for ob in payload.get('observations',[]):
        if 'file' in ob and 'sha256' in ob:
            op=str(PurePosixPath(receipt_path).parent/ob['file']);safe_path(artifact_root,op,require_file=True)
            if files.get(op)!=ob['sha256']: raise ValueError('Receipt evidence file hash mismatch')


def import_registered_artifact(root: Path, artifact_root: Path, registration: CIArtifactRegistration) -> dict[str,Any]:
    if not isinstance(registration,CIArtifactRegistration): raise TypeError('Candidate JSON cannot register evaluator trust')
    root=root.resolve();artifact_root=artifact_root.resolve();batch_path=root/'ci-inputs/current-batch.json'
    if digest(batch_path)!=registration.batch_sha256: raise ValueError('Independent batch digest mismatch')
    batch=validate_batch(read_json(batch_path),root)
    mp=safe_path(artifact_root,'batch-receipt.json',require_file=True)
    if digest(mp)!=registration.artifact_manifest_sha256: raise ValueError('Independently registered artifact root digest mismatch')
    manifest=read_json(mp)
    if manifest.get('origin')!='TRUSTED_CI_BATCH_ENTRY' or manifest.get('batch_sha256')!=registration.batch_sha256 or manifest.get('github_commit')!=registration.commit_sha or manifest.get('github_run_id')!=registration.run_id or manifest.get('repository')!=registration.repository or manifest.get('phase')!=registration.phase or manifest.get('github_run_attempt')!=registration.run_attempt or manifest.get('github_job')!='controls': raise ValueError('CI service/artifact typed join mismatch')
    file_map=manifest.get('files')
    if not isinstance(file_map,dict) or not file_map: raise ValueError('Artifact inventory unavailable')
    actual=inventory(artifact_root);actual.pop('batch-receipt.json',None)
    if actual!=file_map: raise ValueError('Raw artifact exhaustive hash mismatch')
    imported=[];contract=load_ui_contract(root/'runtime/ui-interface.json',root/'runtime/ui-scope.json')
    for sid in batch['phases'][registration.phase]:
        subject=next(s for s in batch['subjects'] if s['subject_id']==sid);registered={};health_registered={};health_bindings={};sessions=[];bundle_hashes=set();fixtures={e['fixture_id']:e['fixture_sha256'] for e in subject['configs']}
        for entry in subject['configs']:
            cm=next((c for c in manifest.get('configs',[]) if c.get('config_path')==entry['config_path']),None)
            if cm is None: continue # Interrupted configs stay explicitly UNKNOWN.
            runtime_path=safe_path(artifact_root,cm.get('manifest_path','UNAVAILABLE'))
            if not runtime_path.is_file(): continue
            if cm.get('config_sha256')!=entry['config_sha256']: raise ValueError('CI config join mismatch')
            runtime=read_json(safe_path(artifact_root,cm['manifest_path'],require_file=True))
            config=read_json(root/entry['config_path']);health_config=config['registeredHealthControl']
            bp=runtime.get('instrumentation',{}).get('browser_provenance',{})
            ci_binding={'ci_job_id':registration.run_id+':'+registration.run_attempt+':'+manifest['github_job'],'github_run_id':registration.run_id,'compiler_sha256':batch['authority_files']['runtime/compiler.mjs'],'dependencies_sha256':batch['authority_files']['runtime/package-lock.json'],'browser_binary_sha256':bp.get('binary_sha256'),'runner_image_sha256':canonical_sha256(bp.get('runner_image',{}))}
            for health_entry in runtime.get('health_controls',[]):
                hrp=str(PurePosixPath(cm['artifact_dir'])/health_entry['artifact_relative_path']);hp=safe_path(artifact_root,hrp,require_file=True)
                if file_map.get(hrp)!=health_entry['sha256']: raise ValueError('Independently registered health receipt hash mismatch')
                receipt=TrustedBrowserReceipt.from_observer_file(hp,file_map[hrp]);payload=receipt.payload;hid=payload['receipt_id']
                if health_entry.get('health_id')!=hid or health_entry.get('receipt_id')!=hid or health_entry.get('task_kind')!=subject['kind'] or payload.get('candidate_package_sha256')!=health_config['packageSha256'] or payload.get('candidate_bundle_sha256')!=health_config['bundleSha256'] or payload.get('fixture_sha256')!=entry['fixture_sha256'] or payload.get('test_id')!=health_config['baselineTestId'] or payload.get('test_plan_sha256')!=health_config['baselineTestPlanSha256']: raise ValueError('Fixed reference/source health typed join mismatch')
                hb={'case_id':subject['case_id'],'candidate_package_sha256':health_config['packageSha256'],'candidate_bundle_sha256':health_config['bundleSha256'],'fixtures':{entry['fixture_id']:entry['fixture_sha256']},'session_ids':[payload['session_id']],'test_plan_sha256':health_config['baselineTestPlanSha256'],'interface_sha256':batch['authority_files']['runtime/ui-interface.json'],'scope_sha256':batch['authority_files']['runtime/ui-scope.json'],'observer_sha256':batch['authority_files']['runtime/acceptance-observer.mjs'],**ci_binding}
                ht=next(t for t in subject['test_matrix'] if t['test_id']==health_config['baselineTestId'])
                if any(payload.get(k)!=v for k,v in ci_binding.items()) or any(health_entry.get('binding',{}).get(k)!=v for k,v in hb.items()) or any(health_entry.get('test_spec',{}).get(k)!=v for k,v in ht.items()): raise ValueError('Same-job health provenance differs from registered authority')
                verify_observation_files(payload,hrp,file_map,artifact_root)
                health_registered[hid]=receipt;health_bindings[hid]={'task_kind':subject['kind'],'binding':hb,'test_spec':ht}
            for r in runtime.get('receipts',[]):
                # Ignore absolute process paths; only bounded artifact-relative paths join.
                rp=str(PurePosixPath(cm['artifact_dir'])/r['artifact_relative_path']);p=safe_path(artifact_root,rp,require_file=True)
                if file_map.get(rp)!=r['sha256']: raise ValueError('Independent receipt file join mismatch')
                receipt=TrustedBrowserReceipt.from_observer_file(p,file_map[rp]);payload=receipt.payload
                if payload.get('test_id') not in entry['test_ids'] or payload.get('test_plan_sha256')!=entry['test_plan_sha256'].get(payload.get('test_id')): raise ValueError('Unregistered browser action plan')
                if payload.get('candidate_package_sha256')!=subject['package_sha256'] or payload.get('candidate_bundle_sha256')!=subject['bundle_sha256']: raise ValueError('Same static package/bundle replay not established')
                if any(payload.get(k)!=v for k,v in ci_binding.items()): raise ValueError('Actual receipt same-job provenance mismatch')
                verify_observation_files(payload,rp,file_map,artifact_root)
                rid=payload['receipt_id']
                if rid in registered: raise ValueError('Duplicate receipt identity')
                registered[rid]=receipt;sessions.append(payload['session_id']);bundle_hashes.add(payload['candidate_bundle_sha256'])
        objective=objective_ui(root/subject['case_dir'],root/subject['output_dir'],{'case_id':subject['case_id'],'benchmark_version':VERSION,'failure_origin':'NONE'})
        # Recomputed by frozen Python evaluator; no candidate supplied E0 enters.
        e0=delivery_receipt(objective,subject,batch['authority_files']);registered[e0['receipt_id']]=TrustedBrowserReceipt.from_observer_payload(e0,canonical_sha256(e0))
        binding={'case_id':subject['case_id'],'candidate_package_sha256':subject['package_sha256'],'candidate_bundle_sha256':subject['bundle_sha256'],'fixtures':fixtures,'session_ids':sessions,'interface_sha256':batch['authority_files']['runtime/ui-interface.json'],'scope_sha256':batch['authority_files']['runtime/ui-scope.json'],'observer_sha256':batch['authority_files']['runtime/acceptance-observer.mjs'],'response_present':True,'response_sha256':subject['response_sha256']}
        matrix=subject['test_matrix']+[{'test_id':e0['test_id'],'atom_ids':[('D' if subject['kind']=='dashboard' else 'P')+'-E0'],'requirements':[]}]
        raw=score_ui_acceptance(subject['kind'],contract['interface']['tasks'][subject['kind']]['atoms'],binding=binding,trusted_receipts=registered,test_matrix=matrix,trusted_health_controls=health_registered,health_control_bindings=health_bindings)
        checks={c['id']:c for c in raw['checks']}
        if subject['role']=='REFERENCE': control_state='PASS' if raw['complete'] else 'FAIL' if raw['fail_weight'] else 'UNKNOWN'
        else:
            selected_ids={tid for c in subject['configs'] if not subject['expected']['unseen_only'] or c['fixture_id']=='unseen_same_schema' for tid in c['test_ids']}
            expected=[t['state'] for aid in subject['expected']['mutation_atoms'] for t in checks[aid]['tests'] if t['test_id'] in selected_ids]
            control_state='PASS' if expected and all(state=='FAIL' for state in expected) else 'UNKNOWN' if not expected or 'UNKNOWN' in expected else 'FAIL'
        imported.append({'subject_id':sid,'role':subject['role'],'control_certification':control_state,'expected':subject['expected'],'same_bundle_verified':bundle_hashes=={subject['bundle_sha256']},'score':raw,'normalized':normalize_browser_score(raw,objective,{'failure_origin':'NONE'}),'model_clocks':'NOT_A_MODEL_TRIAL','ci_browser_clocks':{c['config_path']:c.get('started_utc') for c in manifest.get('configs',[]) if '/'+sid+'/' in c.get('config_path','')}})
    return {'origin':'COORDINATOR_SERVICE_REGISTERED_IMPORT','registration':registration.__dict__,'controls':imported,'certification':'PASS' if imported and all(c['control_certification']=='PASS' for c in imported) else 'UNKNOWN' if any(c['control_certification']=='UNKNOWN' for c in imported) else 'FAIL','candidate_trials':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['prepare','verify']);parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);args=parser.parse_args()
    batch=prepare(args.root) if args.command=='prepare' else validate_batch(read_json(args.root/'ci-inputs/current-batch.json'),args.root)
    print(json.dumps({'subjects':len(batch['subjects']),'configs':sum(len(s['configs']) for s in batch['subjects']),'mode':'OFFLINE_STATIC_ONLY','batch_sha256':digest(args.root/'ci-inputs/current-batch.json'),'browser_functionality':'UNKNOWN'}))
if __name__=='__main__':main()
