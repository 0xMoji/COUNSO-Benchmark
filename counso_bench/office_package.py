"""Bounded OOXML package loading, shared by workbook and presentation checks.

All entries, including images, are retained so an XML relationship is checked
against the actual ZIP package rather than an XML-only view of that package.
"""
from __future__ import annotations

from pathlib import Path
import posixpath
import re
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile

from .io import BenchError

REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
MAIN_TYPES = {
    'xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
}


def resolve_relationship_target(source, target):
    """Resolve an OPC internal relationship relative to its source part."""
    if not isinstance(target, str) or not target or '\\' in target:
        raise BenchError('Office关系目标为空或无效')
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise BenchError('Office关系目标不是本地包部件')
    target = unquote(parsed.path)
    if '\\' in target or '\x00' in target:
        raise BenchError('Office关系目标无效')
    resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(source), target))
    if resolved in {'', '.', '..'} or resolved.startswith('../') or resolved.startswith('/'):
        raise BenchError('Office关系目标越界')
    return resolved


def relationship_map(parts, source):
    relpath = (posixpath.dirname(source) + '/_rels/' + posixpath.basename(source) + '.rels') if source else '_rels/.rels'
    relpath = relpath.lstrip('/')
    if relpath not in parts:
        return {}
    root = ET.fromstring(parts[relpath])
    if root.tag != '{' + REL_NS + '}Relationships':
        raise BenchError('Office关系文档命名空间无效')
    result = {}
    for rel in root:
        if rel.tag != '{' + REL_NS + '}Relationship':
            raise BenchError('Office关系文档包含无效元素')
        rid, kind = rel.attrib.get('Id'), rel.attrib.get('Type', '')
        if not rid or rid in result or not kind:
            raise BenchError('Office关系ID重复或缺少必要属性')
        if rel.attrib.get('TargetMode', '').lower() == 'external':
            raise BenchError('本题只允许自包含Office文件，外部关系不在允许范围')
        target = resolve_relationship_target(source, rel.attrib.get('Target', ''))
        if target not in parts:
            raise BenchError('Office关系目标缺失')
        result[rid] = {'target': target, 'type': kind}
    return result


def read_office_parts(path, max_bytes=50_000_000):
    """Read a valid, self-contained XLSX/PPTX package within explicit limits."""
    path = Path(path)
    if path.stat().st_size > max_bytes:
        raise BenchError('Office文件超过校验大小上限')
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise BenchError('Office包含重名条目')
            if len(names) > 10_000 or sum(info.file_size for info in infos) > max_bytes:
                raise BenchError('Office解压内容超过校验上限')
            for info in infos:
                name = info.filename
                if not name or name.startswith('/') or '\\' in name or '..' in name.split('/') or '\x00' in name:
                    raise BenchError('Office包含越界条目')
                if re.search(r'(^|/)vba[^/]*', name, re.I) or name.lower().endswith('.bin'):
                    raise BenchError('Office宏/二进制嵌入不在本题允许范围')
                if info.flag_bits & 1:
                    raise BenchError('Office加密条目不受支持')
            parts = {info.filename: archive.read(info) for info in infos if not info.is_dir()}
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise BenchError('Office ZIP包无法读取') from exc
    for required in ('[Content_Types].xml', '_rels/.rels'):
        if required not in parts:
            raise BenchError('Office缺少必要包元数据：' + required)
    for name, body in parts.items():
        if name.endswith(('.xml', '.rels')):
            if b'<!DOCTYPE' in body.upper() or b'<!ENTITY' in body.upper():
                raise BenchError('Office XML禁止DTD/实体声明')
            try:
                ET.fromstring(body)
            except ET.ParseError as exc:
                raise BenchError('Office XML无法解析：' + name) from exc
    content = ET.fromstring(parts['[Content_Types].xml'])
    if content.tag != '{' + CT_NS + '}Types':
        raise BenchError('Office内容类型文档无效')
    defaults, overrides = {}, {}
    for entry in content:
        kind = entry.attrib.get('ContentType', '')
        if not kind:
            raise BenchError('Office内容类型声明为空')
        if entry.tag == '{' + CT_NS + '}Default':
            key = entry.attrib.get('Extension', '').lower()
            if not key or key in defaults:
                raise BenchError('Office默认内容类型重复或无效')
            defaults[key] = kind
        elif entry.tag == '{' + CT_NS + '}Override':
            raw = entry.attrib.get('PartName', '')
            if not raw.startswith('/'):
                raise BenchError('Office部件内容类型名称无效')
            key = resolve_relationship_target('', raw)
            if key in overrides:
                raise BenchError('Office部件内容类型重复')
            # Some common producers retain content-type overrides for unused
            # slide masters. They are not relationship targets and do not make
            # an actual part available; validate actual parts and links below.
            overrides[key] = kind
        else:
            raise BenchError('Office内容类型文档包含无效元素')
    for name in parts:
        if name == '[Content_Types].xml':
            continue
        if name not in overrides and name.rsplit('.', 1)[-1].lower() not in defaults:
            raise BenchError('Office部件没有内容类型：' + name)
    root_rels = relationship_map(parts, '')
    entries = [rel['target'] for rel in root_rels.values() if rel['type'].endswith('/officeDocument')]
    if len(entries) != 1 or entries[0] not in MAIN_TYPES:
        raise BenchError('Office根入口关系缺失或不受支持')
    main = entries[0]
    if overrides.get(main, defaults.get(main.rsplit('.', 1)[-1])) != MAIN_TYPES[main]:
        raise BenchError('Office主文档内容类型无效')
    for name in parts:
        if not name.endswith('.rels') or name == '_rels/.rels':
            continue
        directory, base = posixpath.split(name)
        if posixpath.basename(directory) != '_rels':
            raise BenchError('Office关系部件路径无效')
        source = posixpath.join(posixpath.dirname(directory), base[:-5])
        if source not in parts:
            raise BenchError('Office关系来源部件缺失')
        relationship_map(parts, source)
    return parts
