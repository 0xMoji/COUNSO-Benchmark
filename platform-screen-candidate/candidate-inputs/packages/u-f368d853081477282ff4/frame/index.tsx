import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, writeFile, callFunction, triggerUserFileDownload } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Resource = { resource_id: string; display_name: string; team_id: string; skills: string[] };
type RosterDay = { resource_id: string; date: string; available_minutes: number; committed_minutes: number };
type WorkItem = { work_item_id: string; team_id: string; required_skill: string; remaining_minutes: number; earliest_date: string; due_date: string };
type Source = { schema_version: 'resource-plan-1'; snapshot_revision: string; default_date: string; teams: Team[]; resources: Resource[]; roster: RosterDay[]; work_items: WorkItem[] };
type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number };
type Draft = { draft_id: string; allocations: Allocation[] };
type LocalLine = Omit<Allocation, 'minutes'> & { minutes: string };
type LocalDraft = { draft_id: string; allocations: LocalLine[] };
type Authority = { draft: Draft; revision: string | null; canWrite: boolean };
type Attempt = { submitted: Draft; previous: Draft; previousRevision: string; outcome: 'pending' | 'success' | 'uncertain'; acknowledgedRevision?: string };
type EditorFields = { work_item_id: string; resource_id: string; date: string; minutes: string };

const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const key = (x: unknown): x is string => text(x) && x.length > 0;
const nonnegativeInteger = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const exactKeys = (x: Record<string, any>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(x, k));
function calendarDate(x: unknown): x is string {
  if (!text(x) || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const stamp = new Date(x + 'T00:00:00Z');
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === x;
}
function unique(values: string[]) { return new Set(values).size === values.length; }
function validateSource(data: unknown): Source {
  if (!object(data) || !exactKeys(data, ['schema_version','snapshot_revision','default_date','teams','resources','roster','work_items']) || data.schema_version !== 'resource-plan-1' || !key(data.snapshot_revision) || !calendarDate(data.default_date) || !Array.isArray(data.teams) || !Array.isArray(data.resources) || !Array.isArray(data.roster) || !Array.isArray(data.work_items)) throw new Error('Resource source has an unsupported or incomplete schema.');
  if (!data.teams.every((t: unknown) => object(t) && exactKeys(t, ['team_id','display_name']) && key(t.team_id) && text(t.display_name)) || !unique(data.teams.map((t: Team) => t.team_id))) throw new Error('Resource source has invalid or duplicate team identities.');
  const teams = new Set(data.teams.map((t: Team) => t.team_id));
  if (!data.resources.every((r: unknown) => object(r) && exactKeys(r, ['resource_id','display_name','team_id','skills']) && key(r.resource_id) && text(r.display_name) && teams.has(r.team_id) && Array.isArray(r.skills) && r.skills.every((s: unknown) => s === 'EMAIL' || s === 'CHAT') && unique(r.skills)) || !unique(data.resources.map((r: Resource) => r.resource_id))) throw new Error('Resource source has invalid resources or skills.');
  const resources = new Set(data.resources.map((r: Resource) => r.resource_id));
  if (!data.roster.every((r: unknown) => object(r) && exactKeys(r, ['resource_id','date','available_minutes','committed_minutes']) && resources.has(r.resource_id) && calendarDate(r.date) && nonnegativeInteger(r.available_minutes) && nonnegativeInteger(r.committed_minutes)) || !unique(data.roster.map((r: RosterDay) => JSON.stringify([r.resource_id, r.date])))) throw new Error('Resource source has invalid resource/day capacity facts.');
  if (!data.work_items.every((w: unknown) => object(w) && exactKeys(w, ['work_item_id','team_id','required_skill','remaining_minutes','earliest_date','due_date']) && key(w.work_item_id) && teams.has(w.team_id) && (w.required_skill === 'EMAIL' || w.required_skill === 'CHAT') && nonnegativeInteger(w.remaining_minutes) && calendarDate(w.earliest_date) && calendarDate(w.due_date)) || !unique(data.work_items.map((w: WorkItem) => w.work_item_id))) throw new Error('Resource source has invalid work items.');
  return data as Source;
}
function validateDraftShape(data: unknown): Draft {
  if (!object(data) || !exactKeys(data, ['draft_id','allocations']) || !key(data.draft_id) || !Array.isArray(data.allocations)) throw new Error('Stored draft has an unsupported or incomplete schema. Local edits have not been replaced.');
  if (!data.allocations.every((a: unknown) => object(a) && exactKeys(a, ['allocation_id','work_item_id','resource_id','date','minutes']) && key(a.allocation_id) && key(a.work_item_id) && key(a.resource_id) && calendarDate(a.date) && typeof a.minutes === 'number' && Number.isSafeInteger(a.minutes) && a.minutes > 0 && a.minutes % 15 === 0) || !unique(data.allocations.map((a: Allocation) => a.allocation_id))) throw new Error('Stored draft has invalid quantities or allocation identities. Local edits have not been replaced.');
  return data as Draft;
}
async function readAuthority(): Promise<Authority> {
  const entry = await readFile('./draft.json');
  if (!entry) throw new Error('The existing draft file could not be read. Its availability and permissions are unconfirmed; no replacement file will be created.');
  if (typeof entry.canWrite !== 'boolean' || !(entry.revision === null || key(entry.revision))) throw new Error('Draft revision or write capability could not be verified.');
  return { draft: validateDraftShape(JSON.parse(await entry.file.text())), revision: entry.revision, canWrite: entry.canWrite };
}
function toLocal(draft: Draft): LocalDraft { return { draft_id: draft.draft_id, allocations: draft.allocations.map(a => ({ ...a, minutes: String(a.minutes) })) }; }
function toDraft(local: LocalDraft): Draft { return { draft_id: local.draft_id, allocations: local.allocations.map(a => ({ ...a, minutes: Number(a.minutes) })) }; }
function fingerprint(draft: Draft | LocalDraft): string {
  return JSON.stringify({ draft_id: draft.draft_id, allocations: [...draft.allocations].sort((a, b) => a.allocation_id < b.allocation_id ? -1 : a.allocation_id > b.allocation_id ? 1 : 0).map(a => ({ allocation_id: a.allocation_id, work_item_id: a.work_item_id, resource_id: a.resource_id, date: a.date, minutes: typeof a.minutes === 'string' && a.minutes.trim() === '' ? '' : Number.isFinite(Number(a.minutes)) ? Number(a.minutes) : a.minutes })) });
}
function validQuantity(value: string) {
  const n = Number(value);
  return value.trim() !== '' && Number.isSafeInteger(n) && n > 0 && n % 15 === 0;
}
function previewMinutes(value: string) { const n = Number(value); return value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 0; }
function validatePlan(source: Source, local: LocalDraft): string[] {
  const errors: string[] = [];
  const dayTotals = new Map<string, number>();
  const workTotals = new Map<string, number>();
  const ids = new Set<string>();
  for (const line of local.allocations) {
    const label = line.allocation_id;
    if (!key(line.allocation_id) || ids.has(line.allocation_id)) errors.push(`${label || 'Allocation'}: allocation identity must be unique.`);
    ids.add(line.allocation_id);
    const resource = source.resources.find(r => r.resource_id === line.resource_id);
    const work = source.work_items.find(w => w.work_item_id === line.work_item_id);
    const roster = source.roster.find(r => r.resource_id === line.resource_id && r.date === line.date);
    if (!validQuantity(line.minutes)) errors.push(`${label}: minutes must be a positive whole number in 15-minute increments; no rounding is applied.`);
    if (!resource) errors.push(`${label}: choose an existing source resource.`);
    if (!work) errors.push(`${label}: choose an existing source work item.`);
    if (!calendarDate(line.date) || !roster) errors.push(`${label}: this resource has no roster capacity for ${line.date || 'the chosen date'}.`);
    if (resource && work) {
      if (resource.team_id !== work.team_id) errors.push(`${label}: resource team ${resource.team_id} does not match work team ${work.team_id}.`);
      if (!resource.skills.includes(work.required_skill)) errors.push(`${label}: resource ${resource.resource_id} lacks required skill ${work.required_skill}.`);
    }
    if (work && (line.date < work.earliest_date || line.date > work.due_date)) errors.push(`${label}: date must be within ${work.earliest_date} through ${work.due_date}, inclusive.`);
    const n = previewMinutes(line.minutes);
    const dayKey = JSON.stringify([line.resource_id, line.date]);
    dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + n);
    workTotals.set(line.work_item_id, (workTotals.get(line.work_item_id) || 0) + n);
  }
  source.roster.forEach(day => {
    const planned = dayTotals.get(JSON.stringify([day.resource_id, day.date])) || 0;
    const residual = day.available_minutes - day.committed_minutes;
    if (planned > residual && planned > 0) errors.push(`${day.resource_id} on ${day.date}: planned ${planned} minutes exceeds residual committed capacity of ${residual} minutes.`);
  });
  source.work_items.forEach(work => {
    const planned = workTotals.get(work.work_item_id) || 0;
    if (planned > work.remaining_minutes) errors.push(`${work.work_item_id}: planned ${planned} minutes exceeds remaining work effort of ${work.remaining_minutes} minutes.`);
  });
  return errors;
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : 'The controlled draft operation could not be confirmed.'; }

function ResourceView({source}:{source:any}) {
  const [team,setTeam]=useState(''),[date,setDate]=useState(source.default_date),[search,setSearch]=useState(''),[sort,setSort]=useState('resource_id_asc'),[details,setDetails]=useState(''),[downloadError,setDownloadError]=useState('');
  const rowsById=useRef<Record<string,HTMLTableRowElement|null>>({});const closeButton=useRef<HTMLButtonElement|null>(null);
  const dates:Array<string>=Array.from(new Set<string>(source.roster.map((r:any)=>r.date)));
  const rows=source.roster.filter((r:any)=>r.date===date).map((r:any)=>({...r,...source.resources.find((v:any)=>v.resource_id===r.resource_id)})).filter((r:any)=>(!team||r.team_id===team)&&(!search||(r.resource_id+' '+r.display_name).toLowerCase().includes(search.toLowerCase()))).sort((a:any,b:any)=>(a.resource_id<b.resource_id?-1:a.resource_id>b.resource_id?1:0)*(sort==='resource_id_asc'?1:-1));
  const selected=source.resources.find((r:any)=>r.resource_id===details);
  useEffect(()=>{if(details)closeButton.current?.focus();},[details]);
  function close(){const old=details;setDetails('');rowsById.current[old]?.focus();}
  function csv(){const columns=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];const quote=(v:any)=>'"'+String(v).replaceAll('"','""')+'"';const text=[columns.join(','),...rows.map((r:any)=>columns.map(k=>quote(k==='residual_minutes'?r.available_minutes-r.committed_minutes:r[k])).join(','))].join('\r\n')+'\r\n';setDownloadError('');void triggerUserFileDownload({content:new Blob([text],{type:'text/csv;charset=utf-8'}),filename:'capacity.csv'}).catch((e:unknown)=>setDownloadError(messageOf(e)));}
  return <section aria-label="Existing capacity view"><h2>Resource capacity</h2><div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e=>setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map((t:any)=><option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
    <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e=>setDate(e.target.value)}>{dates.map(d=><option key={d} value={d}>{d}</option>)}</select></label>
    <label>Search <input data-eval="legacy-search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <label>Order <select data-eval="legacy-sort" value={sort} onChange={e=>setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
    <button data-eval="legacy-reset" onClick={()=>{setTeam('');setDate(source.default_date);setSearch('');setSort('resource_id_asc');}}>Reset view</button><button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
  </div>
  <table data-eval="resource-table" style={{width:'100%',marginTop:16}}><thead><tr>{['Resource ID','Name','Team','Date','Available minutes','Committed minutes','Residual minutes'].map(h=><th key={h} style={{textAlign:'left'}}>{h}</th>)}</tr></thead><tbody>{rows.map((r:any)=><tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el=>{rowsById.current[r.resource_id]=el;}} onClick={()=>setDetails(r.resource_id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setDetails(r.resource_id);}}}><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id">{r.resource_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes-r.committed_minutes}</td></tr>)}</tbody></table>
  {downloadError&&<p role="alert">Capacity CSV download failed: {downloadError}</p>}
  {rows.length===0&&<p>No matching resource/day rows.</p>}
  {selected&&<aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}}} style={{padding:14,border:'1px solid #789'}}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

function PlanEditor({ source, sourceRefreshing, onBusyChange }: { source: Source; sourceRefreshing: boolean; onBusyChange: (busy: boolean) => void }) {
  const [local, setLocalState] = useState<LocalDraft | null>(null);
  const localRef = useRef<LocalDraft | null>(null);
  const editVersion = useRef(0);
  const [baseline, setBaselineState] = useState<Authority | null>(null);
  const baselineRef = useRef<Authority | null>(null);
  const [latest, setLatest] = useState<Authority | null>(null);
  const [capability, setCapabilityState] = useState<boolean | null>(null);
  const capabilityRef = useRef<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const [status, setStatus] = useState('');
  const [storeError, setStoreError] = useState('');
  const [resolution, setResolutionState] = useState<'none' | 'review' | 'uncertain' | 'blocked'>('none');
  const resolutionRef = useRef<'none' | 'review' | 'uncertain' | 'blocked'>('none');
  const [reviewed, setReviewed] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const [receipt, setReceipt] = useState<Attempt | null>(null);
  const [submittedSnapshot, setSubmittedSnapshot] = useState<Draft | null>(null);
  const initializationSequence = useRef(0);
  const [editor, setEditor] = useState<EditorFields>(() => ({ work_item_id: source.work_items[0]?.work_item_id || '', resource_id: source.resources[0]?.resource_id || '', date: source.default_date, minutes: '15' }));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const newIdCounter = useRef(0);
  const live = useRef(true);

  function setLocal(value: LocalDraft) { localRef.current = value; editVersion.current++; setLocalState(value); }
  function setBaseline(value: Authority) { baselineRef.current = value; setBaselineState(value); }
  function setCapability(value: boolean | null) { capabilityRef.current = value; setCapabilityState(value); }
  function setResolution(value: 'none' | 'review' | 'uncertain' | 'blocked') { resolutionRef.current = value; setResolutionState(value); }
  function setBusy(value: boolean) { busyRef.current = value; setBusyState(value); onBusyChange(value); }
  function assertIdentity(authority: Authority) {
    if (localRef.current && authority.draft.draft_id !== localRef.current.draft_id) throw new Error('The stored draft identity changed. Local edits are preserved; saving a different draft is not authorized.');
  }
  async function initialize() {
    if (busyRef.current) return;
    const sequence = ++initializationSequence.current;
    setLoading(true); setLoadError('');
    try {
      const authority = await readAuthority();
      if (!live.current || sequence !== initializationSequence.current) return;
      setBaseline(authority); setLatest(authority); setCapability(authority.canWrite);
      setLocal(toLocal(authority.draft));
      setStatus('Loaded the existing stored draft. Changes here remain tentative until an explicit permitted Save.');
    } catch (e) { if (live.current && sequence === initializationSequence.current) { setCapability(null); setLoadError(messageOf(e)); } }
    finally { if (live.current && sequence === initializationSequence.current) setLoading(false); }
  }
  useEffect(() => { live.current = true; void initialize(); return () => { live.current = false; }; }, []);

  const validationErrors = useMemo(() => local ? validatePlan(source, local) : [], [source, local]);
  const dirty = !!local && !!baseline && fingerprint(local) !== fingerprint(baseline.draft);
  const dates = Array.from(new Set(source.roster.map(r => r.date))).sort();
  const selectedWork = source.work_items.find(w => w.work_item_id === editor.work_item_id);
  const selectedResource = source.resources.find(r => r.resource_id === editor.resource_id);
  const saveEnabled = !!local && !!baseline && dirty && !busy && !sourceRefreshing && capability === true && key(baseline.revision) && resolution === 'none' && validationErrors.length === 0 && formErrors.length === 0;

  function changeField(field: keyof EditorFields, value: string) {
    setEditor(previous => ({ ...previous, [field]: value }));
    setFormErrors([]);
  }
  function nextAllocationId(draft: LocalDraft) {
    let id: string;
    do { newIdCounter.current++; id = `LOCAL-${newIdCounter.current}`; } while (draft.allocations.some(a => a.allocation_id === id) || latest?.draft.allocations.some(a => a.allocation_id === id));
    return id;
  }
  function applyAllocation() {
    const current = localRef.current;
    if (!current) return;
    const id = editingId || nextAllocationId(current);
    const line: LocalLine = { allocation_id: id, ...editor };
    const candidate = { ...current, allocations: editingId ? current.allocations.map(a => a.allocation_id === editingId ? line : a) : [...current.allocations, line] };
    const errors = validatePlan(source, candidate);
    if (errors.length) { setFormErrors(errors); return; }
    setLocal(candidate); setEditingId(null); setFormErrors([]);
    setStatus(editingId ? `Updated local allocation ${id}. It has not been saved.` : `Added local allocation ${id}. It has not been saved.`);
    setEditor(previous => ({ ...previous, minutes: '15' }));
  }
  function editLine(line: LocalLine) {
    setEditingId(line.allocation_id);
    setEditor({ work_item_id: line.work_item_id, resource_id: line.resource_id, date: line.date, minutes: line.minutes });
    setFormErrors([]);
  }
  function quantityChanged(id: string, value: string) {
    const current = localRef.current;
    if (!current) return;
    setLocal({ ...current, allocations: current.allocations.map(a => a.allocation_id === id ? { ...a, minutes: value } : a) });
    if (editingId === id) setEditor(previous => ({ ...previous, minutes: value }));
    setFormErrors([]);
  }
  function removeLine(id: string) {
    const current = localRef.current;
    if (!current) return;
    setLocal({ ...current, allocations: current.allocations.filter(a => a.allocation_id !== id) });
    if (editingId === id) { setEditingId(null); setFormErrors([]); }
    setStatus(`Removed local allocation ${id}. Removal is tentative until Save.`);
  }

  // A re-read can establish what is currently stored; it never replaces local edits.
  function reconcile(authority: Authority, attempt: Attempt): boolean {
    assertIdentity(authority);
    setLatest(authority); setCapability(authority.canWrite);
    const actual = fingerprint(authority.draft);
    if (actual === fingerprint(attempt.submitted) && key(authority.revision) && (attempt.outcome !== 'success' || authority.revision === attempt.acknowledgedRevision)) {
      setBaseline(authority); setResolution('none'); setReviewed(false); setStoreError('');
      setReceipt({ ...attempt }); attemptRef.current = null;
      setStatus(attempt.outcome === 'success' ? `Draft snapshot saved and independently verified at revision ${authority.revision}. Only the synthetic draft was saved.` : `The Save response was unconfirmed, but an actual file re-read confirms the submitted snapshot is stored at revision ${authority.revision}. Only the synthetic draft is stored.`);
      return true;
    }
    if (attempt.outcome === 'uncertain' && actual === fingerprint(attempt.previous) && key(authority.revision)) {
      setBaseline(authority); setResolution('none'); setReviewed(false); attemptRef.current = null;
      setReceipt(null); setStoreError('Temporary save failure. A file re-read shows the prior stored draft, not the submitted snapshot. Local edits are retained. You may explicitly Save again.');
      setStatus('Save was not confirmed. Local edits are preserved; no automatic retry was made.');
      return true;
    }
    setResolution('review'); setReviewed(false);
    setStoreError(attempt.outcome === 'success' ? 'Save was acknowledged, but the latest stored contents or revision differ from that acknowledgement. Review current authority before deciding what to retain.' : 'Save outcome was unconfirmed. The current stored draft differs from the submitted snapshot and the previous draft. Review it before deciding what to retain.');
    setStatus('Current authority needs review. All local edits are preserved; nothing is automatically reapplied.');
    return false;
  }
  async function checkUncertainAttempt(attempt: Attempt) {
    try {
      const authority = await readAuthority();
      if (!live.current) return;
      reconcile(authority, attempt);
    } catch (e) {
      if (!live.current) return;
      setCapability(null); setResolution('uncertain'); setReviewed(false);
      setStoreError(`${messageOf(e)} Save outcome is still unconfirmed. Review the actual stored draft before any further Save.`);
      setStatus('Unconfirmed Save outcome. Local edits are preserved; retry is blocked until an actual draft re-read.');
    }
  }
  async function saveDraft() {
    // Synchronous guard covers repeated clicks, including during the preflight read.
    if (busyRef.current || sourceRefreshing) return;
    const current = localRef.current;
    const base = baselineRef.current;
    if (!current || !base) return;
    if (capabilityRef.current !== true || !key(base.revision)) { setStoreError('Save is unavailable: current write capability and a source revision are required. Local edits are preserved.'); return; }
    if (resolutionRef.current !== 'none') { setStoreError('Review the current stored draft and explicitly choose to retain or discard local edits before another Save.'); return; }
    const errors = validatePlan(source, current);
    if (errors.length || formErrors.length) { setFormErrors([...errors, ...formErrors]); return; }
    if (fingerprint(current) === fingerprint(base.draft)) { setStatus('The current local plan already matches the stored draft.'); return; }
    const submitted = toDraft(current);
    const attempt: Attempt = { submitted, previous: base.draft, previousRevision: base.revision, outcome: 'pending' };
    attemptRef.current = attempt;
    setReceipt(null); setSubmittedSnapshot(submitted); setBusy(true); setStoreError(''); setStatus('Saving the submitted draft snapshot. You can keep editing; additional Save clicks are disabled.');
    try {
      // Recheck real capability without silently adopting a newer authority revision.
      // The revision selected from our verified base remains the compare-and-swap token.
      const preflight = await readAuthority();
      if (!live.current) return;
      assertIdentity(preflight); setLatest(preflight); setCapability(preflight.canWrite);
      if (!preflight.canWrite || capabilityRef.current !== true) {
        setStatus('Save refused: the existing draft is read-only. All local edits are preserved.');
        setStoreError('Read-only capability was verified before the write. No draft write was attempted.');
        attemptRef.current = null; return;
      }
      if (!key(preflight.revision)) {
        setCapability(null); setStoreError('The existing draft has no verified revision. Save was refused; local edits are preserved.');
        setStatus('Save refused because draft revision is unavailable.'); attemptRef.current = null; return;
      }
      const result = await writeFile('./draft.json', JSON.stringify(submitted, null, 2), { revision: attempt.previousRevision, contentType: 'application/json' });
      if (!live.current) return;
      if (result.success === true && key(result.revision)) {
        attempt.outcome = 'success'; attempt.acknowledgedRevision = result.revision;
        attemptRef.current = attempt;
        setStatus(`Submitted snapshot acknowledged at revision ${result.revision}; verifying the actual stored draft.`);
        setResolution('uncertain');
        await checkUncertainAttempt(attempt);
      } else if (result.success === false && result.error?.code === 'read_only') {
        setCapability(false); setResolution('review'); setReviewed(false); attemptRef.current = null;
        setStoreError(`Read-only refusal: ${result.error.message || 'the source no longer permits draft writes'}. No alternate write will be attempted.`);
        setStatus('Save was refused as read-only. Local edits are preserved.');
      } else if (result.success === false && result.error?.code === 'conflict') {
        setResolution('review'); setReviewed(false); attemptRef.current = null;
        setStoreError(`Revision conflict: ${result.error.message || 'the stored draft has advanced'}. Local edits are preserved. Review current authority, then explicitly retain or discard them.`);
        setStatus('Revision conflict. No automatic retry or replacement of local edits.');
        try { const authority = await readAuthority(); if (live.current) { assertIdentity(authority); setLatest(authority); setCapability(authority.canWrite); } }
        catch (e) { if (live.current) { setCapability(null); setStoreError(`Revision conflict. ${messageOf(e)} Local edits remain intact; review the latest stored draft when available.`); } }
      } else if (result.success === false && result.error?.code === 'invalid_path') {
        setResolution('blocked'); attemptRef.current = null;
        setStoreError(`The permitted existing draft path was rejected: ${result.error.message}. No substitute file or committed-state write is authorized.`);
        setStatus('Draft Save refused. Local edits are preserved.');
      } else {
        attempt.outcome = 'uncertain'; attemptRef.current = attempt;
        setResolution('uncertain');
        setStoreError(result.success === false ? `Save failed: ${result.error?.message || 'outcome unconfirmed'}. Checking the actual stored draft before retry is allowed.` : 'Save returned no verifiable new revision. Checking the actual stored draft.');
        setStatus('Unconfirmed Save response; reconciling by actual file re-read. No automatic retry.');
        await checkUncertainAttempt(attempt);
      }
    } catch (e) {
      if (!live.current) return;
      // A thrown transport failure is also ambiguous once a write could have begun.
      attempt.outcome = 'uncertain'; attemptRef.current = attempt; setResolution('uncertain');
      setStoreError(`${messageOf(e)} Checking actual authority before a further explicit Save.`);
      await checkUncertainAttempt(attempt);
    } finally { if (live.current) setBusy(false); }
  }

  async function reviewAuthority() {
    if (busyRef.current) return;
    setBusy(true); setStoreError(''); setStatus('Reading the current stored draft for review. Your local allocations are unchanged.');
    try {
      const authority = await readAuthority();
      if (!live.current) return;
      assertIdentity(authority); setLatest(authority); setCapability(authority.canWrite);
      const attempt = attemptRef.current;
      if (attempt && attempt.outcome !== 'pending') {
        if (reconcile(authority, attempt)) { setReviewed(true); return; }
      }
      setReviewed(true);
      if (baselineRef.current && (authority.revision !== baselineRef.current.revision || fingerprint(authority.draft) !== fingerprint(baselineRef.current.draft)) || resolutionRef.current !== 'none') setResolution('review');
      setStatus(`Reviewed the current stored draft at revision ${authority.revision ?? 'unavailable'}. Local edits were not replaced or saved.`);
      if (!authority.canWrite) setStoreError('Current source capability is read-only. Local editing is allowed; Save is refused.');
      else if (!key(authority.revision)) setStoreError('The stored draft revision is unavailable. Save is refused.');
    } catch (e) { if (live.current) { setCapability(null); setReviewed(false); setStoreError(messageOf(e)); setStatus('Authority review could not be completed. Local edits are preserved.'); } }
    finally { if (live.current) setBusy(false); }
  }
  function reapplyLocal() {
    if (busyRef.current || !reviewed || !latest || !localRef.current || !latest.canWrite || !key(latest.revision) || resolutionRef.current === 'blocked') return;
    assertIdentity(latest); setBaseline(latest); setCapability(latest.canWrite); setResolution('none');
    attemptRef.current = null; setStoreError(''); setReceipt(null);
    setSubmittedSnapshot(null); setStatus(`Local edits retained against explicitly reviewed revision ${latest.revision}. This decision did not save anything. Use Save to submit the validated local draft.`);
  }
  async function discardLocal() {
    if (busyRef.current) return;
    const before = editVersion.current;
    setBusy(true); setStoreError(''); setStatus('Reading the stored draft for your explicit discard decision.');
    try {
      const authority = await readAuthority();
      if (!live.current) return;
      assertIdentity(authority); setLatest(authority); setCapability(authority.canWrite);
      if (editVersion.current !== before) { setStoreError('You made further edits while the stored draft was loading. Those edits were preserved; choose Discard again if you still want to discard them.'); return; }
      setLocal(toLocal(authority.draft)); setBaseline(authority); setResolution('none'); setReviewed(false);
      setEditingId(null); setFormErrors([]); setReceipt(null); setSubmittedSnapshot(null); attemptRef.current = null;
      setStatus(`Local edits explicitly discarded; loaded the actual stored draft at revision ${authority.revision ?? 'unavailable'}. No write was made.`);
    } catch (e) { if (live.current) { setCapability(null); setStoreError(messageOf(e)); setStatus('Discard could not read the stored draft. Local edits were preserved.'); } }
    finally { if (live.current) setBusy(false); }
  }

  if (loading) return <section aria-label="Tentative allocation plan"><h2>Tentative allocation plan</h2><p role="status">Loading the existing draft and its write capability…</p></section>;
  if (!local || !baseline) return <section aria-label="Tentative allocation plan"><h2>Tentative allocation plan</h2><p data-eval="draft-error" role="alert">{loadError || 'Existing draft is unavailable. No draft write is authorized.'}</p><button onClick={() => void initialize()}>Retry reading existing draft</button><button data-eval="draft-save" disabled>Save draft</button></section>;

  const allErrors = [...validationErrors, ...formErrors, ...(storeError ? [storeError] : [])];
  const localTotal = local.allocations.reduce((n, a) => n + previewMinutes(a.minutes), 0);
  const plannedForDay = (id: string, day: string) => local.allocations.filter(a => a.resource_id === id && a.date === day).reduce((n, a) => n + previewMinutes(a.minutes), 0);
  const plannedForWork = (id: string) => local.allocations.filter(a => a.work_item_id === id).reduce((n, a) => n + previewMinutes(a.minutes), 0);

  return <section className="plan-section" aria-label="Tentative allocation plan">
    <h2>Tentative allocation plan</h2>
    <p>This is a synthetic draft, separate from committed work. Saving it does not book resources or change the capacity facts above.</p>
    <p>Draft <strong>{local.draft_id}</strong> · Verified base revision <strong>{baseline.revision ?? 'unavailable'}</strong> · {capability === true ? 'Source permits draft writes' : capability === false ? 'Source is read-only' : 'Write capability is unconfirmed'}</p>
    <p data-eval="draft-dirty-state" role="status">{dirty ? 'Unsaved local edits' : 'Current local plan matches the confirmed stored draft'}{validationErrors.length ? ' · Validation required before Save' : ''}{busy ? ' · Save/review pending; editing stays local' : ''}</p>
    <form onSubmit={e => { e.preventDefault(); applyAllocation(); }} noValidate className="allocation-editor">
      <h3>{editingId ? `Edit allocation ${editingId}` : 'Add an allocation'}</h3>
      <div className="controls">
        <label>Work item <select data-eval="plan-work-item" value={editor.work_item_id} onChange={e => changeField('work_item_id', e.target.value)}><option value="">Choose work item</option>{source.work_items.map(w => <option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.team_id} · {w.required_skill}</option>)}</select></label>
        <label>Resource <select data-eval="plan-resource" value={editor.resource_id} onChange={e => changeField('resource_id', e.target.value)}><option value="">Choose resource</option>{source.resources.map(r => <option key={r.resource_id} value={r.resource_id}>{r.resource_id} · {r.display_name} · {r.team_id}</option>)}</select></label>
        <label>Plan date <select data-eval="plan-date" value={editor.date} onChange={e => changeField('date', e.target.value)}><option value="">Choose roster date</option>{Array.from(new Set([...dates, ...(editor.date ? [editor.date] : [])])).sort().map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>Minutes <input data-eval="plan-minutes" aria-label="Allocation minutes" type="number" min="15" step="15" value={editor.minutes} onChange={e => changeField('minutes', e.target.value)} /></label>
        <button data-eval="plan-add" type="submit">{editingId ? 'Apply allocation changes' : 'Add allocation'}</button>
        {editingId && <button type="button" onClick={() => { setEditingId(null); setFormErrors([]); setEditor(previous => ({ ...previous, minutes: '15' })); }}>Cancel line edit</button>}
      </div>
      {selectedWork && <p>Work {selectedWork.work_item_id}: team {selectedWork.team_id}, skill {selectedWork.required_skill}, source remaining effort {selectedWork.remaining_minutes} minutes, allowed dates {selectedWork.earliest_date} through {selectedWork.due_date} inclusive.</p>}
      {selectedResource && <p>Resource {selectedResource.resource_id}: team {selectedResource.team_id}, skills {selectedResource.skills.join(', ') || 'none'}. The plan date is independent of the capacity-view date.</p>}
      <p>Use positive 15-minute increments. Add / Apply changes validates the whole local draft; typing here alone does not add a line.</p>
    </form>
    {allErrors.length > 0 && <div data-eval="draft-error" role="alert" className="error"><strong>Draft requires attention</strong><ul>{Array.from(new Set(allErrors)).map((error, i) => <li key={i}>{error}</li>)}</ul></div>}
    <h3>Local allocations · {local.allocations.length} lines · {localTotal} tentative minutes</h3>
    <div className="table-scroll"><table data-eval="draft-table"><thead><tr><th>Allocation ID</th><th>Work item</th><th>Resource</th><th>Date</th><th>Tentative minutes</th><th>Local actions</th></tr></thead><tbody>{local.allocations.map(line => <tr key={line.allocation_id} data-eval="draft-row" data-eval-key={line.allocation_id}>
      <td>{line.allocation_id}</td><td>{line.work_item_id}</td><td>{line.resource_id}</td><td>{line.date}</td>
      <td><input data-eval="draft-line-minutes" data-eval-key={line.allocation_id} aria-label={`Minutes for ${line.allocation_id}`} type="number" min="15" step="15" value={line.minutes} onChange={e => quantityChanged(line.allocation_id, e.target.value)} /></td>
      <td><button data-eval="draft-line-edit" data-eval-key={line.allocation_id} onClick={() => editLine(line)}>Edit allocation</button> <button data-eval="draft-line-remove" data-eval-key={line.allocation_id} onClick={() => removeLine(line.allocation_id)}>Remove allocation</button></td>
    </tr>)}</tbody></table></div>
    {!local.allocations.length && <p>No local allocations. A valid empty plan can be saved as an explicit draft change.</p>}
    <div className="controls save-controls">
      <button data-eval="draft-save" disabled={!saveEnabled} onClick={() => void saveDraft()}>{busy ? 'Save unavailable while pending' : 'Save draft'}</button>
      <button data-eval="conflict-review" disabled={busy} onClick={() => void reviewAuthority()}>Review current stored draft</button>
      <button data-eval="draft-discard" disabled={busy} onClick={() => void discardLocal()}>Discard local edits and load stored draft</button>
    </div>
    {submittedSnapshot && <p>Last submitted snapshot: draft {submittedSnapshot.draft_id}, {submittedSnapshot.allocations.length} allocations, {submittedSnapshot.allocations.reduce((n, a) => n + a.minutes, 0)} minutes. Changes made after clicking Save are separate from this snapshot.</p>}
    <p data-eval="draft-save-state" role="status">{status}{receipt && receipt.outcome !== 'pending' && <span> Submitted snapshot: {receipt.submitted.allocations.length} allocations, {receipt.submitted.allocations.reduce((n, a) => n + a.minutes, 0)} minutes. {dirty ? 'Newer or different local edits remain unsaved.' : 'The current local plan matches this confirmed stored snapshot.'}</span>}</p>
    {capability === false && <p className="notice">Save is disabled because the verified source is read-only. Local editing and review remain available.</p>}
    {resolution !== 'none' && <p className="notice">{resolution === 'uncertain' ? 'The Save outcome is unconfirmed. Read the actual stored draft before any retry.' : resolution === 'blocked' ? 'The declared draft path was refused. No alternate persistence path is available.' : 'Review current authority, then explicitly choose whether to retain your local plan or discard it. Save will not retry automatically.'}</p>}
    {(reviewed || resolution === 'review' || resolution === 'uncertain') && latest && <section data-eval="authority-review" aria-label="Current stored draft review" className="authority">
      <h3>Current stored draft, separate from local edits</h3>
      <p>Draft {latest.draft.draft_id}; actual read revision {latest.revision ?? 'unavailable'}; {latest.canWrite ? 'writable on the last file read' : 'read-only on the last file read'}.</p>
      <div className="table-scroll"><table><thead><tr><th>Stored allocation ID</th><th>Stored work item</th><th>Stored resource</th><th>Stored date</th><th>Stored minutes</th></tr></thead><tbody>{latest.draft.allocations.map(a => <tr key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td>{a.minutes}</td></tr>)}</tbody></table></div>
      {!latest.draft.allocations.length && <p>The current stored draft has no allocations.</p>}
      <p>Reviewing does not discard or save your local edits. Retaining the local plan adopts this reviewed revision for a later explicit Save. That Save replaces the stored allocations with your validated local allocations, including any removals.</p>
      <button data-eval="draft-reapply" disabled={busy || !reviewed || !latest.canWrite || !key(latest.revision) || resolution === 'blocked'} onClick={reapplyLocal}>Retain local edits against reviewed revision</button>
    </section>}
    <h3>Tentative resource/day capacity preview</h3>
    <p>Residual committed capacity = available minus committed. Capacity after plan subtracts local tentative minutes only; committed minutes stay unchanged.</p>
    {validationErrors.length > 0 && <p>These previews show current tentative numeric input and may exceed limits. Blank, non-finite or non-positive quantities are excluded. Invalid plans cannot be saved.</p>}
    <div className="table-scroll"><table><thead><tr><th>Resource ID</th><th>Date</th><th>Residual committed minutes</th><th>Tentative planned minutes</th><th>Capacity after plan (minutes)</th></tr></thead><tbody>{source.roster.map(day => {
      const rowKey = `${day.resource_id}|${day.date}`;
      const residual = day.available_minutes - day.committed_minutes;
      const planned = plannedForDay(day.resource_id, day.date);
      return <tr key={rowKey} data-eval="draft-capacity" data-eval-key={rowKey}><td>{day.resource_id}</td><td>{day.date}</td><td data-eval="draft-capacity-value" data-eval-key={rowKey} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{residual}</td><td data-eval="draft-capacity-value" data-eval-key={rowKey} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-capacity-value" data-eval-key={rowKey} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{residual - planned}</td></tr>;
    })}</tbody></table></div>
    <h3>Tentative remaining-work preview</h3>
    <div className="table-scroll"><table><thead><tr><th>Work item ID</th><th>Team / skill</th><th>Allowed dates (inclusive)</th><th>Source remaining minutes</th><th>Tentative planned minutes</th><th>Remaining after plan (minutes)</th></tr></thead><tbody>{source.work_items.map(work => {
      const planned = plannedForWork(work.work_item_id);
      return <tr key={work.work_item_id} data-eval="draft-work" data-eval-key={work.work_item_id}><td>{work.work_item_id}</td><td>{work.team_id} / {work.required_skill}</td><td>{work.earliest_date} through {work.due_date}</td><td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{work.remaining_minutes}</td><td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{work.remaining_minutes - planned}</td></tr>;
    })}</tbody></table></div>
  </section>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    (async () => {
      try {
        const entry = await readFile('./resources.json');
        if (!entry) throw new Error('Resource source is unavailable.');
        const data = validateSource(JSON.parse(await entry.file.text()));
        if (live.current) setSource(data);
      } catch (e) { if (live.current) setError(messageOf(e)); }
    })();
    return () => { live.current = false; };
  }, []);
  async function refreshResources() {
    if (refreshRef.current || planBusy) return;
    refreshRef.current = true; setRefreshing(true); setRefreshStatus('Refreshing deterministic source; currently displayed facts are from the previous snapshot.');
    try {
      const data = validateSource(await callFunction('load-data', {}));
      if (!live.current) return;
      setSource(data); setError(''); setRefreshStatus(`Resource facts refreshed from source snapshot ${data.snapshot_revision}. Local draft allocations were preserved.`);
    } catch (e) { if (live.current) setRefreshStatus(`Source refresh failed: ${messageOf(e)} The previous source facts and local draft are preserved.`); }
    finally { refreshRef.current = false; if (live.current) setRefreshing(false); }
  }
  return <main data-eval="planner-root" style={{fontFamily:'sans-serif',maxWidth:1200,margin:'auto',padding:20,color:'#172a3d'}}>
    <style>{`
      [data-eval="planner-root"] h1 { margin: 0 0 24px; font-size: 28px; }
      [data-eval="planner-root"] h2 { font-size: 22px; }
      [data-eval="planner-root"] h3 { margin-top: 24px; font-size: 17px; }
      [data-eval="planner-root"] label { display: flex; flex-direction: column; gap: 5px; font-size: 14px; }
      [data-eval="planner-root"] input, [data-eval="planner-root"] select, [data-eval="planner-root"] button { box-sizing: border-box; font: inherit; border: 1px solid #a7b8c9; border-radius: 5px; padding: 8px 10px; background: white; color: #172a3d; }
      [data-eval="planner-root"] input[type="number"] { width: 110px; }
      [data-eval="planner-root"] button { cursor: pointer; background: #eff5fa; }
      [data-eval="planner-root"] button:disabled { cursor: default; opacity: .55; }
      [data-eval="planner-root"] :focus-visible { outline: 3px solid #2876c8; outline-offset: 2px; }
      [data-eval="planner-root"] table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
      [data-eval="planner-root"] th { text-align: left; background: #eff4f8; }
      [data-eval="planner-root"] th, [data-eval="planner-root"] td { border-bottom: 1px solid #d6e0e9; padding: 10px 8px; vertical-align: middle; }
      [data-eval="planner-root"] [data-eval="resource-row"] { cursor: pointer; }
      [data-eval="planner-root"] [data-eval="resource-row"]:hover { background: #f5f9fc; }
      [data-eval="planner-root"] p { line-height: 1.5; font-size: 14px; }
      [data-eval="planner-root"] .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
      [data-eval="planner-root"] .plan-section { border-top: 2px solid #ccdae6; margin-top: 30px; padding-top: 16px; }
      [data-eval="planner-root"] .allocation-editor { background: #f3f7fb; border: 1px solid #d6e0e9; padding: 16px; border-radius: 7px; }
      [data-eval="planner-root"] .allocation-editor h3 { margin-top: 0; }
      [data-eval="planner-root"] .table-scroll { overflow-x: auto; }
      [data-eval="planner-root"] .save-controls { margin-top: 18px; }
      [data-eval="planner-root"] [data-eval="draft-save"]:enabled { background: #185eaa; color: white; border-color: #185eaa; }
      [data-eval="planner-root"] .error { padding: 14px; border: 1px solid #db9a98; border-radius: 6px; color: #822e2e; background: #fff5f4; margin: 14px 0; }
      [data-eval="planner-root"] .error ul { margin-bottom: 0; line-height: 1.6; }
      [data-eval="planner-root"] .notice { background: #fff6da; padding: 12px; border-radius: 6px; }
      [data-eval="planner-root"] .authority { border: 1px solid #c3ccd7; border-radius: 6px; padding: 16px; background: #f6f8fa; }
    `}</style>
    <h1>Resource planning</h1>
    {error && <p role="alert">{error}</p>}
    <button data-eval="refresh-resources" disabled={refreshing || planBusy} onClick={() => void refreshResources()}>{refreshing ? 'Refreshing resources…' : 'Refresh resources'}</button>
    {refreshStatus && <p role="status">{refreshStatus}</p>}
    {source ? <><p>Capacity source snapshot {source.snapshot_revision}. All displayed capacity facts are committed source facts.</p><ResourceView source={source}/><PlanEditor source={source} sourceRefreshing={refreshing} onBusyChange={setPlanBusy}/></> : !error && <p role="status">Loading resources</p>}
  </main>;
}
