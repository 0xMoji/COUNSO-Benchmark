"""新编工作簿的独立语义核验：原始行、有限SUMIFS求值、图表绑定、追加负控。"""
from __future__ import annotations
import csv
import re
from decimal import Decimal
import xml.etree.ElementTree as ET
from .io import BenchError, safe_path
from .checks import workbook_cells, _office_parts, NS

class UnsupportedFormula(BenchError):
    pass

CNS={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}

def _csv(path):
    with path.open(encoding='utf-8',newline='') as f:return list(csv.DictReader(f))

def _args(formula):
    if not formula.strip():raise BenchError('缺少要求的公式')
    wrapped=re.fullmatch(r'\s*=?IFERROR\((SUMIFS\(.*\)),\s*0(?:\.0+)?\)\s*',formula,re.I)
    if wrapped:formula=wrapped[1]
    m=re.fullmatch(r'\s*=?SUMIFS\((.*)\)\s*',formula,re.I)
    if not m:raise UnsupportedFormula('本次自动求值支持单层SUMIFS/IFERROR(SUMIFS,0)；其他合法公式须人工功能复核')
    args=[];buffer='';quoted=False;level=0
    for char in m.group(1):
        if char=='"':quoted=not quoted
        if not quoted:
            if char=='(':level+=1
            if char==')':level-=1
            if char==',' and level==0:args.append(buffer.strip());buffer='';continue
        buffer+=char
    args.append(buffer.strip())
    if len(args)<3 or len(args)%2!=1:raise BenchError('SUMIFS参数无效')
    return args

def _normalize(value):
    return value.replace('$','').replace("'",'').replace(' ','').upper()

def _ranges(token,cells,rows):
    token=token.replace('$','').replace("'",'').strip()
    m=re.fullmatch(r'Sales\[([^]]+)\]',token,re.I)
    if m:
        key=next((k for k in rows[0] if k.lower()==m.group(1).lower()),None)
        if not key:raise BenchError('未知Sales结构化列')
        return [r[key] for r in rows],True
    m=re.fullmatch(r'Sales!([A-D])([0-9]*):([A-D])([0-9]*)',token,re.I)
    if not m or m[1].upper()!=m[3].upper():raise BenchError('SUMIFS范围必须引用同列Sales数据')
    col=m[1].upper();start=int(m[2]) if m[2] else 1;end=int(m[4]) if m[4] else len(rows)+1
    # 自动核验只接受完整数据范围；额外空行允许但不产生正贡献。
    if start not in {1,2} or end<len(rows)+1:raise BenchError('SUMIFS范围遗漏原始行')
    key=['Month','Region','Amount','Type'][ord(col)-65]
    data=[r[key] for r in rows]
    if start==1:data=[key]+data
    return data,False

def sumifs(formula,cells,rows,criteria_override=None):
    args=_args(formula)
    amounts,structured=_ranges(args[0],cells,rows)
    criteria=[]
    for index in range(1,len(args),2):
        values,ref_structured=_ranges(args[index],cells,rows);structured=structured and ref_structured
        token=args[index+1]
        if token.startswith('"') and token.endswith('"'):criterion=token[1:-1]
        else:
            ref=token.replace('$','')
            if re.fullmatch(r'A[0-9]+',ref):criterion=(criteria_override or {}).get(ref,cells['Summary!'+ref]['value'])
            else:raise BenchError('SUMIFS条件必须是文本常量或Summary的月份单元格')
        if len(values)!=len(amounts):raise BenchError('SUMIFS范围长度不一致')
        criteria.append((values,str(criterion)))
    total=Decimal('0')
    for i,amount in enumerate(amounts):
        if all(str(values[i])==criterion for values,criterion in criteria):
            try:total+=Decimal(str(amount))
            except Exception:pass # 表头/空值不会作为数值收入。
    return total,structured

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
            cat=series.findtext('c:cat/c:strRef/c:f',default='',namespaces=CNS)
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
    for rownum,(month,amount) in enumerate(zip(months,target),2):
        if cells.get(f'Summary!A{rownum}',{}).get('value')!=month:return False,'汇总月份错误'
        actual=cells.get(f'Summary!B{rownum}')
        if not actual:return False,'汇总数值缺失'
        if formula_required:
            value,structured=sumifs(actual.get('formula') or '',cells,rows)
            if value!=amount:return False,'实际SUMIFS计算结果错误'
            if dynamic_required and not structured:return False,'下月场景必须使用Sales结构化完整范围'
        elif Decimal(actual['value'])!=amount:return False,'汇总数值错误'
    if dynamic_required:
        tables=reachable_tables(parts,'Sales')
        if not any(t.attrib.get('displayName')=='Sales' and t.attrib.get('ref')==f'A1:D{len(rows)+1}' and [c.attrib.get('name') for c in t.findall('s:tableColumns/s:tableColumn',NS)]==fields for t in tables):return False,'Sales原生表缺失或范围不全'
        # 模拟Excel的标准表格追加/复制月份行工作流；未声明真实Excel渲染或通用计算引擎。
        future=rows+[{'Month':'2026-05','Region':'SG','Amount':'1600','Type':'SALE'},{'Month':'2026-05','Region':'HK','Amount':'900','Type':'SALE'},{'Month':'2026-05','Region':'SG','Amount':'-80','Type':'REFUND'}]
        last=f'A{len(months)+1}'
        formula=cells[f'Summary!B{len(months)+1}']['formula'] or ''
        value,structured=sumifs(formula,cells,future,{last:'2026-05'})
        if value!=Decimal('2500') or not structured:return False,'追加新月份后公式失效或退款误入收入'
    if chart_required and not _chart_ok(parts,dynamic_required,len(months),not with_april):return False,'图表类别、数据引用或动态范围不符合任务'
    return True,'完整源行/数值类型/有限SUMIFS/图表引用及所需追加负控通过；Office视觉渲染UNKNOWN'

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


def package_relationships(parts,source):
    import posixpath
    relpath=posixpath.dirname(source)+'/_rels/'+posixpath.basename(source)+'.rels'
    if relpath not in parts:return {}
    result={}
    for r in ET.fromstring(parts[relpath]):
        target=r.attrib.get('Target','')
        target=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(source),target))
        if target.startswith('../') or target.startswith('/') or target not in parts:raise BenchError('Office关系目标缺失或越界')
        rid=r.attrib.get('Id')
        if rid in result:raise BenchError('Office关系ID重复')
        result[rid]={'target':target,'type':r.attrib.get('Type','')}
    return result

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
