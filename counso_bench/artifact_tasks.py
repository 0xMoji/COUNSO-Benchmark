"""Independent validators and explicit synthetic controls for artifact tasks."""
from __future__ import annotations

import csv
from copy import deepcopy
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape
import zipfile

from .io import BenchError, get_path, load_json, safe_path, sha256, write_json
from .office import write_workbook

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"a": A, "p": P, "c": C, "r": R}

class UnsupportedArtifact(BenchError):
    """Legal-looking functionality outside the bounded local evaluator."""

def _rels(entries):
    return '<Relationships xmlns="' + PKG + '">' + ''.join('<Relationship Id="%s" Type="%s" Target="%s"/>' % (i, R + '/' + t, escape(target, {'"': '&quot;'})) for i, t, target in entries) + '</Relationships>'

def _shape(ident, text, y, font=24):
    return f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="Text {ident}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="700000" y="{y}"/><a:ext cx="10500000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="{font*100}"/><a:t>{escape(text)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>'

def write_reference_presentation(path, values):
    """Minimal, standards-based PPTX control including an editable embedded workbook."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    months = ["January", "February", "March"]
    contents = {
        "_rels/.rels": _rels([("rId1", "officeDocument", "ppt/presentation.xml")]),
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId4"/></p:sldMasterIdLst><p:sldIdLst>'+''.join(f'<p:sldId id="{255+i}" r:id="rId{i}"/>' for i in range(1,4))+'</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
        "ppt/_rels/presentation.xml.rels": _rels([(f"rId{i}", "slide", f"slides/slide{i}.xml") for i in range(1,4)]+[("rId4","slideMaster","slideMasters/slideMaster1.xml")]),
    }
    tree_start = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    bodies = [
        _shape(2,"Quarterly sales",700000,32)+_shape(3,f"Total SGD {sum(values):,.2f}",2200000,28)+_shape(4,"Synthetic fixture",5400000,16),
        _shape(2,"Monthly sales",500000,32)+f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Monthly sales chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000000" y="1600000"/><a:ext cx="10000000" cy="4000000"/></p:xfrm><a:graphic><a:graphicData uri="{C}"><c:chart xmlns:c="{C}" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>',
        _shape(2,"Next steps",700000,32)+_shape(3,"Review March demand",2200000,24)+_shape(4,"Synthetic fixture",5400000,16),
    ]
    for i, body in enumerate(bodies,1):
        contents[f"ppt/slides/slide{i}.xml"] = f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>{tree_start}{body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
        relations=[("rId1","slideLayout","../slideLayouts/slideLayout1.xml")]
        if i==2:relations.append(("rId2","chart","../charts/chart1.xml"))
        contents[f"ppt/slides/_rels/slide{i}.xml.rels"]=_rels(relations)
    colors='<a:dk1><a:srgbClr val="172434"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="24384F"/></a:dk2><a:lt2><a:srgbClr val="F6F8FA"/></a:lt2>'+''.join(f'<a:accent{i}><a:srgbClr val="{color}"/></a:accent{i}>' for i,color in enumerate(['176B87','64A1B8','508869','A78C54','806AB2','9C6670'],1))+'<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>'
    contents['ppt/theme/theme1.xml']=f'<a:theme xmlns:a="{A}" name="Synthetic"><a:themeElements><a:clrScheme name="Synthetic">{colors}</a:clrScheme><a:fontScheme name="Arial"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Synthetic"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
    contents['ppt/slideMasters/slideMaster1.xml']=f'<p:sldMaster xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>{tree_start}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'
    contents['ppt/slideMasters/_rels/slideMaster1.xml.rels']=_rels([('rId1','slideLayout','../slideLayouts/slideLayout1.xml'),('rId2','theme','../theme/theme1.xml')])
    contents['ppt/slideLayouts/slideLayout1.xml']=f'<p:sldLayout xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{tree_start}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    contents['ppt/slideLayouts/_rels/slideLayout1.xml.rels']=_rels([('rId1','slideMaster','../slideMasters/slideMaster1.xml')])
    categories=''.join(f'<c:pt idx="{i}"><c:v>{m}</c:v></c:pt>' for i,m in enumerate(months))
    numbers=''.join(f'<c:pt idx="{i}"><c:v>{n}</c:v></c:pt>' for i,n in enumerate(values))
    contents['ppt/charts/chart1.xml']=f'<c:chartSpace xmlns:c="{C}" xmlns:a="{A}" xmlns:r="{R}"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Sales SGD</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/>{categories}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>0.00</c:formatCode><c:ptCount val="3"/>{numbers}</c:numCache></c:numRef></c:val></c:ser><c:axId val="100"/><c:axId val="200"/></c:barChart><c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="200"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="100"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'
    contents['ppt/charts/_rels/chart1.xml.rels']=_rels([('rId1','package','../embeddings/data.xlsx')])
    overrides=[]
    for name in contents:
        if not name.endswith('.xml') or name.endswith('.rels'):continue
        if name=='ppt/presentation.xml':typ='presentationml.presentation.main'
        elif '/slides/' in name:typ='presentationml.slide'
        elif '/slideMasters/' in name:typ='presentationml.slideMaster'
        elif '/slideLayouts/' in name:typ='presentationml.slideLayout'
        elif '/theme/' in name:typ='theme'
        elif '/charts/' in name:typ='drawingml.chart'
        else:continue
        overrides.append(f'<Override PartName="/{name}" ContentType="application/vnd.openxmlformats-officedocument.{typ}+xml"/>')
    contents['[Content_Types].xml']='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'+''.join(overrides)+'</Types>'
    with tempfile.TemporaryDirectory() as tmp:
        workbook=Path(tmp)/'data.xlsx'
        write_workbook(workbook,[('Sheet1',[['Month','Sales SGD']]+[[m,n] for m,n in zip(months,values)])])
        deterministic=io.BytesIO()
        with zipfile.ZipFile(workbook) as source, zipfile.ZipFile(deterministic,'w',zipfile.ZIP_DEFLATED) as destination:
            for member in sorted(source.namelist()):
                info=zipfile.ZipInfo(member,(2026,10,12,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
                destination.writestr(info,source.read(member))
        contents['ppt/embeddings/data.xlsx']=deterministic.getvalue()
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,body in sorted(contents.items()):
            info=zipfile.ZipInfo(name,(2026,10,12,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,body.encode() if isinstance(body,str) else body)

def _package(path):
    from .office_package import read_office_parts
    parts=read_office_parts(path)
    required={'[Content_Types].xml','_rels/.rels','ppt/presentation.xml','ppt/_rels/presentation.xml.rels'}
    if not required.issubset(parts):raise BenchError('PPTX required package member missing')
    return parts

def _slide_paths(parts):
    from .office_package import relationship_map
    presentation=ET.fromstring(parts['ppt/presentation.xml'])
    relations=relationship_map(parts,'ppt/presentation.xml')
    return [relations[x.get('{'+R+'}id')]['target'] for x in presentation.findall('p:sldIdLst/p:sldId',NS)]

def _texts(node):return [x.text or '' for x in node.findall('.//a:t',NS)]

def check_presentation(path, task, root):
    parts=_package(path);slides=_slide_paths(parts)
    if len(slides)!=3:return False,'Expected exactly 3 slides'
    nodes=[ET.fromstring(parts[name]) for name in slides]
    texts=[' '.join(_texts(node)) for node in nodes]
    values=[1200,1500,2100] if task=='R-P02-update-brief' else [1200,1500,1800]
    if not all(token in texts[0] for token in ['Quarterly sales','SGD']):return False,'Slide 1 missing required editable text'
    if str(sum(values)) not in texts[0].replace(',',''):return False,'Slide 1 total incorrect'
    if 'Monthly sales' not in texts[1] or not all(token in texts[2] for token in ['Next steps','Review March demand','Synthetic fixture']):return False,'Required editable slide text missing'
    for node in nodes:
        for run in node.findall('.//a:r',NS):
            if not ''.join(run.itertext()).strip():continue
            prop=run.find('a:rPr',NS)
            if prop is not None and prop.get('sz') and int(prop.get('sz'))<1200:return False,'Required visible text smaller than 12 pt'
        if any(x.get('hidden')=='1' for x in node.findall('.//p:cNvPr',NS)):return False,'Hidden required slide objects unsupported'
    chart_refs=nodes[1].findall('.//c:chart',NS)
    if not chart_refs:return False,'Slide 2 lacks native editable chart'
    from .office_package import relationship_map
    relations=relationship_map(parts,slides[1])
    chartname=relations[chart_refs[0].get('{'+R+'}id')]['target']
    chart=ET.fromstring(parts[chartname])
    if chart.find('.//c:barChart',NS) is None:return False,'Expected native column chart'
    direction=chart.find('.//c:barDir',NS)
    if direction is not None and direction.get('val')!='col':return False,'Expected column chart'
    cats=[x.text for x in chart.findall('.//c:cat//c:pt/c:v',NS)]
    nums=[float(x.text) for x in chart.findall('.//c:val//c:pt/c:v',NS)]
    if cats!=['January','February','March'] or nums!=values:return False,'Native chart categories/values incorrect'
    external=chart.find('c:externalData',NS)
    if external is None:return False,'Chart lacks embedded editable workbook'
    crels=relationship_map(parts,chartname)
    workbookname=crels[external.get('{'+R+'}id')]['target']
    with tempfile.TemporaryDirectory() as tmp:
        workbook=Path(tmp)/'embedded.xlsx';workbook.write_bytes(parts[workbookname])
        from .checks import workbook_cells
        cells=workbook_cells(workbook)
        # Follow actual chart formulas; valid editors may use any sheet/column/range.
        def referenced_values(formula):
            if not formula:raise UnsupportedArtifact('Chart cell references unavailable; cannot independently bind embedded data')
            match=re.fullmatch(r"=?('(?:[^']|'')+'|[^!]+)!\$?([A-Z]+)\$?([1-9][0-9]*):\$?([A-Z]+)\$?([1-9][0-9]*)",formula.strip(),re.I)
            if not match:raise UnsupportedArtifact('Unsupported chart cell-range expression: '+formula)
            sheet,col1,row1,col2,row2=match.groups();sheet=sheet[1:-1].replace("''", "'") if sheet.startswith("'") else sheet
            def column_number(name):
                result=0
                for letter in name.upper():result=result*26+ord(letter)-64
                return result
            def column_name(number):
                result=''
                while number:number,remainder=divmod(number-1,26);result=chr(65+remainder)+result
                return result
            c1,c2=column_number(col1),column_number(col2);r1,r2=int(row1),int(row2)
            if c1==c2 and r2-r1==2:refs=[col1.upper()+str(row) for row in range(r1,r2+1)]
            elif r1==r2 and c2-c1==2:refs=[column_name(col)+str(r1) for col in range(c1,c2+1)]
            else:raise BenchError('Expected three-point chart range')
            return [cells.get(sheet+'!'+ref,{}).get('value') for ref in refs]
        category_formula=chart.findtext('.//c:cat//c:f',namespaces=NS)
        value_formula=chart.findtext('.//c:val//c:f',namespaces=NS)
        actual_categories=referenced_values(category_formula);actual_values=referenced_values(value_formula)
        if actual_categories!=['January','February','March'] or [float(v) for v in actual_values]!=values:return False,'Embedded workbook disagrees with chart or required labels'
    if task=='R-P02-update-brief':
        original=_package(root/'fixtures/extensions/presentation-template.pptx')
        orig_node=ET.fromstring(original[_slide_paths(original)[2]])
        # Compare visible object semantics, allowing namespace/serialization changes by editors.
        def canonical(element):
            return (element.tag,tuple(sorted(element.attrib.items())),(element.text or '').strip(),tuple(canonical(child) for child in element))
        def signatures(node):
            tree=node.find('p:cSld/p:spTree',NS)
            return [canonical(x) for x in tree if x.tag.split('}')[-1] not in {'nvGrpSpPr','grpSpPr'}]
        if signatures(nodes[2])!=signatures(orig_node):return False,'Slide 3 native objects changed outside requested scope'
    return True,'Native slide text, chart caches, embedded data and preservation checked'

def check_render(path, output_dir, task):
    from .office_engine import render_pdf, OfficeEngineError, OfficeEngineUnavailable
    evidence=output_dir/'.assessor'/task;evidence.mkdir(parents=True,exist_ok=True)
    try:
        with render_pdf(path,timeout_seconds=30) as conversion:
            pdf=conversion.path
            if not pdf.read_bytes().startswith(b'%PDF-'):return False,'Office engine produced invalid PDF'
            shutil.copyfile(pdf,evidence/'render.pdf')
            observed={'origin':'ASSESSOR_OFFICE_RENDER','engine_version':conversion.engine_version,'artifact_sha256':sha256(path),'pdf_sha256':sha256(pdf)}
            write_json(evidence/'render.json',observed)
            return True,'Office engine rendered PPTX to PDF; evidence='+str((evidence/'render.pdf').relative_to(output_dir))
    except OfficeEngineUnavailable as exc:return None,'UNKNOWN: '+str(exc)
    except OfficeEngineError as exc:return None,'UNKNOWN: configured Office engine could not render artifact: '+str(exc)

def check_files(directory, index, root):
    mapping=load_json(root/'fixtures/extensions/file-rules.json')['data']['destinations']
    if any(p.is_symlink() for p in directory.rglob('*')):return False,'Organized output cannot contain symlinks'
    actual={str(p.relative_to(directory)) for p in directory.rglob('*') if p.is_file()}
    if actual!=set(mapping.values()):return False,'Organized directory has missing, duplicate or extra files'
    with index.open(encoding='utf-8',newline='') as stream:
        reader=csv.DictReader(stream)
        if reader.fieldnames!=['source','destination','sha256']:return False,'Index columns differ from public contract'
        rows=list(reader)
    if len(rows)!=len(mapping) or len({r['source'] for r in rows})!=len(rows):return False,'Index must contain each source exactly once'
    by_source={r['source']:r for r in rows}
    for source,destination in mapping.items():
        original=safe_path(root/'fixtures/extensions/file-inbox',source)
        target=safe_path(directory,destination)
        row=by_source.get(source,{})
        if sha256(original)!=sha256(target) or row.get('destination')!=destination or row.get('sha256')!=sha256(target):return False,'File bytes, destination or index hash mismatch: '+source
    return True,'All source bytes, destination paths and independent hashes match'

def evaluate_artifact(check,response,output_dir,root):
    try:
        value=get_path(response,check['path'])
        if not isinstance(value,str) or not value:return False,'Artifact path must be a nonempty relative string'
        path=safe_path(output_dir,value)
        if check['kind']=='ui_behavior':
            from .ui_check import check_ui
            return check_ui(path,check['task'],output_dir,root)
        if check['kind']=='distinct_stage_artifacts':
            initial=safe_path(output_dir,get_path(response,check['other_path']))
            if initial.parent==path.parent:return False,'Initial and revised UI must have separate artifact directories'
            return (initial.is_file() and path.is_file() and sha256(initial)!=sha256(path),'Separate stage artifacts must differ and both be preserved')
        if check['kind']=='presentation_contract':return check_presentation(path,check['task'],root)
        if check['kind']=='presentation_render':
            _package(path)
            return check_render(path,output_dir,check['task'])
        if check['kind']=='file_organization':
            if not path.is_dir():return False,'Organized output directory missing'
            return check_files(path,safe_path(output_dir,get_path(response,check['index_path'])),root)
        return None,'UNKNOWN: unsupported extension check'
    except UnsupportedArtifact as exc:
        return None,'UNKNOWN: '+str(exc)
    except (BenchError,KeyError,ValueError,OSError,ET.ParseError,zipfile.BadZipFile,TypeError,IndexError) as exc:
        return False,'Artifact validation failed: '+str(exc)

def materialize_reference(case,contract,output_dir,root):
    output_dir.mkdir(parents=True,exist_ok=True)
    response=deepcopy(contract['reference_response']);sid=case['id']
    if case.get('capability')=='generative_ui':
        for key,value in response['result'].items():
            task='R-U05-initial' if key=='ui_initial_file' else sid
            target=safe_path(output_dir,value);target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(reference_ui(task),encoding='utf-8')
    elif sid.startswith('R-P'):
        write_reference_presentation(output_dir/'brief.pptx',[1200,1500,2100 if sid=='R-P02-update-brief' else 1800])
    else:
        mapping=load_json(root/'fixtures/extensions/file-rules.json')['data']['destinations']
        rows=[]
        for source,destination in mapping.items():
            target=safe_path(output_dir/'organized',destination);target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(root/'fixtures/extensions/file-inbox'/source,target)
            rows.append({'source':source,'destination':destination,'sha256':sha256(target)})
        with (output_dir/'index.csv').open('w',encoding='utf-8',newline='') as stream:
            writer=csv.DictWriter(stream,fieldnames=['source','destination','sha256'],lineterminator='\n');writer.writeheader();writer.writerows(rows)
    write_json(output_dir/'response.json',response)
    return response

def reference_ui(task):
    """Small reference control deliberately kept outside exported candidate inputs."""
    common='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Control UI</title><style>body{font:18px Arial;margin:32px;max-width:1000px}label{display:inline-block;margin:12px}input,select,button{font:inherit;padding:8px}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{padding:9px;border-bottom:1px solid #ddd}output{display:block;margin:12px} [role=alert]{color:#a21c1c}</style><body><h1>Business workspace</h1>'
    dashboard=task in {'R-U01-dashboard','R-U05-iterative-edit','R-U05-initial'}
    if dashboard:
        sort=task!='R-U05-initial'
        body='<label>Region<select aria-label="Region" id="region"><option>ALL</option><option>SG</option><option>HK</option><option>JP</option></select></label><label>Month<select aria-label="Month" id="month"><option>ALL</option><option>2026-01</option><option>2026-02</option><option>2026-03</option></select></label>'
        if sort:body+='<label>Sort<select aria-label="Sort" id="sort"><option>original</option><option>amount_desc</option><option>amount_asc</option></select></label>'
        body+='<button id="reset">Reset</button><output role="status" aria-label="Revenue" id="revenue"></output><output role="status" aria-label="Count" id="count"></output><p id="empty"></p><table aria-label="Sales"><thead><tr><th>ID</th><th>Month</th><th>Region</th><th>Amount</th></tr></thead><tbody id="rows"></tbody></table>'
        script="""let sales=[];const region=document.querySelector('#region'),month=document.querySelector('#month'),sort=document.querySelector('#sort');function render(){let found=sales.filter(r=>r.type==='SALE'&&(region.value==='ALL'||r.region===region.value)&&(month.value==='ALL'||r.month===month.value));if(sort&&sort.value!=='original')found.sort((a,b)=>(sort.value==='amount_desc'?b.amount-a.amount:a.amount-b.amount)||a.id.localeCompare(b.id));document.querySelector('#revenue').textContent=found.reduce((s,r)=>s+r.amount,0).toFixed(2);document.querySelector('#count').textContent=found.length;document.querySelector('#empty').textContent=found.length?'':'No results';document.querySelector('#rows').innerHTML=found.map(r=>`<tr><td>${r.id}</td><td>${r.month}</td><td>${r.region}</td><td>${r.amount.toFixed(2)}</td></tr>`).join('');}document.querySelector('#reset').onclick=()=>{region.value='ALL';month.value='ALL';if(sort)sort.value='original';render();};for(const element of [region,month,sort].filter(Boolean))element.onchange=render;fetch('/data.json').then(r=>r.json()).then(data=>{sales=data;render();});"""
    elif task=='R-U02-form':
        body='<label>Name<input id="name"></label><label>Email<input id="email" type="email"></label><label>Seats<input id="seats" type="number" value="1"></label><label>Terms<input id="terms" type="checkbox"></label><output role="status" aria-label="Total" id="total">12.50</output><p role="alert" id="alert"></p><button id="preview">Preview</button><button id="submit">Submit</button><output role="status" aria-label="Preview" id="previewOut"></output><output role="status" aria-label="Receipt" id="receipt"></output>'
        script="""const field=id=>document.getElementById(id);let sent=false;function value(){return{name:field('name').value.trim(),email:field('email').value.trim(),seats:Number(field('seats').value),total:(Number(field('seats').value)*12.5).toFixed(2)};}function valid(){const v=value(),ok=v.name&&/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v.email)&&Number.isInteger(v.seats)&&v.seats>=1&&v.seats<=20&&field('terms').checked;field('alert').textContent=ok?'':'Complete valid name, email, seats and terms';return !!ok;}field('seats').oninput=()=>field('total').textContent=value().total;field('preview').onclick=()=>{if(valid())field('previewOut').textContent=JSON.stringify(value());};field('submit').onclick=async()=>{if(sent||!valid())return;sent=true;field('submit').disabled=true;const r=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value())});field('receipt').textContent=(await r.json()).id;};"""
    elif task=='R-U03-calculator':
        body='<label>Units<input id="units" type="number" value="10"></label><label>Price<input id="price" type="number" value="25"></label><label>Discount<input id="discount" type="number" value="0"></label><output role="status" aria-label="Quote" id="quote"></output><p role="alert" id="alert"></p>'
        script="""const fields=['units','price','discount'].map(x=>document.getElementById(x));function render(){const [u,p,d]=fields.map(x=>Number(x.value));const valid=fields.every(x=>x.value!=='')&&u>=0&&u<=1000&&p>=0&&p<=10000&&d>=0&&d<=100&&[u,p,d].every(Number.isFinite);document.getElementById('alert').textContent=valid?'':'Invalid input';document.getElementById('quote').textContent=valid?(Math.round((u*p*(1-d/100)+Number.EPSILON)*100)/100).toFixed(2):'—';}fields.forEach(x=>x.oninput=render);render();"""
    elif task=='R-U04-record-detail':
        body='<label>Search<input id="search"></label><section id="list"><p id="empty"></p><table aria-label="Records"><thead><tr><th>ID</th><th>Name</th><th>Region</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table></section><dialog aria-label="Record details" id="detail"><div id="details"></div><button id="back">Back</button></dialog>'
        script="""let data=[];const search=document.querySelector('#search'),dialog=document.querySelector('#detail');function render(){const found=data.filter(r=>[r.id,r.name,r.region].join(' ').toLowerCase().includes(search.value.toLowerCase()));document.querySelector('#empty').textContent=found.length?'':'No results';const rows=document.querySelector('#rows');rows.replaceChildren();for(const r of found){const tr=document.createElement('tr');for(const value of [r.id,r.name,r.region]){const td=document.createElement('td');td.textContent=value;tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='View '+r.id;button.onclick=()=>{document.querySelector('#details').textContent=[r.id,r.name,r.region,r.email||'Unknown'].join(' | ');dialog.showModal();};td.append(button);tr.append(td);rows.append(tr);}}search.oninput=render;document.querySelector('#back').onclick=()=>dialog.close();fetch('/data.json').then(r=>r.json()).then(r=>{data=r;render();});"""
    elif task=='R-U06-data-update':
        body='<output role="status" aria-label="Revenue" id="revenue"></output><output role="status" aria-label="Count" id="count"></output><output role="status" aria-label="Unknown count" id="unknown"></output><p id="empty"></p>'
        script="""const dataset=new URLSearchParams(location.search).get('dataset')||'base';fetch('/data.json?dataset='+encodeURIComponent(dataset)).then(r=>r.json()).then(data=>{const sales=data.filter(r=>r.type==='SALE');document.querySelector('#revenue').textContent=sales.reduce((s,r)=>s+(typeof r.amount==='number'?r.amount:0),0).toFixed(2);document.querySelector('#count').textContent=sales.length;document.querySelector('#unknown').textContent=sales.filter(r=>typeof r.amount!=='number').length;document.querySelector('#empty').textContent=sales.length?'':'No results';});"""
    else:raise BenchError('Unknown reference UI task')
    return common+body+'<script>'+script+'</script></body></html>'
