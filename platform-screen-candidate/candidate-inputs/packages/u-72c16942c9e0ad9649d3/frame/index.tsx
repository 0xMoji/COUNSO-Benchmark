import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, writeFile, callFunction, triggerUserFileDownload } from '@dust/react-hooks';

type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number | string };
type Draft = { draft_id: string; allocations: Allocation[] };
type Authority = { draft: Draft; revision: string; canWrite: boolean };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const serial = (value: unknown) => JSON.stringify(value);
const cleanDraft = (draft: Draft): Draft => ({
  draft_id: draft.draft_id,
  allocations: draft.allocations.map(a => ({ ...a, minutes: Number(a.minutes) }))
});

function validSource(value: any) {
  return value && value.schema_version === 'resource-plan-1' && typeof value.snapshot_revision === 'string' &&
    typeof value.default_date === 'string' && Array.isArray(value.teams) && Array.isArray(value.resources) &&
    Array.isArray(value.roster) && Array.isArray(value.work_items);
}

function validDraftShape(value: any): value is Draft {
  return value && typeof value.draft_id === 'string' && value.draft_id.length > 0 && Array.isArray(value.allocations) &&
    value.allocations.every((a: any) => a && typeof a.allocation_id === 'string' && typeof a.work_item_id === 'string' &&
      typeof a.resource_id === 'string' && typeof a.date === 'string' && Number.isInteger(a.minutes) && a.minutes >= 15 && a.minutes % 15 === 0);
}

function validateAllocations(source: any, draft: Draft): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byCapacity: Record<string, number> = {};
  const byWork: Record<string, number> = {};
  draft.allocations.forEach((a, index) => {
    const line = `Allocation ${index + 1}`;
    const minutes = Number(a.minutes);
    if (!a.allocation_id || ids.has(a.allocation_id)) errors.push(`${line}: allocation identity must be unique.`);
    ids.add(a.allocation_id);
    const work = source.work_items.find((w: any) => w.work_item_id === a.work_item_id);
    const resource = source.resources.find((r: any) => r.resource_id === a.resource_id);
    const roster = source.roster.find((r: any) => r.resource_id === a.resource_id && r.date === a.date);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes <= 0 || minutes % 15 !== 0) {
      errors.push(`${line}: minutes must be a positive whole number in 15-minute increments.`);
    }
    if (!work) errors.push(`${line}: work item is not in the source.`);
    if (!resource) errors.push(`${line}: resource is not in the source.`);
    if (!roster) errors.push(`${line}: resource has no roster capacity on that date.`);
    if (work && resource && resource.team_id !== work.team_id) errors.push(`${line}: resource is outside the work item's team.`);
    if (work && resource && !resource.skills.includes(work.required_skill)) errors.push(`${line}: resource lacks the required skill ${work.required_skill}.`);
    if (work && (a.date < work.earliest_date || a.date > work.due_date)) errors.push(`${line}: date is outside the work item's allowed range.`);
    if (Number.isFinite(minutes) && minutes > 0) {
      byCapacity[`${a.resource_id}|${a.date}`] = (byCapacity[`${a.resource_id}|${a.date}`] || 0) + minutes;
      byWork[a.work_item_id] = (byWork[a.work_item_id] || 0) + minutes;
    }
  });
  Object.keys(byCapacity).forEach(key => {
    const [resourceId, date] = key.split('|');
    const roster = source.roster.find((r: any) => r.resource_id === resourceId && r.date === date);
    if (roster && byCapacity[key] > roster.available_minutes - roster.committed_minutes) {
      errors.push(`${resourceId} on ${date}: tentative minutes exceed residual committed capacity.`);
    }
  });
  Object.keys(byWork).forEach(id => {
    const work = source.work_items.find((w: any) => w.work_item_id === id);
    if (work && byWork[id] > work.remaining_minutes) errors.push(`${id}: tentative minutes exceed remaining work.`);
  });
  return errors;
}

function ResourceView({ source, draft }: { source: any; draft: Draft }) {
  const [team, setTeam] = useState('');
  const [date, setDate] = useState(source.default_date);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('resource_id_asc');
  const [details, setDetails] = useState('');
  const rowsById = useRef<Record<string, HTMLTableRowElement | null>>({});
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dates: string[] = Array.from(new Set<string>(source.roster.map((r: any) => r.date)));
  const rows = source.roster.filter((r: any) => r.date === date)
    .map((r: any) => ({ ...r, ...source.resources.find((v: any) => v.resource_id === r.resource_id) }))
    .filter((r: any) => (!team || r.team_id === team) && (!search || `${r.resource_id} ${r.display_name}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a: any, b: any) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0) * (sort === 'resource_id_asc' ? 1 : -1));
  const selected = source.resources.find((r: any) => r.resource_id === details);
  useEffect(() => { if (details) closeButton.current?.focus(); }, [details]);
  function close() { const old = details; setDetails(''); setTimeout(() => rowsById.current[old]?.focus(), 0); }
  async function csv() {
    const columns = ['resource_id', 'display_name', 'team_id', 'date', 'available_minutes', 'committed_minutes', 'residual_minutes'];
    const quote = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
    const text = [columns.join(','), ...rows.map((r: any) => columns.map(k => quote(k === 'residual_minutes' ? r.available_minutes - r.committed_minutes : r[k])).join(','))].join('\r\n') + '\r\n';
    await triggerUserFileDownload({ content: text, filename: 'capacity.csv' });
  }
  return <section aria-label="Existing capacity view">
    <h2>Resource capacity</h2>
    <p style={{ color: '#46556f' }}>Committed capacity facts are authoritative source values. Tentative plan minutes are shown separately below.</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
      <label>Team <select data-eval="legacy-team-filter" value={team} onChange={e => setTeam(e.target.value)}><option value="">All teams</option>{source.teams.map((t: any) => <option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}</select></label>
      <label>Date <select data-eval="legacy-date-filter" value={date} onChange={e => setDate(e.target.value)}>{dates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label>Search <input data-eval="legacy-search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Order <select data-eval="legacy-sort" value={sort} onChange={e => setSort(e.target.value)}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
      <button data-eval="legacy-reset" onClick={() => { setTeam(''); setDate(source.default_date); setSearch(''); setSort('resource_id_asc'); }}>Reset view</button>
      <button data-eval="legacy-export" onClick={csv}>Download capacity CSV</button>
    </div>
    <table data-eval="resource-table" style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}><thead><tr>{['Resource ID', 'Name', 'Team', 'Date', 'Available minutes', 'Committed minutes', 'Residual minutes'].map(h => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #a9b4c6', padding: 7 }}>{h}</th>)}</tr></thead><tbody>{rows.map((r: any) => <tr key={r.resource_id} data-eval="resource-row" data-eval-key={r.resource_id} role="button" tabIndex={0} ref={el => { rowsById.current[r.resource_id] = el; }} onClick={() => setDetails(r.resource_id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetails(r.resource_id); } }}>
      <td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="resource_id" style={{ padding: 7 }}>{r.resource_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="display_name">{r.display_name}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="team_id">{r.team_id}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="date">{r.date}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes">{r.available_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes">{r.committed_minutes}</td><td data-eval="resource-cell" data-eval-key={r.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes">{r.available_minutes - r.committed_minutes}</td>
    </tr>)}</tbody></table>
    {rows.length === 0 && <p>No matching resource/day rows.</p>}
    {selected && <aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }} style={{ padding: 14, border: '1px solid #789', borderRadius: 6, marginTop: 12 }}><p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} onClick={close}>Close resource details</button></aside>}
  </section>;
}

function Planner({ source, initial }: { source: any; initial: Authority }) {
  const [local, setLocalState] = useState<Draft>(() => clone(initial.draft));
  const localRef = useRef<Draft>(clone(initial.draft));
  const [authority, setAuthority] = useState<Authority>(() => clone(initial));
  const [savedSerial, setSavedSerial] = useState(serial(cleanDraft(initial.draft)));
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [saveState, setSaveState] = useState(initial.canWrite ? 'No unsaved changes.' : 'Read-only draft: Save is unavailable.');
  const [storeError, setStoreError] = useState('');
  const [reviewRequired, setReviewRequired] = useState(false);
  const [showAuthority, setShowAuthority] = useState(false);
  const [workId, setWorkId] = useState(source.work_items[0]?.work_item_id || '');
  const [resourceId, setResourceId] = useState(source.resources[0]?.resource_id || '');
  const dates: string[] = Array.from(new Set<string>(source.roster.map((r: any) => r.date)));
  const [planDate, setPlanDate] = useState(dates[0] || '');
  const [minutes, setMinutes] = useState('15');
  const idCounter = useRef(1);
  const errors = useMemo(() => validateAllocations(source, local), [source, local]);
  const normalized = errors.length ? null : cleanDraft(local);
  const dirty = normalized ? serial(normalized) !== savedSerial : true;

  function setLocal(next: Draft) { localRef.current = next; setLocalState(next); setStoreError(''); if (!pending) setSaveState('Local draft has unsaved changes.'); }
  function add() {
    let id = `LOCAL-${idCounter.current++}`;
    while (local.allocations.some(a => a.allocation_id === id)) id = `LOCAL-${idCounter.current++}`;
    const next = { ...local, allocations: [...local.allocations, { allocation_id: id, work_item_id: workId, resource_id: resourceId, date: planDate, minutes }] };
    const nextErrors = validateAllocations(source, next);
    if (nextErrors.length) { setStoreError(nextErrors[0]); setSaveState('Allocation was not added.'); return; }
    setLocal(cleanDraft(next));
  }
  function editMinutes(id: string, value: string) { setLocal({ ...local, allocations: local.allocations.map(a => a.allocation_id === id ? { ...a, minutes: value } : a) }); }
  function remove(id: string) { setLocal({ ...local, allocations: local.allocations.filter(a => a.allocation_id !== id) }); }

  async function readAuthority(show = true): Promise<Authority | null> {
    try {
      const entry = await readFile('./draft.json');
      if (!entry || !entry.revision) { setStoreError('The authoritative draft or its revision is unavailable.'); return null; }
      const value = JSON.parse(await entry.file.text());
      if (!validDraftShape(value)) { setStoreError('The authoritative draft has an invalid shape.'); return null; }
      const next = { draft: value, revision: entry.revision, canWrite: entry.canWrite };
      setAuthority(next); setShowAuthority(show);
      return next;
    } catch (e: any) { setStoreError(e?.message || 'Could not read the authoritative draft.'); return null; }
  }

  async function save() {
    if (pendingRef.current) return;
    if (!authority.canWrite) { setStoreError('This verified draft is read-only. Local edits were preserved.'); setSaveState('Save refused: read-only.'); return; }
    if (reviewRequired) { setStoreError('Review the current authority, then choose Reapply local edits or Discard local edits before saving.'); return; }
    const currentErrors = validateAllocations(source, localRef.current);
    if (currentErrors.length) { setStoreError(currentErrors[0]); setSaveState('Save blocked by validation.'); return; }
    const submitted = cleanDraft(clone(localRef.current));
    const submittedSerial = serial(submitted);
    const submittedRevision = authority.revision;
    pendingRef.current = true; setPending(true); setStoreError(''); setSaveState(`Saving draft snapshot at revision ${submittedRevision}…`);
    try {
      const result = await writeFile('./draft.json', JSON.stringify(submitted, null, 2) + '\n', { revision: submittedRevision, contentType: 'application/json' });
      if (result.success) {
        const verified = await readAuthority(false);
        if (verified && verified.revision === result.revision && serial(cleanDraft(verified.draft)) === submittedSerial) {
          setSavedSerial(submittedSerial);
          setReviewRequired(false);
          setSaveState(serial(cleanDraft(localRef.current)) === submittedSerial ? `Draft saved and verified at revision ${result.revision}.` : `Earlier submitted snapshot saved at revision ${result.revision}; newer local edits remain unsaved.`);
        } else {
          setStoreError('Save acknowledgement could not be matched to the stored draft. Local edits were preserved; review authority before saving again.');
          setSaveState('Save is not verified.'); setReviewRequired(true); setShowAuthority(true);
        }
      } else if (result.error.code === 'conflict') {
        await readAuthority(true); setReviewRequired(true);
        setStoreError(`Revision conflict: ${result.error.message}. Local edits were preserved.`); setSaveState('Save rejected by revision conflict.');
      } else if (result.error.code === 'read_only') {
        const latest = await readAuthority(false);
        if (latest) setAuthority({ ...latest, canWrite: false });
        setStoreError(`Save rejected as read-only: ${result.error.message}. Local edits were preserved.`); setSaveState('Save refused: read-only.');
      } else if (result.error.code === 'save_failed') {
        const latest = await readAuthority(true);
        if (latest && serial(cleanDraft(latest.draft)) === submittedSerial) {
          setSavedSerial(submittedSerial);
          setSaveState(serial(cleanDraft(localRef.current)) === submittedSerial ? `Draft was found in the store after an ambiguous failure at revision ${latest.revision}.` : `Submitted snapshot was found in the store; newer local edits remain unsaved.`);
          setStoreError('The save result was ambiguous, so the stored file was re-read and matched.'); setReviewRequired(false);
        } else {
          setStoreError(`Save failed: ${result.error.message}. The store was re-read; local edits were preserved. Save again only if you choose to retry.`);
          setSaveState('Save failed; authoritative state was reconciled.'); setReviewRequired(false);
        }
      } else {
        setStoreError(`Save rejected: ${result.error.message}. Local edits were preserved.`); setSaveState('Save rejected.');
      }
    } catch (e: any) {
      const latest = await readAuthority(true);
      if (latest && serial(cleanDraft(latest.draft)) === submittedSerial) {
        setSavedSerial(submittedSerial);
        setReviewRequired(false);
        setStoreError('The save response failed, so the stored file was re-read and matched to the submitted snapshot.');
        setSaveState(serial(cleanDraft(localRef.current)) === submittedSerial ? `Draft was found in the store at revision ${latest.revision}.` : 'Submitted snapshot was found in the store; newer local edits remain unsaved.');
      } else {
        setStoreError(`${e?.message || 'Temporary save failure.'} The store was re-read and local edits were preserved.`); setSaveState('Save failed; authoritative state was reconciled.');
      }
    } finally { pendingRef.current = false; setPending(false); }
  }

  const plannedByCapacity: Record<string, number> = {};
  const plannedByWork: Record<string, number> = {};
  local.allocations.forEach(a => { const n = Number(a.minutes); if (Number.isFinite(n) && n > 0) { plannedByCapacity[`${a.resource_id}|${a.date}`] = (plannedByCapacity[`${a.resource_id}|${a.date}`] || 0) + n; plannedByWork[a.work_item_id] = (plannedByWork[a.work_item_id] || 0) + n; } });

  return <section aria-label="Tentative allocation plan" style={{ marginTop: 30, paddingTop: 20, borderTop: '3px solid #304e75' }}>
    <h2>Tentative allocation plan</h2><p>This local draft does not change committed work or book resources.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', padding: 12, background: '#edf3fa' }}>
      <label>Work item <select data-eval="plan-work-item" value={workId} onChange={e => setWorkId(e.target.value)}>{source.work_items.map((w: any) => <option key={w.work_item_id} value={w.work_item_id}>{w.work_item_id} · {w.required_skill} · {w.team_id}</option>)}</select></label>
      <label>Resource <select data-eval="plan-resource" value={resourceId} onChange={e => setResourceId(e.target.value)}>{source.resources.map((r: any) => <option key={r.resource_id} value={r.resource_id}>{r.resource_id} · {r.display_name} · {r.team_id}</option>)}</select></label>
      <label>Date <select data-eval="plan-date" value={planDate} onChange={e => setPlanDate(e.target.value)}>{dates.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label>Minutes <input data-eval="plan-minutes" type="number" min="15" step="15" value={minutes} onChange={e => setMinutes(e.target.value)} style={{ width: 90 }} /></label>
      <button data-eval="plan-add" onClick={add}>Add allocation</button>
    </div>
    <h3>Local draft: {local.draft_id}</h3>
    <table data-eval="draft-table" style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Allocation', 'Work item', 'Resource', 'Date', 'Tentative minutes', 'Action'].map(h => <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #a9b4c6', padding: 7 }}>{h}</th>)}</tr></thead><tbody>{local.allocations.map(a => <tr key={a.allocation_id} data-eval="draft-row" data-eval-key={a.allocation_id}><td>{a.allocation_id}</td><td>{a.work_item_id}</td><td>{a.resource_id}</td><td>{a.date}</td><td><input aria-label={`Minutes for ${a.allocation_id}`} data-eval="draft-line-minutes" data-eval-key={a.allocation_id} type="number" min="15" step="15" value={a.minutes} onChange={e => editMinutes(a.allocation_id, e.target.value)} style={{ width: 90 }} /></td><td><button data-eval="draft-line-remove" data-eval-key={a.allocation_id} onClick={() => remove(a.allocation_id)}>Remove</button></td></tr>)}</tbody></table>
    {local.allocations.length === 0 && <p>The local draft has no allocations.</p>}
    <div data-eval="draft-error" role={storeError || errors.length ? 'alert' : undefined} style={{ color: '#8b1d1d', marginTop: 10 }}>{storeError || errors[0] || ''}</div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
      <button data-eval="draft-save" onClick={save} disabled={pending || !authority.canWrite || !!errors.length || !dirty || reviewRequired}>{pending ? 'Saving…' : 'Save draft'}</button>
      <button data-eval="conflict-review" onClick={() => readAuthority(true)}>Review current authority</button>
      <button data-eval="draft-discard" onClick={() => { const next = clone(authority.draft); setLocal(next); setSavedSerial(serial(cleanDraft(next))); setReviewRequired(false); setSaveState('Local edits discarded; authoritative draft restored.'); }}>Discard local edits</button>
      <strong data-eval="draft-dirty-state">{dirty ? 'Unsaved local edits' : 'Local draft matches saved snapshot'}</strong>
    </div>
    <p data-eval="draft-save-state" role="status">{saveState}{!authority.canWrite ? ' Verified capability is read-only.' : ''}</p>
    {(showAuthority || reviewRequired) && <div data-eval="authority-review" style={{ border: '1px solid #b98324', padding: 12, margin: '12px 0', background: '#fff8e8' }}><h3>Authoritative draft review</h3><p>Stored revision: {authority.revision}. Capability: {authority.canWrite ? 'writable' : 'read-only'}.</p><p>{authority.draft.allocations.length} stored allocation(s): {authority.draft.allocations.map(a => `${a.allocation_id} ${a.work_item_id}/${a.resource_id}/${a.date}/${a.minutes}m`).join('; ') || 'none'}.</p>{reviewRequired && <p>Your local draft is still unchanged. Choose what happens next.</p>}<button data-eval="draft-reapply" disabled={!reviewRequired || !authority.canWrite} onClick={() => { setReviewRequired(false); setSaveState('Local edits retained against the reviewed revision; they remain unsaved.'); }}>Reapply local edits</button></div>}
    <h3>Resource/day capacity preview</h3>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th>Resource/day</th><th>Residual after committed</th><th>Tentative planned</th><th>Capacity after plan</th></tr></thead><tbody>{source.roster.map((r: any) => { const key = `${r.resource_id}|${r.date}`, planned = plannedByCapacity[key] || 0, residual = r.available_minutes - r.committed_minutes; return <tr key={key} data-eval="draft-capacity" data-eval-key={key}><td>{r.resource_id} · {r.date}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{residual}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{residual - planned}</td></tr>; })}</tbody></table>
    <h3>Work remaining preview</h3>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th>Work item</th><th>Source remaining</th><th>Tentative planned</th><th>Remaining after plan</th></tr></thead><tbody>{source.work_items.map((w: any) => { const planned = plannedByWork[w.work_item_id] || 0; return <tr key={w.work_item_id} data-eval="draft-work" data-eval-key={w.work_item_id}><td>{w.work_item_id}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{w.remaining_minutes}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td><td data-eval="draft-work-value" data-eval-key={w.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{w.remaining_minutes - planned}</td></tr>; })}</tbody></table>
  </section>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<any>(null);
  const [initial, setInitial] = useState<Authority | null>(null);
  const [error, setError] = useState('');
  const [refreshState, setRefreshState] = useState('');
  useEffect(() => { let live = true; (async () => { try {
    const [resourcesEntry, draftEntry] = await Promise.all([readFile('./resources.json'), readFile('./draft.json')]);
    if (!resourcesEntry) throw new Error('Resource source is unavailable.');
    if (!draftEntry) throw new Error('Draft source is unavailable.');
    if (!draftEntry.revision) throw new Error('Draft revision is unavailable; saving cannot be authorized.');
    const resources = JSON.parse(await resourcesEntry.file.text()); const draft = JSON.parse(await draftEntry.file.text());
    if (!validSource(resources)) throw new Error('Resource source is invalid.');
    if (!validDraftShape(draft)) throw new Error('Draft source is invalid.');
    if (live) { setSource(resources); setInitial({ draft, revision: draftEntry.revision, canWrite: draftEntry.canWrite }); }
  } catch (e: any) { if (live) setError(e?.message || 'Planning sources are unavailable.'); } })(); return () => { live = false; }; }, []);
  async function refresh() { setRefreshState('Refreshing…'); try { const next = await callFunction('load-data', {}); if (!validSource(next)) throw new Error('Refresh returned invalid resource data.'); setSource(next); setRefreshState(`Resources refreshed from snapshot ${next.snapshot_revision}.`); } catch (e: any) { setRefreshState(e?.message || 'Resource refresh failed.'); } }
  return <main data-eval="planner-root" style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1120, margin: 'auto', padding: 20, color: '#17263a' }}><h1>Resource planning</h1>{error ? <p role="alert">{error}</p> : source && initial ? <><button data-eval="refresh-resources" onClick={refresh}>Refresh resource source</button><span role="status" style={{ marginLeft: 10 }}>{refreshState}</span><ResourceView source={source} draft={initial.draft} /><Planner source={source} initial={initial} /></> : <p role="status">Loading resources and draft</p>}</main>;
}
