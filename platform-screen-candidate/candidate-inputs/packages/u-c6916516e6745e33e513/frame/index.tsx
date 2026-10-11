import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FrameRoot } from '@dust/frame';
import { callFunction, readFile } from '@dust/react-hooks';

type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'CLOSED';
type ActiveStatus = Exclude<TicketStatus, 'CLOSED'>;
type Priority = 'P1' | 'P2' | 'P3';

interface Team {
  team_id: string;
  display_name: string;
}
interface Ticket {
  ticket_id: string;
  team_id: string;
  status: TicketStatus;
  priority: Priority;
  created_at: string;
  due_at: string;
  remaining_minutes: number;
}
interface Snapshot {
  schema_version: 'support-snapshot-1';
  snapshot_revision: string;
  as_of: string;
  default_created_from: string;
  default_created_to: string;
  teams: Team[];
  tickets: Ticket[];
}
interface Scope {
  team_ids: string[];
  statuses: TicketStatus[];
  created_from: string;
  created_to: string;
}
interface Filters {
  teamId: string;
  statuses: TicketStatus[];
  createdFrom: string;
  createdTo: string;
}
interface DisplayedView {
  snapshot: Snapshot;
  scope: Scope;
}
interface LoadError {
  message: string;
  scopeKey: string | null;
}

const ALL_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const ACTIVE_STATUSES: ActiveStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING: 'Waiting',
  CLOSED: 'Closed',
};
const PRIORITY_LABEL: Record<Priority, string> = {
  P1: 'P1 · Urgent',
  P2: 'P2 · Standard',
  P3: 'P3 · Low',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}
function isStatus(value: unknown): value is TicketStatus {
  return value === 'OPEN' || value === 'IN_PROGRESS' || value === 'WAITING' || value === 'CLOSED';
}
function isPriority(value: unknown): value is Priority {
  return value === 'P1' || value === 'P2' || value === 'P3';
}
function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.schema_version !== 'support-snapshot-1') {
    throw new Error('The source returned an unsupported support snapshot.');
  }
  if (typeof value.snapshot_revision !== 'string' || value.snapshot_revision.length === 0 ||
      !isDateTime(value.as_of) || !isDate(value.default_created_from) || !isDate(value.default_created_to) ||
      !Array.isArray(value.teams) || !Array.isArray(value.tickets)) {
    throw new Error('The source snapshot is missing required ticket data.');
  }
  const teams: Team[] = value.teams.map((entry) => {
    if (!isRecord(entry) || typeof entry.team_id !== 'string' || entry.team_id.length === 0 || typeof entry.display_name !== 'string') {
      throw new Error('The source contains an invalid team identity.');
    }
    return { team_id: entry.team_id, display_name: entry.display_name };
  });
  const tickets: Ticket[] = value.tickets.map((entry) => {
    if (!isRecord(entry) || typeof entry.ticket_id !== 'string' || entry.ticket_id.length === 0 ||
        typeof entry.team_id !== 'string' || entry.team_id.length === 0 || !isStatus(entry.status) ||
        !isPriority(entry.priority) || !isDateTime(entry.created_at) || !isDateTime(entry.due_at) ||
        typeof entry.remaining_minutes !== 'number' || !Number.isInteger(entry.remaining_minutes) || entry.remaining_minutes < 0) {
      throw new Error('The source contains an invalid ticket record.');
    }
    return {
      ticket_id: entry.ticket_id,
      team_id: entry.team_id,
      status: entry.status,
      priority: entry.priority,
      created_at: entry.created_at,
      due_at: entry.due_at,
      remaining_minutes: entry.remaining_minutes,
    };
  });
  return {
    schema_version: 'support-snapshot-1',
    snapshot_revision: value.snapshot_revision,
    as_of: value.as_of,
    default_created_from: value.default_created_from,
    default_created_to: value.default_created_to,
    teams,
    tickets,
  };
}
function normalizeFilters(filters: Filters): Filters {
  const statuses = ALL_STATUSES.filter((status) => filters.statuses.includes(status));
  return { ...filters, statuses };
}
function scopeFor(filters: Filters): Scope {
  const normalized = normalizeFilters(filters);
  return {
    team_ids: normalized.teamId ? [normalized.teamId] : [],
    statuses: normalized.statuses,
    created_from: normalized.createdFrom,
    created_to: normalized.createdTo,
  };
}
function parseEchoScope(value: unknown): Scope {
  if (!isRecord(value) || !Array.isArray(value.team_ids) || !value.team_ids.every((id) => typeof id === 'string') ||
      !Array.isArray(value.statuses) || !value.statuses.every(isStatus) ||
      !isDate(value.created_from) || !isDate(value.created_to)) {
    throw new Error('The source returned an invalid scope confirmation.');
  }
  return {
    team_ids: value.team_ids as string[],
    statuses: value.statuses as TicketStatus[],
    created_from: value.created_from,
    created_to: value.created_to,
  };
}
function scopesMatch(a: Scope, b: Scope): boolean {
  return a.created_from === b.created_from && a.created_to === b.created_to &&
    a.team_ids.length === b.team_ids.length && a.team_ids.every((id, index) => id === b.team_ids[index]) &&
    a.statuses.length === b.statuses.length && a.statuses.every((status, index) => status === b.statuses[index]);
}
function filtersMatch(a: Filters, b: Filters): boolean {
  return a.teamId === b.teamId && a.createdFrom === b.createdFrom && a.createdTo === b.createdTo &&
    ALL_STATUSES.every((status) => a.statuses.includes(status) === b.statuses.includes(status));
}
function scopeKey(scope: Scope): string {
  return JSON.stringify(scope);
}
function defaultFilters(snapshot: Snapshot): Filters {
  return {
    teamId: '',
    statuses: [...ALL_STATUSES],
    createdFrom: snapshot.default_created_from,
    createdTo: snapshot.default_created_to,
  };
}
function parseLoadResult(value: unknown, expected: Scope): { snapshot: Snapshot; scope: Scope } {
  if (!isRecord(value) || !('snapshot' in value) || !('scope' in value)) {
    throw new Error('The source response did not include ticket data and its requested scope.');
  }
  const snapshot = parseSnapshot(value.snapshot);
  const scope = parseEchoScope(value.scope);
  if (!scopesMatch(scope, expected)) {
    throw new Error('The source confirmed a different scope. No results were applied.');
  }
  return { snapshot, scope };
}
function matchingTickets(snapshot: Snapshot, scope: Scope): Ticket[] {
  if (scope.statuses.length === 0) return [];
  const from = Date.parse(`${scope.created_from}T00:00:00Z`);
  const to = Date.parse(`${scope.created_to}T00:00:00Z`);
  return snapshot.tickets.filter((ticket) => {
    const created = Date.parse(ticket.created_at);
    return (scope.team_ids.length === 0 || scope.team_ids.includes(ticket.team_id)) &&
      scope.statuses.includes(ticket.status) && created >= from && created < to;
  });
}
function compactTime(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z').replace(/Z$/, ' UTC');
}
function formatHours(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, '');
}
function teamLabel(teamId: string, teams: Team[]): string {
  if (!teamId) return 'All teams';
  const team = teams.find((item) => item.team_id === teamId);
  return team ? `${team.display_name} · ${team.team_id}` : `Unknown team · ${teamId}`;
}
function scopeDescription(scope: Scope, teams: Team[]): string {
  const teamText = scope.team_ids.length ? teamLabel(scope.team_ids[0], teams) : 'All teams';
  const statusText = scope.statuses.length ? scope.statuses.map((status) => STATUS_LABEL[status]).join(', ') : 'No statuses';
  return `${teamText} · ${statusText} · created ${scope.created_from} ≤ date < ${scope.created_to}`;
}
function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The source could not be read. Try again.';
}

const css = `
  * { box-sizing: border-box; }
  .support-shell { min-height: 100vh; padding: 32px clamp(18px, 4vw, 56px) 48px; background: #f5f6fa; color: #19223a; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .support-inner { max-width: 1440px; margin: 0 auto; }
  .topline { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom: 26px; }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand-mark { width:40px; height:40px; border-radius:13px; display:grid; place-items:center; color:#fff; background:linear-gradient(140deg,#5868d8,#7587f1); box-shadow:0 8px 18px rgba(81,96,204,.24); font-size:18px; font-weight:800; }
  .eyebrow { color:#7d86a0; text-transform:uppercase; font-size:10px; font-weight:800; letter-spacing:.14em; }
  h1 { margin:3px 0 0; font-size:24px; letter-spacing:-.04em; line-height:1.1; }
  .asof { color:#727b92; text-align:right; font-size:12px; line-height:1.5; }
  .asof strong { display:block; color:#38435d; font-size:13px; }
  .intro { display:flex; justify-content:space-between; align-items:end; gap:20px; margin-bottom:18px; }
  .intro h2 { font-size:17px; margin:0 0 5px; letter-spacing:-.02em; }
  .intro p { color:#7b849a; font-size:13px; margin:0; }
  .toolbar { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .button { border:1px solid #dfe3ee; background:#fff; color:#303a53; padding:9px 13px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; transition:all .16s ease; }
  .button:hover { border-color:#aeb8f2; color:#4658c2; transform:translateY(-1px); }
  .button.primary { color:#fff; background:#5667d5; border-color:#5667d5; box-shadow:0 5px 12px rgba(86,103,213,.17); }
  .button.primary:hover { background:#4658c6; color:#fff; }
  .button:disabled { opacity:.55; cursor:not-allowed; transform:none; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline:3px solid rgba(102,119,225,.35); outline-offset:2px; }
  .filters { display:grid; grid-template-columns:minmax(200px,1.05fr) minmax(250px,1.4fr) minmax(260px,1.3fr); gap:14px; padding:17px; background:#fff; border:1px solid #e8eaf1; border-radius:16px; box-shadow:0 7px 24px rgba(24,34,65,.035); margin-bottom:16px; }
  .filter-block { min-width:0; }
  .filter-title { display:block; color:#7b849a; font-size:10px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; margin-bottom:8px; }
  .team-select, .date-input { border:1px solid #e0e4ee; color:#27324d; background:#fbfcfe; border-radius:9px; min-height:39px; padding:0 11px; font:inherit; font-size:12px; width:100%; }
  .team-select { cursor:pointer; }
  .status-options { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .status-chip { position:relative; display:inline-flex; align-items:center; gap:6px; padding:7px 9px; border:1px solid #e4e7ef; border-radius:9px; color:#58627a; background:#fbfcfe; font-size:11px; line-height:1; cursor:pointer; white-space:nowrap; }
  .status-chip:has(input:checked) { background:#f0f2ff; border-color:#cfd5ff; color:#4c5dc1; }
  .status-chip input { accent-color:#5c6dd6; width:13px; height:13px; margin:0; }
  .date-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .date-label { color:#7b849a; display:block; font-size:10px; margin:0 0 4px 2px; }
  .filter-note { color:#939bb0; font-size:10px; margin:6px 2px 0; }
  .state-banner { display:flex; align-items:flex-start; gap:10px; padding:11px 14px; margin:0 0 16px; border-radius:11px; background:#f0f2ff; border:1px solid #dfe3ff; color:#4a58a9; font-size:12px; line-height:1.5; }
  .state-banner.error { color:#984d45; background:#fff5f3; border-color:#f4d7d2; }
  .state-banner .state-dot { flex:none; width:7px; height:7px; margin-top:5px; border-radius:50%; background:#6473db; }
  .state-banner.error .state-dot { background:#d27667; }
  .state-copy { min-width:0; flex:1; }
  .state-copy strong { font-weight:800; }
  .state-copy small { display:block; color:inherit; opacity:.84; margin-top:2px; }
  .state-action { flex:none; border:0; background:transparent; color:inherit; padding:2px 0; font:inherit; font-weight:800; text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
  .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:13px; margin-bottom:16px; }
  .metric-card { position:relative; min-height:105px; padding:17px 18px; background:#fff; border:1px solid #e8eaf1; border-radius:15px; box-shadow:0 7px 24px rgba(24,34,65,.035); overflow:hidden; }
  .metric-card:after { content:""; position:absolute; right:-16px; top:-23px; width:76px; height:76px; border-radius:50%; background:#f2f3ff; }
  .metric-label { position:relative; z-index:1; color:#778198; font-size:11px; font-weight:700; }
  .metric-value { position:relative; z-index:1; display:block; margin-top:9px; color:#202b45; font-size:25px; font-weight:800; letter-spacing:-.045em; }
  .metric-unit { color:#8992a8; font-size:11px; font-weight:650; letter-spacing:0; margin-left:5px; }
  .content-grid { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(480px,1.7fr); gap:15px; align-items:start; }
  .panel { background:#fff; border:1px solid #e8eaf1; border-radius:16px; box-shadow:0 7px 24px rgba(24,34,65,.035); overflow:hidden; }
  .panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:17px 19px 13px; }
  .panel-head h3 { font-size:14px; line-height:1.2; margin:0; letter-spacing:-.02em; }
  .panel-head p { margin:4px 0 0; color:#9098aa; font-size:11px; }
  .mini-badge { color:#737e99; background:#f4f5f9; border-radius:99px; padding:5px 8px; white-space:nowrap; font-size:10px; font-weight:750; }
  .chart { padding:3px 18px 18px; }
  .chart-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .chart-bar { width:100%; border:1px solid transparent; border-radius:10px; background:transparent; padding:5px 4px 7px; color:#5d6883; cursor:pointer; text-align:center; }
  .chart-bar:hover { background:#f7f8ff; }
  .chart-bar[aria-pressed="true"] { border-color:#dce1ff; background:#f4f5ff; }
  .chart-bar:focus-visible { outline:3px solid rgba(102,119,225,.35); outline-offset:1px; }
  .chart-label { display:block; min-height:30px; color:#6f7890; font-size:10px; font-weight:750; line-height:1.2; }
  .chart-plot { position:relative; display:flex; align-items:flex-end; justify-content:center; width:100%; height:132px; padding-bottom:0; border-bottom:1px solid #cfd4e0; background:linear-gradient(to top,rgba(235,238,247,.62) 1px,transparent 1px); background-size:100% 33px; }
  .chart-glyph { display:block; width:min(38px,55%); min-height:0; border-radius:7px 7px 2px 2px; background:linear-gradient(180deg,#8290f0,#596bd8); box-shadow:0 4px 10px rgba(81,99,213,.18); }
  .chart-count { display:block; padding-top:7px; color:#3c4764; font-size:13px; font-weight:800; }
  .chart-unit { color:#929aad; font-size:9px; font-weight:600; }
  .chart-foot { margin:10px 2px 0; color:#929aad; font-size:10px; line-height:1.45; }
  .table-panel { min-width:0; }
  .table-head { border-bottom:1px solid #edf0f5; padding-bottom:14px; }
  .table-wrap { width:100%; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; min-width:720px; }
  thead { background:#fafbfe; }
  th { text-align:left; padding:10px 13px; color:#8992a7; font-size:9px; font-weight:800; letter-spacing:.075em; text-transform:uppercase; white-space:nowrap; }
  td { padding:12px 13px; border-top:1px solid #f0f1f5; color:#58627a; font-size:11px; white-space:nowrap; }
  tr:hover td { background:#fcfcff; }
  .ticket-id { color:#313d5a; font-size:11px; font-weight:800; }
  .team-name { color:#49536b; font-weight:700; }
  .team-id { display:block; color:#a0a7b6; font-size:9px; margin-top:3px; }
  .status-pill { display:inline-flex; align-items:center; gap:5px; padding:5px 8px; border-radius:99px; background:#f1f3ff; color:#5667c6; font-size:10px; font-weight:750; }
  .status-pill:before { content:""; width:5px; height:5px; border-radius:50%; background:currentColor; }
  .status-pill.waiting { color:#aa7b39; background:#fff7e9; }
  .status-pill.closed { color:#7b8497; background:#f0f2f5; }
  .status-pill.in-progress { color:#3b8c83; background:#eaf7f5; }
  .priority { color:#737e94; font-weight:750; }
  .empty-row { text-align:center; padding:31px 18px; color:#8b94a8; white-space:normal; }
  .table-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; border-top:1px solid #edf0f5; padding:12px 18px; color:#8992a7; font-size:10px; }
  .table-foot strong { color:#536078; }
  .loading-indicator { display:inline-flex; align-items:center; gap:6px; }
  .loading-indicator:before { content:""; width:6px; height:6px; border-radius:50%; background:#6979df; animation:pulse 1s infinite ease-in-out; }
  @keyframes pulse { 50% { opacity:.3; transform:scale(.8); } }
  @media (max-width:1000px) { .filters { grid-template-columns:1fr 1fr; } .filter-block:last-child { grid-column:1/-1; } .content-grid { grid-template-columns:1fr; } }
  @media (max-width:680px) { .support-shell { padding:22px 14px 32px; } .topline { align-items:flex-start; } h1 { font-size:21px; } .asof { font-size:10px; } .intro { align-items:flex-start; flex-direction:column; } .filters { grid-template-columns:1fr; padding:14px; } .filter-block:last-child { grid-column:auto; } .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; } .metric-card { min-height:94px; padding:14px; } .metric-value { font-size:22px; } .state-banner { align-items:flex-start; } .toolbar { width:100%; } }
`;

export default function SupportOperationsFrame() {
  const [filters, setFilters] = useState<Filters>({ teamId: '', statuses: [...ALL_STATUSES], createdFrom: '', createdTo: '' });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<DisplayedView | null>(null);
  const [busy, setBusy] = useState<'initial' | 'query' | null>('initial');
  const [error, setError] = useState<LoadError | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');
  const filtersRef = useRef(filters);
  const snapshotRef = useRef<Snapshot | null>(null);
  const requestSeq = useRef(0);

  const commitDisplayedFilters = (next: Filters) => {
    const normalized = normalizeFilters(next);
    filtersRef.current = normalized;
    setFilters(normalized);
    return normalized;
  };

  const loadForFilters = async (nextInput: Filters, options: { resetDefaults?: boolean; notice?: string } = {}) => {
    const next = commitDisplayedFilters(nextInput);
    const scope = scopeFor(next);
    const key = scopeKey(scope);
    const requestId = ++requestSeq.current;
    setBusy('query');
    setError(null);
    setValidation(null);
    setNotice(options.notice ?? '');
    const fromMs = Date.parse(`${scope.created_from}T00:00:00Z`);
    const toMs = Date.parse(`${scope.created_to}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      if (requestSeq.current === requestId) {
        setBusy(null);
        setValidation('Enter valid dates with a start on or before the exclusive end date.');
      }
      return;
    }
    try {
      const raw = await callFunction('load-data', scope);
      if (requestSeq.current !== requestId) return;
      const result = parseLoadResult(raw, scope);
      if (!filtersMatch(filtersRef.current, next)) return;

      // A refresh may return a newer source. Keep the latest source metadata while
      // reconciling the user's valid selection; never present old rows as new.
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      let reconciled = filtersRef.current;
      let reconciliationNote = options.notice ?? '';
      if (options.resetDefaults) {
        reconciled = {
          teamId: '',
          statuses: [...ALL_STATUSES],
          createdFrom: result.snapshot.default_created_from,
          createdTo: result.snapshot.default_created_to,
        };
        if (!filtersMatch(reconciled, filtersRef.current)) {
          reconciliationNote = 'Reset applied the current source defaults.';
        }
      } else if (filtersRef.current.teamId && !result.snapshot.teams.some((team) => team.team_id === filtersRef.current.teamId)) {
        reconciled = { ...filtersRef.current, teamId: '' };
        reconciliationNote = 'The selected team is no longer in the source, so the view was switched to All teams.';
      }
      if (!filtersMatch(reconciled, filtersRef.current)) {
        if (requestSeq.current !== requestId) return;
        commitDisplayedFilters(reconciled);
        await loadForFilters(reconciled, { resetDefaults: options.resetDefaults, notice: reconciliationNote });
        return;
      }

      const reconciledScope = scopeFor(reconciled);
      // The function echoes the request's literal scope. A reconciling response is
      // intentionally not displayed until the second read returns that exact scope.
      if (!scopesMatch(result.scope, reconciledScope)) {
        if (requestSeq.current !== requestId) return;
        commitDisplayedFilters(reconciled);
        await loadForFilters(reconciled, { resetDefaults: options.resetDefaults, notice: reconciliationNote });
        return;
      }
      setView({ snapshot: result.snapshot, scope: result.scope });
      setBusy(null);
      setError(null);
      setValidation(null);
      setNotice(reconciliationNote);
    } catch (caught) {
      if (requestSeq.current !== requestId) return;
      setBusy(null);
      setError({ message: failureMessage(caught), scopeKey: key });
      setValidation(null);
    }
  };

  const loadInitialSource = async () => {
    const requestId = ++requestSeq.current;
    setBusy('initial');
    setError(null);
    setValidation(null);
    setNotice('');
    try {
      const metadata = await readFile('./dataset.json');
      if (!metadata) throw new Error('Could not read ./dataset.json. The source file is unavailable.');
      const rawText = await metadata.file.text();
      const source = parseSnapshot(JSON.parse(rawText) as unknown);
      if (requestSeq.current !== requestId) return;
      const defaults = defaultFilters(source);
      const initialScope = scopeFor(defaults);
      filtersRef.current = defaults;
      snapshotRef.current = source;
      setFilters(defaults);
      setSnapshot(source);
      setView({ snapshot: source, scope: initialScope });
      setBusy(null);
      setError(null);
      setValidation(null);
      setNotice('Source defaults loaded. All teams and statuses are included.');
    } catch (caught) {
      if (requestSeq.current !== requestId) return;
      setBusy(null);
      setError({ message: failureMessage(caught), scopeKey: null });
    }
  };

  useEffect(() => {
    void loadInitialSource();
    return () => { requestSeq.current += 1; };
    // The first source read belongs to the package mount. All later reads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayedScope = view?.scope ?? null;
  const requestedScope = scopeFor(filters);
  const rows = useMemo(() => view ? matchingTickets(view.snapshot, view.scope) : [], [view]);
  const activeRows = useMemo(() => rows.filter((ticket) => ACTIVE_STATUSES.includes(ticket.status as ActiveStatus)), [rows]);
  const activeCount = activeRows.length;
  const overdueCount = view ? activeRows.filter((ticket) => Date.parse(ticket.due_at) < Date.parse(view.snapshot.as_of)).length : 0;
  const effortHours = activeRows.reduce((sum, ticket) => sum + ticket.remaining_minutes, 0) / 60;
  const chartCounts = ACTIVE_STATUSES.map((status) => ({
    status,
    count: activeRows.filter((ticket) => ticket.status === status).length,
  }));
  const maxChartCount = Math.max(0, ...chartCounts.map((item) => item.count));
  const isCurrentView = Boolean(view && busy === null && !error && !validation && scopesMatch(view.scope, requestedScope) &&
    snapshot?.snapshot_revision === view.snapshot.snapshot_revision);
  const sourceTeams = snapshot?.teams ?? view?.snapshot.teams ?? [];
  const errorIsCurrent = Boolean(error && (error.scopeKey === null || error.scopeKey === scopeKey(requestedScope)));
  const previousViewText = view
    ? `Previous results: ${scopeDescription(view.scope, view.snapshot.teams)} · revision ${view.snapshot.snapshot_revision}.`
    : 'No results have been loaded yet.';
  const requestedText = scopeDescription(requestedScope, sourceTeams);
  const currentBusy = busy !== null;

  const updateFilters = (next: Filters) => {
    const normalized = commitDisplayedFilters(next);
    setNotice('');
    const from = Date.parse(`${normalized.createdFrom}T00:00:00Z`);
    const to = Date.parse(`${normalized.createdTo}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      requestSeq.current += 1;
      setBusy(null);
      setError(null);
      setValidation('The created-date start must be on or before the exclusive end date.');
      return;
    }
    void loadForFilters(normalized);
  };

  const handleReset = () => {
    const current = snapshotRef.current;
    if (!current) {
      void loadInitialSource();
      return;
    }
    const defaults = defaultFilters(current);
    void loadForFilters(defaults, { resetDefaults: true, notice: 'Resetting to the current source defaults…' });
  };
  const handleRefresh = () => {
    if (!snapshotRef.current) {
      void loadInitialSource();
      return;
    }
    void loadForFilters(filtersRef.current, { notice: 'Refreshing the current source snapshot…' });
  };
  const handleRetry = () => {
    if (!snapshotRef.current) void loadInitialSource();
    else void loadForFilters(filtersRef.current, { notice: 'Retrying the current requested scope…' });
  };
  const handleTeamChange = (teamId: string) => updateFilters({ ...filtersRef.current, teamId });
  const handleStatusChange = (status: TicketStatus, checked: boolean) => {
    const statuses = checked
      ? [...filtersRef.current.statuses, status]
      : filtersRef.current.statuses.filter((item) => item !== status);
    updateFilters({ ...filtersRef.current, statuses });
  };
  const handleDateChange = (field: 'createdFrom' | 'createdTo', value: string) => {
    updateFilters({ ...filtersRef.current, [field]: value });
  };
  const handleChartSelect = (status: ActiveStatus) => {
    updateFilters({ ...filtersRef.current, statuses: [status] });
  };

  return (
    <FrameRoot style={{ '--frame-bg': '#f5f6fa' }}>
      <style>{css}</style>
      <main className="support-shell" data-eval="dashboard-root">
        <div className="support-inner">
          <header className="topline">
            <div className="brand">
              <div className="brand-mark" aria-hidden="true">S</div>
              <div>
                <div className="eyebrow">Service desk · Operations</div>
                <h1>Support operations</h1>
              </div>
            </div>
            <div className="asof">
              Source snapshot as of
              <strong>{view ? `${compactTime(view.snapshot.as_of)} · ${view.snapshot.snapshot_revision}` : 'Waiting for source…'}</strong>
            </div>
          </header>

          <section className="intro" aria-label="Dashboard controls">
            <div>
              <h2>Ticket workload</h2>
              <p>Review the current queue by team, status, and created date.</p>
            </div>
            <div className="toolbar">
              <button className="button" type="button" data-eval="reset-filters" onClick={handleReset} disabled={!snapshot && busy !== null}>Reset filters</button>
              <button className="button primary" type="button" data-eval="refresh-data" onClick={handleRefresh} disabled={busy !== null}>↻ &nbsp;Refresh data</button>
            </div>
          </section>

          <section className="filters" aria-label="Ticket filters">
            <div className="filter-block">
              <label className="filter-title" htmlFor="team-filter-select">Team</label>
              <select
                id="team-filter-select"
                className="team-select"
                data-eval="team-filter"
                value={filters.teamId}
                onChange={(event) => handleTeamChange(event.target.value)}
                disabled={!snapshot || busy === 'initial'}
              >
                <option value="">All teams</option>
                {sourceTeams.map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name} · {team.team_id}</option>)}
              </select>
              <div className="filter-note">Team names include source IDs to distinguish similar labels.</div>
            </div>
            <fieldset className="filter-block" style={{ border: 0, padding: 0, margin: 0 }} disabled={!snapshot || busy === 'initial'}>
              <legend className="filter-title">Status</legend>
              <div className="status-options">
                {ALL_STATUSES.map((status) => (
                  <label className="status-chip" key={status}>
                    <input
                      type="checkbox"
                      data-eval="status-option"
                      data-eval-key={status}
                      checked={filters.statuses.includes(status)}
                      onChange={(event) => handleStatusChange(status, event.target.checked)}
                    />
                    <span>{STATUS_LABEL[status]}</span>
                  </label>
                ))}
              </div>
              <div className="filter-note">Choose any combination, or clear all for an empty status scope.</div>
            </fieldset>
            <div className="filter-block">
              <span className="filter-title">Created date · UTC</span>
              <div className="date-row">
                <label>
                  <span className="date-label">From · inclusive</span>
                  <input className="date-input" type="date" data-eval="created-from" value={filters.createdFrom} onChange={(event) => handleDateChange('createdFrom', event.target.value)} disabled={!snapshot || busy === 'initial'} />
                </label>
                <label>
                  <span className="date-label">To · exclusive</span>
                  <input className="date-input" type="date" data-eval="created-to" value={filters.createdTo} onChange={(event) => handleDateChange('createdTo', event.target.value)} disabled={!snapshot || busy === 'initial'} />
                </label>
              </div>
              <div className="filter-note">Interval is start-inclusive and end-exclusive.</div>
            </div>
          </section>

          <section className={`state-banner${errorIsCurrent ? ' error' : ''}`} data-eval="view-state" aria-live="polite">
            <span className="state-dot" aria-hidden="true" />
            <div className="state-copy">
              {busy === 'initial' && <><strong>Loading the source snapshot.</strong><small>{view ? previousViewText : 'Reading the supplied dataset.'}</small></>}
              {busy === 'query' && <><strong><span className="loading-indicator">{notice || 'Loading the requested scope.'}</span></strong><small>Requested: {requestedText}. {previousViewText}</small></>}
              {busy === null && errorIsCurrent && <><strong>{error?.scopeKey === null ? 'Could not read the source snapshot.' : 'Could not load the requested scope.'}</strong><small>{error?.scopeKey === null ? error?.message : `${error?.message} Requested: ${requestedText}.`} {previousViewText}</small></>}
              {busy === null && validation && <><strong>Check the date range.</strong><small>{validation} {previousViewText}</small></>}
              {busy === null && !errorIsCurrent && !validation && isCurrentView && <><strong>View is up to date.</strong><small>Displayed: {view ? scopeDescription(view.scope, view.snapshot.teams) : requestedText} · revision {view?.snapshot.snapshot_revision}.</small></>}
              {busy === null && !errorIsCurrent && !validation && !isCurrentView && !view && <><strong>Source is not available yet.</strong><small>Use Retry to read the current source.</small></>}
              {busy === null && !errorIsCurrent && !validation && !isCurrentView && view && <><strong>Showing previously loaded results.</strong><small>{previousViewText} Requested: {requestedText}.</small></>}
            </div>
            {errorIsCurrent && <button className="state-action" type="button" data-eval="retry-load" onClick={handleRetry}>Retry</button>}
          </section>

          <section className="metrics" aria-label="Current view metrics">
            <div className="metric-card" data-eval="metric" data-eval-key="ticket_count" data-eval-unit="tickets">
              <span className="metric-label">Tickets in view</span>
              <span className="metric-value">{view ? rows.length : '—'}<span className="metric-unit">tickets</span></span>
            </div>
            <div className="metric-card" data-eval="metric" data-eval-key="active_count" data-eval-unit="tickets">
              <span className="metric-label">Active tickets</span>
              <span className="metric-value">{view ? activeCount : '—'}<span className="metric-unit">tickets</span></span>
            </div>
            <div className="metric-card" data-eval="metric" data-eval-key="overdue_active_count" data-eval-unit="tickets">
              <span className="metric-label">Overdue · active</span>
              <span className="metric-value">{view ? overdueCount : '—'}<span className="metric-unit">tickets</span></span>
            </div>
            <div className="metric-card" data-eval="metric" data-eval-key="remaining_effort_hours" data-eval-unit="hours">
              <span className="metric-label">Remaining effort · active</span>
              <span className="metric-value">{view ? formatHours(effortHours) : '—'}<span className="metric-unit">hours</span></span>
            </div>
          </section>

          <section className="content-grid">
            <section className="panel" data-eval="status-chart" aria-label="Active ticket counts by status">
              <div className="panel-head">
                <div><h3>Active by status</h3><p>Counts follow the displayed ticket scope.</p></div>
                <span className="mini-badge">ACTIVE QUEUE</span>
              </div>
              <div className="chart">
                <div className="chart-grid">
                  {chartCounts.map(({ status, count }) => {
                    const proportionalHeight = maxChartCount > 0 ? (count / maxChartCount) * 132 : 0;
                    const selected = filters.statuses.length === 1 && filters.statuses[0] === status;
                    return (
                      <button
                        className="chart-bar"
                        key={status}
                        type="button"
                        data-eval="status-bar"
                        data-eval-key={status}
                        aria-label={`${STATUS_LABEL[status]}: ${count} tickets. Select this status.`}
                        aria-pressed={selected}
                        onClick={() => handleChartSelect(status)}
                        disabled={!snapshot || busy === 'initial'}
                      >
                        <span className="chart-label">{STATUS_LABEL[status]}</span>
                        <span className="chart-plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="height">
                          <span className="chart-glyph" data-eval="status-glyph" data-eval-key={status} style={{ height: `${count === 0 ? 1 : proportionalHeight}px` }} aria-hidden="true" />
                        </span>
                        <span className="chart-count" data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count}<span className="chart-unit"> tickets</span></span>
                      </button>
                    );
                  })}
                </div>
                <p className="chart-foot">Select a bar to focus the whole dashboard on that status. The chart uses a shared zero baseline.</p>
              </div>
            </section>

            <section className="panel table-panel">
              <div className="panel-head table-head">
                <div><h3>Ticket records</h3><p data-eval="displayed-scope">{view ? `Displayed scope: ${scopeDescription(displayedScope!, view.snapshot.teams)} · revision ${view.snapshot.snapshot_revision}` : `Displayed scope: ${requestedText}`}</p></div>
                <span className="mini-badge">{view ? `${rows.length} RECORDS` : 'NO SNAPSHOT'}</span>
              </div>
              <div className="table-wrap">
                <table data-eval="tickets-table">
                  <thead><tr><th>Ticket ID</th><th>Team / identity</th><th>Status</th><th>Priority</th><th>Created · UTC</th><th>Due · UTC</th><th>Remaining effort</th></tr></thead>
                  <tbody>
                    {view && rows.map((ticket) => {
                      const team = view.snapshot.teams.find((item) => item.team_id === ticket.team_id);
                      const statusClass = ticket.status.toLowerCase().replace('_', '-');
                      return (
                        <tr key={`${ticket.ticket_id}-${ticket.team_id}`} data-eval="ticket-row" data-eval-key={ticket.ticket_id}>
                          <td data-eval="ticket-cell" data-eval-field="ticket_id" data-eval-unit="ticket ID" data-eval-key={ticket.ticket_id}><span className="ticket-id">{ticket.ticket_id}</span></td>
                          <td data-eval="ticket-cell" data-eval-field="team_id" data-eval-unit="team ID" data-eval-key={ticket.ticket_id}><span className="team-name">{team?.display_name ?? 'Unknown team'}</span><span className="team-id">{ticket.team_id}</span></td>
                          <td data-eval="ticket-cell" data-eval-field="status" data-eval-unit="status" data-eval-key={ticket.ticket_id}><span className={`status-pill ${statusClass}`}>{STATUS_LABEL[ticket.status]} <span>({ticket.status})</span></span></td>
                          <td><span className="priority">{PRIORITY_LABEL[ticket.priority]}</span></td>
                          <td><time dateTime={ticket.created_at}>{compactTime(ticket.created_at)}</time></td>
                          <td data-eval="ticket-cell" data-eval-field="due_at" data-eval-unit="UTC" data-eval-key={ticket.ticket_id}><time dateTime={ticket.due_at}>{compactTime(ticket.due_at)}</time></td>
                          <td data-eval="ticket-cell" data-eval-field="remaining_minutes" data-eval-unit="minutes" data-eval-key={ticket.ticket_id}>{ticket.remaining_minutes} min</td>
                        </tr>
                      );
                    })}
                    {view && rows.length === 0 && (
                      <tr><td colSpan={7} className="empty-row"><div data-eval="empty-state"><strong>No matching tickets.</strong><br />This is a successful empty result for the displayed scope.</div></td></tr>
                    )}
                    {!view && busy !== 'initial' && (
                      <tr><td colSpan={7} className="empty-row">No source results are available. Use Retry to load the dataset.</td></tr>
                    )}
                    {!view && busy === 'initial' && (
                      <tr><td colSpan={7} className="empty-row">Reading the supplied support snapshot…</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="table-foot">
                <span>{view ? <>Showing <strong>{rows.length}</strong> matching tickets · Due timestamps are UTC</> : 'Waiting for source records'}</span>
                <span>{view ? `Snapshot ${view.snapshot.snapshot_revision}` : currentBusy ? 'Loading' : 'Unavailable'}</span>
              </div>
            </section>
          </section>
        </div>
      </main>
    </FrameRoot>
  );
}
