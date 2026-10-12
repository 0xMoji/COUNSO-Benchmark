"""本版本全题单的模拟参考输出与负控；绝不是候选模型运行。"""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path
import json
import shutil
import urllib.request
from urllib.parse import quote
from .io import ROOT, BenchError, write_json, load_json
from .catalog import scenarios, contracts
from .automation import VERSION, configuration, prepare, score_auto, aggregate_auto
from .mock import running_mock


def materialize_reference(case,contract,out):
    if any(c['kind'] in {'ui_behavior','presentation_contract','file_organization'} for c in contract['checks']):
        from .extensions import materialize_extension_reference
        return materialize_extension_reference(case, contract, out, ROOT)
    out.mkdir(parents=True, exist_ok=True)
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
    """Known controls, not agent results; dependency UNKNOWN is counted honestly."""
    output = Path(output)
    if output.exists():
        raise BenchError('拒绝覆盖已有自测目录')
    manifest = prepare(output, configuration('DETERMINISTIC_REFERENCE_CONTROL', 'environment', 'fixture_generator'),
                       suite='all', origin='SIMULATED')
    positives, negatives, failures = [], [], []
    for entry in manifest['entries']:
        case = next(s for s in scenarios() if s['id'] == entry['scenario_id'])
        contract = contracts(case['id'])
        out = output / entry['output_dir']
        response = materialize_reference(case, contract, out)
        response['schema_version'] = VERSION
        run = {'run_id': entry['run_id'], 'scenario_id': case['id'], 'run_origin': 'SIMULATED',
               'rubric_version': VERSION, 'repeat': entry['repeat'], 'configuration': manifest['configuration']}
        observations = observed_reference(case, response, out, run_id=run['run_id'])
        if observations:
            run['session_id'] = observations['session_id']
        write_json(out/'response.json', response)
        report = score_auto(case, contract['checks'], response, run, out, ROOT, observations)
        positives.append(report)
        if report['task_state'] == 'FAIL':
            failures.append({'scenario_id': case['id'], 'failed_checks': [c for c in report['checks'] if c['state'] == 'FAIL']})
        negative = deepcopy(response)
        first = next((c for c in contract['checks'] if c.get('path','').startswith('result.')
                      and c['kind'] in {'eq','money','money_array','set_eq','nonempty'}), None)
        if first is not None:
            field = first['path'].split('.', 1)[1]
            value = negative['result'][field]
            negative['result'][field] = (not value if isinstance(value, bool) else value+1 if type(value) is int
                                         else ['__NEGATIVE_CONTROL__'] if isinstance(value, list)
                                         else {'__NEGATIVE_CONTROL__': True} if isinstance(value, dict)
                                         else '__NEGATIVE_CONTROL__')
        else:
            field = 'scenario_id'
            negative[field] = '__WRONG_SCENARIO__'
        negative_run = deepcopy(run)
        negative_run['run_id'] += ':negative'
        negative_observations = observed_reference(case, response, out, run_id=negative_run['run_id'])
        if negative_observations:
            negative_run['session_id'] = negative_observations['session_id']
        neg = score_auto(case, contract['checks'], negative, negative_run, out, ROOT, negative_observations)
        detected = neg['task_state'] == 'FAIL'
        negatives.append({'scenario_id': case['id'], 'mutation': field, 'detected': detected})
        if not detected:
            failures.append({'scenario_id': case['id'], 'negative_control': '未检出'})
    summary = {'schema_version': VERSION, 'run_origin': 'SIMULATED', 'passed': not failures,
               'fully_verified': all(r['task_state'] == 'PASS' for r in positives),
               'reference_cases': len(positives),
               'reference_passed': sum(r['task_state'] == 'PASS' for r in positives),
               'reference_unknown': sum(r['task_state'] == 'UNKNOWN' for r in positives),
               'negative_controls': len(negatives), 'negative_detected': sum(n['detected'] for n in negatives),
               'aggregate': aggregate_auto(positives, manifest), 'failures': failures,
               'notice': '参考产物/负控核验，SIMULATED 绝非候选模型成绩；缺少渲染依赖仍记录 UNKNOWN。'}
    write_json(output/'selftest-summary.json', summary)
    write_json(output/'negative-controls.json', negatives)
    return summary
