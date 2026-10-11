import React, { useEffect, useRef, useState } from 'react';
import { readFile, writeFile, callFunction } from '@dust/react-hooks';
function ResourceView({source}:{source:any}) {
  const [team,setTeam]=useState(''),[date,setDate]=useState(source.default_date),[search,setSearch]=useState(''),[sort,setSort]=useState('resource_id_asc'),[details,setDetails]=useState('');
  const rowsById=useRef<Record<string,HTMLTableRowElement|null>>({});const closeButton=useRef<HTMLButtonElement|null>(null);
  const dates:Array<string>=Array.from(new Set<string>(source.roster.map((r:any)=>r.date)));
  const rows=source.roster.filter((r:any)=>r.date===date).map((r:any)=>({...r,...source.resources.find((v:any)=>v.resource_id===r.resource_id)})).filter((r:any)=>(!team||r.team_id===team)&&(!search||(r.resource_id+' '+r.display_name).toLowerCase().includes(search.toLowerCase()))).sort((a:any,b:any)=>(a.resource_id<b.resource_id?-1:a.resource_id>b.resource_id?1:0)*(sort==='resource_id_asc'?1:-1));
  const selected=source.resources.find((r:any)=>r.resource_id===details);
  useEffect(()=>{if(details)closeButton.current?.focus();},[details]);
  function close(){const old=details;setDetails('');rowsById.current[old]?.focus();}
  function csv(){const columns=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];const quote=(v:any)=>'"'+String(v).replaceAll('"','""')+'"';const text=[columns.join(','),...rows.map((r:any)=>columns.map(k=>quote(k==='residual_minutes'?r.available_minutes-r.committed_minutes:r[k])).join(','))].join('\r\n')+'\r\n';const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='capacity.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section aria-label="Existing capacity view"><h2>Resource capacity</h2><div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e=>setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map((t:any)=><option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
    <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e=>setDate(e.target.value)}>{dates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
    <label>Search <input data-eval="legacy-search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <label>Order <select data-eval="legacy-sort" value={sort} onChange={e=>setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
    <button data-eval="legacy-reset" onClick={()=>{setTeam('');setDate(source.default_date);setSearch('');setSort('resource_id_asc');}}>Reset view</button><button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
  </div>
  <table data-eval="resource-table" style={{width:'100%',marginTop:16}}><thead><tr>{['Resource ID','Name','Team','Date','Available minutes','Committed minutes','Residual minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{rows.map((r:any)=><tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el=>{rowsById.current[r.resource_id]=el;}} onClick={()=>setDetails(r.resource_id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setDetails(r.resource_id);}}}><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id">{r.resource_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes-r.committed_minutes}</td></tr>)}</tbody></table>
  {rows.length===0&&<p>No matching resource/day rows.</p>}
  {selected&&<aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}}} style={{padding:14,border:'1px solid #789'}}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

type Allocation = {allocation_id:string; work_item_id:string; resource_id:string; date:string; minutes:number|string};
type Draft = {draft_id:string; allocations:Allocation[]};
type Authority = {draft:Draft; revision:string|null; canWrite:boolean};
const object = (v:any) => v !== null && typeof v==='object' && !Array.isArray(v);
const text = (v:any) => typeof v==='string' && v.length>0;
const integer = (v:any) => Number.isInteger(v) && v>=0;
function calendarDate(v:any):boolean {
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;
  const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;
}
function exactKeys(v:any,keys:string[]):boolean {return object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));}
function unique(values:string[]):boolean {return new Set(values).size===values.length;}
function validateSource(s:any):void {
  if(!exactKeys(s,['schema_version','snapshot_revision','default_date','teams','resources','roster','work_items'])||s.schema_version!=='resource-plan-1'||!text(s.snapshot_revision)||!calendarDate(s.default_date)||!['teams','resources','roster','work_items'].every(k=>Array.isArray(s[k])))throw new Error('Resource data does not match the declared source schema.');
  if(!s.teams.every((t:any)=>exactKeys(t,['team_id','display_name'])&&text(t.team_id)&&typeof t.display_name==='string')||!unique(s.teams.map((t:any)=>t.team_id)))throw new Error('Invalid source teams.');
  const teamIds=new Set(s.teams.map((t:any)=>t.team_id));
  if(!s.resources.every((r:any)=>exactKeys(r,['resource_id','display_name','team_id','skills'])&&text(r.resource_id)&&typeof r.display_name==='string'&&teamIds.has(r.team_id)&&Array.isArray(r.skills)&&unique(r.skills)&&r.skills.every((k:any)=>k==='EMAIL'||k==='CHAT'))||!unique(s.resources.map((r:any)=>r.resource_id)))throw new Error('Invalid source resources.');
  const resourceIds=new Set(s.resources.map((r:any)=>r.resource_id));
  if(!s.roster.every((r:any)=>exactKeys(r,['resource_id','date','available_minutes','committed_minutes'])&&resourceIds.has(r.resource_id)&&calendarDate(r.date)&&integer(r.available_minutes)&&integer(r.committed_minutes))||!unique(s.roster.map((r:any)=>r.resource_id+'|'+r.date)))throw new Error('Invalid source roster.');
  if(!s.work_items.every((w:any)=>exactKeys(w,['work_item_id','team_id','required_skill','remaining_minutes','earliest_date','due_date'])&&text(w.work_item_id)&&teamIds.has(w.team_id)&&(w.required_skill==='EMAIL'||w.required_skill==='CHAT')&&integer(w.remaining_minutes)&&calendarDate(w.earliest_date)&&calendarDate(w.due_date)&&w.earliest_date<=w.due_date)||!unique(s.work_items.map((w:any)=>w.work_item_id)))throw new Error('Invalid source work items.');
}
function parseDraft(data:any):Draft {
  if(!exactKeys(data,['draft_id','allocations'])||!text(data.draft_id)||!Array.isArray(data.allocations)||!data.allocations.every((a:any)=>exactKeys(a,['allocation_id','work_item_id','resource_id','date','minutes'])&&text(a.allocation_id)&&text(a.work_item_id)&&text(a.resource_id)&&calendarDate(a.date)&&Number.isInteger(a.minutes)&&a.minutes>0&&a.minutes%15===0)||!unique(data.allocations.map((a:any)=>a.allocation_id)))throw new Error('Stored draft does not match the declared draft schema. Local edits have been kept.');
  return {draft_id:data.draft_id,allocations:data.allocations.map((a:any)=>({...a}))};
}
function signature(d:Draft):string {
  return JSON.stringify({draft_id:d.draft_id,allocations:d.allocations.map(a=>({allocation_id:a.allocation_id,work_item_id:a.work_item_id,resource_id:a.resource_id,date:a.date,minutes:a.minutes}))});
}
const revisionAvailable=(v:any):v is string=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
async function readAuthority(expectedId?:string):Promise<Authority> {
  const entry=await readFile('./draft.json');
  if(!entry)throw new Error('Draft read unavailable; permission and revision could not be verified. No replacement file will be created.');
  if(typeof entry.canWrite!=='boolean'||!(entry.revision===null||typeof entry.revision==='string'))throw new Error('Draft capability metadata is invalid.');
  const draft=parseDraft(JSON.parse(await entry.file.text()));
  if(expectedId&&draft.draft_id!==expectedId)throw new Error('The stored draft identity changed. Local edits were retained; Save is blocked.');
  return {draft,revision:entry.revision,canWrite:entry.canWrite};
}
function planErrors(source:any,draft:Draft):string[] {
  const errors:string[]=[];const capacity=new Map<string,number>();const demand=new Map<string,number>();const ids=new Set<string>();
  for(const a of draft.allocations){
    const label=a.allocation_id||'Allocation';
    if(!text(a.allocation_id)||ids.has(a.allocation_id))errors.push(label+': allocation ID must be unique.');ids.add(a.allocation_id);
    const r=source.resources.find((r:any)=>r.resource_id===a.resource_id),w=source.work_items.find((w:any)=>w.work_item_id===a.work_item_id),day=source.roster.find((d:any)=>d.resource_id===a.resource_id&&d.date===a.date);
    if(typeof a.minutes!=='number'||!Number.isFinite(a.minutes)||!Number.isInteger(a.minutes)||a.minutes<=0||a.minutes%15!==0)errors.push(label+': minutes must be a positive integer in 15-minute increments.');
    if(!r)errors.push(label+': select an existing resource.');if(!w)errors.push(label+': select an existing work item.');
    if(r&&w&&r.team_id!==w.team_id)errors.push(label+': resource and work item must belong to the same team.');
    if(r&&w&&!r.skills.includes(w.required_skill))errors.push(label+': resource lacks required skill '+w.required_skill+'.');
    if(!calendarDate(a.date)||!day)errors.push(label+': date must have a roster entry for this resource.');
    if(w&&(a.date<w.earliest_date||a.date>w.due_date))errors.push(label+': date must be within '+w.earliest_date+' through '+w.due_date+' inclusive.');
    if(typeof a.minutes==='number'&&Number.isFinite(a.minutes)){
      const key=a.resource_id+'|'+a.date;capacity.set(key,(capacity.get(key)||0)+a.minutes);demand.set(a.work_item_id,(demand.get(a.work_item_id)||0)+a.minutes);
    }
  }
  source.roster.forEach((r:any)=>{const planned=capacity.get(r.resource_id+'|'+r.date)||0;if(planned>r.available_minutes-r.committed_minutes)errors.push(r.resource_id+' on '+r.date+': planned '+planned+' minutes exceeds residual committed capacity '+(r.available_minutes-r.committed_minutes)+' minutes.');});
  source.work_items.forEach((w:any)=>{const planned=demand.get(w.work_item_id)||0;if(planned>w.remaining_minutes)errors.push(w.work_item_id+': planned '+planned+' minutes exceeds remaining effort '+w.remaining_minutes+' minutes.');});
  return errors;
}
function AllocationEditor({source}:{source:any}) {
  const [local,setLocal]=useState<Draft|null>(null),[authority,setAuthority]=useState<Authority|null>(null),[review,setReview]=useState<Authority|null>(null);
  const [pending,setPending]=useState(false),[reading,setReading]=useState(false),[blocked,setBlocked]=useState(false),[readOnly,setReadOnly]=useState(false);
  const [storeError,setStoreError]=useState(''),[saveState,setSaveState]=useState('Loading existing draft…'),[formError,setFormError]=useState('');
  const [work,setWork]=useState(source.work_items[0]?.work_item_id||''),[resource,setResource]=useState(source.resources[0]?.resource_id||''),[planDate,setPlanDate]=useState(source.default_date),[minutes,setMinutes]=useState('15');
  const lock=useRef(false),counter=useRef(0),localRef=useRef<Draft|null>(null),alive=useRef(true),readOnlyRef=useRef(false);
  function changeLocal(d:Draft){localRef.current=d;setLocal(d);}
  function observe(a:Authority){if(!a.canWrite){readOnlyRef.current=true;setReadOnly(true);}}
  useEffect(()=>{alive.current=true;let live=true;(async()=>{try{const a=await readAuthority();if(!live)return;observe(a);setAuthority(a);changeLocal(a.draft);setSaveState('Existing draft loaded from the controlled store.');}catch(e:any){if(live){setStoreError(e.message||'Draft could not be read.');setSaveState('Draft unavailable; Save is blocked.');}}})();return()=>{live=false;alive.current=false;};},[]);
  const errors=local?planErrors(source,local):[];
  const dirty=!!(local&&authority&&signature(local)!==signature(authority.draft));
  const editable=!!local;
  function update(id:string,field:keyof Allocation,value:string){
    const d=localRef.current;if(!d)return;changeLocal({...d,allocations:d.allocations.map(a=>a.allocation_id===id?{...a,[field]:field==='minutes'?(value.trim()===''?'':Number(value)):value}:a)});
  }
  function remove(id:string){const d=localRef.current;if(d)changeLocal({...d,allocations:d.allocations.filter(a=>a.allocation_id!==id)});}
  function add(){
    const d=localRef.current;if(!d)return;
    let id:string;do{id='local-'+Date.now().toString(36)+'-'+(++counter.current);}while(d.allocations.some(a=>a.allocation_id===id));
    const a:Allocation={allocation_id:id,work_item_id:work,resource_id:resource,date:planDate,minutes:minutes.trim()===''?'':Number(minutes)};
    const next={...d,allocations:[...d.allocations,a]};const invalid=planErrors(source,next);
    if(invalid.length){setFormError(invalid.join(' '));return;}
    changeLocal(next);setFormError('');setStoreError('');
  }
  async function reviewAuthority(){
    if(lock.current||reading)return;setReading(true);setStoreError('');
    try{const a=await readAuthority(localRef.current?.draft_id);if(!alive.current)return;observe(a);setReview(a);setSaveState('Current stored draft reviewed. Local edits are unchanged. Choose reapply or discard explicitly.');}
    catch(e:any){if(alive.current)setStoreError(e.message||'Current authority could not be read.');}
    finally{if(alive.current)setReading(false);}
  }
  function reapply(){
    if(!review||lock.current||reading)return;
    setAuthority(review);setReview(null);setBlocked(false);setStoreError('');setSaveState('Local draft retained against the reviewed revision. Nothing has been saved; use Save explicitly.');
  }
  function discard(){
    if(lock.current||reading)return;const a=review||authority;if(!a)return;
    changeLocal({draft_id:a.draft.draft_id,allocations:a.draft.allocations.map(x=>({...x}))});setAuthority(a);setReview(null);setBlocked(false);setFormError('');setStoreError('');setSaveState('Local edits discarded explicitly; restored the last verified stored draft.');
  }
  async function reconcile(submitted:Draft,previous:Authority,reason:string){
    setBlocked(true);setStoreError(reason+' Local edits are preserved. Re-reading the actual file to reconcile the outcome.');
    try{
      const a=await readAuthority(submitted.draft_id);if(!alive.current)return;observe(a);
      if(signature(a.draft)===signature(submitted)){
        setAuthority(a);setReview(null);setBlocked(false);setStoreError('');setSaveState('Save acknowledgement was unconfirmed, but a fresh file read confirms the submitted draft is stored at revision '+(a.revision||'unavailable')+'. Newer local edits, if any, remain unsaved.');
      }else if(a.revision===previous.revision&&signature(a.draft)===signature(previous.draft)){
        setAuthority(a);setReview(null);setBlocked(false);setStoreError(reason+' A fresh file read confirms the previous stored draft is unchanged. Local edits remain unsaved; retry only with explicit Save.');setSaveState('Save failed; current authority verified.');
      }else{
        setReview(a);setBlocked(true);setStoreError(reason+' The stored draft differs. Review current authority and explicitly reapply or discard; no automatic retry.');setSaveState('Unconfirmed outcome; authority review required.');
      }
    }catch(e:any){if(alive.current){setStoreError(reason+' '+(e.message||'Re-read failed.')+' Save remains blocked until current authority can be reviewed.');setSaveState('Unconfirmed outcome; reconciliation required.');}}
  }
  async function save(){
    const d=localRef.current;
    if(lock.current||!d||!authority||blocked||reading)return;
    const invalid=planErrors(source,d);
    if(invalid.length||formError){setStoreError('Invalid input cannot be saved. Correct the allocation or rejected add input first.');return;}
    if(readOnlyRef.current||!authority.canWrite){setStoreError('Read-only: the verified source does not permit Save. Local edits are preserved.');return;}
    if(!revisionAvailable(authority.revision)){setStoreError('Save unavailable: no usable verified draft revision. Review the current authority.');return;}
    const submitted:Draft={draft_id:d.draft_id,allocations:d.allocations.map(a=>({...a}))};const previous=authority;
    lock.current=true;setPending(true);setStoreError('');setSaveState('Saving submitted draft snapshot… You may keep editing locally.');
    let startedWrite=false;
    try{
      // Check current capability without silently rebasing onto a newer revision.
      const capability=await readAuthority(submitted.draft_id);if(!alive.current)return;observe(capability);
      if(!capability.canWrite||readOnlyRef.current){setAuthority({...previous,canWrite:false});setStoreError('Read-only: Save refused before writing. Local edits are preserved.');setSaveState('Save refused: read-only.');return;}
      if(!revisionAvailable(capability.revision)){setBlocked(true);setStoreError('Current draft revision is unavailable. Review authority before another Save.');setSaveState('Save refused: revision unavailable.');return;}
      startedWrite=true;
      const result=await writeFile('./draft.json',signature(submitted),{revision:previous.revision!,contentType:'application/json'});
      if(!alive.current)return;
      if(result.success===true&&revisionAvailable(result.revision)){
        try{
          const stored=await readAuthority(submitted.draft_id);if(!alive.current)return;observe(stored);
          if(stored.revision===result.revision&&signature(stored.draft)===signature(submitted)){
            setAuthority(stored);setReview(null);setBlocked(false);setStoreError('');setSaveState('Submitted draft saved and verified at revision '+result.revision+'. This saves a tentative draft only; no resources were booked. Newer local edits remain unsaved.');
          }else{
            setReview(stored);setBlocked(true);setStoreError('The write was acknowledged, but the current stored draft/revision differs from the submitted snapshot. Local edits are preserved; review before reapplying.');setSaveState('Acknowledged snapshot; current authority requires review.');
          }
        }catch(e:any){setBlocked(true);setStoreError('Write acknowledged, but stored contents could not be independently verified. '+(e.message||'Read failed.')+' Review current authority before another Save.');setSaveState('Acknowledged; verification pending.');}
      }else if(result.success===false){
        const code=result.error?.code,message=result.error?.message||'Save was rejected.';
        if(code==='read_only'){
          readOnlyRef.current=true;setReadOnly(true);setAuthority({...previous,canWrite:false});setStoreError('Read-only: '+message+' Local edits are preserved.');setSaveState('Save rejected: read-only.');
        }else if(code==='conflict'){
          setBlocked(true);setReview(null);setStoreError('Revision conflict: '+message+' Local edits are preserved. Review current authority, then explicitly reapply or discard.');setSaveState('Save rejected: revision conflict.');
        }else if(code==='save_failed')await reconcile(submitted,previous,'Save failed with an unconfirmed outcome: '+message);
        else {setBlocked(true);setStoreError('Save refused: '+message+' Local edits are preserved. Review the existing draft; no alternate write path will be used.');setSaveState('Save rejected: '+(code||'unknown error')+'.');}
      }else await reconcile(submitted,previous,'The save response was not a valid confirmed acknowledgement.');
    }catch(e:any){
      if(alive.current){if(startedWrite)await reconcile(submitted,previous,'Save outcome unconfirmed: '+(e.message||'Temporary failure.'));else{setBlocked(true);setStoreError('Capability could not be verified: '+(e.message||'Read failed.')+' Local edits are preserved. Review current authority before retrying.');setSaveState('Save not submitted.');}}
    }finally{lock.current=false;if(alive.current)setPending(false);}
  }
  const total=(predicate:(a:Allocation)=>boolean)=>local?.allocations.filter(predicate).reduce((sum,a)=>sum+(typeof a.minutes==='number'&&Number.isFinite(a.minutes)?a.minutes:0),0)||0;
  const saveDisabled=pending||reading||blocked||readOnly||!authority?.canWrite||!revisionAvailable(authority?.revision)||!local||errors.length>0||!!formError;
  return <section aria-label="Allocation plan editor" style={{marginTop:28,borderTop:'2px solid #789',paddingTop:16}}>
    <h2>Tentative allocation plan</h2>
    <p>This is a synthetic draft, separate from committed work. Each line needs matching team and skill, a roster date in the work window, and a positive multiple of 15 minutes.</p>
    <p>Draft ID: {local?.draft_id||'unavailable'} · Verified revision: {authority?.revision||'unavailable'} · {readOnly||authority?.canWrite===false?'Read-only':authority?.canWrite?'Draft write permitted':'Capability unavailable'}</p>
    <p data-eval="draft-dirty-state" role="status">{local?(dirty?'Unsaved local changes':blocked?'Local draft retained; authority review required':'Local draft matches the last verified stored snapshot'):'Draft not loaded'}</p>
    <p data-eval="draft-save-state" role="status">{pending?'Saving submitted snapshot; duplicate Save is disabled. '+saveState:saveState}</p>
    {(storeError||formError||errors.length>0)&&<div data-eval="draft-error" role="alert" style={{color:'#a21b22',padding:12,background:'#fff0f0'}}>{storeError&&<p>{storeError}</p>}{formError&&<p>Allocation was not added: {formError}</p>}{errors.length>0&&<ul>{errors.map((s,i)=><li key={i}>{s}</li>)}</ul>}</div>}
    <fieldset disabled={!editable} style={{margin:'18px 0'}}><legend>Add a local allocation</legend><div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label>Work item <select data-eval="plan-work-item" value={work} onChange={e=>{setWork(e.target.value);setFormError('');}}><option value="">Choose work item</option>{source.work_items.map((w:any)=><option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.team_id} · {w.required_skill}</option>)}</select></label>
      <label>Resource <select data-eval="plan-resource" value={resource} onChange={e=>{setResource(e.target.value);setFormError('');}}><option value="">Choose resource</option>{source.resources.map((r:any)=><option key={r.resource_id} value={r.resource_id}>{r.display_name} ({r.resource_id}) · {r.team_id} · {r.skills.join(', ')}</option>)}</select></label>
      <label>Plan date <input data-eval="plan-date" type="date" value={planDate} onChange={e=>{setPlanDate(e.target.value);setFormError('');}}/></label>
      <label>Minutes <input data-eval="plan-minutes" type="number" step="15" min="15" value={minutes} onChange={e=>{setMinutes(e.target.value);setFormError('');}} style={{width:90}}/></label>
      <button data-eval="plan-add" type="button" onClick={add}>Add allocation</button>
    </div></fieldset>
    <div style={{overflowX:'auto'}}><table data-eval="draft-table" style={{width:'100%'}}><caption>Local draft allocations (editable; not committed)</caption><thead><tr>{['Allocation ID','Work item','Resource','Date','Minutes','Action'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{local?.allocations.map(a=><tr data-eval="draft-row" data-eval-key={a.allocation_id} key={a.allocation_id}>
      <td>{a.allocation_id}</td>
      <td><select aria-label={'Work item for '+a.allocation_id} data-eval="draft-line-work-item" data-eval-key={a.allocation_id} value={a.work_item_id} onChange={e=>update(a.allocation_id,'work_item_id',e.target.value)}>{!source.work_items.some((w:any)=>w.work_item_id===a.work_item_id)&&<option value={a.work_item_id}>{a.work_item_id} (missing)</option>}{source.work_items.map((w:any)=><option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id}</option>)}</select></td>
      <td><select aria-label={'Resource for '+a.allocation_id} data-eval="draft-line-resource" data-eval-key={a.allocation_id} value={a.resource_id} onChange={e=>update(a.allocation_id,'resource_id',e.target.value)}>{!source.resources.some((r:any)=>r.resource_id===a.resource_id)&&<option value={a.resource_id}>{a.resource_id} (missing)</option>}{source.resources.map((r:any)=><option key={r.resource_id} value={r.resource_id}>{r.display_name} ({r.resource_id})</option>)}</select></td>
      <td><input aria-label={'Date for '+a.allocation_id} data-eval="draft-line-date" data-eval-key={a.allocation_id} type="date" value={a.date} onChange={e=>update(a.allocation_id,'date',e.target.value)}/></td>
      <td><input aria-label={'Minutes for '+a.allocation_id} data-eval="draft-line-minutes" data-eval-key={a.allocation_id} type="number" min="15" step="15" value={a.minutes} onChange={e=>update(a.allocation_id,'minutes',e.target.value)} style={{width:90}}/></td>
      <td><button data-eval="draft-line-remove" data-eval-key={a.allocation_id} onClick={()=>remove(a.allocation_id)}>Remove</button></td>
    </tr>)}</tbody></table></div>
    {local?.allocations.length===0&&<p>No local allocations. Add a line to plan work.</p>}
    <div style={{display:'flex',gap:10,flexWrap:'wrap',margin:'16px 0'}}>
      <button data-eval="draft-save" onClick={save} disabled={saveDisabled}>{pending?'Saving…':'Save draft'}</button>
      <button data-eval="conflict-review" onClick={reviewAuthority} disabled={pending||reading||!local}>{reading?'Reading authority…':'Review current authority'}</button>
      <button data-eval="draft-discard" onClick={discard} disabled={pending||reading||!authority||blocked&&!review}>Discard local edits</button>
    </div>
    {blocked&&<p>Save is blocked until you review current authority and explicitly decide whether to reapply local edits or discard them.</p>}
    {review&&<aside data-eval="authority-review" aria-label="Current stored draft review" style={{border:'1px solid #789',padding:14,margin:'16px 0'}}>
      <h3>Current authority, separate from your local draft</h3><p>Draft {review.draft.draft_id} · Revision {review.revision||'unavailable'} · {review.canWrite?'Writable':'Read-only'}</p>
      <table style={{width:'100%'}}><thead><tr>{['Allocation ID','Work item','Resource','Date','Stored minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{review.draft.allocations.map(a=><tr key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td>{a.minutes}</td></tr>)}</tbody></table>
      {review.draft.allocations.length===0&&<p>The stored draft has no allocations.</p>}
      <p>Reviewing does not change your local draft or save it. Reapply keeps the entire local draft as your proposed replacement. Check both versions before choosing.</p>
      <button data-eval="draft-reapply" onClick={reapply} disabled={pending||reading||readOnly||!review.canWrite||!revisionAvailable(review.revision)}>Reapply local draft to reviewed revision</button>
      <button onClick={discard} disabled={pending||reading}>Discard local edits and use reviewed draft</button>
    </aside>}
    {local&&<><h3>Resource/day capacity preview</h3><p>Source committed work is unchanged. Tentative minutes below come only from this local draft.{errors.length>0?' The draft is invalid; correct it before saving.':''}</p>
      <div style={{overflowX:'auto'}}><table style={{width:'100%'}}><thead><tr>{['Resource ID','Date','Residual committed minutes','Tentative planned minutes','Capacity after tentative plan (minutes)'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{source.roster.map((r:any)=>{const key=r.resource_id+'|'+r.date,planned=total(a=>a.resource_id===r.resource_id&&a.date===r.date),residual=r.available_minutes-r.committed_minutes;return <tr data-eval="draft-capacity" data-eval-key={key} key={key}><td>{r.resource_id}</td><td>{r.date}</td>{[['residual_committed_minutes',residual],['planned_minutes',planned],['capacity_after_plan_minutes',residual-planned]].map(([field,value])=><td key={String(field)} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field={field} data-eval-unit="minutes">{value}</td>)}</tr>;})}</tbody></table></div>
      <h3>Remaining-work preview</h3><table style={{width:'100%'}}><thead><tr>{['Work item','Team / skill','Eligible dates','Source remaining minutes','Tentative planned minutes','Remaining after tentative plan (minutes)'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{source.work_items.map((w:any)=>{const planned=total(a=>a.work_item_id===w.work_item_id);return <tr data-eval="draft-work" data-eval-key={w.work_item_id} key={w.work_item_id}><td>{w.work_item_id}</td><td>{w.team_id} / {w.required_skill}</td><td>{w.earliest_date} through {w.due_date}</td>{[['source_remaining_minutes',w.remaining_minutes],['planned_minutes',planned],['remaining_after_plan_minutes',w.remaining_minutes-planned]].map(([field,value])=><td key={String(field)} data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field={field} data-eval-unit="minutes">{value}</td>)}</tr>;})}</tbody></table>
    </>}
  </section>;
}
export default function ExistingResourceFrame() {
  const [source,setSource]=useState<any>(null),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false);
  const refreshLock=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;let live=true;(async()=>{try{const entry=await readFile('./resources.json');if(!entry)throw new Error('Resource source is unavailable.');const data=JSON.parse(await entry.file.text());validateSource(data);if(live)setSource(data);}catch(e:any){if(live)setError(e?.message||'Resource source is unavailable.');}})();return()=>{live=false;alive.current=false;};},[]);
  async function refresh(){
    if(refreshLock.current)return;refreshLock.current=true;setRefreshing(true);setError('');
    try{const result=await callFunction('load-data',{});validateSource(result);if(alive.current)setSource(result);}catch(e:any){if(alive.current)setError('Resource refresh failed. Current facts and local draft were retained. '+(e?.message||''));}finally{refreshLock.current=false;if(alive.current)setRefreshing(false);}
  }
  return <main data-eval="planner-root" style={{fontFamily:'sans-serif',maxWidth:1250,margin:'auto',padding:20,color:'#172b40',lineHeight:1.45}}><h1>Resource planning</h1>
    {error&&<p role="alert">{error}</p>}
    {source?<><p>Source snapshot: {source.snapshot_revision}</p><button data-eval="refresh-resources" onClick={refresh} disabled={refreshing}>{refreshing?'Refreshing source…':'Refresh resources'}</button><ResourceView source={source}/><AllocationEditor source={source}/></>:!error&&<p role="status">Loading resources</p>}
  </main>;
}
