"""文件清单及发布ZIP。只包含明确允许的脱敏包文件。"""
from __future__ import annotations
from pathlib import Path
import zipfile
from .io import BenchError, sha256, write_json

ALLOWED_DIRS={'counso_bench','catalog','fixtures','gold','provenance','docs','tests','.github','examples'}
ALLOWED_ROOT={'README.md','pyproject.toml','.gitignore','.gitattributes','CHANGELOG.md','LICENSE-NOTICE.md','RUNBOOK.md','INDEPENDENT_REVIEW.md','AGENT-START.md','package.json','package-lock.json'}

def files(root):
    root=Path(root)
    out=[]
    for p in sorted(root.rglob('*'),key=lambda path:path.relative_to(root).as_posix()):
        if not p.is_file() or p.is_symlink():continue
        r=p.relative_to(root)
        if '__pycache__' in r.parts or p.suffix in {'.pyc','.pyo'}:continue
        if (len(r.parts)==1 and r.name in ALLOWED_ROOT) or (len(r.parts)>1 and r.parts[0] in ALLOWED_DIRS):
            if any(part.startswith('.env') for part in r.parts):raise BenchError('发布白名单包含.env文件，拒绝发布')
            out.append(p)
    return out

def freeze(root):
    root=Path(root)
    manifest=root/'provenance/file_manifest.json'
    items=[{'path':p.relative_to(root).as_posix(),'sha256':sha256(p),'bytes':p.stat().st_size} for p in files(root) if p!=manifest]
    result={'schema_version':'AUTO-0.2','suite_label':'HISTORY-RECONSTRUCTED','hash_origin':'NEW_PACKAGE_BYTES_NOT_ORIGINAL','files':items}
    write_json(manifest,result)
    return {'file_count':len(items),'manifest_sha256':sha256(manifest),'notice':'只标识本次文件字节；无原包哈希可对照。'}

def release(root,output):
    root=Path(root)
    output=Path(output)
    if output.exists():raise BenchError('拒绝覆盖已有ZIP')
    if output.resolve().is_relative_to(root.resolve()):raise BenchError('ZIP必须写到包目录外，以免自包含')
    from .catalog import validate_package
    check=validate_package(root)
    if not check['valid']:raise BenchError('包校验未通过：'+str(check['errors']))
    if not (root/'provenance/file_manifest.json').is_file():raise BenchError('请先freeze冻结文件清单')
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in files(root):
            info=zipfile.ZipInfo('COUNSO-Benchmark/'+p.relative_to(root).as_posix(),date_time=(2026,10,8,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644 << 16
            z.writestr(info,p.read_bytes())
    return {'path':str(output),'sha256':sha256(output),'bytes':output.stat().st_size,'notice':'本地脱敏可发布包；未上传或发布。完整源码含参考答案；自助作答先只读导出的输入包，完成后再调用评分。'}
