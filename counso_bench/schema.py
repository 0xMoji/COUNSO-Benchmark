"""公开输出契约与依赖无关的验证；只验证公开声明的字段约束。"""
from __future__ import annotations
import math
import re


def validate_schema(value, schema, path='$'):
    """Validate the JSON Schema subset emitted by response_schema()."""
    errors = []
    if 'anyOf' in schema:
        if all(validate_schema(value, option, path) for option in schema['anyOf']):
            errors.append(path + '不符合允许的类型')
        return errors
    kinds = schema.get('type', [])
    if isinstance(kinds, str):
        kinds = [kinds]
    matches = {
        'null': value is None,
        'string': isinstance(value, str),
        'number': type(value) in {int, float} and math.isfinite(value),
        'integer': type(value) is int,
        'boolean': type(value) is bool,
        'array': isinstance(value, list),
        'object': isinstance(value, dict),
    }
    if kinds and not any(matches.get(kind, False) for kind in kinds):
        return [path + '类型不符']
    if 'const' in schema and (type(value) is not type(schema['const']) or value != schema['const']):
        errors.append(path + '值与公开常量不符')
    if 'enum' in schema and not any(type(value) is type(v) and value == v for v in schema['enum']):
        errors.append(path + '不在公开词表')
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0):
            errors.append(path + '不能为空')
        if 'maxLength' in schema and len(value) > schema['maxLength']:
            errors.append(path + '超过长度上限')
        if 'pattern' in schema and re.fullmatch(schema['pattern'], value) is None:
            errors.append(path + '格式不符')
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0) or len(value) > schema.get('maxItems', float('inf')):
            errors.append(path + '数组长度不符')
        if 'items' in schema:
            for i, item in enumerate(value):
                errors.extend(validate_schema(item, schema['items'], f'{path}[{i}]'))
    if isinstance(value, dict):
        properties = schema.get('properties', {})
        for key in schema.get('required', []):
            if key not in value:
                errors.append(path + '.' + key + '缺失')
        if schema.get('additionalProperties') is False:
            for key in value.keys() - properties.keys():
                errors.append(path + '.' + key + '未在公开契约声明')
        for key, item in value.items():
            child = properties.get(key, schema.get('additionalProperties'))
            if isinstance(child, dict):
                errors.extend(validate_schema(item, child, path + '.' + key))
    return errors


def validate_response(response, scenario):
    from .catalog import response_schema
    return validate_schema(response, response_schema(scenario))
