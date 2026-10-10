"""确定性 JSON、哈希及受限文件路径。"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

class BenchError(ValueError):
    pass

def load_json(path):
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
        return json.load(f, object_pairs_hook=pairs, parse_constant=constant)

def dumps(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(value), encoding="utf-8")

def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

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
