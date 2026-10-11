import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { callFunction, readFile } from '@dust/react-hooks';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'] as const;
type Status = (typeof STATUSES)[number];
const ACTIVE: readonly Status[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const LABELS: Record<Status, string> = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting', CLOSED: 'Closed',
};
const COLORS: Record<Status, string> = {
  OPEN: '#4263df', IN_PROGRESS: '#8257ce', WAITING: '#c5851e', CLOSED: '#778296',
};
type Team = { team_id: string; display_name: string };
type Ticket = {
  ticket_id: string; team_id: string; status: Status; priority: 'P1' | 'P2' | 'P3';
  created_at: string; due_at: string; remaining_minutes: number;
};
type Snapshot = {
  schema_version: 'support-snapshot-1'; snapshot_revision: string; as_of: string;
  default_created_from: string; default_created_to: string; teams: Team[]; tickets: Ticket[];
};
type Scope = { team_ids: string[]; statuses: Status[]; created_from: string; created_to: string };
type View = { snapshot: Snapshot; scope: Scope };
type Phase = 'loading' | 'ready' | 'error' | 'invalid';
type Reason = 'filter' | 'refresh' | 'retry' | 'reset';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function dateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value));
}
function status(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function parseSnapshot(value: unknown): Snapshot {
  if (!record(value) || value.schema_version !== 'support-snapshot-1'
    || !nonempty(value.snapshot_revision) || !timestamp(value.as_of)
    || !dateOnly(value.default_created_from) || !dateOnly(value.default_created_to)
    || !Array.isArray(value.teams) || !Array.isArray(value.tickets)) {
    throw new Error('The source did not provide a valid support snapshot.');
  }
  const teams: Team[] = value.teams.map((item: unknown) => {
    if (!record(item) || !nonempty(item.team_id) || typeof item.display_name !== 'string') {
      throw new Error('The source contains an invalid team.');
    }
    return { team_id: item.team_id, display_name: item.display_name };
  });
  if (!unique(teams.map((team) => team.team_id))) throw new Error('Team IDs must be unique.');
  const tickets: Ticket[] = value.tickets.map((item: unknown) => {
    if (!record(item) || !nonempty(item.ticket_id) || !nonempty(item.team_id)
      || !status(item.status)
      || !['P1', 'P2', 'P3'].includes(String(item.priority))
      || !timestamp(item.created_at) || !timestamp(item.due_at)
      || typeof item.remaining_minutes !== 'number' || !Number.isInteger(item.remaining_minutes)
      || item.remaining_minutes < 0) throw new Error('The source contains an invalid ticket.');
    return {
      ticket_id: item.ticket_id, team_id: item.team_id, status: item.status,
      priority: item.priority as Ticket['priority'], created_at: item.created_at,
      due_at: item.due_at, remaining_minutes: item.remaining_minutes,
    };
  });
  if (!unique(tickets.map((ticket) => ticket.ticket_id))) throw new Error('Ticket IDs must be unique.');
  return {
    schema_version: 'support-snapshot-1', snapshot_revision: value.snapshot_revision,
    as_of: value.as_of, default_created_from: value.default_created_from,
    default_created_to: value.default_created_to, teams, tickets,
  };
}
function parseScope(value: unknown): Scope {
  if (!record(value) || !Array.isArray(value.team_ids) || !value.team_ids.every(nonempty)
    || !unique(value.team_ids) || !Array.isArray(value.statuses) || !value.statuses.every(status)
    || !unique(value.statuses) || !dateOnly(value.created_from) || !dateOnly(value.created_to)) {
    throw new Error('The source returned an invalid scope.');
  }
  return {
    team_ids: [...value.team_ids], statuses: [...value.statuses],
    created_from: value.created_from, created_to: value.created_to,
  };
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.created_from === b.created_from && a.created_to === b.created_to
    && a.team_ids.length === b.team_ids.length && a.team_ids.every((id) => b.team_ids.includes(id))
    && a.statuses.length === b.statuses.length && a.statuses.every((code) => b.statuses.includes(code));
}
function copyScope(scope: Scope): Scope {
  return { ...scope, team_ids: [...scope.team_ids], statuses: [...scope.statuses] };
}
function defaults(snapshot: Snapshot): Scope {
  return {
    team_ids: [], statuses: [...STATUSES],
    created_from: snapshot.default_created_from, created_to: snapshot.default_created_to,
  };
}
function scopeProblem(scope: Scope): string | null {
  if (!dateOnly(scope.created_from) || !dateOnly(scope.created_to)) {
    return 'Enter both created-date bounds as valid calendar dates.';
  }
  if (scope.created_from > scope.created_to) return 'The created-date end must be on or after the start.';
  return null;
}
function describe(scope: Scope): string {
  return `Teams: ${scope.team_ids.length ? scope.team_ids.join(', ') : 'ALL'} · Statuses: ${scope.statuses.length ? scope.statuses.join(', ') : 'NONE'} · Created UTC: [${scope.created_from}, ${scope.created_to})`;
}
function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (record(error) && typeof error.message === 'string') return error.message;
  return 'The controlled source could not be loaded. Please retry.';
}
function hoursText(hours: number): string {
  return Number(hours.toFixed(4)).toString();
}

const styles = `
  .support-frame, .support-frame * { box-sizing: border-box; }
  .support-frame { color: #203047; background: #f4f6fb; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  .support-frame .content { max-width: 1380px; margin: 0 auto; }
  .support-frame h1, .support-frame h2, .support-frame p { margin: 0; }
  .support-frame h1 { font-size: 28px; letter-spacing: -.7px; font-weight: 750; }
  .support-frame h2 { font-size: 16px; font-weight: 700; letter-spacing: -.15px; }
  .support-frame .muted { color: #64748b; font-size: 13px; line-height: 1.55; }
  .support-frame .eyebrow { font-size: 11px; font-weight: 750; letter-spacing: 1.4px; text-transform: uppercase; color: #5969bb; margin-bottom: 7px; }
  .support-frame .header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 24px; }
  .support-frame .header p { margin-top: 8px; }
  .support-frame .synthetic { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #d9e0ef; border-radius: 30px; background: #fff; padding: 8px 13px; white-space: nowrap; font-size: 12px; color: #56657c; }
  .support-frame .synthetic:before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #7b89cc; }
  .support-frame .card { background: #fff; border: 1px solid #e1e6f0; border-radius: 13px; box-shadow: 0 2px 6px #18264b04; }
  .support-frame .filters { padding: 20px; margin-bottom: 16px; }
  .support-frame .filter-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
  .support-frame .actions { display: flex; align-items: center; gap: 9px; }
  .support-frame button, .support-frame select, .support-frame input { font: inherit; }
  .support-frame button { cursor: pointer; }
  .support-frame button:disabled, .support-frame select:disabled, .support-frame input:disabled { cursor: default; opacity: .55; }
  .support-frame .action { border: 1px solid #d8dfed; border-radius: 7px; background: #fff; color: #394a63; padding: 8px 13px; font-size: 12px; font-weight: 650; }
  .support-frame .action.primary { background: #435cce; border-color: #435cce; color: #fff; }
  .support-frame .action:hover:not(:disabled) { filter: brightness(.97); }
  .support-frame button:focus-visible, .support-frame select:focus-visible, .support-frame input:focus-visible { outline: 3px solid #6d83e2; outline-offset: 3px; }
  .support-frame .filter-grid { display: grid; grid-template-columns: minmax(200px, 1.3fr) minmax(155px, .7fr) minmax(155px, .7fr); gap: 16px; }
  .support-frame .field-label { display: block; font-size: 12px; font-weight: 650; color: #4c5b71; margin-bottom: 7px; }
  .support-frame .field { width: 100%; border: 1px solid #d8dfec; border-radius: 7px; padding: 10px 11px; background: #fff; color: #23344e; min-height: 41px; font-size: 13px; }
  .support-frame .field[aria-invalid="true"] { border-color: #c67525; }
  .support-frame fieldset { border: 0; padding: 0; margin: 18px 0 0; min-width: 0; }
  .support-frame legend { padding: 0; font-size: 12px; font-weight: 650; color: #4c5b71; margin-bottom: 9px; }
  .support-frame .statuses { display: flex; gap: 9px; flex-wrap: wrap; }
  .support-frame .status-option { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #e1e6f0; border-radius: 7px; font-size: 12px; background: #fafbfe; cursor: pointer; }
  .support-frame .status-option.checked { border-color: #c7d1f1; background: #f0f3fd; }
  .support-frame .status-option input { margin: 0; width: 15px; height: 15px; accent-color: #435cce; }
  .support-frame .rule-note { font-size: 11px; color: #748297; margin-top: 13px; }
  .support-frame .state { padding: 13px 16px; border: 1px solid #dce3f1; background: #eef3fe; border-radius: 9px; font-size: 13px; line-height: 1.6; margin: 0 0 16px; overflow-wrap: anywhere; }
  .support-frame .state.ready { color: #335d4f; background: #eff8f3; border-color: #d6eadd; }
  .support-frame .state.error { color: #89393a; background: #fff2f1; border-color: #efcdcb; }
  .support-frame .state.invalid { color: #80571f; background: #fff8e9; border-color: #eddfbc; }
  .support-frame .state .actions { margin-top: 9px; }
  .support-frame .intent { font-size: 11px; opacity: .88; margin-top: 5px; }
  .support-frame .notice { font-size: 12px; background: #fff9e9; border: 1px solid #f0e1b9; color: #765c28; border-radius: 8px; padding: 11px 14px; margin-bottom: 14px; }
  .support-frame .displayed { font-size: 11px; color: #68758a; line-height: 1.7; padding: 0 2px 14px; overflow-wrap: anywhere; }
  .support-frame .displayed strong { color: #465671; }
  .support-frame .prior { display: inline-block; font-weight: 700; color: #8a6424; background: #fff3d8; padding: 2px 7px; border-radius: 4px; margin-right: 6px; }
  .support-frame .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
  .support-frame .metric-card { padding: 19px 20px; }
  .support-frame .metric-title { color: #586780; font-size: 12px; font-weight: 600; }
  .support-frame .metric-number { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; }
  .support-frame .metric-number strong { color: #223552; font-size: 29px; letter-spacing: -1px; font-weight: 730; }
  .support-frame .metric-number span { color: #7b889b; font-size: 11px; }
  .support-frame .metric-note { color: #8690a1; font-size: 10px; margin-top: 7px; }
  .support-frame .chart { padding: 21px; margin-bottom: 16px; }
  .support-frame .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 17px; }
  .support-frame .section-heading p { margin-top: 5px; }
  .support-frame .small-badge { font-size: 11px; color: #6e7a90; background: #f3f5f9; border-radius: 5px; padding: 5px 8px; white-space: nowrap; }
  .support-frame .bar { display: grid; grid-template-columns: 125px minmax(0, 1fr) 42px; gap: 14px; align-items: center; width: 100%; border: 1px solid transparent; background: #fff; padding: 11px 10px; border-radius: 8px; text-align: left; margin: 3px 0; color: #43526a; font-size: 12px; }
  .support-frame .bar:hover { background: #f6f8fc; }
  .support-frame .bar[aria-pressed="true"] { border-color: #c9d3f1; background: #f2f5fe; }
  .support-frame .plot { display: block; width: 100%; height: 24px; background: #edf0f6; border-radius: 4px; overflow: hidden; }
  .support-frame .glyph { display: block; height: 100%; border-radius: 4px; }
  .support-frame .bar-count { text-align: right; font-weight: 750; font-variant-numeric: tabular-nums; color: #3c4b64; }
  .support-frame .axis { display: grid; grid-template-columns: 125px minmax(0, 1fr) 42px; gap: 14px; padding: 5px 10px 0; font-size: 10px; color: #8792a5; }
  .support-frame .axis-scale { display: flex; justify-content: space-between; }
  .support-frame .chart-note { margin: 13px 10px 0; font-size: 11px; color: #748297; }
  .support-frame .table-card { overflow: hidden; }
  .support-frame .table-heading { padding: 20px 21px 0; }
  .support-frame .table-scroll { overflow-x: auto; }
  .support-frame table { border-collapse: collapse; width: 100%; min-width: 940px; text-align: left; }
  .support-frame th { background: #f8f9fc; color: #68768b; font-size: 10px; font-weight: 650; padding: 12px 14px; white-space: nowrap; border-top: 1px solid #e8ecf4; border-bottom: 1px solid #e8ecf4; }
  .support-frame td { font-size: 12px; padding: 13px 14px; border-bottom: 1px solid #edf0f6; vertical-align: middle; }
  .support-frame tbody tr:last-child td { border-bottom: 0; }
  .support-frame tbody tr:hover { background: #fafbfe; }
  .support-frame .id, .support-frame time { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; white-space: nowrap; }
  .support-frame .ticket-id { color: #3c53ad; font-weight: 650; }
  .support-frame .team-name { display: block; font-size: 12px; margin-bottom: 3px; }
  .support-frame .team-id { color: #8490a2; }
  .support-frame .status-tag { display: inline-block; background: #f1f3f8; padding: 5px 7px; border-radius: 5px; font-size: 10px; font-weight: 700; letter-spacing: .2px; white-space: nowrap; }
  .support-frame .overdue { color: #a14b34; }
  .support-frame .effort { text-align: right; font-variant-numeric: tabular-nums; }
  .support-frame .empty { padding: 36px 20px; text-align: center; color: #738198; font-size: 13px; }
  .support-frame .footer { font-size: 11px; color: #8a95a8; padding: 17px 2px 0; line-height: 1.6; }
  @media (max-width: 760px) {
    .support-frame { padding: 16px; }
    .support-frame .header { align-items: flex-start; }
    .support-frame h1 { font-size: 24px; }
    .support-frame .synthetic { display: none; }
    .support-frame .filter-grid { grid-template-columns: 1fr 1fr; }
    .support-frame .team-field { grid-column: 1 / -1; }
    .support-frame .metrics { grid-template-columns: 1fr 1fr; gap: 10px; }
    .support-frame .metric-card { padding: 16px; }
    .support-frame .filter-heading { align-items: flex-start; flex-wrap: wrap; }
    .support-frame .bar, .support-frame .axis { grid-template-columns: 85px minmax(0, 1fr) 28px; gap: 8px; }
    .support-frame .chart { padding: 16px; }
  }
`;

export default function SupportOperationsFrame() {
  const [intent, setIntent] = useState<Scope | null>(null);
  const [catalog, setCatalog] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestId = useRef(0);
  const intended = useRef<Scope | null>(null);
  const currentSource = useRef<Snapshot | null>(null);

  // Each new intent invalidates every earlier completion, including errors.
  // Displayed data owns its scope separately from the editable requested scope.
  async function loadScope(input: Scope, reason: Reason, explanation = ''): Promise<void> {
    const scope = copyScope(input);
    const id = ++requestId.current;
    intended.current = scope;
    setIntent(scope);
    setError('');
    setNotice(explanation);
    const problem = scopeProblem(scope);
    if (problem) {
      setPhase('invalid');
      setError(problem);
      return;
    }
    setPhase('loading');
    try {
      const result = await callFunction('load-data', copyScope(scope));
      if (id !== requestId.current) return;
      if (!record(result)) throw new Error('The source returned an invalid response.');
      const echoed = parseScope(result.scope);
      if (!sameScope(scope, echoed)) throw new Error('The returned scope does not match the requested filters.');
      const snapshot = parseSnapshot(result.snapshot);
      if (id !== requestId.current) return;
      currentSource.current = snapshot;
      setCatalog(snapshot);

      // A reset uses defaults from the current returned source, even if those
      // bounds have changed since the previous successful view.
      if (reason === 'reset') {
        const freshDefaults = defaults(snapshot);
        if (!sameScope(scope, freshDefaults)) {
          await loadScope(freshDefaults, 'reset', 'Reset is using the current source’s default created-date interval.');
          return;
        }
      }
      const missingTeams = scope.team_ids.filter((teamId) => !snapshot.teams.some((team) => team.team_id === teamId));
      if (missingTeams.length) {
        const remainingTeams = scope.team_ids.filter((teamId) => snapshot.teams.some((team) => team.team_id === teamId));
        await loadScope({ ...scope, team_ids: remainingTeams }, 'filter',
          `Team ${missingTeams.join(', ')} is no longer in the current source. ${remainingTeams.length ? 'The remaining selected teams are retained.' : 'The team filter has been changed to All teams.'} Statuses and dates are unchanged.`);
        return;
      }
      setView({ snapshot, scope });
      setError('');
      setPhase('ready');
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(failureMessage(cause));
      setPhase('error');
    }
  }

  async function loadInitial(): Promise<void> {
    const id = ++requestId.current;
    setPhase('loading');
    setError('');
    setNotice('');
    try {
      const source = await readFile('./dataset.json');
      if (id !== requestId.current) return;
      if (!source) throw new Error('The source file is unavailable. Its availability could not be determined.');
      const text = await source.file.text();
      if (id !== requestId.current) return;
      const snapshot = parseSnapshot(JSON.parse(text));
      const scope = defaults(snapshot);
      const problem = scopeProblem(scope);
      if (problem) throw new Error('The source default created-date interval is invalid.');
      currentSource.current = snapshot;
      intended.current = scope;
      setCatalog(snapshot);
      setIntent(scope);
      setView({ snapshot, scope });
      setPhase('ready');
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(failureMessage(cause));
      setPhase('error');
    }
  }

  useEffect(() => {
    void loadInitial();
    return () => { ++requestId.current; };
  }, []);

  function changeScope(patch: Partial<Scope>) {
    if (!intended.current) return;
    void loadScope({ ...intended.current, ...patch }, 'filter');
  }
  function toggleStatus(code: Status, selected: boolean) {
    if (!intended.current) return;
    const selection = new Set(intended.current.statuses);
    if (selected) selection.add(code); else selection.delete(code);
    changeScope({ statuses: STATUSES.filter((candidate) => selection.has(candidate)) });
  }
  function refresh(reason: 'refresh' | 'retry') {
    if (intended.current) void loadScope(intended.current, reason);
    else void loadInitial();
  }
  function reset() {
    if (currentSource.current) void loadScope(defaults(currentSource.current), 'reset');
  }

  const facts = useMemo(() => {
    if (!view) return null;
    const { scope, snapshot } = view;
    const from = Date.parse(scope.created_from + 'T00:00:00Z');
    const to = Date.parse(scope.created_to + 'T00:00:00Z');
    const rows = snapshot.tickets.filter((ticket) => {
      const created = Date.parse(ticket.created_at);
      return (!scope.team_ids.length || scope.team_ids.includes(ticket.team_id))
        && scope.statuses.includes(ticket.status) && created >= from && created < to;
    });
    const active = rows.filter((ticket) => ACTIVE.includes(ticket.status));
    const asOf = Date.parse(snapshot.as_of);
    const overdue = active.filter((ticket) => Date.parse(ticket.due_at) < asOf).length;
    const minutes = active.reduce((sum, ticket) => sum + ticket.remaining_minutes, 0);
    const counts = ACTIVE.map((code) => ({ code, count: active.filter((ticket) => ticket.status === code).length }));
    return { rows, active: active.length, overdue, hours: minutes / 60, counts, maxCount: Math.max(0, ...counts.map((item) => item.count)) };
  }, [view]);

  const prior = !!view && phase !== 'ready';
  const dateError = !!intent && scopeProblem(intent) !== null;
  const metrics = [
    { key: 'ticket_count', label: 'Tickets in scope', unit: 'tickets', value: facts?.rows.length, note: 'All matching statuses' },
    { key: 'active_count', label: 'Active tickets', unit: 'tickets', value: facts?.active, note: 'Open, in progress, waiting' },
    { key: 'overdue_active_count', label: 'Overdue active', unit: 'tickets', value: facts?.overdue, note: 'Due strictly before source as-of' },
    { key: 'remaining_effort_hours', label: 'Remaining active effort', unit: 'hours', value: facts ? hoursText(facts.hours) : undefined, note: 'Active remaining minutes ÷ 60' },
  ];

  return (
    <FrameRoot>
      <div className="support-frame" data-eval="dashboard-root" data-state={phase}>
        <style>{styles}</style>
        <main className="content">
          <header className="header">
            <div>
              <div className="eyebrow">Support workspace</div>
              <h1>Support operations</h1>
              <p className="muted">One source snapshot. One shared scope for tickets, metrics and the status chart.</p>
            </div>
            <span className="synthetic">Synthetic · Read only</span>
          </header>

          <section className="card filters" aria-labelledby="filters-title">
            <div className="filter-heading">
              <h2 id="filters-title">View filters</h2>
              <div className="actions">
                <button type="button" className="action" data-eval="reset-filters" disabled={!catalog} onClick={reset}>Reset filters</button>
                <button type="button" className="action primary" data-eval="refresh-data" onClick={() => refresh('refresh')}>Refresh data</button>
              </div>
            </div>
            <div className="filter-grid">
              <label className="team-field">
                <span className="field-label">Team</span>
                <select className="field" data-eval="team-filter" aria-label="Team" value={intent?.team_ids[0] ?? ''}
                  disabled={!intent} onChange={(event) => changeScope({ team_ids: event.target.value === '' ? [] : [event.target.value] })}>
                  <option value="">All teams</option>
                  {(catalog?.teams ?? []).map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name || 'Unnamed team'} ({team.team_id})</option>)}
                </select>
              </label>
              <label>
                <span className="field-label">Created from · inclusive</span>
                <input className="field" type="date" data-eval="created-from" aria-label="Created from" aria-invalid={dateError}
                  value={intent?.created_from ?? ''} disabled={!intent} onChange={(event) => changeScope({ created_from: event.target.value })} />
              </label>
              <label>
                <span className="field-label">Created to · exclusive</span>
                <input className="field" type="date" data-eval="created-to" aria-label="Created to" aria-invalid={dateError}
                  value={intent?.created_to ?? ''} disabled={!intent} onChange={(event) => changeScope({ created_to: event.target.value })} />
              </label>
            </div>
            <fieldset>
              <legend>Statuses</legend>
              <div className="statuses">
                {STATUSES.map((code) => <label key={code} className={`status-option ${intent?.statuses.includes(code) ? 'checked' : ''}`}>
                  <input type="checkbox" data-eval="status-option" data-eval-key={code} aria-label={LABELS[code]}
                    checked={intent?.statuses.includes(code) ?? false} disabled={!intent}
                    onChange={(event) => toggleStatus(code, event.target.checked)} />
                  <span>{LABELS[code]}</span>
                </label>)}
              </div>
            </fieldset>
            <p className="rule-note">Created-date bounds use UTC midnight: start included, end excluded. Clearing every status intentionally selects no tickets.</p>
          </section>

          <div className={`state ${phase}`} data-eval="view-state" role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">
            {phase === 'loading' && <><strong>{intent ? 'Loading the requested scope…' : 'Loading the controlled source…'}</strong>{view && <span> Showing previous successful results until the new request finishes.</span>}</>}
            {phase === 'ready' && <><strong>Current results loaded.</strong><span> All displayed values use the same source snapshot and scope.</span></>}
            {phase === 'error' && <><strong>Source load failed.</strong><span> {error} {view ? 'The previous successful view is retained below; it is not the result of this failed request.' : 'No successful source snapshot is available yet.'}</span></>}
            {phase === 'invalid' && <><strong>Check the requested dates.</strong><span> {error} {view ? 'Showing the previous successful view. No request was made for these invalid dates.' : ''}</span></>}
            {intent && <div className="intent">Requested scope: {describe(intent)}</div>}
            {phase === 'error' && <div className="actions"><button type="button" className="action primary" data-eval="retry-load" onClick={() => refresh('retry')}>Retry {intent ? 'current scope' : 'source load'}</button></div>}
          </div>
          {notice && <p className="notice" role="status">{notice}</p>}

          {view && <div className="displayed" data-eval="displayed-scope">
            {prior ? <span className="prior">Previous successful view</span> : <strong>Displayed scope: </strong>}
            {describe(view.scope)}<br />
            <strong>Snapshot revision:</strong> {view.snapshot.snapshot_revision} · <strong>As of:</strong> {view.snapshot.as_of}
          </div>}

          <section className="metrics" aria-label={prior ? 'Previous view metrics' : 'Scope metrics'}>
            {metrics.map((metric) => <article className="card metric-card" key={metric.key}>
              <div className="metric-title">{metric.label}</div>
              <div className="metric-number">
                <strong data-eval="metric" data-eval-key={metric.key} data-eval-unit={metric.unit}>{metric.value ?? '—'}</strong>
                <span>{metric.unit}</span>
              </div>
              <p className="metric-note">{metric.note}</p>
            </article>)}
          </section>

          <section className="card chart" data-eval="status-chart" aria-labelledby="chart-title">
            <div className="section-heading">
              <div><h2 id="chart-title">Active tickets by status</h2><p className="muted">Select a bar to focus that status across the entire view.</p></div>
              <span className="small-badge">{prior ? 'Previous view' : 'Tickets'}</span>
            </div>
            {facts ? <>
              {facts.counts.map(({ code, count }) => <button type="button" className="bar" key={code} data-eval="status-bar" data-eval-key={code}
                aria-label={`Select ${LABELS[code]} status, ${count} tickets in displayed scope`}
                aria-pressed={intent?.statuses.length === 1 && intent.statuses[0] === code}
                onClick={() => changeScope({ statuses: [code] })}>
                <span>{LABELS[code]}</span>
                <span className="plot" data-eval="status-plot" data-eval-key={code} data-eval-axis="width">
                  <span className="glyph" data-eval="status-glyph" data-eval-key={code}
                    style={{ width: `${facts.maxCount ? count / facts.maxCount * 100 : 0}%`, background: COLORS[code] }} />
                </span>
                <span className="bar-count" data-eval="status-count" data-eval-key={code} data-eval-unit="tickets">{count}</span>
              </button>)}
              <div className="axis" aria-hidden="true"><span /><span className="axis-scale"><span>0 tickets</span><span>{facts.maxCount || 1} tickets</span></span><span /></div>
              <p className="chart-note">{facts.active === 0 ? 'No active tickets in this displayed scope. All three status counts are zero.' : 'All three bars share one linear, zero-baseline scale. Closed tickets are excluded from active counts.'}</p>
            </> : <p className="empty">{phase === 'error' ? 'The chart is unavailable until the source loads successfully.' : 'Waiting for the source snapshot…'}</p>}
          </section>

          <section className="card table-card" aria-labelledby="table-title">
            <div className="table-heading section-heading">
              <div><h2 id="table-title">Tickets</h2><p className="muted">Stable source identities and exact source timestamps.</p></div>
              <span className="small-badge">{facts ? `${facts.rows.length} tickets${prior ? ' · previous view' : ''}` : 'Not loaded'}</span>
            </div>
            <div className="table-scroll">
              <table data-eval="tickets-table">
                <thead><tr><th>Ticket ID</th><th>Team name / team ID</th><th>Status</th><th>Priority</th><th>Created at (ISO)</th><th>Due at (ISO)</th><th className="effort">Remaining (minutes)</th></tr></thead>
                <tbody>
                  {facts?.rows.map((ticket) => {
                    const team = view!.snapshot.teams.find((candidate) => candidate.team_id === ticket.team_id);
                    const isOverdue = ACTIVE.includes(ticket.status) && Date.parse(ticket.due_at) < Date.parse(view!.snapshot.as_of);
                    return <tr key={ticket.ticket_id} data-eval="ticket-row" data-eval-key={ticket.ticket_id}>
                      <td className="id ticket-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="ticket_id">{ticket.ticket_id}</td>
                      <td><span className="team-name">{team ? team.display_name || 'Unnamed team' : 'Team not listed in source'}</span><span className="id team-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="team_id">{ticket.team_id}</span></td>
                      <td><span className="status-tag" style={{ color: COLORS[ticket.status] }} data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="status">{ticket.status}</span></td>
                      <td>{ticket.priority}</td>
                      <td><time dateTime={ticket.created_at}>{ticket.created_at}</time></td>
                      <td className={isOverdue ? 'overdue' : ''}><time dateTime={ticket.due_at} data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="due_at">{ticket.due_at}</time></td>
                      <td className="effort" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{ticket.remaining_minutes}</td>
                    </tr>;
                  })}
                  {!facts && <tr><td colSpan={7} className="empty">{phase === 'error' ? 'Source unavailable. Retry to load tickets.' : 'Loading tickets…'}</td></tr>}
                  {facts && facts.rows.length === 0 && <tr><td colSpan={7} className="empty">
                    {phase === 'ready' ? <span data-eval="empty-state">No matching tickets. This scope loaded successfully; all four metrics and active-status counts are zero.</span> : <span>The previous successful scope had no matching tickets.</span>}
                  </td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <p className="footer">Active = OPEN, IN_PROGRESS or WAITING. Overdue = active and due before the source’s as-of timestamp. Remaining effort uses active tickets only. This local synthetic dashboard never changes business records.</p>
        </main>
      </div>
    </FrameRoot>
  );
}
