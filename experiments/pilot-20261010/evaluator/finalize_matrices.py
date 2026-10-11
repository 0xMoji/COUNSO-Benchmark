"""Create portable 40-cell comparison exports from scored immutable evidence."""
from pathlib import Path
import json,csv,datetime,collections
ROOT=Path(__file__).resolve().parents[1]
def read(p):return json.loads(p.read_text())
def ref(p):return str(p.relative_to(ROOT))
def dump_csv(path,rows):
 with path.open('w',encoding='utf-8-sig',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
rows=[];checks=[]
exp=read(ROOT/'evaluator/experiment.json');vr=ROOT/'revisions/B17-contract-0.2';vexp=read(vr/'experiment.json')
for phase,cells in [('BASELINE',exp['cells']),('CONTRACT_CLARIFICATION',vexp['cells'])]:
 for c in cells:
  isbase=phase=='BASELINE';run=c['run_id'];original=ROOT/'evaluator/results'/run/'score.json' if isbase else None
  result=ROOT/'evaluator/regraded-v0.2.1'/run/'score.json' if isbase else vr/'results'/run/'score.json'
  s=read(result);raw=read(original) if original else {};review=ROOT/('blind-review' if isbase else 'blind-review-v2')/c['blind_id']/'review-A.json';dims=read(review)['dimensions'];output=ROOT/'candidates'/run/'output' if isbase else vr/'candidates'/run/'output'
  known_fail=[x['id'] for x in s['checks'] if x['state']=='FAIL'];unknown=[x['id'] for x in s['checks'] if x['state']=='UNKNOWN']
  elapsed=round((datetime.datetime.fromisoformat(c['ended_at'].replace('Z','+00:00'))-datetime.datetime.fromisoformat(c['started_at'].replace('Z','+00:00'))).total_seconds(),2)
  disposition='NO_DEMONSTRATED_CRITICAL_BUSINESS_FAILURE'
  if isbase and c['blind_id']=='sample-d208c3ba50':disposition='REAL_NONCRITICAL_CSV_RAGGED_RECORD'
  if isbase and c['blind_id']=='sample-5ccda82914':disposition='REAL_NONCRITICAL_MISLEADING_COLUMN_LABEL'
  if not isbase and c['blind_id']=='sample-47865c6bec':disposition='RESIDUAL_SELECTED_MAPPING_SCOPE_AMBIGUITY'
  if isbase and c['scenario_id']=='B20.scale':disposition='ALL_DATA_RECOMPUTED_CORRECT_OFFICE_VISUAL_UNKNOWN'
  r={'phase':phase,'run_id':run,'requested_model':c['model_requested'],'requested_effort':c['effort_requested'],'exact_backend_snapshot':'UNKNOWN','effort_independently_confirmed':'UNKNOWN','scenario_id':c['scenario_id'],'task_revision':'FROZEN-RECON-0.1' if isbase else 'B17-contract-0.2','raw_frozen_objective_score':raw.get('objective_score','NOT_APPLICABLE_NEW_TASK'),'regraded_old_full_objective_score':s['objective_score'] if isbase else 'NOT_APPLICABLE','new_task_full_objective_score':s['objective_score'] if not isbase else 'NOT_APPLICABLE','revised_known_weight_observed_score':s['objective_observed_score'],'revised_known_weight':s['objective_known_weight'],'revised_possible_weight':s['objective_possible_weight'],'revised_unknown_check_count':s['objective_unknown_checks'],'revised_unknown_ids':';'.join(unknown),'revised_known_failure_ids':';'.join(known_fail),'ai_blind_facts':dims.get('facts'),'ai_blind_completeness':dims.get('completeness'),'ai_blind_usability':dims.get('usability'),'ai_review_origin':'INDEPENDENT_AI_ASSISTED_NOT_HUMAN','true_human_quality':'UNKNOWN','evidence_disposition':disposition,'wall_seconds_observed_including_tools_queues':elapsed,'tokens':'UNKNOWN','cost':'UNKNOWN','blind_id':c['blind_id'],'response_path':ref(output/'response.json'),'original_score_path':ref(original) if original else '', 'revised_score_path':ref(result),'review_path':ref(review),'input_isolation':'INSTRUCTION_RESTRICTED_NOT_OS_VERIFIED'}
  rows.append({k:('UNKNOWN' if v is None else v) for k,v in r.items()})
  for check in s['checks']:checks.append({'phase':phase,'run_id':run,'scenario_id':c['scenario_id'],'check_id':check['id'],'state':check['state'],'weight':check['weight'],'critical':check['critical'],'reason':check['reason']})
assert len(rows)==40
out=ROOT/'report';dump_csv(out/'comparison_matrix.csv',rows);dump_csv(out/'revised_checks.csv',checks)
summary={'effective_candidate_runs':40,'baseline_runs':32,'contract_validation_runs':8,'excluded_infra_attempts':len(exp['excluded_attempts']),'total_candidate_attempts':40+len(exp['excluded_attempts']),'transport_controls_not_candidate_results':len(exp.get('transport_diagnostics',[])),'ai_reviews':40,'real_human_reviews':0,'baseline_raw_scores_immutable':True,'baseline_regraded_outputs':32,'baseline_regrade_new_candidate_runs':0,'new_task_scored_outputs':8,'definite_noncritical_baseline_artifact_issues':2,'demonstrated_critical_business_failures':0,'do_not_interpret_as_model_ranking':True,'phase_score_states':{phase:dict(collections.Counter('FULL_SCORE_KNOWN' if r['revised_unknown_check_count']==0 else 'CONTAINS_UNKNOWN' for r in rows if r['phase']==phase)) for phase in ['BASELINE','CONTRACT_CLARIFICATION']},'tokens':'UNKNOWN','cost':'UNKNOWN','snapshot':'UNKNOWN'}
(out/'final-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2))
