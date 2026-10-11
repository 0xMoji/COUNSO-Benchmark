"""注册表、候选导出和包完整性校验。"""
from __future__ import annotations
from collections import Counter
from pathlib import Path
import shutil
from .io import ROOT, BenchError, load_json, safe_path, sha256, write_json

EXACT_HISTORY_IDS={'B01.discovery','B13.deep','B17.reconcile','B20.scale'}
CHECK_KINDS={'eq','money','contains_all','set_eq','nonempty','max_length','no_actions','citation_sources','csv_exact','xlsx_features','pptx_features','xlsx_edit_only','mock_observation','draft_artifact','draft_identity','update_draft_artifact','sql_revenue','xlsx_sales_contract','xlsx_ledger_contract','entity_fields','state_evidence','csv_format','valuation_csv_rows','selected_source_rows'}

def registry(root=ROOT):
    return load_json(Path(root)/'catalog/scenarios.json')

def scenarios(root=ROOT):
    return registry(root)['scenarios']

def select(sid,root=ROOT):
    for s in scenarios(root):
        if s['id']==sid:
            return s
    raise BenchError(f'未知场景：{sid}')

def contracts(sid,root=ROOT):
    return load_json(Path(root)/'gold/contracts.json')['scenarios'][sid]

def response_schema(scenario):
    result_props={}
    for key,typ in scenario['result_fields'].items():
        result_props[key]={'type':['null','string','number'] if typ=='null_or_number' else typ}
        if key in scenario.get('machine_enums',{}):result_props[key]['enum']=scenario['machine_enums'][key]
        if key in scenario.get('array_item_enums',{}):result_props[key]['items']={'enum':scenario['array_item_enums'][key]}
        result_props[key].update(scenario.get('result_schema_overrides',{}).get(key,{}))
    return {'$schema':'https://json-schema.org/draft/2020-12/schema','title':'新编候选输出契约；无期望答案','type':'object','required':['schema_version','scenario_id','summary','result','citations','executed_actions'],'additionalProperties':False,'properties':{'schema_version':{'const':'RECON-0.1'},'scenario_id':{'const':scenario['id']},'summary':{'type':'string','minLength':1},'result':{'type':'object','required':list(result_props),'properties':result_props,'additionalProperties':False},'citations':{'type':'array','minItems':1,'items':{'type':'object','required':['source_id','locator'],'properties':{'source_id':{'type':'string','minLength':1} if scenario.get('service_required') else {'enum':[i['source_id'] for i in scenario['inputs']]},'locator':{'type':'string','minLength':1}},'additionalProperties':False}},'executed_actions':{'type':'array','maxItems':0}}}

def export_case(sid,output,root=ROOT):
    root=Path(root)
    case=select(sid,root)
    output=Path(output)
    if output.exists():
        raise BenchError(f'拒绝覆盖已有导出目录：{output}')
    output.parent.mkdir(parents=True,exist_ok=True)
    output.mkdir()
    try:
        prompt=('HISTORY-RECONSTRUCTED\n\n'+case['name_zh']+'\n\n'+case['fidelity']+'\n全部输入和提示词为本次新编替代，不是原题原件。\n\n任务：\n'+case['task_zh']+'\n\n机器字段：所有允许的状态/策略/证据类别标签列在response_schema.json中；按词表输出，不必猜隐藏英文名。集合字段不以顺序判断能力。\n\n授权范围：\n'+case['permission_zh']+'\n\n交付：\n只使用inputs目录材料。将response_schema.json要求的JSON写入response.json，产物写在同一结果目录，JSON中的产物路径使用相对路径。引用用source_id及可定位行号/字段名，不能引用外部隐藏金标。\n\n材料列表：\n'+'\n'.join(f'- {i["source_id"]}: inputs/{i["path"]}' for i in case['inputs'])+'\n')
        (output/'prompt.txt').write_text(prompt+case.get('prompt_suffix',''),encoding='utf-8')
        (output/'README.txt').write_text('这是候选输入包，全部业务数据合成。金标、评分规则、其他场景注册表、历史聊天和参考答案没有导出。导出目录隔离是文件级过滤，不等于操作系统隔离；真实评测应将此目录单独挂载到候选容器。没有预配置任何模型/付费/外部账户调用。\n',encoding='utf-8')
        hashes=[]
        for i in case['inputs']:
            source=safe_path(root/'fixtures',i['path'])
            dest=safe_path(output/'inputs',i['path'])
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,dest)
            hashes.append({'path':'inputs/'+i['path'],'source_id':i['source_id'],'sha256':sha256(dest)})
        schema = response_schema(case)
        if case.get('task_revision') == 'B17-contract-0.2':
            import json
            from .revision_contracts import B17_SCHEMA_TEXT
            if schema != json.loads(B17_SCHEMA_TEXT):
                raise BenchError('B17生成schema偏离固定契约，拒绝导出')
            (output/'response_schema.json').write_text(B17_SCHEMA_TEXT,encoding='utf-8')
        else:
            write_json(output/'response_schema.json',schema)
        write_json(output/'input_manifest.json',{'schema_version':'RECON-0.1','scenario_id':sid,'suite_label':'HISTORY-RECONSTRUCTED','fixture_origin':'NEW_SYNTHETIC','task_revision':case.get('task_revision','RECON-0.1'),'grader_revision':'RECON-0.2','files':hashes})
        write_json(output/'run_metadata_template.json',{'run_id':'请换成唯一运行ID','scenario_id':sid,'run_origin':'NEW_MODEL','completion':'UNVERIFIED','failure_origin':'UNKNOWN','rubric_version':'RECON-0.2','task_revision':case.get('task_revision','RECON-0.1'),'model_snapshot':'未填写','started_at':'未填写','notice':'模板不是运行结果；没有调用模型。模拟自测必须使用SIMULATED。'})
    except Exception:
        shutil.rmtree(output)
        raise
    return output

def validate_package(root=ROOT,verify_manifest=True):
    root=Path(root)
    reg=registry(root); cases=reg['scenarios']
    errors=[]
    if reg.get('suite_label')!='HISTORY-RECONSTRUCTED' or reg.get('registry_origin')!='NEW_DESIGN': errors.append('缺少重建标签')
    ids=[s['id'] for s in cases]
    if len(ids)!=len(set(ids)): errors.append('重复场景ID')
    counts=Counter(s['group'] for s in cases)
    mode=Counter(s['score_mode'] for s in cases)
    if len(cases)!=31 or len({s['family'] for s in cases})!=20 or counts!={'core':20,'stress':5,'diagnostic':6}: errors.append('本次新设计计数不符')
    if mode!={'normalized':23,'supplemental':2,'diagnostic':6}: errors.append('本次新编评分分组计数不符')
    gold=load_json(root/'gold/contracts.json')['scenarios']
    if set(gold)!=set(ids):errors.append('注册表与金标集合不一致')
    inputs=set(); assertion_count=0
    for s in cases:
        if s['prompt_origin']!='NEW_AUTHORED_SUBSTITUTE' or s['fixture_origin']!='NEW_SYNTHETIC':errors.append(s['id']+':来源标签缺失')
        if s['id'] not in EXACT_HISTORY_IDS and not s['id'].startswith('R'):errors.append(s['id']+':未恢复ID不能冒充原ID')
        if s['id_origin']=='HISTORICAL_ID' and s['id'] not in EXACT_HISTORY_IDS:errors.append(s['id']+':原ID标注不实')
        if len({i['source_id'] for i in s['inputs']})!=len(s['inputs']):errors.append(s['id']+':source_id冲突')
        for i in s['inputs']:
            try:
                p=safe_path(root/'fixtures',i['path'])
                if not p.is_file():errors.append(s['id']+':缺少输入'+i['path'])
                inputs.add(i['path'])
                if p.suffix=='.json':load_json(p)
            except (OSError,ValueError) as exc:errors.append(str(exc))
        checks=gold.get(s['id'],{}).get('checks',[])
        if len({c['id'] for c in checks})!=len(checks):errors.append(s['id']+':重复检查ID')
        if not checks:errors.append(s['id']+':空评分契约')
        assertion_count+=len(checks)
        for c in checks:
            if c['kind'] not in CHECK_KINDS or c.get('weight',1)<=0:errors.append(s['id']+':未知检查或权重')
            if c['kind'] in {'csv_exact','valuation_csv_rows'} and not safe_path(root/'gold',c['gold_file']).is_file():errors.append(s['id']+':缺少CSV金标')
    manifest=root/'provenance/file_manifest.json'
    if verify_manifest and manifest.exists():
        from .release import files
        listed={i['path'] for i in load_json(manifest)['files']}
        actual={str(p.relative_to(root)) for p in files(root) if p!=manifest}
        if listed!=actual:errors.append('冻结白名单文件集合发生变化：'+str(sorted(listed^actual)))
        for item in load_json(manifest)['files']:
            p=safe_path(root,item['path'])
            if not p.is_file() or sha256(p)!=item['sha256']:errors.append('文件哈希不匹配：'+item['path'])
    return {'valid':not errors,'suite_label':'HISTORY-RECONSTRUCTED','scenario_count':len(cases),'family_count':len({s['family'] for s in cases}),'groups':dict(counts),'score_modes':dict(mode),'distinct_input_files':len(inputs),'objective_checks':assertion_count,'errors':errors,'notice':'这是本次替代包校验，不等于原包394项校验重跑。'}
