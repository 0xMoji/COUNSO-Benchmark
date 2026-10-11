import { DashboardModel, statuses, activeStatuses } from './dashboard-model.mjs';
import { PlannerModel } from './planner-model.mjs';
import { TOOL_PATHS } from './api-contract.mjs';
const root = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const kind = params.get('task') || 'dashboard';
const mutation = params.get('mutation');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selected = (a,b) => a === b ? 'selected' : '';
async function api(tool, input = {}) {
  const {method,path} = TOOL_PATHS[tool];
  const response = await fetch(path, { method, headers: { 'Content-Type':'application/json' }, ...(method === 'POST' ? {body:JSON.stringify(input)} : {}) });
  return response.json();
}
function renderPreservingFocus(html) {
  const active = document.activeElement?.id;
  root.innerHTML = html; root.setAttribute('aria-busy', 'false');
  if(active) document.getElementById(active)?.focus({ preventScroll: true });
}
function renderDashboard(state) {
  if (!state.source) { renderPreservingFocus(`<h1>Support dashboard</h1><p role="${state.error ? 'alert':'status'}">${escape(state.error || 'Loading synthetic source')}</p>`); return; }
  const {intent,view,phase,error} = state;
  const current = view && JSON.stringify(view.scope) === JSON.stringify(intent) && phase === 'ready';
  const summary = view?.summary;
  const max = Math.max(1, ...Object.values(summary?.chart || {}));
  renderPreservingFocus(`<h1>Support dashboard</h1><p class="muted">Synthetic local data. Times and created-date intervals use UTC.</p>
    <fieldset><legend>Filter tickets</legend><label>Team <select id="team" aria-label="Team"><option value="">All teams</option>${state.source.teams.map(t => `<option value="${escape(t.team_id)}" ${selected(intent.team_ids[0] || '',t.team_id)}>${escape(t.display_name)} (${escape(t.team_id)})</option>`).join('')}</select></label>
    ${statuses.map(s => `<label><input type="checkbox" id="status-${s}" aria-label="${s}" ${intent.statuses.includes(s)?'checked':''}>${s}</label>`).join('')}
    <label>Created from (inclusive UTC)<input id="from" aria-label="Created from" type="date" value="${escape(intent.created_from)}"></label>
    <label>Created to (exclusive UTC)<input id="to" aria-label="Created to" type="date" value="${escape(intent.created_to)}"></label>
    <button id="reset">Reset filters</button><button id="refresh">Refresh data</button>${error?'<button id="retry">Retry load</button>':''}</fieldset>
    <p role="status">${phase==='loading'?'Loading current intent':phase==='error'?'Source error; retained previous data':current?'Ready':'Previous scope data'}</p>
    ${error?`<p role="alert">Read failed: ${escape(error)}. Current filters are retained.</p>`:''}
    ${view?`<section aria-label="Displayed scope"><h2>Displayed scope</h2><p>${current?'Current':'Previous'} results: revision ${escape(view.revision)}; teams ${escape(view.scope.team_ids.join(',')||'ALL')}; statuses ${escape(view.scope.statuses.join(','))}; created [${escape(view.scope.created_from)}, ${escape(view.scope.created_to)}) UTC</p></section>
    <section aria-label="Metrics"><h2>Metrics</h2><dl>${[['Ticket count','ticket_count','tickets'],['Active count','active_count','tickets'],['Overdue active count','overdue_active_count','tickets'],['Remaining effort','remaining_effort_hours','hours']].map(([name,key,unit])=>`<div><dt>${name}</dt><dd><output aria-label="${name}">${summary[key]}</output> ${unit}</dd></div>`).join('')}</dl></section>
    <section aria-label="Active status chart"><h2>Active tickets by status</h2><div class="chart">${activeStatuses.map(s=>`<button id="chart-${s}" aria-label="Select ${s}" aria-pressed="${intent.statuses.length===1 && intent.statuses[0]===s}"><span class="plot" aria-label="${s} plot"><span class="glyph" aria-label="${s} plotted count" style="height:${mutation==='wrong-geometry'?(summary.chart[s]?160:10):160*summary.chart[s]/max}px"></span></span><span>${s}: <output aria-label="${s} count">${summary.chart[s]}</output> tickets</span></button>`).join('')}</div></section>
    <div class="scroll"><table aria-label="Tickets"><caption>Tickets in displayed scope</caption><thead><tr>${['Ticket ID','Team ID','Status','Due time UTC','Remaining minutes'].map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${view.rows.map(r=>`<tr>${[r.ticket_id,r.team_id,r.status,r.due_at,r.remaining_minutes].map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!view.rows.length?'<p role="status">No matching tickets</p>':''}`:''}`);
  document.querySelector('#team').onchange = e => model.setIntent({team_ids:e.target.value?[e.target.value]:[]});
  statuses.forEach(s=>document.querySelector(`#status-${s}`).onchange=()=>model.setIntent({statuses:statuses.filter(x=>document.querySelector(`#status-${x}`).checked)}));
  document.querySelector('#from').onchange=e=>model.setIntent({created_from:e.target.value});
  document.querySelector('#to').onchange=e=>model.setIntent({created_to:e.target.value});
  document.querySelector('#reset').onclick=()=>model.reset(); document.querySelector('#refresh').onclick=()=>model.refresh();
  document.querySelector('#retry')?.addEventListener('click',()=>model.retry());
  activeStatuses.forEach(s=>document.querySelector(`#chart-${s}`)?.addEventListener('click',()=>model.setIntent({statuses:[s]})));
}
// The planner renderer is defined below. No hidden evaluator state or answer hook is exposed.
function renderPlanner(state) { plannerRender(state); }
const model = kind==='planner' ? new PlannerModel(api,renderPlanner,mutation) : new DashboardModel(api,renderDashboard,mutation);
model.init();
function plannerRender(state) {
  if (!state.source || !state.local) { renderPreservingFocus(`<h1>Resource planner</h1><p role="${state.error?'alert':'status'}">${escape(state.error||'Loading source and existing draft')}</p>`); return; }
  const {source,local,view}=state;
  const sorted=source.resources.filter(r=>(!view.team_id||r.team_id===view.team_id)&&`${r.resource_id} ${r.display_name}`.toLowerCase().includes(view.search.toLowerCase())).sort((a,b)=>view.sort==='resource_id_desc'?b.resource_id.localeCompare(a.resource_id):a.resource_id.localeCompare(b.resource_id));
  const rows=sorted.flatMap(r=>source.roster.filter(x=>x.resource_id===r.resource_id&&x.date===view.date).map(x=>({...r,...x})));
  const dayTotals=new Map(),workTotals=new Map();for(const a of local.allocations){const key=`${a.resource_id}|${a.date}`;dayTotals.set(key,(dayTotals.get(key)||0)+a.minutes);workTotals.set(a.work_item_id,(workTotals.get(a.work_item_id)||0)+a.minutes);}
  const editor=state.editor||{work_item_id:source.work_items[0].work_item_id,resource_id:source.resources[0].resource_id,date:source.default_date,minutes:15};
  renderPreservingFocus(`<h1>Resource planner</h1><p class="muted">Synthetic local draft only. Saving does not book resources or change committed work.</p>
    <fieldset><legend>Capacity view</legend><label>Team <select id="view-team" aria-label="View team"><option value="">All teams</option>${source.teams.map(t=>`<option value="${escape(t.team_id)}" ${selected(view.team_id,t.team_id)}>${escape(t.display_name)} (${escape(t.team_id)})</option>`).join('')}</select></label>
    <label>View date<input id="view-date" aria-label="View date" type="date" value="${escape(view.date)}"></label><label>Search resources<input id="search" aria-label="Search resources" value="${escape(view.search)}"></label>
    <label>Resource sort<select id="sort" aria-label="Resource sort"><option value="resource_id_asc" ${selected(view.sort,'resource_id_asc')}>Resource ID ascending</option><option value="resource_id_desc" ${selected(view.sort,'resource_id_desc')}>Resource ID descending</option></select></label><button id="reset-view">Reset view</button><button id="export">Export capacity CSV</button></fieldset>
    <div class="scroll"><table aria-label="Resource capacity"><caption>Source committed capacity, minutes</caption><thead><tr>${['Resource ID','Display name','Team ID','Date','Available minutes','Committed minutes','Residual minutes','Details'].map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${[r.resource_id,r.display_name,r.team_id,r.date,r.available_minutes,r.committed_minutes,r.available_minutes-r.committed_minutes].map(x=>`<td>${escape(x)}</td>`).join('')}<td><button id="details-${escape(r.resource_id)}" aria-label="Details ${escape(r.resource_id)}" aria-expanded="${state.expanded===r.resource_id}">Details</button></td></tr>${state.expanded===r.resource_id?`<tr><td colspan="8"><section class="detail" tabindex="-1" id="detail-panel" aria-label="Resource details ${escape(r.resource_id)}"><p>${escape(r.display_name)} (${escape(r.resource_id)}), skills ${escape(r.skills.join(', '))}</p><button id="close-details">Close details</button></section></td></tr>`:''}`).join('')}</tbody></table></div>
    <section aria-label="Plan editor"><h2>Local allocations</h2><fieldset><legend>Add allocation</legend><label>Work item<select id="work" aria-label="Work item">${source.work_items.map(w=>`<option value="${escape(w.work_item_id)}" ${selected(editor.work_item_id,w.work_item_id)}>${escape(w.work_item_id)} (${escape(w.required_skill)})</option>`).join('')}</select></label><label>Resource<select id="resource" aria-label="Allocation resource">${source.resources.map(r=>`<option value="${escape(r.resource_id)}" ${selected(editor.resource_id,r.resource_id)}>${escape(r.display_name)} (${escape(r.resource_id)})</option>`).join('')}</select></label><label>Allocation date<input id="allocation-date" aria-label="Allocation date" type="date" value="${escape(editor.date)}"></label><label>Minutes<input id="minutes" aria-label="Allocation minutes" type="number" value="${escape(editor.minutes)}"></label><button id="add">Add allocation</button></fieldset>
    <table aria-label="Local allocations"><caption>Local tentative draft ${escape(local.draft_id)}</caption><thead><tr>${['Allocation ID','Work item ID','Resource ID','Date','Minutes','Remove'].map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${local.allocations.map(a=>`<tr class="allocation">${[a.allocation_id,a.work_item_id,a.resource_id,a.date].map(x=>`<td>${escape(x)}</td>`).join('')}<td><input id="edit-${escape(a.allocation_id)}" type="number" aria-label="Minutes ${escape(a.allocation_id)}" value="${escape(a.minutes)}"></td><td><button aria-label="Remove ${escape(a.allocation_id)}" id="remove-${escape(a.allocation_id)}">Remove</button></td></tr>`).join('')}</tbody></table>
    <h3>Preview after tentative draft</h3><table aria-label="Capacity preview"><caption>Committed and tentative minutes are separate</caption><thead><tr>${['Resource ID','Date','Committed residual minutes','Tentative minutes','Remaining capacity minutes'].map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${source.roster.map(r=>{const tentative=dayTotals.get(`${r.resource_id}|${r.date}`)||0;const residual=r.available_minutes-r.committed_minutes;return `<tr>${[r.resource_id,r.date,residual,tentative,residual-tentative].map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`;}).join('')}</tbody></table>
    <table aria-label="Work preview"><caption>Remaining work after tentative draft</caption><thead><tr>${['Work item ID','Source remaining minutes','Tentative minutes','Remaining work minutes'].map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${source.work_items.map(w=>`<tr>${[w.work_item_id,w.remaining_minutes,workTotals.get(w.work_item_id)||0,w.remaining_minutes-(workTotals.get(w.work_item_id)||0)].map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>
    ${state.error?`<p role="alert">${escape(state.error)}. Local edits retained.</p>`:''}${state.errors?.length?`<p role="alert">Invalid local draft: ${escape(state.errors.join('; '))}</p>`:''}
    <p role="status">${state.pending?'Saving submitted draft':state.dirty?'Unsaved local edits':'Draft matches confirmed authority'}${state.lastSaved?'. Last acknowledgement saved only the submitted draft.':''}</p><p>Write capability: ${state.canWrite?'writable':'read-only'}; revision ${escape(state.revision)}</p>
    <button id="save" ${state.pending||!state.canWrite||state.errors?.length||state.requiresReview?'disabled':''}>Save draft</button><button id="review">Review latest draft</button>
    ${state.review?`<section aria-label="Latest authoritative draft"><h2>Latest authoritative draft</h2><p>Revision ${escape(state.review.revision)}. Review has not changed your local draft.</p><pre>${escape(JSON.stringify(state.review.draft,null,2))}</pre><button id="reapply">Reapply local edits</button><button id="discard">Discard local edits</button></section>`:''}`);
  document.querySelector('#view-team').onchange=e=>model.setView({team_id:e.target.value});document.querySelector('#view-date').onchange=e=>model.setView({date:e.target.value});document.querySelector('#search').onchange=e=>model.setView({search:e.target.value});document.querySelector('#sort').onchange=e=>model.setView({sort:e.target.value});document.querySelector('#reset-view').onclick=()=>model.resetView();
  document.querySelector('#export').onclick=()=>{const header=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];const quote=x=>'"'+String(x).replaceAll('"','""')+'"';const csv=[header.join(','),...rows.map(r=>[r.resource_id,r.display_name,r.team_id,r.date,r.available_minutes,r.committed_minutes,r.available_minutes-r.committed_minutes].map(quote).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='synthetic-capacity.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);};
  for(const r of rows){document.getElementById(`details-${r.resource_id}`).onclick=()=>{state.expanded=r.resource_id;model.notify();document.querySelector('#detail-panel')?.focus();};}
  document.querySelector('#detail-panel')?.addEventListener('keydown',e=>{if(e.key==='Escape'){const id=state.expanded;state.expanded=null;model.notify();document.getElementById(`details-${id}`)?.focus();}});
  document.querySelector('#close-details')?.addEventListener('click',()=>{const id=state.expanded;state.expanded=null;model.notify();document.getElementById(`details-${id}`)?.focus();});
  const readEditor=()=>({work_item_id:document.querySelector('#work').value,resource_id:document.querySelector('#resource').value,date:document.querySelector('#allocation-date').value,minutes:Number(document.querySelector('#minutes').value)});
  for(const id of ['work','resource','allocation-date','minutes'])document.getElementById(id).onchange=()=>{state.editor=readEditor();};
  document.querySelector('#add').onclick=()=>{state.editor=readEditor();model.add(state.editor);};
  for(const a of local.allocations){document.getElementById(`edit-${a.allocation_id}`).onchange=e=>model.edit(a.allocation_id,{minutes:Number(e.target.value)});document.getElementById(`remove-${a.allocation_id}`).onclick=()=>model.remove(a.allocation_id);}
  document.querySelector('#save').onclick=()=>model.save();document.querySelector('#review').onclick=()=>model.review();document.querySelector('#reapply')?.addEventListener('click',()=>model.reapply());document.querySelector('#discard')?.addEventListener('click',()=>model.discard());
}
