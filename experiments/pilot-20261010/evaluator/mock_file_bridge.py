"""Evaluator-only adapter: per-run file requests -> original localhost HTTP mock."""
import sys,json,pathlib,urllib.request,urllib.parse,datetime,time,signal
sys.path.insert(0,'/workspace/shared/counso-benchmark-reconstructed')
from counso_bench.mock import running_mock
run_id,state_dir,ipc_dir=sys.argv[1:];state_dir=pathlib.Path(state_dir);ipc=pathlib.Path(ipc_dir);state_dir.mkdir(parents=True,exist_ok=False)
for name in ['requests','responses']:(ipc/name).mkdir(parents=True,exist_ok=True)
stop=False
def stop_now(*_):
 global stop;stop=True
signal.signal(signal.SIGTERM,stop_now);signal.signal(signal.SIGINT,stop_now)
with running_mock('B01.discovery',state_dir/'observations.json',run_id=run_id) as (endpoint,state):
    metadata={'endpoint':endpoint,'run_id':run_id,'session_id':state.session_id,'execution_fingerprint':state.execution_fingerprint,'transport':'PER_RUN_FILE_IPC_TO_ORIGINAL_LOCALHOST_HTTP','bridge_ready_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (state_dir/'endpoint.json').write_text(json.dumps(metadata,indent=2));print(json.dumps({'ready':True,'run_id':run_id}),flush=True)
    handled=set()
    while not stop:
      for req_path in sorted((ipc/'requests').glob('*.json')):
        if req_path.name in handled:continue
        try:
          if req_path.is_symlink() or req_path.stat().st_size>2000:raise ValueError('Request not regular or too large')
          req=json.loads(req_path.read_text());op=req.get('operation');arg=req.get('argument')
          if set(req)!={'operation','argument'} or op not in {'search','read'} or not isinstance(arg,str) or len(arg)>200:raise ValueError('Expected operation search/read and string argument (max 200 characters)')
          path='/sources/search?q='+urllib.parse.quote(arg) if op=='search' else '/sources/doc/'+urllib.parse.quote(arg,safe='')
          with urllib.request.urlopen(endpoint+path,timeout=10) as r:payload=json.loads(r.read())
          response={'ok':True,'response':payload}
        except Exception as e:response={'ok':False,'error':type(e).__name__+': '+str(e)}
        target=ipc/'responses'/req_path.name;tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps(response,ensure_ascii=False));tmp.replace(target);handled.add(req_path.name)
        with (state_dir/'transport.jsonl').open('a') as f:f.write(json.dumps({'request_file':req_path.name,'request':req if 'req' in locals() else None,'response_ok':response.get('ok'),'at':datetime.datetime.now(datetime.timezone.utc).isoformat()},ensure_ascii=False)+'\n')
      time.sleep(.05)
