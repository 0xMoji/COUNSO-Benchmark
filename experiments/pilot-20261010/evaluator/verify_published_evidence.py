"""Read-only hashes for published bytes and original evidence, including lossless gzip storage."""
from pathlib import Path
import json,hashlib,gzip,sys
ROOT=Path(__file__).resolve().parents[1]
m=json.loads((ROOT/'PUBLICATION_MANIFEST.json').read_text());fail=[]
for f in m['files']:
 p=ROOT/f['path']
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=f['sha256']:fail.append(f['path'])
allowed={x['path'] for x in m['files']};withheld={x['path'] for x in m['withheld_original_hashes']}
compressed={x['original_path']:x for x in m.get('lossless_compression',[])}
original=0;decompressed=0
for name in ['evaluator/baseline-evidence-manifest.json','revisions/B17-contract-0.2/candidate-evidence-manifest.json']:
 for f in json.loads((ROOT/name).read_text())['files']:
  path=f['path']
  if path in allowed:
   original+=1
   if hashlib.sha256((ROOT/path).read_bytes()).hexdigest()!=f['sha256']:fail.append('original:'+path)
  elif path in compressed:
   original+=1;entry=compressed[path]
   try:data=gzip.decompress((ROOT/entry['gzip_path']).read_bytes())
   except (OSError,EOFError):fail.append('decompression:'+path);continue
   if len(data)!=entry['original_bytes'] or hashlib.sha256(data).hexdigest()!=f['sha256'] or f['sha256']!=entry['original_sha256']:fail.append('decompressed-original:'+path)
   else:decompressed+=1
  elif path not in withheld:fail.append('unaccounted:'+path)
print(json.dumps({'published_files_verified':len(m['files']),'original_evidence_files_verified':original,'originals_transparently_verified_from_gzip':decompressed,'original_entries_explicitly_withheld':len(withheld),'errors':fail},ensure_ascii=False,indent=2));sys.exit(bool(fail))
