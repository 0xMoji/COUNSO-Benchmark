/** Generic synthetic instrumentation control. It grants no candidate/task score. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {browserSession,sha} from '../office-capability-kit-0.5/adapters/standalone-ui/browser-session.mjs';
import {frozenPackage} from '../office-capability-kit-0.5/adapters/standalone-ui/package-boundary.mjs';
const args=process.argv.slice(2),index=args.indexOf('--output');
const output=resolve(index<0?'ui-terminal-evidence':args[index+1]);
if(!args.includes('--execute-ci')||process.env.GITHUB_ACTIONS!=='true')throw new Error('This bounded control requires its authorized actual GitHub CI job. It does not start a browser during prepare/offline checks.');
const kit=fileURLToPath(new URL('../office-capability-kit-0.5/',import.meta.url));
const reference=join(kit,'adapters/standalone-ui/reference');
const identity=await frozenPackage(reference);
const mapping=JSON.parse(await readFile(join(kit,'adapters/standalone-ui/action-mapping.json'),'utf8'));
await mkdir(output,{recursive:false});
const {chromium}=await import('../office-capability-kit-0.5/adapters/standalone-ui/node_modules/playwright/index.mjs');
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const browser=await chromium.launch({channel:'chrome',headless:true,env});
let receipt;
try {
 receipt=await browserSession({browser,kind:'dashboard',fixture:'public',mutation:null,mapping,output,probe_id:'intentional-terminal-wait',candidateDir:null,assets:identity.files.map(f=>'/'+f.path)},async s=>{
  const before=s.host.authority.ledger.length;
  await s.c.action('refresh','click');
  await s.waitTool('dashboard_load','result',before);
  // Healthy actual interaction is complete; a trusted observer deliberately
  // waits for an impossible event to exercise failure capture, not app failure.
  await s.waitTool('INSTRUMENT_CONTROL_EVENT_NEVER_EMITTED');
 });
}finally{await browser.close();}
assert.equal(receipt.actual_browser_executed,true);
assert.equal(receipt.blocked?.error_class,'INSTRUMENTATION');
assert.equal(receipt.blocked?.reason,'Observable result did not settle in acceptance window');
assert.equal(receipt.terminal_capture?.status,'CAPTURED');
assert.deepEqual(receipt.checks,{});assert.deepEqual(receipt.atom_checks,{});
assert.ok(receipt.actions.some(a=>a.key==='refresh'&&a.method==='click'&&a.performed));
assert.ok(receipt.tool_ledger.filter(e=>e.tool==='dashboard_load'&&e.phase==='result'&&e.result.ok).length>=2);
const observation=receipt.observations.find(o=>o.observation_id===receipt.terminal_capture.observation_id);
assert.equal(observation?.actual_browser_executed,true);assert.equal(observation?.evidence_binding,'STABLE');assert.equal(observation?.data?.terminal?.kind,'TERMINAL_ACTUAL_DOM_DIAGNOSTIC');
assert.ok(observation.data.terminal.nodes.length>0);assert.ok(observation.data.terminal.body_text.trim());
assert.equal(observation.data.blocked.reason,receipt.blocked.reason);
assert.ok(observation.actions.length>0);assert.ok(observation.event_ids.length>0);
const png=await readFile(join(output,observation.png_artifact));assert.equal(sha(png),observation.png_sha256);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
const ledger=await readFile(join(output,receipt.ledger_artifact));assert.deepEqual(JSON.parse(ledger),receipt.tool_ledger);
const result={schema_version:1,kind:'INSTRUMENTATION_FAILURE_CAPTURE_CONTROL_NOT_CANDIDATE_SCORE',status:'ACTUAL_TERMINAL_CAPTURE_VERIFIED',browser_version:browser.version(),healthy_refresh_observed:true,intentional_wait_error:receipt.blocked,terminal_capture:receipt.terminal_capture,receipt:{artifact:receipt.artifact,sha256:receipt.sha256},png:{artifact:observation.png_artifact,sha256:observation.png_sha256},ledger:{artifact:receipt.ledger_artifact,sha256:sha(ledger)},reference_package:identity,task_score_awarded:false};
await writeFile(join(output,'control-result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({kind:result.kind,status:result.status,healthy_refresh_observed:true,task_score_awarded:false}));
