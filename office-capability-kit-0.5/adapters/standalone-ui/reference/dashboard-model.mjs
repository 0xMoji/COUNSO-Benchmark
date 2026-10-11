const clone = x => structuredClone(x);
export const statuses = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
export const activeStatuses = statuses.slice(0, 3);
export const defaultScope = s => ({ team_ids: [], statuses: [...statuses], created_from: s.default_created_from, created_to: s.default_created_to });
export function summarize(rows, asOf) {
  const active = rows.filter(r => activeStatuses.includes(r.status));
  return { ticket_count: rows.length, active_count: active.length,
    overdue_active_count: active.filter(r => Date.parse(r.due_at) < Date.parse(asOf)).length,
    remaining_effort_hours: active.reduce((n, r) => n + r.remaining_minutes, 0) / 60,
    chart: Object.fromEntries(activeStatuses.map(s => [s, active.filter(r => r.status === s).length])) };
}
export class DashboardModel {
  constructor(api, onChange = () => {}, mutation = null) { this.api = api; this.onChange = onChange; this.mutation = mutation; this.epoch = 0; this.state = { source: null, intent: null, view: null, phase: 'loading', error: null }; }
  notify() { this.onChange(this.state); }
  async init() { const source = await this.api('dashboard_source'); if (!source.ok) { this.state.phase = 'error'; this.state.error = source.code; this.notify(); return; } this.state.source = source.snapshot; this.state.intent = defaultScope(source.snapshot); await this.load(); }
  setIntent(change) { this.state.intent = { ...this.state.intent, ...clone(change) }; return this.load(); }
  refresh() { return this.load(); }
  retry() { return this.load(); }
  reset() { this.state.intent = defaultScope(this.state.source); return this.load(); }
  async load() {
    const epoch = ++this.epoch, intent = clone(this.state.intent);
    this.state.phase = 'loading'; this.state.error = null; this.notify();
    const result = await this.api('dashboard_load', intent);
    if (epoch !== this.epoch && this.mutation !== 'old-response') return;
    if (!result.ok) { this.state.phase = 'error'; this.state.error = result.code; this.notify(); return; }
    this.state.source = result.snapshot;
    // Deliberate negative control: table remains scoped while aggregates use the full source.
    const metricRows = this.mutation === 'wrong-scope' ? result.snapshot.tickets : result.rows;
    this.state.view = { rows: result.rows, scope: result.scope, revision: result.snapshot.snapshot_revision,
      summary: summarize(metricRows, result.snapshot.as_of), request_id: result.request_id };
    this.state.phase = 'ready'; this.state.error = null; this.notify();
  }
}
