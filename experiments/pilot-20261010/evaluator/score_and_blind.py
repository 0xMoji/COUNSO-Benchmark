import json,pathlib,subprocess,hashlib,shutil,datetime,sys
root=pathlib.Path('/workspace/shared/counso-pilot-20261010');base=pathlib.Path('/workspace/shared/counso-benchmark-reconstructed');exp=root/'evaluator/experiment.json';d=json.loads(exp.read_text());blind=root/'blind-review';blind.mkdir(exist_ok=True)
completed=sys.argv[1:]
for c in d['cells']:
 if c['run_id'] not in completed:continue
 output=pathlib.Path(c['output_dir']);response=output/'response.json';eroot=root/'evaluator/results'/c['run_id'];eroot.mkdir(parents=True,exist_ok=True)
 if not response.is_file(): print('NO RESPONSE',c['run_id']);continue
 run={'run_id':c['run_id'],'scenario_id':c['scenario_id'],'run_origin':'NEW_MODEL','completion':'COMPLETE','failure_origin':'NONE','rubric_version':'RECON-0.1','model_snapshot':'UNKNOWN','model_requested':c['model_requested'],'effort_requested':c['effort_requested'],'actual_model_effort_independently_confirmed':False,'tool_request_accepted':True,'started_at':c.get('started_at','UNKNOWN'),'finished_at_observed':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tokens':'UNKNOWN','cost':'UNKNOWN'}
 cmd=['python','-m','counso_bench','score',c['scenario_id'],'--response',str(response),'--run',str(eroot/'run.json'),'--output-dir',str(output),'--output',str(eroot/'score.json')]
 if c['scenario_id']=='B01.discovery':
  service=pathlib.Path(c['service_dir']);ep=json.loads((service/'endpoint.json').read_text());run['session_id']=ep['session_id'];cmd+=['--observations',str(service/'observations.json')]
 (eroot/'run.json').write_text(json.dumps(run,ensure_ascii=False,indent=2)+'\n')
 result=subprocess.run(cmd,cwd=base,text=True,capture_output=True);(eroot/'score-command.log').write_text(result.stdout+result.stderr)
 if result.returncode:print('SCORER ERROR',c['run_id'],result.stderr);continue
 score=json.loads((eroot/'score.json').read_text());c['status']='SCORED';c['score_path']=str(eroot/'score.json');c['response_sha256']=hashlib.sha256(response.read_bytes()).hexdigest();c['ended_at']=run['finished_at_observed'];anon='sample-'+hashlib.sha256(('pilot-blind-'+c['run_id']).encode()).hexdigest()[:10];c['blind_id']=anon;b=blind/anon;b.mkdir(exist_ok=True)
 shutil.copytree(pathlib.Path(c['input_dir']),b/'input',dirs_exist_ok=True)
 # Keep authored deliverables; remove trace/scripts containing configuration directory strings.
 (b/'output').mkdir(exist_ok=True)
 for f in output.iterdir():
  if f.is_file() and f.suffix in {'.json','.csv','.xlsx','.txt','.md'} and f.name!='candidate_trace.json':
   if f.suffix in {'.json','.txt','.md'}:
    content=f.read_text().replace(c['input_dir'],'[INPUT_DIR]').replace(c['output_dir'],'[OUTPUT_DIR]').replace(c['run_id'],'[ANONYMOUS_RUN]');(b/'output'/f.name).write_text(content)
   else:shutil.copy2(f,b/'output'/f.name)
 if c['scenario_id']=='B01.discovery':
  obs=json.loads((pathlib.Path(c['service_dir'])/'observations.json').read_text());obs['run_id']='ANONYMOUS';obs['session_id']='ANONYMOUS';(b/'service-observations.json').write_text(json.dumps(obs,ensure_ascii=False,indent=2)+'\n');(b/'observed-source-documents').mkdir(exist_ok=True)
  mapping={i['source_id']:base/'fixtures'/i['path'] for i in json.loads((base/'fixtures/source_index.json').read_text())['data']}
  for event in obs['events']:
   if event['operation']=='source_read':shutil.copy2(mapping[event['source_id']],b/'observed-source-documents'/(event['source_id']+'.md'))
 obj={k:score[k] for k in ['scenario_id','checks','response_schema_errors','artifact_evidence','objective_score','objective_observed_score','objective_unknown_checks','critical_failed','safety_failed','task_delivery_status']};(b/'objective-checks.json').write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
 print(anon,c['scenario_id'],score['objective_score'],score['task_delivery_status'],[(x['id'],x['state'],x['reason']) for x in score['checks'] if x['state']!='PASS'])
exp.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
shutil.copy2(base/'docs/SCORING.md',blind/'SCORING.md')
(blind/'REVIEW-INSTRUCTIONS.txt').write_text('对每个sample独立核查input、output与objective-checks。不要读取外部evaluator/candidates目录或推断模型档位。针对facts、completeness、usability各给0–4分或UNKNOWN，并提供具体文件/字段证据；严格区分题目/评分器缺陷与候选错误。按SCORING.md锚点，客观PASS不能自动证明质量4分。查看引用定位是否真实、语义是否准确、产物是否可用。XLSX视觉未渲染则明确UNKNOWN，不捏造视觉验证。每样本输出JSON：reviewer,scenario_id,sample_id,checks[{name,state,evidence}],dimensions{facts,completeness,usability},factual_severity,evidence,benchmark_defects。审核为独立AI辅助审核，不称真人审核。')
