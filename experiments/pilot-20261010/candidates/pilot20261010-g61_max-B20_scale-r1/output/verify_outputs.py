from pathlib import Path
import csv
import json
import sqlite3
import zipfile
from decimal import Decimal
import xml.etree.ElementTree as ET
import jsonschema

BASE = Path('/workspace/shared/counso-pilot-20261010/candidates/pilot20261010-g61_max-B20_scale-r1')
INPUT = BASE / 'input'
OUTPUT = BASE / 'output'
response = json.loads((OUTPUT / 'response.json').read_text())
schema = json.loads((INPUT / 'response_schema.json').read_text())
jsonschema.Draft202012Validator(schema).validate(response)

def read_csv(path):
    with path.open(newline='', encoding='utf-8') as file:
        return list(csv.DictReader(file))

invoices = read_csv(INPUT / 'inputs/ledger-scale/invoices.csv')
receipts = read_csv(INPUT / 'inputs/ledger-scale/receipts.csv')
credits = read_csv(INPUT / 'inputs/ledger-scale/credits.csv')
ledger = read_csv(OUTPUT / 'ledger.csv')

def cents(value):
    return int(Decimal(value) * 100)

db = sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE invoices(invoice_id TEXT PRIMARY KEY, entity_id TEXT, jurisdiction TEXT, currency TEXT, due_date TEXT, amount INTEGER);
CREATE TABLE receipts(receipt_id TEXT PRIMARY KEY, invoice_id TEXT, entity_id TEXT, amount INTEGER, allocation TEXT);
CREATE TABLE credits(credit_id TEXT PRIMARY KEY, invoice_id TEXT, amount INTEGER);
''')
db.executemany('INSERT INTO invoices VALUES(?,?,?,?,?,?)', [
    (r['invoice_id'], r['entity_id'], r['jurisdiction'], r['currency'], r['due_date'], cents(r['amount'])) for r in invoices
])
db.executemany('INSERT INTO receipts VALUES(?,?,?,?,?)', [
    (r['receipt_id'], r['invoice_id'], r['entity_id'], cents(r['amount']), r['allocation']) for r in receipts
])
db.executemany('INSERT INTO credits VALUES(?,?,?)', [
    (r['credit_id'], r['invoice_id'], cents(r['amount'])) for r in credits
])
expected = db.execute('''
WITH receipt_totals AS (
    SELECT invoice_id, SUM(amount) amount
    FROM receipts
    WHERE allocation='APPLIED' AND invoice_id<>''
    GROUP BY invoice_id
), credit_totals AS (
    SELECT invoice_id, SUM(amount) amount FROM credits GROUP BY invoice_id
), joined AS (
    SELECT i.invoice_id, i.entity_id, i.amount,
           COALESCE(r.amount,0) applied_receipts,
           COALESCE(c.amount,0) credits,
           i.amount - COALESCE(r.amount,0) - COALESCE(c.amount,0) balance
    FROM invoices i
    LEFT JOIN receipt_totals r ON i.invoice_id=r.invoice_id
    LEFT JOIN credit_totals c ON i.invoice_id=c.invoice_id
    WHERE i.jurisdiction='SG' AND i.currency='SGD' AND i.due_date<'2026-07-10'
)
SELECT * FROM joined WHERE balance>0 ORDER BY invoice_id
''').fetchall()
assert len(expected) == len(ledger) == response['result']['eligible_rows']
for correct, actual in zip(expected, ledger):
    assert (actual['invoice_id'], actual['entity_id']) == correct[:2]
    assert tuple(cents(actual[k]) for k in ['amount', 'applied_receipts', 'credits', 'balance']) == correct[2:]
assert sum(row[5] for row in expected) == cents(response['result']['balance_sgd'])
for status, result_key in [('UNALLOCATED', 'unallocated_sgd'), ('UNMATCHED', 'unmatched_sgd')]:
    assert db.execute('SELECT SUM(amount) FROM receipts WHERE allocation=?', [status]).fetchone()[0] == cents(response['result'][result_key])

NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
numeric_cells = 0
text_cells = 0
formula_count = 0
with zipfile.ZipFile(OUTPUT / 'ledger.xlsx') as archive:
    assert archive.testzip() is None
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    sheets = workbook.find('x:sheets', NS)
    assert len(sheets) == 1 and sheets[0].get('name') == 'Ledger'
    styles = ET.fromstring(archive.read('xl/styles.xml'))
    xfs = styles.find('x:cellXfs', NS)
    formats = {0: 'General', 49: '@'}
    custom_formats = styles.find('x:numFmts', NS)
    if custom_formats is not None:
        formats.update({int(fmt.get('numFmtId')): fmt.get('formatCode') for fmt in custom_formats})
    shared_strings = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        shared = ET.fromstring(archive.read('xl/sharedStrings.xml'))
        shared_strings = [''.join(n.text or '' for n in item.iter('{' + NS['x'] + '}t')) for item in shared]
    worksheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    rows = worksheet.find('x:sheetData', NS)
    assert len(rows) == len(expected) + 1

    def cell_value(cell):
        cell_type = cell.get('t')
        value = cell.find('x:v', NS)
        if cell_type == 's':
            return shared_strings[int(value.text)]
        if cell_type == 'inlineStr':
            return ''.join(node.text or '' for node in cell.find('x:is', NS).iter('{' + NS['x'] + '}t'))
        return value.text if value is not None else None

    assert [cell_value(cell) for cell in rows[0]] == ['invoice_id', 'entity_id', 'amount', 'applied_receipts', 'credits', 'balance']
    for index, row in enumerate(rows[1:]):
        cells = {cell.get('r'): cell for cell in row}
        row_num = index + 2
        assert int(row.get('r')) == row_num
        correct = expected[index]
        assert len(cells) == 6
        for column, field in [('A', 0), ('B', 1)]:
            cell = cells[f'{column}{row_num}']
            assert cell.get('t') in ('s', 'inlineStr', 'str')
            assert cell_value(cell) == correct[field]
            style = xfs[int(cell.get('s', '0'))]
            assert formats[int(style.get('numFmtId'))] == '@'
            text_cells += 1
        for column, field in [('C', 2), ('D', 3), ('E', 4), ('F', 5)]:
            cell = cells[f'{column}{row_num}']
            assert cell.get('t') in (None, 'n')
            assert cell_value(cell) is not None
            assert int((Decimal(cell_value(cell)) * 100).to_integral_value()) == correct[field]
            numeric_cells += 1
            if column == 'F':
                formula = cell.find('x:f', NS)
                assert formula is not None and formula.text == f'ROUND(C{row_num}-D{row_num}-E{row_num},2)'
                formula_count += 1
    assert numeric_cells == 9600 and text_cells == 4800 and formula_count == 2400
    # The optional OOXML dimension node may be omitted; populated rows and cells
    # above are the authoritative extent check.
    dimension_node = worksheet.find('x:dimension', NS)
    dimension = dimension_node.get('ref') if dimension_node is not None else 'A1:F2401 (verified from actual populated cells)'

report = {
    'response_schema_valid': True,
    'independent_sql_integer_cents_join_matches_every_csv_row': True,
    'full_input_counts': {'invoices': len(invoices), 'receipts': len(receipts), 'credits': len(credits)},
    'eligible_rows': len(expected),
    'balance_sgd': response['result']['balance_sgd'],
    'unallocated_sgd': response['result']['unallocated_sgd'],
    'unmatched_sgd': response['result']['unmatched_sgd'],
    'xlsx_valid_zip': True,
    'xlsx_sheet_names': ['Ledger'],
    'xlsx_dimensions': dimension,
    'xlsx_every_cell_matches_expected': True,
    'xlsx_text_identifier_cells': text_cells,
    'xlsx_identifier_numfmt': '@',
    'xlsx_numeric_amount_cells': numeric_cells,
    'xlsx_balance_formula_count': formula_count,
    'xlsx_balance_formula_caches_verified': True,
    'external_application_open_test_performed': False,
}
(OUTPUT / 'final_validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
