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

type LoadResult = { snapshot: Snapshot; scope: Scope };

const ALL_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING", "CLOSED"];
const ACTIVE_STATUSES: Status[] = ["OPEN", "IN_PROGRESS", "WAITING"];
const STATUS_LABEL: Record<Status, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting",
  CLOSED: "Closed",
};

const colors: Record<Status, string> = {
  OPEN: "#2563eb",
  IN_PROGRESS: "#7c3aed",
  WAITING: "#d97706",
  CLOSED: "#64748b",
};

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f5f7fb", color: "#172033", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  shell: { maxWidth: 1240, margin: "0 auto", padding: "30px 24px 52px" },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 },
  eyebrow: { margin: "0 0 7px", color: "#526178", fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase" },
  title: { margin: 0, fontSize: 30, lineHeight: 1.18, letterSpacing: "-0.035em", color: "#111827" },
  subtitle: { margin: "8px 0 0", color: "#65738a", fontSize: 14 },
  toolbar: { display: "flex", gap: 9, flexWrap: "wrap", justifyContent: "flex-end" },
  button: { border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff", color: "#24324a", padding: "9px 13px", fontSize: 13, fontWeight: 750, cursor: "pointer" },
  panel: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  filters: { display: "grid", gridTemplateColumns: "minmax(190px, 1.15fr) minmax(310px, 2fr) repeat(2, minmax(150px, 0.85fr))", gap: 16, padding: 18, marginBottom: 18, alignItems: "end" },
  label: { display: "block", color: "#526178", fontSize: 11, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 7 },
  input: { width: "100%", boxSizing: "border-box", minHeight: 40, border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", padding: "8px 10px", color: "#172033", fontSize: 14 },
  checkRow: { display: "flex", gap: 7, flexWrap: "wrap", minHeight: 40, alignItems: "center" },
  checkLabel: { display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #dbe3ee", background: "#f8fafc", borderRadius: 999, padding: "7px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  state: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "11px 14px", borderRadius: 10, marginBottom: 18, fontSize: 13, flexWrap: "wrap" },
  metrics: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14, marginBottom: 18 },
  metric: { padding: "17px 18px" },
  metricLabel: { margin: 0, color: "#65738a", fontSize: 12, fontWeight: 750 },
  metricValue: { margin: "8px 0 1px", fontSize: 28, fontWeight: 850, color: "#111827", letterSpacing: "-0.025em" },
  unit: { color: "#7a879a", fontSize: 11 },
  split: { display: "grid", gridTemplateColumns: "minmax(300px, 0.8fr) minmax(560px, 1.55fr)", gap: 18, alignItems: "start" },
  panelHead: { padding: "17px 19px 11px", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 },
  panelTitle: { margin: 0, fontSize: 16, color: "#172033" },
  panelHint: { color: "#7a879a", fontSize: 11 },
  chart: { padding: "5px 18px 22px" },
  barButton: { width: "100%", border: 0, background: "transparent", display: "grid", gridTemplateColumns: "94px 1fr 34px", alignItems: "center", gap: 10, padding: "10px 4px", borderRadius: 8, textAlign: "left", cursor: "pointer", color: "#24324a" },
  plot: { height: 14, borderRadius: 999, background: "#edf1f7", overflow: "hidden", position: "relative" },
  glyph: { height: "100%", borderRadius: 999, transition: "width 180ms ease" },
  tableWrap: { overflowX: "auto", paddingBottom: 5 },
  table: { width: "100%", minWidth: 770, borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "11px 13px", color: "#64748b", background: "#f8fafc", textAlign: "left", fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", borderTop: "1px solid #e7edf4", borderBottom: "1px solid #e7edf4" },
  td: { padding: "13px", borderBottom: "1px solid #edf1f5", verticalAlign: "middle", whiteSpace: "nowrap" },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "#334155" },
  empty: { padding: "48px 24px", textAlign: "center", color: "#64748b" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z"));
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (ALL_STATUSES as string[]).includes(value);
}

function validateScope(value: unknown): value is Scope {
  if (!isObject(value) || !Array.isArray(value.team_ids) || !Array.isArray(value.statuses)) return false;
  return value.team_ids.every((v) => typeof v === "string" && v.length > 0) &&
    value.statuses.every(isStatus) && new Set(value.team_ids).size === value.team_ids.length &&
    new Set(value.statuses).size === value.statuses.length && isDate(value.created_from) && isDate(value.created_to);
}

function validateSnapshot(value: unknown): value is Snapshot {
  if (!isObject(value) || value.schema_version !== "support-snapshot-1" || typeof value.snapshot_revision !== "string" || !value.snapshot_revision ||
      !isDateTime(value.as_of) || !isDate(value.default_created_from) || !isDate(value.default_created_to) ||
      !Array.isArray(value.teams) || !Array.isArray(value.tickets)) return false;
  const teamsOkay = value.teams.every((team) => isObject(team) && typeof team.team_id === "string" && team.team_id.length > 0 && typeof team.display_name === "string");
  const ticketsOkay = value.tickets.every((ticket) => isObject(ticket) && typeof ticket.ticket_id === "string" && ticket.ticket_id.length > 0 &&
    typeof ticket.team_id === "string" && ticket.team_id.length > 0 && isStatus(ticket.status) &&
    (ticket.priority === "P1" || ticket.priority === "P2" || ticket.priority === "P3") &&
    isDateTime(ticket.created_at) && isDateTime(ticket.due_at) && typeof ticket.remaining_minutes === "number" &&
    Number.isInteger(ticket.remaining_minutes) && ticket.remaining_minutes >= 0);
  return teamsOkay && ticketsOkay;
}

function validateLoadResult(value: unknown): value is LoadResult {
  return isObject(value) && validateSnapshot(value.snapshot) && validateScope(value.scope);
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.created_from === b.created_from && a.created_to === b.created_to &&
    a.team_ids.length === b.team_ids.length && a.team_ids.every((v, i) => v === b.team_ids[i]) &&
    a.statuses.length === b.statuses.length && a.statuses.every((v, i) => v === b.statuses[i]);
}

function scopeLabel(scope: Scope): string {
  const teams = scope.team_ids.length ? scope.team_ids.join(", ") : "all teams";
  const statuses = scope.statuses.length ? scope.statuses.join(", ") : "no statuses";
  return `${teams} · ${statuses} · ${scope.created_from} ≤ created < ${scope.created_to} UTC`;
}

function formatHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 10000) / 10000);
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The controlled source could not be read.";
}

export default function SupportOperationsFrame() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [intent, setIntent] = useState<Scope | null>(null);
  const [displayedScope, setDisplayedScope] = useState<Scope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const initialized = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadScope = useCallback(async (scope: Scope, reason: "filter" | "refresh" | "retry" | "reset") => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    if (reason !== "reset") setNotice(null);
    try {
      const raw = await callFunction("load-data", scope);
      if (!mounted.current || id !== requestId.current) return;
      if (!validateLoadResult(raw)) throw new Error("The source returned data in an unsupported format.");
      if (!sameScope(raw.scope, scope)) throw new Error("The source response did not match the requested scope.");
      setSnapshot(raw.snapshot);
      setDisplayedScope(raw.scope);
      setLoading(false);
      setError(null);
      if (reason === "refresh") setNotice(`Source refreshed to revision ${raw.snapshot.snapshot_revision}.`);
      if (reason === "retry") setNotice(`Retry succeeded on revision ${raw.snapshot.snapshot_revision}.`);
      if (reason === "reset") setNotice("Filters reset to the current source defaults.");
    } catch (caught) {
      if (!mounted.current || id !== requestId.current) return;
      setLoading(false);
      setError(messageFromError(caught));
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const id = ++requestId.current;
    (async () => {
      try {
        const metadata = await readFile("./dataset.json");
        if (!metadata) throw new Error("The source file is unavailable.");
        const raw: unknown = JSON.parse(await metadata.file.text());
        if (!validateSnapshot(raw)) throw new Error("The source file has an unsupported format.");
        if (!mounted.current || id !== requestId.current) return;
        const initial: Scope = {
          team_ids: [],
          statuses: [...ALL_STATUSES],
          created_from: raw.default_created_from,
          created_to: raw.default_created_to,
        };
        setSnapshot(raw);
        setIntent(initial);
        setDisplayedScope(initial);
        setLoading(false);
      } catch (caught) {
        if (!mounted.current || id !== requestId.current) return;
        setLoading(false);
        setError(messageFromError(caught));
      }
    })();
  }, []);

  const applyIntent = useCallback((next: Scope) => {
    setIntent(next);
    void loadScope(next, "filter");
  }, [loadScope]);

  const filteredTickets = useMemo(() => {
    if (!snapshot || !displayedScope) return [] as Ticket[];
    const start = Date.parse(displayedScope.created_from + "T00:00:00Z");
    const end = Date.parse(displayedScope.created_to + "T00:00:00Z");
    return snapshot.tickets.filter((ticket) => {
      const created = Date.parse(ticket.created_at);
      const teamMatch = displayedScope.team_ids.length === 0 || displayedScope.team_ids.includes(ticket.team_id);
      return teamMatch && displayedScope.statuses.includes(ticket.status) && created >= start && created < end;
    });
  }, [snapshot, displayedScope]);

  const metrics = useMemo(() => {
    const asOf = snapshot ? Date.parse(snapshot.as_of) : 0;
    const active = filteredTickets.filter((ticket) => ACTIVE_STATUSES.includes(ticket.status));
    return {
      tickets: filteredTickets.length,
      active: active.length,
      overdue: active.filter((ticket) => Date.parse(ticket.due_at) < asOf).length,
      minutes: active.reduce((sum, ticket) => sum + ticket.remaining_minutes, 0),
    };
  }, [snapshot, filteredTickets]);

  const chartCounts = useMemo(() => {
    const counts: Record<"OPEN" | "IN_PROGRESS" | "WAITING", number> = { OPEN: 0, IN_PROGRESS: 0, WAITING: 0 };
    filteredTickets.forEach((ticket) => {
      if (ticket.status !== "CLOSED") counts[ticket.status] += 1;
    });
    return counts;
  }, [filteredTickets]);

  const teamNames = useMemo(() => {
    const names = new Map<string, string>();
    snapshot?.teams.forEach((team) => names.set(team.team_id, team.display_name));
    return names;
  }, [snapshot]);

  const showingPrior = Boolean(snapshot && displayedScope && intent && (loading || error || !sameScope(displayedScope, intent)));
  const maxCount = Math.max(1, ...ACTIVE_STATUSES.map((status) => chartCounts[status]));

  const refresh = () => {
    if (intent) void loadScope(intent, "refresh");
  };

  const retry = () => {
    if (intent) void loadScope(intent, "retry");
    else window.location.reload();
  };

  const reset = () => {
    if (!snapshot) return;
    const next: Scope = {
      team_ids: [],
      statuses: [...ALL_STATUSES],
      created_from: snapshot.default_created_from,
      created_to: snapshot.default_created_to,
    };
    setIntent(next);
    void loadScope(next, "reset");
  };

  const updateDate = (field: "created_from" | "created_to", value: string) => {
    if (!intent) return;
    const next = { ...intent, [field]: value };
    setIntent(next);
    if (isDate(value) && isDate(next.created_from) && isDate(next.created_to)) void loadScope(next, "filter");
  };

  return (
    <FrameRoot style={styles.page}>
      <main data-eval="dashboard-root" style={styles.shell}>
        <header style={styles.header}>
          <div>
            <p style={styles.eyebrow}>Support operations</p>
            <h1 style={styles.title}>Ticket command center</h1>
            <p style={styles.subtitle}>
              {snapshot ? <>Source as of <time dateTime={snapshot.as_of}>{snapshot.as_of}</time> · revision <strong>{snapshot.snapshot_revision}</strong></> : "Loading the controlled source…"}
            </p>
          </div>
          <div style={styles.toolbar}>
            <button type="button" data-eval="reset-filters" style={styles.button} disabled={!intent || loading} onClick={reset}>Reset</button>
            <button type="button" data-eval="refresh-data" style={{ ...styles.button, background: "#172033", color: "white", borderColor: "#172033" }} disabled={!intent || loading} onClick={refresh}>Refresh data</button>
          </div>
        </header>

        {intent && snapshot && (
          <section aria-label="Ticket filters" style={{ ...styles.panel, ...styles.filters }}>
            <div>
              <label htmlFor="team-filter" style={styles.label}>Team</label>
              <select id="team-filter" data-eval="team-filter" style={styles.input} value={intent.team_ids[0] || ""} onChange={(event) => applyIntent({ ...intent, team_ids: event.target.value ? [event.target.value] : [] })}>
                <option value="">All teams</option>
                {snapshot.teams.map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name} · {team.team_id}</option>)}
              </select>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={styles.label}>Status</legend>
              <div style={styles.checkRow}>
                {ALL_STATUSES.map((status) => {
                  const checked = intent.statuses.includes(status);
                  return (
                    <label key={status} style={{ ...styles.checkLabel, borderColor: checked ? colors[status] : "#dbe3ee", background: checked ? `${colors[status]}12` : "#f8fafc" }}>
                      <input type="checkbox" data-eval="status-option" data-eval-key={status} checked={checked} onChange={() => {
                        const statuses = checked ? intent.statuses.filter((value) => value !== status) : ALL_STATUSES.filter((value) => value === status || intent.statuses.includes(value));
                        applyIntent({ ...intent, statuses });
                      }} />
                      {STATUS_LABEL[status]}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div>
              <label htmlFor="created-from" style={styles.label}>Created from (UTC)</label>
              <input id="created-from" type="date" data-eval="created-from" style={styles.input} value={intent.created_from} onChange={(event) => updateDate("created_from", event.target.value)} />
            </div>
            <div>
              <label htmlFor="created-to" style={styles.label}>Created before (UTC)</label>
              <input id="created-to" type="date" data-eval="created-to" style={styles.input} value={intent.created_to} onChange={(event) => updateDate("created_to", event.target.value)} />
            </div>
          </section>
        )}

        <section data-eval="view-state" role={error ? "alert" : "status"} aria-live="polite" style={{ ...styles.state, background: error ? "#fff1f2" : loading ? "#eef6ff" : "#eefbf4", border: `1px solid ${error ? "#fecdd3" : loading ? "#bfdbfe" : "#bbf7d0"}`, color: error ? "#9f1239" : loading ? "#1e40af" : "#166534" }}>
          <div>
            <strong>{error ? "Source error" : loading ? "Loading requested scope" : filteredTickets.length === 0 && snapshot ? "Loaded successfully · no matches" : "Current view loaded"}</strong>
            <span>{error ? ` — ${error}` : notice ? ` — ${notice}` : showingPrior ? " — prior results remain visible while the requested scope loads" : ""}</span>
          </div>
          {error && <button type="button" data-eval="retry-load" style={styles.button} onClick={retry}>Retry current scope</button>}
        </section>

        {snapshot && displayedScope && (
          <>
            <div data-eval="displayed-scope" style={{ color: showingPrior || error ? "#9f1239" : "#64748b", fontSize: 12, margin: "-8px 2px 14px" }}>
              <strong>{showingPrior || error ? "Prior displayed results" : "Displayed results"}</strong> · revision {snapshot.snapshot_revision} · {scopeLabel(displayedScope)}
              {(showingPrior || error) && intent && <div style={{ marginTop: 4 }}><strong>Requested scope</strong> · {scopeLabel(intent)}</div>}
            </div>

            <section aria-label="Business metrics" style={styles.metrics}>
              {[
                ["ticket_count", "Tickets", metrics.tickets, "tickets"],
                ["active_count", "Active", metrics.active, "tickets"],
                ["overdue_active_count", "Overdue active", metrics.overdue, "tickets"],
                ["remaining_effort_hours", "Remaining effort", formatHours(metrics.minutes), "hours"],
              ].map(([key, label, value, unit]) => (
                <article key={key} data-eval="metric" data-eval-key={key} data-eval-unit={unit} style={{ ...styles.panel, ...styles.metric }}>
                  <p style={styles.metricLabel}>{label}</p>
                  <p style={styles.metricValue}>{value}</p>
                  <span style={styles.unit}>{unit}</span>
                </article>
              ))}
            </section>

            <div style={styles.split}>
              <section data-eval="status-chart" aria-label="Active tickets by status" style={styles.panel}>
                <div style={styles.panelHead}>
                  <h2 style={styles.panelTitle}>Active status mix</h2>
                  <span style={styles.panelHint}>Select a bar to focus</span>
                </div>
                <div style={styles.chart}>
                  {ACTIVE_STATUSES.map((status) => {
                    const count = chartCounts[status];
                    const selected = intent?.statuses.length === 1 && intent.statuses[0] === status;
                    return (
                      <button key={status} type="button" data-eval="status-bar" data-eval-key={status} aria-label={`Show only ${STATUS_LABEL[status]} tickets: ${count}`} aria-pressed={selected} style={{ ...styles.barButton, background: selected ? `${colors[status]}10` : "transparent" }} onClick={() => intent && applyIntent({ ...intent, statuses: [status] })}>
                        <span style={{ fontSize: 12, fontWeight: 760 }}>{STATUS_LABEL[status]}</span>
                        <span data-eval="status-plot" data-eval-key={status} data-eval-axis="width" style={styles.plot}>
                          <span data-eval="status-glyph" data-eval-key={status} style={{ ...styles.glyph, display: "block", width: `${(count / maxCount) * 100}%`, background: colors[status] }} />
                        </span>
                        <strong data-eval="status-count" data-eval-key={status} data-eval-unit="tickets" style={{ textAlign: "right" }}>{count}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section style={styles.panel}>
                <div style={styles.panelHead}>
                  <h2 style={styles.panelTitle}>Tickets</h2>
                  <span style={styles.panelHint}>{filteredTickets.length} matching</span>
                </div>
                <div style={styles.tableWrap}>
                  <table data-eval="tickets-table" style={styles.table}>
                    <thead><tr>
                      <th style={styles.th}>Ticket ID</th><th style={styles.th}>Team identity</th><th style={styles.th}>Status</th><th style={styles.th}>Priority</th><th style={styles.th}>Created (UTC)</th><th style={styles.th}>Due (UTC)</th><th style={{ ...styles.th, textAlign: "right" }}>Remaining</th>
                    </tr></thead>
                    <tbody>
                      {filteredTickets.map((ticket) => (
                        <tr key={ticket.ticket_id} data-eval="ticket-row" data-eval-key={ticket.ticket_id}>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="ticket_id" style={{ ...styles.td, ...styles.code, fontWeight: 750 }}>{ticket.ticket_id}</td>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="team_id" style={styles.td}>
                            <div style={{ fontWeight: 720 }}>{teamNames.get(ticket.team_id) || "Unknown team"}</div><div style={styles.code}>{ticket.team_id}</div>
                          </td>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="status" style={styles.td}><span style={{ color: colors[ticket.status], fontWeight: 800 }}>{ticket.status}</span></td>
                          <td style={styles.td}>{ticket.priority}</td>
                          <td style={{ ...styles.td, ...styles.code }}><time dateTime={ticket.created_at}>{ticket.created_at}</time></td>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="due_at" style={{ ...styles.td, ...styles.code }}><time dateTime={ticket.due_at}>{ticket.due_at}</time></td>
                          <td data-eval="ticket-cell" data-eval-key={ticket.ticket_id} data-eval-field="remaining_minutes" data-eval-unit="minutes" style={{ ...styles.td, textAlign: "right", fontWeight: 750 }}>{ticket.remaining_minutes} min</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredTickets.length === 0 && !loading && !error && <div data-eval="empty-state" style={styles.empty}><strong>No tickets match this scope.</strong><div style={{ marginTop: 7, fontSize: 12 }}>The source loaded successfully. Change a filter or reset to see other tickets.</div></div>}
                </div>
              </section>
            </div>
          </>
        )}

        {!snapshot && !loading && error && <div style={{ ...styles.panel, ...styles.empty }}>No prior source snapshot is available. Retry to load the current controlled source.</div>}
      </main>
    </FrameRoot>
  );
}
