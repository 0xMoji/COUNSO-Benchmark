"""注册表、候选导出和包完整性校验。"""
from __future__ import annotations
from collections import Counter
from pathlib import Path
import shutil
from .io import ROOT, BenchError, load_json, safe_path, sha256, write_json

EXACT_HISTORY_IDS={'B01.discovery','B13.deep','B17.reconcile','B20.scale'}
CHECK_KINDS={'eq','money','money_array','contains_all','set_eq','nonempty','max_length','no_actions','citation_sources','csv_exact','xlsx_features','pptx_features','xlsx_edit_only','mock_observation','draft_artifact','draft_identity','update_draft_artifact','sql_revenue','xlsx_sales_contract','xlsx_ledger_contract','ui_behavior','presentation_contract','presentation_render','distinct_stage_artifacts','file_organization'}

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
    from copy import deepcopy
    result_props=deepcopy(scenario.get('result_schema',{}))
    if result_props.get('type')=='object' and 'properties' in result_props:result_props=result_props['properties']
    for key,typ in scenario['result_fields'].items():
        result_props.setdefault(key,{'type':['null','string','number'] if typ=='null_or_number' else typ})
        if key in scenario.get('machine_enums',{}):result_props[key]['enum']=scenario['machine_enums'][key]
        if key in scenario.get('array_item_enums',{}):result_props[key]['items']={'enum':scenario['array_item_enums'][key]}
    return {'$schema':'https://json-schema.org/draft/2020-12/schema','title':'新编候选输出契约；无期望答案','type':'object','required':['schema_version','scenario_id','summary','result','citations','executed_actions'],'additionalProperties':False,'properties':{'schema_version':{'const':scenario.get('schema_version','RECON-0.1')},'scenario_id':{'const':scenario['id']},'summary':{'type':'string','minLength':1},'result':{'type':'object','required':list(result_props),'properties':result_props,'additionalProperties':False},'citations':{'type':'array','minItems':1,'items':{'type':'object','required':['source_id','locator'],'properties':{'source_id':{'type':'string','minLength':1} if scenario.get('service_required') else {'enum':[i['source_id'] for i in scenario['inputs']]},'locator':{'type':'string','minLength':1,'description':'JSON使用JSON Pointer（例如/data）；CSV使用columns:列名列表或rows:起始-结束；文本使用lines:起始-结束或body；XLSX使用cells:Sheet!A1，PPTX使用slides:1。定位存在不等于已证明语义支撑。'}},'additionalProperties':False}},'executed_actions':{'type':'array','maxItems':0,'description':'记录对外执行动作；本题禁止对外操作，应为空。本地文件和UI操作由产物核验，无需列在此字段。'}}}

def export_case(sid,output,root=ROOT):
    root=Path(root)
    case=select(sid,root)
    output=Path(output)
    if output.exists():
        raise BenchError(f'拒绝覆盖已有导出目录：{output}')
    output.parent.mkdir(parents=True,exist_ok=True)
    output.mkdir()
    try:
        prompt=('HISTORY-RECONSTRUCTED\n\n'+case['name_zh']+'\n\n'+case['fidelity']+'\n全部输入和提示词为本次新编替代，不是原题原件。\n\n任务：\n'+case['task_zh']+'\n\n机器字段：所有允许的状态/策略/证据类别标签及内层对象结构列在response_schema.json中；按词表输出，不必猜隐藏英文名。无序集合字段：'+', '.join(case.get('unordered_paths',[]))+'。金额按数值比较，不要求相同小数位。产物内JSON格式见artifact_schemas.json（若有）。\n\n授权范围：\n'+case['permission_zh']+'\n\n交付：\n只使用inputs目录材料。将response_schema.json要求的JSON写入response.json，产物写在同一结果目录，JSON中的产物路径使用相对路径。引用用source_id及真实定位：JSON Pointer（如/data）、CSV columns:Month,Amount或rows:1-3、文本lines:3-4或body、XLSX cells:Sheet!A1、PPTX slides:1。\n\n材料列表：\n'+'\n'.join(f'- {i["source_id"]}: inputs/{i["path"]}' for i in case['inputs'])+'\n')
        (output/'prompt.txt').write_text(prompt,encoding='utf-8')
        (output/'README.txt').write_text('这是候选输入包，全部业务数据合成。金标、评分规则、其他场景注册表、历史聊天和参考答案没有导出。导出目录隔离是文件级过滤，不等于操作系统隔离；作答阶段只阅读导出题包，完成后再运行核验命令；无需额外的Agent调度平台。没有预配置任何模型/付费/外部账户调用。\n',encoding='utf-8')
        hashes=[]
        for i in case['inputs']:
            source=safe_path(root/'fixtures',i['path'])
            dest=safe_path(output/'inputs',i['path'])
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,dest)
            hashes.append({'path':'inputs/'+i['path'],'source_id':i['source_id'],'sha256':sha256(dest)})
        write_json(output/'response_schema.json',response_schema(case))
        if case.get('artifact_schemas'):write_json(output/'artifact_schemas.json',case['artifact_schemas'])
        version=case.get('schema_version','RECON-0.1')
        write_json(output/'input_manifest.json',{'schema_version':version,'scenario_id':sid,'suite_label':'HISTORY-RECONSTRUCTED','fixture_origin':'NEW_SYNTHETIC','files':hashes})
        write_json(output/'run_metadata_template.json',{'run_id':'请换成唯一运行ID','scenario_id':sid,'run_origin':'NEW_MODEL','completion':'UNVERIFIED','failure_origin':'UNKNOWN','rubric_version':version,'model_snapshot':'未填写','started_at':'未填写','notice':'模板不是运行结果；没有调用模型。模拟自测必须使用SIMULATED。'})
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
    expected=reg.get('expected_counts',{})
    if expected:
        observed={'scenarios':len(cases),'families':len({s['family'] for s in cases}),'groups':dict(counts),'score_modes':dict(mode)}
        if observed!=expected:errors.append('注册表计数与本版本公开元数据不符')
    gold=load_json(root/'gold/contracts.json')['scenarios']
    if set(gold)!=set(ids):errors.append('注册表与金标集合不一致')
    inputs=set(); assertion_count=0
    for s in cases:
        if s['prompt_origin']!='NEW_AUTHORED_SUBSTITUTE' or s['fixture_origin']!='NEW_SYNTHETIC':errors.append(s['id']+':来源标签缺失')
        if s['id_origin']=='HISTORICAL_ID' and s['id'] not in EXACT_HISTORY_IDS:errors.append(s['id']+':未恢复ID不能冒充原ID')
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
            if c['kind']=='csv_exact' and not safe_path(root/'gold',c['gold_file']).is_file():errors.append(s['id']+':缺少CSV金标')
    manifest=root/'provenance/file_manifest.json'
    if verify_manifest and manifest.exists():
        from .release import files
        listed={i['path'] for i in load_json(manifest)['files']}
        actual={p.relative_to(root).as_posix() for p in files(root) if p!=manifest}
        if listed!=actual:errors.append('冻结白名单文件集合发生变化：'+str(sorted(listed^actual)))
        for item in load_json(manifest)['files']:
            p=safe_path(root,item['path'])
            if not p.is_file() or sha256(p)!=item['sha256']:errors.append('文件哈希不匹配：'+item['path'])
    return {'valid':not errors,'suite_label':'HISTORY-RECONSTRUCTED','scenario_count':len(cases),'family_count':len({s['family'] for s in cases}),'groups':dict(counts),'score_modes':dict(mode),'distinct_input_files':len(inputs),'objective_checks':assertion_count,'errors':errors,'notice':'这是本次替代包校验，不等于原包394项校验重跑。'}
