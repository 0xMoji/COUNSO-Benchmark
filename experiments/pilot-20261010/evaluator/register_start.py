import json,pathlib,sys
p=pathlib.Path('/workspace/shared/counso-pilot-20261010/evaluator/experiment.json');d=json.loads(p.read_text())
for arg in sys.argv[1:]:
 config,case,agent,at=arg.split('|')
 c=next(c for c in d['cells'] if c['config']==config and c['scenario_id']==case);c.update(agent_task='/root/pilot_model_discrimination/'+agent,started_at=at,tool_acceptance_confirmed=True,actual_snapshot='UNKNOWN',actual_model_effort_independently_confirmed=False)
 if c['status']=='PENDING':c['status']='RUNNING'
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
