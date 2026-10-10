"""仅用标准库生成确定性、可编辑的参考 XLSX；不声明已做 Office 渲染。"""
from __future__ import annotations
from pathlib import Path
from xml.sax.saxutils import escape
import zipfile

S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def _cell(col, row, value):
    ref = f'{col}{row}'
    if isinstance(value, dict) and 'formula' in value:
        return f'<c r="{ref}"><f>{escape(value["formula"])}</f><v>{value.get("cached",0)}</v></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'

def _col(i):
    out = ''
    while i:
        i, r = divmod(i-1,26)
        out = chr(65+r)+out
    return out

def write_workbook(path, sheets, chart=False, table=False, dynamic_chart=False):
    """sheets 为 [(名称, 行)]；chart 绑定第一张表 A2:A4/B2:B4。"""
    parts = {}
    ct = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>', '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>', '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
    parts['_rels/.rels'] = f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    wb_sheets, wb_rels = [], []
    for index, (name, rows) in enumerate(sheets,1):
        wb_sheets.append(f'<sheet name="{escape(name)}" sheetId="{index}" r:id="rId{index}"/>')
        wb_rels.append(f'<Relationship Id="rId{index}" Type="{R}/worksheet" Target="worksheets/sheet{index}.xml"/>')
        xml_rows = ''.join('<row r="%s">%s</row>' % (rownum, ''.join(_cell(_col(col),rownum,v) for col,v in enumerate(values,1))) for rownum,values in enumerate(rows,1))
        extra = '<drawing r:id="rIdChart"/>' if chart and index==1 else ''
        if table and index==2:
            extra += '<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts>'
        parts[f'xl/worksheets/sheet{index}.xml'] = f'<worksheet xmlns="{S}" xmlns:r="{R}"><sheetData>{xml_rows}</sheetData>{extra}</worksheet>'
        ct.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    wb_rels.append(f'<Relationship Id="rIdStyles" Type="{R}/styles" Target="styles.xml"/>')
    defined_names=(f'<definedNames><definedName name="MonthlyLabels" localSheetId="0">Summary!$A$2:INDEX(Summary!$A:$A,COUNTA(Summary!$A:$A))</definedName><definedName name="MonthlyValues" localSheetId="0">Summary!$B$2:INDEX(Summary!$B:$B,COUNTA(Summary!$A:$A))</definedName></definedNames>' if dynamic_chart else '')
    parts['xl/workbook.xml'] = f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>{"".join(wb_sheets)}</sheets>{defined_names}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
    parts['xl/_rels/workbook.xml.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(wb_rels)+'</Relationships>'
    parts['xl/styles.xml'] = f'<styleSheet xmlns="{S}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    if table:
        rows=sheets[1][1]
        headers=rows[0]
        parts['xl/tables/table1.xml']=f'<table xmlns="{S}" id="1" name="Sales" displayName="Sales" ref="A1:{_col(len(headers))}{len(rows)}" totalsRowShown="0"><autoFilter ref="A1:{_col(len(headers))}{len(rows)}"/><tableColumns count="{len(headers)}">'+''.join(f'<tableColumn id="{i}" name="{escape(str(h))}"/>' for i,h in enumerate(headers,1))+'</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>'
        parts['xl/worksheets/_rels/sheet2.xml.rels']=f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdTable" Type="{R}/table" Target="../tables/table1.xml"/></Relationships>'
        ct.append('<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>')
    if chart:
        parts['xl/worksheets/_rels/sheet1.xml.rels']=f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart" Type="{R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
        parts['xl/drawings/drawing1.xml']='''<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="原生可编辑图表"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>'''
        parts['xl/drawings/_rels/drawing1.xml.rels']=f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/chart" Target="../charts/chart1.xml"/></Relationships>'
        name=sheets[0][0]
        n=len(sheets[0][1])
        cat_ref=f"'{name}'!MonthlyLabels" if dynamic_chart else f"'{name}'!$A$2:$A${n}"
        val_ref=f"'{name}'!MonthlyValues" if dynamic_chart else f"'{name}'!$B$2:$B${n}"
        parts['xl/charts/chart1.xml']=f'''<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>'{name}'!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>{cat_ref}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>{val_ref}</c:f></c:numRef></c:val></c:ser><c:axId val="10"/><c:axId val="20"/></c:barChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="20"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>'''
        ct.extend(['<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>','<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'])
    parts['[Content_Types].xml']='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+''.join(ct)+'</Types>'
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name,body in sorted(parts.items()):
            info=zipfile.ZipInfo(name,date_time=(2026,10,8,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            z.writestr(info,body.encode('utf-8'))
