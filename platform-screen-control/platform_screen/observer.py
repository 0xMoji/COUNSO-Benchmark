"""Evaluator clocks for file appearances. Appearance is not verified delivery."""
import datetime,hashlib,json,pathlib,signal,sys,time
out=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]);required=json.loads(sys.argv[3]);stop=False
def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def terminate(*_):
    global stop;stop=True
signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
data={'clock_scope':'EVALUATOR_FILE_OBSERVER','poll_interval_seconds':0.1,'observer_started_at':utc(),'first_parseable_response_observed_at':None,'first_required_files_observed_at':None,'response_versions':[]};last=None
while not stop and not (target.parent/'stop.flag').exists():
    p=out/'response.json'
    if p.is_file():
        try:
            raw=p.read_bytes();json.loads(raw);h=hashlib.sha256(raw).hexdigest()
            if h!=last:
                at=utc();data['response_versions'].append({'observed_at':at,'sha256':h});data['first_parseable_response_observed_at']=data['first_parseable_response_observed_at'] or at;last=h
        except (ValueError,OSError):pass
    if not data['first_required_files_observed_at'] and all((out/f).is_file() for f in ['response.json']+required):data['first_required_files_observed_at']=utc()
    temp=target.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2)+'\n');temp.replace(target);time.sleep(.1)
data['observer_stopped_at']=utc();target.write_text(json.dumps(data,indent=2)+'\n')
