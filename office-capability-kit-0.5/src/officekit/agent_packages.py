"""Agent-first public task export. No model API, account, evaluator or network."""
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from importlib.resources import files
from .exchange import prepare, verify_bundle
from .io import artifact, load_fixture, public_resources, write_json
from .providers import public_final_schema
from .registry import REGISTRY

FORMAT = 'officekit-agent-task-1'

def _ui_resources(case_id):
    try:
        return files('officekit.agent_ui').joinpath(case_id)
    except ModuleNotFoundError:
        p=Path(__file__).resolve().parents[2]/'tasks'/'ui'/case_id/'public'
        if not p.is_dir(): raise ValueError('UI public inputs are unavailable in this installation')
        return p

def _ui_common(name):
    try:
        return files('officekit.agent_ui').joinpath(name).read_bytes()
    except ModuleNotFoundError:
        root=Path(__file__).resolve().parents[2]
        p=root/'tasks'/'ui'/name if name=='TOOL_INTERFACE.json' else root/'adapters'/'standalone-ui'/name
        return p.read_bytes()

def _helper(name):
    return Path(__file__).with_name(name).read_bytes()

def _task_text(case_id):
    title=REGISTRY[case_id]['title']
    general=f'''# {title}\n\nYou are the agent solving {case_id}. Your platform supplies the model; this kit never connects a model API or asks for a key. Read prompt.txt and all public input/business-rule files. Solve the task and deliver working results. Do not substitute a plan or a claimed ledger for actual work.\n\n## Scope and environment\nUse only this public task directory, its fixed helper and the permitted tools. Do not inspect an operator's private run, evaluator, reference implementation, other agents/models or accounts. Inputs are fictional. No real mail/calendar/business actions, external services, package installation, additional model or subagent is authorized. Shared-host separation is instruction-level, not an OS sandbox.\n\nRead ENVIRONMENT.json before starting. A platform without the required file/tool abilities is ENVIRONMENT_UNSUPPORTED; it is not a model zero. One agent, at most 900 seconds of generation, fixed public tool budget. The independent evaluator owns grading. This directory contains no answers, grading code, reference or mutations.\n'''
    if REGISTRY[case_id]['family']=='office':
        tool='data.read_csv' if case_id=='office-data' else 'files.read_input'
        name=load_fixture(case_id)['input_files'][0]
        example="python3 call.py --bundle . tool "+tool+" '"+json.dumps({'file':name},separators=(',',':'))+"'"
        return (general+'''\n## Start and call real synthetic tools\nThe operator first starts `officekit host-agent --bundle <this-directory> --output <operator-private-run>`. You do not write a controller or start another model. From this public directory run:\n\n`python3 call.py --bundle . preflight`\n\nContinue only if the result says READY. Then use the offered names and exact arguments in tools.json, for example:\n\n`__ACTUAL_READ_EXAMPLE__`\n\nRead each returned response before choosing the next action. The helper talks to the already-running trusted mock host; it does not fabricate tool results. Use the returned event/resource identities and status evidence honestly. A rejected call does not grant additional authority.\n\n## Deliver\nCreate submission/candidate.json matching FINAL_RESULT_SCHEMA.json. Its artifacts array contains relative path strings such as outputs/<allowed filename>, extracted from file.artifact or files[].artifact returned by actual tools, never whole descriptor objects. completed_actions must cite actual accepted current-run tool events. File outputs written through tools are kept by the operator's host.\n\n`python3 call.py --bundle . final @submission/candidate.json`\n`python3 submit.py --bundle .`\n\nThe final response confirms receipt only and never reveals a score. handoff.json records the candidate handoff; it cannot certify tool effects. The operator uses the separate host receipt and recorded actual tool session to grade. Do not create or replace a ledger, state, host receipt or private report.\n''').replace('__ACTUAL_READ_EXAMPLE__',example)
    return general+'''\n## Build the standalone mini app\nCreate submission/index.html, submission/response.json and all declared local static JavaScript/CSS assets. response.json has an artifacts array of relative asset paths, including index.html, and optional limitations. No build or npm script is executed. Do not include a scorer, ledger, reference, external dependency or external URL.\n\nUse the synthetic same-origin HTTP tools in TOOL_INTERFACE.json. They are supplied by the independent browser host when it loads the app; they are not real business services. Read each returned source/scope/revision rather than hardcoding this one input. Public inputs describe the data shape, and the evaluator can supply another same-schema dataset.\n\naction-mapping.example.json describes neutral accessible control/table names. If your valid labels differ, deliver an action-mapping.json declaring their visible role/name or unambiguous column mapping. A mapping is an integration aid, not answer evidence. Native Counso, Dust Frames React/TSX and A2UI runtimes are not provided by this standalone task. Do not label HTML as native Frames/A2UI output.\n\n`python3 submit.py --bundle .`\n\nThe helper checks a static handoff only and creates handoff.json outside submission/. It never grants a functional PASS. The operator independently loads the static package in a real browser, performs interactions, changes data and checks tool events/visible results. Only a screenshot, code, compile, self-reported ledger or completion claim cannot certify behavior. If your platform can write files but cannot run Python, deliver the same submission/ files; the operator can run this fixed handoff helper.\n'''

def _prepare(case_id, root):
    if case_id not in REGISTRY: raise ValueError('Unknown fixed task')
    family=REGISTRY[case_id]['family']
    if family=='office':
        prepare(case_id,root)
        allowed=load_fixture(case_id)['allowed_output_files']
        (root/'FINAL_RESULT_SCHEMA.json').write_text(json.dumps(public_final_schema(),indent=2,sort_keys=True)+'\n')
        (root/'call.py').write_bytes(_helper('agent_call.py'))
    else:
        root.mkdir(parents=True)
        res=_ui_resources(case_id)
        for p in sorted(res.iterdir(),key=lambda p:p.name):
            if p.is_file(): (root/p.name).write_bytes(p.read_bytes())
        interface=json.loads(_ui_common('TOOL_INTERFACE.json'))
        allowed_names=interface['task_scopes'][case_id]
        interface['tools']=[t for t in interface['tools'] if t['name'] in allowed_names]
        interface['task_scopes']={case_id:allowed_names}
        # Do not point the candidate at a reference implementation it must not read.
        interface.pop('canonical_definition',None)
        write_json(root/'TOOL_INTERFACE.json',interface)
        mapping=json.loads(_ui_common('action-mapping.json'))
        branch='dashboard' if case_id=='ui-dashboard' else 'planner'
        mapping={k:v for k,v in mapping.items() if k not in ('dashboard','planner') or k==branch}
        write_json(root/'action-mapping.example.json',mapping)
        allowed=['index.html','response.json','declared local static assets','optional action-mapping.json']
        write_json(root/'FINAL_RESULT_SCHEMA.json',{'type':'object','required':['artifacts'],'properties':{'artifacts':{'type':'array','minItems':1,'uniqueItems':True,'items':{'type':'string'}},'limitations':{'type':'array','items':{'type':'string'}}},'additionalProperties':False})
    (root/'submit.py').write_bytes(_helper('agent_submit.py'))
    (root/'TASK.md').write_text(_task_text(case_id),encoding='utf-8')
    write_json(root/'ENVIRONMENT.json',{'schema_version':'officekit-agent-environment-1','case_id':case_id,'family':family,'model_supplied_by':'CALLER_AGENT_PLATFORM','model_api_required':False,'credentials_required':False,'candidate_required_capabilities':['read_public_files','write_submission_files','POSIX_shell_Python_3.11plus_and_running_operator_mock_host'] if family=='office' else ['read_public_files','write_static_app_files'],'operator_requirements':['installed_trusted_officekit','start_host_before_candidate'] if family=='office' else ['separate_standalone_browser_adapter','authorized_normal_official_Chrome','locked_Playwright_install_for_evaluator_only'],'unsupported_status':'ENVIRONMENT_UNSUPPORTED','unsupported_model_score':'UNKNOWN_NOT_ZERO','max_tool_calls':32 if family=='office' else None,'candidate_time_budget_seconds':900,'allowed_output_files':allowed,'ledger_authority':'OPERATOR_LIVE_HOST_ONLY','isolation':'INSTRUCTION_LEVEL_ONLY_NOT_OS_SANDBOX'})
    entries=[artifact(root,p) for p in sorted(root.rglob('*')) if p.is_file()]
    fingerprint=hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    manifest={'schema_version':FORMAT,'case_id':case_id,'family':family,'bundle_kind':'PUBLIC_AGENT_TASK_ONLY','contains_evaluator_gold':False,'contains_reference':False,'contains_mutations':False,'contains_scorer':False,'contains_credentials':False,'model_provider':'EXISTING_AGENT_PLATFORM','artifacts':entries,'task_fingerprint':fingerprint,'mutable_candidate_paths':['submission/','handoff.json'], 'mutable_host_transport_path':'.bridge/' if family=='office' else None}
    write_json(root/'AGENT_TASK_MANIFEST.json',manifest)
    return manifest

def prepare_agent(case_id, output, archive=None):
    root=Path(output).absolute()
    if root.exists():raise ValueError('Public output directory must be fresh and nonexistent')
    if archive and Path(archive).exists():raise ValueError('Public archive destination must be fresh')
    target=Path(archive).absolute() if archive else None
    if target and target.is_relative_to(root):raise ValueError('Archive must be outside its own public task directory')
    manifest=_prepare(case_id,root)
    if archive:
        target.parent.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED) as z:
            for p in sorted(root.rglob('*')):
                if p.is_file(): z.writestr(p.relative_to(root).as_posix(),p.read_bytes())
    return manifest

def verify_agent_bundle(bundle):
    root=Path(bundle).absolute()
    if root.is_symlink():raise ValueError('Public bundle cannot be a symlink')
    manifest_path=root/'AGENT_TASK_MANIFEST.json'
    if manifest_path.is_symlink():raise ValueError('Task manifest cannot be a symlink')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(manifest,dict) or manifest.get('schema_version')!=FORMAT or manifest.get('case_id') not in REGISTRY:raise ValueError('Expected fixed public agent task manifest')
    cid=manifest['case_id']
    with tempfile.TemporaryDirectory(prefix='officekit-fixed-agent-template-') as tmp:
        expected=Path(tmp)/'public';_prepare(cid,expected)
        required={p.relative_to(expected).as_posix():p.read_bytes() for p in expected.rglob('*') if p.is_file()}
    for name,data in required.items():
        p=root/name
        if any(parent.is_symlink() for parent in [p,*p.parents] if parent==root or root in parent.parents):raise ValueError('Public static symlink is unsupported')
        if not p.is_file() or p.read_bytes()!=data:raise ValueError(f'Fixed public agent task changed: {name}')
    for p in root.rglob('*'):
        rel=p.relative_to(root).as_posix()
        if rel in required or rel.startswith(('.bridge/','submission/')) or rel=='handoff.json':continue
        if p.is_file() or p.is_symlink():raise ValueError(f'Unexpected public task file: {rel}')
    if REGISTRY[cid]['family']=='office':return verify_bundle(root)
    return cid,None
