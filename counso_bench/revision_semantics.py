"""Explicit, model-agnostic semantic equivalences for RECON-0.2.

This module does not authenticate observations or migrate run metadata. A legacy
regrade caller must authenticate the original bundle/run/session first. Legacy
B17 eur_intermediate and undocumented CSV requirements remain the caller's
UNKNOWN decisions, not new-task credit.
"""
from decimal import Decimal, InvalidOperation

GRADER_REVISION = 'RECON-0.2'
B17_TASK_REVISION = 'B17-contract-0.2'
B17_FREEZE_SHA256 = 'a1eb635d8edca150207be281e169d6feb20954dec51b223fa591493f95b4f42a'

ENTITY_ALIASES = {
    'jurisdiction': 'jurisdiction', '辖区': 'jurisdiction',
    'registration': 'registration', 'registration_number': 'registration',
    '登记号': 'registration',
}
PERIOD_ALIASES = {
    'period': 'period', 'holding_period': 'period',
    'holding.period': 'period', 'holdings.period': 'period', '持仓期间': 'period',
}
STATE_ALIASES = {
    'sponsor': 'sponsor', 'sponsor_approval': 'sponsor',
    'commercial': 'commercial', 'commercial_approval': 'commercial',
    'data': 'data', 'data_permission': 'data',
    'technical': 'technical', 'technical_account': 'technical',
    'workspace': 'workspace',
}
PRIMARY_STATE_SOURCES = {
    'sponsor': 'sponsor-signed', 'commercial': 'commercial-signed',
    'data': 'data-permission', 'technical': 'technical-ready',
    'workspace': 'workspace-closed',
}
# Lists are derived from the source content, not observed candidate wording.
# Cross-state dependencies can be cited as supporting evidence. An unfamiliar
# relevance claim is UNKNOWN, not automatically ignored or given full credit.
STATE_SUPPORT = {
    'sponsor': {'sponsor-signed', 'sponsor-draft', 'budget-reserved', 'authority-policy'},
    'commercial': {'commercial-signed', 'authority-policy'},
    'data': {'data-permission', 'commercial-signed', 'authority-policy'},
    'technical': {'technical-ready', 'workspace-closed', 'authority-policy'},
    'workspace': {'workspace-closed', 'sales-latest', 'technical-ready', 'authority-policy'},
}
ALL_STATE_SOURCES = set().union(*STATE_SUPPORT.values())


def finite_decimal(value):
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError('金额必须是有限十进制数')
    return number


def entity_fields(value):
    if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
        return False, '主体字段必须为字符串数组'
    if any(x not in ENTITY_ALIASES for x in value):
        return False, '未知主体字段或把名称/联系人作为登记号'
    normalized = [ENTITY_ALIASES[x] for x in value]
    ok = len(normalized) == 2 and set(normalized) == {'jurisdiction', 'registration'}
    return ok, '显式主体字段别名与无序集合等价' if ok else '主体字段缺失、重复或不等价'


def state_evidence(value):
    if not isinstance(value, dict):
        return None, 'UNKNOWN：状态证据未使用可可靠归一的对象结构，需独立证据审核'
    normalized = {}
    uncertain = []
    duplicate_declarations = {}
    for key, sources in value.items():
        category = STATE_ALIASES.get(key)
        if category is None:
            uncertain.append('未登记的状态类别 ' + str(key))
            continue
        if category in normalized:
            uncertain.append('同状态类别使用多个键，需审核是否矛盾：' + category)
            duplicate_declarations.setdefault(category, [normalized[category]]).append(sources)
            continue
        normalized[category] = sources
    # A recognized, missing authority is a substantive failure even when some
    # other fields are difficult to parse. Unknown names cannot earn credit.
    for category, sources in normalized.items():
        if category in duplicate_declarations:
            for declaration in duplicate_declarations[category]:
                if isinstance(declaration, list) and all(isinstance(s, str) for s in declaration):
                    if any(s not in ALL_STATE_SOURCES for s in declaration):
                        return False, '重复类别引用不存在的状态来源：' + category
            continue
        if not isinstance(sources, list) or any(not isinstance(s, str) for s in sources):
            uncertain.append('证据列表无法可靠解释：' + category)
            continue
        if PRIMARY_STATE_SOURCES[category] not in sources:
            return False, '缺少首要权威来源：' + category
        if any(s not in ALL_STATE_SOURCES for s in sources):
            return False, '引用不存在的状态来源：' + category
        if any(s not in STATE_SUPPORT[category] for s in sources):
            uncertain.append('需审核附加来源相关性：' + category)
    if set(normalized) != set(PRIMARY_STATE_SOURCES):
        if uncertain:
            return None, 'UNKNOWN：' + '；'.join(uncertain)
        return False, '状态证据缺少类别'
    if uncertain:
        return None, 'UNKNOWN：' + '；'.join(uncertain)
    return True, '五类首要权威来源完整；公开别名、相关支持来源和顺序已归一'


def evaluate_equivalence(check, response, output_dir, package_root, observations=None):
    """Return (handled, passed-or-None, reason); never validates run identity.

    Only listed fields are handled. In legacy regrades call this AFTER explicitly
    making old B17 eur_intermediate and detail CSV checks UNKNOWN.
    """
    if not isinstance(response, dict) or not isinstance(response.get('result'), dict):
        return False, None, '响应结构未通过公开schema；交原检查处理，不进行语义猜测'
    sid = response.get('scenario_id')
    path = check.get('path')
    result = response.get('result', {})
    if sid in {'B01.discovery', 'R-B01-source-review'} and path == 'result.entity_disambiguation_fields':
        passed, reason = entity_fields(result.get('entity_disambiguation_fields'))
        return True, passed, reason
    if sid == 'B13.deep' and path == 'result.state_evidence':
        passed, reason = state_evidence(result.get('state_evidence'))
        return True, passed, reason
    if sid in {'B17.reconcile', 'R-B17-static-valuation'} and path in {'result.confirmed_subtotal_sgd', 'result.eur_intermediate'}:
        try:
            ok = finite_decimal(result.get(path.split('.')[-1])) == finite_decimal(check['expected'])
            return True, ok, '有限Decimal零容差数值等价' if ok else '金额数值错误'
        except (InvalidOperation, ValueError, TypeError, KeyError):
            return True, False, '金额不是有限十进制数'
    if sid in {'B17.reconcile', 'R-B17-static-valuation'} and path == 'result.period_source':
        value = result.get('period_source')
        ok = isinstance(value, str) and PERIOD_ALIASES.get(value) == 'period'
        return True, ok, '显式持仓期间标签等价' if ok else '期间来源错误或无法归一'
    if sid == 'B17.reconcile' and path in {'result.selected_holding_rows', 'result.selected_quote_rows'}:
        passed, reason = selected_source_rows(result.get(path.split('.')[-1]), check, package_root)
        return True, passed, reason
    if sid == 'B20.scale' and check.get('kind') == 'xlsx_ledger_contract':
        from .checks import evaluate
        passed, reason = evaluate(check, response, output_dir, package_root, observations)
        return True, passed, reason
    return False, None, '此检查不在语义等价修订范围'


def selected_source_rows(value, check, package_root):
    """Validate required source choices; leave ambiguous extra-key scope UNKNOWN.

    The fixed prompt says 'confirmed position_id' but does not explicitly bind
    this phrase to confirmed SGD valuation rather than verified source evidence.
    Never accept fictitious/invalid rows under that ambiguity.
    """
    from .checks import _read_csv
    from .io import load_json
    from pathlib import Path
    root = Path(package_root)
    expected = check['expected']
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        return False, 'selected源行映射必须是position_id到单个源行ID的对象'
    if any(value.get(position) != row_id for position, row_id in expected.items()):
        return False, '缺少已确认所需源行或使用错误版本/行ID'
    extras = set(value) - set(expected)
    if not extras:
        return True, '全部必需源行映射正确'
    policy = load_json(root / 'fixtures/valuation_policy.json')['data']
    holding = check['path'] == 'result.selected_holding_rows'
    filename = 'holdings-versions.csv' if holding else 'quotes-versions.csv'
    id_column = 'holding_row_id' if holding else 'quote_row_id'
    rows = _read_csv(root / 'fixtures' / filename)
    by_id = {row[id_column]: row for row in rows}
    for position in extras:
        row = by_id.get(value[position])
        if row is None or row['position_id'] != position:
            return False, '额外映射包含错误源行ID或不匹配的position_id'
        if holding:
            valid = [r for r in rows if r['position_id'] == position and r['status'] == policy['allowed_holding_status'] and r['period'] == policy['holding_period']]
            if not valid or row not in valid or row['version_date'] != max(r['version_date'] for r in valid):
                return False, '额外持仓映射引用草稿、错期间或非最新有效版本'
        elif row['state'] != policy['allowed_quote_state'] or row['date'] != policy['as_of']:
            return False, '额外报价映射引用指示或错日等不合格源行'
    return None, 'UNKNOWN：必需映射正确且额外源行真实有效，但已确认键域仍有来源确认/SGD确认歧义；需独立语义复核'
