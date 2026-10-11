import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, writeFile, callFunction, triggerUserFileDownload } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Resource = { resource_id: string; display_name: string; team_id: string; skills: string[] };
type RosterRow = { resource_id: string; date: string; available_minutes: number; committed_minutes: number };
type WorkItem = { work_item_id: string; team_id: string; required_skill: string; remaining_minutes: number; earliest_date: string; due_date: string };
type ResourceSource = { schema_version: 'resource-plan-1'; snapshot_revision: string; default_date: string; teams: Team[]; resources: Resource[]; roster: RosterRow[]; work_items: WorkItem[] };
type Allocation = { allocation_id: string; work_item_id: string; resource_id: string; date: string; minutes: number };
type PlanDraft = { draft_id: string; allocations: Allocation[] };
type StoredDraft = { draft: PlanDraft; revision: string | null; canWrite: boolean };
type Validation = { errors: string[]; byAllocation: Record<string, string[]> };

const shellStyle: React.CSSProperties = { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', maxWidth: 1260, margin: '0 auto', padding: 24, color: '#17243b' };
const panelStyle: React.CSSProperties = { background: '#fff', border: '1px solid #dce4ef', borderRadius: 14, padding: 20, marginTop: 18, boxShadow: '0 4px 16px rgba(22, 41, 72, 0.045)' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 650, color: '#3d4d66' };
const inputStyle: React.CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 7, minHeight: 36, padding: '6px 9px', background: '#fff', color: '#17243b', font: 'inherit' };
const buttonStyle: React.CSSProperties = { border: '1px solid #c6d1df', borderRadius: 8, padding: '8px 12px', background: '#fff', color: '#20334f', fontWeight: 700, cursor: 'pointer' };
const primaryButtonStyle: React.CSSProperties = { ...buttonStyle, color: '#fff', borderColor: '#2659b8', background: '#2659b8' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 14, fontSize: 13 };
const thStyle: React.CSSProperties = { padding: '10px 9px', borderBottom: '1px solid #dce4ef', textAlign: 'left', color: '#42536d', fontWeight: 750, whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '9px', borderBottom: '1px solid #edf1f6', verticalAlign: 'top' };

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, any>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertSource(value: unknown): ResourceSource {
  if (!isRecord(value) || value.schema_version !== 'resource-plan-1' || typeof value.snapshot_revision !== 'string' || !value.snapshot_revision || !isDateString(value.default_date)) {
    throw new Error('The deterministic resource source does not match the declared resource-plan schema.');
  }
  if (!hasOnlyKeys(value, ['schema_version', 'snapshot_revision', 'default_date', 'teams', 'resources', 'roster', 'work_items'])) throw new Error('The deterministic resource source contains undeclared fields.');
  if (!Array.isArray(value.teams) || !Array.isArray(value.resources) || !Array.isArray(value.roster) || !Array.isArray(value.work_items)) {
    throw new Error('The deterministic resource source is missing a required list.');
  }
  const teams: Team[] = value.teams.map((item: any) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['team_id', 'display_name']) || typeof item.team_id !== 'string' || !item.team_id || typeof item.display_name !== 'string') throw new Error('A team row is invalid.');
    return { team_id: item.team_id, display_name: item.display_name };
  });
  const resources: Resource[] = value.resources.map((item: any) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['resource_id', 'display_name', 'team_id', 'skills']) || typeof item.resource_id !== 'string' || !item.resource_id || typeof item.display_name !== 'string' || typeof item.team_id !== 'string' || !item.team_id || !Array.isArray(item.skills) || !item.skills.every((skill: unknown) => skill === 'EMAIL' || skill === 'CHAT') || new Set(item.skills).size !== item.skills.length) throw new Error('A resource row is invalid.');
    return { resource_id: item.resource_id, display_name: item.display_name, team_id: item.team_id, skills: [...item.skills] };
  });
  const roster: RosterRow[] = value.roster.map((item: any) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['resource_id', 'date', 'available_minutes', 'committed_minutes']) || typeof item.resource_id !== 'string' || !item.resource_id || !isDateString(item.date) || !Number.isInteger(item.available_minutes) || item.available_minutes < 0 || !Number.isInteger(item.committed_minutes) || item.committed_minutes < 0) throw new Error('A resource/day capacity row is invalid.');
    return { resource_id: item.resource_id, date: item.date, available_minutes: item.available_minutes, committed_minutes: item.committed_minutes };
  });
  const work_items: WorkItem[] = value.work_items.map((item: any) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['work_item_id', 'team_id', 'required_skill', 'remaining_minutes', 'earliest_date', 'due_date']) || typeof item.work_item_id !== 'string' || !item.work_item_id || typeof item.team_id !== 'string' || !item.team_id || (item.required_skill !== 'EMAIL' && item.required_skill !== 'CHAT') || !Number.isInteger(item.remaining_minutes) || item.remaining_minutes < 0 || !isDateString(item.earliest_date) || !isDateString(item.due_date)) throw new Error('A work-item row is invalid.');
    return { work_item_id: item.work_item_id, team_id: item.team_id, required_skill: item.required_skill, remaining_minutes: item.remaining_minutes, earliest_date: item.earliest_date, due_date: item.due_date };
  });
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(teams.map((item) => item.team_id)) || !unique(resources.map((item) => item.resource_id)) || !unique(work_items.map((item) => item.work_item_id))) throw new Error('The resource source contains duplicate identity keys.');
  return { schema_version: 'resource-plan-1', snapshot_revision: value.snapshot_revision, default_date: value.default_date, teams, resources, roster, work_items };
}

function assertDraft(value: unknown): PlanDraft {
  if (!isRecord(value) || typeof value.draft_id !== 'string' || !value.draft_id || !Array.isArray(value.allocations)) throw new Error('The existing draft does not match the declared draft schema.');
  if (Object.keys(value).some((key) => key !== 'draft_id' && key !== 'allocations')) throw new Error('The existing draft contains undeclared fields.');
  const allocations: Allocation[] = value.allocations.map((item: any) => {
    if (!isRecord(item) || typeof item.allocation_id !== 'string' || !item.allocation_id || typeof item.work_item_id !== 'string' || !item.work_item_id || typeof item.resource_id !== 'string' || !item.resource_id || !isDateString(item.date) || !Number.isInteger(item.minutes) || item.minutes < 15 || item.minutes % 15 !== 0 || Object.keys(item).some((key) => !['allocation_id', 'work_item_id', 'resource_id', 'date', 'minutes'].includes(key))) throw new Error('An allocation in the existing draft does not match the declared draft schema.');
    return { allocation_id: item.allocation_id, work_item_id: item.work_item_id, resource_id: item.resource_id, date: item.date, minutes: item.minutes };
  });
  if (new Set(allocations.map((item) => item.allocation_id)).size !== allocations.length) throw new Error('The existing draft contains duplicate allocation IDs.');
  return { draft_id: value.draft_id, allocations };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

async function readStoredDraft(): Promise<StoredDraft> {
  const entry = await readFile('./draft.json');
  if (!entry) throw new Error('The existing draft file could not be read. It was not recreated.');
  if (!entry.file || typeof entry.file.text !== 'function') throw new Error('The draft read did not include file content.');
  const parsed = JSON.parse(await entry.file.text());
  return { draft: assertDraft(parsed), revision: typeof entry.revision === 'string' ? entry.revision : null, canWrite: entry.canWrite === true };
}

function allocationMinutes(allocation: Allocation, minuteInputs: Record<string, string>): number {
  const raw = minuteInputs[allocation.allocation_id];
  return raw === undefined ? allocation.minutes : Number(raw);
}

function validateDraft(source: ResourceSource, draft: PlanDraft, minuteInputs: Record<string, string>): Validation {
  const errors: string[] = [];
  const byAllocation: Record<string, string[]> = {};
  const addLineError = (id: string, message: string) => {
    if (!byAllocation[id]) byAllocation[id] = [];
    if (!byAllocation[id].includes(message)) byAllocation[id].push(message);
    if (!errors.includes(message)) errors.push(message);
  };
  const resourceById = new Map<string, Resource>(source.resources.map((item) => [item.resource_id, item] as [string, Resource]));
  const workById = new Map<string, WorkItem>(source.work_items.map((item) => [item.work_item_id, item] as [string, WorkItem]));
  const rosterByKey = new Map<string, RosterRow>(source.roster.map((item) => [item.resource_id + '|' + item.date, item] as [string, RosterRow]));
  const capacityTotals = new Map<string, number>();
  const workTotals = new Map<string, number>();
  const seenIds = new Set<string>();

  for (const line of draft.allocations) {
    if (!line.allocation_id || seenIds.has(line.allocation_id)) addLineError(line.allocation_id || '(missing allocation ID)', 'Allocation IDs must be present and unique.');
    seenIds.add(line.allocation_id);
    const amount = allocationMinutes(line, minuteInputs);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount % 15 !== 0) addLineError(line.allocation_id, 'Minutes must be a positive whole number divisible by 15.');

    const item = workById.get(line.work_item_id);
    const resource = resourceById.get(line.resource_id);
    if (!item) addLineError(line.allocation_id, 'Choose a work item from the current source.');
    if (!resource) addLineError(line.allocation_id, 'Choose a resource from the current source.');
    if (!source.roster.some((row) => row.date === line.date)) addLineError(line.allocation_id, 'Choose a calendar date present in the source roster.');
    if (item && resource) {
      if (resource.team_id !== item.team_id) addLineError(line.allocation_id, 'The resource must belong to the work item team.');
      if (!resource.skills.includes(item.required_skill)) addLineError(line.allocation_id, 'The resource must have the work item required skill.');
      if (line.date < item.earliest_date || line.date > item.due_date) addLineError(line.allocation_id, 'The plan date must be on or after earliest date and on or before due date.');
    }
    if (resource && !rosterByKey.has(resource.resource_id + '|' + line.date)) addLineError(line.allocation_id, 'The resource has no capacity row for this date.');

    if (Number.isFinite(amount)) {
      if (rosterByKey.has(line.resource_id + '|' + line.date)) {
        const key = line.resource_id + '|' + line.date;
        capacityTotals.set(key, (capacityTotals.get(key) || 0) + amount);
      }
      if (item) workTotals.set(item.work_item_id, (workTotals.get(item.work_item_id) || 0) + amount);
    }
  }

  for (const [key, planned] of capacityTotals.entries()) {
    const row = rosterByKey.get(key);
    if (!row) continue;
    const residual = row.available_minutes - row.committed_minutes;
    if (planned > residual) {
      const date = key.slice(-10);
      const resourceId = key.slice(0, -11);
      const message = 'Planned minutes for ' + resourceId + ' on ' + date + ' exceed its residual committed capacity (' + residual + ' min).';
      if (!errors.includes(message)) errors.push(message);
      for (const line of draft.allocations) if (line.resource_id === resourceId && line.date === date) addLineError(line.allocation_id, message);
    }
  }
  for (const [workId, planned] of workTotals.entries()) {
    const item = workById.get(workId);
    if (!item || planned <= item.remaining_minutes) continue;
    const message = 'Planned minutes for ' + workId + ' exceed remaining work (' + item.remaining_minutes + ' min).';
    if (!errors.includes(message)) errors.push(message);
    for (const line of draft.allocations) if (line.work_item_id === workId) addLineError(line.allocation_id, message);
  }
  return { errors, byAllocation };
}

function ResourceView({ source }: { source: ResourceSource }) {
  const [team, setTeam] = useState('');
  const [date, setDate] = useState(source.default_date);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'resource_id_asc' | 'resource_id_desc'>('resource_id_asc');
  const [details, setDetails] = useState('');
  const rowsById = useRef<Record<string, HTMLTableRowElement | null>>({});
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dates = Array.from(new Set(source.roster.map((row) => row.date)));
  const viewDate = dates.includes(date) ? date : (dates.includes(source.default_date) ? source.default_date : dates[0] || '');
  const rows = source.roster.filter((row) => row.date === viewDate)
    .map((row) => ({ ...row, ...source.resources.find((item) => item.resource_id === row.resource_id) }))
    .filter((row) => Boolean(row.resource_id) && (!team || row.team_id === team) && (!search || (row.resource_id + ' ' + row.display_name).toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (a.resource_id! < b.resource_id! ? -1 : a.resource_id! > b.resource_id! ? 1 : 0) * (sort === 'resource_id_asc' ? 1 : -1));
  const selected = source.resources.find((item) => item.resource_id === details);

  useEffect(() => { if (details) closeButton.current?.focus(); }, [details]);

  function closeDetails() {
    const old = details;
    setDetails('');
    rowsById.current[old]?.focus();
  }

  async function downloadCsv() {
    const columns = ['resource_id', 'display_name', 'team_id', 'date', 'available_minutes', 'committed_minutes', 'residual_minutes'];
    const quote = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const csvText = [columns.join(','), ...rows.map((row: any) => columns.map((key) => quote(key === 'residual_minutes' ? row.available_minutes - row.committed_minutes : row[key])).join(','))].join('\r\n') + '\r\n';
    try {
      await triggerUserFileDownload({ content: csvText, filename: 'capacity.csv' });
    } catch {
      // The download is deliberately local and requires a direct user activation.
    }
  }

  return <section aria-label="Existing capacity view" style={panelStyle}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <div><h2 style={{ margin: 0, fontSize: 20 }}>Resource capacity</h2><p style={{ margin: '6px 0 0', color: '#63738b', fontSize: 13 }}>Committed minutes and residual capacity are source facts. Tentative plan minutes appear in the editor below.</p></div>
      <span style={{ color: '#60718a', fontSize: 12 }}>Source snapshot {source.snapshot_revision}</span>
    </div>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginTop: 16 }}>
      <label style={labelStyle}>Team <select data-eval="legacy-team-filter" style={inputStyle} value={team} onChange={(event) => setTeam(event.target.value)}><option value="">All teams</option>{source.teams.map((item) => <option key={item.team_id} value={item.team_id}>{item.display_name} ({item.team_id})</option>)}</select></label>
      <label style={labelStyle}>Date <select data-eval="legacy-date-filter" style={inputStyle} value={viewDate} onChange={(event) => setDate(event.target.value)}>{dates.map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
      <label style={labelStyle}>Search <input data-eval="legacy-search" style={inputStyle} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Resource ID or name" /></label>
      <label style={labelStyle}>Order <select data-eval="legacy-sort" style={inputStyle} value={sort} onChange={(event) => setSort(event.target.value as 'resource_id_asc' | 'resource_id_desc')}><option value="resource_id_asc">Resource ID ascending</option><option value="resource_id_desc">Resource ID descending</option></select></label>
      <button data-eval="legacy-reset" style={buttonStyle} onClick={() => { setTeam(''); setDate(source.default_date); setSearch(''); setSort('resource_id_asc'); }}>Reset view</button>
      <button data-eval="legacy-export" style={buttonStyle} onClick={downloadCsv}>Download capacity CSV</button>
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table data-eval="resource-table" style={tableStyle}>
        <thead><tr>{['Resource ID', 'Name', 'Team', 'Date', 'Available minutes', 'Committed minutes', 'Residual minutes'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
        <tbody>{rows.map((row: any) => <tr key={row.resource_id} data-eval="resource-row" data-eval-key={row.resource_id} role="button" aria-label={'Open details for ' + row.resource_id} tabIndex={0} ref={(element) => { rowsById.current[row.resource_id] = element; }} onClick={() => setDetails(row.resource_id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDetails(row.resource_id); } }} style={{ cursor: 'pointer', background: details === row.resource_id ? '#f0f5ff' : '#fff' }}>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="resource_id" style={tdStyle}>{row.resource_id}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="display_name" style={tdStyle}>{row.display_name}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="team_id" style={tdStyle}>{row.team_id}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="date" style={tdStyle}>{row.date}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes" style={tdStyle}>{row.available_minutes}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes" style={tdStyle}>{row.committed_minutes}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes" style={tdStyle}>{row.available_minutes - row.committed_minutes}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {rows.length === 0 && <p style={{ color: '#65758c' }}>No matching resource/day rows.</p>}
    {selected && <aside data-eval="resource-details" data-eval-key={selected.resource_id} aria-label="Resource details" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeDetails(); } }} style={{ marginTop: 14, padding: 14, border: '1px solid #b7c9e4', borderRadius: 10, background: '#f7faff' }}><p style={{ marginTop: 0 }}>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p><button ref={closeButton} style={buttonStyle} onClick={closeDetails}>Close resource details</button></aside>}
  </section>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<ResourceSource | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceRefreshing, setSourceRefreshing] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState('');
  const [authority, setAuthority] = useState<StoredDraft | null>(null);
  const [localDraft, setLocalDraft] = useState<PlanDraft | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [lineMinutes, setLineMinutes] = useState<Record<string, string>>({});
  const [planWorkItem, setPlanWorkItem] = useState('');
  const [planResource, setPlanResource] = useState('');
  const [planDate, setPlanDate] = useState('');
  const [planMinutes, setPlanMinutes] = useState('15');
  const [planError, setPlanError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveState, setSaveState] = useState('');
  const [needsReapply, setNeedsReapply] = useState(false);
  const [reviewedAuthority, setReviewedAuthority] = useState<StoredDraft | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [sourceRefreshNotice, setSourceRefreshNotice] = useState('');
  const localIdCounter = useRef(1);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await callFunction('load-data', {});
        const data = assertSource(result);
        if (live) { setSource(data); setSourceError(''); }
      } catch (error: any) {
        if (live) setSourceError(error?.message || 'The deterministic resource source is unavailable.');
      } finally {
        if (live) setSourceLoading(false);
      }
    })();
    (async () => {
      try {
        const loaded = await readStoredDraft();
        if (!live) return;
        setAuthority(loaded);
        setLocalDraft(loaded.draft);
        setSavedSnapshot(stableStringify(loaded.draft));
        setLineMinutes(Object.fromEntries(loaded.draft.allocations.map((line) => [line.allocation_id, String(line.minutes)])));
        setDraftLoadError('');
      } catch (error: any) {
        if (live) setDraftLoadError(error?.message || 'The existing draft is unavailable.');
      }
    })();
    return () => { live = false; };
  }, []);

  const rosterDates = useMemo(() => source ? Array.from(new Set(source.roster.map((row) => row.date))) : [], [source]);
  const workForForm = source ? (source.work_items.find((item) => item.work_item_id === planWorkItem) || source.work_items[0]) : undefined;
  const formWorkId = workForForm?.work_item_id || '';
  const formDate = source ? (rosterDates.includes(planDate) ? planDate : (rosterDates.includes(source.default_date) ? source.default_date : rosterDates[0] || '')) : '';
  const formResourceId = source ? (source.resources.some((item) => item.resource_id === planResource) ? planResource : (source.resources.find((resource) => resource.team_id === workForForm?.team_id && resource.skills.includes(workForForm?.required_skill || '') && source.roster.some((row) => row.resource_id === resource.resource_id && row.date === formDate))?.resource_id || source.resources[0]?.resource_id || '')) : '';
  const viewableSource = source;
  const currentValidation = source && localDraft ? validateDraft(source, localDraft, lineMinutes) : { errors: [], byAllocation: {} };
  const effectiveDraft = localDraft ? {
    ...localDraft,
    allocations: localDraft.allocations.map((line) => {
      const amount = allocationMinutes(line, lineMinutes);
      return Number.isFinite(amount) && Number.isInteger(amount) ? { ...line, minutes: amount } : line;
    })
  } : null;
  const localSnapshot = effectiveDraft ? stableStringify(effectiveDraft) : '';
  const rawQuantityDirty = Boolean(localDraft && localDraft.allocations.some((line) => {
    const raw = lineMinutes[line.allocation_id];
    return raw !== undefined && (raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) !== line.minutes);
  }));
  const isDirty = Boolean(localDraft && (localSnapshot !== savedSnapshot || rawQuantityDirty));
  const canWrite = Boolean(authority && authority.canWrite && authority.revision !== null && authority.revision.length > 0 && !needsReapply);
  const saveDisabledReason = !localDraft ? 'The existing draft must be readable before it can be edited or saved.'
    : !authority ? 'The existing draft authority is not available.'
      : !authority.canWrite ? 'The source reports that the existing draft is read-only.'
        : authority.revision === null || authority.revision.length === 0 ? 'The current draft read did not provide a usable revision, so it cannot be written safely.'
          : needsReapply ? 'Review current authority and explicitly reapply your local edits before saving.'
            : currentValidation.errors.length ? 'Resolve the allocation validation issues before saving.'
              : !isDirty ? 'There are no unsaved draft changes.'
                : '';

  async function refreshSource() {
    setSourceRefreshing(true);
    setSourceRefreshNotice('');
    try {
      const result = await callFunction('load-data', {});
      const refreshed = assertSource(result);
      setSource(refreshed);
      setSourceError('');
      setSourceRefreshNotice('Resource source refreshed. Existing local draft lines were retained and revalidated.');
    } catch (error: any) {
      setSourceRefreshNotice(error?.message || 'Resource refresh failed. The current source and local draft were retained.');
    } finally {
      setSourceRefreshing(false);
    }
  }

  function handleLineMinutes(allocationId: string, raw: string) {
    setPlanError('');
    setLineMinutes((current) => ({ ...current, [allocationId]: raw }));
    if (localDraft && raw.trim() !== '' && Number.isInteger(Number(raw))) {
      const amount = Number(raw);
      setLocalDraft((current) => current ? { ...current, allocations: current.allocations.map((line) => line.allocation_id === allocationId ? { ...line, minutes: amount } : line) } : current);
    }
  }

  function updateLine(allocationId: string, field: 'work_item_id' | 'resource_id' | 'date', value: string) {
    setPlanError('');
    setLocalDraft((current) => current ? { ...current, allocations: current.allocations.map((line) => line.allocation_id === allocationId ? { ...line, [field]: value } : line) } : current);
  }

  function addAllocation() {
    if (!source || !localDraft) return;
    setPlanError('');
    const amount = Number(planMinutes);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount % 15 !== 0) {
      setPlanError('Minutes must be a positive whole number divisible by 15. No allocation was added.');
      return;
    }
    const usedIds = new Set(localDraft.allocations.map((line) => line.allocation_id));
    let allocationId = '';
    do { allocationId = 'local-' + localIdCounter.current++; } while (usedIds.has(allocationId));
    const candidate: Allocation = { allocation_id: allocationId, work_item_id: formWorkId, resource_id: formResourceId, date: formDate, minutes: amount };
    const nextDraft: PlanDraft = { ...localDraft, allocations: [...localDraft.allocations, candidate] };
    const nextMinutes = { ...lineMinutes, [allocationId]: String(amount) };
    const result = validateDraft(source, nextDraft, nextMinutes);
    if (result.errors.length) {
      setPlanError('No allocation was added. ' + result.errors.join(' '));
      return;
    }
    setLocalDraft(nextDraft);
    setLineMinutes(nextMinutes);
    setPlanError('');
    setPlanMinutes('15');
  }

  function removeAllocation(allocationId: string) {
    setLocalDraft((current) => current ? { ...current, allocations: current.allocations.filter((line) => line.allocation_id !== allocationId) } : current);
    setLineMinutes((current) => { const copy = { ...current }; delete copy[allocationId]; return copy; });
    setPlanError('');
  }

  async function reconcileAfterUncertainSave(submitted: PlanDraft, submittedKey: string, originalMessage: string) {
    try {
      const latest = await readStoredDraft();
      const latestKey = stableStringify(latest.draft);
      if (latestKey === submittedKey) {
        setAuthority(latest);
        setSavedSnapshot(submittedKey);
        setNeedsReapply(false);
        setReviewedAuthority(null);
        setSaveState('The submitted draft snapshot was confirmed by rereading the existing draft file. This confirms a draft save only; no resource was booked.');
      } else {
        setReviewedAuthority(latest);
        setNeedsReapply(true);
        setSaveState(originalMessage + ' A fresh read found different current authority. Your local draft is unchanged; review the current version before deciding whether to reapply or discard.');
      }
    } catch (error: any) {
      setNeedsReapply(true);
      setSaveState(originalMessage + ' The actual draft could not be verified on reread, so another Save is blocked until you review the current authority. Your local edits are retained.');
      setReviewError(error?.message || 'The current saved draft could not be reread.');
    }
  }

  async function saveDraft() {
    if (savingRef.current || !source || !localDraft || !authority) return;
    const validation = validateDraft(source, localDraft, lineMinutes);
    if (validation.errors.length) { setPlanError('Resolve the validation issues before saving.'); return; }
    if (!authority.canWrite) { setSaveState('Save was refused because the source reports that the draft is read-only. Local edits are retained.'); return; }
    if (authority.revision === null || authority.revision.length === 0) { setSaveState('Save is unavailable because the existing draft read supplied no usable revision. Local edits are retained.'); return; }
    if (needsReapply) { setSaveState('Review current authority and explicitly reapply your local edits before saving.'); return; }
    const submitted: PlanDraft = { ...localDraft, allocations: localDraft.allocations.map((line) => ({ ...line, minutes: Number(lineMinutes[line.allocation_id] ?? line.minutes) })) };
    const submittedKey = stableStringify(submitted);
    if (submittedKey === savedSnapshot && !rawQuantityDirty) return;
    const submittedText = JSON.stringify(submitted, null, 2) + '\n';
    const revisionAtSubmit = authority.revision;
    savingRef.current = true;
    setSaving(true);
    setPlanError('');
    setSaveState('Saving the selected draft snapshot. This is a draft save only; it does not book resources or mark work complete.');
    try {
      const result: any = await writeFile('./draft.json', submittedText, { revision: revisionAtSubmit, contentType: 'application/json' });
      if (result && result.success === true && typeof result.revision === 'string' && result.revision.length > 0) {
        try {
          const reread = await readStoredDraft();
          if (reread.revision === result.revision && stableStringify(reread.draft) === submittedKey) {
            setAuthority(reread);
            setSavedSnapshot(submittedKey);
            setNeedsReapply(false);
            setReviewedAuthority(null);
            setReviewError('');
            setSaveState('The submitted draft snapshot was saved and verified by rereading the existing file. Any newer edits remain local and unsaved; no resource was booked.');
          } else {
            setReviewedAuthority(reread);
            setNeedsReapply(true);
            setSaveState('The write returned success, but a reread did not confirm the submitted contents and revision together. No newer edits were replaced; review current authority before another Save.');
          }
        } catch (error: any) {
          setNeedsReapply(true);
          setSaveState('The write returned success, but the stored draft could not be verified by rereading. Your local edits are retained and further Save is blocked until review.');
          setReviewError(error?.message || 'The saved draft could not be verified.');
        }
      } else if (result && result.success === false && result.error?.code === 'read_only') {
        setAuthority((current) => current ? { ...current, canWrite: false } : current);
        setNeedsReapply(true);
        setReviewedAuthority(null);
        setSaveState('The controlled store refused this Save as read-only. Local edits are retained, and no alternate write path was used. Review current authority before any further decision.');
      } else if (result && result.success === false && result.error?.code === 'conflict') {
        setNeedsReapply(true);
        setReviewedAuthority(null);
        setSaveState('The draft revision changed before this Save was accepted. Your local edits were kept and no automatic retry was made. Review the current saved draft, then explicitly reapply or discard.');
      } else if (result && result.success === false && result.error?.code === 'save_failed') {
        await reconcileAfterUncertainSave(submitted, submittedKey, 'The Save result was unconfirmed (save_failed).');
      } else if (result && result.success === false) {
        setSaveState('The controlled store refused the draft write (' + String(result.error?.code || 'unknown') + '): ' + String(result.error?.message || 'No further detail was supplied.') + ' Local edits are retained.');
      } else {
        await reconcileAfterUncertainSave(submitted, submittedKey, 'The Save response was not in the declared result shape.');
      }
    } catch (error: any) {
      const message = error?.message || 'The Save call failed without a confirmed result.';
      await reconcileAfterUncertainSave(submitted, submittedKey, 'The Save outcome is uncertain (' + message + ').');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function reviewCurrentAuthority() {
    setReviewLoading(true);
    setReviewError('');
    try {
      const latest = await readStoredDraft();
      if (authority && (latest.revision !== authority.revision || latest.canWrite !== authority.canWrite || stableStringify(latest.draft) !== stableStringify(authority.draft))) setNeedsReapply(true);
      setReviewedAuthority(latest);
      setSaveState('Current saved draft and revision loaded for review. Local edits were not changed or submitted.');
    } catch (error: any) {
      setReviewedAuthority(null);
      setReviewError(error?.message || 'The current saved draft could not be reread.');
    } finally {
      setReviewLoading(false);
    }
  }

  function reapplyLocalAgainstReviewedAuthority() {
    if (!reviewedAuthority) return;
    if (!reviewedAuthority.canWrite || reviewedAuthority.revision === null || reviewedAuthority.revision.length === 0) {
      setSaveState('The reviewed authority is read-only or has no revision. Local edits remain available, but cannot be saved safely.');
      return;
    }
    setAuthority(reviewedAuthority);
    setSavedSnapshot(stableStringify(reviewedAuthority.draft));
    setNeedsReapply(false);
    setSaveState('Local edits were explicitly retained against the reviewed revision. Nothing has been saved yet; use Save draft changes to submit them.');
  }

  function discardLocalEdits() {
    const target = reviewedAuthority || authority;
    if (!target) return;
    setAuthority(target);
    setLocalDraft(target.draft);
    setLineMinutes(Object.fromEntries(target.draft.allocations.map((line) => [line.allocation_id, String(line.minutes)])));
    setSavedSnapshot(stableStringify(target.draft));
    setNeedsReapply(false);
    setReviewedAuthority(null);
    setPlanError('');
    setSaveState('Local edits were discarded by your choice and replaced with the reviewed saved draft.');
  }

  if (sourceLoading && !source) return <main data-eval="planner-root" style={{ ...shellStyle, minHeight: '100vh', background: '#f4f7fb' }}><h1>Resource planning</h1><p role="status">Loading resource source…</p></main>;
  if (!viewableSource) return <main data-eval="planner-root" style={{ ...shellStyle, minHeight: '100vh', background: '#f4f7fb' }}><h1>Resource planning</h1><p role="alert">{sourceError || 'The deterministic resource source is unavailable.'}</p></main>;

  const sourceForUi = viewableSource;
  const availableWorkItems = sourceForUi.work_items;
  const availableResources = sourceForUi.resources;
  const availableDates = rosterDates;

  return <main data-eval="planner-root" style={{ ...shellStyle, minHeight: '100vh', background: '#f4f7fb' }}>
    <header style={{ padding: '4px 0 8px' }}>
      <p style={{ margin: '0 0 5px', color: '#4269a8', textTransform: 'uppercase', letterSpacing: 1.1, fontWeight: 800, fontSize: 11 }}>Planning workspace</p>
      <h1 style={{ margin: 0, fontSize: 30, letterSpacing: '-0.03em' }}>Resource planning</h1>
      <p style={{ margin: '8px 0 0', color: '#63738b', maxWidth: 790 }}>Review committed capacity, build a tentative allocation plan, then explicitly save the draft. Saving a draft does not book resources or change committed work.</p>
    </header>

    <ResourceView source={sourceForUi} />

    <section aria-label="Allocation plan editor" style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div><h2 style={{ margin: 0, fontSize: 20 }}>Tentative allocation plan</h2><p style={{ margin: '6px 0 0', color: '#63738b', fontSize: 13 }}>These lines are local draft edits and remain separate from committed minutes above.</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span data-eval="draft-dirty-state" style={{ fontSize: 12, fontWeight: 800, padding: '6px 9px', borderRadius: 99, color: isDirty ? '#845700' : '#22634a', background: isDirty ? '#fff4d6' : '#e6f6ef' }}>{saving ? 'Save pending' : isDirty ? 'Unsaved local edits' : 'Current local draft matches the last verified saved snapshot'}</span>
          <button data-eval="refresh-resources" style={buttonStyle} disabled={sourceRefreshing} onClick={refreshSource}>{sourceRefreshing ? 'Refreshing source…' : 'Refresh resource source'}</button>
        </div>
      </div>
      {sourceRefreshNotice && <p role="status" style={{ color: '#52647d', fontSize: 13 }}>{sourceRefreshNotice}</p>}

      {draftLoadError ? <div role="alert" style={{ marginTop: 14, color: '#8d2c23', background: '#fff1ef', padding: 12, borderRadius: 8 }}>{draftLoadError} Planning edits and Save are unavailable until the existing draft can be read.</div> : !localDraft ? <p role="status" style={{ marginTop: 14 }}>Loading the existing draft…</p> : <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14, color: '#53647d', fontSize: 12 }}>
          <span>Draft ID: <strong>{localDraft.draft_id}</strong></span>
          <span>Resource snapshot: <strong>{sourceForUi.snapshot_revision}</strong></span>
          <span>Draft revision: <strong>{authority?.revision ?? 'unavailable'}</strong></span>
          <span>{authority?.canWrite ? 'Draft store reports writable' : 'Draft store reports read-only'}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'end', padding: 14, marginTop: 16, border: '1px solid #e2e9f2', borderRadius: 10, background: '#f9fbfe' }}>
          <label style={labelStyle}>Work item <select data-eval="plan-work-item" style={inputStyle} value={formWorkId} onChange={(event) => { setPlanError(''); setPlanWorkItem(event.target.value); }}>{availableWorkItems.map((item) => <option key={item.work_item_id} value={item.work_item_id}>{item.work_item_id} · {item.required_skill} · {item.team_id}</option>)}</select></label>
          <label style={labelStyle}>Resource <select data-eval="plan-resource" style={inputStyle} value={formResourceId} onChange={(event) => { setPlanError(''); setPlanResource(event.target.value); }}>{availableResources.map((item) => <option key={item.resource_id} value={item.resource_id}>{item.display_name} ({item.resource_id}) · {item.team_id}</option>)}</select></label>
          <label style={labelStyle}>Plan date <select data-eval="plan-date" style={inputStyle} value={formDate} onChange={(event) => { setPlanError(''); setPlanDate(event.target.value); }}>{availableDates.map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <label style={labelStyle}>Minutes <input data-eval="plan-minutes" style={inputStyle} type="number" min="15" step="15" inputMode="numeric" value={planMinutes} onChange={(event) => { setPlanError(''); setPlanMinutes(event.target.value); }} /></label>
          <button data-eval="plan-add" style={primaryButtonStyle} disabled={!source || !localDraft} onClick={addAllocation}>Add to local plan</button>
        </div>
        {workForForm && <p style={{ margin: '8px 0 0', color: '#687890', fontSize: 12 }}>Selected work item: {workForForm.required_skill} skill, team {workForForm.team_id}, eligible dates {workForForm.earliest_date} through {workForForm.due_date} inclusive. Quantity must be positive and in 15-minute increments.</p>}

        {planError && <div data-eval="draft-error" role="alert" style={{ marginTop: 12, color: '#8d2c23', background: '#fff1ef', border: '1px solid #f0c3bd', padding: 12, borderRadius: 8 }}>{planError}</div>}
        {!planError && currentValidation.errors.length > 0 && <div data-eval="draft-error" role="alert" style={{ marginTop: 12, color: '#8d2c23', background: '#fff8f6', border: '1px solid #f0c3bd', padding: 12, borderRadius: 8 }}><strong>Resolve these draft validation issues before saving:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>{currentValidation.errors.map((message) => <li key={message}>{message}</li>)}</ul></div>}

        <div style={{ marginTop: 18 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Local allocation lines</h3>
          <p style={{ margin: 0, color: '#63738b', fontSize: 12 }}>Changing a line or removing it changes only this local draft until you select Save.</p>
          <div style={{ overflowX: 'auto' }}>
            <table data-eval="draft-table" style={tableStyle}>
              <thead><tr>{['Work item', 'Resource', 'Date', 'Planned minutes', 'Line checks', ''].map((heading, index) => <th key={heading + index} style={thStyle}>{heading}</th>)}</tr></thead>
              <tbody>{localDraft.allocations.map((line) => {
                const lineErrors = currentValidation.byAllocation[line.allocation_id] || [];
                return <tr key={line.allocation_id} data-eval="draft-row" data-eval-key={line.allocation_id}>
                  <td style={tdStyle}><select aria-label={'Work item for ' + line.allocation_id} data-eval="draft-line-work-item" data-eval-key={line.allocation_id} style={{ ...inputStyle, minWidth: 165 }} value={line.work_item_id} onChange={(event) => updateLine(line.allocation_id, 'work_item_id', event.target.value)}>{!availableWorkItems.some((item) => item.work_item_id === line.work_item_id) && <option value={line.work_item_id}>{line.work_item_id} (not in source)</option>}{availableWorkItems.map((item) => <option key={item.work_item_id} value={item.work_item_id}>{item.work_item_id} · {item.required_skill}</option>)}</select></td>
                  <td style={tdStyle}><select aria-label={'Resource for ' + line.allocation_id} data-eval="draft-line-resource" data-eval-key={line.allocation_id} style={{ ...inputStyle, minWidth: 175 }} value={line.resource_id} onChange={(event) => updateLine(line.allocation_id, 'resource_id', event.target.value)}>{!availableResources.some((item) => item.resource_id === line.resource_id) && <option value={line.resource_id}>{line.resource_id} (not in source)</option>}{availableResources.map((item) => <option key={item.resource_id} value={item.resource_id}>{item.display_name} ({item.resource_id})</option>)}</select></td>
                  <td style={tdStyle}><select aria-label={'Date for ' + line.allocation_id} data-eval="draft-line-date" data-eval-key={line.allocation_id} style={inputStyle} value={line.date} onChange={(event) => updateLine(line.allocation_id, 'date', event.target.value)}>{!availableDates.includes(line.date) && <option value={line.date}>{line.date} (not in roster)</option>}{availableDates.map((day) => <option key={day} value={day}>{day}</option>)}</select></td>
                  <td style={tdStyle}><input aria-label={'Minutes for ' + line.allocation_id} data-eval="draft-line-minutes" data-eval-key={line.allocation_id} style={{ ...inputStyle, width: 110 }} type="number" min="15" step="15" inputMode="numeric" value={lineMinutes[line.allocation_id] ?? String(line.minutes)} onChange={(event) => handleLineMinutes(line.allocation_id, event.target.value)} /> <span style={{ color: '#63738b' }}>min</span></td>
                  <td style={{ ...tdStyle, color: lineErrors.length ? '#8d2c23' : '#66778e', minWidth: 200, fontSize: 12 }}>{lineErrors.length ? lineErrors.join(' ') : 'Valid for current source'}</td>
                  <td style={tdStyle}><button aria-label={'Remove allocation ' + line.allocation_id} data-eval="draft-line-remove" data-eval-key={line.allocation_id} style={buttonStyle} onClick={() => removeAllocation(line.allocation_id)}>Remove</button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {localDraft.allocations.length === 0 && <p style={{ color: '#65758c', fontSize: 13 }}>No allocation lines. Add one above to build a tentative plan.</p>}
        </div>

        <div style={{ marginTop: 22 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Tentative capacity by resource and day</h3>
          <p style={{ margin: 0, color: '#63738b', fontSize: 12 }}>Residual committed minutes equal available minus committed. The plan is subtracted separately to show capacity after tentative allocations.</p>
          <div style={{ overflowX: 'auto' }}><table style={tableStyle}>
            <thead><tr>{['Resource', 'Date', 'Available minutes', 'Committed minutes', 'Residual committed minutes', 'Tentative planned minutes', 'Capacity after plan'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
            <tbody>{sourceForUi.roster.map((row) => {
              const resource = sourceForUi.resources.find((item) => item.resource_id === row.resource_id);
              const key = row.resource_id + '|' + row.date;
              const planned = localDraft.allocations.filter((line) => line.resource_id === row.resource_id && line.date === row.date).reduce((sum, line) => { const amount = allocationMinutes(line, lineMinutes); return sum + (Number.isFinite(amount) ? amount : 0); }, 0);
              const residual = row.available_minutes - row.committed_minutes;
              return <tr key={key} data-eval="draft-capacity" data-eval-key={key}>
                <td style={tdStyle}>{resource?.display_name || row.resource_id} ({row.resource_id})</td><td style={tdStyle}>{row.date}</td>
                <td style={tdStyle} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="available_minutes" data-eval-unit="minutes">{row.available_minutes}</td>
                <td style={tdStyle} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="committed_minutes" data-eval-unit="minutes">{row.committed_minutes}</td>
                <td style={tdStyle} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes">{residual}</td>
                <td style={tdStyle} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td>
                <td style={{ ...tdStyle, fontWeight: 800, color: residual - planned < 0 ? '#a1372b' : '#243b59' }} data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes">{residual - planned}</td>
              </tr>;
            })}</tbody>
          </table></div>
        </div>

        <div style={{ marginTop: 22 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Tentative work remaining</h3>
          <p style={{ margin: 0, color: '#63738b', fontSize: 12 }}>Planned effort is deducted from source remaining effort for this preview only.</p>
          <div style={{ overflowX: 'auto' }}><table style={tableStyle}>
            <thead><tr>{['Work item', 'Team', 'Required skill', 'Source remaining minutes', 'Tentative planned minutes', 'Remaining after plan'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
            <tbody>{sourceForUi.work_items.map((item) => {
              const planned = localDraft.allocations.filter((line) => line.work_item_id === item.work_item_id).reduce((sum, line) => { const amount = allocationMinutes(line, lineMinutes); return sum + (Number.isFinite(amount) ? amount : 0); }, 0);
              const remaining = item.remaining_minutes - planned;
              return <tr key={item.work_item_id} data-eval="draft-work" data-eval-key={item.work_item_id}>
                <td style={tdStyle}>{item.work_item_id}</td><td style={tdStyle}>{item.team_id}</td><td style={tdStyle}>{item.required_skill}</td>
                <td style={tdStyle} data-eval="draft-work-value" data-eval-key={item.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes">{item.remaining_minutes}</td>
                <td style={tdStyle} data-eval="draft-work-value" data-eval-key={item.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes">{planned}</td>
                <td style={{ ...tdStyle, fontWeight: 800, color: remaining < 0 ? '#a1372b' : '#243b59' }} data-eval="draft-work-value" data-eval-key={item.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes">{remaining}</td>
              </tr>;
            })}</tbody>
          </table></div>
        </div>

        <div style={{ marginTop: 22, padding: 14, border: '1px solid #dfe7f1', borderRadius: 10, background: '#f9fbfe' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button data-eval="draft-save" style={primaryButtonStyle} disabled={saving || !canWrite || !isDirty || currentValidation.errors.length > 0} title={saveDisabledReason} onClick={saveDraft}>{saving ? 'Saving draft…' : 'Save draft changes'}</button>
            <button data-eval="draft-discard" style={buttonStyle} disabled={saving || (!isDirty && !needsReapply) || (needsReapply && !reviewedAuthority)} onClick={discardLocalEdits}>Discard local edits</button>
            <button style={buttonStyle} disabled={reviewLoading || saving} onClick={reviewCurrentAuthority}>{reviewLoading ? 'Reading current draft…' : 'Review current saved draft'}</button>
          </div>
          {!canWrite && <p style={{ margin: '8px 0 0', color: '#80621c', fontSize: 12 }}>{saveDisabledReason}</p>}
          <p data-eval="draft-save-state" role="status" aria-live="polite" style={{ margin: '10px 0 0', color: needsReapply || reviewError ? '#8d4b1c' : '#4c607a', fontSize: 13 }}>{saveState || (saving ? 'Save pending.' : 'No write has been requested in this session.')}</p>
          {needsReapply && <div data-eval="conflict-review" style={{ marginTop: 12, padding: 12, borderRadius: 8, border: '1px solid #efcf9b', background: '#fff8e9' }}>
            <strong>Review required before another Save</strong>
            <p style={{ margin: '5px 0 8px', fontSize: 13 }}>The current authority may differ from your local draft. No automatic retry or replacement was made. Read the current saved draft, then choose to reapply your local edits or discard them.</p>
            {!reviewedAuthority && <button style={buttonStyle} disabled={reviewLoading} onClick={reviewCurrentAuthority}>{reviewLoading ? 'Reading…' : 'Review current authority'}</button>}
          </div>}
          {reviewError && <p role="alert" style={{ color: '#8d2c23', fontSize: 13 }}>{reviewError}</p>}
          {reviewedAuthority && <div data-eval="authority-review" style={{ marginTop: 12, padding: 12, borderRadius: 8, border: '1px solid #b9cee8', background: '#f3f8ff' }}>
            <strong>Current saved authority (review only)</strong>
            <p style={{ margin: '5px 0 8px', fontSize: 13 }}>Revision: {reviewedAuthority.revision ?? 'unavailable'} · {reviewedAuthority.canWrite ? 'writable' : 'read-only'}. Reviewing did not change your local lines or submit a write.</p>
            <div style={{ overflowX: 'auto' }}><table style={{ ...tableStyle, marginTop: 4 }}>
              <thead><tr>{['Allocation ID', 'Work item', 'Resource', 'Date', 'Minutes'].map((heading) => <th key={heading} style={thStyle}>{heading}</th>)}</tr></thead>
              <tbody>{reviewedAuthority.draft.allocations.map((line) => <tr key={line.allocation_id}><td style={tdStyle}>{line.allocation_id}</td><td style={tdStyle}>{line.work_item_id}</td><td style={tdStyle}>{line.resource_id}</td><td style={tdStyle}>{line.date}</td><td style={tdStyle}>{line.minutes}</td></tr>)}</tbody>
            </table></div>
            {reviewedAuthority.draft.allocations.length === 0 && <p style={{ fontSize: 12 }}>The reviewed saved draft has no allocation lines.</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {needsReapply && <button data-eval="draft-reapply" style={buttonStyle} disabled={!reviewedAuthority.canWrite || reviewedAuthority.revision === null || reviewedAuthority.revision.length === 0} onClick={reapplyLocalAgainstReviewedAuthority}>Keep my local edits against this revision</button>}
              <button style={buttonStyle} onClick={discardLocalEdits}>Discard local edits and load this saved draft</button>
            </div>
          </div>}
        </div>
      </>}
    </section>
  </main>;
}
