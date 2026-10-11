import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { callFunction, readFile } from '@dust/react-hooks';

type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type Scope = {
  team_ids: string[];
  statuses: Status[];
  created_from: string;
  created_to: string;
};
type Team = { team_id: string; display_name: string };
type Ticket = {
  ticket_id: string;
  team_id: string;
  status: Status;
  priority: 'P1' | 'P2' | 'P3';
  created_at: string;
  due_at: string;
  remaining_minutes: number;
};
type Snapshot = {
  schema_version: 'support-snapshot-1';
  snapshot_revision: string;
  as_of: string;
  default_created_from: string;
  default_created_to: string;
  teams: Team[];
  tickets: Ticket[];
};
type View = { snapshot: Snapshot; scope: Scope };
type Phase = 'loading' | 'ready' | 'error' | 'invalid';
type Reason = 'filters' | 'refresh' | 'retry' | 'reset';

const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const ACTIVE_STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const STATUS_COLORS: Record<Status, string> = {
  OPEN: '#2563eb',
  IN_PROGRESS: '#7c3aed',
  WAITING: '#b77912',
  CLOSED: '#64748b',
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function isInstant(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value));
}
function parseScope(value: unknown): Scope {
  if (!object(value) || !Array.isArray(value.team_ids) || !Array.isArray(value.statuses) ||
      !value.team_ids.every(nonempty) || new Set(value.team_ids).size !== value.team_ids.length ||
      !value.statuses.every(s => typeof s === 'string' && STATUSES.includes(s as Status)) ||
      new Set(value.statuses).size !== value.statuses.length ||
      !isDate(value.created_from) || !isDate(value.created_to)) {
    throw new Error('The source returned an invalid scope.');
  }
  return {
    team_ids: [...value.team_ids] as string[],
    statuses: [...value.statuses] as Status[],
    created_from: value.created_from,
    created_to: value.created_to,
  };
}
function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || value.schema_version !== 'support-snapshot-1' ||
      !nonempty(value.snapshot_revision) || !isInstant(value.as_of) ||
      !isDate(value.default_created_from) || !isDate(value.default_created_to) ||
      !Array.isArray(value.teams) || !Array.isArray(value.tickets)) {
    throw new Error('The source returned an invalid support snapshot.');
  }
  const teamIds = new Set<string>();
  for (const team of value.teams) {
    if (!object(team) || !nonempty(team.team_id) || typeof team.display_name !== 'string' ||
        teamIds.has(team.team_id)) {
      throw new Error('The source has an invalid or duplicate team identity.');
    }
    teamIds.add(team.team_id);
  }
  const ticketIds = new Set<string>();
  for (const ticket of value.tickets) {
    if (!object(ticket) || !nonempty(ticket.ticket_id) || ticketIds.has(ticket.ticket_id) ||
        !nonempty(ticket.team_id) || !teamIds.has(ticket.team_id) ||
        typeof ticket.status !== 'string' || !STATUSES.includes(ticket.status as Status) ||
        !['P1', 'P2', 'P3'].includes(String(ticket.priority)) ||
        !isInstant(ticket.created_at) || !isInstant(ticket.due_at) ||
        typeof ticket.remaining_minutes !== 'number' || !Number.isInteger(ticket.remaining_minutes) ||
        ticket.remaining_minutes < 0) {
      throw new Error('The source has an invalid ticket record.');
    }
    ticketIds.add(ticket.ticket_id);
  }
  return value as unknown as Snapshot;
}
function copyScope(scope: Scope): Scope {
  return { ...scope, team_ids: [...scope.team_ids], statuses: [...scope.statuses] };
}
function defaultScope(snapshot: Snapshot): Scope {
  return {
    team_ids: [],
    statuses: [...STATUSES],
    created_from: snapshot.default_created_from,
    created_to: snapshot.default_created_to,
  };
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.created_from === b.created_from && a.created_to === b.created_to &&
    a.team_ids.length === b.team_ids.length && a.team_ids.every(id => b.team_ids.includes(id)) &&
    a.statuses.length === b.statuses.length && a.statuses.every(status => b.statuses.includes(status));
}
function scopeText(scope: Scope): string {
  return `Team IDs: ${scope.team_ids.length ? scope.team_ids.join(', ') : 'ALL'}; ` +
    `Statuses: ${scope.statuses.length ? scope.statuses.join(', ') : 'NONE'}; ` +
    `Created UTC: [${scope.created_from}, ${scope.created_to})`;
}
function derive(view: View) {
  const { snapshot, scope } = view;
  const start = Date.parse(`${scope.created_from}T00:00:00Z`);
  const end = Date.parse(`${scope.created_to}T00:00:00Z`);
  const rows = snapshot.tickets.filter(ticket => {
    const created = Date.parse(ticket.created_at);
    return (scope.team_ids.length === 0 || scope.team_ids.includes(ticket.team_id)) &&
      scope.statuses.includes(ticket.status) && created >= start && created < end;
  });
  const active = rows.filter(ticket => ACTIVE_STATUSES.includes(ticket.status));
  const asOf = Date.parse(snapshot.as_of);
  const overdue = active.filter(ticket => Date.parse(ticket.due_at) < asOf).length;
  const minutes = active.reduce((sum, ticket) => sum + ticket.remaining_minutes, 0);
  const counts = ACTIVE_STATUSES.map(status => ({
    status,
    count: active.filter(ticket => ticket.status === status).length,
  }));
  return { rows, active: active.length, overdue, hours: minutes / 60, counts };
}
function hoursText(hours: number): string {
  // Rounding is presentation-only; all calculations keep the original minutes.
  return String(Number(hours.toFixed(6)));
}
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The source read did not succeed.';
}

const CSS = `
.support-frame { box-sizing: border-box; min-height: 100vh; background: #f4f7fb; color: #17243a; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
.support-frame * { box-sizing: border-box; }
.support-frame .shell { max-width: 1380px; margin: 0 auto; }
.support-frame h1, .support-frame h2, .support-frame p { margin: 0; }
.support-frame h1 { font-size: 30px; font-weight: 750; letter-spacing: -0.8px; line-height: 1.2; }
.support-frame h2 { font-size: 18px; font-weight: 700; }
.support-frame .eyebrow { font-size: 11px; font-weight: 750; letter-spacing: 1.6px; color: #52657d; margin-bottom: 7px; }
.support-frame .header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 23px; }
.support-frame .subtitle { color: #52657d; font-size: 13px; line-height: 1.6; margin-top: 7px; }
.support-frame .source-tag { display: inline-flex; gap: 8px; align-items: center; border: 1px solid #dbe4ee; background: white; border-radius: 20px; padding: 8px 12px; font-size: 12px; color: #52657d; white-space: nowrap; }
.support-frame .source-dot { width: 7px; height: 7px; border-radius: 50%; background: #4b70a7; }
.support-frame .card { border: 1px solid #dce4ee; border-radius: 12px; background: white; box-shadow: 0 2px 5px #162d4910; }
.support-frame .filters { padding: 18px 20px; margin-bottom: 14px; }
.support-frame .section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.support-frame .actions { display: flex; gap: 8px; }
.support-frame button, .support-frame select, .support-frame input { font: inherit; }
.support-frame button { cursor: pointer; }
.support-frame button:disabled, .support-frame select:disabled, .support-frame input:disabled { cursor: not-allowed; opacity: 0.5; }
.support-frame button:focus-visible, .support-frame select:focus-visible, .support-frame input:focus-visible { outline: 3px solid #2563eb; outline-offset: 3px; }
.support-frame .action { border: 1px solid #cbd6e5; background: white; color: #233b59; border-radius: 7px; padding: 8px 13px; font-size: 13px; font-weight: 650; }
.support-frame .action:hover:not(:disabled) { background: #eff5fc; }
.support-frame .primary { background: #1e4fb0; color: white; border-color: #1e4fb0; }
.support-frame .primary:hover:not(:disabled) { background: #173f91; }
.support-frame .filter-grid { display: grid; grid-template-columns: minmax(230px,1.2fr) minmax(170px,0.8fr) minmax(170px,0.8fr); gap: 16px; }
.support-frame .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.support-frame .field-label { font-size: 12px; font-weight: 700; color: #344962; }
.support-frame .field select, .support-frame .field input { width: 100%; min-height: 39px; border: 1px solid #b9c8dc; border-radius: 7px; padding: 8px 10px; background: white; color: #17243a; font-size: 13px; }
.support-frame .hint { color: #64748b; font-size: 11px; }
.support-frame fieldset { margin: 16px 0 0; padding: 0; border: 0; }
.support-frame legend { font-size: 12px; font-weight: 700; color: #344962; margin-bottom: 9px; }
.support-frame .status-options { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.support-frame .status-choice { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #d4deeb; border-radius: 7px; padding: 8px 10px; font-size: 12px; cursor: pointer; background: #fafcfe; }
.support-frame .status-choice input { margin: 0; width: 16px; height: 16px; accent-color: #2458b4; }
.support-frame .minor { padding: 6px 9px; border: 0; background: transparent; color: #2758ac; font-size: 12px; border-radius: 5px; }
.support-frame .minor:hover { background: #edf3fc; }
.support-frame .view-state { border: 1px solid #c8dbeb; border-radius: 8px; padding: 12px 14px; background: #edf5fc; color: #254468; font-size: 13px; line-height: 1.6; margin-bottom: 12px; }
.support-frame .view-state.error { border-color: #efb7af; background: #fff0ed; color: #8b3027; }
.support-frame .view-state.invalid { border-color: #e5cf9d; background: #fff9e9; color: #765013; }
.support-frame .state-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.support-frame .requested { margin-top: 5px; font-size: 12px; overflow-wrap: anywhere; }
.support-frame .notice { border-left: 3px solid #ba7c11; padding: 9px 12px; color: #735019; background: #fff8e7; margin-bottom: 12px; font-size: 12px; line-height: 1.5; }
.support-frame .scope { padding: 12px 15px; font-size: 12px; line-height: 1.65; color: #51637a; background: #eaf0f7; border-radius: 8px; margin-bottom: 17px; overflow-wrap: anywhere; }
.support-frame .scope strong { color: #334b68; }
.support-frame .metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 13px; margin-bottom: 18px; }
.support-frame .metric-card { padding: 18px 19px; }
.support-frame .metric-title { font-size: 12px; color: #52657d; font-weight: 650; }
.support-frame .metric-number { font-size: 31px; line-height: 1.25; font-weight: 750; color: #183555; margin-top: 7px; font-variant-numeric: tabular-nums; }
.support-frame .metric-unit { font-size: 12px; font-weight: 500; color: #64748b; margin-left: 6px; }
.support-frame .metric-note { color: #64748b; font-size: 11px; margin-top: 7px; line-height: 1.45; }
.support-frame .overdue .metric-number { color: #a44328; }
.support-frame .chart-card { padding: 19px 20px; margin-bottom: 18px; }
.support-frame .chart-note { color: #52657d; font-size: 12px; line-height: 1.5; margin-top: 6px; margin-bottom: 15px; }
.support-frame .chart-rows { display: grid; gap: 8px; }
.support-frame .bar-button { width: 100%; display: grid; grid-template-columns: 132px minmax(60px,1fr) 74px; gap: 14px; align-items: center; text-align: left; background: #fff; border: 1px solid #dce4ee; padding: 11px 12px; border-radius: 8px; color: #283f5a; }
.support-frame .bar-button:hover { background: #f6f9fd; border-color: #98b4db; }
.support-frame .bar-button[aria-pressed="true"] { background: #eff5ff; border-color: #4978c9; }
.support-frame .bar-label { font-size: 12px; font-weight: 650; }
.support-frame .plot { width: 100%; height: 18px; background: #eaf0f7; border-radius: 3px; position: relative; overflow: hidden; }
.support-frame .glyph { height: 100%; display: block; border-radius: 0 3px 3px 0; }
.support-frame .bar-value { text-align: right; white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
.support-frame .bar-value strong { font-weight: 750; font-size: 15px; }
.support-frame .chart-empty { color: #64748b; font-size: 12px; margin-top: 13px; }
.support-frame .table-card { overflow: hidden; }
.support-frame .table-heading { padding: 18px 20px 5px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.support-frame .table-count { font-size: 12px; color: #64748b; }
.support-frame .table-scroll { width: 100%; overflow-x: auto; }
.support-frame table { width: 100%; border-collapse: collapse; font-size: 12px; }
.support-frame caption { padding: 6px 20px 15px; text-align: left; color: #64748b; font-size: 11px; }
.support-frame th { background: #f1f5fa; text-align: left; font-size: 11px; font-weight: 700; color: #51637a; padding: 11px 13px; border-top: 1px solid #e4ebf3; border-bottom: 1px solid #e1e8f1; white-space: nowrap; }
.support-frame td { padding: 11px 13px; border-bottom: 1px solid #edf1f6; vertical-align: middle; }
.support-frame tbody tr:last-child td { border-bottom: 0; }
.support-frame tbody tr:hover { background: #fafcff; }
.support-frame .identity { font-weight: 650; white-space: nowrap; }
.support-frame .team-name { color: #344962; margin-bottom: 3px; white-space: nowrap; }
.support-frame .team-id { font-size: 10px; color: #64748b; white-space: nowrap; }
.support-frame .status-badge { display: inline-block; border-radius: 5px; padding: 4px 6px; background: #f0f4fa; font-size: 10px; font-weight: 700; white-space: nowrap; }
.support-frame .timestamp { font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.support-frame .due-overdue { color: #9b3927; }
.support-frame .effort { white-space: nowrap; font-variant-numeric: tabular-nums; }
.support-frame .empty { text-align: center; padding: 28px 12px; color: #52657d; font-size: 13px; }
.support-frame .empty small { display: block; font-size: 12px; color: #64748b; margin-top: 7px; }
.support-frame .no-source { padding: 35px 20px; text-align: center; color: #52657d; font-size: 13px; }
.support-frame .footer { font-size: 11px; color: #6c7d93; margin-top: 15px; line-height: 1.6; }
@media (max-width: 800px) {
  .support-frame { padding: 18px; }
  .support-frame .header { align-items: flex-start; }
  .support-frame .filter-grid { grid-template-columns: 1fr 1fr; }
  .support-frame .filter-grid .field:first-child { grid-column: 1 / -1; }
  .support-frame .metrics { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@media (max-width: 480px) {
  .support-frame { padding: 12px; }
  .support-frame h1 { font-size: 25px; }
  .support-frame .header { flex-direction: column; gap: 10px; }
  .support-frame .filter-grid { grid-template-columns: 1fr; }
  .support-frame .filter-grid .field:first-child { grid-column: auto; }
  .support-frame .filters, .support-frame .chart-card { padding: 15px 12px; }
  .support-frame .metric-card { padding: 14px 12px; }
  .support-frame .metric-number { font-size: 26px; }
  .support-frame .bar-button { grid-template-columns: 104px minmax(40px,1fr) 52px; gap: 7px; padding: 10px 7px; }
  .support-frame .bar-label { font-size: 10px; }
  .support-frame .bar-value { font-size: 10px; }
}
`;

export default function SupportOperationsFrame() {
  const [source, setSource] = useState<Snapshot | null>(null);
  const [intent, setIntent] = useState<Scope | null>(null);
  const [displayed, setDisplayed] = useState<View | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const intentRef = useRef<Scope | null>(null);
  const sourceRef = useRef<Snapshot | null>(null);
  const requestSerial = useRef(0);

  function rememberIntent(next: Scope) {
    const copied = copyScope(next);
    intentRef.current = copied;
    setIntent(copied);
  }

  async function initialRead() {
    const request = ++requestSerial.current;
    setPhase('loading');
    setError('');
    setNotice('');
    try {
      // readFile returns metadata; the browser File is its .file property.
      const frameFile = await readFile('./dataset.json');
      if (request !== requestSerial.current) return;
      if (!frameFile) throw new Error('The support source is unavailable. Retry to read it again.');
      const content = await frameFile.file.text();
      if (request !== requestSerial.current) return;
      const snapshot = parseSnapshot(JSON.parse(content));
      const scope = defaultScope(snapshot);
      sourceRef.current = snapshot;
      setSource(snapshot);
      rememberIntent(scope);
      setDisplayed({ snapshot, scope });
      setPhase('ready');
    } catch (failure) {
      if (request !== requestSerial.current) return;
      setError(errorText(failure));
      setPhase('error');
    }
  }

  async function requestScope(next: Scope, reason: Reason, preserveNotice = false): Promise<void> {
    // Increment synchronously at intent time, not when a response arrives.
    // Older successes AND older failures are ignored at every completion.
    const request = ++requestSerial.current;
    const requested = copyScope(next);
    rememberIntent(requested);
    setError('');
    if (!preserveNotice) setNotice('');
    if (!isDate(requested.created_from) || !isDate(requested.created_to)) {
      setPhase('invalid');
      return;
    }
    setPhase('loading');
    try {
      const result = await callFunction('load-data', copyScope(requested));
      if (request !== requestSerial.current) return;
      if (!object(result)) throw new Error('The source returned an invalid load result.');
      const echoed = parseScope(result.scope);
      if (!sameScope(echoed, requested)) {
        throw new Error('The returned scope does not match the requested filters. The result was not applied.');
      }
      const snapshot = parseSnapshot(result.snapshot);
      sourceRef.current = snapshot;
      setSource(snapshot);

      // Reset reads current source data; if its manifest defaults have changed,
      // request those actual defaults before presenting a completed reset.
      if (reason === 'reset') {
        const currentDefaults = defaultScope(snapshot);
        if (!sameScope(currentDefaults, requested)) {
          setNotice('Reset is using the date defaults from the newly loaded source snapshot.');
          await requestScope(currentDefaults, 'reset', true);
          return;
        }
      }
      const available = new Set(snapshot.teams.map(team => team.team_id));
      const disappeared = requested.team_ids.filter(id => !available.has(id));
      if (disappeared.length > 0) {
        const corrected = { ...requested, team_ids: [] };
        setNotice(`Team ID ${disappeared.join(', ')} is no longer in snapshot ${snapshot.snapshot_revision}. The team filter was changed to All teams; the other selections were kept.`);
        await requestScope(corrected, reason, true);
        return;
      }
      // All business facts below are derived from this one verified view.
      setDisplayed({ snapshot, scope: copyScope(echoed) });
      setPhase('ready');
    } catch (failure) {
      if (request !== requestSerial.current) return;
      setError(errorText(failure));
      setPhase('error');
    }
  }

  useEffect(() => {
    void initialRead();
    return () => { requestSerial.current += 1; };
  }, []);

  function changeScope(change: Partial<Scope>) {
    const current = intentRef.current;
    if (current) void requestScope({ ...current, ...change }, 'filters');
  }
  function toggleStatus(status: Status, checked: boolean) {
    const current = intentRef.current;
    if (!current) return;
    const selected = new Set(current.statuses);
    if (checked) selected.add(status); else selected.delete(status);
    changeScope({ statuses: STATUSES.filter(candidate => selected.has(candidate)) });
  }
  function refresh() {
    const current = intentRef.current;
    if (current) void requestScope(current, 'refresh');
  }
  function reset() {
    const snapshot = sourceRef.current;
    if (snapshot) void requestScope(defaultScope(snapshot), 'reset');
  }
  function retry() {
    const current = intentRef.current;
    if (current) void requestScope(current, 'retry'); else void initialRead();
  }

  const facts = useMemo(() => displayed ? derive(displayed) : null, [displayed]);
  const teamNames = useMemo(() => new Map<string, string>((displayed?.snapshot.teams || []).map(team => [team.team_id, team.display_name] as [string, string])), [displayed]);
  const prior = !!displayed && (phase !== 'ready' || (!!intent && !sameScope(displayed.scope, intent)));
  const maxCount = Math.max(1, ...(facts?.counts.map(item => item.count) || []));
  const stateMessage = phase === 'loading'
    ? displayed ? 'Loading requested scope. The results below are from the previous successful load.' : 'Loading the support source…'
    : phase === 'error'
      ? `Source load failed. ${error}${displayed ? ' The results below are from the previous successful load; the requested filters have been kept.' : ''}`
      : phase === 'invalid'
        ? `Choose a valid start date and end date to load this scope.${displayed ? ' The results below are from the previous successful load.' : ''}`
        : facts?.rows.length === 0
          ? 'Ready. No matching tickets. The source load succeeded.'
          : 'Ready. Current scope loaded successfully.';

  return (
    <FrameRoot>
      <div className="support-frame" data-eval="dashboard-root" aria-busy={phase === 'loading'}>
        <style>{CSS}</style>
        <main className="shell">
          <header className="header">
            <div>
              <div className="eyebrow">SUPPORT OPERATIONS</div>
              <h1>Ticket workload</h1>
              <p className="subtitle">One shared scope for tickets, metrics and active-status counts.</p>
            </div>
            <div className="source-tag"><span className="source-dot" aria-hidden="true" />Synthetic source · Read only</div>
          </header>

          <section className="card filters" aria-label="Ticket filters">
            <div className="section-heading">
              <h2>Filter scope</h2>
              <div className="actions">
                <button type="button" className="action" data-eval="reset-filters" onClick={reset} disabled={!source}>Reset</button>
                <button type="button" className="action primary" data-eval="refresh-data" onClick={refresh} disabled={!intent}>Refresh</button>
              </div>
            </div>
            <div className="filter-grid">
              <label className="field">
                <span className="field-label">Team</span>
                <select data-eval="team-filter" aria-label="Team" value={intent?.team_ids[0] || ''} disabled={!intent} onChange={event => changeScope({ team_ids: event.target.value ? [event.target.value] : [] })}>
                  <option value="">All teams</option>
                  {source?.teams.map(team => <option key={team.team_id} value={team.team_id}>{team.display_name || '(unnamed team)'} · {team.team_id}</option>)}
                </select>
                <span className="hint">Teams are identified by their source IDs</span>
              </label>
              <label className="field">
                <span className="field-label">Created from</span>
                <input type="date" data-eval="created-from" aria-label="Created from" value={intent?.created_from || ''} disabled={!intent} onChange={event => changeScope({ created_from: event.target.value })} />
                <span className="hint">Inclusive, 00:00 UTC</span>
              </label>
              <label className="field">
                <span className="field-label">Created to</span>
                <input type="date" data-eval="created-to" aria-label="Created to" value={intent?.created_to || ''} disabled={!intent} onChange={event => changeScope({ created_to: event.target.value })} />
                <span className="hint">Exclusive, 00:00 UTC</span>
              </label>
            </div>
            <fieldset disabled={!intent}>
              <legend>Status</legend>
              <div className="status-options">
                {STATUSES.map(status => <label key={status} className="status-choice">
                  <input type="checkbox" data-eval="status-option" data-eval-key={status} aria-label={status} checked={!!intent?.statuses.includes(status)} onChange={event => toggleStatus(status, event.target.checked)} />
                  <span>{status}</span>
                </label>)}
                <button type="button" className="minor" onClick={() => changeScope({ statuses: [...STATUSES] })}>Select all</button>
                <button type="button" className="minor" onClick={() => changeScope({ statuses: [] })}>Clear statuses</button>
              </div>
            </fieldset>
          </section>

          <section className={`view-state ${phase}`} data-eval="view-state" data-state={phase} role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">
            <div className="state-top">
              <p>{stateMessage}</p>
              {phase === 'error' && <button type="button" className="action" data-eval="retry-load" onClick={retry}>Retry</button>}
            </div>
            {prior && intent && <p className="requested">Requested scope: {scopeText(intent)}</p>}
          </section>
          {notice && <p className="notice" role="status">{notice}</p>}

          {displayed && facts ? <>
            <section className="scope" data-eval="displayed-scope" data-eval-revision={displayed.snapshot.snapshot_revision} data-eval-scope={JSON.stringify(displayed.scope)}>
              <div><strong>{prior ? 'Previous displayed scope: ' : 'Displayed scope: '}</strong>{scopeText(displayed.scope)}</div>
              <div><strong>Snapshot revision:</strong> {displayed.snapshot.snapshot_revision} · <strong>As of:</strong> <time dateTime={displayed.snapshot.as_of}>{displayed.snapshot.as_of}</time></div>
            </section>

            <section className="metrics" aria-label="Metrics for the displayed scope">
              <article className="card metric-card">
                <h2 className="metric-title">Matching tickets</h2>
                <div className="metric-number"><span data-eval="metric" data-eval-key="ticket_count" data-eval-unit="tickets">{facts.rows.length}</span><span className="metric-unit">tickets</span></div>
                <p className="metric-note">All selected statuses, including CLOSED</p>
              </article>
              <article className="card metric-card">
                <h2 className="metric-title">Active tickets</h2>
                <div className="metric-number"><span data-eval="metric" data-eval-key="active_count" data-eval-unit="tickets">{facts.active}</span><span className="metric-unit">tickets</span></div>
                <p className="metric-note">OPEN, IN_PROGRESS and WAITING</p>
              </article>
              <article className="card metric-card overdue">
                <h2 className="metric-title">Overdue active</h2>
                <div className="metric-number"><span data-eval="metric" data-eval-key="overdue_active_count" data-eval-unit="tickets">{facts.overdue}</span><span className="metric-unit">tickets</span></div>
                <p className="metric-note">Due strictly before the snapshot's as-of time</p>
              </article>
              <article className="card metric-card">
                <h2 className="metric-title">Remaining effort</h2>
                <div className="metric-number"><span data-eval="metric" data-eval-key="remaining_effort_hours" data-eval-unit="hours">{hoursText(facts.hours)}</span><span className="metric-unit">hours</span></div>
                <p className="metric-note">Active tickets only · source minutes ÷ 60</p>
              </article>
            </section>

            <section className="card chart-card" data-eval="status-chart" aria-label="Active tickets by status">
              <h2>Active tickets by status</h2>
              <p className="chart-note">Ticket counts in the displayed scope, on one linear scale starting at zero. Select a bar to show only that status.</p>
              <div className="chart-rows">
                {facts.counts.map(({ status, count }) => <button
                  key={status}
                  type="button"
                  className="bar-button"
                  data-eval="status-bar"
                  data-eval-key={status}
                  aria-label={`Filter to ${status}: ${count} active tickets`}
                  aria-pressed={!!intent && intent.statuses.length === 1 && intent.statuses[0] === status}
                  onClick={() => changeScope({ statuses: [status] })}
                >
                  <span className="bar-label">{status}</span>
                  <span className="plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="width" aria-hidden="true">
                    <span className="glyph" data-eval="status-glyph" data-eval-key={status} style={{ width: `${(count / maxCount) * 100}%`, background: STATUS_COLORS[status] }} />
                  </span>
                  <span className="bar-value"><strong data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count}</strong> tickets</span>
                </button>)}
              </div>
              {facts.active === 0 && <p className="chart-empty">No active tickets in the displayed scope. All three plotted counts are zero.</p>}
            </section>

            <section className="card table-card" aria-label="Ticket records">
              <div className="table-heading"><h2>Tickets</h2><span className="table-count">{facts.rows.length} matching tickets</span></div>
              <div className="table-scroll">
                <table data-eval="tickets-table">
                  <caption>Records for the displayed scope. ISO timestamps include their timezone; created-date filters use UTC.</caption>
                  <thead><tr><th scope="col">Ticket ID</th><th scope="col">Team name / ID</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Created at</th><th scope="col">Due at</th><th scope="col">Remaining effort</th></tr></thead>
                  <tbody>
                    {facts.rows.map(ticket => {
                      const overdue = ACTIVE_STATUSES.includes(ticket.status) && Date.parse(ticket.due_at) < Date.parse(displayed.snapshot.as_of);
                      return <tr key={ticket.ticket_id} data-eval="ticket-row" data-eval-key={ticket.ticket_id}>
                        <td className="identity" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="ticket_id">{ticket.ticket_id}</td>
                        <td><div className="team-name">{teamNames.get(ticket.team_id)}</div><div className="team-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="team_id">{ticket.team_id}</div></td>
                        <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="status"><span className="status-badge" style={{ color: STATUS_COLORS[ticket.status] }}>{ticket.status}</span></td>
                        <td>{ticket.priority}</td>
                        <td className="timestamp"><time dateTime={ticket.created_at}>{ticket.created_at}</time></td>
                        <td className={`timestamp ${overdue ? 'due-overdue' : ''}`} data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="due_at"><time dateTime={ticket.due_at}>{ticket.due_at}</time></td>
                        <td className="effort"><span data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{ticket.remaining_minutes}</span> minutes</td>
                      </tr>;
                    })}
                    {facts.rows.length === 0 && <tr><td colSpan={7}><div className="empty" data-eval="empty-state">No matching tickets<small>This scope loaded successfully. Change the filters or Reset to the source defaults.</small></div></td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="footer">Overdue and effort calculations use the displayed snapshot, never the browser clock. Refresh and Retry keep your filter selections; Reset uses the current source's date defaults and selects all teams and statuses.</p>
          </> : <div className="card no-source">{phase === 'error' ? 'No support snapshot is available yet. Retry the source read above.' : 'Waiting for a validated support snapshot.'}</div>}
        </main>
      </div>
    </FrameRoot>
  );
}
