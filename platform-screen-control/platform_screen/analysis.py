"""Fixed family macro-aggregation, paired comparisons and timing boundaries."""
import datetime,json,pathlib,random,statistics

FAMILY_ORDER=("information_evidence","data_files","tool_workflow_recovery","generative_ui")
GENERAL_FAMILIES=FAMILY_ORDER[:3]

def seconds(a,b):
    if not isinstance(a,str) or not isinstance(b,str) or 'UNKNOWN' in {a,b}:return None
    return (datetime.datetime.fromisoformat(b)-datetime.datetime.fromisoformat(a)).total_seconds()

def schedule(registry,configs,split,seed=20261011):
    cases=[e for e in registry['entries'] if e['split']==split];cases.sort(key=lambda x:x['case_id']);random.Random(seed).shuffle(cases);cells=[]
    for i,e in enumerate(cases):
        order=configs[i%len(configs):]+configs[:i%len(configs)]
        # Single-direction Latin rotation: each config occupies every position
        # once per complete cycle; incomplete cycles differ by at most one.
        for config in order:cells.append({'case_id':e['case_id'],'config':config,'family':e['family'],'split':split,'order_index':len(cells)})
    return cells

def summarize_runs(run_root,registry,configs,phase='MAIN'):
    entries=[e for e in registry['entries'] if e['split']=={'MAIN':'main','CALIBRATION':'calibration','HOLDOUT':'holdout'}[phase]];byid={e['case_id']:e for e in entries};rows={};timing=[]
    for p in pathlib.Path(run_root).glob('trials/*/run.json'):
        r=json.loads(p.read_text())
        if r['phase']!=phase or r['replicate']!=1:continue
        target=pathlib.Path(r.get('final_score_path',r.get('score_path','')))
        s=json.loads(target.read_text()) if target.is_file() else None
        if s and r.get('failure_origin') in {'PROTOCOL_CONTAMINATION','INFRA_AMBIGUOUS','UNKNOWN'}:
            # Origin comes from coordinator run.json, never a candidate self-report.
            # Keep diagnostic failures, but do not classify missing observations as model zeroes.
            s={**s,'quality_lower':0,'quality_upper':0 if s.get('safety_failures') else 100,'quality_complete':None,'evidence_coverage':0,'all_required_check_coverage':0,'task_delivery_complete':None}
        k=(r['config'],r['case_id'])
        if k in rows:raise ValueError('Duplicate first-run cell; do not silently select a preferred result')
        rows[k]=(r,s)
        obs=p.parent/'service/observations_received.json';events=json.loads(obs.read_text())['events'] if obs.exists() else []
        intervals=sorted((e['service_start_at'],e['service_end_at']) for e in events);union=0;end=None
        for a,b in intervals:
            if end is None or a>end:union+=seconds(a,b);end=b
            elif b>end:union+=seconds(end,b);end=b
        timing.append({'run_id':r['run_id'],'config':r['config'],'case_id':r['case_id'],'submitted_to_receipt_seconds':seconds(r.get('submitted_at'),r.get('artifact_received_at')),'submitted_to_objective_validation_seconds':seconds(r.get('submitted_at'),r.get('validation_end_at')),'submitted_to_first_file_appearance_seconds':seconds(r.get('submitted_at'),r.get('first_required_files_observed_at')),'file_appearance_is_validated_delivery':False,'mock_service_interval_union_seconds':union,'mock_service_cumulative_seconds':sum(e['service_duration_ns'] for e in events)/1e9,'unobserved_shell_tools':'UNKNOWN','provider_inference_seconds':'UNKNOWN','tokens':'UNKNOWN','cost':'UNKNOWN','backend_snapshot':'UNKNOWN','actual_provider_effort':'UNKNOWN','ci_browser_evaluation_seconds':seconds(r.get('ui_validation_started_at'),r.get('ui_validation_ended_at')),'ci_browser_time_in_candidate_speed':False})
    observed_families={e['family'] for e in entries}
    if phase=='MAIN' and observed_families!=set(FAMILY_ORDER):raise ValueError('MAIN must retain all four preregistered families')
    families=[f for f in FAMILY_ORDER if f in observed_families];overall={};task_scores={};task_profiles={}
    for config in configs:
        family_scores={};critical=[];safety=[];critical_unknown=[];missing=[];complete=True
        for family in families:
            tasks=[e for e in entries if e['family']==family];values=[]
            for e in tasks:
                cell=rows.get((config,e['case_id']));s=cell[1] if cell else None
                if s:
                    v={'lower':s['quality_lower'],'upper':s['quality_upper'],'coverage':s['evidence_coverage'],'all_check_coverage':s.get('all_required_check_coverage',s['evidence_coverage']),'complete':s['quality_complete']};critical += [e['case_id']+':'+x for x in s['critical_failures']];safety += [e['case_id']+':'+x for x in s['safety_failures']];critical_unknown += [e['case_id']+':'+x for x in s.get('unresolved_critical_checks',[])]
                else:v={'lower':0,'upper':100,'coverage':0,'all_check_coverage':0,'complete':None};missing.append(e['case_id'])
                task_scores[(config,e['case_id'])]=v;values.append(v)
                check_diagnostics=[{k:c[k] for k in ('id','state','weight','reason','failure_class','difficulty','critical_pending') if k in c} for c in (s or {}).get('checks',[])]
                layers={}
                if family=='generative_ui':
                    for difficulty,budget in [('easy',25),('medium',35),('hard',40)]:
                        cs=[c for c in (s or {}).get('checks',[]) if c.get('difficulty')==difficulty]
                        passed=sum(c['weight'] for c in cs if c['state']=='PASS')
                        unknown=sum(c['weight'] for c in cs if c['state']=='UNKNOWN') if cs else budget
                        layers[difficulty]={'fixed_budget':budget,'lower_points':passed,'upper_points':passed+unknown,'unknown_points':unknown,'before_task_critical_and_safety_gate':True}
                task_profiles[(config,e['case_id'])]={'quality':v,'family':family,'run_id':cell[0]['run_id'] if cell else None,'delivery_complete':s.get('task_delivery_complete') if s else None,'failure_origin':cell[0].get('failure_origin') if cell else 'MISSING_CELL','checks':check_diagnostics,'ui_difficulty':layers}

                if v['complete'] is None:complete=False
            family_scores[family]={k:statistics.mean(v[k] for v in values) for k in ['lower','upper','coverage','all_check_coverage']}
        contaminated=[{'case_id':case_id,'run_id':r['run_id'],'origin':r['failure_origin']} for (cfg,case_id),(r,s) in rows.items() if cfg==config and r.get('failure_origin')=='PROTOCOL_CONTAMINATION']
        def profile(selected):
            if not all(f in family_scores for f in selected):return {'quality_lower':None,'quality_upper':None,'quality_complete':None,'coverage':None,'status':'NOT_ALL_PREREGISTERED_FAMILIES_PRESENT'}
            cells=[task_scores[(config,e['case_id'])] for e in entries if e['family'] in selected]
            return {'quality_lower':statistics.mean(family_scores[f]['lower'] for f in selected),'quality_upper':statistics.mean(family_scores[f]['upper'] for f in selected),'quality_complete':statistics.mean(family_scores[f]['lower'] for f in selected) if all(v['complete'] is not None for v in cells) else None,'coverage':statistics.mean(family_scores[f]['coverage'] for f in selected),'family_weights':{f:1/len(selected) for f in selected}}
        overall[config]={'family_scores':family_scores,'general_foundation':profile(GENERAL_FAMILIES),'generative_ui':profile(('generative_ui',)),'quality_lower':statistics.mean(v['lower'] for v in family_scores.values()),'quality_upper':statistics.mean(v['upper'] for v in family_scores.values()),'quality_complete':statistics.mean(v['lower'] for v in family_scores.values()) if complete else None,'weighted_evidence_coverage':statistics.mean(v['coverage'] for v in family_scores.values()),'all_required_check_coverage':statistics.mean(v['all_check_coverage'] for v in family_scores.values()),'unresolved_critical_checks':critical_unknown,'critical_failures':critical,'safety_failures':safety,'missing_cells':missing,'execution_contaminated_cells':contaminated}
    pairs=[]
    for i,a in enumerate(configs):
        for b in configs[i+1:]:
            wins=losses=ties=unknown=0;diffs={}
            for e in entries:
                x=task_scores[(a,e['case_id'])];y=task_scores[(b,e['case_id'])]
                if x['complete'] is None or y['complete'] is None:unknown+=1
                elif x['complete']>y['complete']:wins+=1
                elif x['complete']<y['complete']:losses+=1
                else:ties+=1
                if x['complete'] is not None and y['complete'] is not None:diffs.setdefault(e['family'],[]).append(x['complete']-y['complete'])
            pairs.append({'a':a,'b':b,'paired_task_wins':wins,'ties':ties,'losses':losses,'unknown_pairs':unknown,'overall_delta_interval':[overall[a]['quality_lower']-overall[b]['quality_upper'],overall[a]['quality_upper']-overall[b]['quality_lower']],'exact_family_deltas':{f:statistics.mean(v) for f,v in diffs.items()},'inference':'DESCRIPTIVE_FIXED_SIX_TASK_SINGLE_OBSERVATION_NOT_STABLE_OR_POPULATION_SUPERIORITY'})
    return {'phase':phase,'overall':overall,'paired':pairs,'timing':timing,'primary_condition':'ALL_EIGHT_REQUESTED_MODEL_EFFORT_CONFIGURATIONS','cost_in_quality_ranking':False,'speed_in_quality_ranking':False,'unknown_is_not_equivalence':True,'same_task_repeatability':'UNKNOWN_INITIAL_SINGLE_RUNS','measurement_title':'Counso平台相关办公能力筛查','family_weights':{f:1/len(families) for f in families},'task_profiles':{cfg:{e['case_id']:task_profiles[(cfg,e['case_id'])] for e in entries} for cfg in configs},'calibration_is_primary_comparison':False,'population_interval':'NOT_ESTIMATED_FIXED_SMALL_NONRANDOM_TASK_SCREEN'}
