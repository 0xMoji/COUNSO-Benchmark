"""Assessor-owned handoff and collection; never runs the candidate or a sandbox."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import tempfile
from urllib.parse import urlsplit

from .automation import VERSION, _digest, validate_manifest
from .catalog import export_case, select
from .io import ROOT, BenchError, load_json, safe_path, sha256, write_json

MAX_FILES = 30_000
MAX_TOTAL_BYTES = 200_000_000
MAX_FILE_BYTES = 50_000_000


def _plain_path(path):
    """Reject links/reparse points before resolving a transfer path."""
    path = Path(path).absolute()
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise BenchError('交接路径不接受符号链接或重解析点：' + str(item))
    return path.resolve()


def _entry(manifest, scenario_id, repeat):
    if type(repeat) is not int:
        raise BenchError('repeat 必须为整数')
    found = [e for e in manifest['entries'] if
             e['scenario_id'] == scenario_id and e['repeat'] == repeat]
    if len(found) != 1:
        raise BenchError('题目/重复编号不在本次题单中')
    return found[0]


def _ticket(manifest, entry):
    return {'schema_version': VERSION, 'kind': 'CANDIDATE_HANDOFF_1',
            'attempt_id': manifest['attempt_id'], 'run_id': entry['run_id'],
            'scenario_id': entry['scenario_id'], 'repeat': entry['repeat'],
            'suite_fingerprint': manifest['suite_fingerprint'],
            'input_sha256': _digest(entry['input_hashes'])}


def handoff(attempt, scenario_id, output, repeat=1, root=ROOT):
    """Export exactly one public input bundle, apart from the assessor checkout."""
    attempt, output, root = map(_plain_path, (attempt, output, root))
    for private in (root, attempt):
        if output.is_relative_to(private) or private.is_relative_to(output):
            raise BenchError('作答包必须放在源码和评测目录之外，不能互相包含')
    if output.exists():
        raise BenchError('拒绝覆盖已有作答包')
    manifest = validate_manifest(load_json(attempt / 'manifest.json'), root)
    entry = _entry(manifest, scenario_id, repeat)
    endpoint = None
    if entry.get('service_required'):
        path = safe_path(attempt, entry['endpoint_path'])
        if not path.is_file():
            raise BenchError('请评测端先按本题 run_id 启动 serve-mock，再导出作答包')
        service = load_json(path)
        if any(service.get(k) != v for k, v in {
            'run_id': entry['run_id'], 'scenario_id': scenario_id,
            'execution_fingerprint': manifest['suite_fingerprint'],
        }.items()) or not service.get('session_id'):
            raise BenchError('mock 服务与本次题目身份不一致')
        url = urlsplit(service.get('endpoint', ''))
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.username or url.password:
            raise BenchError('只接受本题本机 mock 入口')
        endpoint = service['endpoint']
    output.mkdir(parents=True)
    # Re-export from the frozen source, never copy the assessor's working tree.
    export_case(scenario_id, output / 'input', root)
    (output / 'output').mkdir()
    write_json(output / 'ticket.json', _ticket(manifest, entry))
    instructions = (
        '# COUNSO-Benchmark 单题作答\n\n'
        '在新的会话中，只完成本包这一题。读取 input/prompt.txt、'
        'input/response_schema.json 和 input/inputs 中的材料；存在 '
        'input/artifact_schemas.json 时同时遵守。\n\n'
        '将 response.json 与所需文件写到 output/，产物路径相对 output/。'
        '可以检查、预览自己的产物。完成后交回 ticket.json 和 output/；'
        '保持 ticket.json 不变，由评测端核验。无需安装或访问评测源码。\n\n'
        '保持当前 Agent、工具和设置，按任务要求完成工作。'
        '不要寻找参考答案、访问评测仓库或其他题的产物。'
        '不要在 output/ 创建 .assessor 目录。\n'
    )
    if endpoint:
        write_json(output / 'endpoint.json', {'endpoint': endpoint})
        instructions += ('\n本题服务地址见 endpoint.json；用 input/inputs/mock_client.py '
                         '访问。服务由评测端维护，不需要启动服务或生成观测日志。\n')
    if select(scenario_id, root).get('capability') == 'generative_ui':
        shutil.copyfile(root / 'counso_bench/candidate_preview.py', output / 'preview.py')
        instructions += ('\nUI 可在包目录执行 `python preview.py --entry output/ui/index.html` '
                         '预览；按实际入口修改路径。它只读取本包公开材料，不评分。\n')
    (output / 'START.md').write_text(instructions, encoding='utf-8', newline='\n')
    return {'bundle': str(output), 'run_id': entry['run_id'],
            'notice': '只把此单题包交给作答沙箱。导出不设置 OS 权限；宿主须隔离源码、答案、其他作答和评测日志。'}


def _inventory(directory):
    directory = _plain_path(directory)
    if not directory.is_dir():
        raise BenchError('提交必须包含 output 目录；未作答时可为空')
    files, total = [], 0
    for current, dirs, names in os.walk(directory):
        for name in dirs + names:
            path = _plain_path(Path(current) / name)
            relative = path.relative_to(directory).as_posix()
            if '.assessor' in relative.split('/'):
                raise BenchError('候选不能提交 .assessor 核验器证据')
            info = path.stat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise BenchError('只接受普通产物文件')
            total += info.st_size
            if len(files) >= MAX_FILES or total > MAX_TOTAL_BYTES or info.st_size > MAX_FILE_BYTES:
                raise BenchError('提交超过文件数量或字节上限')
            files.append({'path': relative, 'bytes': info.st_size, 'sha256': sha256(path)})
    return sorted(files, key=lambda item: item['path'])


def collect(attempt, submission, root=ROOT):
    """Import only output files. Candidate run/config/observations are never used."""
    attempt, submission = map(_plain_path, (attempt, submission))
    if submission.is_relative_to(attempt) or attempt.is_relative_to(submission):
        raise BenchError('提交包与评测目录不能互相包含')
    manifest = validate_manifest(load_json(attempt / 'manifest.json'), root)
    ticket = load_json(_plain_path(submission / 'ticket.json'))
    if not isinstance(ticket, dict):
        raise BenchError('ticket.json 必须为对象')
    entry = _entry(manifest, ticket.get('scenario_id'), ticket.get('repeat'))
    if ticket != _ticket(manifest, entry):
        raise BenchError('提交身份与本次题目/重复编号/输入不一致')
    destination = _plain_path(safe_path(attempt, entry['output_dir']))
    receipt_path = _plain_path(destination.parent / 'collected.json')
    if receipt_path.exists() or destination.exists() and any(destination.iterdir()):
        raise BenchError('拒绝覆盖已回收提交或已有产物；重试请新建尝试')
    source = _plain_path(submission / 'output')
    files = _inventory(source)
    stage = Path(tempfile.mkdtemp(prefix='.collect-', dir=destination.parent))
    try:
        for item in files:
            src = _plain_path(safe_path(source, item['path']))
            target = safe_path(stage, item['path'])
            target.parent.mkdir(parents=True, exist_ok=True)
            with src.open('rb') as reader, target.open('xb') as writer:
                remaining = item['bytes']
                while remaining:
                    block = reader.read(min(remaining, 65536))
                    if not block:
                        raise BenchError('回收过程中产物发生变化')
                    writer.write(block)
                    remaining -= len(block)
                if reader.read(1):
                    raise BenchError('回收过程中产物增长')
            if sha256(target) != item['sha256']:
                raise BenchError('回收过程中产物发生变化')
        if destination.exists():
            destination.rmdir()  # Only an empty assessor-owned output directory.
        stage.rename(destination)
        receipt = {'run_id': entry['run_id'], 'files': files,
                   'notice': '仅回收候选产物；评分、模型配置和服务观测均来自评测端。'}
        write_json(receipt_path, receipt)
        return {'run_id': entry['run_id'], 'collected_files': len(files), 'receipt': str(receipt_path)}
    finally:
        if stage.exists():
            if stage.resolve().parent != destination.parent.resolve():
                raise BenchError('临时回收路径越界，拒绝清理')
            shutil.rmtree(stage)
