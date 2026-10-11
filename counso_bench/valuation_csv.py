"""B17-contract-0.2: separate public CSV format from business facts.

The fixed prompt did not explicitly settle extra summary rows. Complete correct
business rows plus a correct clearly named subtotal therefore remain UNKNOWN,
not full credit and not an invented additional position. No row is discarded.
"""
import csv
from decimal import InvalidOperation
from .io import BenchError, safe_path
from .revision_semantics import finite_decimal

SUMMARY_IDS = {'TOTAL', 'TOTAL_CONFIRMED', 'CONFIRMED_SUBTOTAL', '合计', '确认小计'}


def format_check(path, columns):
    from .checks import _read_csv
    rows = _read_csv(path)
    with path.open(encoding='utf-8-sig', newline='') as source:
        if next(csv.reader(source), None) != columns:
            return False, '公开CSV列名/顺序不符'
    if any(row['status'] not in {'CONFIRMED', 'UNKNOWN'} for row in rows):
        return False, 'CSV状态不在公开词表CONFIRMED/UNKNOWN'
    return True, '公开CSV列名、顺序、字段数与状态词表通过'


def business_rows_check(path, expected_csv, columns):
    from .checks import _read_csv
    try:
        rows, expected = _read_csv(path), _read_csv(expected_csv)
    except (BenchError, OSError, ValueError):
        return None, 'UNKNOWN：CSV结构/读取错误已由独立格式项判定；业务行无法可靠核验'
    if not rows or not all(set(row) == set(columns) for row in rows):
        return None, 'UNKNOWN：列契约不符，无法无歧义核验业务行；未忽略额外列'
    if len({row['position_id'] for row in rows}) != len(rows):
        return False, '逐项CSV存在重复ID'
    actual_by = {row['position_id']: row for row in rows}
    expected_by = {row['position_id']: row for row in expected}
    if set(expected_by) - set(actual_by):
        return False, '逐项CSV缺少输入头寸'
    uncertain_status = []
    try:
        for position, target in expected_by.items():
            actual = actual_by[position]
            for column in columns:
                if column == 'status' and actual[column] not in {'CONFIRMED', 'UNKNOWN'}:
                    uncertain_status.append(position)
                    continue
                if column in {'value_sgd', 'original_value'} and target[column] != '':
                    if finite_decimal(actual[column]) != finite_decimal(target[column]):
                        return False, '源头寸金额错误：' + position
                elif actual[column] != target[column]:
                    return False, '源头寸状态、标识、未知空白或原币范围错误：' + position
        extra = set(actual_by) - set(expected_by)
        if not extra and uncertain_status:
            return None, 'UNKNOWN：公开词表外状态已单列格式FAIL；未猜测其业务含义，其余可判定业务值已核验'
        if not extra:
            return True, '全部唯一源头寸完整，有限Decimal零容差逐项一致'
        subtotal = sum(finite_decimal(row['value_sgd']) for row in expected if row['status'] == 'CONFIRMED')
        for position in sorted(extra):
            row = actual_by[position]
            if position in SUMMARY_IDS:
                if finite_decimal(row['value_sgd']) != subtotal:
                    return False, '合计标识掩盖错误金额：' + position
            elif position.startswith(('P-', 'U-')):
                return False, 'CSV声称不存在的真实头寸：' + position
            elif (row['status'] == 'CONFIRMED' and row['value_sgd'] != ''
                  and row['original_currency'] == '' and row['original_value'] == ''):
                finite_decimal(row['value_sgd'])
                # A complete confirmed-SGD position claim remains fictitious
                # without a P-/U- prefix. Other unclear extra-row purposes stay
                # UNKNOWN; they are never silently discarded for full credit.
                return False, 'CSV声称不存在的真实头寸：' + position
        return None, 'UNKNOWN：所有源头寸正确，但额外汇总/陌生行在固定题干中的处理未充分定义；需独立语义审核，未忽略额外行'
    except (InvalidOperation, ValueError, TypeError):
        return False, 'CSV金额不是有限十进制数'
