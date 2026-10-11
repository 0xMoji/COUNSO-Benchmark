import pathlib,json,hashlib,shutil,datetime,sys
r=pathlib.Path('/workspace/shared/counso-pilot-20261010');v=r/'revisions/B17-contract-0.2';p=v/'experiment.json';d=json.loads(p.read_text());op=sys.argv[1]
if op=='start':
 for arg in sys.argv[2:]:
  config,agent,at=arg.split('|');c=next(x for x in d['cells'] if x['config']==config);c.update(status='RUNNING',started_at=at,agent_task='/root/pilot_model_discrimination/'+agent,tool_request_accepted=True,actual_model_effort_independently_confirmed=False,exact_snapshot='UNKNOWN',tokens='UNKNOWN',cost='UNKNOWN')
elif op=='complete':
 b=r/'blind-review-v2';b.mkdir(exist_ok=True);shutil.copy2(r/'blind-review/SCORING.md',b/'SCORING.md');(b/'REVIEW-INSTRUCTIONS.txt').write_text('本组是独立新会话完成的B17-contract-0.2契约澄清验证，不与原题混汇。业务输入未变，公开prompt第1至5条与schema为本组唯一契约。请独立核对每项事实、CSV显式列/未知空白和标量EUR目标，按SCORING.md写review-A.json，维度事实/完整性/可用性0–4或UNKNOWN，保留具体证据。没有真人审核；不要读候选身份/配置、外部evaluator或原始candidates目录。评分器尚在完成独立修订时objective-checks标PENDING，不影响独立内容审核。')
 for config in sys.argv[2:]:
  c=next(x for x in d['cells'] if x['config']==config);o=pathlib.Path(c['output_dir']);assert (o/'response.json').is_file();c['status']='COMPLETE_PENDING_SCORER';c['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();c['response_sha256']=hashlib.sha256((o/'response.json').read_bytes()).hexdigest();anon='sample-'+hashlib.sha256(('pilot-v2-blind-'+c['run_id']).encode()).hexdigest()[:10];c['blind_id']=anon;s=b/anon;s.mkdir(exist_ok=True);shutil.copytree(c['input_dir'],s/'input',dirs_exist_ok=True);(s/'output').mkdir(exist_ok=True)
  for f in o.iterdir():
   if f.is_file() and f.suffix in {'.json','.csv','.xlsx','.txt','.md'} and f.name!='candidate_trace.json':
    if f.suffix in {'.json','.txt','.md'}:(s/'output'/f.name).write_text(f.read_text().replace(c['input_dir'],'[INPUT_DIR]').replace(c['output_dir'],'[OUTPUT_DIR]').replace(c['run_id'],'[ANONYMOUS_RUN]'))
    else:shutil.copy2(f,s/'output'/f.name)
  (s/'objective-checks.json').write_text(json.dumps({'task_revision':'B17-contract-0.2','scenario_id':'B17.reconcile','status':'PENDING_NEW_GRADER','checks':[]},ensure_ascii=False,indent=2)+'\n');print(anon)
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
