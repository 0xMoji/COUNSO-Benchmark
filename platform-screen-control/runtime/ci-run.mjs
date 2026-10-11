// Standard GitHub Actions runner entry. No browser or server is started on import.
// This entry deliberately refuses a local Chrome fallback.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startProxy } from './server.mjs';
import { CandidatePackageError } from './compiler.mjs';
import { buildTestPlan, runAcceptanceTest, canonicalSha256 } from './acceptance-driver.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
export const CHROME_CHANNEL = 'chrome';
export const PROBE_CHROME_VERSION = '154.0.8037.97';
export const BROWSER_ENV_KEYS = Object.freeze(['HOME','PATH','LANG','LC_ALL','TZ','TMPDIR','TMP','TEMP','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']);
export function standardChromeLaunchOptions(config = {}, environment = process.env) {
  if ((config.browserChannel ?? environment.CI_BROWSER_CHANNEL ?? CHROME_CHANNEL) !== CHROME_CHANNEL) throw new Error('Only the approved official preinstalled Chrome channel is supported; no browser fallback/download');
  if (config.expectedChromeVersion !== undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(config.expectedChromeVersion)) throw new Error('expectedChromeVersion must be an exact four-part version');
  if (config.expectedChromeBinarySha256 !== undefined && !/^[0-9a-f]{64}$/.test(config.expectedChromeBinarySha256)) throw new Error('expectedChromeBinarySha256 must be a frozen SHA256');
  const env = Object.fromEntries(BROWSER_ENV_KEYS.filter(key => typeof environment[key] === 'string').map(key => [key,environment[key]]));
  return {channel:CHROME_CHANNEL,headless:true,env};
}
export function declaredHostMetadata(contract, provided) {
  const keys = Object.keys(contract.source_files).sort();
  if (provided === undefined) return Object.fromEntries(keys.map(key=>[key,{revision:'1',canWrite:contract.write_paths.includes('./'+key)}]));
  if (!provided || Array.isArray(provided) || typeof provided !== 'object' || JSON.stringify(Object.keys(provided).sort()) !== JSON.stringify(keys)) throw new Error('hostMetadata must cover exactly the declared source file keys');
  for (const key of keys) {
    const item = provided[key];
    if (!item || Array.isArray(item) || typeof item !== 'object' || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['canWrite','revision']) || typeof item.revision !== 'string' || !/^[1-9][0-9]*$/.test(item.revision) || typeof item.canWrite !== 'boolean') throw new Error(`Invalid hostMetadata for ${key}; revision is a positive opaque string and canWrite is boolean`);
    if (item.canWrite && !contract.write_paths.includes('./'+key)) throw new Error(`hostMetadata cannot make a publicly nonwritable source writable: ${key}`);
  }
  return Object.fromEntries(keys.map(key=>[key,{revision:provided[key].revision,canWrite:provided[key].canWrite}]));
}
async function browserProvenance(browser, config) {
  const version = browser.version(), expectedVersion = config.expectedChromeVersion ?? PROBE_CHROME_VERSION;
  if (version !== expectedVersion) throw new Error(`Official Chrome version mismatch: expected ${expectedVersion}, observed ${version}`);
  const cdp = await browser.newBrowserCDPSession();
  try {
    const product = await cdp.send('Browser.getVersion');
    const processes = await cdp.send('SystemInfo.getProcessInfo');
    const pid = processes.processInfo.find(item=>item.type === 'browser')?.id;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Actual Chrome browser process ID unavailable');
    const binaryPath = await fs.realpath(`/proc/${pid}/exe`);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(binaryPath)) digest.update(chunk);
    const binarySha256 = digest.digest('hex');
    if (config.expectedChromeBinarySha256 && binarySha256 !== config.expectedChromeBinarySha256) throw new Error('Actual official Chrome binary SHA256 differs from frozen expectation');
    return {channel:CHROME_CHANNEL,version,product:product.product,protocol_version:product.protocolVersion,user_agent:product.userAgent,
      binary_path:binaryPath,binary_sha256:binarySha256,binary_hash_method:'CDP_BROWSER_PID_PROC_EXE_BYTES',
      binary_expectation:config.expectedChromeBinarySha256 ? 'FROZEN_SHA256_VERIFIED' : 'ACTUAL_SHA256_RECORDED_NOT_YET_FROZEN',
      runner_image:{image_os:process.env.ImageOS ?? 'UNKNOWN',image_version:process.env.ImageVersion ?? 'UNKNOWN',runner_os:process.env.RUNNER_OS ?? 'UNKNOWN',runner_arch:process.env.RUNNER_ARCH ?? 'UNKNOWN'},
      environment_keys:BROWSER_ENV_KEYS.filter(key=>typeof process.env[key]==='string')};
  } finally { await cdp.detach(); }
}
const HEALTH_CONFIG_KEYS = ['baselineTestId','baselineTestPlanSha256','bundleSha256','fixtureDir','fixtureSha256','hostMetadata','packageDir','packageSha256'];
function validateHealthConfig(health, config, resolve, fixtureSha256, hostMetadata) {
  if (!health || Array.isArray(health) || typeof health !== 'object' || JSON.stringify(Object.keys(health).sort()) !== JSON.stringify(HEALTH_CONFIG_KEYS)) throw new Error('registeredHealthControl must use the exact declared evaluator-only shape');
  for (const key of ['packageSha256','bundleSha256','fixtureSha256','baselineTestPlanSha256']) if (!/^[0-9a-f]{64}$/.test(health[key] ?? '')) throw new Error(`Health ${key} must be frozen SHA256`);
  if (typeof health.packageDir !== 'string' || typeof health.fixtureDir !== 'string' || typeof health.baselineTestId !== 'string' || resolve(health.fixtureDir) !== resolve(config.fixtureDir) || health.fixtureSha256 !== fixtureSha256 || canonicalSha256(health.hostMetadata) !== canonicalSha256(hostMetadata)) throw new Error('Health control must use the fixed reference and identical source fixture/authority');
}
async function buildRejectionReceipt({error,test,config,kind,binding,health,artifactDir}) {
  if (!(error instanceof CandidatePackageError)) throw error;
  const diagnostic = error.diagnostic;
  const receiptId = `build-rejected:${test.test_id}`;
  const diagnosticFile = path.join(artifactDir,'build-diagnostic.json');
  await fs.writeFile(diagnosticFile,JSON.stringify(diagnostic,null,2)+'\n');
  const diagnosticRef = `build-diagnostic:${test.test_id}`, healthRef = `reference-health:${health.manifest_entry.receipt_id}`;
  const receipt = {schema_version:1,origin:'TRUSTED_CANDIDATE_BUILD_REJECTION',execution:'verified_build_rejection',actual_browser_executed:false,
    receipt_id:receiptId,task_kind:kind,test_id:test.test_id,test_plan_sha256:canonicalSha256(test),schedule_id:test.schedule_id,fixture_id:test.fixture_id,
    fixture_sha256:binding.fixtures[test.fixture_id],candidate_package_sha256:binding.candidate_package_sha256,candidate_bundle_sha256:null,
    ...Object.fromEntries(['case_id','interface_sha256','scope_sha256','observer_sha256','ci_job_id','github_run_id','compiler_sha256','dependencies_sha256','browser_binary_sha256','runner_image_sha256'].filter(k=>binding[k]).map(k=>[k,binding[k]])),
    diagnostic,health_control_receipt_id:health.manifest_entry.receipt_id,health_control_receipt_sha256:health.manifest_entry.sha256,
    started_at:new Date().toISOString(),ended_at:new Date().toISOString(),observations:[{kind:'build_diagnostic',capture_method:'trusted_typed_compiler',evidence_ref:diagnosticRef,file:path.basename(diagnosticFile),sha256:hash(await fs.readFile(diagnosticFile))},{kind:'reference_health',evidence_ref:healthRef,receipt_id:health.manifest_entry.receipt_id,sha256:health.manifest_entry.sha256}],
    assertions:test.atom_ids.map(atom_id=>({atom_id,state:'FAIL',oracle:'independent_typed_build_rejection',failure_class:'unusable_package',predicate:'Closed typed package rejection under same-job actual healthy compiler/browser/source control',expected:'Runnable public Frame package',observed:diagnostic,evidence_refs:[diagnosticRef,healthRef],reason:'Package is stably unusable; no candidate browser interaction, business/safety finding or PASS is inferred'}))};
  const receiptFile = path.join(artifactDir,`${test.test_id}.receipt.json`);await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n');
  return {receipt_id:receiptId,path:receiptFile,sha256:hash(await fs.readFile(receiptFile))};
}
export async function runCI(config, baseDir = process.cwd()) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Only a separately authorized standard GitHub Actions runner may start this browser entry. No local fallback is permitted.');
  const launchOptions = standardChromeLaunchOptions(config);
  const resolve = p => path.resolve(baseDir, p);
  const output = resolve(config.artifactDir); await fs.mkdir(output, { recursive: true });
  const started = { utc: new Date().toISOString(), monotonic_ms: performance.now() };
  const kind = config.kind === 'create' ? 'dashboard' : config.kind === 'edit' ? 'planner' : config.kind;
  if (!['dashboard','planner'].includes(kind)) throw new Error('Unsupported kind');
  const interfacePath = config.interfacePath ? resolve(config.interfacePath) : path.join(ROOT, 'ui-interface.json');
  const contract = (await json(interfacePath)).tasks[kind];
  const hostMetadata = declaredHostMetadata(contract, config.hostMetadata);
  const files = {};
  for (const key of Object.keys(contract.source_files)) files[key] = { content: await fs.readFile(path.join(resolve(config.fixtureDir), key), 'utf8'), contentType: 'application/json', ...hostMetadata[key] };
  const source = JSON.parse(files[kind === 'dashboard' ? 'dataset.json' : 'resources.json'].content);
  const draft = kind === 'planner' ? JSON.parse(files['draft.json'].content) : null;
  const fixtureHash = canonicalSha256({files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,hash(item.content)])),host_metadata:hostMetadata});
  const plans = buildTestPlan(kind, source, draft, config.fixtureId ?? 'primary');
  if (config.testIds && (!Array.isArray(config.testIds) || !config.testIds.length || new Set(config.testIds).size !== config.testIds.length || config.testIds.some(id=>!plans.some(plan=>plan.test_id===id)))) throw new Error('testIds must be a nonempty unique subset of preregistered plans');
  const selected = config.testIds ? plans.filter(p => config.testIds.includes(p.test_id)) : plans;
  if (!selected.length) throw new Error('No preregistered test selected');
  let observe;
  if (!config.observerModule || !/^[0-9a-f]{64}$/.test(config.observerSha256 ?? '')) throw new Error('Functional acceptance requires the preregistered evaluator observer module and exact hash before browser launch');
  if (config.observerModule) {
    const modulePath = resolve(config.observerModule);
    if (hash(await fs.readFile(modulePath)) !== config.observerSha256) throw new Error('Trusted observer hash mismatch');
    observe = (await import(pathToFileURL(modulePath).href)).observe;
    if (typeof observe !== 'function') throw new Error('Observer must export observe');
  }
  const receipts = [], healthControls = [], instrumentation = { status: 'UNKNOWN', browser: 'UNKNOWN', errors: [] };
  let browser;
  try {
    // Standard launcher only. No disable-web-security, altered URLs, proxy,
    // tunnel, safe-browsing bypass, or alternate browser on failure.
    browser = await chromium.launch(launchOptions);
    instrumentation.browser = browser.version();
    instrumentation.browser_provenance = await browserProvenance(browser, config);
    // Tiny trusted about:blank DOM probe, not a candidate action or task PASS.
    const visibilityContext=await browser.newContext({serviceWorkers:'block'});
    try { const visibilityPage=await visibilityContext.newPage();instrumentation.native_visibility_probe=await visibilityPage.evaluate(()=>{
      const parent=document.createElement('div'),child=document.createElement('span');parent.style.cssText='width:20px;height:20px;opacity:0';child.style.cssText='display:block;width:10px;height:10px;opacity:1';parent.append(child);document.body.append(parent);
      if(typeof child.checkVisibility!=='function')throw new Error('Native effective visibility API unavailable');const options={opacityProperty:true,visibilityProperty:true};const ancestor_opacity_zero=child.checkVisibility(options),own_opacity=getComputedStyle(child).opacity;parent.style.opacity='1';const visible_positive=child.checkVisibility(options);parent.style.display='none';const ancestor_display_none=child.checkVisibility(options);parent.remove();return {origin:'TRUSTED_BROWSER_INSTRUMENT_SELF_CONTROL',visible_positive,ancestor_opacity_zero,ancestor_display_none,own_opacity};
    });const v=instrumentation.native_visibility_probe;if(v.visible_positive!==true||v.ancestor_opacity_zero!==false||v.ancestor_display_none!==false||v.own_opacity!=='1')throw new Error('Actual ancestor-aware visibility positive/negative instrument control failed');
    } finally {await visibilityContext.close();}

    const fixtureId = config.fixtureId ?? 'primary';
    const commonBinding = {fixtures:config.fixtureHashes ?? {[fixtureId]:fixtureHash},case_id:config.caseId,interface_sha256:hash(await fs.readFile(interfacePath)),...(config.scopePath?{scope_sha256:hash(await fs.readFile(resolve(config.scopePath)))}:{}),observer_sha256:config.observerSha256,
      ci_job_id:process.env.GITHUB_RUN_ID&&process.env.GITHUB_RUN_ATTEMPT&&process.env.GITHUB_JOB?`${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}:${process.env.GITHUB_JOB}`:'UNKNOWN',github_run_id:process.env.GITHUB_RUN_ID ?? 'UNKNOWN',compiler_sha256:hash(await fs.readFile(path.join(ROOT,'compiler.mjs'))),dependencies_sha256:hash(await fs.readFile(path.join(ROOT,'package-lock.json'))),browser_binary_sha256:instrumentation.browser_provenance.binary_sha256,runner_image_sha256:canonicalSha256(instrumentation.browser_provenance.runner_image)};
    const healthConfig = config.registeredHealthControl;
    validateHealthConfig(healthConfig, config, resolve, commonBinding.fixtures[fixtureId], hostMetadata);
    const healthTest = plans.find(test=>test.test_id===healthConfig.baselineTestId);
    if (!healthTest || canonicalSha256(healthTest)!==healthConfig.baselineTestPlanSha256 || !['dashboard_scope','planner_initial'].includes(healthTest.oracle_kind)) throw new Error('Health baseline plan differs from frozen known-reference baseline');
    const healthArtifactDir = path.join(output,'health-control');await fs.mkdir(healthArtifactDir,{recursive:true});
    const healthProxy = await startProxy({packageDir:resolve(healthConfig.packageDir),kind,files,interfacePath,artifactDir:healthArtifactDir});
    let healthResult, healthBinding;
    let healthContext;
    try {
      healthContext = await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000},serviceWorkers:'block'});
      if (healthProxy.build.bundle_sha256!==healthConfig.bundleSha256) throw new Error('Actual reference bundle differs from frozen healthy control');
      healthBinding = {...commonBinding,candidate_package_sha256:healthConfig.packageSha256,candidate_bundle_sha256:healthProxy.build.bundle_sha256,test_plan_sha256:canonicalSha256(healthTest),session_ids:[healthProxy.sessionId]};
      healthResult = await runAcceptanceTest({page:await healthContext.newPage(),proxy:healthProxy,test:healthTest,kind,source,draft,binding:healthBinding,artifactDir:healthArtifactDir,observe,timeout:config.actionTimeoutMs??5000});
    } finally {if(healthContext)await healthContext.close();await healthProxy.close();}
    const health = {manifest_entry:healthResult.manifest_entry,binding:healthBinding,test_spec:{...healthTest,test_plan_sha256:canonicalSha256(healthTest)},task_kind:kind};
    healthControls.push({health_id:health.manifest_entry.receipt_id,...health.manifest_entry,artifact_relative_path:path.relative(output,health.manifest_entry.path),binding:health.binding,test_spec:health.test_spec,task_kind:kind});
    if (healthResult.receipt.errors.length || healthResult.receipt.assertions.length!==healthTest.atom_ids.length || healthResult.receipt.assertions.some(a=>a.state!=='PASS')) throw new Error('Same-job actual reference/source browser health remains unconfirmed; no build FAIL attribution permitted');
    for (const test of selected) {
      const artifactDir = path.join(output, test.test_id); await fs.mkdir(artifactDir, { recursive: true });
      let proxy;
      try { proxy = await startProxy({ packageDir: resolve(config.packageDir), kind, files, interfacePath, artifactDir }); }
      catch(error) {
        if (!(error instanceof CandidatePackageError) || !/^[0-9a-f]{64}$/.test(config.candidatePackageSha256??'')) throw error;
        const entry = await buildRejectionReceipt({error,test,config,kind,binding:{...commonBinding,candidate_package_sha256:config.candidatePackageSha256},health,artifactDir});
        receipts.push({...entry,artifact_relative_path:path.relative(output,entry.path)});continue;
      }
      let context;
      try {
        context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const graphBinding = canonicalSha256({ manifest_sha256: proxy.build.manifest_sha256, source_files: proxy.build.source_files_read });
        const binding = { ...commonBinding,candidate_package_sha256: config.candidatePackageSha256 ?? graphBinding, candidate_bundle_sha256: proxy.build.bundle_sha256,test_plan_sha256:canonicalSha256(test) };
        await fs.writeFile(path.join(artifactDir, 'package-binding.json'), JSON.stringify({ ...binding, package_hash_definition: config.candidatePackageSha256 ? 'COORDINATOR_PROVIDED_FROZEN_PACKAGE_DIGEST' : 'MANIFEST_AND_COMPILED_UI_IMPORT_GRAPH_ONLY' }, null, 2));
        const result = await runAcceptanceTest({ page, proxy, test, kind, source, draft, binding, artifactDir, observe,
          fixtureReplacements: config.fixtureReplacements ?? {}, timeout: config.actionTimeoutMs ?? 5000 });
        receipts.push({ ...result.manifest_entry, artifact_relative_path: path.relative(output, result.manifest_entry.path) });
      } finally { if(context)await context.close(); await proxy.close(); }
    }
    instrumentation.status = 'BROWSER_RECEIPTS_RECORDED';
  } catch (error) { instrumentation.status = 'INSTRUMENTATION_UNAVAILABLE_OR_ABORTED'; instrumentation.errors.push({ message: error.message, observed_utc: new Date().toISOString() }); }
  finally { if (browser) await browser.close(); }
  const ended = { utc: new Date().toISOString(), monotonic_ms: performance.now() };
  const manifest = { version: 1, origin: 'TRUSTED_CI_RUNTIME', family: 'generative_ui', kind: kind === 'dashboard' ? 'create' : 'edit', native_counso_status: 'UNKNOWN', functional_pass: 'NOT_INFERRED',
    started, ended, instrumentation, receipts, health_controls:healthControls, provider_model: 'UNKNOWN', provider_tokens: 'UNKNOWN', provider_internal_timing: 'UNKNOWN', github_run_id: process.env.GITHUB_RUN_ID ?? 'UNKNOWN' };
  await fs.writeFile(path.join(output, 'ci-runtime-receipt.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) { console.log('node runtime/ci-run.mjs --config <trusted-config.json> (authorized GitHub Actions only; npm ci; approved official preinstalled Chrome channel, no browser download/fallback)'); }
  else { const i = process.argv.indexOf('--config'); if (i < 0 || !process.argv[i + 1]) throw new Error('--config required'); const file = path.resolve(process.argv[i + 1]); const result = await runCI(await json(file), path.dirname(file)); console.log(JSON.stringify({ status: result.instrumentation.status, receipt_count: result.receipts.length })); }
}
