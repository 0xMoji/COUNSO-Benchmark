import React, { useEffect, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { readFile, callFunction } from '@dust/react-hooks';

type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type Scope = { team_ids: string[]; statuses: Status[]; created_from: string; created_to: string };
type Team = { team_id: string; display_name: string };
type Ticket = { ticket_id: string; team_id: string; status: Status; priority: string; created_at: string; due_at: string; remaining_minutes: number };
type Snapshot = { schema_version: string; snapshot_revision: string; as_of: string; default_created_from: string; default_created_to: string; teams: Team[]; tickets: Ticket[] };
type View = { snapshot: Snapshot; scope: Scope };
const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const ACTIVE: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const names: Record<Status, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', CLOSED: 'Closed' };
const colors: Record<Status, string> = { OPEN: '#2563eb', IN_PROGRESS: '#7c3aed', WAITING: '#c07609', CLOSED: '#475569' };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0) && new Set(value).size === value.length; }
function validateScope(value: unknown): Scope {
  if (!object(value) || !strings(value.team_ids) || !strings(value.statuses) || !value.statuses.every(x => STATUSES.includes(x as Status)) || !date(value.created_from) || !date(value.created_to)) throw new Error('The source returned an invalid scope.');
  return { team_ids: [...value.team_ids], statuses: [...value.statuses] as Status[], created_from: value.created_from, created_to: value.created_to };
}
function validateSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.schema_version !== 'support-snapshot-1' || typeof value.snapshot_revision !== 'string' || !value.snapshot_revision || !timestamp(value.as_of) || !date(value.default_created_from) || !date(value.default_created_to) || !Array.isArray(value.teams) || !Array.isArray(value.tickets)) throw new Error('The source returned an invalid support snapshot.');
  const teams: Team[] = value.teams.map(t => {
    if (!object(t) || typeof t.team_id !== 'string' || !t.team_id || typeof t.display_name !== 'string') throw new Error('The source contains an invalid team.');
    return { team_id: t.team_id, display_name: t.display_name };
  });
  const ids = new Set(teams.map(t => t.team_id));
  if (ids.size !== teams.length) throw new Error('The source contains duplicate team identities.');
  const tickets: Ticket[] = value.tickets.map(t => {
    if (!object(t) || typeof t.ticket_id !== 'string' || !t.ticket_id || typeof t.team_id !== 'string' || !ids.has(t.team_id) || !STATUSES.includes(t.status as Status) || !['P1', 'P2', 'P3'].includes(t.priority as string) || !timestamp(t.created_at) || !timestamp(t.due_at) || typeof t.remaining_minutes !== 'number' || !Number.isSafeInteger(t.remaining_minutes) || t.remaining_minutes < 0) throw new Error('The source contains an invalid ticket.');
    return { ticket_id: t.ticket_id, team_id: t.team_id, status: t.status as Status, priority: t.priority as string, created_at: t.created_at, due_at: t.due_at, remaining_minutes: t.remaining_minutes };
  });
  if (new Set(tickets.map(t => t.ticket_id)).size !== tickets.length) throw new Error('The source contains duplicate ticket identities.');
  return { schema_version: value.schema_version, snapshot_revision: value.snapshot_revision, as_of: value.as_of, default_created_from: value.default_created_from, default_created_to: value.default_created_to, teams, tickets };
}
function defaults(snapshot: Snapshot): Scope { return { team_ids: [], statuses: [...STATUSES], created_from: snapshot.default_created_from, created_to: snapshot.default_created_to }; }
function copyScope(s: Scope): Scope { return { ...s, team_ids: [...s.team_ids], statuses: [...s.statuses] }; }
function sameScope(a: Scope, b: Scope): boolean { return a.created_from === b.created_from && a.created_to === b.created_to && JSON.stringify([...a.team_ids].sort()) === JSON.stringify([...b.team_ids].sort()) && JSON.stringify([...a.statuses].sort()) === JSON.stringify([...b.statuses].sort()); }
function scopeText(s: Scope): string { return `Teams: ${s.team_ids.length ? s.team_ids.join(', ') : 'All teams'} · Statuses: ${s.statuses.length ? s.statuses.join(', ') : 'None'} · Created UTC: [${s.created_from}, ${s.created_to})`; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Unable to read the controlled source. Please retry.'; }
function utc(value: string): string { return new Date(value).toISOString().replace('.000Z', 'Z'); }
function number(value: number): string { return String(Number(value.toFixed(6))); }

export default function SupportOperations() {
  const [scope, setScope] = useState<Scope | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const intent = useRef<Scope | null>(null);
  const latestSource = useRef<Snapshot | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const resetIntent = useRef(false);
  const current = (token: number) => mounted.current && generation.current === token;

  async function bootstrap() {
    const token = ++generation.current;
    setLoading(true); setError(null); setNotice('');
    try {
      const source = await readFile('./dataset.json');
      if (!current(token)) return;
      if (!source) throw new Error('The initial source file is unavailable.');
      const content = await source.file.text();
      if (!current(token)) return;
      const snapshot = validateSnapshot(JSON.parse(content));
      const initial = defaults(snapshot);
      latestSource.current = snapshot; intent.current = initial;
      setScope(initial); setView({ snapshot, scope: copyScope(initial) }); setLoading(false);
    } catch (e) { if (current(token)) { setError(errorText(e)); setLoading(false); } }
  }

  async function load(requested: Scope, reset = false, explanation = '') {
    const request = copyScope(requested);
    const token = ++generation.current;
    intent.current = request; resetIntent.current = reset;
    setScope(request); setError(null); setNotice(explanation); setLoading(true);
    if (!date(request.created_from) || !date(request.created_to) || request.created_from > request.created_to) {
      setError('Choose valid UTC dates with the start on or before the exclusive end.'); setLoading(false); return;
    }
    try {
      const result = await callFunction('load-data', request);
      if (!current(token)) return;
      if (!object(result)) throw new Error('The source returned an invalid response.');
      const echoed = validateScope(result.scope);
      if (!sameScope(echoed, request)) throw new Error('The returned scope does not match the requested filters. Retry to load the intended scope.');
      const snapshot = validateSnapshot(result.snapshot);
      latestSource.current = snapshot;
      if (reset) {
        const freshDefaults = defaults(snapshot);
        if (!sameScope(freshDefaults, request)) {
          void load(freshDefaults, true, 'Reset is using the defaults from the current source snapshot.'); return;
        }
      }
      const validIds = new Set(snapshot.teams.map(t => t.team_id));
      if (request.team_ids.some(id => !validIds.has(id))) {
        const next = { ...request, team_ids: request.team_ids.filter(id => validIds.has(id)) };
        void load(next, false, 'A selected team is no longer in the source. The team filter was updated to the remaining valid selection, or All teams.'); return;
      }
      setView({ snapshot, scope: request }); setLoading(false); setError(null);
    } catch (e) { if (current(token)) { setError(errorText(e)); setLoading(false); } }
  }

  useEffect(() => {
    mounted.current = true;
    void bootstrap();
    return () => { mounted.current = false; ++generation.current; };
  }, []);

  function change(patch: Partial<Scope>) { if (intent.current) void load({ ...intent.current, ...patch }); }
  function refresh() { if (intent.current) void load(intent.current); else void bootstrap(); }
  function retry() { if (intent.current) void load(intent.current, resetIntent.current); else void bootstrap(); }
  function reset() { if (latestSource.current) void load(defaults(latestSource.current), true); else void bootstrap(); }

  const snapshot = view?.snapshot;
  const rows = view ? view.snapshot.tickets.filter(t =>
    (!view.scope.team_ids.length || view.scope.team_ids.includes(t.team_id)) && view.scope.statuses.includes(t.status) &&
    Date.parse(t.created_at) >= Date.parse(view.scope.created_from + 'T00:00:00Z') && Date.parse(t.created_at) < Date.parse(view.scope.created_to + 'T00:00:00Z')
  ) : [];
  const activeRows = rows.filter(t => ACTIVE.includes(t.status));
  const overdue = snapshot ? activeRows.filter(t => Date.parse(t.due_at) < Date.parse(snapshot.as_of)).length : 0;
  const effort = activeRows.reduce((sum, t) => sum + t.remaining_minutes, 0) / 60;
  const counts = ACTIVE.map(status => ({ status, count: activeRows.filter(t => t.status === status).length }));
  const maximum = Math.max(1, ...counts.map(x => x.count));
  const prior = !!view && (loading || !!error || !scope || !sameScope(view.scope, scope));
  const teams = snapshot?.teams ?? [];
  const metricItems = [
    { key: 'ticket_count', label: 'Matching tickets', value: rows.length, unit: 'tickets' },
    { key: 'active_count', label: 'Active tickets', value: activeRows.length, unit: 'tickets' },
    { key: 'overdue_active_count', label: 'Overdue active', value: overdue, unit: 'tickets' },
    { key: 'remaining_effort_hours', label: 'Remaining active effort', value: effort, unit: 'hours' },
  ];

  return <FrameRoot data-eval="dashboard-root" className="support-dashboard">
    <style>{`
      .support-dashboard { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17263d; background: #f3f6fb; min-height: 100vh; padding: 28px; box-sizing: border-box; }
      .support-dashboard * { box-sizing: border-box; }
      .support-dashboard .shell { max-width: 1280px; margin: auto; }
      .support-dashboard h1 { font-size: 27px; letter-spacing: -.7px; margin: 4px 0 8px; }
      .support-dashboard h2 { font-size: 17px; margin: 0 0 8px; }
      .support-dashboard p { margin: 6px 0; }
      .support-dashboard .muted { color: #59697e; font-size: 13px; line-height: 1.5; }
      .support-dashboard .eyebrow { color: #4661a7; font-size: 11px; letter-spacing: 1.4px; font-weight: 800; }
      .support-dashboard .heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 22px; }
      .support-dashboard .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .support-dashboard button { cursor: pointer; font: inherit; border: 1px solid #cbd5e1; background: white; color: #243b5c; border-radius: 7px; padding: 9px 13px; font-size: 13px; }
      .support-dashboard button:hover { background: #eef3ff; border-color: #7c9ad2; }
      .support-dashboard button:focus-visible, .support-dashboard input:focus-visible, .support-dashboard select:focus-visible { outline: 3px solid #407ee9; outline-offset: 3px; }
      .support-dashboard button.primary { background: #234eab; color: white; border-color: #234eab; }
      .support-dashboard button:disabled, .support-dashboard input:disabled, .support-dashboard select:disabled { cursor: default; opacity: .55; }
      .support-dashboard .panel { background: white; border: 1px solid #dfe6ef; border-radius: 12px; padding: 20px; box-shadow: 0 2px 4px #17305305; }
      .support-dashboard .filters { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 20px; margin-bottom: 14px; }
      .support-dashboard .field { display: flex; flex-direction: column; gap: 7px; font-size: 12px; font-weight: 650; }
      .support-dashboard select, .support-dashboard input[type=date] { background: white; border: 1px solid #bbc9dc; color: #17263d; border-radius: 6px; padding: 9px; min-height: 38px; font: inherit; font-size: 13px; }
      .support-dashboard select { min-width: 220px; max-width: 350px; }
      .support-dashboard fieldset { margin: 0; padding: 0; border: 0; }
      .support-dashboard legend { margin-bottom: 8px; font-size: 12px; font-weight: 650; }
      .support-dashboard .status-options { display: flex; flex-wrap: wrap; gap: 12px; min-height: 38px; align-items: center; }
      .support-dashboard .status-options label { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; }
      .support-dashboard input[type=checkbox] { width: 16px; height: 16px; accent-color: #234eab; }
      .support-dashboard .state { border: 1px solid #d7e4f5; border-radius: 8px; background: #eaf1fb; padding: 12px 15px; font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
      .support-dashboard .state.error { background: #fff0ee; border-color: #f1c2bb; color: #842a22; }
      .support-dashboard .scope { color: #52657e; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; margin-top: 7px; }
      .support-dashboard .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
      .support-dashboard .metric-value { font-size: 30px; font-weight: 750; letter-spacing: -.5px; margin: 8px 0 3px; font-variant-numeric: tabular-nums; }
      .support-dashboard .metric-label { font-size: 12px; font-weight: 650; color: #586b84; }
      .support-dashboard .chart { margin-bottom: 18px; }
      .support-dashboard .bar { display: grid; grid-template-columns: 115px minmax(0, 1fr) 70px; align-items: center; gap: 12px; width: 100%; text-align: left; border-color: transparent; margin-top: 8px; padding: 10px; }
      .support-dashboard .bar[aria-pressed=true] { background: #eff4ff; border-color: #94b2ea; }
      .support-dashboard .plot { display: block; width: 100%; height: 20px; background: #edf1f7; border-left: 1px solid #bac7d9; overflow: hidden; }
      .support-dashboard .glyph { display: block; height: 20px; }
      .support-dashboard .bar-count { text-align: right; font-variant-numeric: tabular-nums; }
      .support-dashboard .table-scroll { overflow-x: auto; }
      .support-dashboard table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .support-dashboard th { text-align: left; white-space: nowrap; padding: 12px 10px; background: #f5f7fa; color: #576980; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
      .support-dashboard td { padding: 13px 10px; border-bottom: 1px solid #e9eef5; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .support-dashboard tbody tr:last-child td { border-bottom: 0; }
      .support-dashboard .tag { display: inline-block; font-size: 11px; font-weight: 650; padding: 4px 7px; border-radius: 5px; background: #f0f3fa; }
      .support-dashboard .empty { padding: 28px 16px; text-align: center; color: #5b6e87; }
      .support-dashboard .footnote { padding-top: 14px; font-size: 12px; color: #667991; line-height: 1.6; }
      @media (max-width: 760px) { .support-dashboard { padding: 16px; } .support-dashboard .heading { align-items: flex-start; flex-direction: column; } .support-dashboard .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .support-dashboard .bar { grid-template-columns: 90px minmax(0, 1fr) 55px; gap: 8px; } }
    `}</style>
    <main className="shell">
      <header className="heading">
        <div><div className="eyebrow">SUPPORT OPERATIONS · CONTROLLED SOURCE</div><h1>Ticket workload</h1><p className="muted">One shared scope for tickets, business metrics and active-status counts.</p></div>
        <div className="actions">
          <button data-eval="reset-filters" onClick={reset}>Reset filters</button>
          <button className="primary" data-eval="refresh-data" onClick={refresh}>Refresh data</button>
        </div>
      </header>
      <section className="panel filters" aria-label="Ticket filters">
        <label className="field">Team
          <select aria-label="Team" data-eval="team-filter" value={scope?.team_ids[0] ?? ''} disabled={!scope} onChange={e => change({ team_ids: e.target.value ? [e.target.value] : [] })}>
            <option value="">All teams</option>
            {teams.map(t => <option key={t.team_id} value={t.team_id}>{t.display_name} ({t.team_id})</option>)}
            {scope?.team_ids.filter(id => !teams.some(t => t.team_id === id)).map(id => <option key={id} value={id}>{id} (awaiting source validation)</option>)}
          </select>
        </label>
        <fieldset disabled={!scope}><legend>Status</legend><div className="status-options">
          {STATUSES.map(status => <label key={status}><input type="checkbox" aria-label={names[status]} data-eval="status-option" data-eval-key={status} checked={!!scope?.statuses.includes(status)} onChange={e => {
            const selected = intent.current?.statuses ?? [];
            change({ statuses: STATUSES.filter(s => s === status ? e.target.checked : selected.includes(s)) });
          }} />{names[status]}</label>)}
        </div></fieldset>
        <label className="field">Created from (UTC, inclusive)
          <input aria-label="Created from" type="date" data-eval="created-from" value={scope?.created_from ?? ''} disabled={!scope} onChange={e => change({ created_from: e.target.value })} />
        </label>
        <label className="field">Created to (UTC, exclusive)
          <input aria-label="Created to" type="date" data-eval="created-to" value={scope?.created_to ?? ''} disabled={!scope} onChange={e => change({ created_to: e.target.value })} />
        </label>
      </section>
      <div className={'state' + (error ? ' error' : '')} data-eval="view-state" aria-live="polite" role={error ? 'alert' : 'status'}>
        <strong>{error ? 'Source load failed.' : loading ? 'Loading source…' : 'Source loaded successfully.'}</strong>
        {error && <><p>{error}</p><button data-eval="retry-load" onClick={retry}>Retry</button></>}
        {prior && <p>Showing previous successful results for the scope and revision below. These results do not represent the pending or failed request.</p>}
        {!view && <p>No verified results are available yet.</p>}
        {notice && <p>{notice}</p>}
        {scope && (loading || error) && <p className="scope">Requested scope: {scopeText(scope)}</p>}
        {view && <div className="scope" data-eval="displayed-scope">{prior ? 'Previous displayed scope' : 'Displayed scope'}: {scopeText(view.scope)}<br />Snapshot revision: {view.snapshot.snapshot_revision} · Source as of: {utc(view.snapshot.as_of)} (UTC)</div>}
      </div>
      {view && <>
        <section className="metrics" aria-label={prior ? 'Previous scope metrics' : 'Scope metrics'}>
          {metricItems.map(m => <div className="panel" key={m.key}><div className="metric-label">{m.label}</div><div className="metric-value" data-eval="metric" data-eval-key={m.key} data-eval-unit={m.unit}>{number(m.value)}</div><div className="muted">{m.unit}</div></div>)}
        </section>
        <section className="panel chart" data-eval="status-chart" aria-label="Active tickets by status">
          <h2>Active tickets by status{prior ? ' · previous scope' : ''}</h2>
          <p className="muted">Counts in the displayed scope. Select a bar to request that status. All bars share a linear zero baseline.</p>
          {counts.map(({ status, count }) => <button className="bar" key={status} data-eval="status-bar" data-eval-key={status} aria-label={`${names[status]}: ${count} tickets. Select ${names[status]} status`} aria-pressed={scope?.statuses.length === 1 && scope.statuses[0] === status} onClick={() => change({ statuses: [status] })}>
            <span>{names[status]}</span>
            <span className="plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="width"><span className="glyph" data-eval="status-glyph" data-eval-key={status} style={{ width: `${count / maximum * 100}%`, background: colors[status] }} /></span>
            <span className="bar-count"><span data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count}</span> <small>tickets</small></span>
          </button>)}
          {activeRows.length === 0 && <p className="muted">No active tickets in the displayed scope. All status counts are zero.</p>}
        </section>
        <section className="panel" aria-label="Ticket records">
          <h2>Tickets{prior ? ' · previous scope' : ''}</h2><p className="muted">{rows.length} matching tickets · Team identities are preserved even when names match.</p>
          <div className="table-scroll"><table data-eval="tickets-table"><thead><tr><th>Ticket ID</th><th>Team name</th><th>Team ID</th><th>Status</th><th>Priority</th><th>Created at (UTC)</th><th>Due at (UTC)</th><th>Remaining effort (minutes)</th></tr></thead><tbody>
            {rows.map(t => <tr key={t.ticket_id} data-eval="ticket-row" data-eval-key={t.ticket_id}>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="ticket_id"><strong>{t.ticket_id}</strong></td>
              <td>{snapshot?.teams.find(team => team.team_id === t.team_id)?.display_name}</td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="team_id">{t.team_id}</td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="status"><span className="tag" style={{ color: colors[t.status] }}>{t.status}</span></td>
              <td>{t.priority}</td><td><time dateTime={t.created_at}>{utc(t.created_at)}</time></td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="due_at" data-eval-unit="UTC"><time dateTime={t.due_at}>{utc(t.due_at)}</time></td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{t.remaining_minutes}</td>
            </tr>)}
          </tbody></table></div>
          {rows.length === 0 && <div className="empty" data-eval="empty-state"><strong>No matching tickets.</strong><p>The displayed scope was loaded successfully. Try another team, status or created-date interval.</p></div>}
        </section>
        <footer className="footnote">Active = OPEN, IN_PROGRESS or WAITING. Overdue = active with due time strictly before the source as-of time. Remaining active effort = active remaining minutes ÷ 60. Created dates use UTC [start, end). This view reads synthetic local data only.</footer>
      </>}
    </main>
  </FrameRoot>;
}
