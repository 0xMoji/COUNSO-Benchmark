import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, writeFile, callFunction } from '@dust/react-hooks';

type Allocation = {
  allocation_id: string;
  work_item_id: string;
  resource_id: string;
  date: string;
  minutes: number | string;
};

type Draft = {
  draft_id: string;
  allocations: Allocation[];
};

type StoredDraft = {
  draft: Draft;
  revision: string | null;
  canWrite: boolean;
};

const panelStyle: React.CSSProperties = {
  border: '1px solid #d7dce3',
  borderRadius: 10,
  padding: 16,
  marginTop: 18,
  background: '#fff'
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  marginTop: 12
};

const cellStyle: React.CSSProperties = {
  borderBottom: '1px solid #e6e9ee',
  padding: '9px 7px',
  textAlign: 'left',
  verticalAlign: 'top'
};

function isRecord(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value: any): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSource(value: any): boolean {
  if (!isRecord(value) || value.schema_version !== 'resource-plan-1' ||
      typeof value.snapshot_revision !== 'string' || !value.snapshot_revision ||
      !isDate(value.default_date) || !Array.isArray(value.teams) ||
      !Array.isArray(value.resources) || !Array.isArray(value.roster) ||
      !Array.isArray(value.work_items)) return false;
  if (!value.teams.every((t: any) => isRecord(t) && typeof t.team_id === 'string' && !!t.team_id && typeof t.display_name === 'string')) return false;
  if (!value.resources.every((r: any) => isRecord(r) && typeof r.resource_id === 'string' && !!r.resource_id && typeof r.display_name === 'string' && typeof r.team_id === 'string' && !!r.team_id && Array.isArray(r.skills) && r.skills.every((s: any) => typeof s === 'string'))) return false;
  if (!value.roster.every((r: any) => isRecord(r) && typeof r.resource_id === 'string' && !!r.resource_id && isDate(r.date) && Number.isInteger(r.available_minutes) && r.available_minutes >= 0 && Number.isInteger(r.committed_minutes) && r.committed_minutes >= 0)) return false;
  return value.work_items.every((w: any) => isRecord(w) && typeof w.work_item_id === 'string' && !!w.work_item_id && typeof w.team_id === 'string' && !!w.team_id && typeof w.required_skill === 'string' && Number.isInteger(w.remaining_minutes) && w.remaining_minutes >= 0 && isDate(w.earliest_date) && isDate(w.due_date));
}

function isDraft(value: any): boolean {
  return isRecord(value) && typeof value.draft_id === 'string' && !!value.draft_id &&
    Array.isArray(value.allocations) && value.allocations.every((a: any) =>
      isRecord(a) && typeof a.allocation_id === 'string' && !!a.allocation_id &&
      typeof a.work_item_id === 'string' && !!a.work_item_id &&
      typeof a.resource_id === 'string' && !!a.resource_id && isDate(a.date) &&
      Number.isInteger(a.minutes) && a.minutes >= 15 && a.minutes % 15 === 0
    );
}

function cloneDraft(draft: Draft): Draft {
  return {
    draft_id: draft.draft_id,
    allocations: draft.allocations.map((a) => ({
      allocation_id: a.allocation_id,
      work_item_id: a.work_item_id,
      resource_id: a.resource_id,
      date: a.date,
      minutes: a.minutes
    }))
  };
}

function normalizedDraft(draft: Draft): Draft {
  return {
    draft_id: draft.draft_id,
    allocations: draft.allocations.map((a) => ({
      allocation_id: a.allocation_id,
      work_item_id: a.work_item_id,
      resource_id: a.resource_id,
      date: a.date,
      minutes: Number(a.minutes)
    }))
  };
}

function draftKey(draft: Draft): string {
  return JSON.stringify({
    draft_id: draft.draft_id,
    allocations: draft.allocations.map((a) => ({
      allocation_id: a.allocation_id,
      work_item_id: a.work_item_id,
      resource_id: a.resource_id,
      date: a.date,
      minutes: a.minutes
    }))
  });
}

function validateDraft(source: any, draft: Draft): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const resourceTotals = new Map<string, { resourceId: string; date: string; minutes: number }>();
  const workTotals = new Map<string, number>();

  draft.allocations.forEach((allocation, index) => {
    const label = allocation.allocation_id || `line ${index + 1}`;
    if (!allocation.allocation_id || seen.has(allocation.allocation_id)) {
      errors.push(`${label}: allocation identity must be present and unique.`);
    }
    seen.add(allocation.allocation_id);
    const work = source.work_items.find((w: any) => w.work_item_id === allocation.work_item_id);
    const resource = source.resources.find((r: any) => r.resource_id === allocation.resource_id);
    const roster = source.roster.find((r: any) => r.resource_id === allocation.resource_id && r.date === allocation.date);
    const minutes = allocation.minutes;
    const validMinutes = typeof minutes === 'number' && Number.isFinite(minutes) && Number.isInteger(minutes) && minutes > 0 && minutes % 15 === 0;

    if (!work) errors.push(`${label}: choose a source work item.`);
    if (!resource) errors.push(`${label}: choose a source resource.`);
    if (!isDate(allocation.date) || !roster) errors.push(`${label}: choose a roster date for that resource.`);
    if (!validMinutes) errors.push(`${label}: minutes must be a positive whole number in 15-minute increments.`);
    if (work && resource) {
      if (resource.team_id !== work.team_id) errors.push(`${label}: resource and work item must belong to the same team.`);
      if (!resource.skills.includes(work.required_skill)) errors.push(`${label}: resource does not have the required ${work.required_skill} skill.`);
      if (isDate(allocation.date) && (allocation.date < work.earliest_date || allocation.date > work.due_date)) {
        errors.push(`${label}: date must be from ${work.earliest_date} through ${work.due_date}.`);
      }
    }
    if (validMinutes && work && resource && roster) {
      const resourceKey = JSON.stringify([allocation.resource_id, allocation.date]);
      const current = resourceTotals.get(resourceKey);
      resourceTotals.set(resourceKey, {
        resourceId: allocation.resource_id,
        date: allocation.date,
        minutes: (current?.minutes || 0) + Number(minutes)
      });
      workTotals.set(allocation.work_item_id, (workTotals.get(allocation.work_item_id) || 0) + Number(minutes));
    }
  });

  resourceTotals.forEach((total) => {
    const roster = source.roster.find((r: any) => r.resource_id === total.resourceId && r.date === total.date);
    if (roster) {
      const residual = roster.available_minutes - roster.committed_minutes;
      if (total.minutes > residual) {
        errors.push(`${total.resourceId} on ${total.date}: tentative ${total.minutes} minutes exceeds ${residual} minutes of residual committed capacity.`);
      }
    }
  });
  workTotals.forEach((total, workId) => {
    const work = source.work_items.find((w: any) => w.work_item_id === workId);
    if (work && total > work.remaining_minutes) {
      errors.push(`${workId}: tentative ${total} minutes exceeds ${work.remaining_minutes} source remaining minutes.`);
    }
  });
  return Array.from(new Set(errors));
}

async function readStoredDraft(): Promise<StoredDraft | null> {
  const entry = await readFile('./draft.json');
  if (!entry) return null;
  const parsed = JSON.parse(await entry.file.text());
  if (!isDraft(parsed)) throw new Error('Stored draft does not match the declared draft schema.');
  return { draft: cloneDraft(parsed), revision: entry.revision, canWrite: entry.canWrite };
}

function ResourceView({ source }: { source: any }) {
  const [team, setTeam] = useState('');
  const [date, setDate] = useState(source.default_date);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('resource_id_asc');
  const [details, setDetails] = useState('');
  const rowsById = useRef<Map<string, HTMLTableRowElement | null>>(new Map());
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const previousSource = useRef(source);
  const dates: string[] = Array.from(new Set<string>(source.roster.map((r: any) => r.date)));

  useEffect(() => {
    if (details) closeButton.current?.focus();
  }, [details]);

  useEffect(() => {
    if (previousSource.current !== source) {
      setDate(source.default_date);
      if (team && !source.teams.some((item: any) => item.team_id === team)) setTeam('');
      if (details && !source.resources.some((item: any) => item.resource_id === details)) setDetails('');
      previousSource.current = source;
    }
  }, [source, team, details]);

  const rows = source.roster
    .filter((r: any) => r.date === date)
    .map((r: any) => ({ ...r, ...source.resources.find((v: any) => v.resource_id === r.resource_id) }))
    .filter((r: any) => r.resource_id && (!team || r.team_id === team) && (!search || `${r.resource_id} ${r.display_name}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a: any, b: any) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0) * (sort === 'resource_id_asc' ? 1 : -1));
  const selected = source.resources.find((r: any) => r.resource_id === details);

  function close() {
    const old = details;
    setDetails('');
    window.setTimeout(() => rowsById.current.get(old)?.focus(), 0);
  }

  function csv() {
    const columns = ['resource_id', 'display_name', 'team_id', 'date', 'available_minutes', 'committed_minutes', 'residual_minutes'];
    const quote = (value: any) => `"${String(value).replace(/"/g, '""')}"`;
    const text = [
      columns.join(','),
      ...rows.map((row: any) => columns.map((key) => quote(key === 'residual_minutes' ? row.available_minutes - row.committed_minutes : row[key])).join(','))
    ].join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'capacity.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section aria-label="Existing capacity view" style={panelStyle}>
    <h2 style={{ marginTop: 0 }}>Resource capacity</h2>
    <p style={{ color: '#4b5563' }}>Committed capacity facts from source revision {source.snapshot_revision}. Tentative plan minutes below never change these values.</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
      <label>Team<br />
        <select data-eval="legacy-team-filter" value={team} onChange={(e) => setTeam(e.target.value)} style={{ minWidth: 190, padding: 7 }}>
          <option value="">All teams</option>
          {source.teams.map((t: any) => <option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}
        </select>
      </label>
      <label>Date<br />
        <select data-eval="legacy-date-filter" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: 7 }}>
          {dates.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <label>Search<br />
        <input data-eval="legacy-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ID or name" style={{ padding: 7 }} />
      </label>
      <label>Order<br />
        <select data-eval="legacy-sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ padding: 7 }}>
          <option value="resource_id_asc">Resource ID ascending</option>
          <option value="resource_id_desc">Resource ID descending</option>
        </select>
      </label>
      <button type="button" data-eval="legacy-reset" onClick={() => { setTeam(''); setDate(source.default_date); setSearch(''); setSort('resource_id_asc'); }} style={{ padding: '8px 12px' }}>Reset view</button>
      <button type="button" data-eval="legacy-export" onClick={csv} style={{ padding: '8px 12px' }}>Download capacity CSV</button>
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table data-eval="resource-table" style={tableStyle}>
        <thead><tr>{['Resource ID', 'Name', 'Team', 'Date', 'Available minutes', 'Committed minutes', 'Residual minutes'].map((heading) => <th key={heading} style={cellStyle}>{heading}</th>)}</tr></thead>
        <tbody>{rows.map((row: any) => <tr
          key={row.resource_id}
          data-eval="resource-row"
          data-eval-key={row.resource_id}
          role="button"
          tabIndex={0}
          ref={(element) => { rowsById.current.set(row.resource_id, element); }}
          onClick={() => setDetails(row.resource_id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setDetails(row.resource_id);
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="resource_id" style={cellStyle}>{row.resource_id}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="display_name" style={cellStyle}>{row.display_name}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="team_id" style={cellStyle}>{row.team_id}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="date" style={cellStyle}>{row.date}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="available_minutes" data-eval-unit="minutes" style={cellStyle}>{row.available_minutes}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="committed_minutes" data-eval-unit="minutes" style={cellStyle}>{row.committed_minutes}</td>
          <td data-eval="resource-cell" data-eval-key={row.resource_id} data-eval-field="residual_minutes" data-eval-unit="minutes" style={cellStyle}>{row.available_minutes - row.committed_minutes}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {rows.length === 0 && <p>No matching resource/day rows.</p>}
    {selected && <aside
      data-eval="resource-details"
      data-eval-key={selected.resource_id}
      aria-label="Resource details"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}
      style={{ padding: 14, border: '1px solid #789', borderRadius: 8, marginTop: 12, background: '#f8fafc' }}
    >
      <p>{selected.display_name} ({selected.resource_id}), team {selected.team_id}; skills {selected.skills.join(', ')}</p>
      <button type="button" ref={closeButton} onClick={close}>Close resource details</button>
    </aside>}
  </section>;
}

function CapacityPreview({ source, draft }: { source: any; draft: Draft }) {
  const validMinutes = (allocation: Allocation) => typeof allocation.minutes === 'number' && Number.isInteger(allocation.minutes) && allocation.minutes > 0 && allocation.minutes % 15 === 0;
  return <section style={panelStyle} aria-label="Tentative plan preview">
    <h2 style={{ marginTop: 0 }}>Tentative impact preview</h2>
    <p style={{ color: '#4b5563' }}>These figures are draft-only. They are shown separately from committed work and do not book resources.</p>
    <h3>Resource/day capacity</h3>
    <div style={{ overflowX: 'auto' }}><table style={tableStyle}>
      <thead><tr>{['Resource', 'Date', 'Residual after committed', 'Tentative plan', 'Capacity after tentative plan'].map((heading) => <th key={heading} style={cellStyle}>{heading}</th>)}</tr></thead>
      <tbody>{source.roster.map((row: any) => {
        const key = `${row.resource_id}|${row.date}`;
        const planned = draft.allocations.filter((a) => a.resource_id === row.resource_id && a.date === row.date && validMinutes(a)).reduce((sum, a) => sum + Number(a.minutes), 0);
        const residual = row.available_minutes - row.committed_minutes;
        return <tr key={key} data-eval="draft-capacity" data-eval-key={key}>
          <td style={cellStyle}>{row.resource_id}</td><td style={cellStyle}>{row.date}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="residual_committed_minutes" data-eval-unit="minutes" style={cellStyle}>{residual}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="planned_minutes" data-eval-unit="minutes" style={cellStyle}>{planned}</td>
          <td data-eval="draft-capacity-value" data-eval-key={key} data-eval-field="capacity_after_plan_minutes" data-eval-unit="minutes" style={cellStyle}>{residual - planned}</td>
        </tr>;
      })}</tbody>
    </table></div>
    <h3>Work remaining</h3>
    <div style={{ overflowX: 'auto' }}><table style={tableStyle}>
      <thead><tr>{['Work item', 'Required skill', 'Source remaining', 'Tentative plan', 'Remaining after tentative plan'].map((heading) => <th key={heading} style={cellStyle}>{heading}</th>)}</tr></thead>
      <tbody>{source.work_items.map((work: any) => {
        const planned = draft.allocations.filter((a) => a.work_item_id === work.work_item_id && validMinutes(a)).reduce((sum, a) => sum + Number(a.minutes), 0);
        return <tr key={work.work_item_id} data-eval="draft-work" data-eval-key={work.work_item_id}>
          <td style={cellStyle}>{work.work_item_id}</td><td style={cellStyle}>{work.required_skill}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="source_remaining_minutes" data-eval-unit="minutes" style={cellStyle}>{work.remaining_minutes}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="planned_minutes" data-eval-unit="minutes" style={cellStyle}>{planned}</td>
          <td data-eval="draft-work-value" data-eval-key={work.work_item_id} data-eval-field="remaining_after_plan_minutes" data-eval-unit="minutes" style={cellStyle}>{work.remaining_minutes - planned}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

function AllocationPlanner({ initialSource, initialStored }: { initialSource: any; initialStored: StoredDraft }) {
  const [source, setSource] = useState(initialSource);
  const [localDraft, setLocalDraftState] = useState<Draft>(() => cloneDraft(initialStored.draft));
  const [savedDraft, setSavedDraftState] = useState<Draft>(() => cloneDraft(initialStored.draft));
  const [authority, setAuthority] = useState<StoredDraft>(initialStored);
  const [revision, setRevisionState] = useState<string | null>(initialStored.revision);
  const [canWrite, setCanWriteState] = useState(initialStored.canWrite);
  const [pending, setPending] = useState(false);
  const [saveState, setSaveState] = useState(initialStored.canWrite ? 'Draft loaded. No save requested.' : 'Draft loaded read-only. Local editing is available; Save is unavailable.');
  const [actionError, setActionError] = useState('');
  const [conflictBlocked, setConflictBlocked] = useState(false);
  const [reconcileBlocked, setReconcileBlocked] = useState(false);
  const [reviewed, setReviewed] = useState<StoredDraft | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [planWork, setPlanWork] = useState(initialSource.work_items[0]?.work_item_id || '');
  const [planResource, setPlanResource] = useState(initialSource.resources[0]?.resource_id || '');
  const initialDates: string[] = Array.from(new Set<string>(initialSource.roster.map((r: any) => r.date)));
  const [planDate, setPlanDate] = useState(initialDates.includes(initialSource.default_date) ? initialSource.default_date : (initialDates[0] || ''));
  const [planMinutes, setPlanMinutes] = useState('15');
  const localRef = useRef(localDraft);
  const revisionRef = useRef(revision);
  const canWriteRef = useRef(canWrite);
  const pendingRef = useRef(false);
  const localId = useRef(1);
  const dates: string[] = useMemo(() => Array.from(new Set<string>(source.roster.map((r: any) => r.date))), [source]);
  const errors = useMemo(() => validateDraft(source, localDraft), [source, localDraft]);
  const dirty = draftKey(localDraft) !== draftKey(savedDraft);

  function setLocalDraft(next: Draft) {
    const copy = cloneDraft(next);
    localRef.current = copy;
    setLocalDraftState(copy);
  }

  function setSavedDraft(next: Draft) {
    const copy = cloneDraft(next);
    setSavedDraftState(copy);
  }

  function setRevision(next: string | null) {
    revisionRef.current = next;
    setRevisionState(next);
  }

  function setCanWrite(next: boolean) {
    canWriteRef.current = next;
    setCanWriteState(next);
  }

  function nextAllocationId(): string {
    let candidate = '';
    do {
      candidate = `LOCAL-${String(localId.current++).padStart(4, '0')}`;
    } while (localRef.current.allocations.some((a) => a.allocation_id === candidate));
    return candidate;
  }

  function addAllocation() {
    setActionError('');
    const minutes = planMinutes.trim() === '' ? NaN : Number(planMinutes);
    const candidate: Allocation = {
      allocation_id: nextAllocationId(),
      work_item_id: planWork,
      resource_id: planResource,
      date: planDate,
      minutes
    };
    const next = { draft_id: localRef.current.draft_id, allocations: [...localRef.current.allocations, candidate] };
    const nextErrors = validateDraft(source, next);
    if (nextErrors.length) {
      setActionError(nextErrors.join(' '));
      setSaveState('Invalid allocation was not added. The stored draft was not changed.');
      return;
    }
    setLocalDraft(next);
    setSaveState('Valid local allocation added. Save is still required to persist this draft.');
  }

  function changeMinutes(allocationId: string, raw: string) {
    setActionError('');
    const value: number | string = raw === '' ? '' : Number(raw);
    const next = {
      draft_id: localRef.current.draft_id,
      allocations: localRef.current.allocations.map((a) => a.allocation_id === allocationId ? { ...a, minutes: value } : a)
    };
    setLocalDraft(next);
    setSaveState('Local quantity changed. It has not been saved.');
  }

  function removeAllocation(allocationId: string) {
    setActionError('');
    setLocalDraft({
      draft_id: localRef.current.draft_id,
      allocations: localRef.current.allocations.filter((a) => a.allocation_id !== allocationId)
    });
    setSaveState('Local allocation removed. It has not been saved.');
  }

  async function refreshResources() {
    if (refreshing) return;
    setRefreshing(true);
    setActionError('');
    try {
      const result = await callFunction('load-data', {});
      if (!isSource(result)) throw new Error('The refreshed resource source did not match the declared schema.');
      const nextSource: any = result;
      setSource(nextSource);
      const nextDates: string[] = Array.from(new Set<string>(nextSource.roster.map((r: any) => r.date)));
      if (!nextSource.work_items.some((w: any) => w.work_item_id === planWork)) setPlanWork(nextSource.work_items[0]?.work_item_id || '');
      if (!nextSource.resources.some((r: any) => r.resource_id === planResource)) setPlanResource(nextSource.resources[0]?.resource_id || '');
      if (!nextDates.includes(planDate)) setPlanDate(nextDates.includes(nextSource.default_date) ? nextSource.default_date : (nextDates[0] || ''));
      setSaveState('Resource source refreshed. Local draft was preserved.');
    } catch (error: any) {
      setActionError(error?.message || 'Resource refresh failed; the current source and local draft were preserved.');
    } finally {
      setRefreshing(false);
    }
  }

  function adoptKnownAuthority(stored: StoredDraft) {
    setAuthority(stored);
    setSavedDraft(stored.draft);
    setRevision(stored.revision);
    setCanWrite(stored.canWrite);
  }

  async function reconcileUncertain(submittedKey: string, prefix: string) {
    try {
      const stored = await readStoredDraft();
      if (!stored) {
        setReconcileBlocked(true);
        setSaveState(`${prefix} The current stored draft could not be re-read, so another Save is blocked until authority is reviewed.`);
        return;
      }
      adoptKnownAuthority(stored);
      setReviewed(stored);
      setReconcileBlocked(false);
      if (draftKey(stored.draft) === submittedKey) {
        setSaveState(draftKey(localRef.current) === submittedKey
          ? `${prefix} Re-reading the file confirmed that the submitted draft is stored.`
          : `${prefix} Re-reading confirmed the submitted snapshot is stored; newer local edits remain unsaved.`);
      } else {
        setSaveState(`${prefix} Re-reading found a different authoritative draft. Local edits were preserved; use an explicit Save to try again.`);
      }
    } catch (error: any) {
      setReconcileBlocked(true);
      setSaveState(`${prefix} Reconciliation failed: ${error?.message || 'the current stored draft could not be verified'}. Local edits remain unsaved.`);
    }
  }

  async function saveDraft() {
    if (pendingRef.current) return;
    setActionError('');
    const validation = validateDraft(source, localRef.current);
    if (validation.length) {
      setActionError(validation.join(' '));
      setSaveState('Save refused because the local draft is invalid. No write was attempted.');
      return;
    }
    if (!canWriteRef.current) {
      setSaveState('Save refused because the verified draft capability is read-only. Local edits were preserved.');
      return;
    }
    const verifiedRevision = revisionRef.current;
    if (verifiedRevision === null) {
      setSaveState('Save refused because no verified draft revision is available. Local edits were preserved.');
      return;
    }
    if (conflictBlocked || reconcileBlocked) {
      setSaveState('Review the current authoritative draft before another explicit Save.');
      return;
    }

    const submitted = normalizedDraft(cloneDraft(localRef.current));
    const submittedKey = draftKey(submitted);
    const submittedRevision = verifiedRevision;
    pendingRef.current = true;
    setPending(true);
    setSaveState('Saving this submitted draft snapshot…');
    try {
      const result = await writeFile('./draft.json', `${JSON.stringify(submitted, null, 2)}\n`, {
        revision: submittedRevision,
        contentType: 'application/json'
      });
      if (result.success) {
        let stored: StoredDraft | null = null;
        try {
          stored = await readStoredDraft();
        } catch (verificationError: any) {
          setReconcileBlocked(true);
          setSaveState(`The write was acknowledged, but stored contents could not be verified: ${verificationError?.message || 'verification failed'}. Local edits were preserved.`);
          return;
        }
        if (!stored) {
          setReconcileBlocked(true);
          setSaveState('The write was acknowledged, but the stored draft could not be re-read. Local edits were preserved and another Save is blocked pending review.');
          return;
        }
        if (draftKey(stored.draft) !== submittedKey || stored.revision !== result.revision) {
          setAuthority(stored);
          setSavedDraft(stored.draft);
          setReviewed(stored);
          setConflictBlocked(true);
          setSaveState('The write was acknowledged, but the re-read authoritative contents or revision did not match that acknowledgement. Local edits were preserved; review authority before deciding.');
          return;
        }
        adoptKnownAuthority(stored);
        setReviewed(null);
        setConflictBlocked(false);
        setReconcileBlocked(false);
        setSaveState(draftKey(localRef.current) === submittedKey
          ? 'Draft snapshot saved and verified. This saved the draft only; no resource was booked.'
          : 'Submitted draft snapshot saved and verified. Newer local edits remain unsaved; no resource was booked.');
      } else if (result.error.code === 'conflict') {
        setConflictBlocked(true);
        setReviewed(null);
        setSaveState(`Save rejected for a revision conflict: ${result.error.message} Local edits were preserved; no retry was attempted.`);
      } else if (result.error.code === 'read_only') {
        setCanWrite(false);
        setAuthority((current) => ({ ...current, canWrite: false }));
        setSaveState(`Save rejected as read-only: ${result.error.message} Local edits were preserved and no alternate write will be attempted.`);
      } else if (result.error.code === 'save_failed') {
        await reconcileUncertain(submittedKey, `Save outcome was uncertain: ${result.error.message}`);
      } else {
        setSaveState(`Save rejected: ${result.error.message} Local edits were preserved.`);
      }
    } catch (error: any) {
      await reconcileUncertain(submittedKey, `Save did not return a confirmed result: ${error?.message || 'temporary failure'}.`);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function reviewAuthority() {
    if (reviewLoading || pendingRef.current) return;
    setReviewLoading(true);
    setActionError('');
    try {
      const stored = await readStoredDraft();
      if (!stored) throw new Error('Current authoritative draft is unavailable.');
      setAuthority(stored);
      setSavedDraft(stored.draft);
      setReviewed(stored);
      setSaveState('Current authoritative draft reviewed. Local edits are unchanged; choose Retain local edits or Discard local edits.');
    } catch (error: any) {
      setActionError(error?.message || 'Current authoritative draft could not be reviewed.');
    } finally {
      setReviewLoading(false);
    }
  }

  function reapplyLocal() {
    if (!reviewed) return;
    adoptKnownAuthority(reviewed);
    setConflictBlocked(false);
    setReconcileBlocked(false);
    setReviewed(null);
    setActionError('');
    setSaveState('Local edits retained against the reviewed authority. They remain unsaved until you explicitly choose Save draft.');
  }

  function discardLocal() {
    const target = reviewed || authority;
    setLocalDraft(target.draft);
    adoptKnownAuthority(target);
    setConflictBlocked(false);
    setReconcileBlocked(false);
    setReviewed(null);
    setActionError('');
    setSaveState('Local edits discarded. The editor now matches the reviewed authoritative draft.');
  }

  const saveDisabled = pending || !canWrite || revision === null || errors.length > 0 || !!actionError || conflictBlocked || reconcileBlocked;

  return <>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" data-eval="refresh-resources" onClick={refreshResources} disabled={refreshing}>{refreshing ? 'Refreshing resources…' : 'Refresh resource source'}</button>
      <span style={{ color: '#4b5563' }}>Source revision: {source.snapshot_revision}</span>
    </div>
    <ResourceView source={source} />

    <section style={panelStyle} aria-label="Allocation plan editor">
      <h2 style={{ marginTop: 0 }}>Tentative allocation plan</h2>
      <p style={{ color: '#4b5563' }}>Edit a local draft in 15-minute increments. Saving persists only this draft file; it does not change committed work or book resources.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>Work item<br />
          <select data-eval="plan-work-item" data-eval-key={planWork} value={planWork} onChange={(e) => { setPlanWork(e.target.value); setActionError(''); }} style={{ minWidth: 160, padding: 7 }}>
            {source.work_items.map((work: any) => <option key={work.work_item_id} value={work.work_item_id}>{work.work_item_id} · {work.team_id} · {work.required_skill}</option>)}
          </select>
        </label>
        <label>Resource<br />
          <select data-eval="plan-resource" data-eval-key={planResource} value={planResource} onChange={(e) => { setPlanResource(e.target.value); setActionError(''); }} style={{ minWidth: 180, padding: 7 }}>
            {source.resources.map((resource: any) => <option key={resource.resource_id} value={resource.resource_id}>{resource.resource_id} · {resource.display_name}</option>)}
          </select>
        </label>
        <label>Date<br />
          <select data-eval="plan-date" data-eval-key={planDate} value={planDate} onChange={(e) => { setPlanDate(e.target.value); setActionError(''); }} style={{ padding: 7 }}>
            {dates.map((date) => <option key={date} value={date}>{date}</option>)}
          </select>
        </label>
        <label>Minutes<br />
          <input data-eval="plan-minutes" type="number" min="15" step="15" value={planMinutes} onChange={(e) => { setPlanMinutes(e.target.value); setActionError(''); }} style={{ width: 110, padding: 7 }} />
        </label>
        <button type="button" data-eval="plan-add" onClick={addAllocation} style={{ padding: '8px 14px' }}>Add local allocation</button>
      </div>

      <div style={{ overflowX: 'auto' }}><table data-eval="draft-table" style={tableStyle}>
        <thead><tr>{['Allocation', 'Work item', 'Resource', 'Date', 'Tentative minutes', 'Action'].map((heading) => <th key={heading} style={cellStyle}>{heading}</th>)}</tr></thead>
        <tbody>{localDraft.allocations.map((allocation) => <tr key={allocation.allocation_id} data-eval="draft-row" data-eval-key={allocation.allocation_id}>
          <td style={cellStyle}>{allocation.allocation_id}</td>
          <td style={cellStyle}>{allocation.work_item_id}</td>
          <td style={cellStyle}>{allocation.resource_id}</td>
          <td style={cellStyle}>{allocation.date}</td>
          <td style={cellStyle}><input
            aria-label={`Tentative minutes for ${allocation.allocation_id}`}
            data-eval="draft-line-minutes"
            data-eval-key={allocation.allocation_id}
            type="number"
            min="15"
            step="15"
            value={allocation.minutes}
            onChange={(e) => changeMinutes(allocation.allocation_id, e.target.value)}
            style={{ width: 110, padding: 6 }}
          /></td>
          <td style={cellStyle}><button type="button" data-eval="draft-line-remove" data-eval-key={allocation.allocation_id} onClick={() => removeAllocation(allocation.allocation_id)}>Remove</button></td>
        </tr>)}</tbody>
      </table></div>
      {localDraft.allocations.length === 0 && <p>The local draft has no allocations.</p>}

      {(actionError || errors.length > 0) && <div data-eval="draft-error" role="alert" style={{ marginTop: 12, padding: 10, borderLeft: '4px solid #b42318', background: '#fff1f0', color: '#7a271a' }}>
        {actionError || errors.join(' ')}
      </div>}
      <p data-eval="draft-dirty-state" role="status" style={{ fontWeight: 700, color: dirty ? '#9a3412' : '#166534' }}>
        {dirty ? 'Unsaved local changes' : 'Local draft matches the last confirmed stored snapshot'}
      </p>
      <p data-eval="draft-save-state" aria-live="polite">{pending ? 'Save pending. You can keep editing; this acknowledgement applies only to the submitted snapshot.' : saveState}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" data-eval="draft-save" disabled={saveDisabled} onClick={saveDraft} style={{ padding: '9px 16px', fontWeight: 700 }}>
          {pending ? 'Saving submitted snapshot…' : 'Save draft'}
        </button>
        <button type="button" data-eval="draft-discard" disabled={pending || ((conflictBlocked || reconcileBlocked) && !reviewed)} onClick={discardLocal}>Discard local edits</button>
        {(conflictBlocked || reconcileBlocked) && <button type="button" data-eval="conflict-review" disabled={reviewLoading || pending} onClick={reviewAuthority}>{reviewLoading ? 'Reviewing authority…' : 'Review current authority'}</button>}
        {reviewed && (conflictBlocked || reconcileBlocked) && <button type="button" data-eval="draft-reapply" onClick={reapplyLocal}>Retain local edits</button>}
      </div>
      {!canWrite && <p style={{ color: '#7a271a' }}>Verified capability: read-only. Save is disabled; local edits remain available.</p>}
      {revision === null && canWrite && <p style={{ color: '#7a271a' }}>No verified revision token is available, so Save is disabled.</p>}
    </section>

    <CapacityPreview source={source} draft={localDraft} />

    <section data-eval="authority-review" style={{ ...panelStyle, background: '#f8fafc' }} aria-label="Current authoritative draft">
      <h2 style={{ marginTop: 0 }}>Current authoritative stored draft</h2>
      <p>This read-only review is separate from local edits. Draft ID: <strong>{authority.draft.draft_id}</strong>. Revision: <strong>{authority.revision === null ? 'unavailable' : authority.revision}</strong>. Capability: <strong>{authority.canWrite ? 'writable' : 'read-only'}</strong>.</p>
      {reviewed && <p><strong>Latest authority was explicitly reviewed; local edits have not been replaced or submitted.</strong></p>}
      <ul>{authority.draft.allocations.map((allocation) => <li key={allocation.allocation_id}>{allocation.allocation_id}: {allocation.work_item_id} → {allocation.resource_id} on {allocation.date}, {allocation.minutes} minutes</li>)}</ul>
      {authority.draft.allocations.length === 0 && <p>No stored allocations.</p>}
    </section>
  </>;
}

export default function ExistingResourceFrame() {
  const [source, setSource] = useState<any>(null);
  const [stored, setStored] = useState<StoredDraft | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [resourceEntry, draftEntry] = await Promise.all([readFile('./resources.json'), readStoredDraft()]);
        if (!resourceEntry) throw new Error('Resource source is unavailable.');
        if (!draftEntry) throw new Error('Existing draft is unavailable; a replacement file will not be created.');
        const data = JSON.parse(await resourceEntry.file.text());
        if (!isSource(data)) throw new Error('Resource source does not match the declared schema.');
        if (live) {
          setSource(data);
          setStored(draftEntry);
        }
      } catch (loadError: any) {
        if (live) setError(loadError?.message || 'Resource planning data is unavailable.');
      }
    })();
    return () => { live = false; };
  }, []);

  return <main data-eval="planner-root" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', maxWidth: 1180, margin: 'auto', padding: 20, color: '#17202a', background: '#f3f5f8' }}>
    <h1>Resource planning</h1>
    {error ? <p role="alert">{error}</p> : source && stored ? <AllocationPlanner initialSource={source} initialStored={stored} /> : <p role="status">Loading resources and existing draft</p>}
  </main>;
}
