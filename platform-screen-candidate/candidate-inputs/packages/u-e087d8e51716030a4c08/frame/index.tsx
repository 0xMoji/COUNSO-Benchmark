import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FrameRoot } from "@dust/frame";
import { callFunction, readFile } from "@dust/react-hooks";

type Status = "OPEN" | "IN_PROGRESS" | "WAITING" | "CLOSED";

type Team = {
  team_id: string;
  display_name: string;
};

type Ticket = {
  ticket_id: string;
  team_id: string;
  status: Status;
  priority: "P1" | "P2" | "P3";
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

type DisplayedView = {
  snapshot: Snapshot;
  scope: Scope;
};

type LoadResult = {
  snapshot: Snapshot;
  scope: Scope;
};

const ALL_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING", "CLOSED"];
const ACTIVE_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING"];

const STATUS_LABELS: Record<Status, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting",
  CLOSED: "Closed",
};

const STATUS_COLORS: Record<Status, string> = {
  OPEN: "#5b7cfa",
  IN_PROGRESS: "#9b6cf0",
  WAITING: "#e8a33d",
  CLOSED: "#778093",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (ALL_STATUSES as string[]).includes(value);
}

function isTeam(value: unknown): value is Team {
  return (
    isPlainObject(value) &&
    typeof value.team_id === "string" &&
    value.team_id.length > 0 &&
    typeof value.display_name === "string"
  );
}

function isTicket(value: unknown): value is Ticket {
  return (
    isPlainObject(value) &&
    typeof value.ticket_id === "string" &&
    value.ticket_id.length > 0 &&
    typeof value.team_id === "string" &&
    value.team_id.length > 0 &&
    isStatus(value.status) &&
    (value.priority === "P1" || value.priority === "P2" || value.priority === "P3") &&
    isDateTime(value.created_at) &&
    isDateTime(value.due_at) &&
    typeof value.remaining_minutes === "number" &&
    Number.isInteger(value.remaining_minutes) &&
    value.remaining_minutes >= 0
  );
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!isPlainObject(value)) return false;
  return (
    value.schema_version === "support-snapshot-1" &&
    typeof value.snapshot_revision === "string" &&
    value.snapshot_revision.length > 0 &&
    isDateTime(value.as_of) &&
    isDateOnly(value.default_created_from) &&
    isDateOnly(value.default_created_to) &&
    Array.isArray(value.teams) &&
    value.teams.every(isTeam) &&
    Array.isArray(value.tickets) &&
    value.tickets.every(isTicket)
  );
}

function isScope(value: unknown): value is Scope {
  if (!isPlainObject(value)) return false;
  return (
    Array.isArray(value.team_ids) &&
    value.team_ids.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value.team_ids).size === value.team_ids.length &&
    Array.isArray(value.statuses) &&
    value.statuses.every(isStatus) &&
    new Set(value.statuses).size === value.statuses.length &&
    isDateOnly(value.created_from) &&
    isDateOnly(value.created_to)
  );
}

function isLoadResult(value: unknown): value is LoadResult {
  return isPlainObject(value) && isSnapshot(value.snapshot) && isScope(value.scope);
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.created_from === right.created_from &&
    left.created_to === right.created_to &&
    left.team_ids.length === right.team_ids.length &&
    left.team_ids.every((item, index) => item === right.team_ids[index]) &&
    left.statuses.length === right.statuses.length &&
    left.statuses.every((item, index) => item === right.statuses[index])
  );
}

function defaultScope(snapshot: Snapshot): Scope {
  return {
    team_ids: [],
    statuses: [...ALL_STATUSES],
    created_from: snapshot.default_created_from,
    created_to: snapshot.default_created_to,
  };
}

function scopeSummary(scope: Scope, snapshot: Snapshot): string {
  const team =
    scope.team_ids.length === 0
      ? "All teams"
      : scope.team_ids
          .map((teamId) => {
            const match = snapshot.teams.find((candidate) => candidate.team_id === teamId);
            return match ? `${match.display_name} (${teamId})` : teamId;
          })
          .join(", ");
  const statuses =
    scope.statuses.length === 0
      ? "No statuses"
      : scope.statuses.map((status) => STATUS_LABELS[status]).join(", ");
  return `${team} · ${statuses} · ${scope.created_from} ≤ created < ${scope.created_to}`;
}

function filterTickets(snapshot: Snapshot, scope: Scope): Ticket[] {
  const from = Date.parse(`${scope.created_from}T00:00:00.000Z`);
  const to = Date.parse(`${scope.created_to}T00:00:00.000Z`);
  const selectedTeams = new Set(scope.team_ids);
  const selectedStatuses = new Set(scope.statuses);

  return snapshot.tickets.filter((ticket) => {
    const teamMatches = selectedTeams.size === 0 || selectedTeams.has(ticket.team_id);
    const statusMatches = selectedStatuses.has(ticket.status);
    const createdAt = Date.parse(ticket.created_at);
    return teamMatches && statusMatches && createdAt >= from && createdAt < to;
  });
}

function formatHours(minutes: number): string {
  const value = minutes / 60;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0$/, "");
}

function formatUtc(value: string): string {
  return new Date(value).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The synthetic source could not be loaded.";
}

export default function SupportOperationsFrame() {
  const [intent, setIntent] = useState<Scope | null>(null);
  const [displayed, setDisplayed] = useState<DisplayedView | null>(null);
  const [phase, setPhase] = useState<"booting" | "ready" | "loading" | "error">("booting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadReason, setLoadReason] = useState<"initial" | "filter" | "refresh" | "retry" | "reset">("initial");

  const requestSequence = useRef(0);
  const intentRef = useRef<Scope | null>(null);
  const didBootstrap = useRef(false);

  const issueLoad = useCallback(
    async (requestedScope: Scope, reason: "initial" | "filter" | "refresh" | "retry" | "reset") => {
      const requestId = ++requestSequence.current;
      setLoadReason(reason);
      setLoadError(null);
      setPhase("loading");

      try {
        const result = await callFunction("load-data", requestedScope);
        if (requestId !== requestSequence.current) return;
        if (!isLoadResult(result)) {
          throw new Error("The source returned an invalid support snapshot.");
        }
        if (!sameScope(result.scope, requestedScope)) {
          throw new Error("The source response did not match the requested filter scope.");
        }

        setDisplayed({ snapshot: result.snapshot, scope: result.scope });
        setLoadError(null);
        setPhase("ready");
      } catch (error) {
        if (requestId !== requestSequence.current) return;
        setLoadError(errorMessage(error));
        setPhase("error");
      }
    },
    []
  );

  useEffect(() => {
    if (didBootstrap.current) return;
    didBootstrap.current = true;

    const bootstrap = async () => {
      const bootstrapId = ++requestSequence.current;
      setPhase("booting");
      setLoadError(null);

      try {
        const sourceFile = await readFile("./dataset.json");
        if (bootstrapId !== requestSequence.current) return;
        if (!sourceFile) {
          throw new Error("The local support dataset is unavailable.");
        }
        const raw = await sourceFile.file.text();
        if (bootstrapId !== requestSequence.current) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("The local support dataset is not valid JSON.");
        }
        if (!isSnapshot(parsed)) {
          throw new Error("The local support dataset does not match the support snapshot schema.");
        }

        const initialScope = defaultScope(parsed);
        intentRef.current = initialScope;
        setIntent(initialScope);
        setDisplayed({ snapshot: parsed, scope: initialScope });
        setLoadError(null);
        setPhase("ready");
      } catch (error) {
        if (bootstrapId !== requestSequence.current) return;
        setLoadError(errorMessage(error));
        setPhase("error");
      }
    };

    void bootstrap();
  }, [issueLoad]);

  const setScopeAndLoad = useCallback(
    (nextScope: Scope, reason: "filter" | "reset") => {
      intentRef.current = nextScope;
      setIntent(nextScope);
      void issueLoad(nextScope, reason);
    },
    [issueLoad]
  );

  const filteredTickets = useMemo(() => {
    if (!displayed) return [];
    return filterTickets(displayed.snapshot, displayed.scope);
  }, [displayed]);

  const metrics = useMemo(() => {
    if (!displayed) {
      return {
        ticketCount: 0,
        activeCount: 0,
        overdueActiveCount: 0,
        remainingMinutes: 0,
        statusCounts: { OPEN: 0, IN_PROGRESS: 0, WAITING: 0 } as Record<Exclude<Status, "CLOSED">, number>,
      };
    }

    const asOf = displayed.snapshot.as_of;
    const activeTickets = filteredTickets.filter((ticket) => ACTIVE_STATUSES.includes(ticket.status));
    const statusCounts: Record<Exclude<Status, "CLOSED">, number> = {
      OPEN: 0,
      IN_PROGRESS: 0,
      WAITING: 0,
    };
    for (const ticket of activeTickets) {
      statusCounts[ticket.status as Exclude<Status, "CLOSED">] += 1;
    }

    return {
      ticketCount: filteredTickets.length,
      activeCount: activeTickets.length,
      overdueActiveCount: activeTickets.filter((ticket) => Date.parse(ticket.due_at) < Date.parse(asOf)).length,
      remainingMinutes: activeTickets.reduce((total, ticket) => total + ticket.remaining_minutes, 0),
      statusCounts,
    };
  }, [displayed, filteredTickets]);

  const teamById = useMemo(() => {
    const map = new Map<string, Team>();
    if (displayed) {
      for (const team of displayed.snapshot.teams) map.set(team.team_id, team);
    }
    return map;
  }, [displayed]);

  const selectedTeamId = intent && intent.team_ids.length > 0 ? intent.team_ids[0] : "";
  const selectedTeamMissing =
    !!selectedTeamId && !!displayed && !displayed.snapshot.teams.some((team) => team.team_id === selectedTeamId);

  const changeTeam = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (!intent) return;
    const teamId = event.target.value;
    setScopeAndLoad({ ...intent, team_ids: teamId ? [teamId] : [] }, "filter");
  };

  const toggleStatus = (status: Status) => {
    if (!intent) return;
    const isSelected = intent.statuses.includes(status);
    const statuses = isSelected
      ? intent.statuses.filter((candidate) => candidate !== status)
      : ALL_STATUSES.filter((candidate) => candidate === status || intent.statuses.includes(candidate));
    setScopeAndLoad({ ...intent, statuses }, "filter");
  };

  const changeDate = (field: "created_from" | "created_to", value: string) => {
    if (!intent || !isDateOnly(value)) return;
    setScopeAndLoad({ ...intent, [field]: value }, "filter");
  };

  const selectChartStatus = (status: Exclude<Status, "CLOSED">) => {
    if (!intent) return;
    setScopeAndLoad({ ...intent, statuses: [status] }, "filter");
  };

  const refresh = () => {
    if (intentRef.current) void issueLoad(intentRef.current, "refresh");
  };

  const retry = () => {
    if (intentRef.current) void issueLoad(intentRef.current, "retry");
  };

  const reset = () => {
    if (!displayed) return;
    const resetScope = defaultScope(displayed.snapshot);
    setScopeAndLoad(resetScope, "reset");
  };

  const maxStatusCount = Math.max(
    1,
    metrics.statusCounts.OPEN,
    metrics.statusCounts.IN_PROGRESS,
    metrics.statusCounts.WAITING
  );
  const hasPreviousDifferentScope =
    !!displayed && !!intent && !sameScope(displayed.scope, intent);

  return (
    <FrameRoot
      data-eval="dashboard-root"
      className="support-frame"
      theme={{
        "--frame-bg": "#f4f6fa",
        "--frame-card": "#ffffff",
        "--frame-text": "#172033",
        "--frame-muted": "#667085",
        "--frame-border": "#dfe3eb",
        "--frame-accent": "#3559e8",
      }}
    >
      <style>{`
        * { box-sizing: border-box; }
        .support-frame { min-height: 100%; background: var(--frame-bg); color: var(--frame-text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; }
        .shell { max-width: 1180px; margin: 0 auto; }
        .topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
        h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.03em; }
        .subtitle { color: var(--frame-muted); margin: 0; font-size: 14px; }
        .actions { display: flex; gap: 9px; flex-wrap: wrap; }
        button, select, input { font: inherit; }
        button, select, input[type="date"] { border: 1px solid var(--frame-border); border-radius: 9px; background: white; color: var(--frame-text); }
        button { cursor: pointer; }
        button:disabled, select:disabled, input:disabled { cursor: not-allowed; opacity: .55; }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid rgba(53, 89, 232, .25); outline-offset: 2px; border-color: var(--frame-accent); }
        .secondary { min-height: 40px; padding: 0 14px; font-weight: 650; }
        .primary { min-height: 40px; padding: 0 16px; background: var(--frame-accent); color: white; border-color: var(--frame-accent); font-weight: 700; }
        .panel { background: var(--frame-card); border: 1px solid var(--frame-border); border-radius: 14px; box-shadow: 0 1px 2px rgba(20, 30, 55, .04); }
        .filters { padding: 16px; margin-bottom: 16px; }
        .filter-grid { display: grid; grid-template-columns: minmax(190px, 1.15fr) minmax(290px, 1.8fr) minmax(150px, 1fr) minmax(150px, 1fr); gap: 16px; align-items: end; }
        .field-label { display: block; font-size: 12px; font-weight: 750; color: #4b5568; margin: 0 0 7px; text-transform: uppercase; letter-spacing: .045em; }
        select, input[type="date"] { width: 100%; height: 42px; padding: 0 11px; }
        .status-options { min-height: 42px; display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
        .status-check { position: relative; display: inline-flex; min-height: 36px; align-items: center; gap: 6px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--frame-border); background: #fff; color: #4e586b; cursor: pointer; }
        .status-check input { position: static; opacity: 1; pointer-events: auto; width: 15px; height: 15px; margin: 0; accent-color: var(--frame-accent); cursor: pointer; }
        .status-check span { display: inline-flex; align-items: center; gap: 6px; color: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
        .status-check:has(input:checked) { color: #203baf; border-color: #9eb0f7; background: #eef2ff; }
        .status-check:focus-within { outline: 3px solid rgba(53, 89, 232, .25); outline-offset: 2px; border-color: var(--frame-accent); }
        .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
        .notice { border-radius: 10px; padding: 11px 13px; margin-top: 13px; font-size: 13px; line-height: 1.45; }
        .notice.loading { background: #eef3ff; color: #2f4eb1; }
        .notice.error { background: #fff1f0; color: #a22b28; border: 1px solid #ffd0cc; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .notice.ready { background: #eef9f3; color: #256b45; }
        .notice.warning { background: #fff8e7; color: #805d15; }
        .retry { min-height: 34px; padding: 0 12px; color: #8a2421; border-color: #e8aaa5; flex: 0 0 auto; font-weight: 700; }
        .scope-line { margin-top: 10px; color: var(--frame-muted); font-size: 12px; line-height: 1.45; }
        .scope-line strong { color: #3d4657; }
        .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
        .metric { padding: 16px; min-height: 108px; }
        .metric-label { color: var(--frame-muted); font-size: 12px; font-weight: 700; margin-bottom: 10px; }
        .metric-value { display: flex; align-items: baseline; gap: 6px; font-size: 30px; line-height: 1; font-weight: 780; letter-spacing: -.03em; }
        .metric-unit { color: var(--frame-muted); font-size: 12px; font-weight: 650; letter-spacing: 0; }
        .metric-note { margin-top: 9px; color: #858da0; font-size: 11px; }
        .content-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(310px, .7fr); gap: 16px; align-items: start; }
        .section-head { padding: 17px 18px 13px; border-bottom: 1px solid var(--frame-border); }
        .section-title { margin: 0; font-size: 16px; }
        .section-copy { margin: 5px 0 0; color: var(--frame-muted); font-size: 12px; }
        .table-wrap { overflow-x: auto; }
        table { border-collapse: collapse; width: 100%; min-width: 720px; }
        th { padding: 10px 13px; color: #687186; background: #fafbfc; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; text-align: left; white-space: nowrap; }
        td { padding: 12px 13px; border-top: 1px solid #edf0f4; font-size: 13px; vertical-align: middle; }
        tbody tr:hover { background: #fafbff; }
        .ticket-id { font-weight: 760; color: #2948bd; }
        .team-name { display: block; font-weight: 650; }
        .identity { display: block; margin-top: 2px; color: var(--frame-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--frame-border); border-radius: 99px; padding: 4px 8px; white-space: nowrap; font-size: 11px; font-weight: 730; }
        .date-cell { white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #3f485b; }
        .effort { white-space: nowrap; font-weight: 700; }
        .empty { padding: 48px 20px; text-align: center; }
        .empty-icon { width: 42px; height: 42px; border-radius: 12px; margin: 0 auto 11px; display: grid; place-items: center; background: #f1f3f7; color: #748096; font-size: 22px; }
        .empty strong { display: block; font-size: 14px; }
        .empty p { color: var(--frame-muted); font-size: 12px; margin: 5px 0 0; }
        .chart-body { padding: 18px; }
        .chart { height: 250px; display: flex; align-items: stretch; gap: 10px; }
        .chart-bar { flex: 1 1 0; min-width: 0; border: 0; background: transparent; padding: 0; display: flex; flex-direction: column; align-items: stretch; color: inherit; border-radius: 10px; }
        .chart-bar:hover { background: #f7f8fc; }
        .chart-bar[aria-pressed="true"] { background: #eef2ff; box-shadow: inset 0 0 0 1px #c8d2fb; }
        .status-count { height: 28px; display: grid; place-items: center; font-size: 14px; font-weight: 780; }
        .status-plot { height: 160px; margin: 0 10px; border-bottom: 2px solid #cfd5df; background: repeating-linear-gradient(to top, transparent 0, transparent 39px, #eef1f5 39px, #eef1f5 40px); display: flex; align-items: flex-end; position: relative; }
        .status-glyph { width: 100%; min-height: 0; border-radius: 7px 7px 0 0; }
        .bar-label { min-height: 46px; display: grid; place-items: center; padding: 8px 2px 0; color: #525d71; font-size: 11px; font-weight: 720; line-height: 1.2; }
        .chart-foot { margin-top: 13px; color: var(--frame-muted); font-size: 11px; line-height: 1.5; }
        .asof { margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--frame-border); font-size: 11px; color: var(--frame-muted); }
        @media (max-width: 900px) { .filter-grid { grid-template-columns: 1fr 1fr; } .content-grid { grid-template-columns: 1fr; } }
        @media (max-width: 620px) { .support-frame { padding: 14px; } .topline { flex-direction: column; } .metrics { grid-template-columns: 1fr 1fr; } .filter-grid { grid-template-columns: 1fr; } .actions { width: 100%; } .actions button { flex: 1; } }
      `}</style>

      <main className="shell">
        <header className="topline">
          <div>
            <h1>Support operations</h1>
            <p className="subtitle">A live view of ticket volume, workload, and due risk.</p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              data-eval="reset-filters"
              onClick={reset}
              disabled={!displayed || phase === "booting"}
            >
              Reset
            </button>
            <button
              type="button"
              className="primary"
              data-eval="refresh-data"
              onClick={refresh}
              disabled={!intent || phase === "booting"}
            >
              {phase === "loading" && loadReason === "refresh" ? "Refreshing…" : "Refresh data"}
            </button>
          </div>
        </header>

        <section className="panel filters" aria-label="Ticket filters">
          <div className="filter-grid">
            <div>
              <label className="field-label" htmlFor="team-filter">Team</label>
              <select
                id="team-filter"
                data-eval="team-filter"
                value={selectedTeamId}
                onChange={changeTeam}
                disabled={!intent || !displayed}
              >
                <option value="">All teams</option>
                {selectedTeamMissing && <option value={selectedTeamId}>Unavailable team · {selectedTeamId}</option>}
                {displayed?.snapshot.teams.map((team) => (
                  <option key={team.team_id} value={team.team_id}>
                    {team.display_name || "Unnamed team"} · {team.team_id}
                  </option>
                ))}
              </select>
            </div>

            <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
              <legend className="field-label">Status</legend>
              <div className="status-options">
                {ALL_STATUSES.map((status) => (
                  <label className="status-check" key={status}>
                    <input
                      type="checkbox"
                      data-eval="status-option"
                      data-eval-key={status}
                      value={status}
                      checked={!!intent?.statuses.includes(status)}
                      onChange={() => toggleStatus(status)}
                      disabled={!intent}
                    />
                    <span>
                      <i className="dot" aria-hidden="true" style={{ background: STATUS_COLORS[status] }} />
                      {STATUS_LABELS[status]}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="field-label" htmlFor="created-from">Created from (UTC)</label>
              <input
                id="created-from"
                type="date"
                data-eval="created-from"
                value={intent?.created_from || ""}
                onChange={(event) => changeDate("created_from", event.target.value)}
                disabled={!intent}
              />
            </div>

            <div>
              <label className="field-label" htmlFor="created-to">Created before (UTC)</label>
              <input
                id="created-to"
                type="date"
                data-eval="created-to"
                value={intent?.created_to || ""}
                onChange={(event) => changeDate("created_to", event.target.value)}
                disabled={!intent}
              />
            </div>
          </div>

          {phase === "booting" && (
            <div className="notice loading" data-eval="view-state" role="status">
              Loading the local support snapshot…
            </div>
          )}

          {phase === "loading" && (
            <div className="notice loading" data-eval="view-state" role="status">
              {displayed
                ? hasPreviousDifferentScope
                  ? "Loading the requested scope. The table, metrics, and chart below still show the previous view."
                  : "Refreshing this view. The table, metrics, and chart below show the last confirmed snapshot."
                : "Loading the requested support view…"}
            </div>
          )}

          {phase === "error" && (
            <div className="notice error" data-eval="view-state" role="alert">
              <span>
                <strong>Couldn’t load the requested view.</strong> {loadError}
                {displayed
                  ? " The table, metrics, and chart below remain the last confirmed view."
                  : " No ticket data is currently displayed."}
              </span>
              {intent && (
                <button type="button" className="retry" data-eval="retry-load" onClick={retry}>
                  Retry
                </button>
              )}
            </div>
          )}

          {phase === "ready" && (
            <div className="notice ready" data-eval="view-state" role="status">
              Current snapshot loaded successfully.
            </div>
          )}

          {selectedTeamMissing && (
            <div className="notice warning">
              Team {selectedTeamId} is not present in the latest confirmed snapshot. Its selection is preserved so the intended scope remains explicit.
            </div>
          )}

          {displayed && (
            <div className="scope-line" data-eval="displayed-scope">
              <strong>{phase === "ready" ? "Displayed scope:" : "Last confirmed scope:"}</strong>{" "}
              {scopeSummary(displayed.scope, displayed.snapshot)} · revision {displayed.snapshot.snapshot_revision}
            </div>
          )}
          {intent && hasPreviousDifferentScope && (
            <div className="scope-line">
              <strong>Requested scope:</strong> {scopeSummary(intent, displayed!.snapshot)}
            </div>
          )}
        </section>

        <section className="metrics" aria-label="Business metrics">
          <article className="panel metric" data-eval="metric" data-eval-key="ticket_count" data-eval-unit="tickets">
            <div className="metric-label">Matching tickets</div>
            <div className="metric-value"><span>{metrics.ticketCount}</span><span className="metric-unit">tickets</span></div>
            <div className="metric-note">All records in displayed scope</div>
          </article>
          <article className="panel metric" data-eval="metric" data-eval-key="active_count" data-eval-unit="tickets">
            <div className="metric-label">Active tickets</div>
            <div className="metric-value"><span>{metrics.activeCount}</span><span className="metric-unit">tickets</span></div>
            <div className="metric-note">Open, in progress, or waiting</div>
          </article>
          <article className="panel metric" data-eval="metric" data-eval-key="overdue_active_count" data-eval-unit="tickets">
            <div className="metric-label">Overdue active</div>
            <div className="metric-value"><span>{metrics.overdueActiveCount}</span><span className="metric-unit">tickets</span></div>
            <div className="metric-note">Due strictly before snapshot time</div>
          </article>
          <article className="panel metric" data-eval="metric" data-eval-key="remaining_effort_hours" data-eval-unit="hours">
            <div className="metric-label">Remaining active effort</div>
            <div className="metric-value"><span>{formatHours(metrics.remainingMinutes)}</span><span className="metric-unit">hours</span></div>
            <div className="metric-note">Active workload only</div>
          </article>
        </section>

        <div className="content-grid">
          <section className="panel" aria-labelledby="tickets-heading">
            <div className="section-head">
              <h2 className="section-title" id="tickets-heading">Tickets</h2>
              <p className="section-copy">{filteredTickets.length} records in the displayed scope</p>
            </div>
            <div className="table-wrap" data-eval="tickets-table">
              {filteredTickets.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Ticket ID</th>
                      <th>Team identity</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th>Created at (UTC)</th>
                      <th>Due at (UTC)</th>
                      <th>Remaining effort</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTickets.map((ticket, ticketIndex) => {
                      const team = teamById.get(ticket.team_id);
                      return (
                        <tr key={`${ticket.ticket_id}:${ticketIndex}`} data-eval="ticket-row" data-eval-key={ticket.ticket_id}>
                          <td className="ticket-id" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="ticket_id">
                            {ticket.ticket_id}
                          </td>
                          <td>
                            <span className="team-name">{team?.display_name || "Unknown team"}</span>
                            <span className="identity" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="team_id">{ticket.team_id}</span>
                          </td>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="status">
                            <span className="pill">
                              <i className="dot" aria-hidden="true" style={{ background: STATUS_COLORS[ticket.status] }} />
                              {ticket.status}
                            </span>
                          </td>
                          <td><span className="pill">{ticket.priority}</span></td>
                          <td className="date-cell"><time dateTime={ticket.created_at}>{formatUtc(ticket.created_at)}</time></td>
                          <td className="date-cell" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="due_at" data-eval-unit="UTC">
                            <time dateTime={ticket.due_at}>{formatUtc(ticket.due_at)}</time>
                          </td>
                          <td className="effort" data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes">
                            {ticket.remaining_minutes} min
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : displayed ? (
                <div className="empty" data-eval="empty-state" role="status">
                  <div className="empty-icon" aria-hidden="true">0</div>
                  <strong>{phase === "ready" ? "No tickets match this scope" : "The last confirmed view has no matching tickets"}</strong>
                  <p>
                    {phase === "ready"
                      ? "The source loaded successfully; adjust a team, status, or UTC created-date bound."
                      : "This is prior confirmed data; the current request state is shown above."}
                  </p>
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-icon" aria-hidden="true">…</div>
                  <strong>No confirmed snapshot yet</strong>
                  <p>Ticket rows will appear after the local source loads.</p>
                </div>
              )}
            </div>
          </section>

          <section className="panel" data-eval="status-chart" aria-labelledby="chart-heading">
            <div className="section-head">
              <h2 className="section-title" id="chart-heading">Active tickets by status</h2>
              <p className="section-copy">Select a bar to filter the entire dashboard.</p>
            </div>
            <div className="chart-body">
              <div className="chart">
                {ACTIVE_STATUSES.map((status) => {
                  const count = metrics.statusCounts[status as Exclude<Status, "CLOSED">];
                  const height = `${(count / maxStatusCount) * 100}%`;
                  return (
                    <button
                      type="button"
                      className="chart-bar"
                      key={status}
                      data-eval="status-bar"
                      data-eval-key={status}
                      onClick={() => selectChartStatus(status as Exclude<Status, "CLOSED">)}
                      aria-label={`Filter to ${STATUS_LABELS[status]}: ${count} tickets`}
                      aria-pressed={!!intent && intent.statuses.length === 1 && intent.statuses[0] === status}
                      disabled={!intent}
                    >
                      <span className="status-count" data-eval="status-count" data-eval-key={status} data-eval-unit="tickets">
                        {count}
                      </span>
                      <span className="status-plot" data-eval="status-plot" data-eval-key={status} data-eval-axis="height">
                        <span
                          className="status-glyph"
                          data-eval="status-glyph"
                          data-eval-key={status}
                          style={{ height, background: STATUS_COLORS[status] }}
                        />
                      </span>
                      <span className="bar-label">{STATUS_LABELS[status]}</span>
                    </button>
                  );
                })}
              </div>
              <div className="chart-foot">Counts use the same displayed team, status, and UTC created-date scope as the metrics and table.</div>
              {displayed && <div className="asof">Snapshot as of <time dateTime={displayed.snapshot.as_of}>{formatUtc(displayed.snapshot.as_of)}</time></div>}
            </div>
          </section>
        </div>
      </main>
    </FrameRoot>
  );
}
