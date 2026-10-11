#!/usr/bin/env python3
"""Public agent's static handoff helper. No model, ledger import or functional PASS."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys


def safe_file(root, name):
    if not isinstance(name,str) or not name or name.startswith('/') or '\\' in name:raise ValueError('Expected a relative POSIX artifact path')
    rel=PurePosixPath(name)
    if rel.as_posix()!=name or '..' in rel.parts or '.' in rel.parts:raise ValueError('Artifact path must stay canonical and relative')
    p=root/name
    for item in [p,*p.parents]:
        if item==root.parent:break
        if item.is_symlink():raise ValueError('Artifact symlinks are unsupported')
    if not p.is_file() or not p.resolve().is_relative_to(root.resolve()):raise ValueError('Declared static artifact is missing or outside submission')
    b=p.read_bytes();return {'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}


def submit(bundle):
    root=Path(bundle).absolute();mp=root/'AGENT_TASK_MANIFEST.json'
    if mp.is_symlink():raise ValueError('Task manifest symlink is unsupported')
    manifest=json.loads(mp.read_text(encoding='utf-8'))
    if not isinstance(manifest,dict) or manifest.get('schema_version')!='officekit-agent-task-1':raise ValueError('Public agent task manifest is required')
    out=root/'submission'
    if out.is_symlink():raise ValueError('Submission directory symlink is unsupported')
    if manifest['family']=='office':
        candidate=safe_file(out,'candidate.json');value=json.loads((out/'candidate.json').read_text())
        if not isinstance(value,dict) or set(value)-{'artifacts','completed_actions','facts','text'} or not isinstance(value.get('artifacts'),list) or any(not isinstance(p,str) for p in value['artifacts']):raise ValueError('Final candidate artifacts must be relative path strings')
        rows=[candidate];claims=value['artifacts'];authority='OPERATOR_HOST_RECEIPT_REQUIRED_NOT_CANDIDATE_LEDGER'
    elif manifest['family']=='ui':
        response=safe_file(out,'response.json');value=json.loads((out/'response.json').read_text())
        if not isinstance(value,dict) or set(value)-{'artifacts','limitations'} or not isinstance(value.get('artifacts'),list) or not value['artifacts'] or any(not isinstance(p,str) for p in value['artifacts']) or len(value['artifacts'])!=len(set(value['artifacts'])):raise ValueError('response.json requires unique relative path strings')
        if 'index.html' not in value['artifacts']:raise ValueError('Standalone index.html must be declared')
        rows=[response]+[safe_file(out,name) for name in value['artifacts']];claims=value['artifacts'];authority='INDEPENDENT_ACTUAL_BROWSER_REQUIRED'
        if (out/'action-mapping.json').exists() and 'action-mapping.json' not in claims:rows.append(safe_file(out,'action-mapping.json'))
        allowed={x['path'] for x in rows}
        if any(p.is_file() and p.relative_to(out).as_posix() not in allowed for p in out.rglob('*')):raise ValueError('Undeclared static files are not submitted')
    else:raise ValueError('Unsupported task family')
    handoff={'schema_version':'officekit-agent-handoff-1','case_id':manifest['case_id'],'public_task_fingerprint':manifest['task_fingerprint'],'status':'STATIC_HANDOFF_PREPARED','candidate_directory':'submission','candidate_files':rows,'claimed_artifacts':claims,'tool_or_browser_authority':authority,'functional_status':'UNKNOWN_PENDING_INDEPENDENT_EVALUATION','model_backend':'PLATFORM_SUPPLIED_UNKNOWN','no_model_api_or_credentials':True}
    p=root/'handoff.json'
    if p.exists() or p.is_symlink():raise ValueError('Handoff already exists; preserve original and use a fresh public task run')
    p.write_text(json.dumps(handoff,sort_keys=True,indent=2)+'\n',encoding='utf-8')
    return handoff


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',default='.');a=p.parse_args(argv)
    try:r=submit(a.bundle)
    except (OSError,ValueError,TypeError,KeyError) as exc:print(json.dumps({'status':'HANDOFF_NOT_PREPARED','functional_status':'UNKNOWN','error':str(exc)}));return 2
    print(json.dumps(r,sort_keys=True));return 0

if __name__=='__main__':raise SystemExit(main())
