"""Verify lossless compressed logs; optionally restore exact original bytes beside their gzip files."""
from pathlib import Path
import argparse,json,gzip,hashlib
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--restore',action='store_true',help='Write missing original files after verifying hashes; retain gzip files');args=p.parse_args()
def safe(name):
 result=(ROOT/name).resolve()
 if ROOT not in result.parents:raise ValueError('Path outside experiment')
 return result
records=json.loads((ROOT/'COMPRESSED_ARTIFACTS.json').read_text())['artifacts']
for r in records:
 compressed=safe(r['gzip_path']).read_bytes()
 if hashlib.sha256(compressed).hexdigest()!=r['gzip_sha256']:raise ValueError('Gzip hash mismatch')
 data=gzip.decompress(compressed)
 if len(data)!=r['original_bytes'] or hashlib.sha256(data).hexdigest()!=r['original_sha256']:raise ValueError('Original-byte hash mismatch')
 target=safe(r['original_path'])
 if args.restore:
  if target.exists():
   if target.read_bytes()!=data:raise ValueError('Refuse to overwrite different original file')
  else:target.write_bytes(data)
 print(json.dumps({'original_path':r['original_path'],'original_sha256':r['original_sha256'],'bytes_identical':True,'original_restored':args.restore},ensure_ascii=False))
