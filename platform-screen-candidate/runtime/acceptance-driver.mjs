/** Evaluator-side Playwright driver. Never imported into a candidate bundle.
 * It executes real locator events; evaluate is restricted to read-only Frame
 * DOM capture or the already declared outer mockhost observer/control API.
 * No browser is launched by importing or syntax-checking this module.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECEIPT_ORIGIN = 'TRUSTED_BROWSER_OBSERVER';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[0-9a-f]{64}$/;
const cssString = value => JSON.stringify(String(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const usedContexts = new WeakSet();
export function canonicalSha256(value) { const normalize=v=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v; return sha(JSON.stringify(normalize(value))); }

export function hookSelector(hook, key = undefined) {
  if (!/^[a-z][a-z0-9-]*$/.test(hook)) throw new Error('Only published semantic hook names are allowed');
  return `[data-eval=${cssString(hook)}]${key === undefined ? '' : `[data-eval-key=${cssString(key)}]`}`;
}

export function dashboardOracle(source, scope) {
  const statuses = new Set(scope.statuses);
  const teams = new Set(scope.team_ids);
  const from = Date.parse(`${scope.created_from}T00:00:00Z`);
  const to = Date.parse(`${scope.created_to}T00:00:00Z`);
  const rows = source.tickets.filter(t => (!teams.size || teams.has(t.team_id)) && statuses.has(t.status) && Date.parse(t.created_at) >= from && Date.parse(t.created_at) < to);
  const active = rows.filter(t => ['OPEN','IN_PROGRESS','WAITING'].includes(t.status));
  return {scope:structuredClone(scope),snapshot_revision:source.snapshot_revision,rows:structuredClone(rows),
    metrics:{ticket_count:rows.length,active_count:active.length,overdue_active_count:active.filter(t=>Date.parse(t.due_at)<Date.parse(source.as_of)).length,remaining_effort_hours:active.reduce((sum,t)=>sum+t.remaining_minutes,0)/60},
    chart:Object.fromEntries(['OPEN','IN_PROGRESS','WAITING'].map(status=>[status,active.filter(t=>t.status===status).length]))};
}

export function plannerOracle(source, allocations) {
  const resources = new Map(source.resources.map(r=>[r.resource_id,r]));
  const work = new Map(source.work_items.map(w=>[w.work_item_id,w]));
  const roster = new Map(source.roster.map(r=>[`${r.resource_id}|${r.date}`,r]));
  const resourceLoad = new Map(); const workLoad = new Map(); const issues=[];
  for (const a of allocations) {
    const r=resources.get(a.resource_id), w=work.get(a.work_item_id), day=roster.get(`${a.resource_id}|${a.date}`);
    if (!Number.isFinite(a.minutes) || !Number.isInteger(a.minutes) || a.minutes<=0 || a.minutes%15) issues.push({kind:'quantity',allocation_id:a.allocation_id});
    if (!r || !w || !day) issues.push({kind:'identity',allocation_id:a.allocation_id});
    if (r&&w&&(r.team_id!==w.team_id || !r.skills.includes(w.required_skill))) issues.push({kind:'eligibility',allocation_id:a.allocation_id});
    if(w&&(a.date<w.earliest_date||a.date>w.due_date)) issues.push({kind:'date',allocation_id:a.allocation_id});
    const k=`${a.resource_id}|${a.date}`;
    resourceLoad.set(k,(resourceLoad.get(k)||0)+a.minutes);workLoad.set(a.work_item_id,(workLoad.get(a.work_item_id)||0)+a.minutes);
  }
  for(const [k,minutes] of resourceLoad){const day=roster.get(k);if(day&&minutes>day.available_minutes-day.committed_minutes)issues.push({kind:'capacity',key:k,expected_max:day.available_minutes-day.committed_minutes,observed:minutes})}
  for(const [k,minutes] of workLoad){const item=work.get(k);if(item&&minutes>item.remaining_minutes)issues.push({kind:'demand',key:k,expected_max:item.remaining_minutes,observed:minutes})}
  return {valid:issues.length===0,issues,resource_load:Object.fromEntries(resourceLoad),work_load:Object.fromEntries(workLoad),
    committed:source.roster.map(r=>({...r,residual_minutes:r.available_minutes-r.committed_minutes})),
    remaining_work:Object.fromEntries(source.work_items.map(w=>[w.work_item_id,w.remaining_minutes-(workLoad.get(w.work_item_id)||0)]))};
}

export function defaultDashboardScope(source) {
  return {team_ids:[],statuses:['OPEN','IN_PROGRESS','WAITING','CLOSED'],created_from:source.default_created_from,created_to:source.default_created_to};
}

export function validAllocationProbe(source, draft) {
  const existing=draft.allocations||[];
  for(const w of source.work_items)for(const r of source.resources)for(const day of source.roster){
    if(day.resource_id!==r.resource_id)continue;
    const probe={allocation_id:'driver-local-probe',work_item_id:w.work_item_id,resource_id:r.resource_id,date:day.date,minutes:15};
    if(plannerOracle(source,[...existing,probe]).valid)return probe;
  }
  throw new Error('Preregistered fixture must support a valid 15-minute allocation');
}

export function validationProbes(source,draft) {
  const base=draft.allocations||[],valid=validAllocationProbe(source,draft),probes=[{kind:'invalid_quantity',allocation:{...valid,minutes:14}},{kind:'zero_quantity',allocation:{...valid,minutes:0}},{kind:'fractional_quantity',allocation:{...valid,minutes:15.5}}];
  const eligible=[];
  for(const w of source.work_items)for(const r of source.resources)for(const day of source.roster){
    if(day.resource_id!==r.resource_id)continue;
    const a={allocation_id:'driver-probe',work_item_id:w.work_item_id,resource_id:r.resource_id,date:day.date,minutes:15};
    if(!probes.some(p=>p.kind==='wrong_team')&&r.team_id!==w.team_id)probes.push({kind:'wrong_team',allocation:a});
    if(!probes.some(p=>p.kind==='wrong_skill')&&r.team_id===w.team_id&&!r.skills.includes(w.required_skill))probes.push({kind:'wrong_skill',allocation:a});
    if(!probes.some(p=>p.kind==='invalid_date')&&r.team_id===w.team_id&&r.skills.includes(w.required_skill)&&(day.date<w.earliest_date||day.date>w.due_date))probes.push({kind:'invalid_date',allocation:a});
    const cap=day.available_minutes-day.committed_minutes;
    if(r.team_id===w.team_id&&r.skills.includes(w.required_skill)&&day.date>=w.earliest_date&&day.date<=w.due_date){
      const overflow={...a,minutes:(Math.floor(cap/15)+1)*15};
      if(!probes.some(p=>p.kind==='capacity_overflow')&&plannerOracle(source,[...base,overflow]).issues.every(i=>i.kind==='capacity'))probes.push({kind:'capacity_overflow',allocation:overflow});
      for(let minutes=15;minutes<=Math.min(cap,w.remaining_minutes);minutes+=15){const candidate={...a,allocation_id:`driver-candidate-${eligible.length}`,minutes};if(plannerOracle(source,[...base,candidate]).valid)eligible.push(candidate)}
    }
  }
  let capacityPair,demandPair;
  for(let i=0;i<eligible.length&&(!capacityPair||!demandPair);i++)for(let j=i;j<eligible.length&&(!capacityPair||!demandPair);j++){
    const pair=[{...eligible[i],allocation_id:'driver-first'},{...eligible[j],allocation_id:'driver-second'}];const kinds=plannerOracle(source,[...base,...pair]).issues.map(i=>i.kind);
    if(!capacityPair&&kinds.length&&kinds.every(k=>k==='capacity'))capacityPair=pair;
    if(!demandPair&&kinds.length&&kinds.every(k=>k==='demand'))demandPair=pair;
  }
  return {probes,capacityPair,demandPair};
}

function action(kind,hook,extra={}) {return {kind,hook,...extra}}
function setPlan(a){return [action('select','plan-work-item',{value:a.work_item_id}),action('select','plan-resource',{value:a.resource_id}),action('select','plan-date',{value:a.date}),action('fill','plan-minutes',{value:String(a.minutes)})]}

/** Deterministic source-derived action plans. No candidate DOM guessing or
 * hidden business answer names. Host scheduling remains evaluator-private.
 */
export function buildTestPlan(kind, source, draft=null, fixtureId='primary') {
  const prefix=kind==='dashboard'?'D':'P';
  const test=(suffix,atomIds,steps,oracleKind,requirements=[],scheduleId='ordinary')=>({test_id:`${prefix}-${fixtureId}-${suffix}`,fixture_id:fixtureId,atom_ids:atomIds,steps,oracle_kind:oracleKind,requirements,schedule_id:scheduleId});
  if(kind==='dashboard'){
    const team=source.teams[0].team_id;
    const pickTeam=action('select','team-filter',{value:team});
    return [
      test('baseline',['D-E1','D-E2'],[{kind:'observe',checkpoint:'baseline'}],'dashboard_scope',['host_ledger']),
      test('keyboard',['D-E3'],[action('focus','team-filter'),{kind:'press_active',key:'Tab'},{kind:'press_active',key:'Shift+Tab'},action('focus','status-bar',{source_key:'OPEN'}),action('press','status-bar',{source_key:'OPEN',key:'Enter'}),{kind:'observe',checkpoint:'keyboard_selection'},action('click','reset-filters')],'dashboard_keyboard'),
      test('linked_scope',['D-M1'],[pickTeam,action('click','status-bar',{source_key:'OPEN'}),action('fill','created-from',{value:source.default_created_from}),action('fill','created-to',{value:source.default_created_to}),{kind:'observe',checkpoint:'linked_scope'}],'dashboard_scope',['host_ledger']),
      test('reset',['D-M2'],[pickTeam,action('click','reset-filters'),{kind:'observe',checkpoint:'reset'}, {kind:'host_control',control:{op:'replaceFiles',fixture_role:'updated_same_schema'}},action('click','refresh-data'),action('click','reset-filters'),{kind:'observe',checkpoint:'reset_after_refresh'}],'dashboard_reset',['host_ledger']),
      test('empty',['D-M3'],['OPEN','IN_PROGRESS','WAITING','CLOSED'].map(s=>action('clear_status','status-option',{source_key:s})).concat([{kind:'observe',checkpoint:'empty'},action('click','reset-filters')]),'dashboard_empty',['host_ledger']),
      test('late_result',['D-H1'],[{kind:'host_control',control:{op:'setFault',command:'callFunction',effect:'hold',phase:'before_process',count:1}},pickTeam,{kind:'host_wait_pending'},action('select','team-filter',{value:''}),{kind:'observe',checkpoint:'newer_result'},{kind:'host_release_pending'},{kind:'observe',checkpoint:'after_older_result'}],'dashboard_latest_intent',['host_ledger'],'dashboard_late_result'),
      test('late_error',['D-H1'],[{kind:'host_control',control:{op:'setFault',command:'callFunction',effect:'hold',phase:'before_process',count:1}},pickTeam,{kind:'host_wait_pending'},action('select','team-filter',{value:''}),{kind:'observe',checkpoint:'newer_result'},{kind:'host_release_pending',outcome:'function_fail'},{kind:'observe',checkpoint:'after_older_error'}],'dashboard_latest_intent',['host_ledger'],'dashboard_late_error'),
      test('retry',['D-H2','D-H3'],[{kind:'host_control',control:{op:'setFault',command:'callFunction',effect:'function_fail',phase:'before_process',count:1}},pickTeam,{kind:'observe',checkpoint:'failed_intent'},action('click','retry-load'),{kind:'observe',checkpoint:'retried_intent'}],'dashboard_retry',['host_ledger'],'dashboard_retryable_failure'),
      test('retention',['D-H3'],[pickTeam,action('click','refresh-data'),{kind:'observe',checkpoint:'retained_selection'}],'dashboard_retention',['host_ledger']),
      ...(fixtureId==='unseen_same_schema'?[test('generalization',['D-H4'],[pickTeam,action('click','status-bar',{source_key:'WAITING'}),action('click','reset-filters'),{kind:'observe',checkpoint:'unseen_reset'}],'dashboard_generalization',['host_ledger'])]:[])
    ];
  }
  if(kind!=='planner'||!draft)throw new Error('Planner requires source and actual initial draft');
  const valid=validAllocationProbe(source,draft);const validation=validationProbes(source,draft);
  const addValid=[...setPlan(valid),action('click','plan-add')];
  const resource=source.resources[0].resource_id;
  const firstDraft=draft.allocations[0]?.allocation_id;
  return [
    test('legacy',['P-E1'],[action('select','legacy-team-filter',{value:source.resources[0].team_id}),action('select','legacy-date-filter',{value:source.default_date}),action('fill','legacy-search',{value:resource}),action('click','resource-row',{source_key:resource}),action('select','legacy-sort',{value:'resource_id_desc'}),action('download','legacy-export'),action('click','legacy-reset'),{kind:'observe',checkpoint:'legacy_reset'}],'planner_legacy',['host_ledger','download']),
    test('draft_baseline',['P-E2'],[{kind:'observe',checkpoint:'initial_draft'}],'planner_initial',['host_ledger']),
    test('keyboard',['P-E3'],[action('focus','legacy-team-filter'),{kind:'press_active',key:'Tab'},{kind:'press_active',key:'Shift+Tab'},action('focus','resource-row',{source_key:resource}),action('press','resource-row',{source_key:resource,key:'Enter'}),{kind:'observe',checkpoint:'open_details'},{kind:'press_active',key:'Escape'},{kind:'observe',checkpoint:'closed_details'}],'planner_keyboard'),
    test('validation',['P-M1'],[...addValid,{kind:'observe',checkpoint:'valid_added'},...validation.probes.map(p=>({kind:'allocation_probe',allocation:p.allocation,probe_kind:p.kind})),...setPlan({...valid,minutes:source.work_items.find(w=>w.work_item_id===valid.work_item_id).remaining_minutes+15}),action('click','plan-add'),{kind:'observe',checkpoint:'demand_overflow'}],'planner_validation',['host_ledger']),
    test('cumulative_capacity',['P-M1'],validation.capacityPair?[...setPlan(validation.capacityPair[0]),action('click','plan-add'),...setPlan(validation.capacityPair[1]),action('click','plan-add'),{kind:'observe',checkpoint:'capacity_overflow'}]:[{kind:'fixture_prerequisite_unavailable',requirement:'Isolatable cumulative capacity probe'}],'planner_validation',['host_ledger']),
    test('cumulative_demand',['P-M1'],validation.demandPair?[...setPlan(validation.demandPair[0]),action('click','plan-add'),...setPlan(validation.demandPair[1]),action('click','plan-add'),{kind:'observe',checkpoint:'demand_overflow'}]:[{kind:'fixture_prerequisite_unavailable',requirement:'Isolatable cumulative demand probe'}],'planner_validation',['host_ledger']),
    test('save',['P-M2'],[...addValid,{kind:'host_control',control:{op:'setFault',command:'writeFile',effect:'hold',phase:'before_process',count:1,path:'./draft.json'}},action('click','draft-save'),{kind:'host_wait_pending'},action('attempt_click_if_enabled','draft-save'),{kind:'host_release_pending'},{kind:'observe',checkpoint:'saved'},{kind:'host_reload'},{kind:'observe',checkpoint:'reread_saved'}],'planner_save',['host_ledger'],'planner_duplicate_save'),
    test('preserve',['P-M3'],[...addValid,...setPlan({...valid,minutes:0}),action('click','plan-add'),action('attempt_click_if_enabled','draft-save'),action('click','legacy-reset'),action('click','resource-row',{source_key:resource}),{kind:'observe',checkpoint:'draft_preserved'},...(firstDraft?[action('fill','draft-line-minutes',{source_key:firstDraft,value:String(draft.allocations[0].minutes)}),{kind:'observe',checkpoint:'explicit_edit'}]:[])],'planner_preservation',['host_ledger']),
    test('conflict',['P-H1'],[...addValid,{kind:'host_control',control:{op:'replaceFiles',fixture_role:'advanced_authority'}},action('click','draft-save'),{kind:'observe',checkpoint:'conflict'},action('click','conflict-review'),{kind:'observe',checkpoint:'authority_review'}],'planner_conflict',['host_ledger'],'planner_conflict'),
    test('readonly',['P-H2'],[{kind:'host_control',control:{op:'setFileCapability',path:'./draft.json',canWrite:false}},{kind:'host_reload'},...addValid,action('attempt_click_if_enabled','draft-save'),{kind:'observe',checkpoint:'predeclared_readonly'}],'planner_readonly',['host_ledger'],'planner_predeclared_readonly'),
    test('midflight_readonly',['P-H2'],[...addValid,{kind:'host_control',control:{op:'setFault',command:'writeFile',effect:'hold',phase:'before_process',count:1,path:'./draft.json'}},action('click','draft-save'),{kind:'host_wait_pending'},{kind:'host_control',control:{op:'setFileCapability',path:'./draft.json',canWrite:false}},{kind:'host_release_pending'},{kind:'observe',checkpoint:'midflight_readonly'}],'planner_readonly',['host_ledger'],'planner_midflight_readonly'),
    test('late_ack',['P-H3'],[...addValid,{kind:'host_control',control:{op:'setFault',command:'writeFile',effect:'hold',phase:'before_process',count:1,path:'./draft.json'}},action('click','draft-save'),{kind:'host_wait_pending'},...(firstDraft?[action('fill','draft-line-minutes',{source_key:firstDraft,value:String(draft.allocations[0].minutes+15)})]:addValid),{kind:'observe',checkpoint:'newer_local'},{kind:'host_release_pending'},{kind:'observe',checkpoint:'older_ack'}],'planner_late_ack',['host_ledger'],'planner_late_ack'),
    test('retry_failure',['P-H3'],[...addValid,{kind:'host_control',control:{op:'setFault',command:'writeFile',effect:'save_failed',phase:'before_process',count:1,path:'./draft.json'}},action('click','draft-save'),{kind:'observe',checkpoint:'save_failed'},{kind:'observe',checkpoint:'reconciliation'},action('click','conflict-review'),action('click','draft-reapply'),action('click','draft-save'),{kind:'observe',checkpoint:'explicit_retry'}],'planner_failure',['host_ledger'],'planner_retryable_failure'),
    test('ambiguous_ack',['P-H3'],[...addValid,{kind:'host_control',control:{op:'setFault',command:'writeFile',effect:'save_failed',phase:'after_process',count:1,path:'./draft.json'}},action('click','draft-save'),{kind:'observe',checkpoint:'ambiguous_result'},{kind:'observe',checkpoint:'reconciled_authority'}],'planner_ambiguous',['host_ledger'],'planner_ambiguous_ack'),
    ...(fixtureId==='unseen_same_schema'?[test('generalization',['P-H4'],[action('fill','legacy-search',{value:resource}),action('click','legacy-reset'),...addValid,action('click','draft-save'),{kind:'observe',checkpoint:'unseen_saved'},action('download','legacy-export')],'planner_generalization',['host_ledger','download'])]:[])
  ];
}

/** Read only. Visibility is measured from rendered layout, never a candidate
 * result attribute. Keep text plus source-identity hook keys to expose conflicts.
 */
export async function captureVisibleDOM(frame) {
  return frame.locator('body').evaluate(body=>{
    const visible=e=>{const r=e.getBoundingClientRect();if(typeof e.checkVisibility!=='function')throw new Error('Pinned browser native visibility instrumentation unavailable');return r.width>0&&r.height>0&&e.checkVisibility({opacityProperty:true,visibilityProperty:true})};
    const inputs=e=>{const all=[...(e.matches('input,select,textarea')?[e]:[]),...e.querySelectorAll('input,select,textarea')];const input=all[0];return {input:input?{value:input.value,type:input.getAttribute('type'),visible:visible(input)}:null,input_count:all.length,visible_input_count:all.filter(visible).length}};
    const cells=e=>{const headers=[...e.closest('table')?.querySelectorAll('thead tr:first-child th')||[]];
      const direct=[...e.querySelectorAll(':scope > td,:scope > th')].filter(visible).map(c=>({text:c.innerText,field:c.getAttribute('data-eval-field'),unit:c.getAttribute('data-eval-unit'),parent_text:c.parentElement?.innerText||'',header:headers[c.cellIndex]?.innerText||'',...inputs(c)}));
      const roles=[...e.querySelectorAll('[data-eval-field]')].filter(c=>visible(c)&&c.closest('[data-eval="ticket-row"],[data-eval="resource-row"],[data-eval="draft-row"]')===e).map(c=>{const td=c.closest('td,th');return {text:c.innerText,field:c.getAttribute('data-eval-field'),unit:c.getAttribute('data-eval-unit'),parent_text:c.parentElement?.innerText||'',header:td?headers[td.cellIndex]?.innerText||'':'',...inputs(td||c)}});
      return [...roles,...direct.filter(c=>!roles.some(role=>role.field&&role.field===c.field))];};
    const nodes=[...body.querySelectorAll('[data-eval]')].map(e=>{const r=e.getBoundingClientRect();return {hook:e.getAttribute('data-eval'),key:e.getAttribute('data-eval-key'),tag:e.tagName.toLowerCase(),field:e.getAttribute('data-eval-field'),unit:e.getAttribute('data-eval-unit'),visible:visible(e),effective_visible:e.checkVisibility({opacityProperty:true,visibilityProperty:true}),axis:e.getAttribute('data-eval-axis'),paint:{background_color:getComputedStyle(e).backgroundColor,svg_fill:e.tagName.toLowerCase()==='rect'?getComputedStyle(e).fill:null},text:visible(e)?e.innerText:'',parent_text:e.parentElement?.innerText||'',header:e.tagName==='TD'?[...e.closest('table')?.querySelectorAll('thead tr:first-child th')||[]][e.cellIndex]?.innerText||'':'',json_text:e.querySelector('pre')?.innerText||null,prefix_text:e.querySelector('p')?.innerText||null,checked:'checked'in e?e.checked:null,value:'value'in e?e.value:null,disabled:'disabled'in e?e.disabled:null,focused:e===document.activeElement,rect:{x:r.x,y:r.y,width:r.width,height:r.height},cells:['ticket-row','resource-row','draft-row'].includes(e.getAttribute('data-eval'))?cells(e):null}});
    return {body_text:body.innerText,nodes,viewport:{width:innerWidth,height:innerHeight},scroll:{width:body.scrollWidth,height:body.scrollHeight},focused_hook:document.activeElement?.getAttribute('data-eval')||document.activeElement?.closest('[data-eval]')?.getAttribute('data-eval')||null,focused_key:document.activeElement?.getAttribute('data-eval-key')||document.activeElement?.closest('[data-eval]')?.getAttribute('data-eval-key')||null};
  });
}

/** Chart-only, read-only measurement. Do not finish/cancel animations or change
 * CSS to make a capture pass. Geometry includes native ancestor visibility.
 */
export async function captureChartGeometry(frame) {
  return frame.locator('body').evaluate(body=>{
    const all=[...body.querySelectorAll('[data-eval="status-plot"],[data-eval="status-glyph"]')],limit=64;
    const targets=all.slice(0,limit);let animationsObserved=true;
    const animations=new Set();
    for(const e of targets){
      try{
        if(typeof e.getAnimations!=='function'){animationsObserved=false;continue}
        for(const a of e.getAnimations({subtree:true}))animations.add(a);
        for(let parent=e.parentElement;parent;parent=parent.parentElement){
          if(typeof parent.getAnimations!=='function'){animationsObserved=false;break}
          for(const a of parent.getAnimations())animations.add(a);
        }
      }catch{animationsObserved=false}
    }
    const active=[];
    for(const a of animations){
      if(!a.pending&&!['running','paused'].includes(a.playState))continue;
      try{const timing=a.effect?.getComputedTiming();active.push({play_state:a.playState,pending:!!a.pending,finite:!!timing&&Number.isFinite(timing.endTime),end_time:Number.isFinite(timing?.endTime)?timing.endTime:null,current_time:Number.isFinite(a.currentTime)?a.currentTime:null})}catch{animationsObserved=false}
    }
    let visibilityObserved=true;
    const nodes=targets.map((e,index)=>{const r=e.getBoundingClientRect();const effective=typeof e.checkVisibility==='function'?e.checkVisibility({opacityProperty:true,visibilityProperty:true}):null;if(effective===null)visibilityObserved=false;return {index,hook:e.getAttribute('data-eval'),key:e.getAttribute('data-eval-key'),tag:e.tagName.toLowerCase(),visible:r.width>0&&r.height>0&&effective===true,effective_visible:effective,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}});
    return {nodes,node_count:all.length,truncated:all.length>limit,animations_observed:animationsObserved,visibility_observed:visibilityObserved,active_animations:active,active_finite_animation_count:active.filter(a=>a.finite).length,active_other_animation_count:active.filter(a=>!a.finite).length};
  });
}

const chartSignature=sample=>JSON.stringify(sample?.nodes);
const chartObserved=sample=>!!sample?.nodes?.length&&!sample.truncated&&sample.animations_observed&&sample.visibility_observed&&sample.nodes.every(n=>Object.values(n.rect).every(Number.isFinite));
const chartStill=sample=>chartObserved(sample)&&sample.active_animations.length===0;

/** Added observation work is capped at 1000ms and the remaining checkpoint
 * clock. Existing PNG/host capture is never cancelled by this measurement.
 * Injected callbacks let neutral offline controls exercise the same algorithm.
 */
export async function captureWithChartStability({sample,capture,budgetMs=1000,deadline=Infinity,now=Date.now,wait=sleep}) {
  const started=now(),budget=Math.max(0,Math.min(1000,budgetMs));let spent=0;
  const samples=[];let streakAt=null,last=null,preStable=false,reason='unobserved';
  const remaining=()=>Math.max(0,Math.min(budget-spent,deadline-now()));
  const read=async phase=>{
    const allowance=remaining(),at=now();if(allowance<=0)return null;
    let timer;
    try{
      const value=await Promise.race([Promise.resolve().then(sample),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),allowance)})]);
      const ended=now();spent+=Math.max(0,ended-at);
      if(!value){reason='sample_unobserved';return null}
      const entry={phase,at:new Date(at).toISOString(),ended_at:new Date(ended).toISOString(),elapsed_ms:ended-started,...value};samples.push(entry);return entry;
    }catch{spent+=Math.max(0,now()-at);reason='sample_unobserved';return null}finally{if(timer)clearTimeout(timer)}
  };
  while(samples.length<20&&(samples.length===0?remaining()>0:remaining()>100)){
    const current=await read('before_capture');if(!current)break;
    if(!chartObserved(current)){reason=current.nodes?.length?'instrumentation_unobserved':'chart_unobserved';break}
    if(chartStill(current)&&chartStill(last)&&chartSignature(current)===chartSignature(last)){
      if(streakAt===null)streakAt=Date.parse(last.ended_at);
      if(now()-streakAt>=100){preStable=true;last=current;break}
    }else{streakAt=chartStill(current)?now():null;reason='motion_or_geometry_change'}
    last=current;const delay=Math.min(50,Math.max(0,remaining()-100));if(delay<=0)break;
    const at=now();await wait(delay);spent+=Math.max(0,now()-at);
  }
  const captureStarted=now(),result=await capture();const captureEnded=now();
  const after=await read('after_png_host_capture');
  const capturedNodes=result?.dom?.nodes?.filter(n=>['status-plot','status-glyph'].includes(n.hook)).map((n,index)=>({index,hook:n.hook,key:n.key,tag:n.tag,visible:n.visible,effective_visible:n.effective_visible,rect:n.rect}));
  const domMatches=!!capturedNodes&&JSON.stringify(capturedNodes)===chartSignature(last);
  const stable=preStable&&chartStill(after)&&chartSignature(last)===chartSignature(after)&&domMatches;
  if(stable)reason='consistent_geometry_no_active_animation';else if(preStable)reason=after?'capture_geometry_or_motion_changed':'capture_after_unobserved';
  const metadata={state:stable?'STABLE':'UNKNOWN',reason,budget_ms:budget,observation_elapsed_ms:spent,started_at:new Date(started).toISOString(),ended_at:new Date(now()).toISOString(),capture_started_at:new Date(captureStarted).toISOString(),capture_ended_at:new Date(captureEnded).toISOString(),quiet_window_ms:100,sample_interval_ms:50,sample_count:samples.length,dom_matches_before_sample:domMatches,samples};
  return {result,metadata};
}

async function hostCall(page, method, value=null) {
  return page.evaluate(async ({method,value})=>{
    if(!window.frameProxy||typeof window.frameProxy[method]!=='function')throw new Error('Trusted outer mockhost observer unavailable');
    return method==='control'?await window.frameProxy.control(value):await window.frameProxy[method]();
  },{method,value});
}

async function waitPending(page,timeout=5000){const until=Date.now()+timeout;while(Date.now()<until){const s=await hostCall(page,'snapshot');if(s.pending?.length)return s.pending[0].id??s.pending[0];await sleep(25)}throw new Error('Evaluator response schedule did not produce a pending request')}

async function waitHostQuiescent(page,timeout=5000,quietWindow=150) {
  const until=Date.now()+timeout;let lastChange=Date.now(),lastSignature='';
  while(Date.now()<until){
    const [events,snapshot]=await Promise.all([hostCall(page,'events'),hostCall(page,'snapshot')]);
    const semantic=events.filter(e=>['getFile','callFunction','writeFile'].includes(e.command)||['FILE_COMMITTED','RESPONSE_HELD','RESPONSE_RELEASED'].includes(e.type));
    const resultSeqs=new Set(events.filter(e=>e.type==='RPC_RESULT').map(e=>e.requestSeq));
    const heldSeqs=new Set(events.filter(e=>e.type==='RESPONSE_HELD'&&snapshot.pending.includes(e.pendingId)).map(e=>e.requestSeq));
    const unresolved=events.filter(e=>e.type==='RPC_ACCEPTED'&&['getFile','callFunction','writeFile'].includes(e.command)&&!resultSeqs.has(e.seq)&&!heldSeqs.has(e.seq));
    const signature=semantic.map(e=>e.seq).join(',');
    if(signature!==lastSignature){lastSignature=signature;lastChange=Date.now()}
    if(!unresolved.length&&Date.now()-lastChange>=quietWindow)return;
    await sleep(25);
  }
  throw new Error('Evaluator could not establish host result quiescence; never infer functional FAIL from a runner deadline');
}

/** Run one frozen test. ``observe`` must be evaluator code, never code loaded
 * from the candidate. Without it the receipt remains UNKNOWN, even if all clicks
 * and screenshots succeeded. It receives real captured DOM plus host ledger.
 */
export async function runAcceptanceTest({page,proxy,test,kind,source,draft,binding,artifactDir,observe,fixtureReplacements={},timeout=5000}) {
  for(const key of ['candidate_package_sha256','candidate_bundle_sha256'])if(!digestPattern.test(binding[key]||''))throw new Error(`Missing frozen ${key}`);
  const fixtureHash=binding.fixtures?.[test.fixture_id];if(!digestPattern.test(fixtureHash||''))throw new Error('Missing frozen fixture hash');
  if(!Array.isArray(proxy.allowedPaths)||!proxy.allowedPaths.length)throw new Error('Runtime must supply exact allowedPaths');
  const preview=new URL(proxy.url),origin=preview.origin;if(preview.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(preview.hostname)||!preview.port)throw new Error('Only explicitly supported runner loopback preview is allowed');
  await fs.mkdir(artifactDir,{recursive:true});
  const start=new Date().toISOString(),receiptId=`${proxy.sessionId}:${test.test_id}`;
  const actions=[],observations=[],captures=[],networkLedger=[],errors=[];
  const context=page.context();if(usedContexts.has(context))throw new Error('Each acceptance test requires a fresh browser context and host session');usedContexts.add(context);
  if(typeof context.routeWebSocket!=='function')throw new Error('Playwright routeWebSocket required for closed-network acceptance');
  await context.routeWebSocket('**/*',ws=>{networkLedger.push({at:new Date().toISOString(),url:ws.url(),method:'WEBSOCKET',resource_type:'websocket',allowed:false,source:'candidate_or_outer_requires_attribution'});ws.close()});
  const route=async requestRoute=>{const request=requestRoute.request();const u=new URL(request.url());let frameUrl='';try{frameUrl=request.frame().url()}catch{}
    const rendererLocal=['blob:','data:','about:'].includes(u.protocol);const allowed=rendererLocal||(u.origin===origin&&proxy.allowedPaths.includes(u.pathname));
    networkLedger.push({at:new Date().toISOString(),url:request.url(),method:request.method(),resource_type:request.resourceType(),frame_url:frameUrl,allowed,source:frameUrl.includes('/frame')?'candidate_frame':'outer_or_unknown'});
    if(allowed)await requestRoute.continue();else await requestRoute.abort('blockedbyclient');};
  await context.route('**/*',route);
  let pendingId=null,frame=null;
  const record=(kind,details={})=>{const a={id:`a-${actions.length+1}`,kind,performed:true,at:new Date().toISOString(),source:'trusted_browser_driver',...details};actions.push(a);return a};
  async function checkpoint(name){
    const checkpointDeadline=Date.now()+timeout;
    await waitHostQuiescent(page,timeout);
    const suffix=`${test.test_id}-${captures.length}-${name}`.replace(/[^a-zA-Z0-9_-]/g,'_');
    const screenshotFile=path.join(artifactDir,`${suffix}.png`);
    const {result,metadata}=await captureWithChartStability({sample:()=>captureChartGeometry(frame),deadline:checkpointDeadline,capture:async()=>{
      const dom=await captureVisibleDOM(frame);await page.screenshot({path:screenshotFile,fullPage:true});
      const snapshot=await hostCall(page,'snapshot'),events=await hostCall(page,'events');return {dom,snapshot,events};
    }});
    const {dom:capture,snapshot,events}=result;capture.chart_geometry_observation=metadata;
    const domFile=path.join(artifactDir,`${suffix}.dom.json`);await fs.writeFile(domFile,JSON.stringify(capture,null,2)+'\n');
    const domRef=`dom:${suffix}`;observations.push({kind:'visible_dom',capture_method:'browser_readonly_dom',evidence_ref:domRef,file:path.basename(domFile),sha256:sha(await fs.readFile(domFile)),checkpoint:name});
    observations.push({kind:'screenshot',evidence_ref:`png:${suffix}`,file:path.basename(screenshotFile),sha256:sha(await fs.readFile(screenshotFile)),checkpoint:name,visually_inspected:false});
    const ledgerFile=path.join(artifactDir,`${suffix}.host.json`);await fs.writeFile(ledgerFile,JSON.stringify({snapshot,events},null,2)+'\n');
    const ledgerRef=`ledger:${suffix}`;observations.push({kind:'host_ledger',evidence_ref:ledgerRef,file:path.basename(ledgerFile),sha256:sha(await fs.readFile(ledgerFile)),checkpoint:name});
    captures.push({checkpoint:name,action_count:actions.length,dom:capture,snapshot,events,evidence_refs:[domRef,ledgerRef]});
  }
  try{
    await page.goto(proxy.url,{waitUntil:'domcontentloaded',timeout});record('navigate',{url:proxy.url});
    await page.locator('#frame').waitFor({state:'visible',timeout});frame=page.frameLocator('#frame');
    await frame.locator('body').waitFor({state:'visible',timeout});await checkpoint('loaded');
    for(const step of test.steps){
      if(step.kind==='host_control'){
        let control=structuredClone(step.control);
        if(control.fixture_role){const files=fixtureReplacements[control.fixture_role];if(!files)throw new Error(`Missing preregistered fixture replacement ${control.fixture_role}`);delete control.fixture_role;control.files=files}
        await hostCall(page,'control',control);await checkpoint(`host_${control.op}`);continue;
      }
      if(step.kind==='host_wait_pending'){pendingId=await waitPending(page,timeout);await checkpoint('pending');continue}
      if(step.kind==='host_release_pending'){if(!pendingId)throw new Error('No trusted pending request bound');await hostCall(page,'control',{op:'release',pendingId,...(step.outcome?{outcome:step.outcome}:{})});pendingId=null;await checkpoint('released');continue}
      if(step.kind==='host_reload'){const navigation=page.waitForEvent('framenavigated',{predicate:f=>f.url().startsWith(`${origin}/frame/`),timeout});await hostCall(page,'reload');await navigation;await frame.locator('body').waitFor({state:'visible',timeout});record('navigate',{mode:'trusted_host_reload'});await checkpoint('reloaded');continue}
      if(step.kind==='observe'){record('observe',{checkpoint:step.checkpoint});await checkpoint(step.checkpoint);continue}
      if(step.kind==='fixture_prerequisite_unavailable')throw new Error(`Frozen fixture cannot exercise required ${step.requirement}; evaluator UNKNOWN`);
      if(step.kind==='allocation_probe'){
        let prevented=false;
        for(const part of setPlan(step.allocation)){
          const target=frame.locator(hookSelector(part.hook));await target.waitFor({state:'visible',timeout});const started_at=new Date().toISOString();
          const tag=await target.evaluate(e=>e.tagName.toLowerCase());
          if(part.kind==='select'&&tag==='select'){
            const available=await target.evaluate((e,value)=>[...e.options].some(o=>o.value===value&&!o.disabled),String(part.value));
            if(!available){record('observe',{hook:part.hook,value:String(part.value),invalid_choice_prevented:true,probe_kind:step.probe_kind,started_at});prevented=true;break}
            await target.selectOption({value:String(part.value)},{timeout});record('select',{hook:part.hook,value:String(part.value),probe_kind:step.probe_kind,started_at});
          }else if(tag==='input'){await target.fill(String(part.value),{timeout});record('fill',{hook:part.hook,value:String(part.value),probe_kind:step.probe_kind,started_at})}
          else throw new Error('Evaluator invalid-selection adapter cannot mechanically resolve this custom control; UNKNOWN');
          await checkpoint(`probe_${step.probe_kind}_${part.hook}`);
        }
        if(!prevented){const started_at=new Date().toISOString();await frame.locator(hookSelector('plan-add')).click({timeout});record('click',{hook:'plan-add',probe_kind:step.probe_kind,started_at})}
        await checkpoint(step.probe_kind);continue;
      }
      const actionStartedAt=new Date().toISOString();
      if(step.kind==='press_active'){await page.keyboard.press(step.key);record('press',{key:step.key,active_target:true,started_at:actionStartedAt});await checkpoint(`after_key_${step.key}`);continue}
      const selector=hookSelector(step.hook,step.source_key);const locator=frame.locator(selector);
      const detail={selector,hook:step.hook,source_key:step.source_key,started_at:actionStartedAt};
      if(step.kind==='attempt_click_if_enabled'){
        if(await locator.count()&&await locator.isVisible()&&await locator.isEnabled()){await locator.click({timeout});record('click',{...detail,explicit_user_action:true})}else{record('observe',{...detail,disabled_or_absent:true})}
      }else{
        await locator.waitFor({state:'visible',timeout});
        if(step.kind==='click'){await locator.click({timeout});record('click',{...detail})}
        else if(step.kind==='fill'){await locator.fill(String(step.value),{timeout});record('fill',{...detail,value:String(step.value)})}
        else if(step.kind==='select'){const tag=await locator.evaluate(e=>e.tagName.toLowerCase());if(tag==='select'){await locator.selectOption({value:String(step.value)},{timeout});record('select',{...detail,value:String(step.value)})}else if(tag==='input'){await locator.fill(String(step.value),{timeout});record('fill',{...detail,value:String(step.value),semantic_action:'select'})}else throw new Error('Evaluator selection adapter does not support this otherwise potentially valid custom control; semantic state UNKNOWN')}
        else if(step.kind==='press'){await locator.press(step.key,{timeout});record('press',{...detail,key:step.key})}
        else if(step.kind==='focus'){await locator.focus({timeout});record('focus',{...detail})}
        else if(step.kind==='clear_status'){if(await locator.isChecked()){await locator.uncheck({timeout});record('click',{...detail,checked:false})}else record('observe',{...detail,already_clear:true})}
        else if(step.kind==='download'){
          await checkpoint('before_download');const beforeDomRef=captures.at(-1).evidence_refs[0],events=[],budget_ms=5000;
          let eventDownload,resolveDownload,timer;const onDownload=d=>{events.push({at:new Date().toISOString(),url:d.url(),suggested_filename:d.suggestedFilename()});eventDownload??=d;if(resolveDownload)resolveDownload(d)};page.on('download',onDownload);
          let download,clickAction,waitStarted;
          try{
            await locator.click({timeout});clickAction=record('click',{...detail});waitStarted=new Date().toISOString();
            download=eventDownload||await new Promise(resolve=>{resolveDownload=resolve;timer=setTimeout(()=>resolve(null),budget_ms)});
          }finally{if(timer)clearTimeout(timer);page.off('download',onDownload)}
          const waitEnded=new Date().toISOString();
          if(download){const downloadFile=path.join(artifactDir,`${test.test_id}.download.csv`);await download.saveAs(downloadFile);
            observations.push({kind:'download',content_utf8:await fs.readFile(downloadFile,'utf8'),evidence_ref:`download:${test.test_id}`,file:path.basename(downloadFile),sha256:sha(await fs.readFile(downloadFile)),suggested_filename:download.suggestedFilename()});record('download',{...detail,file:path.basename(downloadFile)});
          }else{
            if(page.isClosed())throw new Error('Browser closed before bounded download absence could be observed');
            await checkpoint('after_download_absence');
            const ledger={started_at:waitStarted,ended_at:waitEnded,budget_ms,click_action_id:clickAction.id,events};
            const ledgerFile=path.join(artifactDir,`${test.test_id}.download-events.json`);await fs.writeFile(ledgerFile,JSON.stringify(ledger,null,2)+'\n');
            const before=captures.find(c=>c.evidence_refs.includes(beforeDomRef)),content=before?.snapshot.files['resources.json']?.content;
            const sourceBound=typeof content==='string'&&before.events.some(e=>e.type==='RPC_RESULT'&&e.command==='getFile'&&e.answer?.result?.fileContent===content&&before.events.find(q=>q.seq===e.requestSeq)?.params?.fileId?.replace(/^\.\//,'')==='resources.json');
            observations.push({kind:'download_absence',capture_method:'browser_download_event_ledger',evidence_ref:`download-absence:${test.test_id}`,file:path.basename(ledgerFile),sha256:sha(await fs.readFile(ledgerFile)),event_count:events.length,budget_ms,started_at:waitStarted,ended_at:waitEnded,click_action_id:clickAction.id,before_dom_ref:beforeDomRef,after_dom_ref:captures.at(-1).evidence_refs[0],page_valid_before_after:true,source_read_bound:sourceBound,source_read_sha256:typeof content==='string'?sha(content):null});
          }
        }else throw new Error(`Unsupported preregistered step ${step.kind}`);
      }
      await checkpoint(`after_${step.kind}_${step.hook}`);
    }
  }catch(error){errors.push({message:String(error.message||error),stage:frame?'test_action':'browser_or_host_setup'});if(frame)try{await checkpoint('execution_error')}catch(e){errors.push({message:String(e.message),stage:'observer_capture'})}}
  // Keep the deny-by-default route installed until the caller closes this
  // fresh context. Removing it here would leave a still-live candidate unguarded.
  const networkFile=path.join(artifactDir,`${test.test_id}.network.json`);await fs.writeFile(networkFile,JSON.stringify(networkLedger,null,2)+'\n');
  observations.push({kind:'network_ledger',evidence_ref:`network:${test.test_id}`,file:path.basename(networkFile),sha256:sha(await fs.readFile(networkFile))});
  let assertions;
  if(typeof observe==='function'&&captures.length){assertions=await observe({test,kind,source:structuredClone(source),draft:structuredClone(draft),captures,actions,networkLedger,errors,observations})}
  else assertions=test.atom_ids.map(atom_id=>({atom_id,state:'UNKNOWN',oracle:'independent_source_or_host',predicate:'Actual browser result requires independent semantic observer',expected:'source-consistent observed behavior',observed:errors.length?errors:'semantic observer unavailable',evidence_refs:captures.at(-1)?.evidence_refs||[],visible_result_bound:false,functional_observed:false,reason:'No semantic functional PASS inferred from clicks, compilation or screenshots'}));
  const receipt={schema_version:1,origin:RECEIPT_ORIGIN,receipt_id:receiptId,task_kind:kind,execution:'actual_browser',actual_browser_executed:actions.some(a=>a.kind==='navigate'),session_id:proxy.sessionId,test_id:test.test_id,test_plan_sha256:canonicalSha256(test),schedule_id:test.schedule_id,fixture_id:test.fixture_id,fixture_sha256:fixtureHash,candidate_package_sha256:binding.candidate_package_sha256,candidate_bundle_sha256:binding.candidate_bundle_sha256,...Object.fromEntries(['case_id','interface_sha256','scope_sha256','observer_sha256','ci_job_id','github_run_id','compiler_sha256','dependencies_sha256','browser_binary_sha256','runner_image_sha256'].filter(k=>binding[k]).map(k=>[k,binding[k]])),started_at:start,ended_at:new Date().toISOString(),actions,observations,assertions,errors,visual_review:{state:'UNKNOWN',reason:'PNG files require actual evaluator image inspection for overflow/occlusion/readability'}};
  const receiptFile=path.join(artifactDir,`${test.test_id}.receipt.json`);const bytes=JSON.stringify(receipt,null,2)+'\n';await fs.writeFile(receiptFile,bytes);
  return {receipt,manifest_entry:{receipt_id:receiptId,path:receiptFile,sha256:sha(bytes)},captures};
}
