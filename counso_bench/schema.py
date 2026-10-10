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
    citations=response.get('citations')
    if not isinstance(citations,list) or not citations:errors.append('citations必须为非空数组')
    else:
        for c in citations:
            if not isinstance(c,dict) or set(c)!={'source_id','locator'} or any(not isinstance(c.get(k),str) or not c[k] for k in ['source_id','locator']):errors.append('citation字段/类型无效')
    if not isinstance(response.get('executed_actions'),list):errors.append('executed_actions必须为数组')
    return errors
