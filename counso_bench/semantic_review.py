"""Evidence-bound candidate self-evaluation; never calls a model or changes scores."""
from __future__ import annotations

from pathlib import Path

from .io import BenchError, safe_path, sha256

TEMPLATE_VERSION = 'AUTO-0.2-SELF-REVIEW-1'
DIMENSIONS = ('facts', 'completeness', 'usability')
TEXT_SUFFIXES = {'.txt', '.md', '.html', '.htm', '.js', '.css', '.py', '.sql', '.log', '.xml'}
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def _locator_exists(path, locator):
    """Validate locations we can inspect without extra packages.

    A whole-image/document locator identifies bytes only; it does not establish
    that an image/PDF was rendered by an assessor or supports a semantic claim.
    """
    suffix = path.suffix.lower()
    if suffix in {'.json', '.csv', '.xlsx', '.pptx'} or suffix in TEXT_SUFFIXES:
        from .checks import _citation_locator
        return _citation_locator(path, locator)
    if suffix in IMAGE_SUFFIXES:
        if locator != 'image:whole':
            return False
        with path.open('rb') as stream:
            header = stream.read(16)
        if suffix == '.png':
            return header.startswith(b'\x89PNG\r\n\x1a\n')
        if suffix in {'.jpg', '.jpeg'}:
            return header.startswith(b'\xff\xd8\xff')
        if suffix == '.gif':
            return header.startswith((b'GIF87a', b'GIF89a'))
        return header.startswith(b'RIFF') and header[8:12] == b'WEBP'
    if suffix == '.pdf':
        if locator != 'document':
            return False
        with path.open('rb') as stream:
            return stream.read(1024).lstrip().startswith(b'%PDF-')
    return False


def validate_self_review(value, output_dir):
    """Return validation metadata, without mutating or raising on a bad review.

    The caller retains ``value`` as submitted and binds this metadata to its
    run/scenario/input/artifact record. Evidence hashes identify local files at
    validation time. This is self-evaluation, not an independent judgement.
    """
    errors, evidence = [], []
    scores = {name: None for name in DIMENSIONS}
    result = {'valid': False, 'errors': errors, 'template_version': None,
              'dimension_scores': scores, 'evidence': evidence}
    if not isinstance(value, dict):
        errors.append('self_review 必须是 JSON 对象')
        return result
    version = value.get('template_version')
    result['template_version'] = version if isinstance(version, str) else None
    if version != TEMPLATE_VERSION:
        errors.append('template_version 必须为 ' + TEMPLATE_VERSION)
    required = {'template_version', 'dimensions', 'commentary', 'known_limitations'}
    if set(value) != required:
        errors.append('self_review 顶层字段须完整且仅包含公开模板字段')
    commentary = value.get('commentary')
    if not isinstance(commentary, str) or len(commentary) > 4000:
        errors.append('commentary 须为最多 4000 字的字符串')
    limitations = value.get('known_limitations')
    if not isinstance(limitations, list) or len(limitations) > 20 or any(
            not isinstance(item, str) or not item.strip() or len(item) > 1000
            for item in limitations):
        errors.append('known_limitations 须为最多 20 项非空短字符串，每项最多 1000 字')
    dimensions = value.get('dimensions')
    if not isinstance(dimensions, dict):
        errors.append('dimensions 必须是对象')
        return result
    if set(dimensions) != set(DIMENSIONS):
        errors.append('dimensions 必须完整包含 facts/completeness/usability')
    hashes = {}
    for name in DIMENSIONS:
        dimension = dimensions.get(name)
        prefix = 'dimensions.' + name
        if not isinstance(dimension, dict):
            errors.append(prefix + '必须是对象')
            continue
        if set(dimension) != {'score', 'reason', 'evidence'}:
            errors.append(prefix + '须完整包含 score/reason/evidence')
        score = dimension.get('score')
        score_valid = score is None or type(score) is int and 0 <= score <= 4
        if not score_valid:
            errors.append(prefix + '.score 必须为 0–4 整数或 null，布尔值不是分数')
        elif 'score' in dimension:
            scores[name] = score
        reason = dimension.get('reason')
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
            errors.append(prefix + '.reason 须为 1–1000 字的简短理由')
        items = dimension.get('evidence')
        if not isinstance(items, list) or len(items) > 20:
            errors.append(prefix + '.evidence 须为最多 20 项的数组')
            continue
        if score is not None and not items:
            errors.append(prefix + '已知分数须至少列一项本地产物证据；无法确认时填写 null')
        for index, item in enumerate(items):
            label = prefix + '.evidence[' + str(index) + ']'
            if not isinstance(item, dict) or set(item) != {'path', 'locator', 'claim'}:
                errors.append(label + '须完整包含 path/locator/claim')
                continue
            if any(not isinstance(item[field], str) or not item[field].strip() or
                   len(item[field]) > (4096 if field == 'path' else 1000)
                   for field in ('path', 'locator', 'claim')):
                errors.append(label + '各字段须为长度受限的非空字符串')
                continue
            try:
                path = safe_path(output_dir, item['path'])
                if not path.is_file():
                    raise BenchError('证据必须是实际存在的普通文件')
                if path not in hashes:
                    hashes[path] = sha256(path)
                if not _locator_exists(path, item['locator']):
                    raise BenchError('证据定位不存在或不符合公开定位格式')
                evidence.append({'dimension': name, 'path': item['path'],
                                 'locator': item['locator'], 'claim': item['claim'],
                                 'sha256': hashes[path]})
            except (BenchError, ValueError, TypeError, KeyError, IndexError, OSError) as exc:
                errors.append(label + '无效：' + str(exc))
            except Exception as exc:
                # A supplemental review cannot abort objective scoring.
                errors.append(label + '无法核验：' + type(exc).__name__)
    result['valid'] = not errors
    return result
