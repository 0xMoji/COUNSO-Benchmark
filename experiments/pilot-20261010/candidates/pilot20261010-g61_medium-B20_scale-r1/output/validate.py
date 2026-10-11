import csv, json, hashlib
from pathlib import Path
from decimal import Decimal
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import jsonschema

out=Path(__file__).resolve().parent
inp=out.parent/'input'
response=json.loads((out/'response.json').read_text())
jsonschema.Draft202012Validator(json.loads((inp/'response_schema.json').read_text())).validate(response)
with (out/'ledger.csv').open(newline='') as f: rows=list(csv.reader(f))
assert len(rows)-1==response['result']['eligible_rows']==2400
assert len({r[0] for r in rows[1:]})==2400
assert all(len(r[0])==8 and r[0].startswith('0') for r in rows[1:])
assert all(Decimal(r[2])-Decimal(r[3])-Decimal(r[4])==Decimal(r[5])>0 for r in rows[1:])
assert sum((Decimal(r[5]) for r in rows[1:]),Decimal('0'))==Decimal(response['result']['balance_sgd'])
ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with ZipFile(out/'ledger.xlsx') as z:
    wb=ET.fromstring(z.read('xl/workbook.xml'))
    assert [s.attrib['name'] for s in wb.findall('x:sheets/x:sheet',ns)]==['Ledger']
    root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    xrows=root.findall('x:sheetData/x:row',ns)
    assert len(xrows)==len(rows)
    for xr,expected in zip(xrows,rows):
        cells=xr.findall('x:c',ns)
        assert len(cells)==6
        for index,(cell,value) in enumerate(zip(cells,expected)):
            actual=cell.find('x:v',ns).text
            if index<2 or xr.attrib['r']=='1':
                assert cell.attrib['t']=='str' and actual==value
            else:
                assert cell.attrib['t']=='n' and Decimal(actual)==Decimal(value)
    styles=ET.fromstring(z.read('xl/styles.xml'))
    formats={n.attrib['numFmtId']:n.attrib['formatCode'] for n in styles.findall('x:numFmts/x:numFmt',ns)}
    xfs=styles.findall('x:cellXfs/x:xf',ns)
    for xr in xrows[1:]:
        for cell in xr.findall('x:c',ns)[:2]:
            fmtid=xfs[int(cell.attrib['s'])].attrib['numFmtId']
            assert fmtid=='49' or formats.get(fmtid)=='@'

trace={
  'record_type':'self_reported_candidate_trace',
  'self_reported':True,
  'scenario_id':'B20.scale',
  'read_files':[
      str(inp/'prompt.txt'),str(inp/'response_schema.json'),str(inp/'input_manifest.json'),
      *[str(inp/f'inputs/ledger-scale/{n}') for n in ['policy.json','invoices.csv','receipts.csv','credits.csv']],
      '/home/agent/.codex/skills/builtins/spreadsheets/SKILL.md',
      '/home/agent/.codex/skills/builtins/spreadsheets/artifact_tool_docs/API_QUICK_START.md',
      '/home/agent/.codex/skills/builtins/spreadsheets/workflows/create_workflows.md',
      '/home/agent/.codex/skills/builtins/spreadsheets/style_guidelines.md',
      *[str(out/n) for n in ['response.json','ledger.csv','ledger_data.json','ledger.xlsx','workbook_checks.txt','ledger_preview.png']],
      str(out/'solve.py'),str(out/'validate.py'),'/tmp/pilot-g61medium-b20/build.mjs'
  ],
  'libraries_used':['Python standard library: csv, json, pathlib, decimal, collections, hashlib, sqlite3, zipfile, xml.etree.ElementTree','jsonschema (installed bundled Python runtime)','@oai/artifact-tool (installed bundled JavaScript runtime)','Node standard library: node:fs/promises'],
  'tools_used':['functions.exec','exec_command','apply_patch','skills.read','write_stdin','view_image'],
  'tool_errors':[{'tool':'artifact-tool rendering','message':'Fontconfig error: No writable cache directories','impact':'Nonfatal warnings. PNG preview and XLSX exported successfully.'},{'tool':'artifact-tool PNG rendering','message':'Preview displays zero-padded numeric-text invoice IDs without leading zeros despite exact strings in engine inspection and native XLSX XML.','impact':'Preview-only limitation. All 2400 XLSX invoice identifiers remain text with exact leading zeros, independently verified from saved XML.'}],
  'validation':{
      'input_hashes_match_manifest':True,
      'complete_input_counts':{'invoices':2818,'receipts':2282,'credits':37},
      'unique_invoice_primary_keys':True,
      'applied_receipt_and_credit_references_exist':True,
      'applied_receipt_entities_match':True,
      'decimal_calculation_matches_independent_sql_integer_cent_join':True,
      'eligible_rows':2400,
      'balance_sgd':'320772.27',
      'unallocated_sgd':'212.96',
      'unmatched_sgd':'168.00',
      'response_passes_json_schema':True,
      'full_csv_and_xlsx_cellwise_match':True,
      'xlsx_sheet_name':'Ledger',
      'xlsx_identifier_cells_text_and_original_leading_zeros':True,
      'xlsx_amount_cells_numeric':True,
      'artifact_tool_final_recalculation_and_error_scan':'completed; zero formula errors',
      'visual_review':'Header and six columns legible. Preview-only numeric-text formatting limitation recorded above.'
  },
  'scope_compliance':{'network_used':False,'software_installed':False,'other_agents_called':False,'external_actions':[],'run_metadata_template_read_or_written':False},
  'artifacts':[{'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [out/'response.json',out/'ledger.csv',out/'ledger.xlsx',out/'reconciliation.json']]
}
(out/'candidate_trace.json').write_text(json.dumps(trace,ensure_ascii=False,indent=2)+'\n')
print('PASS: schema, full CSV/XLSX values and types, leading zeros, totals, row count. Trace saved.')
