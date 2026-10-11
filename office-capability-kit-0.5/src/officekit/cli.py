import argparse
import json
import sys
from pathlib import Path
from . import __version__
from .exchange import prepare,grade,grade_ui
from .providers import ReferenceProvider, ReplayProvider, StdioSessionProvider
from .registry import REGISTRY
from .runner import run


def main(argv=None):
    parser=argparse.ArgumentParser(prog="officekit",description="Portable office fixture runner. No live model calls or credentials.")
    parser.add_argument("--version",action="version",version=__version__)
    sub=parser.add_subparsers(dest="command",required=True)
    sub.add_parser("list",help="List the six fixed case registry slots")
    execute=sub.add_parser("run",help="Execute deterministic reference or recorded action fixture")
    execute.add_argument("--provider",choices=["reference","replay"],required=True)
    execute.add_argument("--replay",help="Versioned JSON action tape required by replay provider")
    execute.add_argument("--mutation",choices=["wrong-total","forbidden-query","missing-file","wrong-entity","null-entity","duplicate-retry","unbound-claim"],help="Reference-only deliberate negative control, not a model sample")
    session=sub.add_parser("session",help="JSONL actual tool feedback loop for an external trusted wrapper; live model identity UNKNOWN")
    for command in (execute,session):
        command.add_argument("--case",choices=list(REGISTRY),required=True)
        command.add_argument("--output",required=True)
        command.add_argument("--max-tool-calls",type=int,default=32)
    export=sub.add_parser("prepare",help="Export public prompt, synthetic input, tool schema; no gold or model")
    export.add_argument("--case",choices=list(REGISTRY),required=True)
    export.add_argument("--output",required=True)
    importer=sub.add_parser("grade",help="Independently grade file artifacts; external tool provenance remains UNKNOWN")
    importer.add_argument("--bundle",required=True)
    importer.add_argument("--artifacts",required=True,help="Candidate root containing outputs/<filenames>")
    importer.add_argument("--candidate",required=True,help="Structured final candidate JSON")
    importer.add_argument("--ledger",help="External raw ledger, kept as unverified evidence")
    importer.add_argument("--state",help="External raw state, kept as unverified evidence")
    importer.add_argument("--output",required=True)
    ui_import=sub.add_parser("grade-ui",help="Aggregate a repository UI adapter report; imported browser claims remain UNKNOWN")
    ui_import.add_argument("--report",required=True)
    ui_import.add_argument("--output",required=True)
    args=parser.parse_args(argv)
    if args.command=="list":
        print(json.dumps(REGISTRY,indent=2,sort_keys=True));return 0
    if args.command in ("run","session") and not 1<=args.max_tool_calls<=1000:
        parser.error("--max-tool-calls must be between 1 and 1000")
    if args.command=="run":
        if args.provider=="replay" and (not args.replay or args.mutation):parser.error("Replay requires --replay and cannot use --mutation")
        if args.provider=="reference" and args.replay:parser.error("Reference does not accept --replay")
        allowed={"office-data":{"wrong-total","forbidden-query","missing-file"},"office-evidence":{"wrong-entity","null-entity"},"office-tools":{"unbound-claim"},"office-recovery":{"duplicate-retry","unbound-claim"}}
        if args.mutation and args.mutation not in allowed.get(args.case,set()):parser.error("Mutation is not defined for this case")
    try:
        if args.command=="prepare":
            result=prepare(args.case,args.output)
            print(json.dumps({"type":"public_bundle","case":args.case,"bundle":str(Path(args.output).absolute()/"public_bundle.json"),"live_capability":"UNKNOWN"},sort_keys=True));return 0
        if args.command=="grade-ui":
            report=grade_ui(args.report,args.output)
        elif args.command=="grade":
            report=grade(args.bundle,args.artifacts,args.candidate,args.output,args.ledger,args.state)
        else:
            provider=StdioSessionProvider() if args.command=="session" else ReferenceProvider(args.mutation) if args.provider=="reference" else ReplayProvider(args.replay)
            report=run(args.case,provider,args.output,args.max_tool_calls)
    except (ValueError,OSError,KeyError,NotImplementedError) as exc:
        print(f"officekit: {exc}",file=sys.stderr);return 2
    print(json.dumps({"type":"run_result","case":report["case_id"],"provider_kind":report["provider"]["kind"],"judgment":report["result"]["judgment"],"score_lower":report["result"]["score_lower"],"score_upper":report["result"]["score_upper"],"quality_complete":report["result"]["quality_complete"],"report":str(Path(args.output).absolute()/"report.json"),"live_capability":"UNKNOWN"},sort_keys=True))
    return 0 if report["result"]["judgment"]=="PASS" else 1
