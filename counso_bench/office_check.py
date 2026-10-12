"""新编工作簿的独立语义核验：原始行、有限SUMIFS求值、图表绑定、追加负控。"""
from __future__ import annotations
import csv
import re
from decimal import Decimal, InvalidOperation
import xml.etree.ElementTree as ET
from .io import BenchError, safe_path
from .checks import workbook_cells, _office_parts, NS

class UnsupportedFormula(BenchError):
    pass

CNS={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}

def _csv(path):
    with path.open(encoding='utf-8',newline='') as f:return list(csv.DictReader(f))

def _args(formula):
    if not isinstance(formula, str) or not formula.strip():
        raise BenchError('缺少要求的公式')
    if len(formula) > 50_000:
        raise BenchError('公式超过核验长度上限')
    wrapped = re.fullmatch(r'\s*=?IFERROR\((SUMIFS\(.*\)),\s*0(?:\.0+)?\)\s*', formula, re.I)
    if wrapped:
        formula = wrapped[1]
    match = re.fullmatch(r'\s*=?SUMIFS\((.*)\)\s*', formula, re.I)
    if not match:
        raise UnsupportedFormula('自动求值支持单层SUMIFS/IFERROR(SUMIFS,0)；其他表达式记录为求值器不支持')
    args, buffer, quoted, level, brackets = [], '', False, 0, 0
    for char in match[1]:
        if char == '"':
            quoted = not quoted
        if not quoted:
            if char == '(': level += 1
            if char == ')': level -= 1
            if char == '[': brackets += 1
            if char == ']': brackets -= 1
            if level < 0 or brackets < 0:
                raise BenchError('SUMIFS参数括号无效')
            if char == ',' and level == 0 and brackets == 0:
                args.append(buffer.strip()); buffer = ''; continue
        buffer += char
    if quoted or level or brackets:
        raise BenchError('SUMIFS参数括号或字符串未闭合')
    args.append(buffer.strip())
    if len(args) < 3 or len(args) % 2 != 1 or any(not arg for arg in args):
        raise BenchError('SUMIFS参数无效')
    return args


def _normalize(value):
    return value.replace('$', '').replace("'", '').replace(' ', '').upper()


def _column(value):
    result = 0
    for char in value.upper():
        result = result * 26 + ord(char) - 64
    if not 1 <= result <= 16384:
        raise BenchError('Excel列引用越界')
    return result


def _column_name(value):
    result = ''
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _address(token):
    match = re.fullmatch(r'\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)', token)
    if not match:
        raise BenchError('Excel单元格引用无效')
    row = int(match[2])
    if row > 1048576:
        raise BenchError('Excel行引用越界')
    return _column(match[1]), row


def _rectangle(token):
    token = token.replace('$', '')
    match = re.fullmatch(r'([A-Za-z]{1,3}):([A-Za-z]{1,3})', token)
    if match:
        bounds = (_column(match[1]), 1, _column(match[2]), 1048576)
    else:
        ends = token.split(':')
        if len(ends) == 1:
            ends *= 2
        if len(ends) != 2:
            raise UnsupportedFormula('自动求值器不支持该范围表达式')
        left, top = _address(ends[0]); right, bottom = _address(ends[1])
        bounds = (left, top, right, bottom)
    if bounds[0] > bounds[2] or bounds[1] > bounds[3]:
        raise BenchError('Excel范围起止无效')
    return bounds


def _table_definitions(parts, cells):
    tables = {}
    if parts is None:
        return tables
    for sheet in worksheet_parts(parts):
        for table in reachable_tables(parts, sheet):
            name = table.attrib.get('displayName') or table.attrib.get('name')
            if not name or name.casefold() in tables:
                raise BenchError('工作簿表名称缺失或重复')
            left, top, right, bottom = _rectangle(table.attrib.get('ref', ''))
            headers = [column.attrib.get('name') for column in table.findall('s:tableColumns/s:tableColumn', NS)]
            header_count = int(table.attrib.get('headerRowCount', '1'))
            totals_count = int(table.attrib.get('totalsRowCount', '0'))
            if header_count not in {0, 1} or totals_count not in {0, 1} or bottom - top + 1 < header_count + totals_count:
                raise BenchError('原生表头/合计行范围无效')
            if len(headers) != right - left + 1 or any(not value for value in headers) or len(set(value.casefold() for value in headers)) != len(headers):
                raise BenchError('原生表列定义与实际范围不一致')
            if header_count:
                for offset, header in enumerate(headers):
                    actual = cells.get(f'{sheet}!{_column_name(left + offset)}{top}', {})
                    if actual.get('value') != header or actual.get('formula') is not None:
                        raise BenchError('原生表声明与实际表头不一致')
            tables[name.casefold()] = {'sheet': sheet, 'bounds': (left, top + header_count, right, bottom - totals_count), 'headers': headers}
    return tables


def _ranges(token, cells, tables):
    """Return the actual range shape plus sparse candidate cell values."""
    match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_.]*)\[([^]\[]+)\]', token.strip())
    if not match:
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_.]*)\[\[#Data\],\[([^]\[]+)\]\]', token.strip(), re.I)
    structured = match is not None
    if structured:
        table = tables.get(match[1].casefold())
        if table is None:
            raise BenchError('结构化公式引用未定义的原生表')
        headers = table['headers']
        index = next((i for i, header in enumerate(headers) if header.casefold() == match[2].casefold()), None)
        if index is None:
            raise BenchError('结构化公式引用未定义的表列')
        left, top, _, bottom = table['bounds']
        left = right = left + index; sheet = table['sheet']
    else:
        match = re.fullmatch(r"(?:'((?:[^']|'')+)'|([^!]+))!(.+)", token.strip())
        if not match:
            raise UnsupportedFormula('自动求值器不支持该命名范围或范围表达式')
        sheet = (match[1].replace("''", "'") if match[1] is not None else match[2]).strip()
        if not any(key.startswith(sheet + '!') for key in cells):
            raise BenchError('公式引用不存在的工作表')
        left, top, right, bottom = _rectangle(match[3])
    values = {}
    for key, cell in cells.items():
        if not key.startswith(sheet + '!'):
            continue
        col, row = _address(key[len(sheet) + 1:])
        if left <= col <= right and top <= row <= bottom:
            if cell.get('formula') is not None:
                raise UnsupportedFormula('自动SUMIFS求值器不支持源范围中嵌套公式')
            if cell.get('type') == 'e':
                raise BenchError('SUMIFS源范围含Excel错误值')
            values[(row - top, col - left)] = cell.get('value', '')
    return {'shape': (max(0, bottom - top + 1), right - left + 1), 'values': values, 'structured': structured}


def _criterion(token, cells, current_sheet='Summary'):
    if token.startswith('"') and token.endswith('"'):
        return token[1:-1].replace('""', '"')
    if re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)', token):
        return token
    match = re.fullmatch(r"(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)", token)
    if not match:
        raise UnsupportedFormula('自动求值器不支持该SUMIFS条件表达式')
    sheet = match[1].replace("''", "'") if match[1] is not None else (match[2] or current_sheet)
    col, row = _address(match[3]); cell = cells.get(f'{sheet}!{_column_name(col)}{row}', {})
    if cell.get('formula') is not None:
        raise UnsupportedFormula('自动求值器不支持公式计算的条件单元格')
    if cell.get('type') == 'e':
        raise BenchError('SUMIFS条件为Excel错误值')
    return cell.get('value', '')


def _matches(value, criterion):
    criterion = str(criterion)
    match = re.match(r'^(<=|>=|<>|=|<|>)', criterion)
    operator = match[1] if match else '='
    operand = criterion[len(operator):] if match else criterion
    left, right = str(value), operand
    try:
        a, b = Decimal(left), Decimal(right)
        if not a.is_finite() or not b.is_finite():
            raise BenchError('SUMIFS金额或条件非有限数值')
    except InvalidOperation:
        a, b = left.casefold(), right.casefold()
    if operator in {'=', '<>'} and any(char in operand for char in '*?~'):
        pattern, index = '', 0
        while index < len(operand):
            char = operand[index]
            if char == '~' and index + 1 < len(operand):
                index += 1; pattern += re.escape(operand[index])
            elif char == '*': pattern += '.*'
            elif char == '?': pattern += '.'
            else: pattern += re.escape(char)
            index += 1
        equal = re.fullmatch(pattern, left, re.I) is not None
        return equal if operator == '=' else not equal
    return {'=': lambda: a == b, '<>': lambda: a != b, '>': lambda: a > b, '<': lambda: a < b, '>=': lambda: a >= b, '<=': lambda: a <= b}[operator]()


def sumifs(formula, cells, rows=None, criteria_override=None, *, parts=None):
    """Evaluate supported SUMIFS against candidate cells, never fixture rows.

    ``rows`` is kept for compatibility with the original helper signature;
    table references require real package definitions supplied through parts.
    """
    if criteria_override:
        cells = {key: dict(value) for key, value in cells.items()}
        for key, value in criteria_override.items():
            cells['Summary!' + key] = {'type': 'string', 'value': value, 'formula': None}
    args = _args(formula); tables = _table_definitions(parts, cells)
    amounts = _ranges(args[0], cells, tables)
    criteria = []
    structured = amounts['structured']
    for index in range(1, len(args), 2):
        values = _ranges(args[index], cells, tables)
        if values['shape'] != amounts['shape']:
            raise BenchError('SUMIFS范围行列数不一致')
        structured = structured and values['structured']
        criteria.append((values['values'], _criterion(args[index + 1], cells)))
    total = Decimal('0')
    for coordinate, amount in amounts['values'].items():
        if all(_matches(values.get(coordinate, ''), criterion) for values, criterion in criteria):
            try:
                number = Decimal(str(amount))
            except InvalidOperation:
                continue  # Excel SUMIFS ignores blank/text amount cells.
            if not number.is_finite():
                raise BenchError('SUMIFS金额不是有限数值')
            total += number
    return total, structured


_COPY_REF = re.compile(r"(?<![\w.])(?P<sheet>'(?:[^']|'')+'!|[A-Za-z_][\w.]*!)?(?P<col>\$?[A-Za-z]{1,3})(?P<row>\$?[1-9][0-9]*)(?![\w.(])")


def translate_formula(formula, row_delta=0, col_delta=0):
    """Apply Excel copy semantics to A1 references, preserving $ locks."""
    def replace(match):
        col, row = match['col'], match['row']
        column, rownum = _column(col.lstrip('$')), int(row.lstrip('$'))
        if not col.startswith('$'): column += col_delta
        if not row.startswith('$'): rownum += row_delta
        if not 1 <= column <= 16384 or not 1 <= rownum <= 1048576:
            raise BenchError('复制公式产生越界单元格引用')
        return (match['sheet'] or '') + ('$' if col.startswith('$') else '') + _column_name(column) + ('$' if row.startswith('$') else '') + str(rownum)
    # Double-quoted constants and structured table expressions are not A1 refs.
    chunks = re.split(r'("(?:[^"]|"")*"|\[(?:[^\[\]]|\[[^\[\]]*\])*\])', formula)
    return ''.join(chunk if chunk.startswith(('"', '[')) else _COPY_REF.sub(replace, chunk) for chunk in chunks)


def _recalculated_summary(path, addresses):
    """Use an optional independent engine only for actual numeric results."""
    from .office_engine import OfficeEngineError, recalculate
    try:
        with recalculate(path) as converted:
            recalculated = workbook_cells(converted.path)
            values = {}
            for address in addresses:
                cell = recalculated.get(address, {})
                # Engine errors can also mean an unsupported function/profile;
                # they do not establish a candidate business failure.
                if cell.get('type') != 'n' or cell.get('value', '') == '':
                    raise OfficeEngineError('可选引擎未能建立数值结果')
                value = Decimal(cell['value'])
                if not value.is_finite():
                    raise OfficeEngineError('可选引擎未能建立有限数值结果')
                values[address] = value
            return values, converted.engine_version
    except (OfficeEngineError, InvalidOperation, BenchError) as exc:
        raise UnsupportedFormula('自动公式求值未建立结果：' + str(exc)) from exc


def _chart_ok(parts,dynamic,month_count,bar_required):
    definitions={}
    wb=ET.fromstring(parts['xl/workbook.xml'])
    summary_index=worksheet_parts(parts)['Summary']['index']
    for name in wb.findall('s:definedNames/s:definedName',NS):
        scope=name.attrib.get('localSheetId')
        if scope is not None and scope!=str(summary_index):continue
        definitions[name.attrib['name']]=name.text or ''
    def ref_ok(formula,col):
        norm=_normalize(formula)
        if not dynamic:return norm==f'SUMMARY!{col}2:{col}{month_count+1}'
        m=re.fullmatch(r'SUMMARY!(.+)',norm)
        if not m:return False
        name=next((k for k in definitions if k.upper()==m[1]),None)
        if name is None:return False
        expr=_normalize(definitions[name])
        allowed={f'SUMMARY!{col}2:INDEX(SUMMARY!{col}:{col},COUNTA(SUMMARY!A:A))',f'OFFSET(SUMMARY!{col}2,0,0,COUNTA(SUMMARY!A:A)-1,1)'}
        return expr in allowed
    for name in reachable_charts(parts,'Summary'):
        root=ET.fromstring(parts[name])
        if bar_required and root.find('.//c:barChart',CNS) is None:continue
        for series in root.findall('.//c:ser',CNS):
            cat=series.findtext('c:cat/c:strRef/c:f',default='',namespaces=CNS) or series.findtext('c:cat/c:numRef/c:f',default='',namespaces=CNS)
            val=series.findtext('c:val/c:numRef/c:f',default='',namespaces=CNS)
            if ref_ok(cat,'A') and ref_ok(val,'B'):return True
    return False

def check_sales_workbook(path,root,with_april=False,formula_required=False,chart_required=False,dynamic_required=False):
    rows=_csv(root/'fixtures/sales.csv')
    if with_april:rows+=_csv(root/'fixtures/april_append.csv')
    cells=workbook_cells(path);parts=_office_parts(path)
    expected_keys=set()
    fields=['Month','Region','Amount','Type']
    for rownum,row in enumerate([dict(zip(fields,fields))]+rows,1):
        for col,key in zip('ABCD',fields):
            ref=f'Sales!{col}{rownum}';expected_keys.add(ref)
            value=cells.get(ref)
            if not value or value['formula'] is not None:return False,'原始Sales行缺失或被公式替代'
            if key=='Amount' and rownum>1:
                if value['type']!='n' or Decimal(value['value'])!=Decimal(row[key]):return False,'金额必须保留数值类型和正确金额'
            elif value['value']!=row[key]:return False,'原始Sales数据被改写'
    if {k for k in cells if k.startswith('Sales!')}!=expected_keys:return False,'Sales增删了原始单元格'
    months=['2026-01','2026-02','2026-03']+(['2026-04'] if with_april else [])
    target=[Decimal('2000'),Decimal('2400'),Decimal('3000')]+([Decimal('3300')] if with_april else [])
    engine_values = None; engine_version = None
    for rownum,(month,amount) in enumerate(zip(months,target),2):
        if cells.get(f'Summary!A{rownum}',{}).get('value')!=month:return False,'汇总月份错误'
        actual=cells.get(f'Summary!B{rownum}')
        if not actual:return False,'汇总数值缺失'
        if formula_required:
            try:
                value,structured=sumifs(actual.get('formula') or '',cells,parts=parts)
            except UnsupportedFormula:
                if dynamic_required:
                    raise UnsupportedFormula('该公式超出自动追加/复制核验范围；不能仅凭引擎的旧月份结果确认下月可用')
                if engine_values is None:
                    engine_values, engine_version = _recalculated_summary(path, [f'Summary!B{i}' for i in range(2, len(months)+2)])
                value, structured = engine_values[f'Summary!B{rownum}'], False
            if value!=amount:return False,'实际公式计算结果错误'
            if dynamic_required and not structured:return False,'下月场景必须使用Sales结构化完整范围'
        elif Decimal(actual['value'])!=amount:return False,'汇总数值错误'
    if dynamic_required:
        tables=reachable_tables(parts,'Sales')
        if not any(t.attrib.get('displayName')=='Sales' and t.attrib.get('ref')==f'A1:D{len(rows)+1}' and [c.attrib.get('name') for c in t.findall('s:tableColumns/s:tableColumn',NS)]==fields for t in tables):return False,'Sales原生表缺失或范围不全'
        # Append candidate sheet cells, extend its actual Sales table, then copy
        # the final formula down one row with relative/absolute A1 semantics.
        future_cells = {key: dict(value) for key, value in cells.items()}
        future_parts = dict(parts)
        appended = [('2026-05','SG',1600,'SALE'), ('2026-05','HK',900,'SALE'), ('2026-05','SG',-80,'REFUND')]
        for rownum, record in enumerate(appended, len(rows) + 2):
            for column, value in zip('ABCD', record):
                future_cells[f'Sales!{column}{rownum}'] = {'type':'n' if column == 'C' else 'string', 'value':str(value), 'formula':None}
        sales_part = worksheet_parts(parts)['Sales']['part']
        sales_xml = ET.fromstring(parts[sales_part]); sales_rels = package_relationships(parts, sales_part)
        rid = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
        for element in sales_xml.findall('s:tableParts/s:tablePart', NS):
            relation = sales_rels.get(element.attrib.get(rid))
            if relation and relation['type'].endswith('/table'):
                table = ET.fromstring(parts[relation['target']])
                if table.attrib.get('displayName') == 'Sales':
                    table.set('ref', f'A1:D{len(rows)+4}')
                    future_parts[relation['target']] = ET.tostring(table)
        last_row = len(months) + 1
        future_cells[f'Summary!A{last_row+1}'] = {'type':'string', 'value':'2026-05', 'formula':None}
        formula = translate_formula(cells[f'Summary!B{last_row}']['formula'] or '', row_delta=1)
        value,structured = sumifs(formula, future_cells, parts=future_parts)
        if value != Decimal('2500') or not structured:
            return False,'实际追加Sales表并复制公式后，新月份计算失效或退款误入收入'
    if chart_required and not _chart_ok(parts,dynamic_required,len(months),not with_april):return False,'图表类别、数据引用或动态范围不符合任务'
    method = ('独立Office引擎计算：' + engine_version) if engine_version else '有界SUMIFS求值'
    return True,'完整源行/数值类型/' + method + '/图表引用及所需追加负控通过；Office视觉渲染UNKNOWN'

def check_ledger_workbook(path,expected_csv):
    rows=_csv(expected_csv);cells=workbook_cells(path)
    fields=list(rows[0]);letters='ABCDEF'
    for c,k in zip(letters,fields):
        if cells.get('Ledger!'+c+'1',{}).get('value')!=k:return False,'Excel列名错误'
    if len([k for k in cells if k.startswith('Ledger!')])!=(len(rows)+1)*len(fields):return False,'Excel输出行/列数错误'
    observed=[]
    for rownum in range(2,len(rows)+2):
        record={}
        for c,k in zip(letters,fields):
            val=cells.get(f'Ledger!{c}{rownum}')
            if not val or val['formula'] is not None:return False,'Excel行缺失或公式替代静态金额'
            if k in {'invoice_id','entity_id'}:
                if val['type']!='string':return False,'文本标识被数字化，前导0可能丢失'
                record[k]=val['value']
            else:
                if val['type']!='n':return False,'金额列不是数值'
                record[k]=str(Decimal(val['value']).quantize(Decimal('.01')))
        observed.append(record)
    key=lambda r:r['invoice_id']
    return (sorted(observed,key=key)==sorted(rows,key=key),'Excel全部行独立读回比较（非渲染）')


def package_relationships(parts, source):
    from .office_package import relationship_map
    return relationship_map(parts, source)


def worksheet_parts(parts):
    rels=package_relationships(parts,'xl/workbook.xml');wb=ET.fromstring(parts['xl/workbook.xml']);result={}
    rid='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
    for index,sheet in enumerate(wb.findall('s:sheets/s:sheet',NS)):
        name=sheet.attrib['name'];rel=rels.get(sheet.attrib[rid])
        if name in result or not rel or not rel['type'].endswith('/worksheet'):raise BenchError('工作表名称/关系无效')
        result[name]={'part':rel['target'],'index':index}
    return result

def reachable_charts(parts,sheet_name):
    sheets=worksheet_parts(parts);part=sheets[sheet_name]['part'];sheet=ET.fromstring(parts[part]);rels=package_relationships(parts,part)
    rid='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id';found=[]
    for drawing in sheet.findall('s:drawing',NS):
        rel=rels.get(drawing.attrib.get(rid))
        if not rel or not rel['type'].endswith('/drawing'):continue
        drawing_part=rel['target'];drawing_rels=package_relationships(parts,drawing_part);root=ET.fromstring(parts[drawing_part])
        namespaces={'xdr':'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing','a':'http://schemas.openxmlformats.org/drawingml/2006/main',**CNS}
        for chart in root.findall('.//xdr:graphicFrame/a:graphic/a:graphicData/c:chart',namespaces):
            chart_rel=drawing_rels.get(chart.attrib.get(rid))
            if chart_rel and chart_rel['type'].endswith('/chart'):found.append(chart_rel['target'])
    return found

def reachable_tables(parts,sheet_name):
    part=worksheet_parts(parts)[sheet_name]['part'];sheet=ET.fromstring(parts[part]);rels=package_relationships(parts,part)
    rid='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id';found=[]
    for table in sheet.findall('s:tableParts/s:tablePart',NS):
        rel=rels.get(table.attrib.get(rid))
        if rel and rel['type'].endswith('/table'):found.append(ET.fromstring(parts[rel['target']]))
    return found
