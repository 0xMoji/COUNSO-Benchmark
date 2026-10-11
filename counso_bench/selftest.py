"""31个模拟参考输出及31个单点负控；绝不是候选模型运行。"""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path
import json
import shutil
import urllib.request
from urllib.parse import quote
from .io import ROOT, BenchError, write_json, load_json
from .catalog import scenarios, contracts
from .scoring import score_response, aggregate
from .mock import running_mock


def materialize_reference(case,contract,out):
    out.mkdir(parents=True)
    response=deepcopy(contract['reference_response']);result=response['result']
    if 'workbook' in result:
        shutil.copyfile(ROOT/'gold/reference'/result['workbook'],out/result['workbook'])
    if 'detail_file' in result:
        gold_name='valuation_expected.csv' if case['family']=='B17' else 'redacted_expected.csv' if case['family']=='R04' else 'ledger-scale_expected.csv' if case['id']=='B20.scale' else 'ledger-small_expected.csv'
        shutil.copyfile(ROOT/'gold'/gold_name,out/result['detail_file'])
    if case['id']=='R08-draft-permission':
        write_json(out/result['draft_file'],{'recipient_group':'PROJECT_TEAM','subject':'合成项目更新草稿','body':'已完成合成销售数据核对。下一步等待数据权限确认；阻塞点为数据授权尚未批准。','state':'DRAFT','sent':False})
    return response

def observed_reference(case,response,out,run_id=None):
    if not case.get('service_required'):return None
    observations_path=out.parent/(out.name+'-'+(run_id or 'SIMULATED-REFERENCE-'+case['id'])+'-assessor-observations.json')
    with running_mock(case['id'],observations_path,run_id=run_id or 'SIMULATED-REFERENCE-'+case['id']) as (endpoint,state):
        if case['service_required'] in {'SOURCE_DISCOVERY_MOCK','SOURCE_REVIEW_MOCK'}:
            for q in (['税务','主体登记','汇率','数据权限'] if case['service_required']=='SOURCE_DISCOVERY_MOCK' else []):
                with urllib.request.urlopen(endpoint+'/sources/search?q='+quote(q),timeout=5) as r:r.read()
            for sid in response['result']['source_ids']:
                with urllib.request.urlopen(endpoint+'/sources/doc/'+sid,timeout=5) as r:r.read()
        else:
            with urllib.request.urlopen(endpoint+'/drafts/by-key/'+response['result']['idempotency_key'],timeout=5) as r:draft=json.loads(r.read().decode('utf-8'))['draft']
            write_json(out/response['result']['draft_file'],draft)
    return load_json(observations_path)

def selftest(output):
    output=Path(output)
    if output.exists():raise BenchError('拒绝覆盖已有自测目录')
    output.mkdir(parents=True)
    positives=[];negative_controls=[];failures=[]
    for case in scenarios():
        sid=case['id'];contract=contracts(sid);out=output/sid
        response=materialize_reference(case,contract,out);observations=observed_reference(case,response,out)
        run={'run_id':'SIMULATED-REFERENCE-'+sid,'scenario_id':sid,'run_origin':'SIMULATED','completion':'COMPLETE','failure_origin':'NONE','rubric_version':'RECON-0.2','task_revision':case.get('task_revision','RECON-0.1'),'human_review':{'reviewer':'DETERMINISTIC_REFERENCE_SELFTEST','facts':4,'completeness':4,'usability':4,'evidence':'这是金标模拟/工具自测，不是候选人工实测审核。'}}
        if observations:run['session_id']=observations['session_id']
        write_json(out/'response.json',response);write_json(out/'run.json',run)
        report=score_response(case,contract['checks'],response,run,out,ROOT,observations)
        positives.append(report);write_json(out/'score.json',report)
        if report['objective_score']!=100:failures.append({'scenario_id':sid,'failed_checks':[c for c in report['checks'] if c['passed'] is not True]})
        negative=deepcopy(response);first=next(c for c in contract['checks'] if c['kind']=='eq' and c['path'].startswith('result.'))
        field=first['path'].split('.',1)[1];value=negative['result'][field]
        negative['result'][field]=not value if isinstance(value,bool) else value+1 if type(value)is int else ['__NEGATIVE_CONTROL__'] if isinstance(value,list) else {'__NEGATIVE_CONTROL__':True} if isinstance(value,dict) else 0 if value is None else '__NEGATIVE_CONTROL__'
        negative_run=deepcopy(run);negative_run['run_id']='SIMULATED-NEGATIVE-'+sid;negative_run.pop('human_review')
        negative_observations=observed_reference(case,response,out,run_id=negative_run['run_id']) if case.get('service_required') else None
        if negative_observations:negative_run['session_id']=negative_observations['session_id']
        negreport=score_response(case,contract['checks'],negative,negative_run,out,ROOT,negative_observations)
        detected=negreport['objective_score'] is not None and negreport['objective_score']<100
        negative_controls.append({'scenario_id':sid,'mutation':field,'detected':detected})
        if not detected:failures.append({'scenario_id':sid,'negative_control':'未检出'})
    summary={'schema_version':'RECON-0.1','run_origin':'SIMULATED','passed':not failures,'reference_cases':len(positives),'negative_controls':len(negative_controls),'negative_detected':sum(n['detected'] for n in negative_controls),'aggregate':aggregate(positives),'failures':failures,'notice':'仅验证本次工具/合成fixture一致性。31个参考通过和31负控检出都不是模型能力成绩。'}
    write_json(output/'selftest-summary.json',summary);write_json(output/'negative-controls.json',negative_controls)
    return summary
