"""Candidate transport client; original service operations are search/read only."""
import argparse,json,pathlib,time,uuid
p=argparse.ArgumentParser();p.add_argument('operation',choices=['search','read']);p.add_argument('argument');a=p.parse_args()
root=pathlib.Path(__file__).parent/'ipc';name=str(uuid.uuid4())+'.json';req=root/'requests'/name;tmp=req.with_suffix('.tmp');tmp.write_text(json.dumps({'operation':a.operation,'argument':a.argument},ensure_ascii=False));tmp.replace(req)
response=root/'responses'/name;deadline=time.monotonic()+20
while not response.exists():
 if time.monotonic()>deadline:raise SystemExit('INFRA_ERROR: controlled mock transport response timeout')
 time.sleep(.05)
r=json.loads(response.read_text())
if not r['ok']:raise SystemExit(r['error'])
print(json.dumps(r['response'],ensure_ascii=False,indent=2))
