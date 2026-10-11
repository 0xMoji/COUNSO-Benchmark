import React, { useEffect, useRef, useState } from 'react';
import { readFile, writeFile, triggerUserFileDownload } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Resource = { resource_id: string; display_name: string; team_id: string; skills: string[] };
type Roster = { resource_id: string; date: string; available_minutes: number; committed_minutes: number };
type WorkItem = { work_item_id: string; team_id: string; required_skill: string; remaining_minutes: number; earliest_date: string; due_date: string };
type Source = { schema_version: string; snapshot_revision: string; default_date: string; teams: Team[]; resources: Resource[]; roster: Roster[]; work_items: WorkItem[] };
type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number | string };
type Draft = { draft_id: string; allocations: Allocation[] };
type FileState = { draft: Draft; revision: string | null; canWrite: boolean };
type Gate = '' | 'conflict' | 'unconfirmed' | 'read_only' | 'invalid_path';

function isSource(value: any): value is Source {
  return !!value && value.schema_version === 'resource-plan-1' && typeof value.default_date === 'string' &&
    Array.isArray(value.teams) && Array.isArray(value.resources) && Array.isArray(value.roster) && Array.isArray(value.work_items) &&
    value.resources.every((r: any) => typeof r.resource_id === 'string' && typeof r.team_id === 'string' && Array.isArray(r.skills)) &&
    value.roster.every((r: any) => typeof r.resource_id === 'string' && typeof r.date === 'string' && Number.isFinite(r.available_minutes) && Number.isFinite(r.committed_minutes)) &&
    value.work_items.every((w: any) => typeof w.work_item_id === 'string' && typeof w.team_id === 'string' && typeof w.required_skill === 'string' && Number.isFinite(w.remaining_minutes));
}
function isDraft(value: any): value is Draft {
  return !!value && typeof value.draft_id === 'string' && value.draft_id.length > 0 && Array.isArray(value.allocations) &&
    value.allocations.every((a: any) => a && typeof a.allocation_id === 'string' && a.allocation_id.length > 0 &&
      typeof a.work_item_id === 'string' && typeof a.resource_id === 'string' && typeof a.date === 'string' &&
      Number.isInteger(a.minutes) && a.minutes > 0 && a.minutes % 15 === 0);
}
function copyDraft(draft: Draft): Draft {
  return { draft_id: draft.draft_id, allocations: draft.allocations.map(a => ({
    allocation_id: a.allocation_id, work_item_id: a.work_item_id, resource_id: a.resource_id,
    date: a.date, minutes: a.minutes
  })) };
}
function sameDraft(a: Draft | null, b: Draft | null): boolean {
  if (!a || !b || a.draft_id !== b.draft_id || a.allocations.length !== b.allocations.length) return false;
  return a.allocations.every((line, i) => {
    const other = b.allocations[i];
    return line.allocation_id === other.allocation_id && line.work_item_id === other.work_item_id &&
      line.resource_id === other.resource_id && line.date === other.date && line.minutes === other.minutes;
  });
}
function minutesNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}
function validateDraft(source: Source, draft: Draft): { errors: string[]; byLine: Record<string, string[]> } {
  const errors: string[] = [];
  const byLine: Record<string, string[]> = {};
  const resourceLoad: Record<string, number> = {};
  const workLoad: Record<string, number> = {};
  const ids = new Set<string>();
  for (const line of draft.allocations) {
    const e: string[] = [];
    const work = source.work_items.find(w => w.work_item_id === line.work_item_id);
    const resource = source.resources.find(r => r.resource_id === line.resource_id);
    const roster = source.roster.find(r => r.resource_id === line.resource_id && r.date === line.date);
    const quantity = minutesNumber(line.minutes);
    if (ids.has(line.allocation_id)) e.push('Allocation ID must be unique.');
    ids.add(line.allocation_id);
    if (!work) e.push('Choose a source work item.');
    if (!resource) e.push('Choose a source resource.');
    if (work && resource && work.team_id !== resource.team_id) e.push('Resource must belong to the work item team.');
    if (work && resource && !resource.skills.includes(work.required_skill)) e.push('Resource needs the required skill.');
    if (!roster) e.push('Resource must have a roster entry on this date.');
    if (work && (line.date < work.earliest_date || line.date > work.due_date)) e.push('Date must fall within the work item window.');
    if (quantity === null || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity % 15 !== 0) e.push('Minutes must be a positive multiple of 15.');
    if (quantity !== null && Number.isFinite(quantity) && quantity > 0) {
      const key = line.resource_id + '|' + line.date;
      resourceLoad[key] = (resourceLoad[key] || 0) + quantity;
      workLoad[line.work_item_id] = (workLoad[line.work_item_id] || 0) + quantity;
    }
    byLine[line.allocation_id] = e;
  }
  for (const row of source.roster) {
    const key = row.resource_id + '|' + row.date;
    const residual = row.available_minutes - row.committed_minutes;
    if ((resourceLoad[key] || 0) > residual) {
      const msg = `${key}: planned minutes exceed the ${residual}-minute residual capacity.`;
      errors.push(msg);
      draft.allocations.filter(a => a.resource_id === row.resource_id && a.date === row.date).forEach(a => byLine[a.allocation_id].push(msg));
    }
  }
  for (const work of source.work_items) {
    if ((workLoad[work.work_item_id] || 0) > work.remaining_minutes) {
      const msg = `${work.work_item_id}: planned minutes exceed ${work.remaining_minutes} minutes of remaining work.`;
      errors.push(msg);
      draft.allocations.filter(a => a.work_item_id === work.work_item_id).forEach(a => byLine[a.allocation_id].push(msg));
    }
  }
  draft.allocations.forEach(a => byLine[a.allocation_id].forEach(message => errors.push(`${a.allocation_id}: ${message}`)));
  return { errors: Array.from(new Set(errors)), byLine };
}
async function readSource(): Promise<Source> {
  const entry = await readFile('./resources.json');
  if (!entry) throw new Error('Resource source is unavailable.');
  const value = JSON.parse(await entry.file.text());
  if (!isSource(value)) throw new Error('Resource source has an unexpected format.');
  return value;
}
async function readDraft(): Promise<FileState> {
  const entry = await readFile('./draft.json');
  if (!entry) throw new Error('The existing draft is unavailable; saving is disabled.');
  const value = JSON.parse(await entry.file.text());
  if (!isDraft(value)) throw new Error('The existing draft has an unexpected format; saving is disabled.');
  return { draft: value, revision: entry.revision, canWrite: entry.canWrite };
}

function ResourceView({ source }: { source: Source }) {
  const [team, setTeam] = useState(''), [date, setDate] = useState(source.default_date), [search, setSearch] = useState(''),
    [sort, setSort] = useState('resource_id_asc'), [details, setDetails] = useState(''), [downloadError, setDownloadError] = useState('');
  const rowsById = useRef<Record<string, HTMLTableRowElement | null>>({});
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dates: string[] = Array.from(new Set(source.roster.map(r => r.date)));
  const rows = source.roster.filter(r => r.date === date).flatMap(r => {
    const resource = source.resources.find(v => v.resource_id === r.resource_id);
    return resource ? [{ ...r, ...resource }] : [];
  })
    .filter(r => (!team || r.team_id === team) && (!search || (r.resource_id + ' ' + r.display_name).toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0) * (sort === 'resource_id_asc' ? 1 : -1));
  const selected = source.resources.find(r => r.resource_id === details);
  useEffect(() => { if (details) closeButton.current?.focus(); }, [details]);
  function close() { const old = details; setDetails(''); setTimeout(() => rowsById.current[old]?.focus(), 0); }
  async function csv() {
    const columns = ['resource_id', 'display_name', 'team_id', 'date', 'available_minutes', 'committed_minutes', 'residual_minutes'];
    const quote = (v: any) => '"' + String(v).replace(/"/g, '""') + '"';
    const content = [columns.join(','), ...rows.map(r => columns.map(k => quote(k === 'residual_minutes' ? r.available_minutes - r.committed_minutes : (r as any)[k])).join(','))].join('\r\n') + '\r\n';
    try { setDownloadError(''); await triggerUserFileDownload({ content, filename: 'capacity.csv' }); }
    catch (e: any) { setDownloadError(e?.message || 'CSV download failed.'); }
  }
  return <section aria-label="Existing capacity view">
    <h2>Resource capacity</h2>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
      <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e => setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map(t => <option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
      <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e => setDate(e.target.value)}>{dates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label>Search <input data-eval="legacy-search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Order <select data-eval="legacy-sort" value={sort} onChange={e => setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
      <button data-eval="legacy-reset" onClick={() => { setTeam(''); setDate(source.default_date); setSearch(''); setSort('resource_id_asc'); }}>Reset view</button>
      <button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
    </div>
    {downloadError && <p role="alert">{downloadError}</p>}
    <div style={{ overflowX: 'auto' }}><table data-eval="resource-table" style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}><thead><tr>{['Resource ID', 'Name', 'Team', 'Date', 'Available minutes', 'Committed minutes', 'Residual minutes'].map(h => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #bbc', padding: 6 }}>{h}</th>)}</tr></thead><tbody>
      {rows.map(r => <tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el => { rowsById.current[r.resource_id] = el; }} onClick={() => setDetails(r.resource_id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetails(r.resource_id); } }} style={{ cursor: 'pointer' }}>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id" style={{ padding: 6 }}>{r.resource_id}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name" style={{ padding: 6 }}>{r.display_name}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id" style={{ padding: 6 }}>{r.team_id}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date" style={{ padding: 6 }}>{r.date}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{r.available_minutes}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{r.committed_minutes}</td>
        <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{r.available_minutes - r.committed_minutes}</td>
      </tr>)}
    </tbody></table></div>
    {rows.length === 0 && <p>No matching resource/day rows.</p>}
    {selected && <aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }} style={{ padding: 14, border: '1px solid #789', marginTop: 12 }}>
      <p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p>
      <button ref={closeButton} onClick={close}>Close resource details</button>
    </aside>}
  </section>;
}

function PlanEditor({ source }: { source: Source }) {
  const [authority, setAuthority] = useState<FileState | null>(null);
  const authorityRef = useRef<FileState | null>(null);
  const [local, setLocal] = useState<Draft | null>(null);
  const localRef = useRef<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const savedRef = useRef<Draft | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewBusyRef = useRef(false);
  const [gate, setGateState] = useState<Gate>('');
  const gateRef = useRef<Gate>('');
  const [readOnlySeen, setReadOnlySeen] = useState(false);
  const readOnlyRef = useRef(false);
  const [reviewed, setReviewed] = useState(false);
  const [status, setStatus] = useState('Loading the existing draft.');
  const [formError, setFormError] = useState('');
  const [formWork, setFormWork] = useState(source.work_items[0]?.work_item_id || '');
  const [formResource, setFormResource] = useState(source.resources[0]?.resource_id || '');
  const allDates = Array.from(new Set(source.roster.map(r => r.date))).sort();
  const [formDate, setFormDate] = useState(allDates.includes(source.default_date) ? source.default_date : (allDates[0] || ''));
  const [formMinutes, setFormMinutes] = useState('15');
  const nextId = useRef(1);
  const uncertainRef = useRef<{ submitted: Draft; before: Draft; revision: string | null } | null>(null);

  function changeGate(next: Gate) { gateRef.current = next; setGateState(next); }
  function observeReadOnly() { readOnlyRef.current = true; setReadOnlySeen(true); changeGate('read_only'); }
  function changeLocal(next: Draft) {
    localRef.current = next;
    setLocal(next);
    setFormError('');
    if (pendingRef.current) setStatus('Saving an earlier submitted snapshot; newer edits remain local.');
    else if (!gateRef.current) setStatus('Local draft changed. These edits are unsaved until an explicit Save draft.');
  }
  function changeSaved(next: Draft) { const snapshot = copyDraft(next); savedRef.current = snapshot; setSaved(snapshot); }
  function installAuthority(next: FileState) {
    authorityRef.current = next;
    setAuthority(next);
    changeSaved(next.draft);
    if (!next.canWrite) observeReadOnly();
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const first = await readDraft();
        if (!live) return;
        installAuthority(first);
        changeLocal(copyDraft(first.draft));
        setStatus(first.canWrite ? 'Existing draft loaded. Changes stay local until Save draft.' : 'This draft is read-only; local changes cannot be saved.');
      } catch (e: any) {
        if (live) { setLoadError(e?.message || 'The existing draft could not be read.'); setStatus('Draft unavailable; saving is disabled.'); }
      }
    })();
    return () => { live = false; };
  }, []);

  async function reviewLatest(allowWhileSaving = false) {
    if (reviewBusyRef.current || (pendingRef.current && !allowWhileSaving)) return;
    reviewBusyRef.current = true;
    setReviewBusy(true);
    const before = authorityRef.current;
    try {
      const latest = await readDraft();
      installAuthority(latest);
      setReviewed(true);
      const uncertain = uncertainRef.current;
      if (uncertain) {
        uncertainRef.current = null;
        if (sameDraft(latest.draft, uncertain.submitted)) {
          if (!readOnlyRef.current) changeGate('');
          setStatus(sameDraft(localRef.current, uncertain.submitted)
            ? 'The stored draft matches the submitted snapshot after an uncertain response. Draft save is verified by a fresh read.'
            : 'The stored draft matches the earlier submission; newer local edits remain unsaved.');
        } else if (sameDraft(latest.draft, uncertain.before) && latest.revision === uncertain.revision) {
          if (!readOnlyRef.current) changeGate('');
          setStatus('Save failed. The stored draft is unchanged; your local edits remain. Choose Save draft again to retry.');
        } else {
          changeGate('conflict');
          setStatus('The stored draft differs after an uncertain save. Review the current authority, then explicitly keep or discard your local edits.');
        }
      } else if (gateRef.current === 'conflict') {
        setStatus('Revision conflict. Current stored draft is shown below; local edits are still intact. Choose Reapply local edits or Discard local edits.');
      } else if (gateRef.current === 'read_only' || readOnlyRef.current) {
        setStatus('Draft is read-only. Local edits are still available here; no further save is permitted in this view.');
      } else if (before && (latest.revision !== before.revision || !sameDraft(latest.draft, before.draft))) {
        changeGate('conflict');
        setStatus('The stored draft changed since this view loaded. Review it, then explicitly keep or discard local edits.');
      } else {
        setStatus('Current stored draft and revision refreshed. Local edits were kept.');
      }
    } catch (e: any) {
      setStatus(`Could not read the current stored draft: ${e?.message || 'read unavailable'}. Local edits are kept.`);
    } finally { reviewBusyRef.current = false; setReviewBusy(false); }
  }
  async function saveDraft() {
    const current = localRef.current;
    const base = authorityRef.current;
    if (!current || !base || pendingRef.current || reviewBusyRef.current) return;
    if (readOnlyRef.current || !base.canWrite) { observeReadOnly(); setStatus('Read-only draft: no write was sent.'); return; }
    if (gateRef.current) { setStatus('Review and resolve the stored draft state before a new Save.'); return; }
    if (!base.revision) { setStatus('No verified draft revision is available; no write was sent.'); return; }
    if (current.draft_id !== base.draft.draft_id) { setStatus('Draft identity differs from the current stored draft; no write was sent.'); return; }
    const check = validateDraft(source, current);
    if (check.errors.length) { setStatus('Correct the allocation errors before saving. No write was sent.'); return; }
    const submitted = copyDraft(current);
    const before = copyDraft(base.draft);
    const revision = base.revision;
    pendingRef.current = true;
    setPending(true);
    setStatus('Saving this draft snapshot and verifying the stored contents…');
    try {
      const result = await writeFile('./draft.json', JSON.stringify(submitted, null, 2) + '\n', { revision, contentType: 'application/json' });
      if (result.success) {
        if (!result.revision || result.revision === revision) {
          uncertainRef.current = { submitted, before, revision };
          changeGate('unconfirmed');
          setStatus('Save response lacked a confirmed new revision. Local edits remain; review the stored draft.');
        } else {
          try {
            const verified = await readDraft();
            installAuthority(verified);
            if (verified.revision === result.revision && sameDraft(verified.draft, submitted)) {
              changeGate(readOnlyRef.current ? 'read_only' : '');
              setReviewed(false);
              setStatus(sameDraft(localRef.current, submitted)
                ? 'Draft saved and verified at the new revision. This is a tentative plan only.'
                : 'Earlier submitted draft saved and verified. Newer local edits remain unsaved.');
            } else {
              changeGate('conflict');
              setReviewed(true);
              setStatus('Save was acknowledged, but the current stored revision or contents differ. Local edits are intact; review before another Save.');
            }
          } catch (e: any) {
            uncertainRef.current = { submitted, before, revision };
            changeGate('unconfirmed');
            setStatus(`Save was acknowledged, but the stored draft could not be verified: ${e?.message || 'read unavailable'}. Review before another Save.`);
          }
        }
      } else if (result.error.code === 'read_only') {
        observeReadOnly();
        setStatus('Save was refused as read-only. Local edits are kept; no alternate write was sent.');
      } else if (result.error.code === 'conflict') {
        changeGate('conflict');
        setReviewed(false);
        setStatus('Revision conflict. Local edits are kept; review the current stored draft.');
        await reviewLatest(true);
      } else if (result.error.code === 'save_failed') {
        uncertainRef.current = { submitted, before, revision };
        changeGate('unconfirmed');
        setStatus('Save outcome is uncertain. Re-reading the stored draft before any further Save.');
        await reviewLatest(true);
      } else {
        changeGate('invalid_path');
        setStatus('Draft save path was refused. Local edits are kept; no replacement file or alternate write was attempted.');
      }
    } catch (e: any) {
      uncertainRef.current = { submitted, before, revision };
      changeGate('unconfirmed');
      setStatus('Save response was interrupted. Re-reading the stored draft before any further Save.');
      await reviewLatest(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  function newId(): string {
    const existing = new Set(localRef.current?.allocations.map(a => a.allocation_id) || []);
    let id = '';
    do { id = `LOCAL-${nextId.current++}`; } while (existing.has(id));
    return id;
  }
  function addLine() {
    const current = localRef.current;
    if (!current) return;
    const amount = minutesNumber(formMinutes);
    const candidate: Allocation = { allocation_id: newId(), work_item_id: formWork, resource_id: formResource, date: formDate, minutes: amount === null ? formMinutes : amount };
    const proposed = { ...current, allocations: [...current.allocations, candidate] };
    const check = validateDraft(source, proposed);
    if (check.errors.length) { setFormError(check.errors.join(' ')); return; }
    changeLocal(proposed);
    setStatus(pendingRef.current ? 'Added locally while an earlier draft snapshot is saving.' : 'Allocation added locally. Save draft to persist it.');
  }
  function changeLine(id: string, patch: Partial<Allocation>) {
    const current = localRef.current;
    if (!current) return;
    changeLocal({ ...current, allocations: current.allocations.map(a => a.allocation_id === id ? { ...a, ...patch } : a) });
  }
  function removeLine(id: string) {
    const current = localRef.current;
    if (!current) return;
    changeLocal({ ...current, allocations: current.allocations.filter(a => a.allocation_id !== id) });
    setStatus('Allocation removed from the local draft. Save draft to persist the change.');
  }
  function discardLocal() {
    const current = authorityRef.current;
    if (!current || ((gateRef.current === 'conflict' || gateRef.current === 'unconfirmed') && !reviewed)) return;
    changeLocal(copyDraft(current.draft));
    changeSaved(current.draft);
    uncertainRef.current = null;
    if (!readOnlyRef.current) changeGate('');
    setStatus('Local edits discarded by your choice. Showing the current stored draft.');
  }
  function reapplyLocal() {
    if (gateRef.current !== 'conflict' || !reviewed || !authorityRef.current || readOnlyRef.current) return;
    if (localRef.current?.draft_id !== authorityRef.current.draft.draft_id) {
      setStatus('Draft IDs differ; local edits cannot be reapplied to another draft.');
      return;
    }
    changeGate('');
    setReviewed(false);
    setStatus('Local edits retained against the reviewed revision. Inspect validation, then choose Save draft explicitly.');
  }

  const validation = local ? validateDraft(source, local) : { errors: [], byLine: {} as Record<string, string[]> };
  const identityError = local && authority && local.draft_id !== authority.draft.draft_id ? 'Local draft ID differs from the current stored draft.' : '';
  const dirty = !!local && !!saved && !sameDraft(local, saved);
  const canSave = !!local && !!authority && !!authority.revision && authority.canWrite && !readOnlySeen && !pending && !reviewBusy && !gate && !identityError && validation.errors.length === 0;
  const plannedCapacity: Record<string, number> = {};
  const plannedWork: Record<string, number> = {};
  if (local) for (const line of local.allocations) {
    const amount = minutesNumber(line.minutes);
    if (amount !== null && Number.isFinite(amount) && amount > 0) {
      const key = line.resource_id + '|' + line.date;
      plannedCapacity[key] = (plannedCapacity[key] || 0) + amount;
      plannedWork[line.work_item_id] = (plannedWork[line.work_item_id] || 0) + amount;
    }
  }
  return <section aria-label="Tentative allocation-plan editor" style={{ marginTop: 30, borderTop: '2px solid #526d83', paddingTop: 16 }}>
    <h2>Tentative allocation plan</h2>
    <p>Plan quantities are tentative. Committed minutes in the capacity view remain source facts. Save draft stores this plan only.</p>
    {loadError ? <p data-eval="draft-error" role="alert">{loadError}</p> : !local ? <p role="status">Loading draft</p> : <>
      <p>Draft <strong>{local.draft_id}</strong></p>
      <p data-eval="draft-dirty-state" role="status">{dirty ? 'Unsaved local edits' : 'Local draft matches the verified stored draft'}{pending ? '; a submitted snapshot is pending' : ''}</p>
      <p data-eval="draft-save-state" role="status">{status}</p>
      {(validation.errors.length > 0 || formError || identityError) && <div data-eval="draft-error" role="alert" style={{ color: '#a32929' }}>
        {identityError && <p>{identityError}</p>}{formError && <p>{formError}</p>}
        {validation.errors.length > 0 && <ul>{validation.errors.map((message, i) => <li key={i}>{message}</li>)}</ul>}
      </div>}
      <h3>Add allocation</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>Work item <select data-eval="plan-work-item" value={formWork} onChange={e => { setFormWork(e.target.value); setFormError(''); }}>{source.work_items.map(w => <option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.team_id} · {w.required_skill}</option>)}</select></label>
        <label>Resource <select data-eval="plan-resource" value={formResource} onChange={e => { setFormResource(e.target.value); setFormError(''); }}>{source.resources.map(r => <option key={r.resource_id} value={r.resource_id}>{r.resource_id} · {r.display_name} · {r.team_id}</option>)}</select></label>
        <label>Date <select data-eval="plan-date" value={formDate} onChange={e => { setFormDate(e.target.value); setFormError(''); }}>{allDates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
        <label>Minutes <input data-eval="plan-minutes" type="number" min="15" step="15" value={formMinutes} onChange={e => { setFormMinutes(e.target.value); setFormError(''); }} style={{ width: 90 }} /></label>
        <button data-eval="plan-add" onClick={addLine}>Add to local draft</button>
      </div>
      <h3>Local draft allocations</h3>
      <div style={{ overflowX: 'auto' }}><table data-eval="draft-table" style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Allocation ID', 'Work item', 'Resource', 'Date', 'Minutes', 'Action'].map(h => <th key={h} style={{ textAlign: 'left', padding: 6, borderBottom: '1px solid #bbc' }}>{h}</th>)}</tr></thead><tbody>
        {local.allocations.map(line => <tr key={line.allocation_id} data-eval="draft-row" data-eval-key={line.allocation_id}>
          <td style={{ padding: 6 }}>{line.allocation_id}</td>
          <td style={{ padding: 6 }}><select aria-label={`Work item for ${line.allocation_id}`} data-eval="draft-line-work-item" data-eval-key={line.allocation_id} value={line.work_item_id} onChange={e => changeLine(line.allocation_id, { work_item_id: e.target.value })}>{source.work_items.map(w => <option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id}</option>)}</select></td>
          <td style={{ padding: 6 }}><select aria-label={`Resource for ${line.allocation_id}`} data-eval="draft-line-resource" data-eval-key={line.allocation_id} value={line.resource_id} onChange={e => changeLine(line.allocation_id, { resource_id: e.target.value })}>{source.resources.map(r => <option key={r.resource_id} value={r.resource_id}>{r.resource_id}</option>)}</select></td>
          <td style={{ padding: 6 }}><select aria-label={`Date for ${line.allocation_id}`} data-eval="draft-line-date" data-eval-key={line.allocation_id} value={line.date} onChange={e => changeLine(line.allocation_id, { date: e.target.value })}>{allDates.map(d => <option key={d} value={d}>{d}</option>)}</select></td>
          <td style={{ padding: 6 }}><input aria-label={`Minutes for ${line.allocation_id}`} data-eval="draft-line-minutes" data-eval-key={line.allocation_id} type="number" min="15" step="15" value={line.minutes} onChange={e => changeLine(line.allocation_id, { minutes: e.target.value === '' ? '' : Number(e.target.value) })} style={{ width: 90 }} /></td>
          <td style={{ padding: 6 }}><button data-eval="draft-line-remove" data-eval-key={line.allocation_id} onClick={() => removeLine(line.allocation_id)}>Remove</button></td>
        </tr>)}
      </tbody></table></div>
      {local.allocations.length === 0 && <p>No local allocations.</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button data-eval="draft-save" onClick={saveDraft} disabled={!canSave}>Save draft</button>
        <button data-eval="conflict-review" onClick={() => { void reviewLatest(); }} disabled={reviewBusy || pending}>Review current stored draft</button>
        {gate === 'conflict' && <button data-eval="draft-reapply" onClick={reapplyLocal} disabled={!reviewed || readOnlySeen}>Reapply local edits to reviewed revision</button>}
        <button data-eval="draft-discard" onClick={discardLocal} disabled={pending || ((gate === 'conflict' || gate === 'unconfirmed') && !reviewed)}>Discard local edits</button>
      </div>
      {!authority?.revision && <p>No verified revision is available, so Save is unavailable.</p>}
      {readOnlySeen && <p>Read-only capability or refusal observed. This view will not send another write.</p>}
      <h3>Capacity after tentative plan</h3>
      <p>Residual committed capacity = available minus committed. Capacity after plan = residual committed capacity minus tentative allocations. All values are minutes.</p>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Resource', 'Date', 'Residual committed minutes', 'Planned minutes', 'Capacity after plan minutes'].map(h => <th key={h} style={{ textAlign: 'left', padding: 6, borderBottom: '1px solid #bbc' }}>{h}</th>)}</tr></thead><tbody>
        {source.roster.map(row => { const key = row.resource_id + '|' + row.date; const residual = row.available_minutes - row.committed_minutes; const planned = plannedCapacity[key] || 0; return <tr key={key} data-eval="draft-capacity" data-eval-key={key}>
          <td style={{ padding: 6 }}>{row.resource_id}</td><td style={{ padding: 6 }}>{row.date}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{residual}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{planned}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{residual - planned}</td>
        </tr>; })}
      </tbody></table></div>
      <h3>Work remaining after tentative plan</h3>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Work item', 'Team', 'Skill', 'Earliest', 'Due', 'Source remaining minutes', 'Planned minutes', 'Remaining after plan minutes'].map(h => <th key={h} style={{ textAlign: 'left', padding: 6, borderBottom: '1px solid #bbc' }}>{h}</th>)}</tr></thead><tbody>
        {source.work_items.map(work => { const planned = plannedWork[work.work_item_id] || 0; return <tr key={work.work_item_id} data-eval="draft-work" data-eval-key={work.work_item_id}>
          <td style={{ padding: 6 }}>{work.work_item_id}</td><td style={{ padding: 6 }}>{work.team_id}</td><td style={{ padding: 6 }}>{work.required_skill}</td><td style={{ padding: 6 }}>{work.earliest_date}</td><td style={{ padding: 6 }}>{work.due_date}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{work.remaining_minutes}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{planned}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes" style={{ padding: 6 }}>{work.remaining_minutes - planned}</td>
        </tr>; })}
      </tbody></table></div>
      {authority && <section data-eval="authority-review" aria-label="Current stored draft" style={{ marginTop: 22, padding: 12, background: '#eef2f5' }}>
        <h3>Current stored draft (separate from local edits)</h3>
        <p>Draft {authority.draft.draft_id}; revision {authority.revision || 'unavailable'}; {authority.canWrite && !readOnlySeen ? 'writable' : 'read-only in this view'}.</p>
        <ul>{authority.draft.allocations.map(line => <li key={line.allocation_id}>{line.allocation_id}: {line.work_item_id}, {line.resource_id}, {line.date}, {line.minutes} minutes</li>)}</ul>
        {authority.draft.allocations.length === 0 && <p>No stored allocations.</p>}
      </section>}
    </>}
  </section>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    readSource().then(value => { if (live) setSource(value); }).catch((e: any) => { if (live) setError(e?.message || 'Resource source is unavailable.'); });
    return () => { live = false; };
  }, []);
  async function refresh() {
    setRefreshing(true);
    try { const value = await readSource(); setSource(value); setError(''); }
    catch (e: any) { setError(e?.message || 'Resource source refresh failed.'); }
    finally { setRefreshing(false); }
  }
  return <main data-eval="planner-root" style={{ fontFamily: 'sans-serif', maxWidth: 1200, margin: 'auto', padding: 20, color: '#1c2733' }}>
    <h1>Resource planning</h1>
    {error && <p role="alert">{error}</p>}
    {source ? <><button data-eval="refresh-resources" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh resource source'}</button><ResourceView source={source} /><PlanEditor source={source} /></> : !error ? <p role="status">Loading resources</p> : null}
  </main>;
}
