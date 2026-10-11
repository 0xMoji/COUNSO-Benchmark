"""对本次输出schema做无依赖验证；UNKNOWN不靠JSON字段省略表示。"""
from __future__ import annotations

def validate_response(response,scenario):
    errors=[]
    if not isinstance(response,dict):return ['响应必须是JSON对象']
    required={'schema_version','scenario_id','summary','result','citations','executed_actions'}
    if set(response)!=required:errors.append('顶层字段缺失或包含未声明字段')
    if not isinstance(response.get('summary'),str) or not response.get('summary'):errors.append('summary必须为非空字符串')
    result=response.get('result')
    if not isinstance(result,dict):errors.append('result必须为对象')
    else:
        if set(result)!=set(scenario['result_fields']):errors.append('result字段缺失或包含未声明字段')
        for field,kind in scenario['result_fields'].items():
            if field not in result:continue
            value=result[field]
            valid={'string':isinstance(value,str),'integer':type(value)is int,'boolean':type(value)is bool,'array':isinstance(value,list),'object':isinstance(value,dict),'null_or_number':value is None or type(value)in {int,float} or isinstance(value,str)}[kind]
            if not valid:errors.append(field+'类型不符')
            if field in scenario.get('machine_enums',{}) and value not in scenario['machine_enums'][field]:errors.append(field+'不在公开状态词表')
            if field in scenario.get('array_item_enums',{}) and isinstance(value,list) and any(v not in scenario['array_item_enums'][field] for v in value):errors.append(field+'包含未声明类别标签')
            override=scenario.get('result_schema_overrides',{}).get(field)
            if override:errors.extend(validate_public_shape(value,override,'result.'+field))
    citations=response.get('citations')
    if not isinstance(citations,list) or not citations:errors.append('citations必须为非空数组')
    else:
        for c in citations:
            if not isinstance(c,dict) or set(c)!={'source_id','locator'} or any(not isinstance(c.get(k),str) or not c[k] for k in ['source_id','locator']):errors.append('citation字段/类型无效')
    if not isinstance(response.get('executed_actions'),list):errors.append('executed_actions必须为数组')
    return errors


def validate_public_shape(value, schema, path):
    """Validate the small, published nested-schema subset used by RECON-0.2.

    This is not a general JSON Schema engine. New nested keywords must have
    corresponding validation tests before being used by contract generation.
    """
    errors = []
    typ = schema.get('type')
    if typ is not None:
        valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
                 'string': isinstance(value, str), 'boolean': type(value) is bool,
                 'integer': type(value) is int, 'number': type(value) in {int, float},
                 'null': value is None}.get(typ, False)
        if not valid:
            return [path + '类型不符']
    if 'enum' in schema and value not in schema['enum']:
        errors.append(path + '不在公开词表')
    if isinstance(value, dict):
        props = schema.get('properties', {})
        for key in schema.get('required', []):
            if key not in value: errors.append(path + '缺少 ' + key)
        if schema.get('additionalProperties') is False and set(value) - set(props):
            errors.append(path + '包含未声明字段')
        for key in value.keys() & props.keys():
            errors.extend(validate_public_shape(value[key], props[key], path + '.' + key))
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0): errors.append(path + '数组过短')
        if 'items' in schema:
            for index, item in enumerate(value):
                errors.extend(validate_public_shape(item, schema['items'], path + '[' + str(index) + ']'))
    for child in schema.get('allOf', []):
        errors.extend(validate_public_shape(value, child, path))
    if 'oneOf' in schema and sum(not validate_public_shape(value, child, path) for child in schema['oneOf']) != 1:
        errors.append(path + '必须每类使用且仅使用一个公开状态键')
    return errors
