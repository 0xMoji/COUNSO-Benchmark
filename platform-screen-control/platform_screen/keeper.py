"""Long-lived evaluator exec session. Detached processes cannot be assumed live.

Run this foreground in a persistent exec_command session throughout the study.
It owns subprocesses in its PID namespace. Cross-exec termination uses file flags,
never PIDs from another namespace. This verified limitation is instrumented.
"""
import datetime,json,pathlib,signal,subprocess,sys,time
bundle=pathlib.Path(sys.argv[1]).resolve();root=pathlib.Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True);processes={};stop=False
def terminate(*_):
    global stop;stop=True
signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
(root/'keeper_ready.json').write_text(json.dumps({'ready':True,'semantics':'PERSISTENT_EXEC_SESSION_NOT_DETACHED_BACKGROUND','bundle':str(bundle)}))
print('Evaluator keeper ready',flush=True)
while not stop and not (root/'keeper_stop.flag').exists():
    heartbeat=root/'keeper_heartbeat.json';t=heartbeat.with_suffix('.tmp');t.write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}));t.replace(heartbeat)
    for path in sorted((root/'trials').glob('*/run.json')):
        trial=path.parent
        if trial.name in processes:continue
        try:r=json.loads(path.read_text())
        except (OSError,ValueError):continue
        if r.get('status')!='PREPARED':continue
        children=[]
        if r.get('service_required'):
            state=trial/'service';state.mkdir(exist_ok=True);log=(state/'service.log').open('w')
            args=[sys.executable,'-m','platform_screen.service',str(bundle/'dataset/cases'/r['case_id']),str(state),str(trial/'ipc'),r['run_id'],r['session_id'],r['execution_fingerprint']]
            children.append(subprocess.Popen(args,cwd=bundle,stdout=log,stderr=subprocess.STDOUT));log.close()
        children.append(subprocess.Popen([sys.executable,'-m','platform_screen.observer',str(trial/'output'),str(trial/'file_observations.json'),json.dumps(r['required_artifacts'])],cwd=bundle,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
        processes[trial.name]=children
        (trial/'keeper_started.json').write_text(json.dumps({'started':True,'service_required':r.get('service_required',False)}))
    for id,children in processes.items():
        for child in children:
            if child.poll() is not None and child.returncode and not (root/'trials'/id/'stop.flag').exists():(root/'trials'/id/'keeper_error.json').write_text(json.dumps({'error':'SUBPROCESS_EXIT','returncode':child.returncode}))
    time.sleep(.05)
for id,children in processes.items():
    (root/'trials'/id/'stop.flag').touch()
    for child in children:
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:child.terminate()
print('Evaluator keeper stopped',flush=True)
