import React, { useEffect, useRef, useState } from 'react';
import { readFile, writeFile, callFunction, triggerUserFileDownload } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Resource = { resource_id: string; display_name: string; team_id: string; skills: string[] };
type Roster = { resource_id: string; date: string; available_minutes: number; committed_minutes: number };
type Work = { work_item_id: string; team_id: string; required_skill: string; remaining_minutes: number; earliest_date: string; due_date: string };
type Source = { schema_version: string; snapshot_revision: string; default_date: string; teams: Team[]; resources: Resource[]; roster: Roster[]; work_items: Work[] };
type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number };
type Draft = { draft_id: string; allocations: Allocation[] };
type Authority = { draft: Draft; revision: string | null; canWrite: boolean };
type Receipt = { snapshot: Draft; revision: string; confirmed: boolean };

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const quantity = (v: unknown): v is number => whole(v) && v > 0 && v % 15 === 0;
const revisionOK = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
function isoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function objectKeys(v: any, keys: string[]) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
}
function unique(values: string[]) { return new Set(values).size === values.length; }
function parseSource(value: any): Source {
  const bad = () => { throw new Error('Resource source does not match the declared resource-plan-1 schema. Planning and saving require a verified source.'); };
  if (!objectKeys(value, ['schema_version','snapshot_revision','default_date','teams','resources','roster','work_items']) || value.schema_version !== 'resource-plan-1' || !nonempty(value.snapshot_revision) || !isoDate(value.default_date)) bad();
  if (![value.teams, value.resources, value.roster, value.work_items].every(Array.isArray)) bad();
  if (!value.teams.every((t: any) => objectKeys(t,['team_id','display_name']) && nonempty(t.team_id) && typeof t.display_name === 'string')) bad();
  if (!value.resources.every((r: any) => objectKeys(r,['resource_id','display_name','team_id','skills']) && nonempty(r.resource_id) && typeof r.display_name === 'string' && nonempty(r.team_id) && Array.isArray(r.skills) && r.skills.every((s: any) => s === 'EMAIL' || s === 'CHAT') && unique(r.skills))) bad();
  if (!value.roster.every((r: any) => objectKeys(r,['resource_id','date','available_minutes','committed_minutes']) && nonempty(r.resource_id) && isoDate(r.date) && whole(r.available_minutes) && whole(r.committed_minutes))) bad();
  if (!value.work_items.every((w: any) => objectKeys(w,['work_item_id','team_id','required_skill','remaining_minutes','earliest_date','due_date']) && nonempty(w.work_item_id) && nonempty(w.team_id) && (w.required_skill === 'EMAIL' || w.required_skill === 'CHAT') && whole(w.remaining_minutes) && isoDate(w.earliest_date) && isoDate(w.due_date))) bad();
  if (!unique(value.teams.map((t: Team) => t.team_id)) || !unique(value.resources.map((r: Resource) => r.resource_id)) || !unique(value.work_items.map((w: Work) => w.work_item_id)) || !unique(value.roster.map((r: Roster) => r.resource_id + '|' + r.date))) bad();
  return value as Source;
}
function parseDraft(value: any): Draft {
  if (!objectKeys(value,['draft_id','allocations']) || !nonempty(value.draft_id) || !Array.isArray(value.allocations) || !value.allocations.every((a: any) => objectKeys(a,['allocation_id','work_item_id','resource_id','date','minutes']) && nonempty(a.allocation_id) && nonempty(a.work_item_id) && nonempty(a.resource_id) && isoDate(a.date) && quantity(a.minutes)) || !unique(value.allocations.map((a: Allocation) => a.allocation_id))) {
    throw new Error('The existing draft does not match the declared draft schema. It has not been replaced or written.');
  }
  return value as Draft;
}
function copyDraft(d: Draft): Draft { return { draft_id: d.draft_id, allocations: d.allocations.map(a => ({ ...a })) }; }
function fingerprint(d: Draft | null): string {
  return d ? JSON.stringify({ draft_id: d.draft_id, allocations: d.allocations.map(a => ({ allocation_id:a.allocation_id, work_item_id:a.work_item_id, resource_id:a.resource_id, date:a.date, minutes:a.minutes })) }) : '';
}
const equalDraft = (a: Draft | null, b: Draft | null) => fingerprint(a) === fingerprint(b);
function planErrors(source: Source, draft: Draft): string[] {
  const errors: string[] = [];
  const byDay = new Map<string,number>();
  const byWork = new Map<string,number>();
  const ids = new Set<string>();
  for (const a of draft.allocations) {
    const label = 'Allocation ' + a.allocation_id + ': ';
    if (!nonempty(a.allocation_id) || ids.has(a.allocation_id)) errors.push(label + 'allocation identities must be unique.');
    ids.add(a.allocation_id);
    const w = source.work_items.find(v => v.work_item_id === a.work_item_id);
    const r = source.resources.find(v => v.resource_id === a.resource_id);
    const day = source.roster.find(v => v.resource_id === a.resource_id && v.date === a.date);
    if (!quantity(a.minutes)) errors.push(label + 'minutes must be positive whole numbers in 15-minute increments.');
    if (!w) errors.push(label + 'choose a source work item.');
    if (!r) errors.push(label + 'choose a source resource.');
    if (w && r && w.team_id !== r.team_id) errors.push(label + 'resource and work item must belong to the same team.');
    if (w && r && !r.skills.includes(w.required_skill)) errors.push(label + 'resource lacks required skill ' + w.required_skill + '.');
    if (!isoDate(a.date) || !day) errors.push(label + 'date must have a roster row for the selected resource.');
    if (w && isoDate(a.date) && (a.date < w.earliest_date || a.date > w.due_date)) errors.push(label + 'date must be within ' + w.earliest_date + ' through ' + w.due_date + ', inclusive.');
    if (quantity(a.minutes)) {
      const key = a.resource_id + '|' + a.date;
      byDay.set(key, (byDay.get(key) || 0) + a.minutes);
      byWork.set(a.work_item_id, (byWork.get(a.work_item_id) || 0) + a.minutes);
    }
  }
  for (const [key, minutes] of byDay) {
    const day = source.roster.find(r => r.resource_id + '|' + r.date === key);
    if (day && minutes > day.available_minutes - day.committed_minutes) errors.push('Resource/day ' + key + ': planned ' + minutes + ' minutes exceed residual committed capacity of ' + (day.available_minutes - day.committed_minutes) + ' minutes.');
  }
  for (const [id, minutes] of byWork) {
    const w = source.work_items.find(v => v.work_item_id === id);
    if (w && minutes > w.remaining_minutes) errors.push('Work item ' + id + ': planned ' + minutes + ' minutes exceed remaining effort of ' + w.remaining_minutes + ' minutes.');
  }
  return errors;
}
function parseQuantity(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return quantity(n) ? n : null;
}
async function readAuthority(onCapability?: (canWrite: boolean) => void): Promise<Authority> {
  const entry = await readFile('./draft.json');
  if (!entry) throw new Error('The existing draft file could not be read. Its availability, revision and permission are unverified; no replacement file will be created.');
  if (typeof entry.canWrite !== 'boolean') throw new Error('Draft file capability is unverified. Save is unavailable.');
  onCapability?.(entry.canWrite);
  if (!(entry.revision === null || typeof entry.revision === 'string') || !entry.file || typeof entry.file.text !== 'function') throw new Error('Draft file metadata is unverified. Save is unavailable.');
  const draft = parseDraft(JSON.parse(await entry.file.text()));
  return { draft, revision: entry.revision, canWrite: entry.canWrite };
}

// Retained capacity view: filters, facts, sorting, details and keyboard behavior
// remain independent of the tentative draft editor below.
function ResourceView({source}:{source:Source}) {
  const [team,setTeam]=useState(''),[date,setDate]=useState(source.default_date),[search,setSearch]=useState(''),[sort,setSort]=useState('resource_id_asc'),[details,setDetails]=useState('');
  const [downloadError,setDownloadError]=useState('');
  const rowsById=useRef<Record<string,HTMLTableRowElement|null>>({});const closeButton=useRef<HTMLButtonElement|null>(null);
  const dates:Array<string>=Array.from(new Set<string>(source.roster.map(r=>r.date)));
  const rows=source.roster.filter(r=>r.date===date).map(r=>({...r,...source.resources.find(v=>v.resource_id===r.resource_id)})).filter(r=>(!team||r.team_id===team)&&(!search||(r.resource_id+' '+r.display_name).toLowerCase().includes(search.toLowerCase()))).sort((a,b)=>(a.resource_id<b.resource_id?-1:a.resource_id>b.resource_id?1:0)*(sort==='resource_id_asc'?1:-1));
  const selected=source.resources.find(r=>r.resource_id===details);
  useEffect(()=>{if(details)closeButton.current?.focus();},[details]);
  function close(){const old=details;setDetails('');rowsById.current[old]?.focus();}
  function csv(){
    const columns=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];
    const quote=(v:any)=>'"'+String(v).replaceAll('"','""')+'"';
    const text=[columns.join(','),...rows.map((r:any)=>columns.map(k=>quote(k==='residual_minutes'?r.available_minutes-r.committed_minutes:r[k])).join(','))].join('\r\n')+'\r\n';
    setDownloadError('');
    void triggerUserFileDownload({content:text,filename:'capacity.csv'}).catch(()=>setDownloadError('The local CSV download failed. Use Download capacity CSV to try again.'));
  }
  return <section aria-label="Existing capacity view"><h2>Resource capacity</h2><div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e=>setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map(t=><option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
    <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e=>setDate(e.target.value)}>{dates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
    <label>Search <input data-eval="legacy-search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <label>Order <select data-eval="legacy-sort" value={sort} onChange={e=>setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
    <button data-eval="legacy-reset" onClick={()=>{setTeam('');setDate(source.default_date);setSearch('');setSort('resource_id_asc');}}>Reset view</button><button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
  </div>
  <table data-eval="resource-table" style={{width:'100%',marginTop:16}}><thead><tr>{['Resource ID','Name','Team','Date','Available minutes','Committed minutes','Residual minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el=>{rowsById.current[r.resource_id]=el;}} onClick={()=>setDetails(r.resource_id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setDetails(r.resource_id);}}}><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id">{r.resource_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes-r.committed_minutes}</td></tr>)}</tbody></table>
  {rows.length===0&&<p>No matching resource/day rows.</p>}
  {downloadError&&<p role="alert">{downloadError}</p>}
  {selected&&<aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}}} style={{padding:14,border:'1px solid #789'}}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

function AllocationPlanner({source,refreshing}:{source:Source;refreshing:boolean}) {
  const [draft,setDraft] = useState<Draft|null>(null);
  const [basis,setBasis] = useState<Authority|null>(null);
  const [reviewed,setReviewed] = useState<Authority|null>(null);
  const [lineInputs,setLineInputs] = useState<Record<string,string>>({});
  const [work,setWork] = useState(source.work_items[0]?.work_item_id || '');
  const [resource,setResource] = useState(source.resources[0]?.resource_id || '');
  const [date,setDate] = useState(source.default_date);
  const [minutes,setMinutes] = useState('15');
  const [addError,setAddError] = useState('');
  const [storeError,setStoreError] = useState('');
  const [saveMessage,setSaveMessage] = useState('Reading the existing draft and file capability.');
  const [pending,setPending] = useState(false);
  const [reading,setReading] = useState(true);
  const [readOnly,setReadOnly] = useState(false);
  const [needsDecision,setNeedsDecision] = useState(false);
  const [reconcileRequired,setReconcileRequired] = useState(false);
  const [pathDenied,setPathDenied] = useState(false);
  const [identityDenied,setIdentityDenied] = useState(false);
  const [receipt,setReceipt] = useState<Receipt|null>(null);
  const localRef = useRef<Draft|null>(null);
  const basisRef = useRef<Authority|null>(null);
  const reviewedRef = useRef<Authority|null>(null);
  const lineInputsRef = useRef<Record<string,string>>({});
  const readOnlyRef = useRef(false);
  const decisionRef = useRef(false);
  const reconcileRef = useRef(false);
  const saveBusy = useRef(false);
  const readBusy = useRef(false);
  const pathDeniedRef = useRef(false);
  const identityDeniedRef = useRef(false);
  const originalDraftId = useRef<string|null>(null);
  const nextLine = useRef(1);
  const mounted = useRef(true);
  const lastSubmission = useRef<Draft|null>(null);
  const lastExpectedRevision = useRef<string|null>(null);
  const lastOutcome = useRef<'none'|'success'|'conflict'|'save_failed'|'read_only'|'invalid_path'>('none');
  const dates = Array.from(new Set(source.roster.map(r=>r.date))).sort();

  function replaceLocal(next:Draft) {
    const copy = copyDraft(next);
    localRef.current = copy; setDraft(copy);
    const inputs:Record<string,string> = {};
    copy.allocations.forEach(a=>{ inputs[a.allocation_id]=String(a.minutes); });
    lineInputsRef.current=inputs;setLineInputs(inputs);
  }
  function updateLocal(next:Draft) { localRef.current=next;setDraft(next); }
  function rememberBasis(a:Authority) { basisRef.current=a;setBasis(a); }
  function observeCapability(canWrite:boolean) {
    if (!canWrite) { readOnlyRef.current=true;setReadOnly(true); }
  }
  function observeAuthority(a:Authority) {
    reviewedRef.current=a;setReviewed(a);observeCapability(a.canWrite);
  }
  function decision(value:boolean) { decisionRef.current=value;setNeedsDecision(value); }
  function reconcile(value:boolean) { reconcileRef.current=value;setReconcileRequired(value); }
  function checkedIdentity(a:Authority) {
    if (originalDraftId.current !== null && a.draft.draft_id !== originalDraftId.current) {
      identityDeniedRef.current=true;setIdentityDenied(true);
      throw new Error('The file now identifies a different draft. Local edits are preserved; this session cannot overwrite a different draft identity.');
    }
  }
  function reconcileRead(a:Authority, forceConflict:boolean) {
    observeAuthority(a); checkedIdentity(a);
    const prior=basisRef.current;
    const submitted=lastSubmission.current;
    reconcile(false);
    if (forceConflict || decisionRef.current) {
      decision(true);
      setSaveMessage((forceConflict?'Revision conflict. ':'')+'Current authority has been read for review. Local edits remain intact. Explicitly reapply or discard before another Save.');
      return;
    }
    if (submitted && equalDraft(a.draft,submitted) && (lastOutcome.current==='success'||lastOutcome.current==='save_failed')) {
      rememberBasis(a);
      const confirmed=lastOutcome.current==='success' && revisionOK(lastExpectedRevision.current) && a.revision===lastExpectedRevision.current;
      if (revisionOK(a.revision)) setReceipt({snapshot:copyDraft(submitted),revision:a.revision,confirmed});
      setSaveMessage(confirmed ? 'Submitted draft saved and verified at revision '+a.revision+'.' : 'File re-read verifies that the submitted snapshot is stored at revision '+String(a.revision)+'. The write response itself was unconfirmed.');
      if(confirmed)setStoreError('');
      return;
    }
    if(prior && equalDraft(a.draft,prior.draft)) {
      rememberBasis(a);
      if(lastOutcome.current==='save_failed') setSaveMessage('Save was unconfirmed. File re-read confirms the previously stored draft; local changes remain unsaved. A retry requires a new explicit Save.');
      else if(lastOutcome.current==='success') setSaveMessage('Save acknowledgement could not be verified against file contents. Your local changes are retained; a new explicit Save is required.');
      else setSaveMessage('Stored draft and capability have been re-read. Local edits were preserved.');
      return;
    }
    decision(true);
    setStoreError('The current stored draft differs from the editing baseline. Review it separately and explicitly choose what to keep. No write has been retried.');
    setSaveMessage('Authority changed. Local edits are retained and Save is paused for your decision.');
  }
  useEffect(()=>{
    mounted.current=true;
    let live=true;readBusy.current=true;
    void (async()=>{
      try{
        const a=await readAuthority(observeCapability);
        if(!live)return;
        checkedIdentity(a);
        originalDraftId.current=a.draft.draft_id;
        observeAuthority(a);rememberBasis(a);
        if(localRef.current===null)replaceLocal(a.draft);
        setStoreError('');
        setSaveMessage(a.canWrite?'Existing draft loaded. Only an explicit Save can persist local allocations.':'Read-only draft loaded. Local planning is available; Save is refused.');
      }catch(e:any){if(live){setStoreError(e?.message||'Draft read failed.');reconcile(true);setSaveMessage('Draft availability and permission are unverified. Save is unavailable.');}}
      finally{if(live){readBusy.current=false;setReading(false);}}
    })();
    return()=>{live=false;mounted.current=false;};
  },[]);

  const validation = draft ? planErrors(source,draft) : [];
  const stagedErrors:Record<string,string> = {};
  if(draft)for(const a of draft.allocations){
    const text=lineInputs[a.allocation_id] ?? String(a.minutes);
    const n=parseQuantity(text);
    if(n===null)stagedErrors[a.allocation_id]='Minutes must be a positive whole number divisible by 15; the entered value has not been applied.';
    else if(n!==a.minutes){
      const candidate={...draft,allocations:draft.allocations.map(v=>v.allocation_id===a.allocation_id?{...v,minutes:n}:v)};
      stagedErrors[a.allocation_id]=planErrors(source,candidate).join(' ') || 'This quantity has not been applied.';
    }
  }
  const hasStagedInput=!!draft&&draft.allocations.some(a=>parseQuantity(lineInputs[a.allocation_id]??String(a.minutes))!==a.minutes);
  const dirty=!!draft&&(!basis||!equalDraft(draft,basis.draft)||hasStagedInput);
  const validRevision=!!basis&&revisionOK(basis.revision);
  const saveDisabled=!draft||!basis||!basis.canWrite||readOnly||!validRevision||pending||reading||refreshing||needsDecision||reconcileRequired||pathDenied||identityDenied||validation.length>0||Object.keys(stagedErrors).length>0||!!addError||!dirty;
  const selectedWork=source.work_items.find(w=>w.work_item_id===work);
  const selectedResource=source.resources.find(r=>r.resource_id===resource);
  const selectedRoster=source.roster.find(r=>r.resource_id===resource&&r.date===date);
  const plannedDay=(id:string,d:string)=>draft?.allocations.filter(a=>a.resource_id===id&&a.date===d).reduce((sum,a)=>sum+a.minutes,0)||0;
  const plannedWork=(id:string)=>draft?.allocations.filter(a=>a.work_item_id===id).reduce((sum,a)=>sum+a.minutes,0)||0;

  function addAllocation(e:React.FormEvent) {
    e.preventDefault();
    const current=localRef.current;
    if(!current){setAddError('Read the existing draft before adding a local allocation.');return;}
    const n=parseQuantity(minutes);
    if(n===null){setAddError('Minutes must be positive finite whole numbers divisible by 15. The allocation was not added.');return;}
    let id:string;
    do{id='local-allocation-'+nextLine.current++;}while(current.allocations.some(a=>a.allocation_id===id));
    const next:Draft={draft_id:current.draft_id,allocations:[...current.allocations,{allocation_id:id,work_item_id:work,resource_id:resource,date,minutes:n}]};
    const errors=planErrors(source,next);
    if(errors.length){setAddError(errors.join(' ')+' The allocation was not added.');return;}
    updateLocal(next);
    const inputs={...lineInputsRef.current,[id]:String(n)};lineInputsRef.current=inputs;setLineInputs(inputs);
    setAddError('');
  }
  function editQuantity(id:string,text:string) {
    const inputs={...lineInputsRef.current,[id]:text};lineInputsRef.current=inputs;setLineInputs(inputs);
    const current=localRef.current;const n=parseQuantity(text);
    if(!current||n===null)return;
    const next:Draft={...current,allocations:current.allocations.map(a=>a.allocation_id===id?{...a,minutes:n}:a)};
    if(planErrors(source,next).length===0)updateLocal(next);
  }
  function removeAllocation(id:string) {
    const current=localRef.current;if(!current)return;
    updateLocal({...current,allocations:current.allocations.filter(a=>a.allocation_id!==id)});
    const inputs={...lineInputsRef.current};delete inputs[id];lineInputsRef.current=inputs;setLineInputs(inputs);
    setAddError('');
  }
  async function reviewAuthority() {
    if(readBusy.current||saveBusy.current)return;
    readBusy.current=true;setReading(true);
    try{
      const a=await readAuthority(observeCapability);if(!mounted.current)return;
      if(localRef.current===null){
        originalDraftId.current=a.draft.draft_id;observeAuthority(a);rememberBasis(a);replaceLocal(a.draft);reconcile(false);setStoreError('');setSaveMessage('Existing draft loaded from its file; no draft has been written.');
      }else reconcileRead(a,lastOutcome.current==='conflict');
    }catch(e:any){if(mounted.current){setStoreError(e?.message||'Current authority could not be read.');reconcile(true);setSaveMessage('Authority could not be verified. Local edits remain intact; Save is paused until a successful file re-read.');}}
    finally{readBusy.current=false;if(mounted.current)setReading(false);}
  }
  function reapply() {
    const a=reviewedRef.current;
    if(!a||saveBusy.current||readBusy.current||reconcileRef.current||identityDeniedRef.current)return;
    try{checkedIdentity(a);}catch(e:any){setStoreError(e.message);return;}
    rememberBasis(a);decision(false);reconcile(false);setStoreError('');lastOutcome.current='none';lastSubmission.current=null;setReceipt(null);
    setSaveMessage('The entire local draft is retained against reviewed revision '+String(a.revision)+'. It has not been saved. A later explicit Save replaces that reviewed stored allocation snapshot, if permitted.');
  }
  function discard() {
    if(saveBusy.current||readBusy.current||reconcileRef.current||identityDeniedRef.current)return;
    const a=reviewedRef.current||basisRef.current;if(!a)return;
    try{checkedIdentity(a);}catch(e:any){setStoreError(e.message);return;}
    replaceLocal(a.draft);rememberBasis(a);decision(false);reconcile(false);setStoreError('');setAddError('');setReceipt(null);lastOutcome.current='none';lastSubmission.current=null;
    setSaveMessage('Local edits explicitly discarded. The local plan now matches the reviewed stored draft at revision '+String(a.revision)+'. No write was performed.');
  }
  async function save() {
    if(saveBusy.current||readBusy.current)return;
    const current=localRef.current;const base=basisRef.current;
    if(!current||!base){setStoreError('The existing draft file and its metadata must be verified before Save.');return;}
    if(readOnlyRef.current||!base.canWrite){setStoreError('Read-only capability: Save is refused. Your local draft is preserved.');return;}
    if(!revisionOK(base.revision)||decisionRef.current||reconcileRef.current||pathDeniedRef.current||identityDeniedRef.current){setStoreError('Save requires a verified permitted revision and resolution of the current review or read blocker.');return;}
    const rawInvalid=current.allocations.some(a=>parseQuantity(lineInputsRef.current[a.allocation_id]??String(a.minutes))!==a.minutes);
    const errors=planErrors(source,current);
    if(rawInvalid||errors.length||addError){setStoreError(errors.join(' ')||'Correct or remove the invalid local input before Save.');return;}
    if(equalDraft(current,base.draft)){setSaveMessage('There are no unsaved draft changes. No write was performed.');return;}
    const submitted=copyDraft(current);const expected=base.revision;
    saveBusy.current=true;setPending(true);setStoreError('');setReceipt(null);
    lastSubmission.current=submitted;lastExpectedRevision.current=null;lastOutcome.current='none';
    setSaveMessage('Saving the submitted draft snapshot. You may continue editing; additional edits will remain unsaved.');
    try{
      const result=await writeFile('./draft.json',JSON.stringify(submitted,null,2)+'\n',{revision:expected,contentType:'application/json'});
      if(!mounted.current)return;
      if(result && result.success===true){
        lastOutcome.current='success';
        if(revisionOK(result.revision)&&result.revision!==expected)lastExpectedRevision.current=result.revision;
        else setStoreError('Save returned an unverified acknowledgement revision. File contents must be reconciled before any further Save.');
        reconcile(true);
        setSaveMessage('Save acknowledged for the submitted snapshot; verifying the actual stored draft.');
        try{
          const a=await readAuthority(observeCapability);if(!mounted.current)return;
          reconcileRead(a,false);
          if(!lastExpectedRevision.current) setStoreError('The acknowledgement revision was not verified. The file was re-read; no operational booking is claimed.');
          else if(!equalDraft(a.draft,submitted)||a.revision!==lastExpectedRevision.current) setStoreError('The latest file does not match the acknowledged snapshot and revision. Local edits are preserved; review current authority before deciding what to save.');
        }catch(e:any){if(mounted.current){setStoreError(e?.message||'Save verification read failed.');reconcile(true);setSaveMessage('The submitted Save was acknowledged but file verification is unavailable. Local edits remain intact; re-read the draft before a further Save.');}}
      }else{
        const failure=result && result.success===false?result.error:null;
        const code=failure?.code||'save_failed';
        lastOutcome.current=code==='conflict'?'conflict':code==='read_only'?'read_only':code==='invalid_path'?'invalid_path':'save_failed';
        setStoreError((failure?.message||'Save did not return a confirmed outcome.')+' Local edits are preserved.');
        reconcile(true);
        if(code==='read_only') {readOnlyRef.current=true;setReadOnly(true);setSaveMessage('Read-only rejection. Save is refused for this session; no alternative write path is used.');}
        else if(code==='invalid_path'){pathDeniedRef.current=true;setPathDenied(true);setSaveMessage('This draft write was refused. No substitute path or replacement file will be used.');}
        else if(code==='conflict'){decision(true);setSaveMessage('Revision conflict. Your local edits have not been overwritten. Reading current authority for a separate review.');}
        else setSaveMessage('Save failed with an unconfirmed outcome. Reading the actual file before any explicit retry.');
        try{
          const a=await readAuthority(observeCapability);if(!mounted.current)return;
          reconcileRead(a,code==='conflict');
          if(code==='read_only')setSaveMessage('Read-only rejection respected. Current authority was re-read; local allocations are preserved and Save remains refused.');
          if(code==='invalid_path')setSaveMessage('Write path refusal respected. Current authority was re-read; local allocations are preserved and no further write is permitted here.');
        }catch(e:any){if(mounted.current){setStoreError((failure?.message||'Save outcome is unconfirmed.')+' '+(e?.message||'Authority read failed.')+' Local edits are preserved.');setSaveMessage('Save is paused. Re-read current authority to reconcile the outcome; no write will be retried automatically.');}}
      }
    }catch(e:any){
      if(mounted.current){
        lastOutcome.current='save_failed';reconcile(true);setStoreError((e?.message||'Temporary Save failure.')+' The write outcome is unconfirmed. Local edits are preserved.');setSaveMessage('Save outcome is unconfirmed; reading the actual draft file before another explicit Save.');
        try{const a=await readAuthority(observeCapability);if(mounted.current)reconcileRead(a,false);}catch(readError:any){if(mounted.current){setStoreError((readError?.message||'Authority reconciliation read failed.')+' Save remains paused and local edits are preserved.');}}
      }
    }finally{saveBusy.current=false;if(mounted.current)setPending(false);}
  }

  return <section aria-label="Tentative allocation plan" style={{marginTop:28,paddingTop:12,borderTop:'2px solid #c9d6e2'}}>
    <h2>Tentative allocation plan</h2>
    <p>Draft allocations are separate from committed work. Saving this synthetic draft does not book resources or change committed minutes.</p>
    {draft?<p>Draft ID: <strong>{draft.draft_id}</strong></p>:<p role="status">{reading?'Loading the existing draft':'Existing draft unavailable; no local replacement has been created.'}</p>}
    <form onSubmit={addAllocation} noValidate style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label>Work item <select data-eval="plan-work-item" value={work} onChange={e=>{setWork(e.target.value);setAddError('');}}>{source.work_items.map(w=><option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.team_id} · {w.required_skill}</option>)}</select></label>
      <label>Resource <select data-eval="plan-resource" value={resource} onChange={e=>{setResource(e.target.value);setAddError('');}}>{source.resources.map(r=><option key={r.resource_id} value={r.resource_id}>{r.display_name} ({r.resource_id}) · {r.team_id} · {r.skills.join(', ')||'no skills'}</option>)}</select></label>
      <label>Plan date <select data-eval="plan-date" value={date} onChange={e=>{setDate(e.target.value);setAddError('');}}>{dates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
      <label>Minutes <input data-eval="plan-minutes" type="number" min="15" step="15" value={minutes} onChange={e=>{setMinutes(e.target.value);setAddError('');}} style={{width:100}}/></label>
      <button data-eval="plan-add" type="submit" disabled={!draft}>Add allocation</button>
    </form>
    <p style={{fontSize:14,color:'#46546a'}}>Work {selectedWork?selectedWork.work_item_id+' requires '+selectedWork.required_skill+' in team '+selectedWork.team_id+', from '+selectedWork.earliest_date+' through '+selectedWork.due_date+', inclusive.':'must be selected.'} {selectedResource?'Selected resource skills: '+(selectedResource.skills.join(', ')||'none')+'. ':''}{selectedRoster?'Unallocated tentative capacity on '+date+': '+(selectedRoster.available_minutes-selectedRoster.committed_minutes-plannedDay(resource,date))+' minutes.':'No roster capacity for that resource/date.'}</p>
    <div data-eval="draft-error" role="alert" aria-live="polite">
      {addError&&<p>{addError}</p>}
      {storeError&&<p>{storeError}</p>}
      {validation.length>0&&<ul>{validation.map((v,i)=><li key={i}>{v}</li>)}</ul>}
      {Object.entries(stagedErrors).map(([id,message])=><p key={id}>Allocation {id}: {message} The last valid quantity remains in the previews.</p>)}
    </div>
    {draft&&<>
      <table data-eval="draft-table" style={{width:'100%',marginTop:16}}><caption style={{textAlign:'left'}}>Local draft allocations (tentative minutes)</caption><thead><tr>{['Allocation ID','Work item','Resource','Date','Minutes','Action'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>
        {draft.allocations.map(a=><tr key={a.allocation_id} data-eval="draft-row" data-eval-key={a.allocation_id}>
          <td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td>
          <td><input aria-label={'Minutes for allocation '+a.allocation_id} data-eval="draft-line-minutes" data-eval-key={a.allocation_id} type="number" min="15" step="15" value={lineInputs[a.allocation_id]??String(a.minutes)} onChange={e=>editQuantity(a.allocation_id,e.target.value)} aria-invalid={!!stagedErrors[a.allocation_id]} style={{width:90}}/>{stagedErrors[a.allocation_id]&&<span> ({a.minutes} minutes applied)</span>}</td>
          <td><button data-eval="draft-line-remove" data-eval-key={a.allocation_id} onClick={()=>removeAllocation(a.allocation_id)}>Remove allocation</button></td>
        </tr>)}
      </tbody></table>
      {draft.allocations.length===0&&<p>No tentative allocations in this local draft.</p>}
      <h3>Capacity after the local tentative plan</h3>
      <p>Residual committed capacity equals available minus committed minutes. Tentative minutes are subtracted only in this preview.</p>
      <table style={{width:'100%'}}><thead><tr>{['Resource','Date','Residual committed minutes','Tentative planned minutes','Capacity after plan (minutes)'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>
        {source.roster.map(r=>{const key=r.resource_id+'|'+r.date;const planned=plannedDay(r.resource_id,r.date);const residual=r.available_minutes-r.committed_minutes;return <tr key={key} data-eval="draft-capacity" data-eval-key={key}><td>{r.resource_id}</td><td>{r.date}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{residual}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{residual-planned}</td></tr>;})}
      </tbody></table>
      <h3>Remaining work after the local tentative plan</h3>
      <table style={{width:'100%'}}><thead><tr>{['Work item','Team / required skill','Eligible dates (inclusive)','Source remaining minutes','Tentative planned minutes','Remaining after plan (minutes)'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>
        {source.work_items.map(w=>{const planned=plannedWork(w.work_item_id);return <tr key={w.work_item_id} data-eval="draft-work" data-eval-key={w.work_item_id}><td>{w.work_item_id}</td><td>{w.team_id} / {w.required_skill}</td><td>{w.earliest_date} through {w.due_date}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{w.remaining_minutes}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{w.remaining_minutes-planned}</td></tr>;})}
      </tbody></table>
    </>}
    <p data-eval="draft-dirty-state" aria-live="polite">{!draft?'Draft not loaded.':dirty?'Unsaved local draft changes.':'No unsaved draft changes; local plan matches the verified stored draft.'}{hasStagedInput?' Invalid or unapplied input is also retained locally.':''}</p>
    <div data-eval="draft-save-state" role="status" aria-live="polite"><p>{pending?'Save pending. ':''}{saveMessage}</p>{receipt&&<p>{receipt.confirmed?'Confirmed submitted snapshot':'Snapshot observed by file re-read'}: {receipt.snapshot.allocations.length} allocations, {receipt.snapshot.allocations.reduce((s,a)=>s+a.minutes,0)} tentative minutes, revision {receipt.revision}. {draft&&equalDraft(draft,receipt.snapshot)&&!hasStagedInput?'Local plan matches that stored snapshot.':'Newer local edits remain unsaved and were not included in that submitted snapshot.'}</p>}</div>
    <p>{readOnly||basis?.canWrite===false?'Verified read-only capability. Save is refused; local editing remains available.':!basis?'Draft write permission is unverified.':!validRevision?'The draft revision is unavailable or invalid. Save is disabled.':'Verified draft write capability; editing baseline revision '+basis.revision+'.'} {needsDecision?'Authority review requires an explicit decision.':''} {reconcileRequired?'A file re-read is required before Save.':''}</p>
    <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
      <button data-eval="draft-save" disabled={saveDisabled} onClick={()=>{void save();}}>{pending?'Saving draft…':'Save draft'}</button>
      <button data-eval="conflict-review" disabled={pending||reading} onClick={()=>{void reviewAuthority();}}>{reading?'Reading stored draft…':'Review current stored draft'}</button>
      {needsDecision&&<button data-eval="draft-reapply" disabled={!reviewed||pending||reading||reconcileRequired||identityDenied||reviewed.draft.draft_id!==originalDraftId.current} onClick={reapply}>Reapply entire local draft (do not save)</button>}
      <button data-eval="draft-discard" disabled={pending||reading||reconcileRequired||identityDenied||(!reviewed&&!basis)||(needsDecision&&!reviewed)} onClick={discard}>Discard local edits and use reviewed stored draft</button>
    </div>
    {reviewed&&<aside data-eval="authority-review" aria-label="Authoritative draft review" style={{marginTop:18,padding:14,border:'1px solid #b2c0ce',background:'#f4f7fb'}}>
      <h3>Last verified stored draft, separate from local edits</h3>
      <p>Draft ID {reviewed.draft.draft_id}; revision {reviewed.revision??'unavailable'}; file capability {reviewed.canWrite?'writable':'read-only'}. Reviewing this snapshot does not replace local allocations or save them.</p>
      {needsDecision&&<p>Reapply keeps the entire local draft. A later explicit Save would replace this reviewed stored allocation snapshot, including rows that exist only in the stored draft. Discard instead loads this reviewed snapshot without writing.</p>}
      <table style={{width:'100%'}}><thead><tr>{['Allocation ID','Work item','Resource','Date','Stored tentative minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{reviewed.draft.allocations.map(a=><tr key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td>{a.minutes}</td></tr>)}</tbody></table>
      {reviewed.draft.allocations.length===0&&<p>The reviewed stored draft has no allocations.</p>}
    </aside>}
  </section>;
}

export default function ExistingResourceFrame() {
  const [source,setSource]=useState<Source|null>(null),[error,setError]=useState('');
  const [refreshing,setRefreshing]=useState(false);
  const refreshBusy=useRef(false);
  const resourceReadEpoch=useRef(0);
  useEffect(()=>{let live=true;const epoch=++resourceReadEpoch.current;(async()=>{try{const entry=await readFile('./resources.json');if(!entry)throw new Error('Resource source is unavailable.');const data=parseSource(JSON.parse(await entry.file.text()));if(live&&epoch===resourceReadEpoch.current)setSource(data);}catch(e:any){if(live&&epoch===resourceReadEpoch.current)setError(e?.message||'Resource source is unavailable.');}})();return()=>{live=false;};},[]);
  async function refresh(){
    if(refreshBusy.current)return;
    refreshBusy.current=true;const epoch=++resourceReadEpoch.current;setRefreshing(true);setError('');
    try{const value=await callFunction('load-data',{});const verified=parseSource(value);if(epoch===resourceReadEpoch.current)setSource(verified);}
    catch(e:any){setError((e?.message||'Resource refresh failed.')+(source?' The last verified resource snapshot remains displayed.':''));}
    finally{refreshBusy.current=false;setRefreshing(false);}
  }
  return <main data-eval="planner-root" style={{fontFamily:'sans-serif',maxWidth:1200,margin:'auto',padding:20,color:'#172a3a'}}>
    <style>{`button,input,select{font:inherit}button{padding:7px 11px;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.6}input,select{padding:5px;border:1px solid #869bad;border-radius:4px}label{display:flex;flex-direction:column;gap:5px;font-size:14px}table{border-collapse:collapse}th,td{padding:9px 7px;border-bottom:1px solid #dce4ed;vertical-align:top}th{font-size:13px;background:#eef3f8}tr[data-eval="resource-row"]{cursor:pointer}tr[data-eval="resource-row"]:hover{background:#eef5fc}:focus-visible{outline:3px solid #276baf;outline-offset:2px}[role="alert"]{color:#9d2525}section{overflow-x:auto}h2{font-size:22px}h3{font-size:17px}`}</style>
    <h1>Resource planning</h1>
    <p>Synthetic capacity planning · controlled draft file only</p>
    {source&&<p style={{fontSize:13}}>Verified resource snapshot: {source.snapshot_revision}. {refreshing?'Refreshing; previous snapshot shown until a validated response arrives.':''}</p>}
    {error&&<p role="alert">{error}</p>}
    {source?<><ResourceView source={source}/><div style={{marginTop:16}}><button data-eval="refresh-resources" disabled={refreshing} onClick={()=>{void refresh();}}>{refreshing?'Refreshing resource source…':'Refresh resource source'}</button></div><AllocationPlanner source={source} refreshing={refreshing}/></>:!error?<p role="status">Loading resources</p>:<button data-eval="refresh-resources" disabled={refreshing} onClick={()=>{void refresh();}}>Retry resource source</button>}
  </main>;
}
