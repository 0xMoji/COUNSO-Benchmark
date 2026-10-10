from __future__ import annotations
import argparse
import sys
from pathlib import Path
from .io import ROOT, BenchError, dumps, load_json, write_json, sha256
from .catalog import scenarios, select, contracts, export_case, validate_package
from .scoring import score_response, aggregate


def save_new(path,value):
    if Path(path).exists():raise BenchError('拒绝覆盖已有输出/原始证据：'+str(path))
    write_json(path,value)

def main(argv=None):
    p=argparse.ArgumentParser(description='HISTORY-RECONSTRUCTED 离线合成评测；不会调用模型或付费服务')
    sub=p.add_subparsers(dest='command',required=True)
    q=sub.add_parser('list',help='列出本次新设计场景');q.add_argument('--group',choices=['core','stress','diagnostic'])
    q=sub.add_parser('export',help='导出候选输入，拒绝覆盖且排除金标');q.add_argument('scenario_id',nargs='?');q.add_argument('--all',action='store_true');q.add_argument('--output',required=True)
    q=sub.add_parser('serve-mock',help='启动本机受控模拟服务；服务端记录保留在评估器目录');q.add_argument('scenario_id');q.add_argument('--state-dir',required=True);q.add_argument('--run-id',required=True)
    sub.add_parser('validate',help='校验注册、输入与已冻结哈希')
    q=sub.add_parser('score',help='评估本地输出；没有候选模型调用');q.add_argument('scenario_id');q.add_argument('--response',required=True);q.add_argument('--run',required=True);q.add_argument('--output-dir');q.add_argument('--observations');q.add_argument('--adjudicated');q.add_argument('--output')
    q=sub.add_parser('report',help='同一运行来源的统计汇总');q.add_argument('reports',nargs='+');q.add_argument('--output')
    q=sub.add_parser('selftest',help='模拟参考输出与负对照；不代表候选表现');q.add_argument('--output',required=True)
    q=sub.add_parser('freeze',help='冻结本次包文件哈希，不能恢复原文件哈希')
    q=sub.add_parser('release',help='生成脱敏且确定性的本地发布ZIP；不会上传');q.add_argument('--output',required=True)
    q=sub.add_parser('compare',help='用相同已证据场景交集比较配置');q.add_argument('--configs',required=True);q.add_argument('--output')
    q=sub.add_parser('adjudicate',help='比较双审核员检查/分数，再应用裁决');q.add_argument('--review-a',required=True);q.add_argument('--review-b',required=True);q.add_argument('--decisions');q.add_argument('--output')
    args=p.parse_args(argv)
    try:
        if args.command=='list':
            selected=[s for s in scenarios() if not args.group or s['group']==args.group]
            for s in selected: print(f'{s["id"]}\t{s["group"]}\t{s["name_zh"]}\t{s["id_origin"]}')
            return 0
        if args.command=='export':
            if bool(args.scenario_id)==bool(args.all):raise BenchError('指定一个scenario_id或--all')
            target=Path(args.output)
            if args.all:
                if target.exists():raise BenchError('拒绝覆盖已有批量导出目录')
                target.mkdir(parents=True)
                for s in scenarios():export_case(s['id'],target/s['id'])
            else:export_case(args.scenario_id,target)
            print('候选输入已导出：'+str(target));return 0
        if args.command=='serve-mock':
            from .mock import running_mock
            import time
            state_dir=Path(args.state_dir)
            if state_dir.exists():raise BenchError('拒绝覆盖已有服务观测目录')
            state_dir.mkdir(parents=True)
            with running_mock(args.scenario_id,state_dir/'observations.json',run_id=args.run_id) as (endpoint,state):
                write_json(state_dir/'endpoint.json',{'endpoint':endpoint,'scenario_id':args.scenario_id,'run_id':args.run_id,'session_id':state.session_id,'execution_fingerprint':state.execution_fingerprint})
                print('模拟服务地址：'+endpoint+'（只把地址交给候选；不要交出state-dir）',flush=True)
                try:
                    while True:time.sleep(3600)
                except KeyboardInterrupt:return 0
        if args.command=='validate':
            result=validate_package();print(dumps(result),end='');return 0 if result['valid'] else 1
        if args.command=='score':
            output_dir=Path(args.output_dir) if args.output_dir else Path(args.response).parent
            response=load_json(args.response);run=load_json(args.run)
            if args.adjudicated:
                from .reviews import apply_adjudication
                run=apply_adjudication(select(args.scenario_id),run,load_json(args.adjudicated))
            report=score_response(select(args.scenario_id),contracts(args.scenario_id)['checks'],response,run,output_dir,ROOT,observations=load_json(args.observations) if args.observations else None)
            if args.adjudicated:report['adjudication_sha256']=sha256(args.adjudicated);report['adjudication_applied']=load_json(args.adjudicated)
            if args.observations:report['observation_file_sha256']=sha256(args.observations)
            report['response_sha256']=sha256(args.response);report['run_metadata_sha256']=sha256(args.run)
            report['fixture_hashes']=[{'path':i['path'],'sha256':sha256(ROOT/'fixtures'/i['path'])} for i in select(args.scenario_id)['inputs']]
            if args.output:save_new(args.output,report)
            else:print(dumps(report),end='')
            return 0
        if args.command=='report':
            result=aggregate([load_json(x) for x in args.reports])
            if args.output:save_new(args.output,result)
            else:print(dumps(result),end='')
            return 0
        if args.command=='selftest':
            from .selftest import selftest
            result=selftest(Path(args.output));print(dumps(result),end='');return 0 if result['passed'] else 1
        if args.command=='freeze':
            from .release import freeze
            print(dumps(freeze(ROOT)),end='');return 0
        if args.command=='release':
            from .release import release
            print(dumps(release(ROOT,Path(args.output))),end='');return 0
        if args.command=='compare':
            from .reviews import compare_configurations
            mapping=load_json(args.configs)
            result=compare_configurations({k:[load_json(f) for f in paths] for k,paths in mapping.items()})
            if args.output:save_new(args.output,result)
            else:print(dumps(result),end='')
            return 0
        if args.command=='adjudicate':
            from .reviews import adjudicate
            result=adjudicate(load_json(args.review_a),load_json(args.review_b),load_json(args.decisions) if args.decisions else None)
            if args.output:save_new(args.output,result)
            else:print(dumps(result),end='')
            return 0
    except (BenchError,ValueError,OSError,KeyError) as exc:
        print('错误：'+str(exc),file=sys.stderr);return 2
    return 2
