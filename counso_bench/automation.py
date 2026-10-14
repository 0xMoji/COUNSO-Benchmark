"""Self-service AUTO-0.2 submissions and local scoring. Never invokes an agent/model."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

from .io import ROOT, BenchError, get_path, load_json, safe_path, sha256, write_json
from .catalog import contracts, export_case, scenarios, select
from .checks import evaluate
from .schema import validate_response
from .mock import execution_fingerprint

VERSION = 'AUTO-0.2'
CAPABILITIES = ('office_tasks', 'file_tools', 'generative_ui')
ARTIFACT_KINDS = {
    'csv_exact', 'xlsx_features', 'xlsx_edit_only', 'xlsx_sales_contract',
    'xlsx_ledger_contract', 'draft_artifact', 'draft_identity',
    'update_draft_artifact', 'pptx_features', 'ui_behavior',
    'presentation_contract', 'presentation_render', 'file_organization',
}


def capability(case, root=ROOT):
    if case.get('capability') in CAPABILITIES:
        return case['capability']
    if any(c['kind'].startswith(('csv_', 'xlsx_', 'pptx_')) for c in contracts(case['id'], root)['checks']):
        return 'file_tools'
    return 'office_tasks'


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def configuration(model, source='user_config', agent='existing_agent', **optional):
    if not isinstance(model, str) or not model.strip():
        raise BenchError('模型标识不能为空；不能确认时明确填写 UNKNOWN')
    if source not in {'user_config', 'environment', 'agent_self_report', 'unknown'}:
        raise BenchError('model_identity_source 无效')
    return {'model_label': model, 'model_identity_source': source,
            'agent_label': agent, 'model_snapshot': None, **optional}


def prepare(output, config, ids=None, suite='main', repeats=1, origin='NEW_MODEL', root=ROOT):
    """Export tasks and an immutable planned denominator; no agent execution."""
    root, output = Path(root), Path(output)
    if output.exists():
        raise BenchError('拒绝覆盖已有作答目录：' + str(output))
    if type(repeats) is not int or not 1 <= repeats <= 20:
        raise BenchError('repeats 必须是 1–20 的整数')
    if origin not in {'NEW_MODEL', 'SIMULATED'}:
        raise BenchError('只接受 NEW_MODEL 或 SIMULATED；历史结果单独保存')
    selected = [select(sid, root) for sid in ids] if ids else [
        s for s in scenarios(root) if suite == 'all' or s['group'] != 'diagnostic']
    if not selected or len({s['id'] for s in selected}) != len(selected):
        raise BenchError('题单不能为空或有重复场景')
    if not isinstance(config, dict) or not config.get('model_label'):
        raise BenchError('缺少模型标识；身份可以未知，不能虚构')
    output.mkdir(parents=True)
    attempt_id = str(uuid.uuid4())
    entries = []
    for case in selected:
        for repeat in range(1, repeats + 1):
            base = Path('cases') / case['id'] / f'repeat-{repeat:03d}'
            export_case(case['id'], output / base / 'input', root)
            (output / base / 'output').mkdir()
            run_id = f'{attempt_id}:{case["id"]}:{repeat}'
            entry = {'scenario_id': case['id'], 'repeat': repeat, 'run_id': run_id,
                     'capability': capability(case, root), 'group': case['group'],
                     'input_dir': str(base / 'input'), 'output_dir': str(base / 'output'),
                     'response_path': str(base / 'output' / 'response.json'),
                     'observations_path': str(base / 'service' / 'observations.json'),
                     'endpoint_path': str(base / 'service' / 'endpoint.json'),
                     'input_hashes': [{'path': i['path'], 'sha256': sha256(root / 'fixtures' / i['path'])}
                                      for i in case['inputs']]}
            if case.get('service_required'):
                entry['service_required'] = case['service_required']
            write_json(output / base / 'run.json', {
                'schema_version': VERSION, 'rubric_version': VERSION, 'run_id': run_id,
                'scenario_id': case['id'], 'run_origin': origin, 'repeat': repeat,
                'configuration': config, 'state': 'PREPARED',
                'notice': '只准备题目和提交记录，没有调用模型。完成状态由核验产物推导。'})
            entries.append(entry)
    manifest = {'schema_version': VERSION, 'attempt_id': attempt_id,
                'run_origin': origin, 'configuration': config,
                'created_at': datetime.now(timezone.utc).isoformat(),
                'suite_fingerprint': execution_fingerprint(root),
                'entries': entries,
                'notice': '自助作答题单；完整仓库可读，不构成防作弊或模型路由证明。'}
    manifest['plan_sha256'] = _digest({k: v for k, v in manifest.items() if k != 'plan_sha256'})
    write_json(output / 'manifest.json', manifest)
    (output / 'START.txt').write_text(
        '读取仓库 AGENT-START.md。manifest.json 是本次题单；每题 input/prompt.txt 和 '
        'input/response_schema.json 为作答要求。产物放到该题 output/。提交后调用：\n'
        f'python -m counso_bench score-suite --attempt "{output}"\n'
        '本命令未调用模型；不要读取 gold 或修改评分器来获得通过。\n', encoding='utf-8')
    return manifest


def validate_manifest(manifest, root=ROOT, require_current=True):
    if not isinstance(manifest, dict) or manifest.get('schema_version') != VERSION:
        raise BenchError('题单版本必须为 ' + VERSION)
    if manifest.get('run_origin') not in {'NEW_MODEL', 'SIMULATED'}:
        raise BenchError('题单来源无效')
    if manifest.get('plan_sha256') != _digest({k: v for k, v in manifest.items() if k != 'plan_sha256'}):
        raise BenchError('题单指纹不符；修改题单请新建一次作答')
    if require_current and manifest.get('suite_fingerprint') != execution_fingerprint(root):
        raise BenchError('题集/输入/评分器已改变，请使用原版本或新建作答目录')
    entries = manifest.get('entries')
    if not isinstance(entries, list) or not entries:
        raise BenchError('题单 entries 不能为空')
    ids, run_ids = set(), set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise BenchError('题单条目必须为对象')
        key = (entry.get('scenario_id'), entry.get('repeat'))
        if type(key[1]) is not int or key[1] < 1 or key in ids:
            raise BenchError('场景/重复编号无效或重复')
        if not entry.get('run_id') or entry['run_id'] in run_ids:
            raise BenchError('run_id 缺失或重复')
        select(key[0], root)
        for field in ('input_dir', 'output_dir', 'response_path', 'observations_path', 'endpoint_path'):
            safe_path(Path('/tmp/counso-plan-validation'), entry[field])
        ids.add(key); run_ids.add(entry['run_id'])
    return manifest


def _result(cid, passed, reason, category='facts', weight=1, critical=False, required=True):
    return {'id': cid, 'state': 'UNKNOWN' if passed is None else 'PASS' if passed else 'FAIL',
            'passed': passed, 'reason': str(reason), 'category': category, 'weight': weight,
            'critical': bool(critical), 'required': bool(required)}


def derive(checks):
    """Known failure takes precedence over unknown; never shrink the planned denominator."""
    if not checks or len({c['id'] for c in checks}) != len(checks):
        raise BenchError('检查为空或 ID 重复')
    for c in checks:
        if c.get('state') not in {'PASS', 'FAIL', 'UNKNOWN'}:
            raise BenchError('检查状态无效')
        if c.get('passed') is not {'PASS': True, 'FAIL': False, 'UNKNOWN': None}[c['state']]:
            raise BenchError('检查 state 与 passed 冲突')
        if type(c.get('weight')) not in {int, float} or isinstance(c['weight'], bool) or not 0 < c['weight'] < 10000:
            raise BenchError('检查权重无效')
    required = [c for c in checks if c.get('required', True)]
    failed = any(c['state'] == 'FAIL' for c in required)
    unknown = any(c['state'] == 'UNKNOWN' for c in required)
    state = 'FAIL' if failed else 'UNKNOWN' if unknown else 'PASS'
    critical_failed = any(c['critical'] and c['state'] == 'FAIL' for c in checks)
    critical_unknown = any(c['critical'] and c['state'] == 'UNKNOWN' for c in checks)
    known = sum(c['weight'] for c in checks if c['state'] != 'UNKNOWN')
    earned = sum(c['weight'] for c in checks if c['state'] == 'PASS')
    possible = sum(c['weight'] for c in checks)
    observed = round(100 * earned / known, 4) if known else None
    objective = 0.0 if critical_failed else None if any(c['state'] == 'UNKNOWN' for c in checks) else observed
    return {'task_state': state, 'critical_failed': critical_failed,
            'critical_unknown': critical_unknown, 'objective_score': objective,
            'objective_observed_score': observed, 'known_weight': known,
            'possible_weight': possible,
            'unknown_checks': sum(c['state'] == 'UNKNOWN' for c in checks)}


def score_auto(case, checks, response, run, output_dir, root=ROOT,
               observations=None, response_error=None, self_review=None):
    root, output_dir = Path(root), Path(output_dir)
    if not isinstance(run, dict) or run.get('scenario_id') != case['id'] or not run.get('run_id'):
        raise BenchError('提交记录缺少身份或与场景不符')
    if run.get('run_origin') not in {'NEW_MODEL', 'SIMULATED'}:
        raise BenchError('新评分不接受历史记录或未标记的来源')
    if run.get('rubric_version', VERSION) != VERSION:
        raise BenchError('禁止把旧运行记录静默迁入 AUTO-0.2')
    if any(k in run for k in ('human_review', 'adjudication')):
        raise BenchError('AUTO-0.2 不接受人工评分字段')
    response_object = response if isinstance(response, dict) else {}
    schema_case = {**case, 'schema_version': VERSION}
    errors = [response_error] if response_error else validate_response(response, schema_case)
    if response_object.get('schema_version') != VERSION:
        errors.append('schema_version 必须为 ' + VERSION)
    if response_object.get('scenario_id') != case['id']:
        errors.append('响应场景身份不符或缺失')
    evaluated = [_result(case['id'] + ':response_format', not errors,
                         '；'.join(str(e) for e in errors) if errors else '公开响应契约通过',
                         category='format', weight=2, critical=True)]
    observation_issue = None
    observations_digest = _digest(observations) if observations is not None else None
    if observations is not None:
        if not isinstance(observations, dict) or any((
            observations.get('run_id') != run['run_id'],
            observations.get('scenario_id') != case['id'],
            not isinstance(run.get('session_id'), str) or not run.get('session_id'),
            not isinstance(observations.get('session_id'), str) or not observations.get('session_id'),
            observations.get('session_id') != run.get('session_id'),
            observations.get('execution_fingerprint') != execution_fingerprint(root),
        )):
            observation_issue = '观测与 run/session/场景/执行包身份不一致，拒绝使用'
            observations = None
    artifact_evidence = []
    for check in checks:
        if check['kind'] in ARTIFACT_KINDS and check.get('path'):
            try:
                relative = get_path(response_object, check['path'])
                artifact = safe_path(output_dir, relative)
                if check['kind'] == 'file_organization':
                    files, total_bytes = [], 0
                    if artifact.is_dir():
                        for member in artifact.rglob('*'):
                            if member.is_symlink():
                                raise BenchError('目录产物不接受符号链接')
                            if not member.is_file():
                                continue
                            total_bytes += member.stat().st_size
                            if len(files) >= 10000 or total_bytes > 50_000_000:
                                raise BenchError('目录产物超过核验资源范围')
                            files.append({'path': member.relative_to(artifact).as_posix(), 'sha256': sha256(member)})
                    files.sort(key=lambda item: item['path'])
                    artifact_evidence.append({'check_id': check['id'], 'path': relative,
                                              'type': 'directory', 'present': artifact.is_dir(),
                                              'sha256': None, 'files': files,
                                              'content_manifest_sha256': _digest(files) if artifact.is_dir() else None})
                else:
                    artifact_evidence.append({'check_id': check['id'], 'path': relative,
                                              'type': 'file', 'present': artifact.is_file(),
                                              'sha256': sha256(artifact) if artifact.is_file() else None})
            except (BenchError, KeyError, TypeError, OSError) as exc:
                artifact_evidence.append({'check_id': check['id'], 'path': None,
                                          'present': False, 'sha256': None, 'error': str(exc)})
        if not isinstance(response, dict) or response_error:
            passed, reason = None, '未形成可核验响应；格式/交付失败已单列'
        else:
            try:
                passed, reason = evaluate(check, response, output_dir, root, observations)
            except (BenchError, KeyError, TypeError, ValueError, IndexError, OSError) as exc:
                passed, reason = False, '候选输出不满足契约：' + str(exc)
            except Exception as exc:
                passed, reason = None, '核验器异常：' + type(exc).__name__ + ': ' + str(exc)
        evaluated.append(_result(check['id'], passed, reason, check.get('category', 'facts'),
                                 check.get('weight', 1), check.get('critical', False),
                                 check.get('required', True)))
    if observation_issue:
        evaluated.append(_result(case['id'] + ':observation_identity', None,
                                 observation_issue, 'evidence', critical=True))
    derived = derive(evaluated)
    assessor_evidence = []
    evidence_dir = output_dir / '.assessor'
    if evidence_dir.exists():
        try:
            total_bytes = 0
            for member in sorted(evidence_dir.rglob('*')):
                safe_path(output_dir, str(member.relative_to(output_dir)))
                if not member.is_file():
                    continue
                total_bytes += member.stat().st_size
                if len(assessor_evidence) >= 10000 or total_bytes > 50_000_000:
                    raise BenchError('核验观察文件超过资源范围')
                assessor_evidence.append({'path': member.relative_to(output_dir).as_posix(),
                                          'sha256': sha256(member)})
        except (BenchError, OSError) as exc:
            assessor_evidence.append({'error': str(exc)})
    suite_fingerprint = execution_fingerprint(root)
    fixture_hashes = [{'path': i['path'], 'sha256': sha256(root / 'fixtures' / i['path'])}
                      for i in case['inputs']]
    self_evaluation = None
    if self_review is not None:
        from .semantic_review import validate_self_review
        review_validation = validate_self_review(self_review, output_dir)
        self_evaluation = {'source': 'CANDIDATE_SELF_EVALUATION',
                           'included_in_score': False, 'content': self_review,
                           'validation': review_validation,
                           'reference_quality_cap': 0 if derived['critical_failed'] else None,
                           'binding': _digest({'run_id': run['run_id'], 'response': response_object,
                                               'artifacts': artifact_evidence,
                                               'assessor_evidence': assessor_evidence,
                                               'suite_fingerprint': suite_fingerprint,
                                               'fixture_hashes': fixture_hashes})}
    return {'schema_version': VERSION, 'rubric_version': VERSION, 'scenario_id': case['id'],
            'run_id': run['run_id'], 'repeat': run.get('repeat', 1),
            'run_origin': run['run_origin'], 'configuration': run.get('configuration', {}),
            'group': case['group'], 'capability': capability(case, root),
            'suite_fingerprint': suite_fingerprint, 'fixture_hashes': fixture_hashes,
            'response_schema_errors': errors, 'response_load_error': response_error,
            'checks': evaluated, **derived, 'artifact_evidence': artifact_evidence,
            'response_content_sha256': _digest(response), 'run_content_sha256': _digest(run),
            'observations_content_sha256': observations_digest,
            'observations_identity_verified': observations is not None,
            'assessor_evidence': assessor_evidence,
            'self_evaluation': self_evaluation,
            'evidence_scope': 'LOCAL_ARTIFACTS_AND_MOCK' if observations else 'LOCAL_ARTIFACTS_AND_DECLARATIONS',
            'behavior_notice': '无独立轨迹的行为声明不证明真实外部操作；本报告只核验题集可观察范围。'}


def validate_score(report):
    if not isinstance(report, dict) or report.get('schema_version') != VERSION:
        raise BenchError('评分记录必须为 ' + VERSION)
    if report.get('run_origin') not in {'NEW_MODEL', 'SIMULATED'}:
        raise BenchError('评分记录来源无效')
    derived = derive(report['checks'])
    for key, value in derived.items():
        if report.get(key) != value:
            raise BenchError('评分派生字段与逐项检查冲突：' + key)
    return report


def aggregate_auto(reports, manifest, root=ROOT):
    validate_manifest(manifest, root, require_current=False)
    expected = {(e['scenario_id'], e['repeat']): e for e in manifest['entries']}
    seen = {}
    for report in reports:
        validate_score(report)
        key = (report['scenario_id'], report['repeat'])
        if key not in expected or key in seen:
            raise BenchError('报告场景不在题单内或重复提交')
        entry = expected[key]
        case = select(report['scenario_id'], root)
        if report.get('capability') != capability(case, root) or report.get('group') != case['group']:
            raise BenchError('报告能力/分组与注册表不符')
        expected_checks = {c['id']: c for c in contracts(case['id'], root)['checks']}
        expected_checks[case['id'] + ':response_format'] = {'category': 'format', 'weight': 2, 'critical': True, 'required': True}
        observed_checks = {c['id']: c for c in report['checks']}
        identity_id = case['id'] + ':observation_identity'
        if identity_id in observed_checks:
            expected_checks[identity_id] = {'category': 'evidence', 'weight': 1, 'critical': True, 'required': True}
            if observed_checks[identity_id]['state'] != 'UNKNOWN':
                raise BenchError('身份不符观测只能为 UNKNOWN')
        if set(observed_checks) != set(expected_checks):
            raise BenchError('报告检查集合与冻结契约不符')
        for cid, specification in expected_checks.items():
            found = observed_checks[cid]
            for field, default in [('category', 'facts'), ('weight', 1), ('critical', False), ('required', True)]:
                if found.get(field) != specification.get(field, default):
                    raise BenchError('报告检查策略与契约不符：' + cid + ':' + field)
        if report['run_id'] != entry['run_id'] or report['run_origin'] != manifest['run_origin']:
            raise BenchError('报告 run_id/来源与题单不符')
        if report['suite_fingerprint'] != manifest['suite_fingerprint'] or report['fixture_hashes'] != entry['input_hashes']:
            raise BenchError('报告输入或评分包指纹与题单不符')
        if report.get('configuration') != manifest['configuration']:
            raise BenchError('报告模型配置与题单不符')
        seen[key] = report
    groups = {}
    for name in (*CAPABILITIES, 'diagnostic'):
        entries = [e for e in manifest['entries'] if
                   (e['group'] == 'diagnostic' if name == 'diagnostic'
                    else e['group'] != 'diagnostic' and e['capability'] == name)]
        states = Counter(seen[(e['scenario_id'], e['repeat'])]['task_state']
                         if (e['scenario_id'], e['repeat']) in seen else 'UNKNOWN' for e in entries)
        total = len(entries)
        groups[name] = {'planned': total, 'submitted': sum((e['scenario_id'], e['repeat']) in seen for e in entries),
                        'pass': states['PASS'], 'fail': states['FAIL'], 'unknown': states['UNKNOWN'],
                        'success_rate_bounds': [states['PASS'] / total, (states['PASS'] + states['UNKNOWN']) / total] if total else None}
    main = [e for e in manifest['entries'] if e['group'] != 'diagnostic']
    success = sum(seen.get((e['scenario_id'], e['repeat']), {}).get('task_state') == 'PASS' for e in main)
    fail = sum(seen.get((e['scenario_id'], e['repeat']), {}).get('task_state') == 'FAIL' for e in main)
    unknown = len(main) - success - fail
    result = {'schema_version': VERSION, 'run_origin': manifest['run_origin'],
              'attempt_id': manifest['attempt_id'], 'configuration': manifest['configuration'],
              'plan_sha256': manifest['plan_sha256'], 'suite_fingerprint': manifest['suite_fingerprint'],
              'manifest': manifest, 'planned_count': len(expected), 'submitted_count': len(seen),
              'missing_count': len(expected) - len(seen),
              'submission_coverage': len(seen) / len(expected),
              'main': {'planned': len(main), 'pass': success, 'fail': fail, 'unknown': unknown,
                       'success_rate_bounds': [success / len(main), (success + unknown) / len(main)] if main else None},
              'capabilities': groups, 'case_reports': list(seen.values()),
              'recommendations': _recommendations(groups, list(seen.values())),
              'notice': '程序核验结果与 Agent 自评分开；UNKNOWN 范围不是统计置信区间；SIMULATED 不代表模型表现。'}
    return result


def _recommendations(groups, reports):
    result = []
    for name, group in groups.items():
        if not group['planned']:
            continue
        failures = [r for r in reports if r['task_state'] == 'FAIL' and
                    (r['group'] == 'diagnostic' if name == 'diagnostic' else r['group'] != 'diagnostic' and r['capability'] == name)]
        failed_checks = [{'scenario_id': r['scenario_id'], 'check_id': c['id'], 'reason': c['reason']}
                         for r in failures for c in r['checks'] if c['state'] == 'FAIL']
        result.append({'capability': name, 'summary':
                       f"计划 {group['planned']} 项，成功 {group['pass']}，失败 {group['fail']}，未判定 {group['unknown']}。",
                       'evidence': failed_checks[:12],
                       'advice': '优先处理已确认失败；未判定项补齐核验证据后再比较。' if group['fail'] or group['unknown'] else '本题单已验证要求均通过，结论限定于这些任务。'})
    return result


def score_suite(attempt, root=ROOT):
    attempt, root = Path(attempt), Path(root)
    manifest = validate_manifest(load_json(attempt / 'manifest.json'), root)
    reports = []
    for entry in manifest['entries']:
        case = select(entry['scenario_id'], root)
        input_dir = safe_path(attempt, entry['input_dir'])
        for item in entry['input_hashes']:
            if sha256(safe_path(input_dir / 'inputs', item['path'])) != item['sha256']:
                raise BenchError('导出输入被修改：' + entry['scenario_id'] + ':' + item['path'])
        response_path = safe_path(attempt, entry['response_path'])
        output_dir = safe_path(attempt, entry['output_dir'])
        if not response_path.exists() and (not output_dir.exists() or output_dir.is_dir() and not any(output_dir.iterdir())):
            # Not attempted: leave it in the planned denominator as UNKNOWN.
            continue
        response, error = None, None
        try:
            response = load_json(response_path)
        except (BenchError, ValueError, OSError) as exc:
            error = type(exc).__name__ + ': ' + str(exc)
        run = {'run_id': entry['run_id'], 'scenario_id': entry['scenario_id'],
               'run_origin': manifest['run_origin'], 'rubric_version': VERSION,
               'repeat': entry['repeat'], 'configuration': manifest['configuration']}
        observations = None
        observation_path = safe_path(attempt, entry['observations_path'])
        if observation_path.exists():
            try:
                observations = load_json(observation_path)
                endpoint = load_json(safe_path(attempt, entry['endpoint_path']))
                run['session_id'] = endpoint.get('session_id')
            except (BenchError, ValueError, OSError, AttributeError):
                observations = {}
        self_review = None
        self_review_path = output_dir / 'self_review.json'
        if self_review_path.exists():
            try:
                self_review = load_json(self_review_path)
            except (BenchError, ValueError, OSError) as exc:
                self_review = {'invalid_self_review': str(exc)}
        report = score_auto(case, contracts(case['id'], root)['checks'], response, run,
                            output_dir, root, observations, error, self_review)
        report['response_sha256'] = sha256(response_path) if response_path.is_file() and response_path.stat().st_size <= 5_000_000 else None
        reports.append(report)
    return aggregate_auto(reports, manifest, root)


def compare_reports(configs, root=ROOT):
    if not isinstance(configs, dict) or len(configs) < 2:
        raise BenchError('比较至少两份题单报告')
    checked = {}
    for name, report in configs.items():
        recomputed = aggregate_auto(report['case_reports'], report['manifest'], root)
        for key in ('main', 'capabilities', 'planned_count', 'submitted_count', 'plan_sha256', 'suite_fingerprint', 'configuration', 'run_origin'):
            if report.get(key) != recomputed.get(key):
                raise BenchError('汇总字段与题单/逐项记录不一致：' + name + ':' + key)
        checked[name] = recomputed
    fingerprints = {r['suite_fingerprint'] for r in checked.values()}
    origins = {r['run_origin'] for r in checked.values()}
    if len(fingerprints) != 1 or len(origins) != 1:
        raise BenchError('禁止比较不同评分包或混合 SIMULATED/NEW_MODEL')
    universes = []
    for report in checked.values():
        universes.append({(e['scenario_id'], e['repeat']): e['input_hashes'] for e in report['manifest']['entries']})
    if any(u != universes[0] for u in universes[1:]):
        raise BenchError('题单、重复编号或输入不同，不能只取有分交集比较')
    names = list(checked)
    paired = []
    base = checked[names[0]]
    for name in names[1:]:
        other = checked[name]
        dimensions = {}
        for cap in CAPABILITIES:
            a, b = base['capabilities'][cap], other['capabilities'][cap]
            if not a['planned']:
                continue
            la, ua = a['success_rate_bounds']; lb, ub = b['success_rate_bounds']
            dimensions[cap] = {'success_rate_difference_bounds': [lb - ua, ub - la],
                               'conclusion': name + '的已确定成功率更高' if lb > ua else names[0] + '的已确定成功率更高' if la > ub else '当前证据不足以确定优势，查看逐题差异。'}
        paired.append({'baseline': names[0], 'candidate': name, 'capabilities': dimensions})
    return {'schema_version': VERSION, 'run_origin': next(iter(origins)),
            'configurations': {name: {k: r[k] for k in ('configuration', 'main', 'capabilities')} for name, r in checked.items()},
            'comparability': {
                'same_agent_label': len({r['configuration'].get('agent_label') for r in checked.values()}) == 1,
                'environment_recorded_for_all': all(r['configuration'].get('environment') for r in checked.values()),
                'declared_environments_equal': (len({_digest(r['configuration'].get('environment')) for r in checked.values()}) == 1
                                                if all(r['configuration'].get('environment') for r in checked.values()) else None),
                'attribution_notice': '同一 Agent 且工具条件一致更适合判断换模型的变化；跨 Agent 或工具环境不同只能解释整体系统表现。环境记录不是实际模型路由证明。'},
            'paired_comparisons': paired,
            'notice': '同题单报告比较；差异范围由 UNKNOWN 造成，不代表统计显著性。不同 Agent 的环境差异仍需按记录解释。'}


def markdown_report(report):
    labels = {'office_tasks': '办公事务', 'file_tools': '文件与工具', 'generative_ui': '生成式 UI', 'diagnostic': '诊断（单列）'}
    lines = ['# Agent 题集本地核验报告', '',
             f"版本：{VERSION}；来源：{report['run_origin']}；模型标识：{report['configuration'].get('model_label', 'UNKNOWN')}。", '',
             f"题单 {report['planned_count']} 项，提交 {report['submitted_count']} 项，未提交 {report['missing_count']} 项。", '',
             '| 能力 | 计划 | 成功 | 失败 | 未判定 | 成功率可确定范围 |',
             '|---|---:|---:|---:|---:|---|']
    for name, group in report['capabilities'].items():
        bounds = group['success_rate_bounds']
        value = f'{bounds[0]:.1%}–{bounds[1]:.1%}' if bounds else '未选题'
        lines.append(f"| {labels[name]} | {group['planned']} | {group['pass']} | {group['fail']} | {group['unknown']} | {value} |")
    lines.extend(['', '## 有证据的参考意见', ''])
    for rec in report['recommendations']:
        lines.append(f"- {labels[rec['capability']]}：{rec['summary']} {rec['advice']}")
        for item in rec['evidence']:
            reason = item['reason'].replace('\n', ' ')
            lines.append(f"  - {item['scenario_id']} / {item['check_id']}：{reason}")
    reviews = [r for r in report['case_reports'] if r.get('self_evaluation')]
    if reviews:
        lines.extend(['', '## Agent 自动自评参考（不计程序分）', '',
                      '以下来自当前作答 Agent，不是独立评审。定位核验不证明语义正确；关键程序失败的参考质量封顶 0。', '',
                      '| 题目 | 模板有效 | 事实 / 完整 / 可用 | 参考意见 |', '|---|---|---|---|'])
        for case in reviews:
            review = case['self_evaluation']
            validation = review['validation']
            scores = validation['dimension_scores']
            capped = review['reference_quality_cap'] == 0
            values = [str(0 if capped else scores[k]) if scores[k] is not None else '未知'
                      for k in ('facts', 'completeness', 'usability')]
            content = review['content']
            comment = str(content.get('commentary', '') if isinstance(content, dict) else '')
            comment = comment.replace('|', '\\|').replace('\n', ' ')[:400]
            lines.append(f"| {case['scenario_id']} | {'是' if validation['valid'] else '否，见 JSON 错误'} | "
                         f"{' / '.join(values) if validation['valid'] else '未核验'} | {comment} |")
    lines.extend(['', '## 判断范围', '', report['notice'],
                  '模型标识按所记录来源保存，不证明实际路由。当前 Agent 自评不计入程序核验分。', ''])
    return '\n'.join(lines)
