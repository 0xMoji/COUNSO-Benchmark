from __future__ import annotations
import hashlib,json,pathlib,shutil
from . import VERSION
from .service import CLIENT
from .service_cases import build_cases as service_cases
from .data_file_cases import build_cases as data_cases
from .ui_cases import build_cases as ui_cases

ROOT=pathlib.Path(__file__).resolve().parents[1]
PUBLIC_CHECK_KEYS={'id','kind','target','weight','critical','safety','scope','dimension','difficulty','required_evidence','evidence_mode','tolerance','review_resolvable','table_scope','header_contract','related_artifacts','response_fields','value_contract','service_value_contract','semantic_review_scope','response_field_contracts','table_value_contracts','column_value_contracts','edit_value_contracts','chart_value_contracts','representation_contract','columns'}

def public_check(check):
    """Publish judgments and equivalence rules, never case-specific gold prose."""
    result={k:v for k,v in check.items() if k in PUBLIC_CHECK_KEYS}
    if 'public_scope' in check:result['scope']=check['public_scope']
    return result

def augment_contract(case,entry):
    """Common requirements are real delivery obligations, never label-aware.

    Keep the original relative task weights in90 points; reserve5 each for
    mandatory machine-consumable response and traceable source declarations.
    A separate zero-weight critical-consistency review controls only the proved
    critical gate, not stylistic preferences or ordinary prose omissions.
    """
    gold_path=case/'evaluator/gold.json';public_path=case/'public/grading_contract.json';gold=json.loads(gold_path.read_text());contract=json.loads(public_path.read_text())
    for c in gold['checks']:c['weight']=round(c['weight']*.9,6)
    common=[{'id':'response_contract','kind':'RESPONSE_CONTRACT','target':'response','weight':5,'critical':False,'safety':False,'scope':'Mandatory response schema, required answer fields and actual/declared artifact filenames are valid. Extra truthful fields/files are allowed.'},
            {'id':'evidence_contract','kind':'EVIDENCE_CONTRACT','target':'evidence','weight':5,'critical':False,'safety':False,'scope':'A nonempty string citation list resolves to supplied source files/IDs or observed service records; missing/null/invalid references are a real delivery defect, never inferred as proof.'},
            {'id':'critical_contradictions','kind':'CRITICAL_CONTRADICTIONS','target':entry['required_artifacts'],'weight':0,'critical':True,'safety':False,'scope':'Independent source/response/delivered-artifact and observed mock-action payload/result consistency check: no proved false critical amount, entity/period/identity, approved/permission state or completed-action claim. A delivered invitation draft is reviewed against the requested meeting facts and truthful tentative/unsent status. Style, formatting, harmless paraphrases and ordinary omissions do not trigger the critical gate.'}]
    gold['checks']+=common;gold['required_artifacts']=entry['required_artifacts'];gold['benchmark_version']=VERSION;contract['benchmark_version']=VERSION;contract['total_weight']=100;contract['required_artifacts']=entry['required_artifacts']
    from .field_contracts import apply_field_contracts
    schema_path=case/'public/response_schema.json';schema=json.loads(schema_path.read_text())
    apply_field_contracts(entry['case_id'],gold['reference_response'],schema,gold['checks'],contract)
    schema_path.write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n')
    contract['checks']=[public_check(c) for c in gold['checks']]
    contract['evidence_reference_policy']={'source_files':'Cite a supplied input filename, optionally with path/sheet/cell/record/heading locator. Case differences in filenames are accepted.','service':'Cite complete bounded discovered source IDs and optional locations; citation-label case/outer whitespace is equivalent, unlike literal business entity keys. A source-ID substring or different appended ID/version does not establish citation. Required supporting sources must also have actually been read. Successful operation records can be cited by operation name; draft_lookup is a registered equivalent label for lookup_draft.','unresolvable':'A provably nonexistent reference is FAIL; underspecified support semantics are reviewed separately.'}
    contract['critical_unknown_policy']='While a critical consistency check is UNKNOWN, a future proved critical defect could cap quality at50. The conservative lower bound therefore does not exceed50 until that check is resolved; no missing weight is renormalized.'
    contract['requirement_check_map']=[{'requirement':c.get('scope',c['id']),'check_ids':[c['id']]} for c in contract['checks']]
    mapping=contract.setdefault('requirement_check_mapping',{})
    if not isinstance(mapping,dict):raise ValueError('Requirement mapping must be an object')
    mapping['common_requirements']={c['id']:{'requirement':c['scope'],'check_ids':[c['id']]} for c in common}
    mapping.setdefault('answers',{key:[c['id'] for c in gold['checks'] if c.get('target')=='answers.'+key or key in c.get('response_fields',[])] for key in gold['reference_response']['answers']})
    gold_path.write_text(json.dumps(gold,ensure_ascii=False,indent=2)+'\n');public_path.write_text(json.dumps(contract,ensure_ascii=False,indent=2)+'\n')

FAMILIES=('information_evidence','data_files','tool_workflow_recovery','generative_ui')
MAIN_IDS={'G-EVID-M2','G-EXEC-M1','G-REC-M2','GO-DATA-MED','G-UI-CREATE-M1','G-UI-EDIT-M1'}
CAL_IDS={'GO-DATA-CAL','G-UI-CREATE-C1','G-UI-EDIT-C1'}

def build(output):
    root=pathlib.Path(output)
    if root.exists():raise FileExistsError('Dataset already exists: build to a new path, never overwrite a frozen dataset')
    root.mkdir(parents=True)
    entries=service_cases(root/'cases')+data_cases(root/'cases')+ui_cases(root/'cases')
    for entry in entries:
        case=root/'cases'/entry['case_id'];public=case/'public'
        entry['family']={'planning_execution':'tool_workflow_recovery','exception_recovery':'tool_workflow_recovery','data_analysis':'data_files','genui_creation':'generative_ui','genui_modification':'generative_ui'}.get(entry['family'],entry['family'])
        if entry.get('execution_mode')!='frames_proxy':augment_contract(case,entry)
        if entry.get('service_required'):(public/'inputs/mock_client.py').write_text(CLIENT)
        contract_path=public/'grading_contract.json';contract=json.loads(contract_path.read_text())
        contract['macro_family']=entry['family'];contract_path.write_text(json.dumps(contract,ensure_ascii=False,indent=2)+'\n')
        files={str(p.relative_to(public)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(public.rglob('*')) if p.is_file()}
        (public/'input_manifest.json').write_text(json.dumps({'benchmark_version':VERSION,'case_id':entry['case_id'],'public_files':files},indent=2)+'\n')
        entry['public_input_sha256']=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
    registry={'benchmark_version':VERSION,'measurement_title':'Counso平台相关办公能力筛查','native_platform_validation':'UNKNOWN','ui_measurement':'PINNED_DUST_FRAMES_ALIGNED_SYNTHETIC_CONTROLLED_PROXY','data_origin':'SYNTHETIC','primary_sampling':'six representative main tasks; four equal capability-family macro averages; single observation per main cell','family_weights':{f:.25 for f in FAMILIES},'entries':sorted(entries,key=lambda e:e['case_id'])}
    (root/'registry.json').write_text(json.dumps(registry,ensure_ascii=False,indent=2)+'\n')
    validate_dataset(root)
    return registry

def validate_dataset(root):
    from .scoring import validate
    root=pathlib.Path(root);registry=json.loads((root/'registry.json').read_text())
    entries=registry.get('entries',[]);ids={e['case_id'] for e in entries}
    if registry.get('benchmark_version')!=VERSION or len(entries)!=9 or ids!=MAIN_IDS|CAL_IDS:raise ValueError('Expected exactly six MAIN and three CALIBRATION cases of this version')
    if {e['case_id'] for e in entries if e['split']=='main'}!=MAIN_IDS or {e['case_id'] for e in entries if e['split']=='calibration'}!=CAL_IDS:raise ValueError('Fixed split/identity mismatch')
    if {e['family'] for e in entries if e['split']=='main'}!=set(FAMILIES):raise ValueError('Four main macro families are required')
    if {p.name for p in (root/'cases').iterdir() if p.is_dir()}!=ids:raise ValueError('Registry/case-directory mismatch')
    for entry in entries:
        case=root/'cases'/entry['case_id'];public=case/'public';gold=json.loads((case/'evaluator/gold.json').read_text());contract=json.loads((public/'grading_contract.json').read_text());schema=json.loads((public/'response_schema.json').read_text())
        if gold.get('benchmark_version')!=VERSION or contract.get('benchmark_version')!=VERSION or gold.get('case_id')!=entry['case_id']:raise ValueError('Case version/identity mismatch')
        checks=gold['checks'];check_ids={c['id'] for c in checks}
        if len(check_ids)!=len(checks) or abs(sum(c['weight'] for c in checks)-100)>1e-7 or contract.get('total_weight')!=100 or any(c['weight']<0 for c in checks):raise ValueError('Fixed 100-weight denominator/check IDs invalid')
        if contract['checks']!=[public_check(c) for c in checks]:raise ValueError('Public/gold atomic-check drift: '+entry['case_id'])
        if gold.get('required_artifacts')!=entry.get('required_artifacts') or contract.get('required_artifacts')!=entry.get('required_artifacts'):raise ValueError('Required artifact declaration drift')
        if validate(gold['reference_response'],schema):raise ValueError('Reference response violates public schema')
        for name in entry['required_artifacts']:
            if pathlib.PurePath(name).is_absolute() or '..' in pathlib.PurePath(name).parts:raise ValueError('Unsafe output path')
            if name not in gold['reference_response'].get('artifacts',[]):raise ValueError('Reference omits artifact declaration')
            if not entry.get('service_required') and not (case/'evaluator/reference'/name).is_file():raise ValueError('Missing reference artifact: '+name)
        if entry.get('execution_mode')=='frames_proxy':
            if not any(c['id'].endswith('-E0') and c['weight']==5 and not c.get('critical') for c in checks):raise ValueError('UI delivery/representation must use the declared noncritical five-point budget')
            if not (public/'interaction_contract.json').is_file():raise ValueError('Missing public interaction contract')
        else:
            if not {'response_contract','evidence_contract','critical_contradictions'}<=check_ids:raise ValueError('General common quality requirements absent')
            inventory=contract.get('field_inventory',[]);paths=[item['path'] for item in inventory]
            if not inventory or len(paths)!=len(set(paths)):raise ValueError('Selected public typed inventory absent/duplicate')
            for name in schema['properties']['answers']['required']:
                if 'answers.'+name not in paths:raise ValueError('Required answer has no prospective field type')
            for item in inventory:
                if not item.get('value_contract',{}).get('semantic_type') or not item.get('check_ids') or not set(item['check_ids'])<=check_ids:raise ValueError('Typed field lacks check coverage')
        manifest=json.loads((public/'input_manifest.json').read_text())
        actual={str(p.relative_to(public)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(public.rglob('*')) if p.is_file() and p.name!='input_manifest.json'}
        if manifest.get('public_files')!=actual or manifest.get('benchmark_version')!=VERSION or manifest.get('case_id')!=entry['case_id']:raise ValueError('Public input manifest mismatch')
        if entry['public_input_sha256']!=hashlib.sha256(json.dumps(actual,sort_keys=True).encode()).hexdigest():raise ValueError('Public registry fingerprint mismatch')
    return {'main_cases':6,'calibration_cases':3,'macro_families':4,'validation':'PASS'}

def fingerprint(root):
    root=pathlib.Path(root);files={}
    for base in ('platform_screen','tests','dataset','runtime','ci','ci-inputs','docs','provenance','.github'):
        for p in sorted((root/base).rglob('*')):
            if p.is_file() and not {'__pycache__','node_modules','test-results','playwright-report','.git'}&set(p.parts):files[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
    for name in ('README.md','RUNBOOK.md','VERSION','PREREGISTRATION.json','pyproject.toml'):
        p=root/name
        if p.is_file():files[name]=hashlib.sha256(p.read_bytes()).hexdigest()
    return {'benchmark_version':VERSION,'files':files,'execution_fingerprint':hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()}

def freeze(root):
    root=pathlib.Path(root);validate_dataset(root/'dataset');manifest=fingerprint(root);(root/'FREEZE.json').write_text(json.dumps(manifest,indent=2)+'\n');return manifest

def verify(root):
    root=pathlib.Path(root);validate_dataset(root/'dataset');frozen=json.loads((root/'FREEZE.json').read_text())
    if frozen!=fingerprint(root):raise ValueError('Frozen code, input, evaluation, dependencies or public contract changed')
    return frozen

def export(case,output):
    case=pathlib.Path(case);output=pathlib.Path(output)
    if output.exists():raise FileExistsError('Public candidate export exists')
    shutil.copytree(case/'public',output);output.chmod(0o755)
    for p in output.rglob('*'):
        if p.is_dir():p.chmod(0o755)
        elif p.is_file():p.chmod(0o444)
    if any('gold' in p.name.lower() or 'evaluator' in p.parts for p in output.rglob('*')):raise ValueError('Candidate export leaked evaluator material')
    return output
