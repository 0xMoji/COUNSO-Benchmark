import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { readFile, callFunction } from '@dust/react-hooks';

type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type Ticket = {
  ticket_id: string;
  team_id: string;
  status: Status;
  priority: 'P1' | 'P2' | 'P3';
  created_at: string;
  due_at: string;
  remaining_minutes: number;
};
type Team = { team_id: string; display_name: string };
type Snapshot = {
  schema_version: 'support-snapshot-1';
  snapshot_revision: string;
  as_of: string;
  default_created_from: string;
  default_created_to: string;
  teams: Team[];
  tickets: Ticket[];
};
type Scope = {
  team_ids: string[];
  statuses: Status[];
  created_from: string;
  created_to: string;
};
type View = { snapshot: Snapshot; scope: Scope };
type Phase = 'loading' | 'ready' | 'pending' | 'error';
const statuses: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const activeStatuses: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const statusName: Record<Status, string> = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', CLOSED: 'Closed'
};
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const isText = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isDate = (v: unknown): v is string => isText(v) && datePattern.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isInstant = (v: unknown): v is string => isText(v) && !Number.isNaN(Date.parse(v));

function parseSnapshot(raw: unknown): Snapshot {
  if (!isObject(raw) || raw.schema_version !== 'support-snapshot-1' || !isText(raw.snapshot_revision) || !raw.snapshot_revision ||
      !isInstant(raw.as_of) || !isDate(raw.default_created_from) || !isDate(raw.default_created_to) ||
      !Array.isArray(raw.teams) || !Array.isArray(raw.tickets)) throw new Error('The source snapshot is invalid.');
  const teams = raw.teams as unknown[];
  const tickets = raw.tickets as unknown[];
  if (!teams.every(t => isObject(t) && isText(t.team_id) && !!t.team_id && isText(t.display_name)) ||
      !tickets.every(t => isObject(t) && isText(t.ticket_id) && !!t.ticket_id && isText(t.team_id) && !!t.team_id &&
        statuses.includes(t.status as Status) && ['P1','P2','P3'].includes(t.priority as string) &&
        isInstant(t.created_at) && isInstant(t.due_at) && typeof t.remaining_minutes === 'number' && Number.isInteger(t.remaining_minutes) && t.remaining_minutes >= 0)) {
    throw new Error('The source records are invalid.');
  }
  return raw as unknown as Snapshot;
}
function parseScope(raw: unknown): Scope {
  if (!isObject(raw) || !Array.isArray(raw.team_ids) || !Array.isArray(raw.statuses) ||
      !raw.team_ids.every(x => isText(x) && !!x) || !raw.statuses.every(x => statuses.includes(x as Status)) ||
      !isDate(raw.created_from) || !isDate(raw.created_to)) throw new Error('The source scope is invalid.');
  return raw as unknown as Scope;
}
function sameScope(a: Scope, b: Scope) {
  return a.created_from === b.created_from && a.created_to === b.created_to &&
    a.team_ids.length === b.team_ids.length && a.team_ids.every(x => b.team_ids.includes(x)) &&
    a.statuses.length === b.statuses.length && a.statuses.every(x => b.statuses.includes(x));
}
function defaultScope(snapshot: Snapshot): Scope {
  return { team_ids: [], statuses: [...statuses], created_from: snapshot.default_created_from, created_to: snapshot.default_created_to };
}
function scopeText(scope: Scope) {
  const teams = scope.team_ids.length ? scope.team_ids.join(', ') : 'all teams';
  const selected = scope.statuses.length ? scope.statuses.join(', ') : 'no statuses';
  return `${teams}; ${selected}; created UTC ${scope.created_from} ≤ date < ${scope.created_to}`;
}
function scopeRecords(view: View): Ticket[] {
  const { snapshot, scope } = view;
  const start = Date.parse(`${scope.created_from}T00:00:00Z`);
  const end = Date.parse(`${scope.created_to}T00:00:00Z`);
  return snapshot.tickets.filter(t =>
    (scope.team_ids.length === 0 || scope.team_ids.includes(t.team_id)) &&
    scope.statuses.includes(t.status) &&
    Date.parse(t.created_at) >= start && Date.parse(t.created_at) < end
  );
}
function hours(minutes: number) {
  return String(Number((minutes / 60).toFixed(3)));
}
const styles = `
  * { box-sizing: border-box; }
  .support-frame { background:#f5f7fb; min-height:100vh; color:#17233b; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding:24px; }
  .shell { max-width:1280px; margin:0 auto; }
  .hero { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
  .eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:11px; font-weight:800; color:#5371a1; margin:0 0 5px; }
  h1 { font-size:27px; letter-spacing:-.03em; margin:0 0 4px; }
  .subtitle { margin:0; color:#637087; font-size:14px; }
  .card { background:#fff; border:1px solid #dfe5ee; border-radius:16px; box-shadow:0 3px 14px rgba(15,35,70,.04); }
  .actions { display:flex; gap:8px; }
  button,select,input { font:inherit; }
  button { cursor:pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid #5887f8; outline-offset:2px; }
  .action { padding:9px 14px; background:#fff; border:1px solid #cbd5e3; border-radius:9px; font-weight:650; color:#263c5f; }
  .action:hover { background:#eef4ff; }
  .action.primary { background:#1d4ed8; color:#fff; border-color:#1d4ed8; }
  .action.primary:hover { background:#153daa; }
  .filters { padding:17px 18px; margin-bottom:15px; }
  .filters-heading { font-size:13px; font-weight:800; color:#52617a; text-transform:uppercase; letter-spacing:.08em; margin:0 0 13px; }
  .filter-grid { display:grid; grid-template-columns:minmax(170px,1.2fr) minmax(285px,2fr) minmax(150px,1fr) minmax(150px,1fr); gap:18px; align-items:end; }
  .filter-label { font-size:12px; font-weight:700; color:#52617a; display:block; margin-bottom:6px; }
  select,input[type=date] { width:100%; height:38px; padding:7px 10px; background:white; color:#1e2c46; border:1px solid #cad4e3; border-radius:8px; }
  .status-options { display:flex; gap:7px 14px; min-height:38px; flex-wrap:wrap; align-items:center; }
  .status-choice { display:inline-flex; gap:6px; align-items:center; white-space:nowrap; font-size:13px; color:#243754; cursor:pointer; }
  .status-choice input { accent-color:#1d4ed8; width:16px; height:16px; margin:0; }
  .status-strip { border-radius:10px; padding:11px 14px; font-size:13px; margin-bottom:15px; border:1px solid #d7e0ed; background:#f7faff; color:#385171; line-height:1.5; }
  .status-strip.error { background:#fff1f0; border-color:#f2b9b5; color:#8d2924; }
  .status-strip.pending { background:#fff9e9; border-color:#efd99a; color:#725619; }
  .status-strip strong { font-weight:800; }
  .status-strip .action { margin-left:10px; }
  .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:15px; }
  .metric { padding:16px 18px; min-height:103px; }
  .metric-label { color:#5b6a80; font-size:13px; font-weight:650; }
  .metric-value { margin-top:9px; font-size:27px; letter-spacing:-.03em; font-weight:800; font-variant-numeric:tabular-nums; }
  .metric-unit { font-size:13px; margin-left:5px; font-weight:600; color:#65748b; letter-spacing:0; }
  .panels { display:grid; grid-template-columns:minmax(280px, 390px) minmax(0,1fr); gap:15px; align-items:start; }
  .chart,.table-card { padding:18px; }
  .panel-title { font-size:17px; font-weight:800; margin:0 0 4px; }
  .panel-note { font-size:12px; color:#6d7b90; margin:0 0 15px; line-height:1.4; }
  .bars { display:flex; flex-direction:column; gap:8px; }
  .bar-button { width:100%; display:grid; grid-template-columns:96px minmax(0,1fr) 32px; align-items:center; gap:9px; padding:9px 10px; text-align:left; background:#fff; border:1px solid #e1e6ef; border-radius:9px; color:#273d5d; }
  .bar-button:hover { background:#f4f7fe; }
  .bar-button.selected { border-color:#6688e5; background:#eef3ff; }
  .bar-label { font-size:12px; font-weight:700; }
  .bar-count { font-variant-numeric:tabular-nums; text-align:right; font-weight:800; }
  .plot { height:22px; width:100%; background:#edf1f7; border-radius:4px; overflow:hidden; position:relative; }
  .glyph { height:100%; display:block; background:#4475d9; border-radius:4px; }
  .bar-button:nth-child(2) .glyph { background:#24a495; }
  .bar-button:nth-child(3) .glyph { background:#d5983d; }
  .table-scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:670px; font-size:13px; }
  th { text-align:left; color:#627187; font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:11px 9px; border-bottom:1px solid #dce4ef; }
  td { padding:12px 9px; border-bottom:1px solid #edf0f5; white-space:nowrap; color:#243750; }
  tr:last-child td { border-bottom:0; }
  .ticket-id { font-weight:800; color:#214fad; }
  .badge { border-radius:20px; background:#eaf1ff; color:#2854a1; padding:4px 7px; font-size:11px; font-weight:750; }
  .empty { text-align:center; color:#61718a; padding:32px 12px; }
  .hint { font-size:12px; color:#68788e; margin-top:10px; }
  @media (max-width:900px) { .filter-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .panels { grid-template-columns:1fr; } }
  @media (max-width:620px) { .support-frame { padding:13px; } .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .filter-grid { grid-template-columns:1fr; } .actions { width:100%; } }
`;

export default function SupportOperationsFrame() {
  const [intent, setIntent] = useState<Scope | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('Reading the current synthetic source…');
  const [invalidation, setInvalidation] = useState('');
  const intentRef = useRef<Scope | null>(null);
  const viewRef = useRef<View | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1; }; }, []);
  const setCurrentView = useCallback((next: View) => { viewRef.current = next; setView(next); }, []);

  const load: (scope: Scope, resetToDefaults?: boolean) => Promise<void> = useCallback(async (scope: Scope, resetToDefaults = false) => {
    const request = ++sequence.current;
    setPhase('pending');
    setMessage('Loading current source for the selected scope…');
    try {
      const raw = await callFunction('load-data', scope);
      if (!mounted.current || request !== sequence.current) return;
      if (!isObject(raw)) throw new Error('The source returned an invalid response.');
      const snapshot = parseSnapshot(raw.snapshot);
      const echoed = parseScope(raw.scope);
      if (!sameScope(scope, echoed)) throw new Error('The source returned a different scope.');
      if (resetToDefaults) {
        const defaults = defaultScope(snapshot);
        if (!sameScope(defaults, scope)) {
          intentRef.current = defaults;
          setIntent(defaults);
          setInvalidation('Source default dates changed; Reset now uses the current snapshot defaults.');
          await load(defaults);
          return;
        }
      }
      const selectedTeam = scope.team_ids[0];
      if (selectedTeam && !snapshot.teams.some(team => team.team_id === selectedTeam)) {
        const adjusted = { ...scope, team_ids: [] };
        intentRef.current = adjusted;
        setIntent(adjusted);
        setInvalidation(`Team ${selectedTeam} is no longer in this snapshot; showing all teams.`);
        await load(adjusted);
        return;
      }
      setCurrentView({ snapshot, scope: echoed });
      setPhase('ready');
      setMessage('Current source loaded.');
    } catch (err) {
      if (!mounted.current || request !== sequence.current) return;
      setPhase('error');
      setMessage(err instanceof Error ? err.message : 'The source request failed.');
    }
  }, [setCurrentView]);

  useEffect(() => {
    const request = ++sequence.current;
    (async () => {
      try {
        const metadata = await readFile('./dataset.json');
        if (!metadata) throw new Error('The source file could not be read.');
        const snapshot = parseSnapshot(JSON.parse(await metadata.file.text()));
        if (!mounted.current || request !== sequence.current) return;
        const scope = defaultScope(snapshot);
        intentRef.current = scope;
        setIntent(scope);
        setCurrentView({ snapshot, scope });
        setPhase('ready');
        setMessage('Current source loaded.');
      } catch (err) {
        if (!mounted.current || request !== sequence.current) return;
        setPhase('error');
        setMessage(err instanceof Error ? err.message : 'The source file could not be read.');
      }
    })();
  }, [setCurrentView]);

  const changeIntent = useCallback((next: Scope, resetToDefaults = false) => {
    intentRef.current = next;
    setIntent(next);
    setInvalidation('');
    if (isDate(next.created_from) && isDate(next.created_to)) void load(next, resetToDefaults);
    else { sequence.current += 1; setPhase('error'); setMessage('Enter valid UTC created dates to load this scope.'); }
  }, [load]);

  const reset = () => {
    const snapshot = viewRef.current?.snapshot;
    if (!snapshot) return;
    const next = defaultScope(snapshot);
    changeIntent(next, true);
  };
  const refresh = () => { if (intentRef.current) void load(intentRef.current); };
  const retry = () => {
    if (intentRef.current) void load(intentRef.current);
    else {
      const request = ++sequence.current;
      setPhase('loading');
      setMessage('Reading the current synthetic source…');
      (async () => {
        try {
          const metadata = await readFile('./dataset.json');
          if (!metadata) throw new Error('The source file could not be read.');
          const snapshot = parseSnapshot(JSON.parse(await metadata.file.text()));
          if (!mounted.current || request !== sequence.current) return;
          const scope = defaultScope(snapshot);
          intentRef.current = scope;
          setIntent(scope);
          setCurrentView({ snapshot, scope });
          setPhase('ready');
          setMessage('Current source loaded.');
        } catch (err) {
          if (!mounted.current || request !== sequence.current) return;
          setPhase('error');
          setMessage(err instanceof Error ? err.message : 'The source file could not be read.');
        }
      })();
    }
  };

  const records = useMemo(() => view ? scopeRecords(view) : [], [view]);
  const active = records.filter(t => activeStatuses.includes(t.status));
  const overdue = active.filter(t => Date.parse(t.due_at) < Date.parse(view!.snapshot.as_of));
  const effortMinutes = active.reduce((sum, t) => sum + t.remaining_minutes, 0);
  const counts: Record<Status, number> = { OPEN: 0, IN_PROGRESS: 0, WAITING: 0, CLOSED: 0 };
  active.forEach(t => { counts[t.status] += 1; });
  const maxCount = Math.max(0, ...activeStatuses.map(s => counts[s]));
  const teams = view?.snapshot.teams || [];
  const teamNames = new Map(teams.map(t => [t.team_id, t.display_name]));
  const prior = !!view && ((!!intent && !sameScope(intent, view.scope)) || phase === 'pending' || phase === 'error');
  const statusText = phase === 'error' ? `Source error: ${message}` : phase === 'pending' || phase === 'loading' ? message : 'Showing current synthetic source.';

  return <FrameRoot data-eval="dashboard-root" className="support-frame">
    <style>{styles}</style>
    <main className="shell">
      <header className="hero">
        <div><p className="eyebrow">Support operations</p><h1>Ticket workload</h1><p className="subtitle">Synthetic source snapshot · UTC created-date range · active effort</p></div>
        <div className="actions">
          <button type="button" className="action" data-eval="reset-filters" onClick={reset} disabled={!intent}>Reset</button>
          <button type="button" className="action primary" data-eval="refresh-data" onClick={refresh} disabled={!intent}>Refresh data</button>
        </div>
      </header>
      <section className="filters card" aria-label="Ticket filters">
        <p className="filters-heading">Scope</p>
        <div className="filter-grid">
          <label><span className="filter-label">Team</span><select data-eval="team-filter" data-eval-key={intent?.team_ids[0] || ''} aria-label="Team" value={intent?.team_ids[0] || ''} disabled={!intent} onChange={e => intent && changeIntent({ ...intent, team_ids: e.target.value ? [e.target.value] : [] })}>
            <option value="">All teams</option>
            {teams.map(team => <option key={team.team_id} value={team.team_id}>{team.display_name || '(Unnamed team)'} · {team.team_id}</option>)}
          </select></label>
          <div role="group" aria-label="Statuses"><span className="filter-label">Status</span><div className="status-options">
            {statuses.map(status => <label className="status-choice" key={status}><input type="checkbox" data-eval="status-option" data-eval-key={status} aria-label={statusName[status]} disabled={!intent} checked={!!intent?.statuses.includes(status)} onChange={e => {
              if (!intent) return;
              const selected = e.target.checked ? statuses.filter(s => intent.statuses.includes(s) || s === status) : intent.statuses.filter(s => s !== status);
              changeIntent({ ...intent, statuses: selected });
            }}/><span>{statusName[status]}</span></label>)}
          </div></div>
          <label><span className="filter-label">Created from (UTC, inclusive)</span><input type="date" data-eval="created-from" value={intent?.created_from || ''} disabled={!intent} onChange={e => intent && changeIntent({ ...intent, created_from: e.target.value })}/></label>
          <label><span className="filter-label">Created to (UTC, exclusive)</span><input type="date" data-eval="created-to" value={intent?.created_to || ''} disabled={!intent} onChange={e => intent && changeIntent({ ...intent, created_to: e.target.value })}/></label>
        </div>
      </section>
      <div className={`status-strip ${phase}`} data-eval="view-state" role="status" aria-live="polite">
        <strong>{statusText}</strong>
        {invalidation && <span> {invalidation}</span>}
        {phase === 'error' && <button type="button" className="action" data-eval="retry-load" onClick={retry}>Retry</button>}
        {prior && view && <span> Displayed figures are from the previous view below, not the selected controls.</span>}
        {intent && <div>Selected scope: {scopeText(intent)}</div>}
        {view && <div data-eval="displayed-scope">Displayed scope: {scopeText(view.scope)} · snapshot {view.snapshot.snapshot_revision} · as of {view.snapshot.as_of}</div>}
      </div>
      <section className="metrics" aria-label="Business metrics">
        {([
          ['ticket_count', 'Tickets', records.length, 'tickets'],
          ['active_count', 'Active tickets', active.length, 'tickets'],
          ['overdue_active_count', 'Overdue active', overdue.length, 'tickets'],
          ['remaining_effort_hours', 'Remaining active effort', hours(effortMinutes), 'hours']
        ] as const).map(([key, label, value, unit]) => <article className="metric card" key={key} data-eval="metric" data-eval-key={key} data-eval-unit={unit}>
          <div className="metric-label">{label}</div><div className="metric-value">{view ? value : '—'}<span className="metric-unit">{unit}</span></div>
        </article>)}
      </section>
      <div className="panels">
        <section className="chart card" data-eval="status-chart" aria-label="Active tickets by status">
          <h2 className="panel-title">Active status</h2><p className="panel-note">Ticket counts in the displayed scope. Select a bar to filter to that status.</p>
          <div className="bars">{activeStatuses.map(status => <button type="button" className={`bar-button ${view?.scope.statuses.length === 1 && view.scope.statuses[0] === status ? 'selected' : ''}`} data-eval="status-bar" data-eval-key={status} key={status} aria-label={`Filter to ${statusName[status]}: ${view ? counts[status] : 0} tickets`} disabled={!intent} onClick={() => intent && changeIntent({ ...intent, statuses: [status] })}>
            <span className="bar-label">{statusName[status]}</span>
            <span className="plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="width"><span className="glyph" data-eval="status-glyph" data-eval-key={status} style={{ width: maxCount ? `${100 * counts[status] / maxCount}%` : '0%' }} /></span>
            <span className="bar-count" data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{view ? counts[status] : '—'}</span>
          </button>)}</div>
          {view && records.length === 0 && <p className="hint">No matching tickets; all active status counts are zero.</p>}
        </section>
        <section className="table-card card" aria-label="Filtered tickets">
          <h2 className="panel-title">Tickets</h2><p className="panel-note">{view ? `${records.length} matching ticket${records.length === 1 ? '' : 's'} in displayed scope` : 'Waiting for source'} · dates shown in UTC</p>
          <div className="table-scroll"><table data-eval="tickets-table"><thead><tr><th>Ticket ID</th><th>Team</th><th>Status</th><th>Priority</th><th>Created at (UTC)</th><th>Due at (UTC)</th><th>Remaining (minutes)</th></tr></thead><tbody>
            {records.map(t => <tr data-eval="ticket-row" data-eval-key={t.ticket_id} key={t.ticket_id}>
              <td className="ticket-id" data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="ticket_id">{t.ticket_id}</td>
              <td>{teamNames.get(t.team_id) || '(Unknown team)'} · <span data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="team_id">{t.team_id}</span></td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="status"><span className="badge">{t.status}</span></td>
              <td>{t.priority}</td><td>{t.created_at}</td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="due_at">{t.due_at}</td>
              <td data-eval="ticket-cell" data-eval-key={t.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{t.remaining_minutes}</td>
            </tr>)}
          </tbody></table></div>
          {view && records.length === 0 && <div className="empty" data-eval="empty-state">No tickets match the displayed scope. The source loaded successfully.</div>}
        </section>
      </div>
    </main>
  </FrameRoot>;
}
