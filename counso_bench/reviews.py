"""双审核与终裁；证据措辞不同本身不触发L1裁决。"""
from __future__ import annotations
from copy import deepcopy
from .io import BenchError
DIMS=('facts','completeness','usability')
STATES={'PASS','FAIL','UNKNOWN'}

def validate_review(review):
    if not review.get('reviewer') or not review.get('scenario_id'):raise BenchError('审核缺少reviewer/scenario_id')
    checks=review.get('checks',[])
    if len({c['name'] for c in checks})!=len(checks):raise BenchError('审核检查名重复')
    for c in checks:
        if c['state'] not in STATES or not c.get('evidence'):raise BenchError('审核状态/证据无效')
    for key in DIMS:
        v=review.get('dimensions',{}).get(key)
        if v is not None and (type(v)is not int or not 0<=v<=4):raise BenchError('审核维度值无效')

def adjudicate(a,b,decisions=None):
    validate_review(a);validate_review(b)
    if a['scenario_id']!=b['scenario_id']:raise BenchError('双审核场景不一致')
    if a['reviewer']==b['reviewer']:raise BenchError('双审核须标识两个不同审核员')
    ac={c['name']:c for c in a['checks']};bc={c['name']:c for c in b['checks']}
    disputes=[];effective_checks={};effective_dims={}
    for name in sorted(set(ac)|set(bc)):
        av=ac.get(name);bv=bc.get(name)
        if av is None or bv is None or av['state']!=bv['state']:
            disputes.append({'type':'OBSERVABILITY' if av is None or bv is None or 'UNKNOWN' in {av['state'],bv['state']} else 'L1_STATE','target':name,'scope':'checks'})
        else:effective_checks[name]={'state':av['state'],'evidence_a':av['evidence'],'evidence_b':bv['evidence']}
    for dim in DIMS:
        av=a.get('dimensions',{}).get(dim);bv=b.get('dimensions',{}).get(dim)
        if av!=bv:disputes.append({'type':'OBSERVABILITY' if av is None or bv is None else 'SCORE','target':dim,'scope':'dimensions'})
        else:effective_dims[dim]=av
    unresolved=[];applied=[]
    decisions=decisions or {}
    allowed_checks={d['target'] for d in disputes if d['scope']=='checks'}
    allowed_dims={d['target'] for d in disputes if d['scope']=='dimensions'}
    if set(decisions.get('checks',{}))-allowed_checks or set(decisions.get('dimensions',{}))-allowed_dims:raise BenchError('裁决只能覆盖争议检查/维度，不得静默改一致项')
    for d in disputes:
        target=d['target'];where=d['scope'];value=decisions.get(where,{}).get(target)
        if value is None:unresolved.append(d);continue
        if not decisions.get('adjudicator') or not value.get('evidence'):raise BenchError('裁决须有adjudicator和证据')
        if where=='checks':
            if value.get('state') not in STATES:raise BenchError('终裁状态无效')
            effective_checks[target]=deepcopy(value)
        else:
            score=value.get('score')
            if score is not None and (type(score)is not int or not 0<=score<=4):raise BenchError('终裁分数无效')
            effective_dims[target]=score
        applied.append({'type':d['type'],'target':target,'decision':value})
    complete=not unresolved and all(effective_dims.get(k) is not None for k in DIMS)
    quality=sum(effective_dims[k] for k in DIMS)/3 if complete else None
    return {'schema_version':'RECON-0.1','scenario_id':a['scenario_id'],'raw_a':a,'raw_b':b,'raw_decisions':deepcopy(decisions),'disputes':disputes,'applied_decisions':applied,'unresolved':unresolved,'effective_checks':effective_checks,'effective_dimensions':effective_dims,'pre_hardgate_quality':quality,'complete':complete,'notice':'先终裁后聚合，A/B原证据与原分保持不变。已观测业务硬门由score命令另行应用；未终裁/UNKNOWN不补零。'}

def compare_configurations(configs):
    """每配置每场景一个已评分报告；使用同一组已观察且已有人工分的场景。"""
    if len(configs)<2:raise BenchError('比较至少两个配置')
    maps={};origins=set()
    for name,reports in configs.items():
        from .scoring import aggregate
        aggregate(reports)
        mapping={}
        for r in reports:
            origins.add(r['run_origin'])
            if r['scenario_id'] in mapping:raise BenchError('配置中重复场景；重复试验先使用独立预定义的聚合规则')
            mapping[r['scenario_id']]=r
        maps[name]=mapping
    if len(origins)>1:raise BenchError('比较不能混合模拟和真实模型')
    eligible={name:{sid for sid,r in mapping.items() if r['quality_eligible'] and r['human_quality_score'] is not None} for name,mapping in maps.items()}
    shared=set.intersection(*eligible.values())
    result={}
    for name,mapping in maps.items():
        result[name]={'shared_quality_mean':sum(mapping[sid]['human_quality_score'] for sid in shared)/len(shared) if shared else None,'own_observed_quality_count':len(eligible[name]),'shared_quality_count':len(shared),'shared_scenario_ids':sorted(shared)}
    return {'schema_version':'RECON-0.1','run_origin':next(iter(origins),None),'shared_scenario_count':len(shared),'configurations':result,'notice':'相同已证据场景交集比较；交集为空则质量UNKNOWN，不能称0或100。没有统计显著性/模型排名推断。'}


def apply_adjudication(scenario,run,document):
    if document.get('schema_version')!='RECON-0.1' or document.get('scenario_id')!=scenario['id']:raise BenchError('终裁场景/版本与运行不一致')
    verified=adjudicate(document['raw_a'],document['raw_b'],document.get('raw_decisions'))
    for key in ['effective_checks','effective_dimensions','complete','unresolved']:
        if document.get(key)!=verified[key]:raise BenchError('终裁派生字段被修改，拒绝应用')
    if not verified['complete']:raise BenchError('仍有争议/未知维度，不能宣称完整人工质量；请先终裁，或不提供人工质量')
    result=deepcopy(run)
    result['human_review']={'reviewer':'ADJUDICATED:'+document.get('raw_decisions',{}).get('adjudicator','AGREED_A_B'),'evidence':{'raw_a':document['raw_a'],'raw_b':document['raw_b'],'raw_decisions':document.get('raw_decisions',{}),'effective_checks':document['effective_checks']},**document['effective_dimensions'],'factual_severity':document.get('raw_decisions',{}).get('factual_severity','NO_ISSUE')}
    return result
