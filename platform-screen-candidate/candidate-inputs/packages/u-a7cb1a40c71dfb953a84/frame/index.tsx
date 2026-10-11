import React, { useEffect, useRef, useState } from 'react';
import { readFile, writeFile, callFunction, triggerUserFileDownload } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Resource = { resource_id: string; display_name: string; team_id: string; skills: string[] };
type Roster = { resource_id: string; date: string; available_minutes: number; committed_minutes: number };
type Work = { work_item_id: string; team_id: string; required_skill: string; remaining_minutes: number; earliest_date: string; due_date: string };
type Source = { schema_version: string; snapshot_revision: string; default_date: string; teams: Team[]; resources: Resource[]; roster: Roster[]; work_items: Work[] };
type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number | string };
type Draft = { draft_id: string; allocations: Allocation[] };
type Authority = { draft: Draft; revision: string | null; canWrite: boolean };
type Check = { errors: string[]; byLine: Record<string, string[]> };

const box: React.CSSProperties = { border: '1px solid #ccd5df', borderRadius: 8, padding: 16, marginTop: 20, background: '#fff' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 10 };
const cell: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #e4e9ef', padding: '7px 8px' };
const dateKey = (r: string, d: string) => r + '|' + d;

function isSource(value: any): value is Source {
  return !!value && value.schema_version === 'resource-plan-1' && typeof value.default_date === 'string' &&
    Array.isArray(value.teams) && Array.isArray(value.resources) && Array.isArray(value.roster) && Array.isArray(value.work_items);
}
function isDraft(value: any): value is Draft {
  return !!value && typeof value.draft_id === 'string' && value.draft_id.length > 0 && Array.isArray(value.allocations) &&
    value.allocations.every((a: any) => a && typeof a.allocation_id === 'string' && typeof a.work_item_id === 'string' &&
      typeof a.resource_id === 'string' && typeof a.date === 'string' && typeof a.minutes === 'number');
}
function numericMinutes(value: number | string): number | null {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n % 15 === 0 ? n : null;
}
function previewMinutes(value: number | string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function normalDraft(draft: Draft): Draft {
  return { draft_id: draft.draft_id, allocations: draft.allocations.map(a => ({
    allocation_id: a.allocation_id, work_item_id: a.work_item_id, resource_id: a.resource_id, date: a.date,
    minutes: Number(a.minutes)
  })) };
}
function signature(draft: Draft): string { return JSON.stringify(normalDraft(draft)); }
function checkPlan(source: Source, draft: Draft): Check {
  const errors: string[] = [];
  const byLine: Record<string, string[]> = {};
  const byCapacity: Record<string, number> = {};
  const byWork: Record<string, number> = {};
  const seen = new Set<string>();
  for (const a of draft.allocations) {
    const line: string[] = [];
    const work = source.work_items.find(w => w.work_item_id === a.work_item_id);
    const resource = source.resources.find(r => r.resource_id === a.resource_id);
    const roster = source.roster.find(r => r.resource_id === a.resource_id && r.date === a.date);
    const minutes = numericMinutes(a.minutes);
    if (!a.allocation_id || seen.has(a.allocation_id)) line.push('Allocation ID must be unique.');
    seen.add(a.allocation_id);
    if (minutes === null) line.push('Minutes must be a positive multiple of 15.');
    if (!work) line.push('Unknown work item.');
    if (!resource) line.push('Unknown resource.');
    if (work && resource) {
      if (work.team_id !== resource.team_id) line.push('Resource is outside the work item team.');
      if (!resource.skills.includes(work.required_skill)) line.push('Resource lacks the required skill.');
      if (a.date < work.earliest_date || a.date > work.due_date) line.push('Date is outside the work item window.');
    }
    if (!roster) line.push('Resource has no roster capacity on that date.');
    if (minutes !== null) {
      byCapacity[dateKey(a.resource_id, a.date)] = (byCapacity[dateKey(a.resource_id, a.date)] || 0) + minutes;
      byWork[a.work_item_id] = (byWork[a.work_item_id] || 0) + minutes;
    }
    byLine[a.allocation_id] = line;
  }
  for (const r of source.roster) {
    const planned = byCapacity[dateKey(r.resource_id, r.date)] || 0;
    if (planned > 0 && planned > r.available_minutes - r.committed_minutes) errors.push(`${r.resource_id} on ${r.date}: planned ${planned} exceeds residual capacity ${r.available_minutes - r.committed_minutes} minutes.`);
  }
  for (const w of source.work_items) {
    const planned = byWork[w.work_item_id] || 0;
    if (planned > w.remaining_minutes) errors.push(`${w.work_item_id}: planned ${planned} exceeds remaining work ${w.remaining_minutes} minutes.`);
  }
  for (const a of draft.allocations) for (const message of byLine[a.allocation_id] || []) errors.push(`${a.allocation_id}: ${message}`);
  return { errors, byLine };
}

/* The supplied capacity view remains an independent view of committed source facts. */
function ResourceView({ source }: { source: Source }) {
  const [team, setTeam] = useState(''), [date, setDate] = useState(source.default_date), [search, setSearch] = useState(''),
    [sort, setSort] = useState('resource_id_asc'), [details, setDetails] = useState('');
  const rowsById = useRef<Record<string, HTMLTableRowElement | null>>({});
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dates: string[] = Array.from(new Set<string>(source.roster.map(r => r.date)));
  const rows = source.roster.filter(r => r.date === date)
    .map(r => ({ ...r, ...(source.resources.find(v => v.resource_id === r.resource_id) || {}) }))
    .filter((r: any) => (!team || r.team_id === team) && (!search || (r.resource_id + ' ' + r.display_name).toLowerCase().includes(search.toLowerCase())))
    .sort((a: any, b: any) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0) * (sort === 'resource_id_asc' ? 1 : -1));
  const selected = source.resources.find(r => r.resource_id === details);
  useEffect(() => { if (details) closeButton.current?.focus(); }, [details]);
  function close() { const old = details; setDetails(''); setTimeout(() => rowsById.current[old]?.focus(), 0); }
  async function csv() {
    const columns = ['resource_id', 'display_name', 'team_id', 'date', 'available_minutes', 'committed_minutes', 'residual_minutes'];
    const quote = (v: any) => '"' + String(v).replaceAll('"', '""') + '"';
    const content = [columns.join(','), ...rows.map((r: any) => columns.map(k => quote(k === 'residual_minutes' ? r.available_minutes - r.committed_minutes : r[k])).join(','))].join('\r\n') + '\r\n';
    await triggerUserFileDownload({ content, filename: 'capacity.csv' });
  }
  return <section aria-label="Existing capacity view" style={box}><h2>Resource capacity</h2><p>Source availability and committed work. Tentative allocations below do not change these figures.</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e => setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map(t => <option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
      <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e => setDate(e.target.value)}>{dates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label>Search <input data-eval="legacy-search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Order <select data-eval="legacy-sort" value={sort} onChange={e => setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
      <button data-eval="legacy-reset" onClick={() => { setTeam(''); setDate(source.default_date); setSearch(''); setSort('resource_id_asc'); }}>Reset view</button>
      <button data-eval="legacy-export" onClick={() => { void csv(); }}>Download capacity CSV</button>
    </div>
    <table data-eval="resource-table" style={table}><thead><tr>{['Resource ID', 'Name', 'Team', 'Date', 'Available minutes', 'Committed minutes', 'Residual minutes'].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead><tbody>{rows.map((r: any) => <tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el => { rowsById.current[r.resource_id] = el; }} onClick={() => setDetails(r.resource_id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetails(r.resource_id); } }}>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id">{r.resource_id}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td>
      <td style={cell} data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes - r.committed_minutes}</td>
    </tr>)}</tbody></table>
    {rows.length === 0 && <p>No matching resource/day rows.</p>}
    {selected && <aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }} style={{ padding: 14, border: '1px solid #789' }}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

function PlanEditor({ source, setSource }: { source: Source; setSource: (s: Source) => void }) {
  const [authority, setAuthority] = useState<Authority | null>(null);
  const [authorityVerified, setAuthorityVerified] = useState(false);
  const [local, setLocal] = useState<Draft | null>(null);
  const localRef = useRef<Draft | null>(null);
  const [confirmed, setConfirmed] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [storeError, setStoreError] = useState('');
  const [saveState, setSaveState] = useState('Loading existing draft…');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [decisionRequired, setDecisionRequired] = useState(false);
  const [readOnlyRejected, setReadOnlyRejected] = useState(false);
  const [form, setForm] = useState({ work: source.work_items[0]?.work_item_id || '', resource: source.resources[0]?.resource_id || '', date: source.default_date, minutes: '' });
  const nextId = useRef(1);

  function changeLocal(next: Draft) { localRef.current = next; setLocal(next); setFormError(''); }
  async function readAuthority(): Promise<Authority | null> {
    const entry = await readFile('./draft.json');
    if (!entry) return null;
    const content = JSON.parse(await entry.file.text());
    if (!isDraft(content)) throw new Error('The stored draft has an unexpected format.');
    return { draft: content, revision: entry.revision, canWrite: entry.canWrite };
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const current = await readAuthority();
        if (!live) return;
        if (!current) { setLoadError('The existing draft could not be read. No replacement file will be created.'); setSaveState('Draft unavailable'); return; }
        setAuthority(current); setAuthorityVerified(true); setConfirmed(current.draft); changeLocal(current.draft);
        setSaveState(current.canWrite && current.revision ? 'Existing draft loaded; local edits are not saved until Save draft.' : 'Existing draft loaded read-only. Local edits can be reviewed but cannot be saved.');
      } catch (e: any) { if (live) { setLoadError(e?.message || 'Could not read the existing draft.'); setSaveState('Draft unavailable'); } }
    })();
    return () => { live = false; };
  }, []);

  const check = local ? checkPlan(source, local) : { errors: [], byLine: {} as Record<string, string[]> };
  const dirty = !!local && !!confirmed && signature(local) !== signature(confirmed);
  const canSave = !!local && !!authority && dirty && check.errors.length === 0 && !formError && authority.canWrite && authorityVerified && typeof authority.revision === 'string' && authority.revision.length > 0 && !pending && !decisionRequired && !readOnlyRejected;
  const rosterDates = Array.from(new Set(source.roster.map(r => r.date)));

  function add() {
    if (!local) return;
    const allocation: Allocation = { allocation_id: '', work_item_id: form.work, resource_id: form.resource, date: form.date, minutes: form.minutes };
    do { allocation.allocation_id = `local-${nextId.current++}`; } while (local.allocations.some(a => a.allocation_id === allocation.allocation_id));
    const candidate = { ...local, allocations: [...local.allocations, allocation] };
    const issues = checkPlan(source, candidate).errors;
    if (issues.length) { setFormError(issues.join(' ')); return; }
    changeLocal({ ...local, allocations: [...local.allocations, { ...allocation, minutes: Number(allocation.minutes) }] });
    setForm({ ...form, minutes: '' });
    setSaveState(pendingRef.current ? 'Saving an earlier draft snapshot; this new local allocation remains unsaved.' : 'Local allocation added. Save draft to persist it.');
  }
  function updateMinutes(id: string, value: string) {
    const current = localRef.current; if (!current) return;
    changeLocal({ ...current, allocations: current.allocations.map(a => a.allocation_id === id ? { ...a, minutes: value } : a) });
    setSaveState(pendingRef.current ? 'Saving an earlier draft snapshot; this newer local edit remains unsaved.' : 'Local allocation changed; not yet saved.');
  }
  function remove(id: string) {
    const current = localRef.current; if (!current) return;
    changeLocal({ ...current, allocations: current.allocations.filter(a => a.allocation_id !== id) });
    setSaveState(pendingRef.current ? 'Saving an earlier draft snapshot; this newer local removal remains unsaved.' : 'Local allocation removed; not yet saved.');
  }
  async function inspectAfterAmbiguous(snapshot: Draft, beforeRevision: string, context: string) {
    try {
      const latest = await readAuthority();
      if (!latest) { setDecisionRequired(true); setAuthorityVerified(false); setStoreError('Stored draft could not be re-read after an uncertain Save.'); setSaveState(`${context} The stored draft could not be re-read. Local edits remain; review authority before another Save.`); return; }
      setAuthority(latest); setAuthorityVerified(true);
      if (signature(latest.draft) === signature(snapshot) && latest.revision && latest.revision !== beforeRevision) {
        setConfirmed(snapshot);
        setStoreError('');
        setDecisionRequired(false);
        setSaveState(`Draft snapshot was verified in the store at revision ${latest.revision}. ${signature(localRef.current || snapshot) === signature(snapshot) ? 'Current local draft is saved.' : 'Newer local edits remain unsaved.'}`);
      } else if (latest.revision !== beforeRevision || signature(latest.draft) !== signature(confirmed || latest.draft)) {
        setDecisionRequired(true);
        setStoreError('Stored draft differs from the submitted snapshot.');
        setSaveState(`${context} Stored draft differs from the submitted snapshot. Local edits remain. Review authority, then choose Reapply or Discard.`);
      } else {
        setStoreError('Save was not confirmed. Local edits were retained.');
        setSaveState(`${context} No saved snapshot was verified. Local edits remain; use Save draft explicitly to try again.`);
      }
    } catch (e: any) { setDecisionRequired(true); setAuthorityVerified(false); setStoreError('Re-reading authority failed after an uncertain Save.'); setSaveState(`${context} Re-reading authority failed. Local edits remain; review before another Save.`); }
  }
  async function save() {
    if (pendingRef.current || !localRef.current || !authority) return;
    if (!authority.canWrite || readOnlyRejected) { setSaveState('This draft is read-only. Local edits are retained; Save is unavailable.'); return; }
    if (!authority.revision || !authorityVerified || decisionRequired) { setSaveState('Review the current stored draft and explicitly reapply local edits before saving.'); return; }
    if (formError) { setSaveState('An invalid allocation request is unresolved. Correct it before saving.'); return; }
    const issues = checkPlan(source, localRef.current).errors;
    if (issues.length) { setSaveState('Invalid draft was not submitted. Correct the listed errors.'); return; }
    if (signature(localRef.current) === signature(confirmed || authority.draft)) { setSaveState('There are no new local edits to save.'); return; }
    const snapshot = normalDraft(localRef.current);
    const submittedRevision = authority.revision;
    const payload = JSON.stringify(snapshot);
    pendingRef.current = true; setPending(true); setStoreError(''); setSaveState(`Saving draft snapshot against revision ${submittedRevision}…`);
    try {
      const result = await writeFile('./draft.json', payload, { revision: submittedRevision, contentType: 'application/json' });
      if (result.success) {
        let latest: Authority | null = null;
        try { latest = await readAuthority(); } catch (_) { /* Keep the submission unconfirmed. */ }
        if (latest) { setAuthority(latest); setAuthorityVerified(true); } else setAuthorityVerified(false);
        if (latest && latest.revision === result.revision && result.revision !== submittedRevision && signature(latest.draft) === payload) {
          setConfirmed(snapshot); setStoreError(''); setDecisionRequired(false);
          setSaveState(`Draft snapshot saved and verified at revision ${result.revision}. ${signature(localRef.current || snapshot) === payload ? 'Current local draft is saved.' : 'Newer local edits remain unsaved.'} This has not booked resources.`);
        } else {
          setDecisionRequired(true);
          setStoreError('The Save response could not be verified against the stored draft.');
          setSaveState('The Save response could not be independently verified against the stored draft. Local edits remain. Review authority before another Save.');
        }
      } else if (result.error.code === 'read_only') {
        setReadOnlyRejected(true);
        setStoreError('Save refused: this draft is read-only.');
        setAuthority({ ...authority, canWrite: false });
        setSaveState('Save refused: the draft became read-only. Local edits remain. No alternate write will be attempted.');
        try { const latest = await readAuthority(); if (latest) { setAuthority({ ...latest, canWrite: false }); setAuthorityVerified(true); } else setAuthorityVerified(false); } catch (_) { setAuthorityVerified(false); }
      } else if (result.error.code === 'conflict') {
        setStoreError('Revision conflict: review current authority before reapplying or discarding local edits.');
        setDecisionRequired(true);
        setSaveState('Revision conflict. Local edits remain; review the current stored draft before deciding whether to reapply or discard them.');
        try { const latest = await readAuthority(); if (latest) { setAuthority(latest); setAuthorityVerified(true); } else setAuthorityVerified(false); } catch (_) { setAuthorityVerified(false); }
      } else if (result.error.code === 'save_failed') {
        await inspectAfterAmbiguous(snapshot, submittedRevision, 'Save returned a temporary or ambiguous failure.');
      } else {
        setStoreError(`Save refused: ${result.error.code}.`);
        setDecisionRequired(true);
        setSaveState(`Save refused (${result.error.code}). Local edits remain; no alternate write will be attempted.`);
      }
    } catch (e: any) {
      await inspectAfterAmbiguous(snapshot, submittedRevision, 'Save could not be confirmed.');
    } finally { pendingRef.current = false; setPending(false); }
  }
  async function review() {
    if (pendingRef.current) return;
    try {
      const latest = await readAuthority();
      if (!latest) { setAuthorityVerified(false); setSaveState('Current authority could not be read; local edits remain.'); return; }
      const changedAuthority = !authority || latest.revision !== authority.revision || signature(latest.draft) !== signature(authority.draft);
      setAuthority(latest); setAuthorityVerified(true);
      if (signature(localRef.current || latest.draft) === signature(latest.draft)) { setConfirmed(latest.draft); setDecisionRequired(false); }
      else if (changedAuthority) setDecisionRequired(true);
      setSaveState(`Current stored draft loaded for review at revision ${latest.revision || 'unavailable'}. Local edits have not been replaced or saved.${changedAuthority && signature(localRef.current || latest.draft) !== signature(latest.draft) ? ' Explicitly reapply or discard local edits before saving.' : ''}`);
    } catch (e: any) { setAuthorityVerified(false); setSaveState('Current authority could not be read; local edits remain.'); }
  }
  function reapply() {
    if (!authority || !authorityVerified || pendingRef.current || readOnlyRejected) return;
    setConfirmed(authority.draft);
    setStoreError('');
    setDecisionRequired(false);
    setSaveState('Local edits retained against the reviewed stored revision. They are still unsaved; use Save draft explicitly.');
  }
  function discard() {
    if (!authority || !authorityVerified || pendingRef.current) return;
    changeLocal(authority.draft); setConfirmed(authority.draft); setStoreError(''); setDecisionRequired(false);
    setSaveState('Local edits discarded. The current stored draft is shown.');
  }
  async function refreshResources() {
    try {
      const value = await callFunction('load-data', {});
      if (!isSource(value)) throw new Error('Unexpected resource result.');
      setSource(value);
      setSaveState('Resource facts refreshed. Local draft was retained and revalidated.');
    } catch (e: any) { setSaveState(`Resource refresh failed: ${e?.message || 'unknown error'}. Local draft was retained.`); }
  }

  return <section aria-label="Allocation plan editor" style={box}>
    <h2>Tentative allocation plan</h2>
    <p>Edit the existing draft locally. These quantities are tentative and do not change committed resource work. Save draft persists only the draft file.</p>
    <button data-eval="refresh-resources" onClick={() => { void refreshResources(); }} disabled={pending}>Refresh resource facts</button>
    {loadError && <p role="alert" data-eval="draft-error">{loadError}</p>}
    {!local ? <p>Loading draft…</p> : <>
      <p>Draft ID: <strong>{local.draft_id}</strong></p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>Work item <select data-eval="plan-work-item" data-eval-key={form.work} value={form.work} onChange={e => { setForm({ ...form, work: e.target.value }); setFormError(''); }}>{source.work_items.map(w => <option key={w.work_item_id} value={w.work_item_id} data-eval-key={w.work_item_id}>{w.work_item_id} · {w.team_id} · {w.required_skill} · {w.remaining_minutes} min remaining</option>)}</select></label>
        <label>Resource <select data-eval="plan-resource" data-eval-key={form.resource} value={form.resource} onChange={e => { setForm({ ...form, resource: e.target.value }); setFormError(''); }}>{source.resources.map(r => <option key={r.resource_id} value={r.resource_id} data-eval-key={r.resource_id}>{r.resource_id} · {r.display_name} · {r.team_id} · {r.skills.join('/')}</option>)}</select></label>
        <label>Plan date <select data-eval="plan-date" data-eval-key={form.date} value={form.date} onChange={e => { setForm({ ...form, date: e.target.value }); setFormError(''); }}>{rosterDates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>Minutes <input data-eval="plan-minutes" type="number" min="15" step="15" value={form.minutes} onChange={e => { setForm({ ...form, minutes: e.target.value }); setFormError(''); }} style={{ width: 90 }} /></label>
        <button data-eval="plan-add" onClick={add}>Add allocation</button>
      </div>
      {formError && <p role="alert" data-eval="draft-error" style={{ color: '#9a2929' }}>{formError}</p>}
      <h3>Local draft allocations</h3>
      <table data-eval="draft-table" style={table}><thead><tr>{['Allocation ID', 'Work item', 'Resource', 'Date', 'Tentative minutes', 'Action'].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead><tbody>
        {local.allocations.map(a => <tr key={a.allocation_id} data-eval="draft-row" data-eval-key={a.allocation_id}>
          <td style={cell}>{a.allocation_id}</td><td style={cell}>{a.work_item_id}</td><td style={cell}>{a.resource_id}</td><td style={cell}>{a.date}</td>
          <td style={cell}><input aria-label={`Minutes for ${a.allocation_id}`} data-eval="draft-line-minutes" data-eval-key={a.allocation_id} type="number" min="15" step="15" value={a.minutes} onChange={e => updateMinutes(a.allocation_id, e.target.value)} style={{ width: 90 }} /> min</td>
          <td style={cell}><button data-eval="draft-line-remove" data-eval-key={a.allocation_id} onClick={() => remove(a.allocation_id)}>Remove</button></td>
        </tr>)}
      </tbody></table>
      {local.allocations.length === 0 && <p>No tentative allocations in this local draft.</p>}
      <h3>Resource/day capacity preview</h3><p>Committed residual = available − committed. Capacity after plan = committed residual − tentative plan.</p>
      <table style={table}><thead><tr>{['Resource', 'Date', 'Committed residual (min)', 'Tentative planned (min)', 'Capacity after plan (min)'].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead><tbody>
        {source.roster.map(r => { const planned = local.allocations.filter(a => a.resource_id === r.resource_id && a.date === r.date).reduce((n, a) => n + previewMinutes(a.minutes), 0); const residual = r.available_minutes - r.committed_minutes; const key = dateKey(r.resource_id, r.date); return <tr key={key} data-eval="draft-capacity" data-eval-key={key}><td style={cell}>{r.resource_id}</td><td style={cell}>{r.date}</td><td style={cell} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{residual}</td><td style={cell} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td style={cell} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{residual - planned}</td></tr>; })}
      </tbody></table>
      <h3>Remaining work preview</h3><table style={table}><thead><tr>{['Work item', 'Required team', 'Skill', 'Window', 'Source remaining (min)', 'Tentative planned (min)', 'Remaining after plan (min)'].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead><tbody>
        {source.work_items.map(w => { const planned = local.allocations.filter(a => a.work_item_id === w.work_item_id).reduce((n, a) => n + previewMinutes(a.minutes), 0); return <tr key={w.work_item_id} data-eval="draft-work" data-eval-key={w.work_item_id}><td style={cell}>{w.work_item_id}</td><td style={cell}>{w.team_id}</td><td style={cell}>{w.required_skill}</td><td style={cell}>{w.earliest_date} to {w.due_date}</td><td style={cell} data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{w.remaining_minutes}</td><td style={cell} data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td style={cell} data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{w.remaining_minutes - planned}</td></tr>; })}
      </tbody></table>
      {check.errors.length > 0 && <div data-eval="draft-error" role="alert" style={{ color: '#9a2929' }}><strong>Draft is invalid; Save is blocked.</strong><ul>{check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
      <p data-eval="draft-dirty-state" role="status">{dirty ? 'Unsaved local edits' : 'Local draft matches the confirmed stored draft'}{decisionRequired ? '; authority review and explicit reapply or discard required' : ''}.</p>
      <p data-eval="draft-save-state" role="status">{saveState}</p>
      {storeError && <p data-eval="draft-error" role="alert" style={{ color: '#9a2929' }}>{storeError}</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button data-eval="draft-save" onClick={() => { void save(); }} disabled={!canSave}>{pending ? 'Saving…' : 'Save draft'}</button>
        <button data-eval="conflict-review" onClick={() => { void review(); }} disabled={pending}>Review current stored draft</button>
        <button data-eval="draft-reapply" onClick={reapply} disabled={pending || !decisionRequired || !authority || !authorityVerified || !authority.canWrite || readOnlyRejected}>Reapply my local edits</button>
        <button data-eval="draft-discard" onClick={discard} disabled={pending || !authority || !authorityVerified || !dirty}>Discard local edits</button>
      </div>
      {authority && <aside data-eval="authority-review" style={{ marginTop: 16, background: '#f4f7fb', padding: 12 }}>
        <strong>{authorityVerified ? 'Current stored authority' : 'Last observed authority; re-read required'} (separate from local draft)</strong>
        <p>Revision: {authority.revision || 'unavailable'} · {authority.canWrite && !readOnlyRejected ? 'Writable' : 'Read-only'} · Draft ID: {authority.draft.draft_id}</p>
        <ul>{authority.draft.allocations.map(a => <li key={a.allocation_id}>{a.allocation_id}: {a.work_item_id} → {a.resource_id} on {a.date}, {a.minutes} min</li>)}</ul>
        {authority.draft.allocations.length === 0 && <p>No stored allocations.</p>}
      </aside>}
    </>}
  </section>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<Source | null>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; (async () => {
    try { const entry = await readFile('./resources.json'); if (!entry) throw new Error('Resource source is unavailable.'); const data = JSON.parse(await entry.file.text()); if (!isSource(data)) throw new Error('Resource source has an unexpected format.'); if (live) setSource(data); }
    catch (e: any) { if (live) setError(e?.message || 'Resource source is unavailable.'); }
  })(); return () => { live = false; }; }, []);
  return <main data-eval="planner-root" style={{ fontFamily: 'sans-serif', maxWidth: 1200, margin: 'auto', padding: 20, color: '#182532', background: '#f9fbfd' }}><h1>Resource planning</h1>{error ? <p role="alert">{error}</p> : source ? <><ResourceView source={source} /><PlanEditor source={source} setSource={setSource} /></> : <p role="status">Loading resources</p>}</main>;
}
