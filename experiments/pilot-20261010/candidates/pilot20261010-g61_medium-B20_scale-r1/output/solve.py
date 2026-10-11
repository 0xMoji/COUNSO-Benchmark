import csv, json, hashlib, sqlite3
from pathlib import Path
from decimal import Decimal
from collections import defaultdict, Counter

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / 'output'
IN = BASE / 'input'
manifest = json.loads((IN / 'input_manifest.json').read_text())
for f in manifest['files']:
    assert hashlib.sha256((IN / f['path']).read_bytes()).hexdigest() == f['sha256']
policy = json.loads((IN / 'inputs/ledger-scale/policy.json').read_text())
data = {}
for name in ('invoices', 'receipts', 'credits'):
    with (IN / f'inputs/ledger-scale/{name}.csv').open(newline='') as f:
        data[name] = list(csv.DictReader(f))
    assert len(data[name]) == policy['input_counts'][name]
assert len({r['invoice_id'] for r in data['invoices']}) == len(data['invoices'])
ids = {r['invoice_id']:r for r in data['invoices']}
applied, credits = defaultdict(Decimal), defaultdict(Decimal)
unallocated = unmatched = Decimal('0')
exception_rows = []
for line, r in enumerate(data['receipts'], 2):
    if r['allocation'] == 'APPLIED' and r['invoice_id']:
        assert r['invoice_id'] in ids
        assert r['entity_id'] == ids[r['invoice_id']]['entity_id']
        applied[r['invoice_id']] += Decimal(r['amount'])
    elif r['allocation'] == 'UNALLOCATED':
        unallocated += Decimal(r['amount'])
        exception_rows.append({'source_line':line, **r})
    elif r['allocation'] == 'UNMATCHED':
        unmatched += Decimal(r['amount'])
        exception_rows.append({'source_line':line, **r})
    else:
        raise ValueError('Unexpected allocation')
for r in data['credits']:
    assert r['invoice_id'] in ids
    credits[r['invoice_id']] += Decimal(r['amount'])
rows, exclusions = [], Counter()
for r in data['invoices']:
    k = r['invoice_id']
    amount = Decimal(r['amount'])
    balance = amount - applied[k] - credits[k]
    if r['jurisdiction'] != 'SG': exclusions['jurisdiction'] += 1
    elif r['currency'] != 'SGD': exclusions['currency'] += 1
    elif r['due_date'] >= '2026-07-10': exclusions['due_date'] += 1
    elif balance <= 0: exclusions['nonpositive_balance'] += 1
    else: rows.append([k, r['entity_id'], amount, applied[k], credits[k], balance])
rows.sort(key=lambda r:r[0])
headers = ['invoice_id','entity_id','amount','applied_receipts','credits','balance']
with (OUT / 'ledger.csv').open('w',newline='') as f:
    w=csv.writer(f); w.writerow(headers)
    w.writerows([[*r[:2], *[format(x,'.2f') for x in r[2:]]] for r in rows])
total = sum((r[5] for r in rows),Decimal('0'))
# Independent integer-cent SQL aggregation and selection.
db=sqlite3.connect(':memory:')
db.execute('CREATE TABLE i(id TEXT PRIMARY KEY, entity TEXT, j TEXT, c TEXT, due TEXT, cents INTEGER)')
db.execute('CREATE TABLE r(id TEXT, cents INTEGER, allocation TEXT)')
db.execute('CREATE TABLE cr(id TEXT, cents INTEGER)')
cents=lambda x:int(Decimal(x)*100)
db.executemany('INSERT INTO i VALUES(?,?,?,?,?,?)',[(r['invoice_id'],r['entity_id'],r['jurisdiction'],r['currency'],r['due_date'],cents(r['amount'])) for r in data['invoices']])
db.executemany('INSERT INTO r VALUES(?,?,?)',[(r['invoice_id'],cents(r['amount']),r['allocation']) for r in data['receipts']])
db.executemany('INSERT INTO cr VALUES(?,?)',[(r['invoice_id'],cents(r['amount'])) for r in data['credits']])
sqlrows=db.execute('''WITH rr AS (SELECT id,SUM(cents) a FROM r WHERE allocation='APPLIED' AND id<>'' GROUP BY id), cc AS (SELECT id,SUM(cents) a FROM cr GROUP BY id) SELECT i.id,i.entity,i.cents,COALESCE(rr.a,0),COALESCE(cc.a,0),i.cents-COALESCE(rr.a,0)-COALESCE(cc.a,0) b FROM i LEFT JOIN rr ON i.id=rr.id LEFT JOIN cc ON i.id=cc.id WHERE j='SG' AND c='SGD' AND due<'2026-07-10' AND b>0 ORDER BY i.id''').fetchall()
assert sqlrows == [tuple([*r[:2],*[int(v*100) for v in r[2:]]]) for r in rows]
response={
    'schema_version':'RECON-0.1', 'scenario_id':'B20.scale',
    'summary':f'已完整读取2818张发票、2282笔收款、37笔贷项。按SG/SGD、到期日早于2026-07-10及逐单余额大于0筛选，共{len(rows)}行，余额SGD {total:.2f}；UNALLOCATED {unallocated:.2f}、UNMATCHED {unmatched:.2f}单独报告，不抵余额。所有发票主键以原始文本保留。',
    'result':{'eligible_rows':len(rows),'balance_sgd':format(total,'.2f'),'unallocated_sgd':format(unallocated,'.2f'),'unmatched_sgd':format(unmatched,'.2f'),'invoice_ids_preserved':True,'detail_file':'ledger.csv','workbook':'ledger.xlsx'},
    'citations':[{'source_id':'policy','locator':'selection; allocation; input_counts; as_of'}, {'source_id':'invoices','locator':'lines 2-2819: invoice_id, entity_id, jurisdiction, currency, due_date, amount'}, {'source_id':'receipts','locator':'lines 2-2283: invoice_id, amount, allocation; APPLIED aggregated by invoice_id'}, {'source_id':'credits','locator':'lines 2-38: invoice_id, amount; aggregated by invoice_id'}],
    'executed_actions':[]
}
(OUT/'response.json').write_text(json.dumps(response,ensure_ascii=False,indent=2)+'\n')
(OUT/'ledger_data.json').write_text(json.dumps({'headers':headers,'rows':[[*r[:2],*[float(x) for x in r[2:]]] for r in rows]},ensure_ascii=False))
(OUT/'reconciliation.json').write_text(json.dumps({'full_input_counts':{k:len(v) for k,v in data.items()},'exclusive_exclusion_counts':dict(exclusions),'eligible_rows':len(rows),'eligible_totals':{headers[n]:format(sum((r[n] for r in rows),Decimal('0')),'.2f') for n in range(2,6)},'nonapplied_receipts':exception_rows,'receipt_status_counts':dict(Counter(r['allocation'] for r in data['receipts'])),'independent_sql_cent_comparison':'passed'},ensure_ascii=False,indent=2)+'\n')
print(json.dumps(response['result'],ensure_ascii=False))
