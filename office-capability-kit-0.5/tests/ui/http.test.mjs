/** Ordinary Node HTTP mock controls only. This file never imports/starts a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../adapters/standalone-ui/server.mjs';
import { dashboardFacts } from '../../adapters/standalone-ui/oracle.mjs';
import { frozenPackage } from '../../adapters/standalone-ui/package-boundary.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const post = (origin, path, value) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const defaultScope = source => ({ team_ids: [], statuses: ['OPEN', 'IN_PROGRESS', 'WAITING', 'CLOSED'], created_from: source.default_created_from, created_to: source.default_created_to });
const waitFor = async predicate => {
 const deadline = Date.now() + 2000;
 while (!predicate()) { if (Date.now() >= deadline) throw new Error('HTTP control failed to reach a pending request'); await new Promise(resolve => setImmediate(resolve)); }
};
function additionalLine(source, draft) {
 for (const work of source.work_items) for (const resource of source.resources) for (const day of source.roster) {
  if (day.resource_id !== resource.resource_id || resource.team_id !== work.team_id || !resource.skills.includes(work.required_skill) || day.date < work.earliest_date || day.date > work.due_date) continue;
  const usedDay = draft.allocations.filter(a => a.resource_id === resource.resource_id && a.date === day.date).reduce((n, a) => n + a.minutes, 0);
  const usedWork = draft.allocations.filter(a => a.work_item_id === work.work_item_id).reduce((n, a) => n + a.minutes, 0);
  if (day.available_minutes - day.committed_minutes - usedDay >= 30 && work.remaining_minutes - usedWork >= 30) return { allocation_id: 'http-control-new-line', work_item_id: work.work_item_id, resource_id: resource.resource_id, date: day.date, minutes: 30 };
 }
 throw new Error('Authored planner fixture lacks an eligible HTTP control addition');
}

for (const fixture of ['public', 'evaluator']) {
 test(`[${fixture}] mock HTTP exposes task tools/static assets and types malformed input`, async () => {
  const server = await startServer({ fixture });
  try {
   assert.equal((await fetch(server.origin + '/')).status, 200);
   for (const path of ['/gold.json', '/host-control', '/source.json', '/resources.json']) assert.equal((await fetch(server.origin + path)).status, 404);
   const broken = await fetch(server.origin + '/api/dashboard-load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
   assert.equal(broken.status, 200); const result = await broken.json();
   assert.equal(result.code, 'invalid_arguments'); assert.equal(result.error_class, 'PROTOCOL_INTEGRATION');
   assert.equal((await (await post(server.origin, '/api/dashboard-load', null)).json()).code, 'invalid_arguments');
   const crossTask = await (await fetch(server.origin + '/api/planner-source')).json();
   assert.equal(crossTask.error_class, 'PROTOCOL_INTEGRATION'); assert.equal(crossTask.effect, 'rejected_read_only_protocol_query');
   assert.equal(server.authority.ledger.filter(e => e.phase === 'commit').length, 0);
  } finally { await server.close(); }
 });

 test(`[${fixture}] mock HTTP scope uses independent new data and half-open UTC boundaries`, async () => {
  const server = await startServer({ fixture });
  try {
   const sourceResult = await (await fetch(server.origin + '/api/dashboard-source')).json();
   assert.equal(sourceResult.ok, true); assert.deepEqual(sourceResult.snapshot, server.authority.dashboard);
   const source = sourceResult.snapshot, baseline = defaultScope(source);
   for (const scope of [baseline, { ...baseline, team_ids: [source.teams[0].team_id], statuses: ['OPEN'] }, { ...baseline, statuses: [] }]) {
    const result = await (await post(server.origin, '/api/dashboard-load', scope)).json();
    assert.equal(result.ok, true); assert.deepEqual(result.scope, scope); assert.deepEqual(result.snapshot, source);
    assert.deepEqual(result.rows, dashboardFacts(source, scope).rows);
   }
   const all = await (await post(server.origin, '/api/dashboard-load', baseline)).json();
   const lower = source.tickets.find(row => row.created_at === `${baseline.created_from}T00:00:00Z`), upper = source.tickets.find(row => row.created_at === `${baseline.created_to}T00:00:00Z`);
   assert.ok(lower && upper); assert.ok(all.rows.some(row => row.ticket_id === lower.ticket_id)); assert.ok(!all.rows.some(row => row.ticket_id === upper.ticket_id));
   assert.equal(server.authority.ledger.filter(e => e.phase === 'commit').length, 0);
  } finally { await server.close(); }
 });

 test(`[${fixture}] mock HTTP held requests clean up without writes or stale pending queues`, async () => {
  const server = await startServer({ fixture });
  try {
   const source = server.authority.dashboard, scope = { ...defaultScope(source), team_ids: [source.teams[1].team_id], statuses: ['WAITING'] };
   server.authority.hold('dashboard_load');
   const held = post(server.origin, '/api/dashboard-load', scope).catch(() => null);
   await waitFor(() => server.authority.pendingFor('dashboard_load').length === 1);
   assert.deepEqual(server.authority.pendingFor('dashboard_load')[0].input, scope);
   await server.close(); await held;
   assert.equal(server.authority.pending.length, 0); assert.equal(server.authority.ledger.filter(e => e.phase === 'commit').length, 0);
   assert.equal(server.authority.ledger.find(e => e.tool === 'dashboard_load' && e.phase === 'result').result.code, 'observer_teardown');
  } finally { await server.close(); }
 });

 test(`[${fixture}] mock HTTP planner rejects invalid quantity and saves exact new-fixture draft`, async () => {
  const server = await startServer({ fixture, kind: 'planner' });
  try {
   const sourceResult = await (await fetch(server.origin + '/api/planner-source')).json(), original = await (await fetch(server.origin + '/api/draft')).json();
   assert.equal(sourceResult.ok, true); assert.equal(original.ok, true); assert.equal(original.canWrite, true);
   const source = sourceResult.source, roster = structuredClone(source.roster), draft = structuredClone(original.draft);
   const line = additionalLine(source, draft); draft.allocations.push({ ...line, minutes: 17 });
   const invalid = await (await post(server.origin, '/api/draft', { revision: original.revision, draft })).json();
   assert.equal(invalid.code, 'invalid_draft'); assert.deepEqual(server.authority.draft, original.draft);
   assert.equal(server.authority.ledger.filter(e => e.phase === 'commit').length, 0);
   draft.allocations.at(-1).minutes = line.minutes;
   const saved = await (await post(server.origin, '/api/draft', { revision: original.revision, draft })).json();
   assert.equal(saved.ok, true); assert.notEqual(saved.revision, original.revision); assert.deepEqual(saved.draft, draft);
   const reread = await (await fetch(server.origin + '/api/draft')).json();
   assert.deepEqual(reread.draft, draft); assert.equal(reread.revision, saved.revision); assert.deepEqual(server.authority.resources.roster, roster);
   const commits = server.authority.ledger.filter(e => e.phase === 'commit'); assert.equal(commits.length, 1); assert.deepEqual(commits[0].draft, draft);
  } finally { await server.close(); }
 });
}

test('frozen ordinary inline scripts use content hashes, not unsafe script permissions', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'officekit-inline-'));
 try {
  await writeFile(join(dir, 'index.html'), '<!doctype html><script>document.title="synthetic";</script>');
  const pkg = await frozenPackage(dir), server = await startServer({ candidateDir: dir, assets: pkg.files.map(file => '/' + file.path) });
  try {
   const response = await fetch(server.origin + '/'), csp = response.headers.get('content-security-policy');
   assert.match(csp, /script-src 'self' 'sha256-/); assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'")); assert.equal(response.status, 200);
  } finally { await server.close(); }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
