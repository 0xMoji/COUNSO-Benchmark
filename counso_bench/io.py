"""确定性 JSON、哈希及受限文件路径。"""
from __future__ import annotations
import hashlib
import json
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_FILE_BYTES = 50_000_000
MAX_JSON_BYTES = 5_000_000
MAX_JSON_DEPTH = 128

class BenchError(ValueError):
    pass

def check_file_size(path, max_bytes=MAX_FILE_BYTES):
    info = Path(path).stat()
    if not stat.S_ISREG(info.st_mode):
        raise BenchError("只接受普通文件")
    if info.st_size > max_bytes:
        raise BenchError(f"文件超过 {max_bytes} 字节的校验上限")
    return info.st_size

def load_json(path, max_bytes=MAX_JSON_BYTES):
    check_file_size(path, max_bytes)
    with Path(path).open(encoding="utf-8") as f:
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise BenchError(f"JSON 包含重复键：{key}")
                result[key] = value
            return result
        def constant(value):
            raise BenchError(f"JSON 禁止非常数值：{value}")
        # Limit the actual read as well as stat: a concurrently growing file must
        # not bypass the resource guard.
        content = f.read(max_bytes + 1)
        if len(content.encode("utf-8")) > max_bytes:
            raise BenchError("JSON 超过校验上限")
        try:
            result = json.loads(content, object_pairs_hook=pairs, parse_constant=constant)
        except (RecursionError, json.JSONDecodeError) as exc:
            raise BenchError("JSON 语法无效或嵌套过深") from exc
        stack = [(result, 0)]
        while stack:
            value, depth = stack.pop()
            if depth > MAX_JSON_DEPTH:
                raise BenchError("JSON 嵌套超过校验上限")
            if isinstance(value, dict):
                stack.extend((v, depth + 1) for v in value.values())
            elif isinstance(value, list):
                stack.extend((v, depth + 1) for v in value)
        return result

def dumps(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(value), encoding="utf-8")

def sha256(path, max_bytes=MAX_FILE_BYTES):
    check_file_size(path, max_bytes)
    digest = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(64 * 1024), b''):
            size += len(block)
            if size > max_bytes:
                raise BenchError("文件增长超过哈希校验上限")
            digest.update(block)
    return digest.hexdigest()

def safe_path(root, relative):
    root = Path(root).resolve()
    value = Path(relative)
    if value.is_absolute() or ".." in value.parts or not value.parts:
        raise BenchError(f"禁止越界文件路径：{relative}")
    candidate = root / value
    for part in [candidate, *candidate.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise BenchError(f"禁止符号链接：{relative}")
    result = candidate.resolve()
    if not result.is_relative_to(root):
        raise BenchError(f"禁止越界文件路径：{relative}")
    return result

def get_path(value, dotted):
    current = value
    for part in dotted.split(".") if dotted else []:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            raise KeyError(dotted)
    return current
