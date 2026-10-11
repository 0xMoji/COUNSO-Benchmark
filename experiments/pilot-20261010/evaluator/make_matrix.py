import json,csv,pathlib,datetime,collections
root=pathlib.Path(__file__).resolve().parents[1];exp=json.loads((root/'evaluator/experiment.json').read_text());dest=root/'report';dest.mkdir(exist_ok=True)
rows=[];checks=[]
for c in exp['cells']:
 s=json.loads((root/'evaluator/results'/c['run_id']/'score.json').read_text()) if c.get('score_path') else {}
 rp=root/'blind-review'/c.get('blind_id','NONE')/'review-A.json';review=json.loads(rp.read_text()) if rp.is_file() else {};dims=review.get('dimensions',{})
 started=c.get('started_at');ended=c.get('ended_at');elapsed=None
 if started and ended:
  elapsed=round((datetime.datetime.fromisoformat(ended.replace('Z','+00:00'))-datetime.datetime.fromisoformat(started.replace('Z','+00:00'))).total_seconds(),2)
 row={'run_id':c['run_id'],'requested_model':c['model_requested'],'requested_effort':c['effort_requested'],'actual_snapshot':'UNKNOWN','actual_effort_confirmed':'UNKNOWN','case_id':c['scenario_id'],'task_revision':'FROZEN-RECON-0.1','status':c['status'],'delivery':s.get('task_delivery_status','UNKNOWN'),'raw_objective_score':s.get('objective_score'),'raw_observed_objective_score':s.get('objective_observed_score'),'raw_unknown_checks':s.get('objective_unknown_checks'),'raw_critical_failed':s.get('critical_failed'),'ai_blind_facts':dims.get('facts'),'ai_blind_completeness':dims.get('completeness'),'ai_blind_usability':dims.get('usability'),'true_human_quality':'UNKNOWN','started_at_observed':started,'finished_at_scoring_observed':ended,'wall_seconds_upper_observed':elapsed,'tokens':'UNKNOWN','cost':'UNKNOWN','blind_id':c.get('blind_id'),'response_path':str(pathlib.Path(c['output_dir'])/'response.json'),'raw_score_path':c.get('score_path'),'ai_review_path':str(rp) if rp.is_file() else None,'input_isolation':'INSTRUCTION_ONLY_NOT_OS_VERIFIED'}
 rows.append(row)
 for check in s.get('checks',[]):checks.append({'run_id':c['run_id'],'case_id':c['scenario_id'],'check_id':check['id'],'category':check['category'],'weight':check['weight'],'state':check['state'],'critical':check['critical'],'reason':check['reason']})
for name,data in [('baseline_matrix.csv',rows),('baseline_checks.csv',checks)]:
 if data:
  with (dest/name).open('w',encoding='utf-8-sig',newline='') as f:w=csv.DictWriter(f,fieldnames=list(data[0]));w.writeheader();w.writerows(data)
summary={'phase':'BASELINE','planned_cells':len(rows),'scored_cells':sum(x['status']=='SCORED' for x in rows),'ai_reviewed':sum(bool(x['ai_review_path']) for x in rows),'by_model_scored':dict(collections.Counter(x['requested_model'] for x in rows if x['status']=='SCORED')),'excluded_infra_attempts':len(exp.get('excluded_attempts',[])),'true_human_reviews':0,'note':'Raw scorer results include confirmed contract/parser defects; not model rankings. AI reviews are not human scores. Wall time is not pure inference latency.','updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(dest/'progress.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False))
