import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { callFunction, readFile } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Ticket = { ticket_id: string; team_id: string; status: Status; priority: string; created_at: string; due_at: string; remaining_minutes: number };
type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type Snapshot = { schema_version: 'support-snapshot-1'; snapshot_revision: string; as_of: string; default_created_from: string; default_created_to: string; teams: Team[]; tickets: Ticket[] };
type Scope = { team_ids: string[]; statuses: Status[]; created_from: string; created_to: string };
type Result = { snapshot: Snapshot; scope: Scope };
const STATUS: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const ACTIVE: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const label: Record<Status, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', CLOSED: 'Closed' };
function isSnapshot(x: any): x is Snapshot {
  return !!x && x.schema_version === 'support-snapshot-1' && typeof x.snapshot_revision === 'string' && typeof x.as_of === 'string' && typeof x.default_created_from === 'string' && typeof x.default_created_to === 'string' && Array.isArray(x.teams) && Array.isArray(x.tickets) && x.teams.every((t: any) => typeof t.team_id === 'string' && typeof t.display_name === 'string') && x.tickets.every((t: any) => typeof t.ticket_id === 'string' && typeof t.team_id === 'string' && STATUS.includes(t.status) && typeof t.created_at === 'string' && typeof t.due_at === 'string' && Number.isInteger(t.remaining_minutes));
}
function isResult(x: any): x is Result {
  return !!x && isSnapshot(x.snapshot) && !!x.scope && Array.isArray(x.scope.team_ids) && Array.isArray(x.scope.statuses) && typeof x.scope.created_from === 'string' && typeof x.scope.created_to === 'string';
}
const sameScope = (a: Scope, b: Scope) => a.created_from === b.created_from && a.created_to === b.created_to && a.team_ids.join('\u0000') === b.team_ids.join('\u0000') && a.statuses.join('\u0000') === b.statuses.join('\u0000');
const dateText = (v: string) => v ? `${v} UTC` : '—';
const fmtDue = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC'); };

export default function SupportOperationsFrame() {
  const sequence = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [requested, setRequested] = useState<Scope | null>(null);
  const [displayed, setDisplayed] = useState<{ rows: Ticket[]; scope: Scope; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const performLoad = useCallback(async (scope: Scope) => {
    const id = ++sequence.current;
    setRequested(scope);
    setBusy(true);
    setError(null);
    setNote('');
    try {
      const raw = await callFunction('load-data', scope);
      if (!isResult(raw)) throw new Error('The source returned data in an unexpected format.');
      if (!sameScope(raw.scope, scope)) throw new Error('The source response scope did not match this request.');
      if (id !== sequence.current) return;
      setSnapshot(raw.snapshot);
      setDisplayed({ rows: raw.snapshot.tickets, scope, revision: raw.snapshot.snapshot_revision });
      setBusy(false);
    } catch (e) {
      if (id !== sequence.current) return;
      setBusy(false);
      setError(e instanceof Error ? e.message : 'The source could not be loaded.');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const id = ++sequence.current;
    setBusy(true);
    (async () => {
      try {
        const meta = await readFile('./dataset.json');
        if (!meta) throw new Error('Could not read the initial source file.');
        const parsed: unknown = JSON.parse(await meta.file.text());
        if (!isSnapshot(parsed)) throw new Error('The source file has an unexpected schema.');
        if (!alive || id !== sequence.current) return;
        setSnapshot(parsed);
        const initial: Scope = { team_ids: [], statuses: [...STATUS], created_from: parsed.default_created_from, created_to: parsed.default_created_to };
        setRequested(initial);
        const raw = await callFunction('load-data', initial);
        if (!isResult(raw)) throw new Error('The source returned data in an unexpected format.');
        if (!sameScope(raw.scope, initial)) throw new Error('The source response scope did not match this request.');
        if (!alive || id !== sequence.current) return;
        setSnapshot(raw.snapshot);
        setDisplayed({ rows: raw.snapshot.tickets, scope: initial, revision: raw.snapshot.snapshot_revision });
        setBusy(false);
      } catch (e) {
        if (!alive || id !== sequence.current) return;
        setBusy(false);
        setError(e instanceof Error ? e.message : 'The source could not be loaded.');
      }
    })();
    return () => { alive = false; };
  }, []);

  const teamOptions = snapshot?.teams ?? [];
  const changeTeam = (value: string) => {
    if (!requested) return;
    performLoad({ ...requested, team_ids: value === '' ? [] : [value] });
  };
  const toggleStatus = (status: Status) => {
    if (!requested) return;
    const statuses = requested.statuses.includes(status) ? requested.statuses.filter(s => s !== status) : STATUS.filter(s => requested.statuses.includes(s) || s === status);
    performLoad({ ...requested, statuses });
  };
  const changeDate = (key: 'created_from' | 'created_to', value: string) => {
    if (!requested) return;
    const next = { ...requested, [key]: value };
    setRequested(next);
    if (next.created_from && next.created_to && next.created_from < next.created_to) performLoad(next);
  };

  const refresh = async () => {
    const id = ++sequence.current;
    setBusy(true); setError(null); setNote('');
    try {
      const meta = await readFile('./dataset.json');
      if (!meta) throw new Error('Could not refresh the source file.');
      const parsed: unknown = JSON.parse(await meta.file.text());
      if (!isSnapshot(parsed)) throw new Error('The refreshed source has an unexpected schema.');
      if (id !== sequence.current) return;
      const current = requested ?? { team_ids: [], statuses: [...STATUS], created_from: parsed.default_created_from, created_to: parsed.default_created_to };
      const validTeamIds = new Set(parsed.teams.map(t => t.team_id));
      const keptTeams = current.team_ids.filter(teamId => validTeamIds.has(teamId));
      let next: Scope = { ...current, team_ids: current.team_ids.length ? keptTeams : [] };
      let invalidated = current.team_ids.length > 0 && keptTeams.length === 0;
      if (invalidated) next = { ...next, team_ids: [] };
      setRequested(next);
      if (invalidated) setNote('The selected team is no longer in the refreshed source; showing all teams.');
      const raw = await callFunction('load-data', next);
      if (!isResult(raw)) throw new Error('The source returned data in an unexpected format.');
      if (!sameScope(raw.scope, next)) throw new Error('The source response scope did not match this request.');
      if (id !== sequence.current) return;
      setSnapshot(raw.snapshot); setDisplayed({ rows: raw.snapshot.tickets, scope: next, revision: raw.snapshot.snapshot_revision }); setBusy(false);
    } catch (e) {
      if (id !== sequence.current) return;
      setBusy(false); setError(e instanceof Error ? e.message : 'The source could not be refreshed.');
    }
  };
  const reset = () => {
    if (!snapshot) return;
    performLoad({ team_ids: [], statuses: [...STATUS], created_from: snapshot.default_created_from, created_to: snapshot.default_created_to });
  };

  const rows = displayed?.rows ?? [];
  const counts = useMemo(() => {
    const counts = { ticket_count: rows.length, active_count: 0, overdue_active_count: 0, remaining_minutes: 0 };
    const asOf = displayed ? Date.parse(snapshot?.snapshot_revision === displayed.revision ? snapshot.as_of : '') : NaN;
    for (const t of rows) if (ACTIVE.includes(t.status)) {
      counts.active_count += 1;
      if (Number.isFinite(asOf) && Date.parse(t.due_at) < asOf) counts.overdue_active_count += 1;
      counts.remaining_minutes += t.remaining_minutes;
    }
    return counts;
  }, [rows, displayed, snapshot]);
  const statusCounts = ACTIVE.map(status => ({ status, count: rows.filter(r => r.status === status && ACTIVE.includes(r.status)).length }));
  const maxCount = Math.max(1, ...statusCounts.map(x => x.count));
  const teamsById = new Map(teamOptions.map(t => [t.team_id, t]));
  const activeFilters = requested ? `${requested.team_ids.length ? requested.team_ids.map(id => `${teamsById.get(id)?.display_name ?? 'Unknown team'} (${id})`).join(', ') : 'All teams'} · ${requested.statuses.length ? requested.statuses.map(s => label[s]).join(', ') : 'No statuses'} · ${dateText(requested.created_from)} – ${dateText(requested.created_to)} (end exclusive)` : 'Loading source defaults…';
  const shownFilters = displayed ? `${displayed.scope.team_ids.length ? displayed.scope.team_ids.map(id => `${teamsById.get(id)?.display_name ?? id} (${id})`).join(', ') : 'All teams'} · ${displayed.scope.statuses.length ? displayed.scope.statuses.map(s => label[s]).join(', ') : 'No statuses'} · ${dateText(displayed.scope.created_from)} – ${dateText(displayed.scope.created_to)} (end exclusive)` : 'No results displayed';
  const failedLabel = error ? `Load failed: ${error}${displayed ? ` Previous results remain from revision ${displayed.revision} and scope: ${shownFilters}.` : ''}` : busy ? `Loading requested scope. ${displayed ? `Currently showing prior results from revision ${displayed.revision} and scope: ${shownFilters}.` : 'Waiting for the first source result.'}` : displayed ? `Showing current source results, revision ${displayed.revision}.` : 'Waiting for source.';

  return <FrameRoot style={{ minHeight: '100vh', background: '#f5f7fb', color: '#17263c', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', padding: 24 }}>
    <main data-eval="dashboard-root" style={{ maxWidth: 1240, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 22 }}>
        <div><div style={{ color: '#55708e', fontSize: 12, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase' }}>Support operations</div><h1 style={{ margin: '7px 0', fontSize: 30 }}>Ticket workload</h1><div style={{ color: '#61748d' }}>A live view of ticket volume, SLA risk and remaining effort</div></div>
        <div style={{ display: 'flex', gap: 9 }}><button data-eval="refresh-data" onClick={refresh} disabled={!snapshot} style={buttonStyle}>↻ Refresh data</button><button data-eval="reset-filters" onClick={reset} disabled={!snapshot} style={buttonStyle}>Reset filters</button></div>
      </header>
      <section aria-label="Filters" style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}><strong>View filters</strong><span style={{ fontSize: 12, color: '#71839a' }}>Requested: {activeFilters}</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1fr) minmax(145px, .7fr) minmax(145px, .7fr) minmax(260px, 1.8fr)', gap: 14, alignItems: 'start' }}>
          <label style={fieldLabel}>Team<select data-eval="team-filter" value={requested?.team_ids[0] ?? ''} onChange={e => changeTeam(e.target.value)} disabled={!requested} style={selectStyle}><option value="">All teams</option>{teamOptions.map(t => <option key={t.team_id} value={t.team_id}>{t.display_name} · {t.team_id}</option>)}</select></label>
          <label style={fieldLabel}>Created from (UTC)<input data-eval="created-from" type="date" value={requested?.created_from ?? ''} onChange={e => changeDate('created_from', e.target.value)} disabled={!requested} style={selectStyle}/></label>
          <label style={fieldLabel}>Created to (UTC, exclusive)<input data-eval="created-to" type="date" value={requested?.created_to ?? ''} onChange={e => changeDate('created_to', e.target.value)} disabled={!requested} style={selectStyle}/></label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend style={fieldLabel}>Status</legend><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 9 }}>{STATUS.map(s => <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: '#334760' }}><input type="checkbox" data-eval="status-option" data-eval-key={s} checked={!!requested?.statuses.includes(s)} onChange={() => toggleStatus(s)} disabled={!requested}/>{label[s]}</label>)}</div></fieldset>
        </div>
        {requested?.created_from && requested?.created_to && requested.created_from >= requested.created_to && <div role="alert" style={{ color: '#a04436', marginTop: 10, fontSize: 13 }}>Choose an end date later than the start date. The date interval includes the start and excludes the end.</div>}
        {note && <div role="status" style={{ color: '#795b17', marginTop: 10, fontSize: 13 }}>{note}</div>}
      </section>
      <div data-eval="view-state" role={error ? 'alert' : 'status'} aria-live="polite" style={{ ...panel, marginTop: 14, borderColor: error ? '#f0c3bc' : '#dce5ef', background: error ? '#fff8f6' : '#fff', color: error ? '#873b30' : '#526a83', fontSize: 13 }}>
        <span>{failedLabel}</span>{error && <button data-eval="retry-load" onClick={() => requested && performLoad(requested)} style={{ ...buttonStyle, marginLeft: 12, padding: '7px 12px' }}>Retry</button>}
        {displayed && <div data-eval="displayed-scope" style={{ marginTop: 6, fontSize: 12 }}>Displayed scope: {shownFilters} · revision {displayed.revision}</div>}
      </div>
      <section aria-label="Ticket metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14, marginTop: 14 }}>
        <Metric name="Tickets" value={counts.ticket_count} unit="tickets" accent="#3467d5"/>
        <Metric name="Active tickets" value={counts.active_count} unit="tickets" accent="#14866d"/>
        <Metric name="Overdue active" value={counts.overdue_active_count} unit="tickets" accent="#d35f4a"/>
        <Metric name="Remaining effort" value={(counts.remaining_minutes / 60).toFixed(2)} unit="hours" accent="#8b62c6"/>
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(330px, .8fr)', gap: 14, marginTop: 14, alignItems: 'stretch' }}>
        <div style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}><div><h2 style={h2}>Tickets</h2><div style={{ fontSize: 12, color: '#71839a' }}>{rows.length} matching records · effort in minutes</div></div><div style={{ fontSize: 12, color: '#71839a' }}>{displayed ? `Snapshot ${displayed.revision}` : ''}</div></div>
          <div style={{ overflowX: 'auto', marginTop: 14 }}><table data-eval="tickets-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}><thead><tr>{['Ticket ID', 'Team', 'Status', 'Due time (UTC)', 'Remaining effort (minutes)'].map(x => <th key={x} style={th}>{x}</th>)}</tr></thead><tbody>
            {rows.map(t => <tr data-eval="ticket-row" data-eval-key={t.ticket_id} key={t.ticket_id}>
              <td data-eval="ticket-cell" data-eval-field="ticket_id" style={td}><strong>{t.ticket_id}</strong></td>
              <td data-eval="ticket-cell" data-eval-field="team_id" style={td}>{teamsById.get(t.team_id)?.display_name ?? 'Unknown team'} <span style={{ color: '#71839a' }}>({t.team_id})</span></td>
              <td data-eval="ticket-cell" data-eval-field="status" style={td}><span style={badge}>{label[t.status]}</span></td>
              <td data-eval="ticket-cell" data-eval-field="due_at" style={td}>{fmtDue(t.due_at)}</td>
              <td data-eval="ticket-cell" data-eval-field="remaining_minutes" data-eval-unit="minutes" style={td}>{t.remaining_minutes} min</td>
            </tr>)}
          </tbody></table></div>
          {rows.length === 0 && !busy && !error && <div data-eval="empty-state" style={{ padding: '34px 12px', textAlign: 'center', color: '#61748d' }}><strong>No tickets match this scope.</strong><div style={{ marginTop: 5 }}>The source read succeeded; all metrics and active-status counts are zero.</div></div>}
          {rows.length === 0 && busy && <div style={{ padding: 22, textAlign: 'center', color: '#61748d' }}>Loading…</div>}
        </div>
        <div data-eval="status-chart" style={panel}>
          <h2 style={h2}>Active tickets by status</h2><p style={{ margin: '4px 0 20px', color: '#71839a', fontSize: 12 }}>Matching tickets · counts · select a bar to filter to that status</p>
          <div style={{ display: 'grid', gap: 14 }}>
            {statusCounts.map(({ status, count }) => <button type="button" data-eval="status-bar" data-eval-key={status} key={status} aria-label={`Filter to ${label[status]}: ${count} tickets`} aria-pressed={requested?.statuses.length === 1 && requested.statuses[0] === status} onClick={() => requested && performLoad({ ...requested, statuses: [status] })} disabled={!requested} style={{ border: 0, padding: 0, background: 'transparent', color: '#334760', textAlign: 'left', cursor: requested ? 'pointer' : 'wait', font: 'inherit' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}><span>{label[status]}</span><strong data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count} tickets</strong></div>
              <div data-eval="status-plot" data-eval-key={status} data-eval-axis="width" style={{ width: '100%', height: 17, borderRadius: 9, background: '#edf1f6', overflow: 'hidden' }}>
                <div data-eval="status-glyph" data-eval-key={status} style={{ width: `${count === 0 ? 0 : Math.max(1, (count / maxCount) * 100)}%`, height: '100%', borderRadius: 9, background: status === 'OPEN' ? '#3774de' : status === 'IN_PROGRESS' ? '#13a181' : '#e8a238', minWidth: count === 0 ? 0 : 2 }} />
              </div>
            </button>)}
          </div>
          <div style={{ marginTop: 23, padding: 12, borderRadius: 9, background: '#f6f8fb', fontSize: 12, color: '#61748d' }}>Active excludes Closed. Overdue means due before source as-of time ({snapshot?.as_of ?? '—'}), not the browser clock.</div>
        </div>
      </section>
    </main>
  </FrameRoot>;
}

function Metric({ name, value, unit, accent }: { name: string; value: number | string; unit: string; accent: string }) {
  const keys: Record<string, string> = { 'Tickets': 'ticket_count', 'Active tickets': 'active_count', 'Overdue active': 'overdue_active_count', 'Remaining effort': 'remaining_effort_hours' };
  return <article data-eval="metric" data-eval-key={keys[name]} data-eval-unit={unit} style={{ ...panel, borderTop: `3px solid ${accent}`, padding: 17 }}><div style={{ color: '#71839a', fontSize: 12, fontWeight: 600 }}>{name}</div><div style={{ fontSize: 28, fontWeight: 750, marginTop: 7 }}>{value}<span style={{ fontSize: 12, color: '#71839a', fontWeight: 500, marginLeft: 6 }}>{unit}</span></div></article>;
}
const panel: React.CSSProperties = { background: '#fff', border: '1px solid #dce5ef', borderRadius: 12, padding: 18, boxShadow: '0 2px 9px rgba(28,48,77,.035)' };
const h2: React.CSSProperties = { margin: 0, fontSize: 17, color: '#233950' };
const th: React.CSSProperties = { padding: '10px 9px', borderBottom: '1px solid #dce5ef', color: '#71839a', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '12px 9px', borderBottom: '1px solid #edf1f6', whiteSpace: 'nowrap', color: '#334760' };
const fieldLabel: React.CSSProperties = { display: 'block', color: '#536982', fontSize: 12, fontWeight: 650 };
const selectStyle: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #cdd9e5', borderRadius: 8, background: '#fff', color: '#233950', marginTop: 7, fontSize: 13 };
const buttonStyle: React.CSSProperties = { border: '1px solid #cdd9e5', borderRadius: 8, padding: '9px 13px', background: '#fff', color: '#29435f', fontWeight: 650, cursor: 'pointer' };
const badge: React.CSSProperties = { display: 'inline-block', borderRadius: 12, padding: '4px 8px', background: '#edf3fa', fontSize: 12, fontWeight: 600 };
