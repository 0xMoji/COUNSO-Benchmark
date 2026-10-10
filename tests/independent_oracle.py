from pathlib import Path
from collections import defaultdict, Counter
from decimal import Decimal
import csv,json,hashlib,sys

root=Path(sys.argv[1])
def rows(p):
 with (root/p).open(newline='',encoding='utf-8') as f:return list(csv.DictReader(f))
def money(x):return format(x.quantize(Decimal('.01')),'f')
report={'input_snapshot_manifest_sha256':hashlib.sha256((root/('SNAPSHOT.sha256' if (root/'SNAPSHOT.sha256').exists() else 'provenance/file_manifest.json')).read_bytes()).hexdigest(),'ledgers':{},'valuation':{},'other':{}}
for tier in ['small','scale']:
 prefix=f'fixtures/ledger-{tier}'
 inv=rows(prefix+'/invoices.csv');rec=rows(prefix+'/receipts.csv');cr=rows(prefix+'/credits.csv')
 ids=[x['invoice_id'] for x in inv]
 assert len(set(ids))==len(ids),'Duplicate invoice IDs'
 app=defaultdict(lambda:Decimal(0));credit=defaultdict(lambda:Decimal(0));unalloc=Decimal(0);unmatched=Decimal(0)
 for x in rec:
  if x['allocation']=='APPLIED':
   assert x['invoice_id'] in set(ids),'Applied receipt unknown ID'
   app[x['invoice_id']]+=Decimal(x['amount'])
  elif x['allocation']=='UNALLOCATED':unalloc+=Decimal(x['amount'])
  elif x['allocation']=='UNMATCHED':unmatched+=Decimal(x['amount'])
  else:raise AssertionError(x)
 for x in cr:
  assert x['invoice_id'] in set(ids)
  credit[x['invoice_id']]+=Decimal(x['amount'])
 actual={};total=Decimal(0)
 for x in inv:
  key=x['invoice_id'];bal=Decimal(x['amount'])-app[key]-credit[key]
  if x['jurisdiction']=='SG' and x['currency']=='SGD' and x['due_date']<'2026-07-10' and bal>0:
   actual[key]={'invoice_id':key,'entity_id':x['entity_id'],'amount':money(Decimal(x['amount'])),'applied_receipts':money(app[key]),'credits':money(credit[key]),'balance':money(bal)}
   total+=bal
 expected={x['invoice_id']:x for x in rows(f'gold/ledger-{tier}_expected.csv')}
 assert actual==expected,'All-row independently recalculated gold mismatch'
 report['ledgers'][tier]={'inputs':[len(inv),len(rec),len(cr)],'eligible':len(actual),'balance':money(total),'unallocated':money(unalloc),'unmatched':money(unmatched),'all_gold_rows_equal':True,'leading_zero_ids':sum(k.startswith('0') for k in actual),'receipt_allocations':dict(Counter(x['allocation'] for x in rec)),'maximum_applied_receipts_per_invoice':max(Counter(x['invoice_id'] for x in rec if x['allocation']=='APPLIED').values()),'first_500_eligible':sum(x['invoice_id'] in actual for x in inv[:500]),'all_zero_or_negative_balances':sum(Decimal(x['amount'])-app[x['invoice_id']]-credit[x['invoice_id']]<=0 for x in inv)}
pol=json.load(open(root/'fixtures/valuation_policy.json'))['data']
hold=rows('fixtures/holdings.csv');quotes=rows('fixtures/quotes.csv');gold=rows('gold/valuation_expected.csv')
quote={x['position_id']:x for x in quotes};actual=[];total=Decimal(0);unknown=[]
for h in hold:
 pid=h['position_id'];q=quote.get(pid)
 out={'position_id':pid,'value_sgd':'','status':'UNKNOWN','original_currency':'','original_value':''}
 validhold=h['period']==pol['holding_period'] and h['status']==pol['allowed_holding_status']
 validquote=q and q['date']==pol['as_of'] and q['state']==pol['allowed_quote_state']
 if validhold and validquote:
  local=Decimal(h['units'])*Decimal(q['price']);fx=pol['fx_domains'][h['fx_domain']]
  if h['currency']=='SGD':sgd=local
  elif fx['date']!=pol['as_of']:
   sgd=None;out.update(original_currency=h['currency'],original_value=money(local))
  elif h['currency']=='USD':sgd=local/Decimal(fx['USD_per_SGD'])
  elif h['currency']=='EUR':sgd=local*Decimal(fx['SGD_per_EUR'])
  else:sgd=None
  if sgd is not None:out.update(status='CONFIRMED',value_sgd=money(sgd));total+=sgd
 if out['status']=='UNKNOWN':unknown.append(pid)
 actual.append(out)
assert actual==gold,'Independent valuation gold mismatch'
report['valuation']={'confirmed_subtotal':money(total),'unknown':unknown,'all_gold_rows_equal':True,'line_count':len(actual),'confirmed_lines':[x for x in actual if x['status']=='CONFIRMED'],'original_currency_known':[x for x in actual if x['original_currency']]}
sales=rows('fixtures/sales.csv');monthly=defaultdict(lambda:Decimal(0))
for x in sales:
 if x['Type']=='SALE':monthly[x['Month']]+=Decimal(x['Amount'])
report['other']['sales']={k:money(v) for k,v in monthly.items()}

if (root/'fixtures/holdings-versions.csv').exists():
 hrows=rows('fixtures/holdings-versions.csv');qrows=rows('fixtures/quotes-versions.csv')
 hmap={};qmap={};unknown=[];subtotal=Decimal(0);middle={};missing={}
 for pid in sorted(set(h['position_id'] for h in hrows)):
  hs=[h for h in hrows if h['position_id']==pid and h['status']=='APPROVED' and h['period']==pol['holding_period']]
  if not hs:unknown.append(pid);missing[pid]=['APPROVED_OCTOBER_HOLDING'];continue
  h=max(hs,key=lambda x:x['version_date'])
  qs=[q for q in qrows if q['position_id']==pid and q['state']=='FINAL' and q['date']==pol['as_of']]
  if not qs:unknown.append(pid);missing[pid]=['FINAL_AS_OF_QUOTE'];continue
  q=max(qs,key=lambda x:x['published_at'])
  value=Decimal(h['units'])*Decimal(q['price']);domain=pol['fx_domains'][h['fx_domain']]
  if h['currency']!='SGD' and domain['date']!=pol['as_of']:
   unknown.append(pid);middle[pid]={'currency':h['currency'],'value':money(value)};missing[pid]=['AS_OF_AUTHORIZED_FX'];continue
  if h['currency']=='USD':value/=Decimal(domain['USD_per_SGD'])
  elif h['currency']=='EUR':value*=Decimal(domain['SGD_per_EUR'])
  subtotal+=value;hmap[pid]=h['holding_row_id'];qmap[pid]=q['quote_row_id']
 reference=json.load(open(root/'gold/contracts.json'))['scenarios']['B17.reconcile']['reference_response']['result']
 assert reference['selected_holding_rows']==hmap
 assert reference['selected_quote_rows']==qmap
 assert reference['missing_evidence']==missing
 assert set(reference['unknown_positions'])==set(unknown)
 assert reference['confirmed_subtotal_sgd']==money(subtotal)
 report['valuation_versions']={'holding_rows':len(hrows),'quote_rows':len(qrows),'subtotal':money(subtotal),'unknown':unknown,'intermediate':middle,'selected_holding_rows':hmap,'selected_quote_rows':qmap,'missing_evidence':missing,'all_reference_fields_independently_equal':True}

report['review_origin']='INDEPENDENT_DECIMAL_ORACLE_NO_GENERATOR_IMPORT'
print(json.dumps(report,ensure_ascii=False,indent=2))
