import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SyntheticAuthority } from '../../adapters/standalone-ui/mock-service.mjs';
import { DashboardModel } from '../../adapters/standalone-ui/reference/dashboard-model.mjs';
import { PlannerModel, validate } from '../../adapters/standalone-ui/reference/planner-model.mjs';
import { dashboardFacts, plannerPreview, numericFact, geometryFact } from '../../adapters/standalone-ui/oracle.mjs';
import { distinct } from '../../adapters/standalone-ui/dashboard-probes.mjs';

const root = new URL('../../', import.meta.url);
const json = async p => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const fixtureSets = await Promise.all(['public', 'evaluator'].map(async name => ({
 name,
 dashboard: await json(`tasks/ui/ui-dashboard/${name}/source.json`),
 resources: await json(`tasks/ui/ui-planner/${name}/resources.json`),
 draft: await json(`tasks/ui/ui-planner/${name}/draft.json`),
})));
const fixture = fixtureSets[0];
const make = (mutation = null, selected = fixture) => new SyntheticAuthority({ ...selected, mutation });
const tick = () => new Promise(resolve => setImmediate(resolve));
const statuses = ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'];
const defaultScope = source => ({ team_ids: [], statuses: [...statuses], created_from: source.default_created_from, created_to: source.default_created_to });
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const unique = (values, label) => assert.equal(new Set(values).size, values.length, label);
const datePlus = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function editDistance(a, b) {
 const row = Array.from({ length: b.length + 1 }, (_, i) => i);
 for (let i = 1; i <= a.length; i++) { let prior = row[0]; row[0] = i;
  for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prior + (a[i - 1] === b[j - 1] ? 0 : 1)); prior = old; }
 }
 return row.at(-1);
}
const hasSimilarNames = rows => rows.some((a, i) => rows.slice(i + 1).some(b => editDistance(a.display_name.toLowerCase(), b.display_name.toLowerCase()) <= 2));
function distinctScope(source) {
 const { team, status, date } = distinct(source);
 return { ...defaultScope(source), team_ids: [team], statuses: [status], created_from: date };
}
// Source-derived witness selection is independent of the application validator.
function eligibleSlots(source, draft) {
 const slots = [];
 for (const work of source.work_items) for (const resource of source.resources) for (const day of source.roster) {
  if (day.resource_id !== resource.resource_id || resource.team_id !== work.team_id || !resource.skills.includes(work.required_skill) || day.date < work.earliest_date || day.date > work.due_date) continue;
  const usedDay = sum(draft.allocations.filter(a => a.resource_id === resource.resource_id && a.date === day.date), 'minutes');
  const usedWork = sum(draft.allocations.filter(a => a.work_item_id === work.work_item_id), 'minutes');
  slots.push({ work, resource, day, usedDay, usedWork, freeDay: day.available_minutes - day.committed_minutes - usedDay, freeWork: work.remaining_minutes - usedWork });
 }
 return slots;
}
const lineFor = (slot, minutes = 30) => ({ work_item_id: slot.work.work_item_id, resource_id: slot.resource.resource_id, date: slot.day.date, minutes });
function validLine(selected) {
 const slot = eligibleSlots(selected.resources, selected.draft).find(s => s.freeDay >= 45 && s.freeWork >= 45);
 assert.ok(slot, 'Fixture must support Add 30 followed by valid correction to 45');
 return lineFor(slot);
}
const newLine = validLine(fixture);
const authoredBaselines = {
 public: { metrics: { ticket_count: 16, active_count: 13, overdue_active_count: 8, remaining_effort_hours: 23.25 }, chart: { OPEN: 5, IN_PROGRESS: 3, WAITING: 5 } },
 evaluator: { metrics: { ticket_count: 13, active_count: 10, overdue_active_count: 6, remaining_effort_hours: 20.25 }, chart: { OPEN: 4, IN_PROGRESS: 3, WAITING: 3 } },
};

for (const selected of fixtureSets) {
 const label = `[${selected.name}]`;
 const source = selected.dashboard, scope = distinctScope(source), expected = dashboardFacts(source, scope);
 const addition = validLine(selected), originalCount = selected.draft.allocations.length;

 test(`${label} actual dashboard probe selector has nonempty changed-date and updated-source preconditions`, () => {
  const chosen = distinct(source);
  assert.deepEqual(scope, { ...defaultScope(source), team_ids: [chosen.team], statuses: [chosen.status], created_from: chosen.date });
  assert.notEqual(chosen.date, source.default_created_from, 'Selected date differs from the default');
  assert.ok(chosen.date >= source.default_created_from && chosen.date < source.default_created_to, 'Selected date precedes the exclusive upper bound');
  const before = dashboardFacts(source, { ...scope, created_from: source.default_created_from });
  assert.ok(expected.rows.length > 0, 'The actual probe-selected scope is nonempty');
  assert.notDeepEqual(before.rows.map(row => row.ticket_id), expected.rows.map(row => row.ticket_id), 'The actual selected date changes returned records');
  assert.ok(before.metrics.ticket_count > expected.metrics.ticket_count, 'The changed date removes records from the same team/status scope');
  const updated = structuredClone(source);
  updated.snapshot_revision += '-offline-precondition';
  const row = dashboardFacts(updated, scope).rows[0];
  assert.ok(row, 'The updated-source probe can access rows[0]');
  const corresponding = updated.tickets.find(ticket => ticket.ticket_id === row.ticket_id);
  assert.ok(corresponding, 'The selected record exists in the updated source');
  const originalMinutes = corresponding.remaining_minutes;
  corresponding.remaining_minutes += 15;
  assert.equal(dashboardFacts(updated, scope).rows[0].remaining_minutes, originalMinutes + 15, 'The corresponding source row can be changed');
  assert.equal(dashboardFacts(source, scope).rows[0].remaining_minutes, originalMinutes, 'The authored fixture remains unchanged');
 });

 test(`${label} actual dashboard probe selector throws explicit fixture insufficiency without a qualifying in-range group`, () => {
  const template = source.tickets[0];
  const oneDateOnly = {
   ...source,
   tickets: [datePlus(source.default_created_from, -1), source.default_created_from, source.default_created_to].map((date, index) => ({
    ...template, ticket_id: `${template.ticket_id}-selector-boundary-${index}`, created_at: `${date}T00:00:00Z`,
   })),
  };
  const insufficiency = { name: 'Error', message: 'Fixture cannot support distinct date-effect probe within default created-date bounds' };
  for (const insufficient of [{ ...source, tickets: [] }, oneDateOnly]) {
   assert.throws(() => distinct(insufficient), insufficiency);
   assert.throws(() => distinctScope(insufficient), insufficiency);
  }
 });

 test(`${label} independently authored dashboard input properties and exact baseline arithmetic`, () => {
  assert.equal(source.schema_version, 'support-snapshot-1');
  unique(source.teams.map(t => t.team_id), 'Distinct team identities');
  unique(source.tickets.map(t => t.ticket_id), 'Distinct ticket identities');
  assert.ok(source.teams.length >= 3 && hasSimilarNames(source.teams));
  const teams = new Set(source.teams.map(t => t.team_id));
  const asOf = Date.parse(source.as_of), start = Date.parse(`${source.default_created_from}T00:00:00Z`), end = Date.parse(`${source.default_created_to}T00:00:00Z`);
  assert.ok(Number.isFinite(asOf) && start < end);
  for (const row of source.tickets) {
   assert.ok(teams.has(row.team_id) && statuses.includes(row.status) && ['P1', 'P2', 'P3'].includes(row.priority));
   assert.ok(Number.isInteger(row.remaining_minutes) && row.remaining_minutes >= 0);
   assert.ok(Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.due_at)));
   assert.ok(Date.parse(row.created_at) <= asOf, 'Snapshots contain no future-created ticket');
   assert.ok(Date.parse(row.created_at) <= Date.parse(row.due_at), 'Due times follow creation');
  }
  const active = source.tickets.filter(row => row.status !== 'CLOSED');
  for (const offset of [-1000, 0, 1000]) assert.ok(active.some(row => Date.parse(row.due_at) === asOf + offset), `Active due-time boundary ${offset}ms`);
  assert.ok(active.some(row => row.remaining_minutes === 0));
  assert.ok(source.tickets.some(row => row.status === 'CLOSED' && row.remaining_minutes === 0));
  const baseline = dashboardFacts(source, defaultScope(source));
  assert.deepEqual(baseline.metrics, authoredBaselines[selected.name].metrics);
  assert.deepEqual(baseline.chart, authoredBaselines[selected.name].chart);
  const lower = source.tickets.find(row => Date.parse(row.created_at) === start), upper = source.tickets.find(row => Date.parse(row.created_at) === end);
  assert.ok(lower && upper && source.tickets.some(row => Date.parse(row.created_at) < start));
  assert.ok(baseline.rows.some(row => row.ticket_id === lower.ticket_id));
  assert.ok(!baseline.rows.some(row => row.ticket_id === upper.ticket_id));
  const before = dashboardFacts(source, { ...scope, created_from: source.default_created_from });
  assert.notDeepEqual(before.rows.map(r => r.ticket_id), expected.rows.map(r => r.ticket_id));
  assert.ok(expected.rows.length > 0 && expected.metrics.remaining_effort_hours > 0);
  const single = dashboardFacts(source, { ...defaultScope(source), statuses: ['WAITING'] });
  assert.equal(single.chart.OPEN, 0); assert.equal(single.chart.IN_PROGRESS, 0); assert.ok(single.chart.WAITING > 0);
  assert.deepEqual(dashboardFacts(source, { ...defaultScope(source), statuses: [] }).metrics, { ticket_count: 0, active_count: 0, overdue_active_count: 0, remaining_effort_hours: 0 });
 });

 test(`${label} dashboard actual changed date, selection retained after update and empty view`, async () => {
  const host = make(null, selected), m = new DashboardModel((...args) => host.request(...args)); await m.init();
  const original = m.state.intent.created_from;
  await m.setIntent(scope);
  assert.notEqual(m.state.intent.created_from, original);
  assert.deepEqual(m.state.view.rows.map(row => row.ticket_id), expected.rows.map(row => row.ticket_id));
  assert.deepEqual(m.state.view.summary, { ...expected.metrics, chart: expected.chart });
  const updated = structuredClone(source); updated.snapshot_revision += '-offline-update';
  updated.tickets.find(row => row.ticket_id === expected.rows[0].ticket_id).remaining_minutes += 15;
  host.updateDashboard(updated); const intent = structuredClone(m.state.intent); await m.refresh();
  assert.deepEqual(m.state.intent, intent);
  assert.equal(m.state.view.summary.remaining_effort_hours, expected.metrics.remaining_effort_hours + 0.25);
  const emptyStart = datePlus(source.default_created_to, 1000);
  await m.setIntent({ created_from: emptyStart, created_to: datePlus(emptyStart, 1) });
  assert.equal(m.state.view.rows.length, 0); assert.equal(m.state.phase, 'ready');
  assert.deepEqual(m.state.view.summary, { ticket_count: 0, active_count: 0, overdue_active_count: 0, remaining_effort_hours: 0, chart: { OPEN: 0, IN_PROGRESS: 0, WAITING: 0 } });
 });

 test(`${label} dashboard wrong-scope negative control fails independent exact arithmetic`, async () => {
  const host = make(null, selected), m = new DashboardModel((...args) => host.request(...args), () => {}, 'wrong-scope'); await m.init(); await m.setIntent(scope);
  assert.deepEqual(m.state.view.rows.map(row => row.ticket_id), expected.rows.map(row => row.ticket_id));
  assert.notEqual(m.state.view.summary.ticket_count, expected.metrics.ticket_count);
  assert.notEqual(m.state.view.summary.remaining_effort_hours, expected.metrics.remaining_effort_hours);
 });

 test(`${label} dashboard late old response and old error cannot replace newer intent`, async () => {
  for (const failure of [null, 'temporary_failure']) {
   const host = make(null, selected), m = new DashboardModel((...args) => host.request(...args)); await m.init(); host.hold('dashboard_load');
   const a = m.setIntent({ team_ids: [source.teams[0].team_id] }), b = m.setIntent({ team_ids: [source.teams[1].team_id] });
   await tick(); const [old, newer] = host.pendingFor('dashboard_load'); host.release(newer.request_id); await b;
   const view = structuredClone(m.state.view); host.release(old.request_id, failure); await a;
   assert.deepEqual(m.state.view, view); assert.equal(m.state.phase, 'ready');
  }
 });

 test(`${label} dashboard retry loads current intent after controlled read failure`, async () => {
  const host = make(null, selected), m = new DashboardModel((...args) => host.request(...args)); await m.init();
  const team = source.teams[1].team_id; host.failNext('dashboard_load'); await m.setIntent({ team_ids: [team] });
  assert.equal(m.state.phase, 'error'); assert.deepEqual(m.state.view.scope.team_ids, []); await m.retry();
  assert.equal(m.state.phase, 'ready'); assert.deepEqual(m.state.view.scope.team_ids, [team]);
 });

 // Offline success validates engineering controls only, never browser/business functional PASS.
 test(`${label} independently authored planner integrity and constraint witnesses`, () => {
  const plan = selected.resources, draft = selected.draft, host = make(null, selected);
  assert.equal(plan.schema_version, 'resource-plan-1');
  unique(plan.teams.map(row => row.team_id), 'Team identities'); unique(plan.resources.map(row => row.resource_id), 'Resource identities');
  unique(plan.work_items.map(row => row.work_item_id), 'Work identities'); unique(draft.allocations.map(row => row.allocation_id), 'Existing allocation identities');
  unique(plan.roster.map(row => `${row.resource_id}|${row.date}`), 'Resource/date roster identities');
  assert.ok(plan.teams.length >= 3 && hasSimilarNames(plan.teams) && hasSimilarNames(plan.resources));
  const teamIds = new Set(plan.teams.map(row => row.team_id)), resourceIds = new Set(plan.resources.map(row => row.resource_id));
  for (const resource of plan.resources) { assert.ok(teamIds.has(resource.team_id)); assert.ok(resource.skills.length > 0); unique(resource.skills, 'Resource skills'); }
  const dates = [...new Set(plan.roster.map(row => row.date))];
  assert.ok(dates.length >= 3 && dates.includes(plan.default_date));
  for (const day of plan.roster) {
   assert.ok(resourceIds.has(day.resource_id)); assert.equal(datePlus(day.date, 0), day.date);
   assert.ok(Number.isInteger(day.available_minutes) && day.available_minutes >= 0 && day.available_minutes % 15 === 0);
   assert.ok(Number.isInteger(day.committed_minutes) && day.committed_minutes >= 0 && day.committed_minutes % 15 === 0 && day.committed_minutes <= day.available_minutes);
  }
  for (const work of plan.work_items) {
   assert.ok(teamIds.has(work.team_id)); assert.equal(datePlus(work.earliest_date, 0), work.earliest_date); assert.equal(datePlus(work.due_date, 0), work.due_date);
   assert.ok(work.earliest_date <= work.due_date && Number.isInteger(work.remaining_minutes) && work.remaining_minutes >= 0 && work.remaining_minutes % 15 === 0);
  }
  assert.ok(plan.roster.some(row => row.available_minutes === 0 && row.committed_minutes === 0));
  assert.ok(plan.roster.some(row => row.available_minutes > 0 && row.available_minutes === row.committed_minutes));
  assert.ok(plan.roster.some(row => row.available_minutes > 0 && row.committed_minutes === 0));
  assert.ok(plan.work_items.some(row => row.remaining_minutes === 0));
  assert.ok(plan.work_items.some(work => !plan.resources.some(resource => resource.team_id === work.team_id && resource.skills.includes(work.required_skill))));
  assert.equal(host.validDraft(draft), true); assert.deepEqual(validate(plan, draft), []);
  const slots = eligibleSlots(plan, draft);
  assert.ok(slots.some(slot => slot.usedDay > 0 && slot.freeDay >= 30 && slot.freeWork >= slot.freeDay + 15), 'Independent cumulative-capacity witness including an existing line');
  assert.ok(slots.some(slot => slot.usedWork > 0 && slot.freeWork >= 45 && slot.freeDay >= slot.freeWork + 15), 'Independent cumulative-work witness with capacity still available');
  assert.ok(slots.some(slot => slot.day.date === slot.work.earliest_date && slot.freeDay >= 15 && slot.freeWork >= 15));
  assert.ok(slots.some(slot => slot.day.date === slot.work.due_date && slot.freeDay >= 15 && slot.freeWork >= 15));
  const preview = plannerPreview(plan, draft);
  for (const row of preview.capacity) { const day = plan.roster.find(d => d.resource_id === row.resource_id && d.date === row.date); assert.equal(row.remaining_minutes, day.available_minutes - day.committed_minutes - row.tentative_minutes); }
  for (const row of preview.work) assert.equal(row.remaining_minutes, row.source_remaining_minutes - row.tentative_minutes);
 });

 test(`${label} planner Add -> preview -> explicit Save, invalid correction and removal`, async () => {
  const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init();
  const original = structuredClone(host.draft);
  for (const minutes of [0, -15, 17, 22.5, NaN, Infinity, '30']) assert.equal(m.add({ ...addition, minutes }), false);
  assert.deepEqual(host.draft, original); assert.equal(host.ledger.filter(e => e.tool === 'draft_save').length, 0);
  assert.equal(m.add(addition), true); assert.equal(m.state.local.allocations.length, originalCount + 1); assert.equal(m.state.dirty, true);
  const id = m.state.local.allocations.at(-1).allocation_id; m.edit(id, { minutes: 17 }); assert.equal(await m.save(), false);
  m.edit(id, { minutes: 45 }); assert.equal(m.state.errors.length, 0); assert.equal(await m.save(), true);
  assert.deepEqual(host.draft, m.state.local); assert.equal(host.ledger.filter(e => e.phase === 'commit').length, 1);
  m.remove(id); assert.equal(m.state.local.allocations.length, originalCount); assert.equal(m.state.dirty, true);
 });

 test(`${label} planner conflict Review nonmutating, explicit Reapply/Save or Discard`, async () => {
  for (const decision of ['reapply', 'discard']) {
   const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init(); m.add(addition);
   const local = structuredClone(m.state.local), remote = structuredClone(host.draft); remote.allocations[0].minutes += 15;
   assert.equal(host.validDraft(remote), true); host.externalDraft(remote); assert.equal(await m.save(), false); assert.equal(m.state.error, 'conflict'); assert.deepEqual(m.state.local, local);
   await m.review(); assert.deepEqual(m.state.local, local); assert.equal(host.ledger.filter(e => e.phase === 'commit').length, 0); m[decision]();
   if (decision === 'reapply') { assert.equal(m.state.local.allocations.length, originalCount + 1); assert.equal(m.state.local.allocations[0].minutes, remote.allocations[0].minutes); assert.equal(m.state.dirty, true); assert.equal(await m.save(), true); }
   else { assert.deepEqual(m.state.local, remote); assert.equal(m.state.dirty, false); assert.equal(host.ledger.filter(e => e.phase === 'commit').length, 0); }
  }
 });

 test(`${label} planner delayed acknowledgement retains newer edits and prevents duplicate Save`, async () => {
  const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init(); m.add(addition); host.hold('draft_save');
  const save = m.save(); await tick(); assert.equal(await m.save(), false);
  m.edit(m.state.local.allocations.at(-1).allocation_id, { minutes: 45 }); const current = structuredClone(m.state.local);
  host.release(host.pendingFor('draft_save')[0].request_id); await save;
  assert.deepEqual(m.state.local, current); assert.equal(host.draft.allocations.at(-1).minutes, addition.minutes); assert.equal(m.state.dirty, true);
  assert.equal(host.ledger.filter(e => e.tool === 'draft_save' && e.phase === 'request').length, 1);
 });

 test(`${label} planner declared and midflight read-only preserve edits without commits`, async () => {
  const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init(); m.add(addition); host.hold('draft_save');
  const save = m.save(); await tick(); host.setWritable(false); host.release(host.pendingFor('draft_save')[0].request_id);
  assert.equal(await save, false); const local = structuredClone(m.state.local); assert.equal(await m.save(), false); assert.deepEqual(m.state.local, local);
  assert.equal(host.ledger.filter(e => e.phase === 'commit').length, 0);
  const readonly = make(null, selected); readonly.setWritable(false); const p = new PlannerModel((...args) => readonly.request(...args)); await p.init(); p.add(addition);
  assert.equal(await p.save(), false); assert.equal(readonly.ledger.filter(e => e.tool === 'draft_save').length, 0);
 });

 test(`${label} planner ambiguous save_failed requires authority review before explicit Save`, async () => {
  const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init(); m.add(addition); host.failNext('draft_save', 'save_failed');
  assert.equal(await m.save(), false); assert.equal(await m.save(), false); await m.review(); m.reapply(); assert.equal(await m.save(), true);
  assert.equal(host.ledger.filter(e => e.tool === 'draft_read' && e.phase === 'request').length, 2);
 });

 test(`${label} planner cumulative capacity binds including existing allocation, work still has slack`, async () => {
  const slot = eligibleSlots(selected.resources, selected.draft).find(s => s.usedDay > 0 && s.freeDay >= 30 && s.freeWork >= s.freeDay + 15);
  assert.ok(slot); const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init();
  const originalIds = m.state.local.allocations.map(a => a.allocation_id);
  assert.equal(m.add(lineFor(slot, slot.freeDay)), true); const filled = structuredClone(m.state.local);
  assert.equal(m.add(lineFor(slot, 15)), false); assert.deepEqual(m.state.local, filled); assert.ok(m.state.error.includes('cumulative draft exceeds residual capacity'));
  assert.ok(!m.state.error.includes('remaining work'));
  assert.deepEqual(m.state.local.allocations.slice(0, originalCount).map(a => a.allocation_id), originalIds);
  m.setView({ date: selected.resources.roster.find(day => day.date !== selected.resources.default_date).date, search: selected.resources.resources[0].display_name }); m.resetView();
  assert.deepEqual(m.state.local, filled); assert.equal(host.ledger.filter(e => e.phase === 'commit').length, 0);
 });

 test(`${label} planner cumulative work binds across multiple lines with capacity still available`, async () => {
  const slot = eligibleSlots(selected.resources, selected.draft).find(s => s.usedWork > 0 && s.freeWork >= 45 && s.freeDay >= s.freeWork + 15);
  assert.ok(slot); const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init();
  assert.equal(m.add(lineFor(slot, slot.freeWork - 15)), true); assert.equal(m.add(lineFor(slot, 15)), true);
  const filled = structuredClone(m.state.local); assert.equal(m.add(lineFor(slot, 15)), false); assert.deepEqual(m.state.local, filled);
  assert.ok(m.state.error.includes('cumulative draft exceeds remaining work')); assert.ok(!m.state.error.includes('residual capacity'));
  assert.equal(sum(filled.allocations.filter(a => a.work_item_id === slot.work.work_item_id), 'minutes'), slot.work.remaining_minutes);
 });

 test(`${label} planner rejects isolated team/skill/date/zero constraints and accepts inclusive dates`, async () => {
  const plan = selected.resources, draft = selected.draft, slots = eligibleSlots(plan, draft);
  const witnesses = [];
  for (const work of plan.work_items) for (const resource of plan.resources) for (const day of plan.roster) {
   if (day.resource_id !== resource.resource_id) continue;
   const usedDay = sum(draft.allocations.filter(a => a.resource_id === resource.resource_id && a.date === day.date), 'minutes');
   const usedWork = sum(draft.allocations.filter(a => a.work_item_id === work.work_item_id), 'minutes');
   const freeDay = day.available_minutes - day.committed_minutes - usedDay, freeWork = work.remaining_minutes - usedWork;
   const sameTeam = resource.team_id === work.team_id, skilled = resource.skills.includes(work.required_skill), inWindow = day.date >= work.earliest_date && day.date <= work.due_date;
   const slot = { work, resource, day };
   if (!sameTeam && skilled && inWindow && freeDay >= 15 && freeWork >= 15) witnesses.push(['team', slot]);
   if (sameTeam && !skilled && inWindow && freeDay >= 15 && freeWork >= 15) witnesses.push(['skill', slot]);
   if (sameTeam && skilled && day.date < work.earliest_date && freeDay >= 15 && freeWork >= 15) witnesses.push(['before earliest', slot]);
   if (sameTeam && skilled && day.date > work.due_date && freeDay >= 15 && freeWork >= 15) witnesses.push(['after due', slot]);
   if (sameTeam && skilled && inWindow && freeDay === 0 && freeWork >= 15) witnesses.push(['zero capacity', slot]);
   if (sameTeam && skilled && inWindow && freeDay >= 15 && freeWork === 0) witnesses.push(['zero work', slot]);
  }
  for (const kind of ['team', 'skill', 'before earliest', 'after due', 'zero capacity', 'zero work']) {
   const witness = witnesses.find(([name]) => name === kind); assert.ok(witness, `Independent ${kind} witness`);
   const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init();
   assert.equal(m.add(lineFor(witness[1], 15)), false, kind); assert.deepEqual(m.state.local, draft); assert.deepEqual(host.draft, draft);
   assert.equal(host.validDraft({ ...draft, allocations: [...draft.allocations, { ...lineFor(witness[1], 15), allocation_id: 'offline-ineligible' }] }), false, kind);
   assert.equal(host.ledger.filter(e => e.tool === 'draft_save').length, 0);
  }
  for (const boundary of ['earliest_date', 'due_date']) {
   const slot = slots.find(s => s.day.date === s.work[boundary] && s.freeDay >= 15 && s.freeWork >= 15); assert.ok(slot);
   const host = make(null, selected), m = new PlannerModel((...args) => host.request(...args)); await m.init(); assert.equal(m.add(lineFor(slot, 15)), true, boundary);
  }
 });

 test(`${label} independent oracle catches wrong scope and missing units remain UNKNOWN`, () => {
  const full = dashboardFacts(source, defaultScope(source));
  assert.notEqual(full.metrics.ticket_count, expected.metrics.ticket_count);
  assert.equal(numericFact({ status: 'OBSERVED', text: String(full.metrics.ticket_count), unit: 'tickets' }, expected.metrics.ticket_count, 'tickets').status, 'FAIL');
  assert.equal(numericFact({ status: 'OBSERVED', text: String(expected.metrics.ticket_count), unit: '' }, expected.metrics.ticket_count, 'tickets').status, 'UNKNOWN');
  assert.equal(numericFact({ status: 'UNKNOWN' }, expected.metrics.ticket_count, 'tickets').status, 'UNKNOWN');
 });
}

test('public/evaluator authored inputs have independent identities, dates, cardinalities and facts', () => {
 const [publicSet, evaluatorSet] = fixtureSets;
 const ids = selected => [...selected.dashboard.teams.map(r => r.team_id), ...selected.dashboard.tickets.map(r => r.ticket_id), ...selected.resources.teams.map(r => r.team_id), ...selected.resources.resources.map(r => r.resource_id), ...selected.resources.work_items.map(r => r.work_item_id), selected.draft.draft_id, ...selected.draft.allocations.map(r => r.allocation_id)];
 const publicIds = new Set(ids(publicSet)); assert.ok(ids(evaluatorSet).every(id => !publicIds.has(id)));
 assert.notEqual(publicSet.dashboard.as_of, evaluatorSet.dashboard.as_of); assert.notEqual(publicSet.resources.default_date, evaluatorSet.resources.default_date);
 assert.notEqual(publicSet.dashboard.teams.length, evaluatorSet.dashboard.teams.length); assert.notEqual(publicSet.dashboard.tickets.length, evaluatorSet.dashboard.tickets.length);
 assert.notEqual(publicSet.resources.resources.length, evaluatorSet.resources.resources.length); assert.notEqual(publicSet.resources.roster.length, evaluatorSet.resources.roster.length);
 assert.notEqual(publicSet.draft.allocations.length, evaluatorSet.draft.allocations.length);
 assert.notDeepEqual(authoredBaselines.public, authoredBaselines.evaluator);
});
test('real geometry prerequisites explicit; wrong ratio and false zero fail; missing/unstable unknown',()=>{const chart=heights=>({stable:true,values:Object.fromEntries(['OPEN','IN_PROGRESS','WAITING'].map((s,i)=>[s,{plot:{x:0,y:0,width:64,height:160},glyph:{x:0,width:64,height:heights[i],y:160-heights[i]},plotVisible:true,glyphObservable:true}]))});assert.equal(geometryFact(chart([80,40,0]),{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'PASS');assert.equal(geometryFact(chart([80,80,0]),{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'FAIL');assert.equal(geometryFact(chart([80,40,10]),{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'FAIL');assert.equal(geometryFact({...chart([80,40,0]),stable:false},{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'UNKNOWN');assert.equal(geometryFact(null,{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'UNKNOWN');assert.equal(geometryFact({stable:true,values:{}},{OPEN:2,IN_PROGRESS:1,WAITING:0}).status,'UNKNOWN');});
import {makeTypedReport} from '../../adapters/standalone-ui/report.mjs';
test('unexecuted browser report never grants UI PASS, and missing chart does not erase proven rows',()=>{const atoms=[{id:'D-E1',dimension:'ui_functional',weight:5},{id:'D-E2',dimension:'ui_functional',weight:10}],dependencies={'D-E1':['baseline'],'D-E2':['baseline']};const probes=[{probe_id:'baseline',actual_browser_executed:true,atom_checks:{'D-E1':[{status:'PASS'}],'D-E2':[{status:'UNKNOWN',reason:'missing chart'}]}}];assert.deepEqual(makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes}).atoms.map(a=>a.status),['UNKNOWN','UNKNOWN']);assert.deepEqual(makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes,tested_level:'ACTUAL_BROWSER_SYNTHETIC'}).atoms.map(a=>a.status),['PASS','UNKNOWN']);});
import {safeAsset,frozenPackage,verifiedAsset} from '../../adapters/standalone-ui/package-boundary.mjs';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join as pathJoin} from 'node:path';
test('static package boundary rejects traversal, URLs, absolute/double slash and symlink files/parents',async()=>{for(const path of ['/../gold.json','//outside','/a//b.js','/a/./b.js','/a%2fb.js','/http:x','/a\\b.js','/a.js?x'])assert.throws(()=>safeAsset(path));assert.equal(safeAsset('/assets/app.mjs'),'/assets/app.mjs');const dir=await mkdtemp(pathJoin(tmpdir(),'officekit-boundary-'));try{await mkdir(pathJoin(dir,'ok'));await writeFile(pathJoin(dir,'ok','index.html'),'safe');const pkg=await frozenPackage(pathJoin(dir,'ok'));assert.equal(pkg.files.length,1);await symlink(pathJoin(dir,'ok','index.html'),pathJoin(dir,'ok','alias.html'));await assert.rejects(()=>frozenPackage(pathJoin(dir,'ok')),/Symlink/);await symlink(pathJoin(dir,'ok'),pathJoin(dir,'linked'));await assert.rejects(()=>verifiedAsset(pathJoin(dir,'linked'),'/index.html'),/Symlink/);}finally{await rm(dir,{recursive:true,force:true});}});
import {calendarDate} from '../../adapters/standalone-ui/reference/api-contract.mjs';
test('tool boundary malformed arguments and noncalendar dates return typed protocol defects with request/result and no effects',async()=>{const host=make(),original=structuredClone(host.draft);for(const input of [null,[],{}, {team_ids:[],statuses:null,created_from:fixture.dashboard.default_created_from,created_to:fixture.dashboard.default_created_to}, {team_ids:[],statuses:['OPEN'],created_from:'2027-02-30',created_to:'2027-03-02'}]){const result=await host.request('dashboard_load',input);assert.equal(result.code,'invalid_arguments');assert.equal(result.error_class,'PROTOCOL_INTEGRATION');}for(const input of [null,{revision:4,draft:original},{revision:'actual',draft:null}])assert.equal((await host.request('draft_save',input)).code,'invalid_arguments');assert.equal(host.ledger.filter(x=>x.phase==='request').length,8);assert.equal(host.ledger.filter(x=>x.phase==='result').length,8);assert.deepEqual(host.draft,original);assert.equal(host.ledger.filter(x=>x.phase==='commit').length,0);assert.equal(calendarDate('2027-02-30'),false);assert.equal(calendarDate('2028-02-29'),true);});
import {equalRows} from '../../adapters/standalone-ui/oracle.mjs';
test('ISO equivalents and hours are source equivalent; unresolved date prose UNKNOWN; distinct valid wrong date FAIL',()=>{const expected=[{date:'2030-08-14',due_at:'2030-08-09T06:00:00Z',remaining_minutes:60}];assert.equal(equalRows({status:'OBSERVED',rows:[{date:'2030-08-14',due_at:'2030-08-09T07:00:00+01:00',remaining_minutes:'1'}],units:{remaining_minutes:'hours'}},expected,['date','due_at','remaining_minutes']).status,'PASS');assert.equal(equalRows({status:'OBSERVED',rows:[{...expected[0],date:'Aug 14, 2030'}]},expected,['date']).status,'UNKNOWN');assert.equal(equalRows({status:'OBSERVED',rows:[{...expected[0],date:'2030-08-15'}]},expected,['date']).status,'FAIL');});
test('old-response and late-ack negative source variants fail independent state/ledger expectations',async()=>{const host=make(),d=new DashboardModel((...x)=>host.request(...x),()=>{},'old-response');await d.init();host.hold('dashboard_load');const a=d.setIntent({team_ids:[fixture.dashboard.teams[0].team_id]}),b=d.setIntent({team_ids:[fixture.dashboard.teams[1].team_id]});await tick();const [old,newer]=host.pendingFor('dashboard_load');host.release(newer.request_id);await b;host.release(old.request_id);await a;assert.notDeepEqual(d.state.view.scope,d.state.intent);const h=make(),p=new PlannerModel((...x)=>h.request(...x),()=>{},'late-ack-clears-edits');await p.init();p.add(newLine);h.hold('draft_save');const save=p.save();await tick();const id=p.state.local.allocations.at(-1).allocation_id;p.edit(id,{minutes:45});h.release(h.pendingFor('draft_save')[0].request_id);await save;assert.notEqual(p.state.local.allocations.at(-1).minutes,45);assert.equal(p.state.dirty,false);});
test('cross-task read-only query is a protocol defect, forbidden synthetic write separately rejected, never commits',async()=>{const host=new SyntheticAuthority({...fixture,task_kind:'dashboard'});const read=await host.request('planner_source');assert.equal(read.error_class,'PROTOCOL_INTEGRATION');assert.equal(read.effect,'rejected_read_only_protocol_query');const write=await host.request('draft_save',{revision:host.revision,draft:fixture.draft});assert.equal(write.error_class,'SAFETY_EFFECT');assert.equal(write.effect,'rejected_forbidden_mock_write');assert.equal(host.ledger.filter(e=>e.phase==='commit').length,0);});
// These reducer fixtures simulate a trusted runner's input shape; no browser is executed.
test('report reducer actual-channel known FAIL survives missing required probe with coverage UNKNOWN',()=>{const atoms=[{id:'D-M1',dimension:'ui_functional',weight:15,public_requirement:'Neutral reducer control'}],dependencies={'D-M1':['completed','missing']};const probes=[{probe_id:'completed',actual_browser_executed:true,atom_checks:{'D-M1':[{status:'FAIL',error_class:'BUSINESS_FACT',expected:1,observed:2}]}}];const atom=makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes,tested_level:'ACTUAL_BROWSER_SYNTHETIC'}).atoms[0];assert.equal(atom.status,'FAIL');assert.equal(atom.error_class,'BUSINESS_FACT');assert.equal(atom.coverage.status,'UNKNOWN');assert.deepEqual(atom.coverage.missing_probe_ids,['missing']);assert.deepEqual(atom.required_probe_ids,['completed','missing']);assert.equal(atom.weight,15);});
test('report reducer prepared/offline self-claimed FAIL stays UNKNOWN even with browser flags',()=>{const atoms=[{id:'D-M1',dimension:'ui_functional',weight:15}],dependencies={'D-M1':['completed','missing']};const claimed={probe_id:'completed',actual_browser_executed:true,atom_checks:{'D-M1':[{status:'FAIL',error_class:'BUSINESS_FACT'}]}};for(const tested_level of ['BROWSER_PREPARED_NOT_EXECUTED','OFFLINE_CONTROL_ONLY']){const atom=makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes:[claimed],tested_level}).atoms[0];assert.equal(atom.status,'UNKNOWN');assert.equal(atom.coverage.status,'UNKNOWN');}const unexecuted=makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes:[{...claimed,actual_browser_executed:false}],tested_level:'ACTUAL_BROWSER_SYNTHETIC'}).atoms[0];assert.equal(unexecuted.status,'UNKNOWN');});
import {createHash} from 'node:crypto';
import {publicCandidateIdentity, executionMode} from '../../adapters/standalone-ui/browser-acceptance.mjs';
import {downloadArtifactPath} from '../../adapters/standalone-ui/planner-probes.mjs';
test('probe evidence hash binds its receipt artifact; missing delivery/transfer receipts do not invent paths/hashes',async()=>{const dir=await mkdtemp(pathJoin(tmpdir(),'officekit-evidence-binding-'));try{await mkdir(pathJoin(dir,'neutral'));const bytes='{"control_only":true,"actual_browser_executed":false}\n';await writeFile(pathJoin(dir,'neutral','receipt.json'),bytes);const digest=createHash('sha256').update(bytes).digest('hex');const atoms=[{id:'D-M1',dimension:'ui_functional',weight:15}],dependencies={'D-M1':['receipt','delivery','transfer']},probes=[{probe_id:'receipt',actual_browser_executed:true,artifact:'neutral/receipt.json',sha256:digest,atom_checks:{'D-M1':[{status:'PASS'}]}},...['delivery','transfer'].map(probe_id=>({probe_id,actual_browser_executed:true,atom_checks:{'D-M1':[{status:'PASS'}]}}))];const r=makeTypedReport({case_id:'ui-dashboard',atoms,dependencies,probes,tested_level:'ACTUAL_BROWSER_SYNTHETIC',artifact:'ui-dashboard.report.json'});const evidence=r.atoms[0].evidence;assert.equal(evidence[0].artifact,'neutral/receipt.json');assert.equal(evidence[0].sha256,createHash('sha256').update(await readFile(pathJoin(dir,evidence[0].artifact))).digest('hex'));for(const e of evidence.slice(1)){assert.equal(Object.hasOwn(e,'artifact'),false);assert.equal(Object.hasOwn(e,'sha256'),false);}}finally{await rm(dir,{recursive:true,force:true});}});
test('public candidate manifest and download evidence contain no machine root/path',()=>{const identity={root:'/private/machine/work/package',files:[{path:'index.html',sha256:'a'.repeat(64),bytes:1}],digest:'b'.repeat(64)};const exposed=publicCandidateIdentity(identity);assert.deepEqual(Object.keys(exposed),['files','digest']);assert.equal(JSON.stringify(exposed).includes('/private/machine'),false);assert.equal(downloadArtifactPath('/private/machine/output','/private/machine/output/planner-public-add-save/capacity.csv'),'planner-public-add-save/capacity.csv');});

// Pure argument dispatch only: no process.env mutation, browser launch or CI execution.
test('browser execution mode dispatch supports ordinary Chrome and preserves explicit CI guard', () => {
 const before = process.env.GITHUB_ACTIONS;
 assert.equal(executionMode([], {}), 'prepare');
 assert.equal(executionMode(['--prepare'], {}), 'prepare');
 assert.equal(executionMode(['--execute-browser'], {}), 'browser');
 assert.equal(executionMode(['--execute-browser'], { GITHUB_ACTIONS: 'false' }), 'browser');
 for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'TRUE' }]) assert.throws(() => executionMode(['--execute-ci'], env), /requires.*GitHub CI/);
 assert.equal(executionMode(['--execute-ci'], { GITHUB_ACTIONS: 'true' }), 'ci');
 assert.throws(() => executionMode(['--execute-browser', '--execute-ci'], {}), /Choose one browser execution mode/);
 assert.throws(() => executionMode(['--execute-ci', '--execute-browser'], { GITHUB_ACTIONS: 'true' }), /Choose one browser execution mode/);
 assert.equal(process.env.GITHUB_ACTIONS, before);
});
