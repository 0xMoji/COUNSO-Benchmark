import argparse,json,pathlib
from . import build as b
p=argparse.ArgumentParser();sub=p.add_subparsers(dest='action',required=True)
for name in ['build','freeze','verify','validate']:
 s=sub.add_parser(name);s.add_argument('path')
a=p.parse_args();func={'build':b.build,'freeze':b.freeze,'verify':b.verify,'validate':b.validate_dataset}[a.action]
print(json.dumps(func(pathlib.Path(a.path)),ensure_ascii=False,indent=2))
