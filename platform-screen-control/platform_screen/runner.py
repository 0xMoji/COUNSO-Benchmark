"""Evaluator-side run registration, immutable receipts and candidate export.

Native candidate invocation is owned by the coordinating assistant. This module
does not call paid APIs. Submission/acceptance/completion receipt are coordinator
observations, not provider clocks or pure model latency.
"""
from __future__ import annotations
import datetime, hashlib, json, os, pathlib, shutil, signal, subprocess, sys, time, uuid
from . import VERSION
from .build import export, verify
from .scoring import score as general_score, sha
from .ui_gate import objective_ui,delivered_path

def score(case,out,run,observations=None,review=None):
    gold=json.loads((pathlib.Path(case)/"evaluator/gold.json").read_text())
    if gold.get("ui_task_type"):
        if review is not None:raise ValueError("UI final scoring requires evaluator-registered browser receipts, not General prose review")
        return objective_ui(case,out,run)
    return general_score(case,out,run,observations,review)

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def atomic(p,v):
    t=p.with_suffix(p.suffix+'.tmp');t.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');t.replace(p)

def register(bundle,run_root,case_id,config,phase='MAIN',replicate=1):
    bundle=pathlib.Path(bundle);run_root=pathlib.Path(run_root);f=verify(bundle)
    registry=json.loads((bundle/'dataset/registry.json').read_text());entry=next(x for x in registry['entries'] if x['case_id']==case_id)
    expected_split={'MAIN':'main','CALIBRATION':'calibration','HOLDOUT':'holdout','REPEAT':'main'}[phase]
    if entry['split']!=expected_split:raise ValueError('Case split/phase mismatch')
    id='trial-'+uuid.uuid4().hex[:16];root=run_root/'trials'/id;root.mkdir(parents=True,exist_ok=False);public=root/'public';out=root/'output';out.mkdir();case=bundle/'dataset/cases'/case_id;export(case,public)
    cfg={'g61':'gpt-6.1-sol','g6':'gpt-6-sol','luna':'gpt-6-luna','g56':'gpt-5.6-sol'};model,effort=config.rsplit('_',1)
    if model not in cfg or effort not in {'medium','max'}:raise ValueError('Not a preregistered authorized configuration')
    if not (run_root/'keeper_ready.json').exists():raise RuntimeError('Start and verify the persistent evaluator keeper session first')
    heartbeat=json.loads((run_root/'keeper_heartbeat.json').read_text())
    if (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(heartbeat['at'])).total_seconds()>3:raise RuntimeError('Evaluator keeper heartbeat is stale; restore the persistent session before proceeding')
    run={'run_id':id,'benchmark_version':VERSION,'case_id':case_id,'family':entry['family'],'domain':entry['domain'],'difficulty':entry['difficulty'],'phase':phase,'replicate':replicate,'config':config,'requested_model':cfg[model],'requested_effort':effort,'exact_backend_snapshot':'UNKNOWN','actual_effort_independently_confirmed':'UNKNOWN','tokens':'UNKNOWN','cost':'UNKNOWN','execution_fingerprint':f['execution_fingerprint'],'public_input_sha256':entry['public_input_sha256'],'required_artifacts':entry['required_artifacts'],'service_required':bool(entry.get('service_required')),'input_isolation':'INSTRUCTION_RESTRICTED_SHARED_HOST_NOT_OS_VERIFIED','candidate_shell_tool_timing':'UNKNOWN','status':'PREPARED','created_at':utc(),'run_origin':'NEW_NATIVE_AGENT','no_paid_external_api':True}
    if entry.get('service_required'):
        session=uuid.uuid4().hex;run['session_id']=session;state=root/'service';ipc=root/'ipc';state.mkdir()
        atomic(public/'inputs/endpoint.json',{'ipc_dir':str(ipc),'session_id':session,'transport':'PER_RUN_SYNTHETIC_FILE_IPC'})
    atomic(root/'run.json',run)
    deadline=time.monotonic()+15
    while not (root/'keeper_started.json').exists() or (entry.get('service_required') and not (root/'service/ready.json').exists()):
        if (root/'keeper_error.json').exists() or time.monotonic()>deadline:raise RuntimeError('Persistent keeper/service did not acknowledge trial preparation')
        time.sleep(.05)
    prompt=f"Complete the task described in {public}/prompt.txt. Read response_schema.json and grading_contract.json in that same directory. Your input access is limited to that public directory, and your writable deliverable directory is {out}. Complete this task within this single native candidate agent: do not spawn or delegate to subagents, and do not invoke any other LLM/model service. You may use local file/code tools and ordinary installed libraries. Do not use Cua or other remote desktop/browser tools. For Frame tasks generate the requested static React/TSX package; the evaluator separately runs actual browser interactions against the supplied contract. Do not install arbitrary dependencies or execute supplied function/backend entrypoints. If supplied, invoke the synthetic service only through inputs/mock_client.py; its transport files are used by the client and are not a material-discovery route. Do not read any evaluator/gold/other-trial directory, repository code, parent notes or previous candidate output. Do not use connected personal plugins, external networks, real accounts, or send anything externally. This is a synthetic Counso-related platform office/Frames-proxy task. Native platform deployment is not observed; do not claim you published a live Counso Frame. Follow supplied business policies and the user's requested scope. Put response.json at the output root and every requested artifact or package file at its exact publicly declared relative path under that output directory. Do not ask the coordinator for hidden answers. If a true blocker remains, still deliver the safe complete portion and state it clearly. Do not tune your output to prior model results. When finished, return a short factual completion note; include no model/config labels."
    (root/'candidate_prompt.txt').write_text(prompt+'\n')
    return {'run_id':id,'run_path':str(root/'run.json'),'model':run['requested_model'],'effort':effort,'prompt':prompt,'case_id':case_id}

def mark(run_path,event,value=None):
    p=pathlib.Path(run_path);r=json.loads(p.read_text());r[event+'_at']=utc()
    if value is not None:r[event]=value
    if event=='submitted':r['status']='RUNNING'
    if event=='accepted':r['tool_request_accepted']=True
    atomic(p,r);return r

def receive(bundle,run_path,raw_final_text,terminal='COMPLETE'):
    p=pathlib.Path(run_path);r=json.loads(p.read_text());root=p.parent;out=root/'output'
    if r.get('status') not in {'RUNNING','PREPARED'}:raise ValueError('Already received; do not overwrite evidence')
    r['candidate_completion_notification_received_at']=utc();r['candidate_completed_at']='UNKNOWN';r['provider_started_at']='UNKNOWN';r['provider_queue_seconds']='UNKNOWN';r['first_token_at']='UNKNOWN';r['artifact_received_at']=utc();r['candidate_terminal']=terminal
    r['failure_origin']='NONE' if terminal=='COMPLETE' else 'PROTOCOL_CONTAMINATION' if terminal=='EXECUTION_CONTAMINATED' else 'INFRA_AMBIGUOUS' if terminal in {'COORDINATOR_TIMEOUT','INFRA_FAILURE','CANCELLED_UNOBSERVED'} else 'MODEL' if terminal=='PROVED_MODEL_FAILURE' else 'UNKNOWN'
    raw=root/'raw_final_response.txt';raw.write_text(raw_final_text,encoding='utf-8');r['raw_final_response_sha256']=sha(raw)
    r['artifact_sha256']={str(f.relative_to(out)):sha(f) for f in out.rglob('*') if f.is_file() and not f.is_symlink()}
    (root/'stop.flag').touch()
    if (root/'file_observations.json').exists():
        file_obs=json.loads((root/'file_observations.json').read_text());r['first_parseable_response_observed_at']=file_obs['first_parseable_response_observed_at'];r['first_required_files_observed_at']=file_obs['first_required_files_observed_at'];r['file_appearance_is_validated_delivery']=False
    # A trusted receipt binds the current evaluator observation file before scoring.
    observations=None
    if (root/'service/observations.json').is_file():
        observations=json.loads((root/'service/observations.json').read_text());receipt=root/'service/observations_received.json';atomic(receipt,observations);r['observations_received_sha256']=sha(receipt)
    r['status']='RECEIVED';atomic(p,r)
    scoring=score(pathlib.Path(bundle)/'dataset/cases'/r['case_id'],out,r,observations)
    atomic(root/'score-objective.json',scoring);r['status']='OBJECTIVE_SCORED';r['score_path']=str(root/'score-objective.json');r['validation_start_at']=scoring['validation_start_at'];r['validation_end_at']=scoring['validation_end_at'];atomic(p,r)
    # Write-protect delivered artifacts against accidental later mutation. Shared
    # host ownership means this is operational preservation, not OS isolation.
    for f in out.rglob('*'):
        if f.is_symlink():continue
        if f.is_file():f.chmod(0o444)
        elif f.is_dir():f.chmod(0o555)
    out.chmod(0o555);raw.chmod(0o444)
    return scoring

def make_blind(bundle,run_path,destination):
    p=pathlib.Path(run_path);r=json.loads(p.read_text());b=pathlib.Path(destination)
    if b.exists():raise FileExistsError('Blind sample already exists')
    b.mkdir(parents=True);case=pathlib.Path(bundle)/'dataset/cases'/r['case_id'];shutil.copytree(case/'public',b/'input')
    endpoint=b/'input/inputs/endpoint.json'
    if endpoint.exists():endpoint.unlink()
    # Never dereference a candidate-created link while making reviewer inputs.
    shutil.copytree(p.parent/'output',b/'output',symlinks=True)
    (b/'output').chmod(0o755)
    for f in (b/'output').rglob('*'):
        if f.is_dir() and not f.is_symlink():f.chmod(0o755)
    invalid_links=[]
    for f in (b/'output').rglob('*'):
        if f.is_symlink():
            invalid_links.append({'artifact_path':str(f.relative_to(b/'output')),'rejected_link_target':os.readlink(f)});f.unlink()
    if invalid_links:atomic(b/'invalid_artifact_links.json',invalid_links)
    for f in b.rglob('*'):
        if f.is_file():f.chmod(0o644)
        elif f.is_dir():f.chmod(0o755)
    if (p.parent/'service/observations_received.json').exists():
        obs=json.loads((p.parent/'service/observations_received.json').read_text());docs=json.loads((case/'evaluator/service.json').read_text())['documents'];read={e['argument'].get('source_id') for e in obs['events'] if e['operation']=='read' and e['ok']};(b/'sources').mkdir()
        for d in docs:(b/'sources'/(d['source_id']+'.txt')).write_text(d['title']+'\n'+d['text'])
        atomic(b/'observed_read_source_ids.json',sorted(read))
        safe_obs={'case_id':obs['case_id'],'events':[{k:v for k,v in e.items() if k not in {'request_id','service_start_at','service_end_at','service_duration_ns'}} for e in obs['events']]};atomic(b/'service_events.json',safe_obs)
    obj=json.loads((p.parent/'score-objective.json').read_text());atomic(b/'objective_checks.json',{'case_id':r['case_id'],'checks':obj['checks'],'schema_errors':obj['schema_errors'],'task_delivery_complete':obj['task_delivery_complete']})
    atomic(b/'review_contract.json',{'case_id':r['case_id'],'response_sha256':obj['evidence']['response_sha256'],'observations_sha256':obj['evidence']['observations_sha256'],'artifact_sha256':obj['evidence']['artifact_sha256'],'manual_checks':[{k:v for k,v in c.items() if k in {'id','target','weight','scope','critical','review_resolvable','value_contract','semantic_review_scope','response_field_contracts','service_value_contract','table_value_contracts','column_value_contracts','edit_value_contracts','chart_value_contracts','representation_contract','columns'}} for c in json.loads((case/'evaluator/gold.json').read_text())['checks'] if c['kind'] in {'MANUAL_REVIEW','CRITICAL_CONTRADICTIONS'} or c.get('review_resolvable') in {'header_equivalence','semantic_field'}],'review_origin':'INDEPENDENT_AI_ASSISTED_NOT_HUMAN','rules':'Use PASS/FAIL/UNKNOWN with concrete file/page/claim evidence. Permit a tie. Judge factual support and usability to task requirements, not length or style preference. Review observed mock payloads as delivered work too: invitation draft recipients/body must match requested meeting facts and truthful tentative/unsent state. Critical contradictions require a proved false material amount/entity/period/approval/completion claim; stylistic/ordinary defects do not activate that gate. Semantic-field/artifact review resolves only designated semantic UNKNOWN by supplied-source/delivered-field or artifact meaning, with evidence, source_refs and response_refs identifying the actual scored field or file; do not guess undeclared locale or select an interpretation solely because it matches gold; a critical FAIL additionally requires material_business_error:true with concrete material fact evidence. It cannot override a proved objective business FAIL. Header-equivalence review can resolve only machine UNKNOWN labeled HEADER_EQUIVALENCE after other business checks pass, never a machine FAIL or unsupported formula. Structural parse is not visual validation. Images must be actually viewed before visual PASS. No identity inference or external trial lookup.'})
    return str(b)

def final_score(bundle,run_path,review_path):
    p=pathlib.Path(run_path);r=json.loads(p.read_text());root=p.parent;review=json.loads(pathlib.Path(review_path).read_text());obs_path=root/'service/observations_received.json';obs=json.loads(obs_path.read_text()) if obs_path.exists() else None
    for name,h in r['artifact_sha256'].items():
        if sha(delivered_path(root/'output',name))!=h:raise ValueError('Candidate artifact changed after receipt')
    if obs and sha(obs_path)!=r['observations_received_sha256']:raise ValueError('Evaluator observation receipt changed')
    target=root/'score-final.json'
    if target.exists():raise FileExistsError('Final score exists; preserve evidence')
    scored=score(pathlib.Path(bundle)/'dataset/cases'/r['case_id'],root/'output',r,obs,review);atomic(target,scored);r['final_score_path']=str(target);r['review_path']=str(review_path);r['status']='FINAL_SCORED';atomic(p,r);return scored
