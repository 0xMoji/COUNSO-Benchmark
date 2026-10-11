import React, { useEffect, useMemo, useRef, useState } from "react";
import { FrameRoot } from "@dust/frame";
import { callFunction, readFile } from "@dust/react-hooks";

type Status = "OPEN" | "IN_PROGRESS" | "WAITING" | "CLOSED";
type Priority = "P1" | "P2" | "P3";
type Team = { team_id: string; display_name: string };
type Ticket = {
  ticket_id: string;
  team_id: string;
  status: Status;
  priority: Priority;
  created_at: string;
  due_at: string;
  remaining_minutes: number;
};
type Snapshot = {
  schema_version: "support-snapshot-1";
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
type Phase = "loading" | "ready" | "error";

const ALL_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING", "CLOSED"];
const ACTIVE_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING"];
const STATUS_TONES: Record<Status, string> = {
  OPEN: "#2563eb",
  IN_PROGRESS: "#8b5cf6",
  WAITING: "#f59e0b",
  CLOSED: "#64748b",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}
function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isStatus(value: unknown): value is Status {
  return typeof value === "string" && ALL_STATUSES.includes(value as Status);
}
function validateSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || value.schema_version !== "support-snapshot-1" ||
      typeof value.snapshot_revision !== "string" || !value.snapshot_revision ||
      !isDateTime(value.as_of) || !isDate(value.default_created_from) ||
      !isDate(value.default_created_to) || !Array.isArray(value.teams) ||
      !Array.isArray(value.tickets)) {
    throw new Error("The source returned an invalid support snapshot.");
  }
  for (const team of value.teams) {
    if (!isRecord(team) || typeof team.team_id !== "string" || !team.team_id ||
        typeof team.display_name !== "string") {
      throw new Error("The source returned an invalid team.");
    }
  }
  for (const ticket of value.tickets) {
    if (!isRecord(ticket) || typeof ticket.ticket_id !== "string" || !ticket.ticket_id ||
        typeof ticket.team_id !== "string" || !ticket.team_id || !isStatus(ticket.status) ||
        !["P1", "P2", "P3"].includes(String(ticket.priority)) ||
        !isDateTime(ticket.created_at) || !isDateTime(ticket.due_at) ||
        typeof ticket.remaining_minutes !== "number" ||
        !Number.isInteger(ticket.remaining_minutes) || ticket.remaining_minutes < 0) {
      throw new Error("The source returned an invalid ticket.");
    }
  }
  return value as unknown as Snapshot;
}
function defaultScope(snapshot: Snapshot): Scope {
  return {
    team_ids: [],
    statuses: [...ALL_STATUSES],
    created_from: snapshot.default_created_from,
    created_to: snapshot.default_created_to,
  };
}
function sameMembers<T extends string>(a: T[], b: T[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every(item => b.includes(item));
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.created_from === b.created_from && a.created_to === b.created_to &&
    sameMembers(a.team_ids, b.team_ids) && sameMembers(a.statuses, b.statuses);
}
function echoedScope(value: unknown, requested: Scope): boolean {
  if (!isRecord(value) || !Array.isArray(value.team_ids) || !Array.isArray(value.statuses) ||
      !isDate(value.created_from) || !isDate(value.created_to)) return false;
  const scope = value as unknown as Scope;
  return sameScope(scope, requested);
}
function scopeLabel(scope: Scope): string {
  const team = scope.team_ids.length === 0 ? "all teams" : scope.team_ids.join(", ");
  const statuses = scope.statuses.length === 0 ? "no statuses" : scope.statuses.join(", ");
  return `Teams: ${team} · Statuses: ${statuses} · Created UTC [${scope.created_from}, ${scope.created_to})`;
}
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The source could not be loaded.";
}
function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(3).replace(/\.?0+$/, "");
}

export default function SupportOperationsFrame() {
  const [intent, setIntent] = useState<Scope | null>(null);
  const intentRef = useRef<Scope | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestNumber = useRef(0);

  async function loadInitial(): Promise<void> {
    const request = ++requestNumber.current;
    setPhase("loading");
    setProblem(null);
    try {
      const frameFile = await readFile("./dataset.json");
      if (!frameFile) throw new Error("The support snapshot is unavailable.");
      const source = validateSnapshot(JSON.parse(await frameFile.file.text()) as unknown);
      if (request !== requestNumber.current) return;
      const firstScope = defaultScope(source);
      snapshotRef.current = source;
      intentRef.current = firstScope;
      setSnapshot(source);
      setIntent(firstScope);
      setView({ snapshot: source, scope: firstScope });
      setPhase("ready");
    } catch (error) {
      if (request !== requestNumber.current) return;
      setProblem(errorText(error));
      setPhase("error");
    }
  }

  async function loadScope(requested: Scope, resetAgainstCurrentSource = false): Promise<void> {
    const request = ++requestNumber.current;
    setPhase("loading");
    setProblem(null);
    try {
      const raw = await callFunction("load-data", requested);
      if (!isRecord(raw) || !echoedScope(raw.scope, requested)) {
        throw new Error("The source response did not match the requested scope.");
      }
      const source = validateSnapshot(raw.snapshot);
      if (request !== requestNumber.current || !intentRef.current || !sameScope(intentRef.current, requested)) return;

      snapshotRef.current = source;
      setSnapshot(source);

      if (resetAgainstCurrentSource &&
          (requested.created_from !== source.default_created_from || requested.created_to !== source.default_created_to)) {
        const revised = defaultScope(source);
        intentRef.current = revised;
        setIntent(revised);
        void loadScope(revised);
        return;
      }

      const selectedTeamMissing = requested.team_ids.some(id => !source.teams.some(team => team.team_id === id));
      if (selectedTeamMissing) {
        const revised: Scope = { ...requested, team_ids: [] };
        intentRef.current = revised;
        setIntent(revised);
        setNotice("The selected team is no longer in the current source. Showing all teams instead.");
        void loadScope(revised);
        return;
      }

      setView({ snapshot: source, scope: requested });
      setPhase("ready");
    } catch (error) {
      if (request !== requestNumber.current || !intentRef.current || !sameScope(intentRef.current, requested)) return;
      setProblem(errorText(error));
      setPhase("error");
    }
  }

  function selectScope(next: Scope, resetAgainstCurrentSource = false): void {
    intentRef.current = next;
    setIntent(next);
    setNotice(null);
    void loadScope(next, resetAgainstCurrentSource);
  }

  useEffect(() => {
    void loadInitial();
    return () => { requestNumber.current += 1; };
  }, []);

  const rows = useMemo(() => {
    if (!view) return [] as Ticket[];
    const from = Date.parse(`${view.scope.created_from}T00:00:00Z`);
    const to = Date.parse(`${view.scope.created_to}T00:00:00Z`);
    return view.snapshot.tickets.filter(ticket => {
      const created = Date.parse(ticket.created_at);
      return (view.scope.team_ids.length === 0 || view.scope.team_ids.includes(ticket.team_id)) &&
        view.scope.statuses.includes(ticket.status) && created >= from && created < to;
    });
  }, [view]);

  const facts = useMemo(() => {
    const counts: Record<"OPEN" | "IN_PROGRESS" | "WAITING", number> = {
      OPEN: 0, IN_PROGRESS: 0, WAITING: 0,
    };
    let activeCount = 0;
    let overdueCount = 0;
    let activeMinutes = 0;
    const asOf = view ? Date.parse(view.snapshot.as_of) : 0;
    for (const ticket of rows) {
      if (ticket.status === "OPEN" || ticket.status === "IN_PROGRESS" || ticket.status === "WAITING") {
        counts[ticket.status] += 1;
        activeCount += 1;
        activeMinutes += ticket.remaining_minutes;
        if (Date.parse(ticket.due_at) < asOf) overdueCount += 1;
      }
    }
    return { ticketCount: rows.length, activeCount, overdueCount, activeMinutes, counts };
  }, [rows, view]);

  const teamMap = useMemo(() => {
    const result = new Map<string, string>();
    if (view) for (const team of view.snapshot.teams) result.set(team.team_id, team.display_name);
    return result;
  }, [view]);
  const currentSource = snapshot || view?.snapshot || null;
  const hasPriorView = view !== null && (phase !== "ready" || (intent !== null && !sameScope(intent, view.scope)));
  const maxCount = Math.max(0, facts.counts.OPEN, facts.counts.IN_PROGRESS, facts.counts.WAITING);
  const metrics = [
    { key: "ticket_count", title: "Tickets", value: String(facts.ticketCount), unit: "tickets", sub: "All matching records" },
    { key: "active_count", title: "Active", value: String(facts.activeCount), unit: "tickets", sub: "Open · In progress · Waiting" },
    { key: "overdue_active_count", title: "Overdue active", value: String(facts.overdueCount), unit: "tickets", sub: "Due before source as-of" },
    { key: "remaining_effort_hours", title: "Remaining effort", value: formatHours(facts.activeMinutes), unit: "hours", sub: "Active tickets only" },
  ];

  return (
    <FrameRoot data-eval="dashboard-root" className="support-frame">
      <style>{`
        .support-frame { --ink:#132238; --muted:#5c6b7d; --line:#e3e9f0; --surface:#fff; --blue:#2563eb;
          color:var(--ink); background:linear-gradient(155deg,#eef4ff 0%,#f7f9fc 34%,#f6f8fb 100%);
          min-height:100vh; padding:28px; box-sizing:border-box; font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .support-frame * { box-sizing:border-box; }
        .support-shell { max-width:1440px; margin:0 auto; }
        .support-top { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin:0 0 23px; }
        .support-eyebrow { color:#355bb7; font-weight:750; letter-spacing:.12em; font-size:11px; text-transform:uppercase; margin-bottom:8px; }
        .support-title { margin:0; font-size:clamp(27px,3vw,38px); letter-spacing:-.045em; line-height:1.13; font-weight:760; }
        .support-subtitle { margin:10px 0 0; color:var(--muted); font-size:14px; line-height:1.5; }
        .support-actions { display:flex; flex-wrap:wrap; gap:9px; padding-top:7px; }
        .support-btn { appearance:none; border:1px solid #cdd9e8; border-radius:10px; background:#fff; color:#17315a;
          padding:10px 15px; font:inherit; font-size:13px; font-weight:650; cursor:pointer; min-height:40px; white-space:nowrap;
          box-shadow:0 1px 2px rgba(18,39,76,.04); }
        .support-btn:hover { border-color:#89a7da; background:#f7faff; }
        .support-btn:disabled { cursor:not-allowed; opacity:.52; }
        .support-btn.primary { border-color:#255fd9; background:#255fd9; color:#fff; }
        .support-btn.primary:hover { background:#1e50bc; }
        .support-frame :is(button,select,input):focus-visible { outline:3px solid #78a5ff; outline-offset:3px; }
        .support-panel { background:#fff; border:1px solid var(--line); border-radius:16px; box-shadow:0 7px 30px rgba(21,43,82,.045); }
        .support-filters { padding:19px 20px 20px; margin-bottom:18px; }
        .support-section-kicker { font-size:11px; text-transform:uppercase; color:#687b94; font-weight:760; letter-spacing:.1em; margin:0 0 14px; }
        .support-filter-grid { display:grid; grid-template-columns:minmax(210px,1.2fr) minmax(255px,1.7fr) minmax(150px,.8fr) minmax(150px,.8fr); gap:17px; align-items:end; }
        .support-field { min-width:0; }
        .support-field-label { display:block; margin-bottom:8px; color:#354762; font-size:12px; font-weight:700; }
        .support-input { border:1px solid #cfdae8; border-radius:9px; background:#fff; color:#182b47; min-height:40px; width:100%; padding:8px 10px; font:inherit; font-size:13px; }
        .support-input:disabled { opacity:.57; }
        .support-statuses { display:flex; flex-wrap:wrap; gap:6px; min-height:40px; align-items:center; }
        .support-status-option { display:inline-flex; align-items:center; gap:6px; border:1px solid #d7e0eb; padding:8px 9px;
          border-radius:9px; font-size:12px; font-weight:650; color:#32445e; cursor:pointer; white-space:nowrap; }
        .support-status-option:has(input:checked) { border-color:#9ebbf3; background:#eef5ff; color:#194887; }
        .support-status-option input { accent-color:#2667dd; margin:0; cursor:pointer; }
        .support-state { margin-bottom:17px; border:1px solid #d5e5fc; background:#eff6ff; color:#254e83; padding:12px 16px; border-radius:12px;
          display:flex; align-items:center; justify-content:space-between; gap:13px; font-size:13px; line-height:1.45; }
        .support-state.error { border-color:#f0cbc2; background:#fff3ef; color:#9e3b2e; }
        .support-state.ok { border-color:#dce6ef; background:#f8fafc; color:#476074; }
        .support-state-main { font-weight:680; }
        .support-state-detail { display:block; margin-top:3px; font-weight:450; }
        .support-scope { margin:0 0 17px; font-size:12px; color:#607189; padding:0 3px; line-height:1.5; }
        .support-scope strong { color:#324763; }
        .support-notice { padding:9px 12px; background:#fff8e7; color:#765516; border:1px solid #f5e0ae; border-radius:9px; margin-bottom:14px; font-size:12px; }
        .support-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:13px; margin-bottom:18px; }
        .support-metric { padding:18px 20px 16px; min-width:0; }
        .support-metric-title { color:#63758e; font-size:12px; font-weight:700; }
        .support-metric-value { margin-top:11px; font-size:31px; letter-spacing:-.05em; font-weight:750; line-height:1.12; white-space:nowrap; }
        .support-metric-unit { font-size:12px; font-weight:620; letter-spacing:0; color:#597088; margin-left:5px; }
        .support-metric-sub { color:#8a98a8; font-size:11px; margin-top:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .support-body { display:grid; grid-template-columns:minmax(290px,.68fr) minmax(0,1.7fr); gap:17px; align-items:start; }
        .support-chart-panel, .support-table-panel { padding:21px; min-width:0; }
        .support-panel-heading { margin:0; font-size:16px; font-weight:750; letter-spacing:-.02em; }
        .support-panel-sub { color:#78899b; margin:6px 0 17px; font-size:12px; line-height:1.4; }
        .support-chart { display:flex; flex-direction:column; gap:7px; }
        .support-chart-row { display:grid; grid-template-columns:105px minmax(0,1fr) 28px; width:100%; gap:11px; align-items:center;
          padding:11px 10px; border-radius:10px; border:1px solid transparent; background:transparent; color:#2e405a;
          cursor:pointer; text-align:left; font:inherit; }
        .support-chart-row:hover { border-color:#d8e6f9; background:#f7faff; }
        .support-chart-row[aria-pressed="true"] { border-color:#a7c4f2; background:#eff5ff; }
        .support-chart-label { font-size:11px; font-weight:750; white-space:nowrap; }
        .support-chart-plot { display:block; height:17px; min-width:0; width:100%; background:#edf1f7; border-radius:5px; overflow:hidden; }
        .support-chart-glyph { display:block; height:100%; border-radius:5px; }
        .support-chart-count { text-align:right; font-size:13px; font-weight:750; font-variant-numeric:tabular-nums; }
        .support-chart-foot { border-top:1px solid #edf0f4; padding-top:13px; margin-top:16px; color:#8492a3; font-size:11px; line-height:1.5; }
        .support-table-header { display:flex; justify-content:space-between; gap:15px; align-items:start; }
        .support-count-pill { padding:5px 9px; border-radius:99px; color:#35588b; background:#ecf3ff; font-size:11px; font-weight:700; white-space:nowrap; }
        .support-table-scroll { overflow-x:auto; width:100%; }
        .support-table { width:100%; border-collapse:collapse; text-align:left; font-size:12px; }
        .support-table th { color:#7a8b9f; background:#fafbfd; font-size:10px; font-weight:750; letter-spacing:.04em; text-transform:uppercase;
          padding:11px 11px; white-space:nowrap; border-bottom:1px solid #e8edf3; }
        .support-table td { color:#293c55; padding:12px 11px; border-bottom:1px solid #edf1f5; vertical-align:middle; }
        .support-table tbody tr:last-child td { border-bottom:0; }
        .support-table tbody tr:hover { background:#fafcff; }
        .support-ticket-id { font-weight:750; color:#244c8a; white-space:nowrap; }
        .support-team-name { font-weight:680; white-space:nowrap; }
        .support-team-id { color:#8a99ab; font-size:10px; margin-top:3px; white-space:nowrap; }
        .support-chip { display:inline-flex; padding:4px 7px; border-radius:6px; font-size:10px; font-weight:750; white-space:nowrap; }
        .support-date { font-variant-numeric:tabular-nums; white-space:nowrap; font-size:11px; }
        .support-effort { font-variant-numeric:tabular-nums; font-weight:700; white-space:nowrap; }
        .support-empty { text-align:center; padding:42px 16px; color:#697d91; }
        .support-empty strong { display:block; color:#344c68; font-size:15px; margin-bottom:5px; }
        @media(max-width:1050px) { .support-filter-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .support-body { grid-template-columns:1fr; } }
        @media(max-width:650px) { .support-frame { padding:17px; } .support-top { flex-direction:column; gap:11px; }
          .support-filter-grid { grid-template-columns:1fr; } .support-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
          .support-metric { padding:15px; } .support-metric-value { font-size:25px; } .support-chart-panel,.support-table-panel { padding:16px; } }
      `}</style>
      <div className="support-shell">
        <header className="support-top">
          <div>
            <div className="support-eyebrow">Support operations / live source</div>
            <h1 className="support-title">Ticket operations</h1>
            <p className="support-subtitle">A focused view of workload, due risk and active tickets in the selected UTC created-date window.</p>
          </div>
          <div className="support-actions">
            <button type="button" className="support-btn" data-eval="refresh-data" disabled={!intent}
              onClick={() => { if (intentRef.current) void loadScope(intentRef.current); }}>Refresh data</button>
            <button type="button" className="support-btn primary" data-eval="reset-filters" disabled={!currentSource}
              onClick={() => { if (snapshotRef.current) selectScope(defaultScope(snapshotRef.current), true); }}>Reset filters</button>
          </div>
        </header>

        <section className="support-panel support-filters" aria-label="Ticket filters">
          <div className="support-section-kicker">Scope controls</div>
          <div className="support-filter-grid">
            <div className="support-field">
              <label className="support-field-label" htmlFor="team-filter">Team</label>
              <select id="team-filter" className="support-input" data-eval="team-filter" value={intent?.team_ids[0] || ""}
                disabled={!intent} onChange={event => {
                  if (!intentRef.current) return;
                  selectScope({ ...intentRef.current, team_ids: event.target.value ? [event.target.value] : [] });
                }}>
                <option value="">All teams</option>
                {(currentSource?.teams || []).map(team =>
                  <option key={team.team_id} value={team.team_id}>{team.display_name} · {team.team_id}</option>)}
              </select>
            </div>
            <div className="support-field">
              <div className="support-field-label" id="status-filter-label">Status</div>
              <div className="support-statuses" role="group" aria-labelledby="status-filter-label">
                {ALL_STATUSES.map(status =>
                  <label className="support-status-option" key={status}>
                    <input type="checkbox" data-eval="status-option" data-eval-key={status}
                      checked={intent?.statuses.includes(status) || false} disabled={!intent}
                      onChange={() => {
                        if (!intentRef.current) return;
                        const current = intentRef.current;
                        const next = current.statuses.includes(status)
                          ? current.statuses.filter(item => item !== status)
                          : ALL_STATUSES.filter(item => item === status || current.statuses.includes(item));
                        selectScope({ ...current, statuses: next });
                      }} />
                    {status}
                  </label>)}
              </div>
            </div>
            <div className="support-field">
              <label className="support-field-label" htmlFor="created-from">Created from · UTC, inclusive</label>
              <input id="created-from" type="date" className="support-input" data-eval="created-from" value={intent?.created_from || ""}
                disabled={!intent} onChange={event => {
                  if (intentRef.current && isDate(event.target.value)) selectScope({ ...intentRef.current, created_from: event.target.value });
                }} />
            </div>
            <div className="support-field">
              <label className="support-field-label" htmlFor="created-to">Created to · UTC, exclusive</label>
              <input id="created-to" type="date" className="support-input" data-eval="created-to" value={intent?.created_to || ""}
                disabled={!intent} onChange={event => {
                  if (intentRef.current && isDate(event.target.value)) selectScope({ ...intentRef.current, created_to: event.target.value });
                }} />
            </div>
          </div>
        </section>

        <div data-eval="view-state" aria-live="polite" className={`support-state ${phase === "error" ? "error" : phase === "ready" ? "ok" : ""}`}>
          <div>
            <span className="support-state-main">
              {phase === "loading" ? (view ? "Loading requested selection…" : "Loading support snapshot…") :
                phase === "error" ? "Could not load the requested selection" :
                rows.length === 0 ? "Ready · no matching tickets" : "Ready · current source loaded"}
            </span>
            <span className="support-state-detail">
              {phase === "error" ? `${problem || "Source error."} ${view ? "The results below are from the previous successful view." : "No results are available yet."}` :
                phase === "loading" && view ? "The results below are from the previous successful view until this request succeeds." :
                phase === "ready" && view ? `Snapshot ${view.snapshot.snapshot_revision} · as of ${view.snapshot.as_of}` : "Reading the controlled local source."}
            </span>
          </div>
          {phase === "error" &&
            <button type="button" className="support-btn" data-eval="retry-load"
              onClick={() => { if (intentRef.current) void loadScope(intentRef.current); else void loadInitial(); }}>Retry</button>}
        </div>

        {notice && <div className="support-notice" role="status">{notice}</div>}
        <div className="support-scope" data-eval="displayed-scope">
          {view ? <><strong>{hasPriorView ? "Previous results" : "Displayed results"}</strong> · Snapshot {view.snapshot.snapshot_revision} · As of {view.snapshot.as_of} · {scopeLabel(view.scope)}</> :
            <><strong>No results displayed</strong>{intent ? ` · Requested: ${scopeLabel(intent)}` : ""}</>}
        </div>
        {intent && phase !== "ready" && view &&
          <div className="support-scope" data-eval="requested-scope"><strong>Requested selection</strong> · {scopeLabel(intent)}</div>}

        <section className="support-metrics" aria-label="Ticket metrics">
          {metrics.map(metric =>
            <div className="support-panel support-metric" data-eval="metric" data-eval-key={metric.key}
              data-eval-unit={metric.unit} key={metric.key}>
              <div className="support-metric-title">{metric.title}</div>
              <div className="support-metric-value">{metric.value}{" "}<span className="support-metric-unit">{metric.unit}</span></div>
              <div className="support-metric-sub">{metric.sub}</div>
            </div>)}
        </section>

        <div className="support-body">
          <section className="support-panel support-chart-panel" data-eval="status-chart" aria-label="Active tickets by status">
            <h2 className="support-panel-heading">Active by status</h2>
            <p className="support-panel-sub">Matching tickets by active status · select a bar to focus its status</p>
            <div className="support-chart">
              {ACTIVE_STATUSES.map(status => {
                const count = facts.counts[status];
                const width = maxCount === 0 ? 0 : count / maxCount * 100;
                return <button type="button" className="support-chart-row" data-eval="status-bar" data-eval-key={status}
                    key={status} disabled={!intent} aria-pressed={!!view && view.scope.statuses.length === 1 && view.scope.statuses[0] === status}
                    aria-label={`Select ${status} status, ${count} matching tickets`}
                    onClick={() => { if (intentRef.current) selectScope({ ...intentRef.current, statuses: [status] }); }}>
                  <span className="support-chart-label">{status}</span>
                  <span className="support-chart-plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="width">
                    <span className="support-chart-glyph" data-eval="status-glyph" data-eval-key={status}
                      style={{ width: `${width}%`, background: STATUS_TONES[status] }} />
                  </span>
                  <span className="support-chart-count" data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">{count}</span>
                </button>;
              })}
            </div>
            <div className="support-chart-foot">One shared zero-baseline scale. Closed tickets are included in total tickets, but excluded from active counts and effort.</div>
          </section>

          <section className="support-panel support-table-panel" aria-label="Matching tickets">
            <div className="support-table-header">
              <div>
                <h2 className="support-panel-heading">Tickets</h2>
                <p className="support-panel-sub">Source IDs and timestamps are shown as supplied.</p>
              </div>
              <span className="support-count-pill">{rows.length} shown</span>
            </div>
            <div className="support-table-scroll">
              <table className="support-table" data-eval="tickets-table">
                <thead><tr>
                  <th scope="col">Ticket ID</th><th scope="col">Team</th><th scope="col">Team ID</th><th scope="col">Status</th>
                  <th scope="col">Due at</th><th scope="col">Remaining · minutes</th><th scope="col">Priority</th><th scope="col">Created at</th>
                </tr></thead>
                <tbody>
                  {rows.map(ticket =>
                    <tr data-eval="ticket-row" data-eval-key={ticket.ticket_id} key={ticket.ticket_id}>
                      <td className="support-ticket-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="ticket_id">{ticket.ticket_id}</td>
                      <td className="support-team-name">{teamMap.get(ticket.team_id) ?? "Unknown team"}</td>
                      <td className="support-team-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="team_id">{ticket.team_id}</td>
                      <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="status"><span className="support-chip" style={{color: STATUS_TONES[ticket.status], background: `${STATUS_TONES[ticket.status]}16`}}>{ticket.status}</span></td>
                      <td className="support-date" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="due_at">{ticket.due_at}</td>
                      <td className="support-effort" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">{ticket.remaining_minutes}</td>
                      <td><span className="support-chip" style={{color:ticket.priority === "P1" ? "#ad4f31" : "#52637b",background:ticket.priority === "P1" ? "#fff0e9" : "#f0f3f7"}}>{ticket.priority}</span></td>
                      <td className="support-date">{ticket.created_at}</td>
                    </tr>)}
                </tbody>
              </table>
              {view && rows.length === 0 &&
                <div className="support-empty" data-eval="empty-state" role="status">
                  <strong>No matching tickets</strong>
                  {hasPriorView
                    ? "The previous successful scope had no matching tickets. The current selection is pending or failed; see the source status above."
                    : "This source read succeeded. Try a different team, status or UTC created-date window."}
                </div>}
            </div>
          </section>
        </div>
      </div>
    </FrameRoot>
  );
}
