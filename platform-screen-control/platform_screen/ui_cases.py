"""Two prospective Frames-aligned controlled-proxy task families.

Candidate input includes business source data and a public neutral interface.
Only evaluator files contain reference source, fault schedules and unseen data.
The function runner is a trusted deterministic proxy, not native Dust/Counso.
"""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from . import VERSION

HERE=Path(__file__).parent

def _dump(path:Path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def _text(path:Path,value:str):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value,encoding='utf-8')

def _sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def dashboard_oracle(snapshot,scope):
    """Independent source-only arithmetic; no DOM or reference implementation."""
    def instant(value):
        value=value if 'T' in value else value+'T00:00:00Z'
        return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)
    active={'OPEN','IN_PROGRESS','WAITING'}
    rows=[r for r in snapshot['tickets']
          if (not scope['team_ids'] or r['team_id'] in scope['team_ids'])
          and r['status'] in scope['statuses']
          and instant(scope['created_from'])<=instant(r['created_at'])<instant(scope['created_to'])]
    live=[r for r in rows if r['status'] in active]
    return {'ticket_ids':[r['ticket_id'] for r in rows],
            'metrics':{'ticket_count':len(rows),'active_count':len(live),
                       'overdue_active_count':sum(instant(r['due_at'])<instant(snapshot['as_of']) for r in live),
                       'remaining_effort_hours':sum(r['remaining_minutes'] for r in live)/60},
            'chart':{status:sum(r['status']==status for r in live) for status in ['OPEN','IN_PROGRESS','WAITING']}}

def validate_draft(snapshot,draft):
    """Source-bound eligibility/quantity/cumulative controls for trusted oracles."""
    resources={r['resource_id']:r for r in snapshot['resources']}
    work={w['work_item_id']:w for w in snapshot['work_items']}
    roster={(r['resource_id'],r['date']):r for r in snapshot['roster']}
    resource_totals=defaultdict(int);work_totals=defaultdict(int);identities=set();errors=[]
    for a in draft['allocations']:
        aid=a['allocation_id'];n=a['minutes'];r=resources.get(a['resource_id']);w=work.get(a['work_item_id']);day=roster.get((a['resource_id'],a['date']))
        if aid in identities:errors.append('duplicate_allocation_id')
        identities.add(aid)
        if isinstance(n,bool) or not isinstance(n,int) or n<=0 or n%15:errors.append('invalid_quantity');continue
        if not r or not w or not day:errors.append('unknown_source_association');continue
        if r['team_id']!=w['team_id'] or w['required_skill'] not in r['skills']:errors.append('ineligible_resource')
        if not w['earliest_date']<=a['date']<=w['due_date']:errors.append('ineligible_date')
        resource_totals[(a['resource_id'],a['date'])]+=n;work_totals[a['work_item_id']]+=n
    for key,total in resource_totals.items():
        r=roster[key]
        if total>r['available_minutes']-r['committed_minutes']:errors.append('resource_capacity_exceeded')
    for wid,total in work_totals.items():
        if total>work[wid]['remaining_minutes']:errors.append('work_demand_exceeded')
    return errors

def _sources(kind):
    folder=HERE/'ui_templates'
    if kind=='dashboard':return None,(folder/'dashboard.tsx').read_text()
    shared=(folder/'planner_common.tsx').read_text()
    return shared+(folder/'planner_seed.tsx').read_text(),shared+(folder/'planner_editor.tsx').read_text()

def _fixture_files(kind,fixture):
    f=copy.deepcopy(fixture);metadata=f.pop('_host_file_metadata',{})
    if kind=='dashboard':return {'dataset.json':f},{'dataset.json':{'revision':'1','canWrite':False}}
    draft=f.pop('draft')
    return {'resources.json':f,'draft.json':draft},metadata

def _make(root:Path,record,interface,mutations):
    cid=record['case_id'];kind=record['task_type'];task=record['task'];case=root/cid;pub=case/'public';ev=case/'evaluator'
    public_interface=copy.deepcopy(interface['tasks'][kind]);public_interface.pop('observer_atoms_shape',None)
    public_interface['allowed_imports']=interface['allowed_imports'];public_interface['manifest']=interface['manifest'];public_interface['measurement_title']=interface['measurement_title']
    public_interface['rules']=task['public_business_rules'];public_interface['native_counso_status']='UNKNOWN; controlled proxy only'
    public_interface['unusable_package_rule']='The required entry must be a loadable React/TSX component using the published import surface. If the evaluator binds this exact package to a stable typed INVALID_TSX, MISSING_ENTRY or PROHIBITED_IMPORT rejection, and the same CI job independently demonstrates a source-correct reference through the same compiler, dependencies, browser and host, every runtime-dependent functional atom is FAIL. This is FAIL-only prerequisite evidence: it cannot grant PASS, does not claim candidate UI interaction, and triggers no business/safety cap. Unknown dependency, host, browser or error attribution remains UNKNOWN. E0 delivery/format keeps its own five-point weight.'
    public_interface['download_absence_rule']='A download feature FAIL requires an actual effective user click, a bound visible page, and an evaluator browser-event ledger showing no download within the publicly bounded five-second acceptance window. Failure to perform the click or establish the page/instrument remains UNKNOWN. A real downloaded file and its bytes are required for PASS.'
    public_interface['package_identity']={'frame_id':'SYNTHETIC-'+cid,'source_package':'frame','modification_preserves_identity':kind=='planner','identity_is_host_bound':'Output source replaces this assigned package. Candidate text cannot create or certify a new native Frame identity.'}
    _dump(pub/'interaction_contract.json',public_interface)
    for api_file in ['SDK_API.d.ts','SDK_API.json']:
        _text(pub/api_file,(HERE/'ui_templates'/api_file).read_text())
    initial,metadata=_fixture_files(kind,record['initial']);alternate,alternate_metadata=_fixture_files(kind,record['unseen'])
    required_artifacts=['frame/manifest.json','frame/index.tsx','frame/functions/load-data.ts']+['frame/'+name for name in initial]
    reference_response={'artifacts':required_artifacts,'limitations':['Controlled Frames-aligned proxy; native Counso fork/workspace execution has not been verified.']}
    delivery={'weight':5,'scored_atom':'D-E0' if kind=='dashboard' else 'P-E0','required_response':'response.json','response_schema':'response_schema.json','required_artifacts':required_artifacts,'no_additional_weight':True,'policy':'Delivery PASS requires valid response.json and all declared package files. Missing/type-invalid delivery is a noncritical delivery FAIL. Unreliable observation is UNKNOWN. Functional score alone never certifies complete delivery; complete requires all functional atoms PASS and delivery PASS.'}
    seed,reference=_sources(kind);manifest=copy.deepcopy(interface['manifest']);manifest['description']=task['brief_zh']
    for target in [pub/'inputs'/'frame',ev/'reference'/'frame']:
        _dump(target/'manifest.json',manifest)
        for name,data in initial.items():_dump(target/name,data)
        # The trusted proxy registers this declared bare function. This file is
        # pure task-data logic; no claim about an unverified sandbox runner ABI.
        function="// Deterministic task-data function for the controlled proxy. No network or model calls.\nexport default function loadData(input: unknown, snapshot: unknown) {\n  return "+("{snapshot, scope: input}" if kind=='dashboard' else "snapshot")+";\n}\n"
        _text(target/'functions'/'load-data.ts',function)
    if seed is not None:_text(pub/'inputs'/'frame'/'index.tsx',seed)
    _text(ev/'reference'/'frame'/'index.tsx',reference)
    for name,data in alternate.items():_dump(ev/'unseen'/'frame'/name,data)
    _dump(ev/'initial_host_files.json',metadata);_dump(ev/'unseen_host_files.json',alternate_metadata)
    _dump(ev/'response_schedules.json',record['schedules']);_dump(ev/'mutation_control_plan.json',mutations[kind])
    checks=[]
    for atom in task['atomic_acceptance_matrix']:
        checks.append({'id':atom['id'],'kind':'UI_BROWSER','target':atom['id'],'weight':atom['weight'],'critical':atom['critical_business_error_possible'],'safety':False,'scope':atom['public_requirement'],'difficulty':atom['difficulty'],'evidence_mode':atom['evidence_mode'],'required_evidence':atom['required_evidence']})
    _dump(ev/'gold.json',{'benchmark_version':VERSION,'case_id':cid,'checks':checks,'ui_task_type':kind,'task_type':'create' if kind=='dashboard' else 'modify','required_artifacts':required_artifacts,'reference_response':reference_response,'delivery_flag':delivery,'reference_package':'reference/frame','independent_oracle':task['independent_oracle'],'score_denominator':100,'score_intervals':interface['score_intervals'],'unknown_policy':'Missing trusted evidence UNKNOWN; fixed denominator, no redistribution.','safety_gate':record['task']['safety_rule']})
    contract={'benchmark_version':VERSION,'version':VERSION,'case_id':cid,'total_weight':100,'execution_mode':'frames_proxy','required_artifacts':required_artifacts,'measurement_title':interface['measurement_title'],'checks':checks,'delivery_flag':delivery,'unknown_policy':'Missing or unreliable actual-browser/source evidence is UNKNOWN. Every atom retains its fixed weight. Compilation, element existence or screenshots alone do not prove functional PASS.','critical_gate':'Only proved material business amount/entity/date/scope/permission/completed-action error caps quality at 50; representation and feature defects are noncritical.','critical_unknown_policy':'An unresolved potentially critical business check keeps complete score null and conservative lower bound at most50; preserve the uncapped interval and fixed unknown weight separately.','safety_gate':record['task']['safety_rule']}
    contract.update(score_intervals=interface['score_intervals'],sdk_api_files=['SDK_API.d.ts','SDK_API.json'])
    _dump(pub/'task_contract.json',contract)
    _dump(pub/'grading_contract.json',contract)
    _dump(pub/'response_schema.json',{'type':'object','required':['artifacts'],'properties':{'artifacts':{'type':'array','minItems':len(required_artifacts),'uniqueItems':True,'items':{'type':'string'},'allOf':[{'contains':{'const':a}} for a in required_artifacts]},'limitations':{'type':'array','items':{'type':'string'}}},'additionalProperties':True})
    action='Create the new React/TSX UI in output/frame/index.tsx using the supplied Frame package manifest and business source.' if kind=='dashboard' else 'Modify the supplied existing Frame index.tsx in the same assigned package identity. Deliver its replacement source under output/frame, preserving original behavior. Do not recreate a different Frame as the modification.'
    prompt=task['public_task_brief']+'\n\n'+action+'\nCopy the supplied manifest, initial source data and declared function unchanged into output/frame. The trusted host owns runtime data and replaces it for same-schema transfer; source-file editing cannot certify business state. Use only react, @dust/frame and @dust/react-hooks imports. Read SDK_API.d.ts and SDK_API.json for the exact available signatures and proxy limits: readFile returns FrameFile metadata (not a bare File), and the host provider already wraps the default component. readFile/callFunction/writeFile are from @dust/react-hooks. Read interaction_contract.json for public data schemas, neutral visible value roles and actual file/revision rules. Visible cell/preview roles or unambiguous header/text equivalents are accepted; columns and sentences need not match a reference. Unresolved date/prose meaning remains UNKNOWN for source-bound review. Implement real visible browser-operable behavior. Only deterministic synthetic load-data and the explicitly permitted existing draft file write are authorized. No external requests, real business writes, other models or agents. Deliver response.json listing every required frame artifact in grading_contract.json plus any genuine limitations. All atomic weights total100; unknown evaluator evidence is not redistributed. A valid response and required files are the explicit five-point E0 representation atom; missing delivery cannot be called complete.\n'
    _text(pub/'prompt.txt',prompt)
    _dump(ev/'reference_response.json',reference_response)
    _dump(ev/'source_hashes.json',{'initial':{name:_sha(pub/'inputs'/'frame'/name) for name in initial},'seed_index':None if seed is None else _sha(pub/'inputs'/'frame'/'index.tsx'),'reference_index':_sha(ev/'reference'/'frame'/'index.tsx'),'unseen':{name:_sha(ev/'unseen'/'frame'/name) for name in alternate}})
    return {'case_id':cid,'family':'generative_ui','task_type':'create' if kind=='dashboard' else 'modify','split':record['split'],'difficulty':'hard','domain':'synthetic_support_operations' if kind=='dashboard' else 'synthetic_resource_planning','summary':task['brief_zh'],'execution_mode':'frames_proxy','service_required':False,'required_artifacts':required_artifacts,'measurement_title':interface['measurement_title'],'contract_weight':100}

def build_cases(root:Path):
    """Generate exactly 2 MAIN + 2 CAL UI cases; never append extra topics."""
    data=json.loads((HERE/'ui_data.json').read_text())
    return [_make(Path(root),r,data['interface'],data['mutation_control_plan']) for r in data['records']]
