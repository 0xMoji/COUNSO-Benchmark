import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, writeFile } from '@dust/react-hooks';

type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number };
type Draft = { draft_id: string; allocations: Allocation[] };
type Source = { schema_version:string; snapshot_revision:string; default_date:string; teams:Array<{team_id:string;display_name:string}>; resources:Array<{resource_id:string;display_name:string;team_id:string;skills:string[]}>; roster:Array<{resource_id:string;date:string;available_minutes:number;committed_minutes:number}>; work_items:Array<{work_item_id:string;team_id:string;required_skill:string;remaining_minutes:number;earliest_date:string;due_date:string}> };
type Authority = {draft:Draft; revision:string|null; canWrite:boolean};
const FILE='./draft.json';
const deepDraft=(d:Draft):Draft=>({draft_id:d.draft_id,allocations:d.allocations.map(a=>({...a}))});
const same=(a:Draft,b:Draft)=>JSON.stringify(a)===JSON.stringify(b);
const validDraftShape=(v:any):v is Draft=>!!v&&typeof v.draft_id==='string'&&Array.isArray(v.allocations)&&v.allocations.every((a:any)=>a&&typeof a.allocation_id==='string'&&typeof a.work_item_id==='string'&&typeof a.resource_id==='string'&&typeof a.date==='string'&&Number.isFinite(a.minutes));
const money=(n:number)=>Number.isFinite(n)?String(n):'—';

function ResourceView({source}:{source:Source}) {
  const [team,setTeam]=useState(''),[date,setDate]=useState(source.default_date),[search,setSearch]=useState(''),[sort,setSort]=useState('resource_id_asc'),[details,setDetails]=useState('');
  const rowsById=useRef<Record<string,HTMLTableRowElement|null>>({});const closeButton=useRef<HTMLButtonElement|null>(null);
  const dates:Array<string>=Array.from(new Set<string>(source.roster.map(r=>r.date))).sort();
  const rows=source.roster.filter(r=>r.date===date).map(r=>({...r,...source.resources.find(v=>v.resource_id===r.resource_id)})).filter((r:any)=>(!team||r.team_id===team)&&(!search||(r.resource_id+' '+r.display_name).toLowerCase().includes(search.toLowerCase()))).sort((a:any,b:any)=>(a.resource_id<b.resource_id?-1:a.resource_id>b.resource_id?1:0)*(sort==='resource_id_asc'?1:-1));
  const selected=source.resources.find(r=>r.resource_id===details);
  useEffect(()=>{if(details)closeButton.current?.focus();},[details]);
  function close(){const old=details;setDetails('');rowsById.current[old]?.focus();}
  function csv(){const columns=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];const quote=(v:any)=>'"'+String(v).replaceAll('"','""')+'"';const text=[columns.join(','),...rows.map((r:any)=>columns.map(k=>quote(k==='residual_minutes'?r.available_minutes-r.committed_minutes:r[k])).join(','))].join('\r\n')+'\r\n';const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='capacity.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section aria-label="Existing capacity view"><h2>Resource capacity</h2><div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e=>setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map(t=><option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
    <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e=>setDate(e.target.value)}>{dates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
    <label>Search <input data-eval="legacy-search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <label>Order <select data-eval="legacy-sort" value={sort} onChange={e=>setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
    <button data-eval="legacy-reset" onClick={()=>{setTeam('');setDate(source.default_date);setSearch('');setSort('resource_id_asc');}}>Reset view</button><button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
  </div>
  <table data-eval="resource-table" style={{width:'100%',marginTop:16,borderCollapse:'collapse'}}><thead><tr>{['Resource ID','Name','Team','Date','Available minutes','Committed minutes','Residual minutes'].map(h=><th key={h} style={{textAlign:'left',padding:6,borderBottom:'1px solid #ccd'}}>{h}</th>)}</tr></thead><tbody>{rows.map((r:any)=><tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el=>{rowsById.current[r.resource_id]=el;}} onClick={()=>setDetails(r.resource_id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setDetails(r.resource_id);}}}><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id">{r.resource_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes-r.committed_minutes}</td></tr>)}</tbody></table>
  {rows.length===0&&<p>No matching resource/day rows.</p>}
  {selected&&<aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}}} style={{padding:14,border:'1px solid #789',marginTop:12}}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

function Planner({source,initial}:{source:Source;initial:Authority}) {
  const [draft,setDraft]=useState<Draft>(()=>deepDraft(initial.draft));
  const [saved,setSaved]=useState<Draft>(()=>deepDraft(initial.draft));
  const [revision,setRevision]=useState<string|null>(initial.revision);
  const [canWrite,setCanWrite]=useState(initial.canWrite);
  const [pending,setPending]=useState(false);
  const [status,setStatus]=useState('Draft loaded from the controlled draft file.');
  const [error,setError]=useState('');
  const [authority,setAuthority]=useState<Authority|null>(null);
  const [workId,setWorkId]=useState(source.work_items[0]?.work_item_id||'');
  const [resourceId,setResourceId]=useState('');
  const [planDate,setPlanDate]=useState(source.roster[0]?.date||source.default_date);
  const [minutesText,setMinutesText]=useState('60');
  const [formError,setFormError]=useState('');
  const [lineInputs,setLineInputs]=useState<Record<string,string>>({});
  const [lineErrors,setLineErrors]=useState<Record<string,string>>({});
  const [reconciled,setReconciled]=useState(true);
  const dirty=!same(draft,saved);
  const planDates=useMemo(()=>Array.from(new Set(source.roster.map(r=>r.date))).sort(),[source]);
  const allocations=draft.allocations;
  const explanation=(candidate:Draft):string=>{
    if(candidate.draft_id!==initial.draft.draft_id)return 'Draft identity cannot be changed.';
    const workSums:Record<string,number>={},capSums:Record<string,number>={};
    for(const a of candidate.allocations){
      if(!a.allocation_id||!a.work_item_id||!a.resource_id)return 'Every allocation needs its source identity keys.';
      if(!Number.isFinite(a.minutes)||!Number.isInteger(a.minutes)||a.minutes<=0||a.minutes%15!==0)return 'Minutes must be a positive whole number divisible by 15.';
      const w=source.work_items.find(x=>x.work_item_id===a.work_item_id);if(!w)return `Unknown work item ${a.work_item_id}.`;
      const r=source.resources.find(x=>x.resource_id===a.resource_id);if(!r)return `Unknown resource ${a.resource_id}.`;
      if(r.team_id!==w.team_id)return `Resource ${r.resource_id} is not in work item's team ${w.team_id}.`;
      if(!r.skills.includes(w.required_skill))return `Resource ${r.resource_id} lacks required ${w.required_skill} skill.`;
      if(a.date<w.earliest_date||a.date>w.due_date)return `Date must be between ${w.earliest_date} and ${w.due_date} for ${w.work_item_id}.`;
      const roster=source.roster.find(x=>x.resource_id===r.resource_id&&x.date===a.date);if(!roster)return `No roster capacity exists for ${r.resource_id} on ${a.date}.`;
      const key=r.resource_id+'|'+a.date;capSums[key]=(capSums[key]||0)+a.minutes;workSums[w.work_item_id]=(workSums[w.work_item_id]||0)+a.minutes;
      const residual=roster.available_minutes-roster.committed_minutes;if(residual<0||capSums[key]>residual)return `${r.resource_id} has only ${Math.max(0,residual)} residual minutes on ${a.date}; plan total is ${capSums[key]}.`;
      if(workSums[w.work_item_id]>w.remaining_minutes)return `${w.work_item_id} has ${w.remaining_minutes} minutes remaining; planned total is ${workSums[w.work_item_id]}.`;
    }
    return '';
  };
  const wholeError=explanation(draft);
  const resourcePreview=source.roster.map(r=>{const k=r.resource_id+'|'+r.date;const planned=allocations.filter(a=>a.resource_id===r.resource_id&&a.date===r.date).reduce((s,a)=>s+(Number.isFinite(a.minutes)?a.minutes:0),0);return {...r,key:k,planned,residual:r.available_minutes-r.committed_minutes,after:r.available_minutes-r.committed_minutes-planned};});
  const workPreview=source.work_items.map(w=>{const planned=allocations.filter(a=>a.work_item_id===w.work_item_id).reduce((s,a)=>s+(Number.isFinite(a.minutes)?a.minutes:0),0);return {...w,planned,after:w.remaining_minutes-planned};});
  function updateLine(id:string,key:'minutes',value:string){setLineInputs(x=>({...x,[id]:value}));const n=Number(value);if(value.trim()===''||!Number.isFinite(n)||!Number.isInteger(n)||n<=0||n%15!==0){setLineErrors(x=>({...x,[id]:'Use positive 15-minute increments.'}));return;}const next={...draft,allocations:draft.allocations.map(a=>a.allocation_id===id?{...a,[key]:n}:a)};const err=explanation(next);if(err){setLineErrors(x=>({...x,[id]:err}));return;}setLineErrors(x=>{const y={...x};delete y[id];return y;});setDraft(next);setError('');setStatus('Local draft edited. Not saved.');}
  function removeLine(id:string){setDraft(d=>({...d,allocations:d.allocations.filter(a=>a.allocation_id!==id)}));setLineInputs(x=>{const y={...x};delete y[id];return y;});setLineErrors(x=>{const y={...x};delete y[id];return y;});setError('');setStatus('Allocation removed from local draft. Not saved.');}
  function addLine(e:React.FormEvent){e.preventDefault();setFormError('');const w=source.work_items.find(x=>x.work_item_id===workId);const r=source.resources.find(x=>x.resource_id===resourceId);const n=Number(minutesText);if(!w||!r){setFormError('Choose a work item and resource.');return;}const id=`local-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;const candidate={...draft,allocations:[...draft.allocations,{allocation_id:id,work_item_id:workId,resource_id:resourceId,date:planDate,minutes:n}]};const err=explanation(candidate);if(err){setFormError(err);return;}setDraft(candidate);setLineInputs(x=>({...x,[id]:String(n)}));setStatus('Allocation added to local draft. Not saved.');setError('');}
  async function readAuthority():Promise<Authority|null>{try{const entry=await readFile(FILE);if(!entry){setError('Could not read the existing draft file; no cause is available. Local edits are preserved.');return null;}const raw=JSON.parse(await entry.file.text());if(!validDraftShape(raw)){setError('The current draft file did not contain a valid draft. Local edits are preserved.');return null;}return {draft:deepDraft(raw),revision:entry.revision,canWrite:entry.canWrite};}catch(e:any){setError(e?.message||'Draft file could not be read. Local edits are preserved.');return null;}}
  async function review(){const a=await readAuthority();if(a){setAuthority(a);setError('');setStatus(`Reviewed current authority at revision ${a.revision??'unknown'}; local edits were kept.`);}}
  async function save(){if(pending)return;if(!initial.canWrite&&!canWrite){setError('This draft file is read-only. Local edits remain available.');return;}if(!canWrite){setError('Write permission is not available.');return;}if(!revision){setError('The draft has no verified revision, so Save is unavailable.');return;}if(!reconciled){setError('Review the current draft file before another explicit Save.');return;}const localProblem=explanation(draft);if(localProblem||Object.keys(lineErrors).length){setError(localProblem||'Resolve the invalid allocation quantity before saving.');return;}
    setPending(true);setError('');setStatus('Checking the existing draft and saving the submitted snapshot…');const submitted=deepDraft(draft);const baseRevision=revision;
    const before=await readAuthority();if(!before){setPending(false);setStatus('Save not completed; draft status could not be verified.');setReconciled(false);return;}
    setCanWrite(before.canWrite);if(!before.canWrite){setAuthority(before);setReconciled(false);setPending(false);setError('The current draft file is read-only. No Save was attempted; local edits are preserved.');setStatus('Read-only refusal.');return;}
    if(before.revision!==baseRevision||!same(before.draft,saved)){setAuthority(before);setReconciled(false);setPending(false);setError('The authoritative draft changed since it was loaded. Review it, then choose whether to reapply or discard your local edits.');setStatus('Revision conflict; local edits were preserved.');return;}
    let result;try{result=await writeFile(FILE,JSON.stringify(submitted,null,2)+'\n',{revision:before.revision as string,contentType:'application/json'});}catch(e:any){result={success:false,error:{code:'save_failed',message:e?.message||'Save result was not confirmed.'}} as const;}
    if(result.success){const after=await readAuthority();if(after&&after.revision===result.revision&&same(after.draft,submitted)){setRevision(after.revision);setCanWrite(after.canWrite);setSaved(submitted);setAuthority(after);setReconciled(true);setStatus(same(draft,submitted)?'Draft saved and verified. No resource booking or committed-work change was made.':'Submitted draft snapshot saved and verified. Newer local edits remain unsaved.');setError('');}
      else {setReconciled(false);if(after)setAuthority(after);setError('Save was acknowledged, but the stored snapshot could not be independently verified. Local edits are preserved; review the current draft before another Save.');setStatus('Save acknowledgement requires review.');}
    } else {const code=result.error.code;setStatus(code==='conflict'?'Revision conflict; local edits were preserved.':code==='read_only'?'Read-only refusal; local edits were preserved.':'Save outcome needs reconciliation; local edits were preserved.');setError(`${code}: ${result.error.message}`);if(code==='conflict'||code==='read_only'){setReconciled(false);const current=await readAuthority();if(current){setAuthority(current);setCanWrite(current.canWrite);}}else {setReconciled(false);const current=await readAuthority();if(current){setAuthority(current);setCanWrite(current.canWrite);if(same(current.draft,submitted)){setSaved(submitted);setRevision(current.revision);setStatus(same(draft,submitted)?'Submitted snapshot found in the draft file after an uncertain result.':'Submitted snapshot was stored; newer local edits remain unsaved.');setError('');setReconciled(true);}else if(current.revision!==baseRevision||!same(current.draft,saved)){setStatus('The draft file changed during the uncertain Save. Review authority before deciding what to do.');}}}}
    setPending(false);
  }
  function reapply(){if(!authority)return;setRevision(authority.revision);setCanWrite(authority.canWrite);setSaved(deepDraft(authority.draft));setAuthority(null);setReconciled(true);setError('');setStatus('Reviewed authority accepted as the new comparison point. Your local allocations were retained and are still unsaved. Choose Save explicitly to persist.');}
  function discard(){if(!authority)return;setDraft(deepDraft(authority.draft));setSaved(deepDraft(authority.draft));setRevision(authority.revision);setCanWrite(authority.canWrite);setLineInputs({});setLineErrors({});setAuthority(null);setReconciled(true);setError('');setStatus('Local edits discarded by your choice; current authoritative draft loaded.');}
  const saveDisabled=pending||!canWrite||!revision||!!wholeError||Object.keys(lineErrors).length>0||!reconciled;
  return <section aria-label="Allocation plan editor" style={{border:'1px solid #ccd',borderRadius:8,padding:16,marginTop:24}}>
    <h2>Allocation plan</h2><p>Local plan is tentative. Committed work above is unchanged; Save stores this draft only and does not book resources.</p>
    <p data-eval="draft-dirty-state" data-dirty={dirty?'true':'false'} role="status">{dirty?'Unsaved local edits':'No unsaved changes'}{!reconciled?' · Reconciliation required':''}</p>
    <p data-eval="draft-save-state" role="status">{pending?'Save pending · duplicate Save is disabled':status}</p>
    <form onSubmit={addLine} style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'end',padding:'10px 0'}}>
      <label>Work item<select data-eval="plan-work-item" value={workId} onChange={e=>setWorkId(e.target.value)}>{source.work_items.map(w=><option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.required_skill} · {w.remaining_minutes} min remaining</option>)}</select></label>
      <label>Resource<select data-eval="plan-resource" value={resourceId} onChange={e=>setResourceId(e.target.value)}><option value="">Choose resource</option>{source.resources.map(r=><option key={r.resource_id} value={r.resource_id}>{r.resource_id} · {r.display_name} · {r.team_id} · {r.skills.join('/')}</option>)}</select></label>
      <label>Date<select data-eval="plan-date" value={planDate} onChange={e=>setPlanDate(e.target.value)}>{planDates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
      <label>Minutes<input data-eval="plan-minutes" type="number" min="15" step="15" value={minutesText} onChange={e=>setMinutesText(e.target.value)} style={{width:90}}/></label>
      <button data-eval="plan-add" type="submit">Add to local plan</button>
    </form>
    {formError&&<p data-eval="draft-error" role="alert">{formError}</p>}
    {wholeError&&<p data-eval="draft-error" role="alert">Plan needs correction: {wholeError}</p>}
    {error&&<p data-eval="draft-error" role="alert">{error}</p>}
    <h3>Local draft allocations</h3>
    <table data-eval="draft-table" style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Allocation','Work item','Resource','Date','Minutes','Local action'].map(h=><th key={h} style={{textAlign:'left',padding:6,borderBottom:'1px solid #ccd'}}>{h}</th>)}</tr></thead><tbody>{allocations.map(a=><tr key={a.allocation_id} data-eval="draft-row" data-eval-key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td><input data-eval="draft-line-minutes" data-eval-key={a.allocation_id} aria-label={`Minutes for ${a.allocation_id}`} type="number" min="15" step="15" value={lineInputs[a.allocation_id]??String(a.minutes)} onChange={e=>updateLine(a.allocation_id,'minutes',e.target.value)} style={{width:90}}/>{lineErrors[a.allocation_id]&&<small role="alert" style={{display:'block',color:'#a22'}}>{lineErrors[a.allocation_id]}</small>}</td><td><button type="button" data-eval="draft-line-remove" data-eval-key={a.allocation_id} onClick={()=>removeLine(a.allocation_id)}>Remove local line</button></td></tr>)}{allocations.length===0&&<tr><td colSpan={6}>No allocations in this draft.</td></tr>}</tbody></table>
    <h3>Tentative capacity preview</h3><p>Residual committed minutes = available minus committed. Planned minutes are separate; after-plan is residual minus tentative plan.</p>
    <table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Resource | date','Residual committed min','Tentative planned min','Capacity after plan min'].map(h=><th style={{textAlign:'left',padding:6}} key={h}>{h}</th>)}</tr></thead><tbody>{resourcePreview.map(r=><tr key={r.key} data-eval="draft-capacity" data-eval-key={r.key}><td>{r.resource_id} | {r.date}</td><td data-eval="draft-capacity-value" data-eval-key={r.key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{r.residual}</td><td data-eval="draft-capacity-value" data-eval-key={r.key} data-eval-field="planned_minutes" data-eval-unit="minutes">{r.planned}</td><td data-eval="draft-capacity-value" data-eval-key={r.key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{r.after}</td></tr>)}</tbody></table>
    <h3>Remaining work preview</h3><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr>{['Work item','Source remaining min','Tentative planned min','Remaining after plan min'].map(h=><th style={{textAlign:'left',padding:6}} key={h}>{h}</th>)}</tr></thead><tbody>{workPreview.map(w=><tr key={w.work_item_id} data-eval="draft-work" data-eval-key={w.work_item_id}><td>{w.work_item_id}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{w.remaining_minutes}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{w.planned}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{w.after}</td></tr>)}</tbody></table>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',marginTop:14}}><button type="button" data-eval="draft-save" disabled={saveDisabled} onClick={save}>{pending?'Saving…':'Save draft'}</button>{!canWrite&&<span>Read-only source · Save unavailable</span>}<button type="button" data-eval="refresh-resources" onClick={review}>Review current draft file</button><button type="button" data-eval="draft-discard" disabled={!authority} onClick={discard}>Discard local edits and use reviewed authority</button></div>
    {authority&&<aside data-eval="authority-review" aria-label="Current authoritative draft" style={{border:'1px solid #a9b8ca',padding:12,marginTop:12,background:'#f6f8fb'}}><h3>Current authority · revision {authority.revision??'unknown'} · {authority.canWrite?'writable':'read-only'}</h3><p>Review is separate from your local draft. No edits were replaced or saved.</p><table style={{width:'100%'}}><thead><tr><th>Allocation</th><th>Work</th><th>Resource</th><th>Date</th><th>Minutes</th></tr></thead><tbody>{authority.draft.allocations.map(a=><tr key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td>{a.minutes}</td></tr>)}</tbody></table><button data-eval="draft-reapply" type="button" onClick={reapply}>Keep my local edits against this reviewed revision</button> <button type="button" onClick={discard}>Discard local edits and load this authority</button></aside>}
  </section>;
}

export default function ExistingResourceFrame() {
 const [source,setSource]=useState<Source|null>(null),[initial,setInitial]=useState<Authority|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;(async()=>{try{const [resourceEntry,draftEntry]=await Promise.all([readFile('./resources.json'),readFile(FILE)]);if(!resourceEntry)throw new Error('Resource source is unavailable.');if(!draftEntry)throw new Error('Existing draft file is unavailable; no replacement will be created.');const data=JSON.parse(await resourceEntry.file.text());const draft=JSON.parse(await draftEntry.file.text());if(!validDraftShape(draft))throw new Error('Existing draft file has an invalid shape.');if(live){setSource(data);setInitial({draft:deepDraft(draft),revision:draftEntry.revision,canWrite:draftEntry.canWrite});}}catch(e:any){if(live)setError(e?.message||'Resource or draft source is unavailable.');}})();return()=>{live=false;};},[]);
 return <main data-eval="planner-root" style={{fontFamily:'Arial, sans-serif',maxWidth:1150,margin:'auto',padding:20,color:'#182331'}}><h1>Resource planning</h1>{error?<p role="alert">{error}</p>:source&&initial?<><ResourceView source={source}/><Planner source={source} initial={initial}/></>:<p role="status">Loading resources and draft</p>}</main>;
}
