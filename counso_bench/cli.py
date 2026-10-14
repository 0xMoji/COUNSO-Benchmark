"""Local self-service CLI. No agent/provider invocation and no human adjudication."""
from __future__ import annotations
import argparse
from pathlib import Path
import shutil
import sys
from .io import ROOT, BenchError, dumps, load_json, write_json, sha256
from .catalog import scenarios, select, contracts, export_case, validate_package
from .automation import (VERSION, configuration, prepare, score_auto, score_suite,
                         aggregate_auto, compare_reports, markdown_report)


def save_new(path, value):
    if Path(path).exists():
        raise BenchError('拒绝覆盖已有输出/原始证据：' + str(path))
    write_json(path, value)


def doctor():
    from importlib.util import find_spec
    import os
    import json
    import subprocess
    node = os.environ.get('COUNSO_NODE') or shutil.which('node')
    office = os.environ.get('COUNSO_SOFFICE') or shutil.which('soffice') or shutil.which('libreoffice')
    browser = {'available': False, 'notice': '没有检查到可用的 Playwright/Chromium'}
    if node:
        script = "const fs=require('fs');const p=require('playwright');const path=process.env.COUNSO_CHROMIUM_EXECUTABLE||p.chromium.executablePath();process.stdout.write(JSON.stringify({available:fs.existsSync(path),executable:path,node_version:process.version,playwright_version:require('playwright/package.json').version}));"
        try:
            result = subprocess.run([node, '-e', script], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                browser = json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
    office_version = None
    if office:
        try:
            result = subprocess.run([office, '--version'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                office_version = result.stdout.strip()[:500]
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {'schema_version': VERSION, 'python': sys.version.split()[0],
            'node': node, 'browser': browser, 'office_engine': office, 'office_engine_version': office_version,
            'openpyxl': find_spec('openpyxl') is not None,
            'notice': '基础题和评分不需要 API key；UI 浏览器及 Office 渲染依赖按使用说明检查，缺失时记录 UNKNOWN。'}


def main(argv=None):
    p = argparse.ArgumentParser(description='Agent 评测：准备、单题交接、回收和核验；不会调用模型或付费服务')
    sub = p.add_subparsers(dest='command', required=True)
    q = sub.add_parser('list', help='列出题目'); q.add_argument('--group', choices=['core', 'stress', 'diagnostic'])
    sub.add_parser('doctor', help='检查本地依赖，不调用模型')
    q = sub.add_parser('prepare', help='创建题单、输入包和提交目录；不会执行题目')
    q.add_argument('--output', required=True); q.add_argument('--model', required=True)
    q.add_argument('--model-source', choices=['user_config', 'environment', 'agent_self_report', 'unknown'], default='user_config')
    q.add_argument('--agent', default='existing_agent'); q.add_argument('--cases', nargs='+')
    q.add_argument('--suite', choices=['main', 'all'], default='main'); q.add_argument('--repeats', type=int, default=1)
    q.add_argument('--origin', choices=['NEW_MODEL', 'SIMULATED'], default='NEW_MODEL')
    q = sub.add_parser('handoff', help='评测端导出单题作答包，不含答案或评分器')
    q.add_argument('--attempt', required=True); q.add_argument('--case', required=True)
    q.add_argument('--repeat', type=int, default=1); q.add_argument('--output', required=True)
    q = sub.add_parser('collect', help='评测端按提交身份回收 output，保留自己的配置和观测')
    q.add_argument('--attempt', required=True); q.add_argument('--submission', required=True)
    q = sub.add_parser('variant', help='生成有明确覆盖范围的冻结种子变体副本')
    q.add_argument('--seed', type=int, required=True); q.add_argument('--output', required=True)
    q = sub.add_parser('export', help='单题输入包，排除 gold'); q.add_argument('scenario_id', nargs='?')
    q.add_argument('--all', action='store_true'); q.add_argument('--output', required=True)
    q = sub.add_parser('serve-mock', help='题内本地模拟服务'); q.add_argument('scenario_id')
    q.add_argument('--state-dir', required=True); q.add_argument('--run-id', required=True)
    sub.add_parser('validate', help='校验题集和冻结清单')
    q = sub.add_parser('score', help='AUTO-0.2 单题本地核验'); q.add_argument('scenario_id')
    q.add_argument('--response', required=True); q.add_argument('--run', required=True)
    q.add_argument('--output-dir'); q.add_argument('--observations'); q.add_argument('--self-review'); q.add_argument('--output')
    q = sub.add_parser('score-suite', help='核验作答目录并生成 JSON/Markdown 报告')
    q.add_argument('--attempt', required=True); q.add_argument('--output')
    q = sub.add_parser('report', help='按固定题单汇总单题核验记录')
    q.add_argument('reports', nargs='+'); q.add_argument('--manifest', required=True); q.add_argument('--output')
    q = sub.add_parser('compare', help='比较同版本、同输入、同题单的汇总报告')
    q.add_argument('--configs', required=True); q.add_argument('--output')
    q = sub.add_parser('selftest', help='参考产物和负控；不是模型实测'); q.add_argument('--output', required=True)
    sub.add_parser('freeze', help='冻结本地发布文件哈希')
    q = sub.add_parser('release', help='生成确定性本地源码 ZIP'); q.add_argument('--output', required=True)
    args = p.parse_args(argv)
    try:
        if args.command == 'doctor':
            print(dumps(doctor()), end=''); return 0
        if args.command == 'list':
            from .automation import capability
            for case in scenarios():
                if not args.group or case['group'] == args.group:
                    print(f"{case['id']}\t{case['group']}\t{capability(case)}\t{case['name_zh']}")
            return 0
        if args.command == 'prepare':
            result = prepare(Path(args.output), configuration(args.model, args.model_source, args.agent,
                             environment=doctor()),
                             args.cases, args.suite, args.repeats, args.origin)
            print(dumps({'attempt': args.output, 'planned_count': len(result['entries']),
                         'manifest': str(Path(args.output) / 'manifest.json'),
                         'notice': '评测端题单已准备；用 handoff 交接单题，collect 回收后由评测端 score-suite。'}), end=''); return 0
        if args.command == 'handoff':
            from .handoff import handoff
            print(dumps(handoff(args.attempt, args.case, args.output, args.repeat)), end=''); return 0
        if args.command == 'collect':
            from .handoff import collect
            print(dumps(collect(args.attempt, args.submission)), end=''); return 0
        if args.command == 'variant':
            from .variants import create_variant
            print(dumps(create_variant(Path(args.output), args.seed)), end=''); return 0
        if args.command == 'export':
            if bool(args.scenario_id) == bool(args.all):
                raise BenchError('指定一个 scenario_id 或 --all')
            target = Path(args.output)
            if args.all:
                if target.exists(): raise BenchError('拒绝覆盖已有批量导出目录')
                target.mkdir(parents=True)
                for case in scenarios(): export_case(case['id'], target / case['id'])
            else:
                export_case(args.scenario_id, target)
            print('题目输入已导出：' + str(target)); return 0
        if args.command == 'serve-mock':
            from .mock import running_mock
            import time
            state_dir = Path(args.state_dir)
            if state_dir.exists(): raise BenchError('拒绝覆盖已有服务观测目录')
            state_dir.mkdir(parents=True)
            with running_mock(args.scenario_id, state_dir / 'observations.json', run_id=args.run_id) as (endpoint, state):
                write_json(state_dir / 'endpoint.json', {'endpoint': endpoint, 'scenario_id': args.scenario_id,
                           'run_id': args.run_id, 'session_id': state.session_id, 'execution_fingerprint': state.execution_fingerprint})
                print('本地模拟服务：' + endpoint, flush=True)
                try:
                    while True: time.sleep(1)
                except KeyboardInterrupt:
                    return 0
        if args.command == 'validate':
            result = validate_package(); print(dumps(result), end=''); return 0 if result['valid'] else 1
        if args.command == 'score':
            if args.output and Path(args.output).exists(): raise BenchError('拒绝覆盖已有输出/原始证据')
            output_dir = Path(args.output_dir) if args.output_dir else Path(args.response).parent
            response, error = None, None
            try: response = load_json(args.response)
            except (BenchError, ValueError, OSError) as exc: error = str(exc)
            run = load_json(args.run)
            observations, self_review = None, None
            if args.observations:
                try: observations = load_json(args.observations)
                except (BenchError, ValueError, OSError): observations = {}
            if args.self_review:
                try: self_review = load_json(args.self_review)
                except (BenchError, ValueError, OSError) as exc:
                    self_review = {'invalid_self_review': str(exc)}
            report = score_auto(select(args.scenario_id), contracts(args.scenario_id)['checks'], response,
                                run, output_dir, ROOT, observations, error, self_review)
            path = Path(args.response)
            report['response_sha256'] = sha256(path) if path.is_file() and path.stat().st_size <= 5_000_000 else None
            report['run_metadata_sha256'] = sha256(args.run)
            if args.output: save_new(args.output, report)
            else: print(dumps(report), end='')
            return 0
        if args.command == 'score-suite':
            attempt = Path(args.attempt)
            output = Path(args.output) if args.output else attempt / 'report.json'
            markdown = output.with_suffix('.md')
            if output.exists() or markdown.exists(): raise BenchError('拒绝覆盖已有报告；请用 --output 指定新文件')
            if output.resolve() == markdown.resolve(): raise BenchError('JSON 报告扩展名不能为 .md')
            result = score_suite(attempt)
            save_new(output, result)
            markdown.write_text(markdown_report(result), encoding='utf-8')
            print(dumps({'report': str(output), 'readable_report': str(markdown), 'main': result['main'],
                         'notice': result['notice']}), end=''); return 0
        if args.command == 'report':
            result = aggregate_auto([load_json(x) for x in args.reports], load_json(args.manifest))
            if args.output: save_new(args.output, result)
            else: print(dumps(result), end='')
            return 0
        if args.command == 'compare':
            mapping = load_json(args.configs)
            if not isinstance(mapping, dict): raise BenchError('configs 需为配置名到 report.json 路径的对象')
            base = Path(args.configs).resolve().parent
            loaded = {}
            for name, value in mapping.items():
                if not isinstance(value, str): raise BenchError('每个配置对应一份完整题单汇总报告路径')
                path = Path(value); loaded[name] = load_json(path if path.is_absolute() else base / path)
            result = compare_reports(loaded)
            if args.output: save_new(args.output, result)
            else: print(dumps(result), end='')
            return 0
        if args.command == 'selftest':
            from .selftest import selftest
            result = selftest(Path(args.output)); print(dumps(result), end=''); return 0 if result['passed'] else 1
        if args.command == 'freeze':
            from .release import freeze
            print(dumps(freeze(ROOT)), end=''); return 0
        if args.command == 'release':
            from .release import release
            print(dumps(release(ROOT, Path(args.output))), end=''); return 0
    except (BenchError, ValueError, OSError, KeyError, TypeError) as exc:
        print('错误：' + str(exc), file=sys.stderr); return 2
    return 2
