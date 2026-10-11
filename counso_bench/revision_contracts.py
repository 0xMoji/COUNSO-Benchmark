"""Deterministic contract changes; no fixture amounts are rewritten."""
from copy import deepcopy
from .revision_semantics import (ENTITY_ALIASES, STATE_ALIASES,
    ALL_STATE_SOURCES, GRADER_REVISION, B17_TASK_REVISION, B17_FREEZE_SHA256)

B17_PROMPT_SUFFIX = '\n\n本轮契约澄清版本：B17-contract-0.2。业务数据、估值政策和计算任务保持不变。以下定义只适用于本版本。\n1. result.eur_intermediate 明确指向 position_id=U-EUR-FX 可确定的EUR原币金额，不是已确认EUR头寸的金额，也不是EUR头寸合计。以有限十进制字符串输出，小数位数量不影响数值等价。\n2. result.period_source 使用公开词表。输入持仓的期间字段为period，对应标签period；其他可选标签为version_date、quote_date、filename、UNKNOWN。根据实际选用的期间证据填一项。\n3. result.detail_file 指向一个静态CSV，表头顺序固定为 position_id,value_sgd,status,original_currency,original_value。输入出现的每个唯一position_id交付一行，行顺序不限，不重复。status只取CONFIRMED或UNKNOWN。已确认SGD金额填value_sgd，未知金额必须空白而非0。original_currency/original_value专用于SGD仍未知但原币金额可确定的头寸；已确认SGD、或原币金额也无法确认时，这两列留空。金额均接受有限十进制数值等价写法。\n4. 更丰富的计算中间值、来源行ID、选用规则和说明可另附文件；response.json中selected_holding_rows和selected_quote_rows等既有要求不变。\n5. 为消除首段措辞的范围歧义，本版本必须保留的原币中间值仅限SGD仍未知但原币金额可确定的头寸；已确认SGD头寸的原币中间值可以另附，但不属于必交内容。\n'

B17_SCHEMA_TEXT = '{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "additionalProperties": false,\n  "properties": {\n    "citations": {\n      "items": {\n        "additionalProperties": false,\n        "properties": {\n          "locator": {\n            "minLength": 1,\n            "type": "string"\n          },\n          "source_id": {\n            "enum": [\n              "holdings-versions",\n              "quotes-versions",\n              "valuation_policy"\n            ]\n          }\n        },\n        "required": [\n          "source_id",\n          "locator"\n        ],\n        "type": "object"\n      },\n      "minItems": 1,\n      "type": "array"\n    },\n    "executed_actions": {\n      "maxItems": 0,\n      "type": "array"\n    },\n    "result": {\n      "additionalProperties": false,\n      "properties": {\n        "complete_valuation_sgd": {\n          "type": [\n            "null",\n            "string",\n            "number"\n          ]\n        },\n        "confirmed_subtotal_sgd": {\n          "type": "string"\n        },\n        "detail_file": {\n          "type": "string",\n          "description": "CSV columns in this order: position_id,value_sgd,status,original_currency,original_value. Per-position rules are defined in prompt.txt."\n        },\n        "eur_intermediate": {\n          "type": "string",\n          "description": "Only the EUR native intermediate value of position_id U-EUR-FX; not other EUR positions or aggregate."\n        },\n        "excluded_evidence": {\n          "items": {\n            "enum": [\n              "DRAFT_HOLDING",\n              "INDICATIVE_QUOTE",\n              "SEPTEMBER_HOLDING",\n              "WRONG_DATE_FX",\n              "WRONG_DATE_QUOTE",\n              "UNSIGNED_POLICY",\n              "UNVERIFIED_CONTACT",\n              "UNKNOWN"\n            ]\n          },\n          "type": "array"\n        },\n        "missing_evidence": {\n          "type": "object"\n        },\n        "period_source": {\n          "type": "string",\n          "enum": [\n            "period",\n            "version_date",\n            "quote_date",\n            "filename",\n            "UNKNOWN"\n          ]\n        },\n        "selected_holding_rows": {\n          "type": "object"\n        },\n        "selected_quote_rows": {\n          "type": "object"\n        },\n        "static_output_acceptable": {\n          "type": "boolean"\n        },\n        "unknown_positions": {\n          "type": "array"\n        }\n      },\n      "required": [\n        "complete_valuation_sgd",\n        "confirmed_subtotal_sgd",\n        "detail_file",\n        "eur_intermediate",\n        "excluded_evidence",\n        "missing_evidence",\n        "period_source",\n        "selected_holding_rows",\n        "selected_quote_rows",\n        "static_output_acceptable",\n        "unknown_positions"\n      ],\n      "type": "object"\n    },\n    "scenario_id": {\n      "const": "B17.reconcile"\n    },\n    "schema_version": {\n      "const": "RECON-0.1"\n    },\n    "summary": {\n      "minLength": 1,\n      "type": "string"\n    }\n  },\n  "required": [\n    "schema_version",\n    "scenario_id",\n    "summary",\n    "result",\n    "citations",\n    "executed_actions"\n  ],\n  "title": "新编候选输出契约；无期望答案",\n  "type": "object"\n}\n'


def apply_revisions(scenarios, gold):
    # The original generator reuses some check dictionaries across scenarios.
    # Detach them before a revision that applies only to B17.reconcile.
    for sid in list(gold):
        gold[sid] = deepcopy(gold[sid])
    for case in scenarios:
        sid = case['id']
        contract = gold[sid]
        case['grader_revision'] = GRADER_REVISION
        case['task_revision'] = 'RECON-0.1'
        if sid in {'B01.discovery', 'R-B01-source-review'}:
            case['task_revision'] = 'B01-schema-0.2'
            case.setdefault('array_item_enums', {})['entity_disambiguation_fields'] = [
                *ENTITY_ALIASES, 'display_name', 'contact_name', 'UNKNOWN']
            case['result_schema_overrides'] = {'entity_disambiguation_fields': {
                'description': 'Use jurisdiction and registration as canonical labels; 辖区, registration_number, 登记号 are explicit aliases. display_name/contact_name are different fields.'}}
            for check in contract['checks']:
                if check.get('path') == 'result.entity_disambiguation_fields':
                    check['kind'] = 'entity_fields'
        if sid == 'B13.deep':
            case['task_revision'] = 'B13-schema-0.2'
            props = {key: {'type': 'array', 'items': {'type': 'string', 'enum': sorted(ALL_STATE_SOURCES)}, 'minItems': 1}
                     for key in STATE_ALIASES}
            groups = {v: [k for k, x in STATE_ALIASES.items() if x == v] for v in STATE_ALIASES.values()}
            case['result_schema_overrides'] = {'state_evidence': {
                'type': 'object', 'properties': props, 'additionalProperties': False,
                'allOf': [{'oneOf': [{'required': [key]} for key in keys]} for keys in groups.values()],
                'description': 'Five state categories: sponsor, commercial, data, technical, workspace. The matching result-field names are explicit aliases. Use exactly one key per category, with an array of source IDs. Cite the authoritative state source; related support/conflict sources may be included in any order.'}}
            case['task_zh'] += ' state_evidence的五类键和明确别名见schema；每类须列首要状态权威来源，可附相关支持/冲突来源，列表顺序不限。'
            for check in contract['checks']:
                if check.get('path') == 'result.state_evidence':
                    check['kind'] = 'state_evidence'
        if sid in {'B17.reconcile', 'R-B17-static-valuation'}:
            for check in contract['checks']:
                if check.get('path') in {'result.confirmed_subtotal_sgd', 'result.eur_intermediate'}:
                    check.update(kind='money', tolerance='0.00')
        if sid == 'B17.reconcile':
            case['task_revision'] = B17_TASK_REVISION
            case['task_contract_sha256'] = B17_FREEZE_SHA256
            case['prompt_suffix'] = B17_PROMPT_SUFFIX
            case.setdefault('machine_enums', {})['period_source'] = ['period', 'version_date', 'quote_date', 'filename', 'UNKNOWN']
            case['result_schema_overrides'] = {
                'detail_file': {'description': 'CSV columns in this order: position_id,value_sgd,status,original_currency,original_value. Per-position rules are defined in prompt.txt.'},
                'eur_intermediate': {'description': 'Only the EUR native intermediate value of position_id U-EUR-FX; not other EUR positions or aggregate.'}}
            contract['reference_response']['result']['period_source'] = 'period'
            for check in contract['checks']:
                if check.get('path') in {'result.selected_holding_rows', 'result.selected_quote_rows'}:
                    check['kind'] = 'selected_source_rows'
                    check['quality_unknown'] = True
                if check.get('path') == 'result.period_source':
                    check['expected'] = 'period'
                if check['kind'] == 'csv_exact':
                    check['columns'] = ['position_id', 'value_sgd', 'status', 'original_currency', 'original_value']
                    check.update(kind='valuation_csv_rows', weight=3)
            contract['checks'].append({'id': 'B17.reconcile:csv_public_format', 'kind': 'csv_format', 'path': 'result.detail_file', 'columns': ['position_id', 'value_sgd', 'status', 'original_currency', 'original_value'], 'category': 'format', 'critical': False, 'weight': 1})
        contract['task_revision'] = case['task_revision']
        contract['grader_revision'] = GRADER_REVISION
