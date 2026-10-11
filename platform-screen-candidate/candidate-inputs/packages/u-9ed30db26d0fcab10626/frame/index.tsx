import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { callFunction, readFile } from '@dust/react-hooks';

type Team = { team_id: string; display_name: string };
type Ticket = { ticket_id: string; team_id: string; status: Status; priority: string; created_at: string; due_at: string; remaining_minutes: number };
type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type Snapshot = { schema_version: 'support-snapshot-1'; snapshot_revision: string; as_of: string; default_created_from: string; default_created_to: string; teams: Team[]; tickets: Ticket[] };
type Scope = { team_ids: string[]; statuses: Status[]; created_from: string; created_to: string };
type Result = { snapshot: Snapshot; scope: Scope };
const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const ACTIVE: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const names: Record<Status, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', CLOSED: 'Closed' };

function validSnapshot(v: any): v is Snapshot {
  return !!v && v.schema_version === 'support-snapshot-1' && typeof v.snapshot_revision === 'string' && typeof v.as_of === 'string' && typeof v.default_created_from === 'string' && typeof v.default_created_to === 'string' && Array.isArray(v.teams) && Array.isArray(v.tickets) && v.teams.every((t: any) => typeof t.team_id === 'string' && typeof t.display_name === 'string') && v.tickets.every((t: any) => typeof t.ticket_id === 'string' && typeof t.team_id === 'string' && STATUSES.includes(t.status) && typeof t.created_at === 'string' && typeof t.due_at === 'string' && Number.isFinite(t.remaining_minutes));
}
function scopeKey(s: Scope) { return JSON.stringify([s.team_ids, s.statuses, s.created_from, s.created_to]); }
function equalScope(a: Scope, b: Scope) { return scopeKey(a) === scopeKey(b); }
function fmtDate(s: string) { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC'; }

export default function SupportOperationsFrame() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [displayedScope, setDisplayedScope] = useState<Scope | null>(null);
  const [rows, setRows] = useState<Ticket[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bootError, setBootError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const sequence = useRef(0);
  const currentScope = useRef<Scope | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);

  const load = useCallback(async (nextScope: Scope, kind: 'scope' | 'refresh' = 'scope') => {
    const id = ++sequence.current;
    currentScope.current = nextScope;
    setScope(nextScope);
    setBusy(true);
    setError('');
    try {
      const raw = await callFunction('load-data', nextScope);
      const result = raw as Result;
      if (!result || !validSnapshot(result.snapshot) || !result.scope || !equalScope(result.scope, nextScope)) throw new Error('The source returned an invalid snapshot or a mismatched scope.');
      if (id !== sequence.current || !currentScope.current || !equalScope(currentScope.current, nextScope)) return;
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      setRows(result.snapshot.tickets.filter(t =>
        (!nextScope.team_ids.length || nextScope.team_ids.includes(t.team_id)) &&
        nextScope.statuses.includes(t.status) &&
        Date.parse(t.created_at) >= Date.parse(`${nextScope.created_from}T00:00:00Z`) && Date.parse(t.created_at) < Date.parse(`${nextScope.created_to}T00:00:00Z`)
      ));
      setDisplayedScope(nextScope);
      setLoaded(true);
      setError('');
    } catch (e) {
      if (id !== sequence.current) return;
      setError(e instanceof Error ? e.message : 'Unable to load the current support snapshot.');
    } finally {
      if (id === sequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entry = await readFile('./dataset.json');
        if (!entry) throw new Error('The source dataset is unavailable.');
        const text = await entry.file.text();
        const initial = JSON.parse(text);
        if (!validSnapshot(initial)) throw new Error('The source dataset does not match the support snapshot schema.');
        if (cancelled) return;
        snapshotRef.current = initial;
        setSnapshot(initial);
        const base: Scope = { team_ids: [], statuses: [...STATUSES], created_from: initial.default_created_from, created_to: initial.default_created_to };
        await load(base, 'scope');
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : 'Unable to read the source dataset.');
      }
    })();
    return () => { cancelled = true; sequence.current += 1; };
  }, [load]);

  const refresh = useCallback(async () => {
    const desired = currentScope.current ?? scope;
    if (!desired) return;
    // The proxy function returns the current snapshot and echoes the requested scope.
    await load(desired, 'refresh');
  }, [load, scope]);
  const retry = useCallback(() => { const desired = currentScope.current ?? scope; if (desired) void load(desired); }, [load, scope]);
  const reset = useCallback(() => {
    const source = snapshotRef.current;
    if (!source) return;
    void load({ team_ids: [], statuses: [...STATUSES], created_from: source.default_created_from, created_to: source.default_created_to }, 'refresh');
  }, [load]);

  const teams = snapshot?.teams ?? [];
  const team = scope?.team_ids[0] ?? '';
  const change = (patch: Partial<Scope>) => { if (scope) void load({ ...scope, ...patch }); };
  const toggleStatus = (status: Status) => {
    if (!scope) return;
    const statuses = scope.statuses.includes(status) ? scope.statuses.filter(s => s !== status) : STATUSES.filter(s => scope.statuses.includes(s) || s === status);
    void load({ ...scope, statuses });
  };
  const teamLabel = (t: Team) => `${t.display_name} · ${t.team_id}`;
  const activeRows = useMemo(() => rows.filter(t => ACTIVE.includes(t.status)), [rows]);
  const overdue = activeRows.filter(t => Date.parse(t.due_at) < Date.parse(snapshot?.as_of ?? ''));
  const effort = activeRows.reduce((sum, t) => sum + t.remaining_minutes, 0) / 60;
  const counts = ACTIVE.map(status => ({ status, count: activeRows.filter(t => t.status === status).length }));
  const maxCount = Math.max(0, ...counts.map(x => x.count));
  const priorLabel = displayedScope && scope && !equalScope(displayedScope, scope) ? `Showing prior results for ${displayedScope.created_from} to before ${displayedScope.created_to} · revision ${snapshot?.snapshot_revision ?? 'unknown'}.` : '';

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #e7eaf0', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(20,34,60,.035)' };
  const control: React.CSSProperties = { border: '1px solid #d8dee9', borderRadius: 8, padding: '9px 11px', background: 'white', color: '#1d2939', fontSize: 14 };
  const button: React.CSSProperties = { ...control, cursor: 'pointer', fontWeight: 600 };
  const statusText = (s: Status) => names[s];
  return <FrameRoot style={{ minHeight: '100vh', background: '#f5f7fb', color: '#172435', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', padding: 28 }}>
    <main data-eval="dashboard-root" style={{ maxWidth: 1180, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, marginBottom: 24 }}>
        <div><div style={{ color: '#58708e', fontSize: 12, letterSpacing: 1.4, fontWeight: 700, textTransform: 'uppercase' }}>Support operations</div><h1 style={{ margin: '6px 0 4px', fontSize: 28, letterSpacing: '-.5px' }}>Ticket overview</h1><div style={{ color: '#66768b', fontSize: 13 }}>Created time in UTC · end date is exclusive{snapshot ? ` · snapshot ${snapshot.snapshot_revision} as of ${fmtDate(snapshot.as_of)}` : ''}</div></div>
        <div style={{ display: 'flex', gap: 8 }}><button data-eval="refresh-data" style={button} onClick={() => void refresh()} disabled={!scope || busy}>↻ Refresh</button><button data-eval="reset-filters" style={{ ...button, background: '#142d4e', color: '#fff', borderColor: '#142d4e' }} onClick={reset} disabled={!snapshot}>Reset</button></div>
      </header>
      <section style={{ ...card, marginBottom: 18 }} aria-label="Filters">
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.15fr) minmax(140px,.8fr) minmax(140px,.8fr) 2fr', gap: 18, alignItems: 'start' }}>
          <label style={{ display: 'grid', gap: 7, color: '#42536a', fontSize: 12, fontWeight: 700 }}>TEAM<select data-eval="team-filter" value={team} onChange={e => change({ team_ids: e.target.value ? [e.target.value] : [] })} style={control}><option value="">All teams</option>{teams.map(t => <option key={t.team_id} value={t.team_id}>{teamLabel(t)}</option>)}</select></label>
          <label style={{ display: 'grid', gap: 7, color: '#42536a', fontSize: 12, fontWeight: 700 }}>CREATED FROM<input data-eval="created-from" type="date" value={scope?.created_from ?? ''} onChange={e => change({ created_from: e.target.value })} style={control}/></label>
          <label style={{ display: 'grid', gap: 7, color: '#42536a', fontSize: 12, fontWeight: 700 }}>CREATED TO (EXCLUSIVE)<input data-eval="created-to" type="date" value={scope?.created_to ?? ''} onChange={e => change({ created_to: e.target.value })} style={control}/></label>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}><legend style={{ color: '#42536a', fontSize: 12, fontWeight: 700, marginBottom: 9 }}>STATUS</legend><div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>{STATUSES.map(s => <label key={s} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: '#344054', fontSize: 13 }}><input data-eval="status-option" type="checkbox" value={s} checked={scope?.statuses.includes(s) ?? false} onChange={() => toggleStatus(s)}/>{statusText(s)}</label>)}</div></fieldset>
        </div>
      </section>
      <div data-eval="view-state" role="status" aria-live="polite" style={{ minHeight: 24, margin: '0 2px 12px', color: error || bootError ? '#b42318' : busy ? '#475467' : '#18734a', fontSize: 13 }}>
        {bootError ? <>Source error: {bootError}</> : error ? <>Could not load this scope: {error}{loaded ? ` Previous results remain visible for revision ${snapshot?.snapshot_revision}.` : ''} <button data-eval="retry-load" onClick={retry} style={{ ...button, padding: '4px 9px', marginLeft: 8 }}>Retry</button></> : busy ? <>Loading requested scope…{loaded ? ` Previous results remain visible for revision ${snapshot?.snapshot_revision}.` : ''}</> : loaded ? `Showing current results · revision ${snapshot?.snapshot_revision}` : 'Loading source…'}
        {priorLabel && <span style={{ display: 'block', color: '#9a6700', marginTop: 5 }}>{priorLabel}</span>}
      </div>
      {displayedScope && <div data-eval="displayed-scope" style={{ color: '#66768b', fontSize: 12, margin: '0 2px 14px' }}>Results scope: {displayedScope.team_ids.length ? displayedScope.team_ids.map(id => teamLabel(teams.find(t => t.team_id === id) ?? { team_id: id, display_name: 'Unavailable team' })).join(', ') : 'All teams'} · {displayedScope.statuses.map(statusText).join(', ') || 'No statuses'} · {displayedScope.created_from} ≤ created date &lt; {displayedScope.created_to} · revision {snapshot?.snapshot_revision}</div>}
      <section aria-label="Key metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 14, marginBottom: 18 }}>
        {[['ticket_count', 'Tickets', rows.length, 'tickets'], ['active_count', 'Active tickets', activeRows.length, 'tickets'], ['overdue_active_count', 'Overdue active', overdue.length, 'tickets'], ['remaining_effort_hours', 'Remaining effort', effort.toFixed(2), 'hours']].map(([key, label, value, unit]) => <div data-eval="metric" data-eval-key={key} data-eval-unit={unit} key={key} style={card}><div style={{ color: '#66768b', fontSize: 13 }}>{label}</div><div style={{ fontSize: 27, fontWeight: 700, marginTop: 8, color: '#18375c' }}>{value}</div><div style={{ color: '#8492a6', fontSize: 11, marginTop: 2 }}>{unit}</div></div>)}
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(280px,.8fr)', gap: 18, alignItems: 'stretch' }}>
        <div data-eval="tickets-table" style={{ ...card, padding: 0, overflow: 'hidden' }}><div style={{ padding: '17px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><h2 style={{ fontSize: 16, margin: 0 }}>Tickets</h2><div style={{ color: '#66768b', fontSize: 12, marginTop: 4 }}>{rows.length} matching records</div></div></div><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}><thead><tr style={{ background: '#f8fafc', color: '#66768b' }}>{['Ticket ID','Team','Status','Priority','Created (UTC)','Due (UTC)','Remaining effort'].map(h => <th key={h} style={{ padding: '11px 12px', borderTop: '1px solid #edf0f4', borderBottom: '1px solid #edf0f4', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead><tbody>{rows.map(t => <tr data-eval="ticket-row" data-eval-key={t.ticket_id} key={t.ticket_id} style={{ borderBottom: '1px solid #f0f2f5' }}><td data-eval="ticket-cell" data-eval-field="ticket_id" style={{ padding: '12px', fontWeight: 650, color: '#24588a', whiteSpace: 'nowrap' }}>{t.ticket_id}</td><td data-eval="ticket-cell" data-eval-field="team_id" style={{ padding: '12px', whiteSpace: 'nowrap' }}>{teamLabel(teams.find(x => x.team_id === t.team_id) ?? { team_id: t.team_id, display_name: 'Unknown team' })}</td><td data-eval="ticket-cell" data-eval-field="status" style={{ padding: '12px', whiteSpace: 'nowrap' }}>{statusText(t.status)}</td><td style={{ padding: '12px' }}>{t.priority}</td><td style={{ padding: '12px', whiteSpace: 'nowrap' }}>{fmtDate(t.created_at)}</td><td data-eval="ticket-cell" data-eval-field="due_at" style={{ padding: '12px', whiteSpace: 'nowrap' }}>{fmtDate(t.due_at)}</td><td data-eval="ticket-cell" data-eval-field="remaining_minutes" data-eval-unit="minutes" style={{ padding: '12px', whiteSpace: 'nowrap' }}>{t.remaining_minutes} min</td></tr>)}</tbody></table></div>{!busy && !error && loaded && rows.length === 0 && <div data-eval="empty-state" style={{ padding: 32, color: '#66768b', textAlign: 'center' }}>No tickets match this scope. Adjust filters or reset to the default view.</div>}</div>
        <section data-eval="status-chart" style={card} aria-label="Active tickets by status"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}><div><h2 style={{ fontSize: 16, margin: 0 }}>Active by status</h2><p style={{ color: '#66768b', fontSize: 12, margin: '5px 0 0' }}>Select a bar to filter to that status</p></div><span style={{ color: '#8492a6', fontSize: 11 }}>tickets</span></div><div style={{ display: 'grid', gap: 17, marginTop: 24 }}>{counts.map(({ status, count }) => { const width = maxCount ? Math.max(count ? 4 : 0, count / maxCount * 100) : 0; const selected = scope?.statuses.length === 1 && scope.statuses[0] === status; return <button data-eval="status-bar" data-eval-key={status} key={status} type="button" aria-pressed={!!selected} onClick={() => scope && void load({ ...scope, statuses: [status] })} style={{ border: 0, padding: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', color: '#344054', font: 'inherit', outlineOffset: 4 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 7 }}><span>{names[status]}</span><strong data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count}</strong></div><div data-eval="status-plot" data-eval-key={status} data-eval-axis="width" style={{ height: 14, width: '100%', background: '#edf1f6', borderRadius: 99, overflow: 'hidden' }}><div data-eval="status-glyph" data-eval-key={status} style={{ height: '100%', width: `${width}%`, minWidth: count ? 4 : 0, background: selected ? '#126a89' : '#5b8fa8', borderRadius: 99, transition: 'width .2s ease' }}/></div></button>; })}</div><div style={{ color: '#8492a6', fontSize: 11, marginTop: 21 }}>Counts use the same scale from zero across all three active statuses.</div></section>
      </section>
    </main>
  </FrameRoot>;
}
