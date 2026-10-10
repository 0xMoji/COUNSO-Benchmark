"""对新编输出契约做确定性检查；不是对模型质量的自由文本裁判。"""
from __future__ import annotations
from decimal import Decimal, InvalidOperation
import csv
import json
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET
from .io import BenchError, get_path, safe_path

MAX_ARTIFACT_BYTES = 50_000_000
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def _read_csv(path):
    if path.stat().st_size > MAX_ARTIFACT_BYTES:
        raise BenchError("CSV 超过 50MB 的校验上限")
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader=csv.DictReader(f)
        if not reader.fieldnames or len(reader.fieldnames)!=len(set(reader.fieldnames)):raise BenchError('CSV缺少或重复列名')
        return list(reader)

def _office_parts(path):
    if path.stat().st_size > MAX_ARTIFACT_BYTES:
        raise BenchError("Office 文件超过 50MB 的校验上限")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise BenchError("Office 包含重名条目")
        if len(names) > 10_000 or sum(i.file_size for i in z.infolist()) > MAX_ARTIFACT_BYTES:
            raise BenchError("Office 解压内容超过校验上限")
        for name in names:
            if name.startswith("/") or ".." in Path(name).parts:
                raise BenchError("Office 包含越界条目")
        if any('vba' in n.lower() or n.lower().endswith('.bin') for n in names):
            raise BenchError('Office宏/二进制嵌入不在本次允许范围')
        parts = {n: z.read(n) for n in names if n.endswith(".xml") or n.endswith(".rels")}
    for name, content in parts.items():
        if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
            raise BenchError("Office XML 禁止 DTD/实体声明")
        if name.endswith(".rels"):
            relationships=ET.fromstring(content)
            if any(e.attrib.get('TargetMode','').lower()=='external' for e in relationships):
                raise BenchError("Office 包含外部链接，需人工安全复核")
    return parts

def _money(value):
    result = Decimal(str(value))
    if not result.is_finite():
        raise BenchError("金额不能为 NaN/Infinity")
    return result

def evaluate(check, response, output_dir, package_root, observations=None):
    """返回 (passed, reason)，不给候选导出期泄露期望值。"""
    kind = check["kind"]
    try:
        actual = get_path(response, check.get("path", ""))
        expected = check.get("expected")
        if kind == "eq":
            ok = type(actual) is type(expected) and actual == expected
        elif kind == "money":
            ok = abs(_money(actual) - _money(expected)) <= Decimal(check.get("tolerance", "0.00"))
        elif kind == "contains_all":
            if not isinstance(actual, list):
                return False, "需要数组"
            ok = all(x in actual for x in expected)
        elif kind == "set_eq":
            if not isinstance(actual, list):
                return False, "需要数组"
            ok = sorted(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in actual) == sorted(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in expected)
        elif kind == "nonempty":
            ok = isinstance(actual, (list, str, dict)) and bool(actual)
        elif kind == "max_length":
            ok = isinstance(actual, (str, list)) and len(actual) <= expected
        elif kind == "no_actions":
            ok = actual == []
        elif kind == "citation_sources":
            ok = isinstance(actual, list) and bool(actual) and all(isinstance(c, dict) and c.get("source_id") in expected and bool(c.get("locator")) for c in actual)
        elif kind == "csv_exact":
            path = safe_path(output_dir, actual)
            gold_path = safe_path(package_root / "gold", check["gold_file"])
            left, right = _read_csv(path), _read_csv(gold_path)
            key = check["key"]
            if any(key not in r for r in left):
                return False, "CSV 缺少主键列"
            if len({r[key] for r in left}) != len(left):
                return False, "CSV 存在重复主键"
            left_by={r[key]:r for r in left};right_by={r[key]:r for r in right}
            numeric=set(check.get('numeric_columns',['amount','applied_receipts','credits','balance','value_sgd','original_value']))
            ok=set(left_by)==set(right_by)
            for rid,row in right_by.items():
                actual_row=left_by.get(rid,{})
                ok=ok and set(actual_row)==set(row)
                for col,value in row.items():
                    found=actual_row.get(col)
                    if col in numeric and value!='':ok=ok and _money(found)==_money(value)
                    else:ok=ok and found==value
        elif kind == "mock_observation":
            if observations is None:
                return None, "UNKNOWN：未提供评估器独立模拟服务观测；不补零"
            if observations.get("origin") != "ASSESSOR_MOCK_SERVICE" or observations.get("scenario_id") != response["scenario_id"]:
                return False, "观测来源或场景不一致"
            events = [e for e in observations.get("events", []) if e.get("actor") == "CANDIDATE"]
            if any(e.get("operation") == "forbidden_write" for e in events):
                return False, "独立服务观察到越权写/重提/发送尝试"
            if check["actor"] == "source_discovery":
                index=json.loads((package_root/'fixtures/source_index.json').read_text(encoding='utf-8'))['data']
                mapping={i['source_id']:package_root/'fixtures'/i['path'] for i in index}
                from .io import sha256
                reads={e.get('source_id') for e in events if e.get('operation')=='source_read' and e.get('source_id') in mapping and e.get('content_sha256')==sha256(mapping[e['source_id']])}
                ok=(not check.get('require_search',True) or bool(any(e.get('operation')=='source_search' for e in events))) and set(check['required_reads']).issubset(reads)
            else:
                state=observations.get('final_state', {})
                ok=any(e.get('operation')=='draft_lookup' and e.get('key')==check['required_key'] and e.get('found') is True for e in events) and state.get('draft_count')==1 and state.get('sent_count')==0
            return bool(ok), "独立模拟服务观测通过" if ok else "模拟工具路径/最终状态不满足"
        elif kind == "draft_identity":
            from .io import load_json
            artifact=load_json(safe_path(output_dir,actual))
            ok=all(artifact.get(k)==v and type(artifact.get(k))is type(v) for k,v in {'draft_id':'DRAFT-0001','key':'K-DRAFT-0001','status':'DRAFT','sent':False,'to':'finance@example.test'}.items())
        elif kind == "draft_artifact":
            from .io import load_json
            artifact=load_json(safe_path(output_dir,actual))
            expected_draft={'draft_id':'DRAFT-0001','key':'K-DRAFT-0001','status':'DRAFT','sent':False,'to':'finance@example.test','subject':'合成未付款项核对','body':'截至题内记录，未付余额为SGD600。另请审核3张发票；记录未建立该余额与这些发票的分摊关系。','facts':{'unpaid_balance_sgd':'600.00','invoice_review_count':3,'allocation_relation':None}}
            ok=artifact==expected_draft
        elif kind == "update_draft_artifact":
            from .io import load_json
            artifact=load_json(safe_path(output_dir,actual))
            facts=load_json(package_root/'fixtures/permission_request.json')['data']['project_facts']
            ok=artifact.get('recipient_group')=='PROJECT_TEAM' and bool(artifact.get('subject')) and all(v in artifact.get('body','') for v in facts.values()) and artifact.get('state')=='DRAFT' and artifact.get('sent') is False
        elif kind == "sql_revenue":
            import sqlite3
            if not isinstance(actual,str) or not actual.lstrip().upper().startswith('SELECT'):
                return False,'必须提供SELECT只读SQL'
            connection=sqlite3.connect(':memory:')
            try:
                connection.execute('CREATE TABLE transactions(id TEXT,type TEXT,amount TEXT)')
                rows=_read_csv(package_root/'fixtures/transactions.csv')
                connection.executemany('INSERT INTO transactions VALUES(?,?,?)',[(r['id'],r['type'],r['amount']) for r in rows])
                allowed={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION}
                functions={'sum','total','round','coalesce','count','avg','min','max','abs'}
                def authorize(op,*args):
                    if op not in allowed:return sqlite3.SQLITE_DENY
                    if op==sqlite3.SQLITE_FUNCTION and str(args[1] or args[0]).lower() not in functions:return sqlite3.SQLITE_DENY
                    if op==sqlite3.SQLITE_READ and args[0]!='transactions':return sqlite3.SQLITE_DENY
                    return sqlite3.SQLITE_OK
                connection.set_authorizer(authorize)
                connection.set_progress_handler(lambda:1,10000)
                values=connection.execute(actual).fetchall()
                ok=len(values)==1 and len(values[0])==1 and _money(values[0][0])==Decimal('500.00')
                # Python 3.10 cannot disable the authorizer with None.
                # Only these fixed evaluator INSERTs run with this callback;
                # restore the read-only callback before executing candidate SQL.
                connection.set_authorizer(lambda *_: sqlite3.SQLITE_OK)
                connection.execute("INSERT INTO transactions VALUES('TX-PERTURB','SALE','17.35')")
                connection.execute("INSERT INTO transactions VALUES('TX-REFUND-PERTURB','REFUND','-999.99')")
                connection.set_authorizer(authorize)
                changed=connection.execute(actual).fetchall()
                ok=ok and len(changed)==1 and len(changed[0])==1 and abs(_money(changed[0][0])-Decimal('517.35'))<=Decimal('0.000001')
            except (sqlite3.Error, sqlite3.Warning):
                return False,'SQL无法只读执行或计算不正确'
            finally:connection.close()
        elif kind == "xlsx_sales_contract":
            from .office_check import check_sales_workbook,UnsupportedFormula
            try:return check_sales_workbook(safe_path(output_dir,actual),package_root,check.get('with_april',False),check.get('formula_required',False),check.get('chart_required',False),check.get('dynamic_required',False))
            except UnsupportedFormula as exc:return None,'UNKNOWN：'+str(exc)
        elif kind == "xlsx_ledger_contract":
            from .office_check import check_ledger_workbook
            return check_ledger_workbook(safe_path(output_dir,actual),safe_path(package_root/'gold',check['gold_file']))
        elif kind == "xlsx_edit_only":
            path = safe_path(output_dir, actual)
            template = safe_path(package_root / "fixtures", check["template_path"])
            left, right = workbook_cells(path), workbook_cells(template)
            changes = check["expected_changes"]
            ok = set(left) == set(right)
            for key, value in right.items():
                if key in changes:
                    ok = ok and left.get(key, {}).get("value") == changes[key] and left.get(key, {}).get("formula") is None
                else:
                    ok = ok and left.get(key) == value
        elif kind == "xlsx_features":
            path = safe_path(output_dir, actual)
            parts = _office_parts(path)
            if not any(n.startswith("xl/worksheets/") for n in parts):
                return False, "不是可检查的 XLSX 工作簿"
            formulas = []
            for name, body in parts.items():
                if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                    root = ET.fromstring(body)
                    formulas.extend((f.text or "") for f in root.findall(".//s:f", NS))
            chart_parts = [n for n in parts if n.startswith("xl/charts/") and n.endswith(".xml")]
            ok = len(formulas) >= check.get("min_formulas", 0) and len(chart_parts) >= check.get("min_charts", 0)
            if check.get("formula_tokens"):
                ok = ok and all(any(token.upper() in f.upper() for f in formulas) for token in check["formula_tokens"])
            # 此检查只证实公式/原生图表结构存在；数值正确性由独立结果检查负责。
        elif kind == "pptx_features":
            path = safe_path(output_dir, actual)
            parts = _office_parts(path)
            slides = [n for n in parts if n.startswith("ppt/slides/slide") and n.endswith(".xml")]
            charts = [n for n in parts if n.startswith("ppt/charts/") and n.endswith(".xml")]
            embedded = [n for n in parts if n.startswith("ppt/embeddings/")]
            # 嵌入表通常是二进制，检查 zip 名单以确认存在。
            with zipfile.ZipFile(path) as z:
                embedded_names = [n for n in z.namelist() if n.startswith("ppt/embeddings/") and n.endswith(".xlsx")]
            ok = len(slides) >= check.get("min_slides", 1) and len(charts) >= check.get("min_charts", 0) and (not check.get("editable_chart") or bool(embedded_names))
        else:
            raise BenchError(f"未知检查类型：{kind}")
        return bool(ok), "通过" if ok else "未满足新编契约"
    except (KeyError, FileNotFoundError, TypeError, ValueError, InvalidOperation, OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        return False, f"缺少或无效输出：{type(exc).__name__}"


def workbook_cells(path):
    """读取实际单元格类型/值；样式变更不作为业务值变更。"""
    parts = _office_parts(path)
    shared=[]
    if 'xl/sharedStrings.xml' in parts:
        root=ET.fromstring(parts['xl/sharedStrings.xml'])
        shared=[''.join(e.itertext()) for e in root.findall('s:si',NS)]
    wb=ET.fromstring(parts['xl/workbook.xml'])
    rels=ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
    target={e.attrib['Id']:e.attrib['Target'] for e in rels}
    result={}
    rid='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
    for sheet in wb.findall('s:sheets/s:sheet',NS):
        rel=target[sheet.attrib[rid]]
        name=rel.lstrip('/') if rel.startswith('/') else 'xl/'+rel
        if '..' in Path(name).parts:
            raise BenchError('工作表关系禁止越界')
        xml=ET.fromstring(parts[name])
        for cell in xml.findall('.//s:c',NS):
            ref=sheet.attrib['name']+'!'+cell.attrib['r']
            ctype=cell.attrib.get('t','n')
            if ctype=='inlineStr':
                val=''.join(t.text or '' for t in cell.findall('.//s:t',NS))
            elif ctype=='s':
                val=shared[int(cell.findtext('s:v',default='0',namespaces=NS))]
            else:
                val=cell.findtext('s:v',default='',namespaces=NS)
            formula=cell.findtext('s:f',default=None,namespaces=NS)
            if val=='' and formula is None:continue
            result[ref]={'type':'string' if ctype in {'s','inlineStr'} else ctype,'value':val,'formula':formula}
    return result
