"""Frozen, reproducible sales-data variants for three declared UI tasks only."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil

from .io import ROOT, BenchError, load_json, safe_path, sha256, write_json
from .release import ALLOWED_DIRS, ALLOWED_ROOT, files, freeze

SUPPORTED_CASES = ['R-U01-dashboard','R-U05-iterative-edit','R-U06-data-update']
SALES_FILES = ['extensions/sales.json','extensions/sales-updated.json','extensions/sales-partial.json']
ALGORITHM = 'UI-SALES-SHA256-CENTS-ORDER-v1'

def _digest(seed, domain, ident):
    return hashlib.sha256(f'{ALGORITHM}\n{seed}\n{domain}\n{ident}'.encode('utf-8')).hexdigest()

def _refuse_symlinks(root):
    """release.files skips links; variant creation must reject links rather than omit them."""
    if root.is_symlink():raise BenchError('Variant source root cannot be a symlink')
    for item in root.iterdir():
        if item.name not in ALLOWED_DIRS | ALLOWED_ROOT:continue
        if item.is_symlink():raise BenchError('Variant source whitelist contains a symlink: '+item.name)
        if not item.is_dir():continue
        for current,dirs,names in os.walk(item,followlinks=False):
            dirs[:]=[name for name in dirs if name not in {'__pycache__','.git','runs'}]
            for name in dirs+names:
                candidate=Path(current)/name
                if candidate.is_symlink():raise BenchError('Variant source whitelist contains a symlink: '+str(candidate.relative_to(root)))

def create_variant(output, seed, root=ROOT):
    """Copy release whitelist, perturb supported fixtures, record provenance, then freeze.

    This creates data only. It neither starts an agent nor schedules any runs.
    No timestamps or output paths enter the copied bytes, so identical source
    bytes plus seed produce an identical frozen package.
    """
    if not isinstance(seed,int) or isinstance(seed,bool):raise BenchError('Variant seed must be an integer')
    root=Path(root);output=Path(output)
    if output.exists() or output.is_symlink():raise BenchError('Refusing to overwrite an existing variant directory')
    # Reject symlink ancestors before resolving, including a dangling output link.
    for ancestor in (output,*output.parents):
        if ancestor.is_symlink():raise BenchError('Variant output path cannot use symlink ancestors')
    _refuse_symlinks(root)
    root=root.resolve();output=output.resolve()
    if output.is_relative_to(root):raise BenchError('Variant directory must be outside the source package')
    source_files=[p for p in files(root) if not any(part in {'.git','runs'} for part in p.relative_to(root).parts)]
    if not source_files:raise BenchError('Variant source release whitelist is empty')
    registered=load_json(root/'catalog/scenarios.json')['scenarios']
    registered_ids={case['id'] for case in registered}
    if not set(SUPPORTED_CASES).issubset(registered_ids):raise BenchError('Supported UI tasks are missing from source package')
    output.mkdir(parents=True,exist_ok=False)
    try:
        for source in source_files:
            relative=source.relative_to(root).as_posix();target=safe_path(output,relative)
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        seen={};changed=[]
        for relative in SALES_FILES:
            source=safe_path(root/'fixtures',relative);target=safe_path(output/'fixtures',relative)
            content=load_json(source)
            for row in content['data']:
                ident=row['id']
                if row.get('amount') is None:continue
                if ident not in seen:
                    raw=int(_digest(seed,'amount',ident)[:16],16)
                    cents=-(1000+raw%39001) if row['amount']<0 else 15000+raw%185001
                    seen[ident]=cents/100
                row['amount']=seen[ident]
            content['data'].sort(key=lambda row:(_digest(seed,'order',row['id']),row['id']))
            write_json(target,content)
            changed.append({'path':'fixtures/'+relative,'original_sha256':sha256(source),'variant_sha256':sha256(target)})
        provenance={
            'schema_version':'AUTO-0.2','variant_origin':'NEW_SYNTHETIC_SEEDED_DATA',
            'seed':seed,'algorithm':ALGORITHM,'supported_cases':SUPPORTED_CASES,
            'unchanged_cases':sorted(registered_ids-set(SUPPORTED_CASES)),
            'changed_files':changed,
            'scope':'Only sales amount values and input ordering for the declared three UI cases vary. Other tasks are byte-preserved; this is not suite-wide seeded coverage.',
            'source_manifest_sha256':sha256(root/'provenance/file_manifest.json') if (root/'provenance/file_manifest.json').is_file() else None,
        }
        write_json(output/'provenance/variant.json',provenance)
        frozen=freeze(output)
        from .catalog import validate_package
        valid=validate_package(output)
        if not valid['valid']:raise BenchError('Frozen variant validation failed: '+str(valid['errors']))
        return {'output':str(output),'seed':seed,'algorithm':ALGORITHM,'supported_cases':SUPPORTED_CASES,
                'unchanged_case_count':len(provenance['unchanged_cases']),'changed_files':changed,**frozen,
                'notice':'Frozen local data variant; no model or agent was called. Only the three declared sales UI cases vary.'}
    except Exception:
        shutil.rmtree(output)
        raise
