/** Additive candidate-batch integration hook. Offline verification never imports
 * the compiler, server, browser runner, candidate module, or candidate config.
 * Preparation does not authorize publication or execution. Workflow authority is additive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BATCH_PATH = 'candidate-inputs/current-batch.json';
const ANCHOR_PATH = 'candidate-inputs/current-batch.sha256';
const OUTPUT_PATH = 'candidate-results';
const REPOSITORY = '0xMoji/counso-benchmark-reconstructed';
const JOB = 'candidate-ui';
const GITHUB_JOB = 'candidate_ui';
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
export const canonicalSha256 = value => sha(JSON.stringify(normalize(value)));
const same = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));

export async function boundedPath(root, name, {file = false} = {}) {
  root = path.resolve(root);
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe relative path');
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Symlink root forbidden');
  let target = root;
  for (const part of name.split('/')) {
    target = path.join(target, part);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Symlink forbidden'); }
    catch (error) { if (error.code !== 'ENOENT' || file) throw error; }
  }
  if (!target.startsWith(root + path.sep)) throw new Error('Path escapes root');
  if (file && !(await fs.stat(target)).isFile()) throw new Error('Declared file missing');
  return target;
}

export async function fileInventory(root) {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Static inventory directory required');
  const files = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink forbidden in registered files');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files[path.relative(root, target).split(path.sep).join('/')] = sha(await fs.readFile(target));
      else throw new Error('Nonstatic file forbidden');
    }
  }
  await visit(root);
  return files;
}

const TRANSPORT_ORIGIN = 'COORDINATOR_REGISTERED_CANDIDATE_CI_TRANSPORT';
const PREFIX = 'platform-screen-candidate';
const AUTHORITY_WORKFLOW = '.github/workflows/candidate-ui-acceptance.yml';
const ACTIVE_WORKFLOW = '.github/workflows/counso-platform-screen-candidate.yml';
const RUNTIME_SUBSET = ['acceptance-driver.mjs','acceptance-observer.mjs','candidate-observer.mjs','package-path.mjs','candidate-ci-entry.mjs','ci-run.mjs','compiler.mjs','model.mjs','runtime-data.ts','sdk.ts','server.mjs','package.json','package-lock.json','ui-interface.json','ui-scope.json','VENDOR_MANIFEST.json'];
const TRANSPORT_KEYS = ['schema_version','origin','adapter_version','benchmark_version','base_fingerprint','local_batch_sha256','execution_freeze','repository','deployment','browser','limits','authority_files','content_files','control_gate_sha256','candidates','references','publication'];
const SUBJECT_KEYS = ['subject_id','role','case_id','kind','output_dir','package_dir','package_sha256','response_sha256','raw_final_response_sha256','bundle_sha256','compile_preflight','registration','configs','test_matrix','full_delivery_package_sha256','executed_frontend_subset_sha256','frontend_subset_files'];
const CONFIG_KEYS = ['packageDir','fixtureDir','kind','artifactDir','interfacePath','scopePath','caseId','fixtureId','fixtureHashes','candidatePackageSha256','testIds','fixtureReplacements','actionTimeoutMs','observerModule','observerSha256','hostMetadata','registeredHealthControl','browserChannel','expectedChromeVersion'];
const CASES = {'G-UI-CREATE-M1':'dashboard','G-UI-EDIT-M1':'planner','G-UI-CREATE-C1':'dashboard','G-UI-EDIT-C1':'planner'};
const BASES = {'COUNSO-PLATFORM-SCREEN-0.4.0-control-v1':'90305b5a741f75c41fe595e100e1f4ca0a129f8c1c659fc8bc6d8c604aaed258','COUNSO-PLATFORM-SCREEN-0.4.0-control-v2':'96246266cdd18301a433d17e3586c19b9b35d0cc5aa8aeefec76a68e32870e42','COUNSO-PLATFORM-SCREEN-0.4.0-control-v3':'27999bbb8ac4a81ee57946752f59f3798abce3995aaedb435ec6754b55f2aad4','COUNSO-PLATFORM-SCREEN-0.4.0-control-v4':'5ba0c9645cb97ec29f4e60cd6a929e851c144bcf5060bc68dde57ecb73c94c6d'};
const exact = (value, keys, label) => {if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label} exact closed schema required`);};
const hashMap = (value, label, empty = false) => {if (!value || typeof value !== 'object' || Array.isArray(value) || (!empty && !Object.keys(value).length) || Object.values(value).some(h => !SHA.test(h ?? ''))) throw new Error(`${label} raw hash inventory required`);};

/** Closed remote subset admission. No Python/gold/raw final delivery is present.
 * Hash verification precedes static compiler import; static compilation never
 * executes a candidate module, handler, npm script, server or browser.
 */
export async function verifyTransport(root, batch, {compile = true} = {}) {
  exact(batch, TRANSPORT_KEYS, 'Candidate transport');
  if (batch.schema_version !== 1 || batch.origin !== TRANSPORT_ORIGIN || batch.adapter_version !== 'CANDIDATE-ADAPTER-SUBSET-3'
      || BASES[batch.benchmark_version] !== batch.base_fingerprint || batch.repository !== REPOSITORY) throw new Error('Reviewed candidate transport base/version mismatch');
  exact(batch.deployment, ['publication_authorized','expected_repository','expected_branch','repository_prefix','authority_workflow','active_workflow'], 'Publication deployment');
  if (typeof batch.deployment.publication_authorized !== 'boolean' || !same({...batch.deployment,publication_authorized:false}, {publication_authorized:false,expected_repository:REPOSITORY,expected_branch:'eval/counso-ui-probe',repository_prefix:PREFIX,authority_workflow:AUTHORITY_WORKFLOW,active_workflow:ACTIVE_WORKFLOW})) throw new Error('Fixed candidate publication target required');
  if (!same(batch.limits,{max_job_seconds:600,max_test_seconds:300,max_candidate_artifacts:2,max_planner_artifacts:1,max_configs:4,candidate_scripts_executed:false,max_browser_seconds:330})
      || !same(batch.browser,{channel:'chrome',expected_version:'154.0.8037.97',binary_sha256:'ACTUAL_RECORDED_NOT_YET_FROZEN'})
      || !SHA.test(batch.local_batch_sha256 ?? '') || !SHA.test(batch.control_gate_sha256 ?? '')) throw new Error('Fixed candidate budget/browser/local anchors required');
  if (!same(batch.execution_freeze?.grader_base_deltas,{'runtime/model.mjs':{before_sha256:'02f1030d60217d0875a685d40e1c566161df1881af19fbe9601aee3a04aff7de',after_sha256:'76ac3b2e88477a5a9fc01c1515e888b21017a9e4ab008ccd99eae530e44fd9e2',reason:'SHARED_TRUSTED_PACKAGE_NAMESPACE_FOR_READ_WRITE_FAULT_SOURCE_IDENTITY'},'runtime/acceptance-driver.mjs':{"before_sha256":"78b4da67b10cff61b7533be0db061011dcc5aa120983d6dbbdf160604fa48ea3","after_sha256":"adf3710298de61ebec7efb7d126546e13fb54d0f4f0e3c4f736a4757950e3405","reason":"BOUNDED_STABLE_CHART_DOM_PNG_HOST_AND_VISIBLE_INPUT_CAPTURE"}})) throw new Error('Fixed audited grader-only namespace delta required');
  if (batch.deployment.publication_authorized) {
    exact(batch.publication, ['local_batch_sha256','execution_fingerprint','control_gate_sha256','reviewed_authority_sha256','source_review_observation','publisher_observation','repository','branch','repository_prefix','active_workflow'], 'Independent publisher admission');
    const p = batch.publication;
    if (batch.execution_freeze?.mode !== 'COMBINED_VERIFIED' || p.local_batch_sha256 !== batch.local_batch_sha256 || p.execution_fingerprint !== batch.execution_freeze.execution_fingerprint
        || p.control_gate_sha256 !== batch.control_gate_sha256 || p.reviewed_authority_sha256 !== canonicalSha256(batch.authority_files)
        || !/^ob-[0-9a-f]{16,64}$/.test(p.source_review_observation ?? '') || !/^ob-[0-9a-f]{16,64}$/.test(p.publisher_observation ?? '')
        || p.repository !== REPOSITORY || p.branch !== 'eval/counso-ui-probe' || p.repository_prefix !== PREFIX || p.active_workflow !== ACTIVE_WORKFLOW) throw new Error('Reviewed source/publisher admission mismatch');
  } else if (batch.publication !== null) throw new Error('Disabled preview cannot claim publisher admission');
  hashMap(batch.authority_files, 'Runtime authority'); hashMap(batch.content_files, 'Execution content');
  if(batch.authority_files['runtime/model.mjs']!==batch.execution_freeze.grader_base_deltas['runtime/model.mjs'].after_sha256||batch.authority_files['runtime/acceptance-driver.mjs']!==batch.execution_freeze.grader_base_deltas['runtime/acceptance-driver.mjs'].after_sha256||batch.authority_files['runtime/package-path.mjs']!=='02630cc35fd18381b663447e7fb8ddc7ddcf9902d9cc3dc793a0376259c3bdf7')throw new Error('Shared normalizer/model source must match exact audited delta');
  const vendors = Object.keys(await fileInventory(await boundedPath(root,'runtime/vendor'))).map(n => 'runtime/vendor/'+n);
  const expectedAuthority = ['VERSION',AUTHORITY_WORKFLOW,...RUNTIME_SUBSET.map(n => 'runtime/'+n),...vendors].sort();
  if (!same(Object.keys(batch.authority_files).sort(),expectedAuthority)) throw new Error('Fixed official runtime subset authority required');
  if ((await fs.readFile(await boundedPath(root,'VERSION',{file:true}),'utf8')).trim() !== batch.benchmark_version) throw new Error('Transport VERSION bytes mismatch');
  for (const [name,h] of Object.entries({...batch.authority_files,...batch.content_files})) {
    if (Object.hasOwn(batch.authority_files,name) && Object.hasOwn(batch.content_files,name)) throw new Error('Authority/content overlap');
    if (!Object.hasOwn(batch.authority_files,name) && (!name.startsWith('candidate-inputs/') || [BATCH_PATH,ANCHOR_PATH].includes(name) || /\/(objective|raw-final)\//.test(name))) throw new Error('Local chat/E0/gold/Python forbidden in remote transport');
    const raw = await fs.readFile(await boundedPath(root,name,{file:true}));
    if (sha(raw) !== h) throw new Error('Execution subset raw hash mismatch: '+name);
  }
  // Official npm-installed dependency topology is excluded, never candidate supplied.
  const actual = {};
  async function walk(dir,prefix='') {
    for (const ent of await fs.readdir(dir,{withFileTypes:true})) {
      const name = prefix+ent.name;
      if (['runtime/node_modules','candidate-results'].includes(name)) continue;
      if ([BATCH_PATH,ANCHOR_PATH].includes(name)) continue;
      const f=path.join(dir,ent.name);
      if (ent.isSymbolicLink()) throw new Error('Execution source symlink forbidden');
      if (ent.isDirectory()) await walk(f,name+'/');
      else if(ent.isFile()) actual[name]=sha(await fs.readFile(f));
      else throw new Error('Nonstatic execution source forbidden');
    }
  }
  await walk(root);
  if (!same(actual,{...batch.authority_files,...batch.content_files})) throw new Error('Exhaustive execution subset mismatch (extra/missing source)');
  if (!Array.isArray(batch.candidates) || !batch.candidates.length || batch.candidates.length > 2 || batch.candidates.filter(s=>s.kind==='planner').length>1 || new Set(batch.candidates.map(s=>s.subject_id)).size !== batch.candidates.length
      || !Array.isArray(batch.references) || batch.references.length !== new Set(batch.candidates.map(s=>s.case_id)).size) throw new Error('At most two anonymously registered artifacts with same-case references required');
  const usedContent = new Set(); const usedRefs = new Set();
  let compiler, driver;
  if (compile) { compiler=await import('./compiler.mjs'); driver=await import('./acceptance-driver.mjs'); }
  for (const s of batch.candidates) {
    exact(s,SUBJECT_KEYS,'Transport candidate');hashMap(s.frontend_subset_files,'Executed frontend',true);
    exact(s.registration,['anonymous_run_id','case_id','public_input_sha256','output_files','raw_final_response_sha256','run_origin','failure_origin','source_observation','execution_fingerprint','native_generation_fingerprint'],'Parent anonymous registration');
    if(s.registration.run_origin!=='NEW_NATIVE_AGENT'||!['NONE','MODEL','INFRA_AMBIGUOUS','UNKNOWN','PROTOCOL_CONTAMINATION'].includes(s.registration.failure_origin)||!/^ob-[0-9a-f]{16,64}$/.test(s.registration.source_observation??'')||s.registration.execution_fingerprint!==batch.execution_freeze.execution_fingerprint||![batch.execution_freeze.execution_fingerprint,...(batch.benchmark_version==='COUNSO-PLATFORM-SCREEN-0.4.0-control-v4'?[batch.base_fingerprint]:[])].includes(s.registration.native_generation_fingerprint)||!SHA.test(s.registration.public_input_sha256??''))throw new Error('Anonymous native origin/execution binding required');
    exact(s.compile_preflight,['state','diagnostic','error','compiled_graph'],'Compiler preflight');
    const pre=s.compile_preflight;
    if(pre.state==='COMPILED'){
      exact(pre.compiled_graph,['manifest_sha256','graph_sha256','source_files_read'],'Compiler UI import graph');hashMap(pre.compiled_graph.source_files_read,'Compiler UI graph reads');
      if(pre.diagnostic!==null||pre.error!==null||!SHA.test(s.bundle_sha256??'')||pre.compiled_graph.manifest_sha256!==s.frontend_subset_files['manifest.json']||!SHA.test(pre.compiled_graph.graph_sha256??'')||Object.entries(pre.compiled_graph.source_files_read).some(([n,h])=>s.frontend_subset_files[n]!==h))throw new Error('Prepared UI graph must match transported raw source/manifest');
    }else if(pre.state==='CANDIDATE_PACKAGE_REJECTED'){
      exact(pre.diagnostic,['schema_version','origin','code','source_file','line','column','reason','source_sha256','phase'],'Typed source diagnostic');const d=pre.diagnostic;
      if(s.bundle_sha256!==null||pre.compiled_graph!==null||pre.error!==null||d.schema_version!==1||d.origin!=='TRUSTED_COMPILER_INPUT_GUARD'||d.phase!=='PRE_EXECUTION_SOURCE_VALIDATION'||!['INVALID_TSX','PROHIBITED_IMPORT','MISSING_ENTRY'].includes(d.code)||typeof d.reason!=='string'||!d.reason)throw new Error('Closed fail-only typed compiler diagnostic required');
      await boundedPath(await boundedPath(root,s.package_dir),d.source_file);
      if(d.code==='MISSING_ENTRY'?(Object.hasOwn(s.frontend_subset_files,d.source_file)||d.source_sha256!==null):(s.frontend_subset_files[d.source_file]!==d.source_sha256||!Number.isInteger(d.line)||d.line<1))throw new Error('Typed compiler diagnostic must bind actual transported source');
    }else if(pre.state==='UNKNOWN'){
      exact(pre.error,['name','message','failure_origin'],'Unknown compiler infrastructure');if(s.bundle_sha256!==null||pre.compiled_graph!==null||pre.diagnostic!==null||pre.error.failure_origin!=='UNKNOWN')throw new Error('Infrastructure ambiguity cannot acquire a model zero/bundle');
    }else throw new Error('Closed compiler classification required');

    if (!/^u-[a-z0-9]{8,32}$/.test(s.subject_id) || s.role !== 'CANDIDATE' || CASES[s.case_id] !== s.kind
        || s.output_dir !== `candidate-inputs/packages/${s.subject_id}` || s.package_dir !== s.output_dir+'/frame'
        || s.package_sha256 !== s.full_delivery_package_sha256 || !SHA.test(s.full_delivery_package_sha256 ?? '')
        || !same(await fileInventory(await boundedPath(root,s.package_dir)),s.frontend_subset_files)
        || canonicalSha256(s.frontend_subset_files) !== s.executed_frontend_subset_sha256
        || s.registration?.anonymous_run_id !== s.subject_id || s.registration?.case_id !== s.case_id
        || s.registration?.raw_final_response_sha256 !== s.raw_final_response_sha256 || !SHA.test(s.raw_final_response_sha256 ?? '')
        || !Array.isArray(s.configs) || !same(s.configs.map(e=>e.fixture_id),['primary','unseen_same_schema'])) throw new Error('Same-artifact anonymous full-delivery/frontend dual binding mismatch');
    const ref=batch.references.find(r=>r.case_id===s.case_id);
    exact(ref,['reference_id','case_id','kind','package_dir','package_files','package_sha256','bundle_sha256','fixture_plans'],'Same-case reference');
    if (!ref || ref.reference_id !== 'ref-'+s.case_id.toLowerCase() || ref.kind !== s.kind || ref.package_dir !== 'candidate-inputs/references/'+ref.reference_id+'/frame'
        || !same(await fileInventory(await boundedPath(root,ref.package_dir)),ref.package_files) || canonicalSha256(ref.package_files) !== ref.package_sha256 || !SHA.test(ref.bundle_sha256 ?? '')) throw new Error('Actual health must use exact same-case official reference');
    for (const n of Object.keys(ref.package_files)) usedContent.add(ref.package_dir+'/'+n);
    for (const n of Object.keys(s.frontend_subset_files)) usedContent.add(s.package_dir+'/'+n);
    if (s.response_sha256 !== null) {const n=s.output_dir+'/response.json';if(sha(await fs.readFile(await boundedPath(root,n,{file:true}))) !== s.response_sha256)throw new Error('Original delivered response changed');usedContent.add(n);}
    if (compile) {
      try {
        const built=await compiler.compileFrame(await boundedPath(root,s.package_dir));
        const graph={manifest_sha256:built.evidence.manifest_sha256,graph_sha256:built.evidence.graph_sha256,source_files_read:built.evidence.source_files_read};
        if (s.compile_preflight.state !== 'COMPILED' || built.evidence.bundle_sha256 !== s.bundle_sha256 || !same(graph,s.compile_preflight.compiled_graph)) throw new Error('INFRA/UNKNOWN: remote UI import graph/manifest/bundle differs from local preflight');
      } catch(error) {
        if (!(error instanceof compiler.CandidatePackageError) || s.compile_preflight.state !== 'CANDIDATE_PACKAGE_REJECTED' || !same(error.diagnostic,s.compile_preflight.diagnostic) || s.bundle_sha256 !== null) {
          if (s.compile_preflight.state !== 'UNKNOWN') throw error;
          // Ambiguous infrastructure/manifest stays UNKNOWN; no text classification.
        }
      }
      if (!usedRefs.has(ref.reference_id)) {const built=await compiler.compileFrame(await boundedPath(root,ref.package_dir));if(built.evidence.bundle_sha256 !== ref.bundle_sha256)throw new Error('Same-case official health bundle changed');usedRefs.add(ref.reference_id);}
    }
    for (const e of s.configs) {
      exact(e,['config_path','config_sha256','fixture_id','fixture_files','fixture_sha256','test_ids','test_plan_sha256'],'Coordinator config entry');
      if (e.config_path !== `candidate-inputs/configs/${s.subject_id}/${e.fixture_id}.json`)throw new Error('Fixed coordinator config path required');
      const {payload:c}=await readHashed(root,e.config_path,e.config_sha256,'Coordinator config');exact(c,CONFIG_KEYS,'Coordinator config');usedContent.add(e.config_path);
      if (c.packageDir !== s.package_dir || c.fixtureDir !== `candidate-inputs/fixtures/${s.subject_id}/${e.fixture_id}` || c.kind !== s.kind || c.caseId !== s.case_id || c.fixtureId !== e.fixture_id
          || c.artifactDir !== `candidate-results/${s.subject_id}/${e.fixture_id}` || c.interfacePath !== 'runtime/ui-interface.json' || c.scopePath !== 'runtime/ui-scope.json'
          || c.observerModule !== 'runtime/candidate-observer.mjs' || c.observerSha256 !== batch.authority_files[c.observerModule] || c.actionTimeoutMs !== 5000
          || c.browserChannel !== 'chrome' || c.expectedChromeVersion !== batch.browser.expected_version || c.candidatePackageSha256 !== s.package_sha256 || !same(c.testIds,e.test_ids)
          || !same(await fileInventory(await boundedPath(root,c.fixtureDir)),e.fixture_files) || canonicalSha256({files:e.fixture_files,host_metadata:c.hostMetadata}) !== e.fixture_sha256
          || !same(c.fixtureHashes,{[e.fixture_id]:e.fixture_sha256})) throw new Error('Fixed source/fixture/module/plan/candidate config binding mismatch');
      for(const n of Object.keys(e.fixture_files))usedContent.add(c.fixtureDir+'/'+n);
      exact(c.registeredHealthControl,['packageDir','packageSha256','bundleSha256','fixtureDir','fixtureSha256','hostMetadata','baselineTestId','baselineTestPlanSha256'],'Same-case health config');
      const h=c.registeredHealthControl;
      if(h.packageDir!==ref.package_dir||h.packageSha256!==ref.package_sha256||h.bundleSha256!==ref.bundle_sha256||h.fixtureDir!==c.fixtureDir||h.fixtureSha256!==e.fixture_sha256||!same(h.hostMetadata,c.hostMetadata))throw new Error('Same-case reference health must share actual fixture and host metadata');
      if(compile){const source=JSON.parse(await fs.readFile(await boundedPath(root,c.fixtureDir+'/'+(s.kind==='dashboard'?'dataset.json':'resources.json'),{file:true}),'utf8'));const draft=s.kind==='planner'?JSON.parse(await fs.readFile(await boundedPath(root,c.fixtureDir+'/draft.json',{file:true}),'utf8')):null;const plans=driver.buildTestPlan(s.kind,source,draft,e.fixture_id);if(!same(plans.map(t=>t.test_id),e.test_ids)||plans.some(t=>canonicalSha256(t)!==e.test_plan_sha256[t.test_id])||!plans.some(t=>t.test_id===h.baselineTestId&&canonicalSha256(t)===h.baselineTestPlanSha256))throw new Error('Unchanged official driver/test-plan mismatch');}
    }
  }
  if(!same([...usedContent].sort(),Object.keys(batch.content_files).sort()))throw new Error('Unregistered execution content outside fixed frontend/fixture/config subset');
  return batch;
}

/** The Python verifier owns exhaustive schema, frozen-base, package/fixture,
 * same-case official reference, configuration, and maximum-batch checks.
 * root is a library test seam; the CLI and execution hook always use ROOT.
 */
export async function verifyBatch(root = ROOT, {requireGit = false, environment = process.env} = {}) {
  const batchFile = await boundedPath(root, BATCH_PATH, {file: true});
  const anchorFile = await boundedPath(root, ANCHOR_PATH, {file: true});
  const raw = await fs.readFile(batchFile);
  const anchorRaw = await fs.readFile(anchorFile);
  const expected = anchorRaw.toString('utf8').trim();
  if (!SHA.test(expected) || sha(raw) !== expected) throw new Error('Coordinator candidate batch anchor mismatch');
  // Fixed module and fixed CLI only. This operation is offline static validation.
  const decoded = JSON.parse(raw);
  if (decoded.origin === TRANSPORT_ORIGIN) await verifyTransport(root,decoded);
  else execFileSync('python3', ['-m', 'platform_screen.candidate_ci_batch', '--verify'], {cwd: root});
  if (!(await fs.readFile(batchFile)).equals(raw) || !(await fs.readFile(anchorFile)).equals(anchorRaw))
    throw new Error('Candidate batch anchor changed during offline verification');
  const batch = JSON.parse(raw);
  if (requireGit) await verifyRunnerRegistration(root, batch, environment);
  return {batch, batch_sha256: expected};
}

/** Pure registration guard: no imports with browser/candidate execution. An
 * authorized deployment must be reviewed and committed before this can pass.
 */
export async function verifyRunnerRegistration(root, batch, environment = process.env) {
  const deployment = batch.deployment;
  if (deployment?.publication_authorized !== true) throw new Error('Candidate publication/execution has not been authorized');
  const branch = deployment.expected_branch;
  if (deployment.expected_repository !== REPOSITORY || typeof branch !== 'string' || !branch
      || branch === 'LOCAL_UNPUBLISHED' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock'))
    throw new Error('Reviewed candidate deployment repository/branch required');
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_JOB !== GITHUB_JOB
      || environment.GITHUB_REPOSITORY !== REPOSITORY || environment.GITHUB_REF !== `refs/heads/${branch}`
      || !COMMIT.test(environment.GITHUB_SHA ?? '') || environment.CI_EVIDENCE_COMMIT !== environment.GITHUB_SHA
      || !POSITIVE_INTEGER.test(environment.GITHUB_RUN_ID ?? '') || environment.CI_EVIDENCE_RUN_ID !== environment.GITHUB_RUN_ID
      || !POSITIVE_INTEGER.test(environment.GITHUB_RUN_ATTEMPT ?? ''))
    throw new Error('Independent candidate runner commit/repository/ref/job mismatch');
  // The Actions service supplies this event document. A fork/PR/public caller
  // cannot register evidence merely by presenting a candidate JSON trust flag.
  if (!environment.GITHUB_EVENT_PATH || !environment.GITHUB_ACTOR || !['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME))
    throw new Error('Private repository caller event unavailable');
  const event = JSON.parse(await fs.readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.private !== true || event.repository?.full_name !== REPOSITORY
      || event.sender?.login !== environment.GITHUB_ACTOR || event.pull_request)
    throw new Error('Private repository caller guard mismatch');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  if (commit !== environment.GITHUB_SHA) throw new Error('Checked-out Git HEAD differs from independent runner commit');
  const transport = batch.origin === TRANSPORT_ORIGIN;
  const prefix = transport ? PREFIX + '/' : '';
  if (transport && branch !== 'eval/counso-ui-probe') throw new Error('Fixed candidate branch required');
  const names = transport ? [...Object.keys(batch.authority_files),...Object.keys(batch.content_files),BATCH_PATH,ANCHOR_PATH] : [BATCH_PATH,ANCHOR_PATH];
  for (const name of names) {
    const committed = Buffer.from(execFileSync('git', ['show', `HEAD:${prefix}${name}`], {cwd: root}));
    if (!committed.equals(await fs.readFile(await boundedPath(root, name, {file: true}))))
      throw new Error('Candidate batch anchor is not the checked-out commit bytes');
  }
  if (transport) {
    const active = Buffer.from(execFileSync('git',['show',`HEAD:${ACTIVE_WORKFLOW}`],{cwd:root}));
    if (!active.equals(await fs.readFile(await boundedPath(root,AUTHORITY_WORKFLOW,{file:true})))) throw new Error('Root candidate workflow differs from registered authority bytes');
  }
  return {repository: REPOSITORY, branch, commit};
}

async function readHashed(root, name, expected, label) {
  if (!SHA.test(expected ?? '')) throw new Error(`${label} registered hash unavailable`);
  const raw = await fs.readFile(await boundedPath(root, name, {file: true}));
  if (sha(raw) !== expected) throw new Error(`${label} hash mismatch`);
  return {raw, payload: JSON.parse(raw)};
}

/** Closed attribution check shared with offline synthetic controls. UNKNOWN
 * compilation can preserve observations but cannot acquire browser PASS trust.
 */
export function validateCandidatePayload(subject, registration, plan, payload, health) {
  if (payload.task_kind !== subject.kind || payload.case_id !== subject.case_id
      || payload.test_id !== plan.test_id || payload.fixture_id !== registration.fixture_id
      || payload.fixture_sha256 !== registration.fixture_sha256 || payload.schedule_id !== plan.schedule_id
      || payload.test_plan_sha256 !== registration.test_plan_sha256[plan.test_id]
      || payload.candidate_package_sha256 !== subject.package_sha256
      || !Array.isArray(payload.assertions) || !same(payload.assertions.map(item => item.atom_id).sort(), [...plan.atom_ids].sort())
      || payload.assertions.some(item => !['PASS', 'FAIL', 'UNKNOWN'].includes(item.state)))
    throw new Error('Actual receipt typed package/fixture/plan/assertion mismatch');
  const state = subject.compile_preflight?.state;
  if (state === 'CANDIDATE_PACKAGE_REJECTED') {
    if (payload.origin !== 'TRUSTED_CANDIDATE_BUILD_REJECTION' || payload.execution !== 'verified_build_rejection'
        || payload.actual_browser_executed !== false || payload.candidate_bundle_sha256 !== null
        || subject.bundle_sha256 !== null || !same(payload.diagnostic, subject.compile_preflight.diagnostic)
        || payload.assertions.some(item => item.state !== 'FAIL' || item.failure_class !== 'unusable_package')
        || !health || payload.health_control_receipt_id !== health.receipt_id || payload.health_control_receipt_sha256 !== health.sha256)
      throw new Error('Known source rejection differs from frozen diagnostic or actual healthy control');
    return {state: 'VERIFIED_BUILD_REJECTION', browser_pass_eligible: false};
  }
  if (state === 'COMPILED') {
    if (payload.origin !== 'TRUSTED_BROWSER_OBSERVER' || payload.execution !== 'actual_browser'
        || payload.actual_browser_executed !== true || !SHA.test(subject.bundle_sha256 ?? '')
        || payload.candidate_bundle_sha256 !== subject.bundle_sha256 || !Array.isArray(payload.errors))
      throw new Error('Actual browser receipt differs from fixed compiled bundle');
    if (payload.errors.length && payload.assertions.some(a=>a.state==='PASS')) throw new Error('Interrupted candidate observer cannot assert functional PASS');
    const incomplete=payload.errors.length>0||payload.assertions.some(a=>a.state==='UNKNOWN');
    return {state: incomplete?'BOUND_BROWSER_INCOMPLETE':'BOUND_BROWSER_OBSERVATION', browser_pass_eligible: !incomplete, evaluator_errors: payload.errors};
  }
  if (state === 'UNKNOWN' && subject.bundle_sha256 === null) {
    const browser = payload.origin === 'TRUSTED_BROWSER_OBSERVER' && payload.execution === 'actual_browser'
      && payload.actual_browser_executed === true && SHA.test(payload.candidate_bundle_sha256 ?? '') && Array.isArray(payload.errors);
    const rejection = payload.origin === 'TRUSTED_CANDIDATE_BUILD_REJECTION' && payload.execution === 'verified_build_rejection'
      && payload.actual_browser_executed === false && payload.candidate_bundle_sha256 === null
      && payload.assertions.every(item => item.state === 'FAIL' && item.failure_class === 'unusable_package')
      && health && payload.health_control_receipt_id === health.receipt_id && payload.health_control_receipt_sha256 === health.sha256;
    if (!browser && !rejection) throw new Error('Unknown preflight does not permit an untyped execution payload');
    return {state: 'COMPILE_PREFLIGHT_UNKNOWN', browser_pass_eligible: false};
  }
  throw new Error('Registered compile preflight state unavailable');
}

async function verifyObservationFiles(root, receiptPath, payload) {
  if (!Array.isArray(payload.observations)) throw new Error('Actual receipt observation inventory unavailable');
  const required = payload.origin === 'TRUSTED_BROWSER_OBSERVER' ? ['visible_dom', 'screenshot', 'host_ledger', 'network_ledger']
    : payload.origin === 'TRUSTED_CANDIDATE_BUILD_REJECTION' ? ['build_diagnostic'] : [];
  if (!required.length || required.some(kind => !payload.observations.some(observation => observation?.kind === kind
      && typeof observation.file === 'string' && SHA.test(observation.sha256 ?? ''))))
    throw new Error('Required actual raw observer evidence files unavailable');
  for (const observation of payload.observations) {
    if (Object.hasOwn(observation, 'file')) {
      if (typeof observation.file !== 'string' || !SHA.test(observation.sha256 ?? '')) throw new Error('Malformed observation file binding');
      // Validate the unnormalized relative path first; path.join must not erase traversal.
      await boundedPath(path.dirname(await boundedPath(root, receiptPath, {file: true})), observation.file, {file: true});
      const raw = await fs.readFile(await boundedPath(root, path.posix.dirname(receiptPath) + '/' + observation.file, {file: true}));
      if (sha(raw) !== observation.sha256) throw new Error('Actual observation file hash mismatch');
      if (observation.kind === 'build_diagnostic' && (observation.capture_method !== 'trusted_typed_compiler'
          || !same(JSON.parse(raw), payload.diagnostic))) throw new Error('Actual raw compiler diagnostic differs from typed receipt');
    }
  }
}

export async function verifyRuntimeEvidence(root, batch, subject, registration, config, plans, runtime, environment = process.env) {
  if (runtime.origin !== 'TRUSTED_CI_RUNTIME' || runtime.instrumentation?.status !== 'BROWSER_RECEIPTS_RECORDED'
      || runtime.github_run_id !== environment.GITHUB_RUN_ID || !Array.isArray(runtime.receipts) || !Array.isArray(runtime.health_controls))
    throw new Error('Browser instrumentation incomplete; preserve UNKNOWN');
  const provenance = runtime.instrumentation.browser_provenance;
  if (provenance?.channel !== 'chrome' || provenance.version !== config.expectedChromeVersion
      || runtime.instrumentation.browser !== config.expectedChromeVersion || !SHA.test(provenance.binary_sha256 ?? ''))
    throw new Error('Actual approved browser provenance unavailable');
  const bindings = {case_id: subject.case_id, interface_sha256: batch.authority_files['runtime/ui-interface.json'],
    scope_sha256: batch.authority_files['runtime/ui-scope.json'], observer_sha256: batch.authority_files['runtime/candidate-observer.mjs'],
    compiler_sha256: batch.authority_files['runtime/compiler.mjs'], dependencies_sha256: batch.authority_files['runtime/package-lock.json'],
    ci_job_id: `${environment.GITHUB_RUN_ID}:${environment.GITHUB_RUN_ATTEMPT}:${GITHUB_JOB}`, github_run_id: environment.GITHUB_RUN_ID,
    browser_binary_sha256: provenance.binary_sha256, runner_image_sha256: canonicalSha256(provenance.runner_image)};
  const checkBindings = payload => {
    if (Object.entries(bindings).some(([key, value]) => typeof value !== 'string' || payload[key] !== value))
      throw new Error('Actual receipt independent same-job authority mismatch');
  };
  const control = config.registeredHealthControl;
  if (runtime.health_controls.length !== 1) throw new Error('Exactly one actual same-case reference health control required');
  const healthEntry = runtime.health_controls[0];
  await boundedPath(await boundedPath(root, config.artifactDir), healthEntry.artifact_relative_path, {file: true});
  const healthPath = config.artifactDir + '/' + healthEntry.artifact_relative_path;
  const {payload: healthPayload} = await readHashed(root, healthPath, healthEntry.sha256, 'Reference health receipt');
  const baseline = plans.find(plan => plan.test_id === control.baselineTestId);
  if (!baseline || canonicalSha256(baseline) !== control.baselineTestPlanSha256
      || healthPayload.origin !== 'TRUSTED_BROWSER_OBSERVER' || healthPayload.execution !== 'actual_browser' || healthPayload.actual_browser_executed !== true
      || healthEntry.receipt_id !== healthPayload.receipt_id || healthEntry.health_id !== healthPayload.receipt_id
      || healthEntry.task_kind !== subject.kind || typeof healthPayload.session_id !== 'string' || !healthPayload.session_id
      || healthPayload.task_kind !== subject.kind || healthPayload.test_id !== control.baselineTestId
      || healthPayload.test_plan_sha256 !== control.baselineTestPlanSha256 || healthPayload.schedule_id !== baseline.schedule_id
      || healthPayload.candidate_package_sha256 !== control.packageSha256 || healthPayload.candidate_bundle_sha256 !== control.bundleSha256
      || healthPayload.fixture_id !== registration.fixture_id || healthPayload.fixture_sha256 !== registration.fixture_sha256
      || !Array.isArray(healthPayload.errors) || healthPayload.errors.length || !Array.isArray(healthPayload.assertions)
      || !same(healthPayload.assertions.map(item => item.atom_id).sort(), [...baseline.atom_ids].sort())
      || healthPayload.assertions.some(item => item.state !== 'PASS'))
    throw new Error('Actual same-case reference/source health unconfirmed; no candidate attribution permitted');
  checkBindings(healthPayload);
  const healthBindings = {...bindings, candidate_package_sha256: control.packageSha256, candidate_bundle_sha256: control.bundleSha256,
    fixtures: {[registration.fixture_id]: registration.fixture_sha256}, session_ids: [healthPayload.session_id], test_plan_sha256: control.baselineTestPlanSha256};
  if (Object.entries(healthBindings).some(([key, value]) => !same(healthEntry.binding?.[key], value))
      || Object.entries(baseline).some(([key, value]) => !same(healthEntry.test_spec?.[key], value)))
    throw new Error('Actual reference health binding/action-plan registration mismatch');
  await verifyObservationFiles(root, healthPath, healthPayload);
  if(batch.origin===TRANSPORT_ORIGIN){
    const dir=path.posix.dirname(healthPath),ref=batch.references.find(r=>r.case_id===subject.case_id);
    const evidence=JSON.parse(await fs.readFile(await boundedPath(root,dir+'/build-evidence.json',{file:true}),'utf8'));
    const bundle=await fs.readFile(await boundedPath(root,dir+'/candidate.bundle.js',{file:true}));
    if(evidence.manifest_sha256!==ref.package_files['manifest.json']||evidence.bundle_sha256!==ref.bundle_sha256||sha(bundle)!==ref.bundle_sha256||!evidence.source_files_read||Object.entries(evidence.source_files_read).some(([n,h])=>ref.package_files[n]!==h))throw new Error('INFRA/UNKNOWN: actual same-case health build differs from official reference source/bundle');
  }
  const health = {receipt_id: healthPayload.receipt_id, sha256: healthEntry.sha256};
  const tests = new Set();
  const dispositions = [];
  for (const entry of runtime.receipts) {
    await boundedPath(await boundedPath(root, config.artifactDir), entry.artifact_relative_path, {file: true});
    const receiptPath = config.artifactDir + '/' + entry.artifact_relative_path;
    const {payload} = await readHashed(root, receiptPath, entry.sha256, 'Candidate receipt');
    const plan = plans.find(item => item.test_id === payload.test_id);
    if (!plan || !registration.test_ids.includes(payload.test_id) || tests.has(payload.test_id) || entry.receipt_id !== payload.receipt_id)
      throw new Error('Duplicate or unregistered actual test receipt');
    checkBindings(payload);
    dispositions.push({test_id: payload.test_id, ...validateCandidatePayload(subject, registration, plan, payload, health)});
    if(batch.origin===TRANSPORT_ORIGIN && subject.compile_preflight.state==='COMPILED') {
      const dir=path.posix.dirname(receiptPath), graph=subject.compile_preflight.compiled_graph;
      const evidence=JSON.parse(await fs.readFile(await boundedPath(root,dir+'/build-evidence.json',{file:true}),'utf8'));
      const bundle=await fs.readFile(await boundedPath(root,dir+'/candidate.bundle.js',{file:true}));
      if(Object.entries(graph).some(([k,v])=>!same(evidence[k],v))||evidence.bundle_sha256!==subject.bundle_sha256||sha(bundle)!==subject.bundle_sha256)throw new Error('INFRA/UNKNOWN: actual browser import graph/manifest/bundle differs from local preflight');
    }
    await verifyObservationFiles(root, receiptPath, payload);
    tests.add(payload.test_id);
  }
  if (tests.size !== registration.test_ids.length) throw new Error('Incomplete actual candidate receipt coverage');
  return dispositions;
}

export async function runBatch(job) {
  if (job !== JOB || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Only --job candidate-ui on a later-authorized GitHub runner may execute; no local browser/server fallback');
  const {batch, batch_sha256} = await verifyBatch(ROOT, {requireGit: true});
  if (batch.origin !== TRANSPORT_ORIGIN) throw new Error('Only reviewed execution-subset transport can run; local complete gold/raw delivery never publishes');
  // Both imports are unreachable for every locally prepared unpublished batch.
  const {runCI} = await import('./ci-run.mjs');
  const {buildTestPlan} = await import('./acceptance-driver.mjs');
  const output = await boundedPath(ROOT, OUTPUT_PATH);
  try { await fs.mkdir(output); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Fresh candidate job evidence directory required'); throw error; }
  const started = {utc: new Date().toISOString(), monotonic_ms: performance.now()};
  const configs = [], errors = [];
  let finalStatus = 'UNKNOWN', gap = false;
  let writes = Promise.resolve();
  const persist = status => writes = writes.then(async () => {
    const files = await fileInventory(output);
    delete files['batch-receipt.json'];
    const manifest = {schema_version: 1, origin: 'TRUSTED_CANDIDATE_CI_BATCH_ENTRY', repository: REPOSITORY,
      branch: batch.deployment.expected_branch, github_commit: process.env.GITHUB_SHA, github_run_id: process.env.GITHUB_RUN_ID,
      github_run_attempt: process.env.GITHUB_RUN_ATTEMPT, github_job: GITHUB_JOB, job: JOB, batch_sha256: batch.local_batch_sha256, transport_batch_sha256: batch_sha256,
      frontend_bindings: batch.candidates.map(s=>({subject_id:s.subject_id,full_delivery_package_sha256:s.full_delivery_package_sha256,executed_frontend_subset_sha256:s.executed_frontend_subset_sha256,full_delivery_replay:'LOCAL_ONLY_HASH_BOUND',frontend_replay:'ACTUAL_REMOTE_STATIC_SUBSET'})), started,
      ended: {utc: new Date().toISOString(), monotonic_ms: performance.now()}, status, configs, errors, files,
      browser_clock: 'EVALUATOR_BROWSER_ONLY', model_clock: 'SEPARATE_COORDINATOR_REGISTRATION', native_counso: 'UNKNOWN', functional_pass: 'NOT_INFERRED'};
    await fs.writeFile(path.join(output, 'batch-receipt.json'), JSON.stringify(manifest, null, 2) + '\n');
  });
  const onTerm = () => {
    errors.push({message: 'Actual SIGTERM observed at candidate CI timeout/executor boundary; origin remains infrastructure/coordinator', utc: new Date().toISOString()});
    persist('COORDINATOR_TIMEOUT_CI_JOB').finally(() => process.exit(143));
  };
  process.once('SIGTERM', onTerm);
  // A real coordinator timeout creates an infrastructure gap, never a candidate
  // FAIL. These fixed ceilings are independently checked by the Python verifier.
  const jobTimer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), batch.limits.max_browser_seconds * 1000);
  let configTimer;
  try {
    await persist('PARTIAL');
    for (const subject of batch.candidates) {
      for (const registration of subject.configs) {
        const {payload: config} = await readHashed(ROOT, registration.config_path, registration.config_sha256, 'Registered config');
        if (config.packageDir !== subject.package_dir || config.candidatePackageSha256 !== subject.package_sha256
            || config.kind !== subject.kind || config.caseId !== subject.case_id || config.fixtureId !== registration.fixture_id
            || config.artifactDir !== `${OUTPUT_PATH}/${subject.subject_id}/${registration.fixture_id}` || !same(config.testIds, registration.test_ids))
          throw new Error('Per-config fixed package/case/fixture/output binding mismatch');
        if (canonicalSha256(await fileInventory(await boundedPath(ROOT, subject.package_dir))) !== subject.executed_frontend_subset_sha256)
          throw new Error('Registered candidate package changed before browser entry');
        const source = JSON.parse(await fs.readFile(await boundedPath(ROOT, config.fixtureDir + '/' + (subject.kind === 'dashboard' ? 'dataset.json' : 'resources.json'), {file: true}), 'utf8'));
        const draft = subject.kind === 'planner' ? JSON.parse(await fs.readFile(await boundedPath(ROOT, config.fixtureDir + '/draft.json', {file: true}), 'utf8')) : null;
        const plans = buildTestPlan(subject.kind, source, draft, registration.fixture_id);
        for (const id of registration.test_ids) {
          const plan = plans.find(item => item.test_id === id);
          if (!plan || canonicalSha256(plan) !== registration.test_plan_sha256[id]) throw new Error('Predeclared candidate test action-plan changed');
        }
        const artifactDir = config.artifactDir.slice(OUTPUT_PATH.length + 1);
        const entry = {subject_id: subject.subject_id, config_path: registration.config_path, config_sha256: registration.config_sha256,
          artifact_dir: artifactDir, manifest_path: artifactDir + '/ci-runtime-receipt.json', manifest_sha256: null,
          started_utc: new Date().toISOString(), ended_utc: null, instrumentation_status: 'SUBMITTED_TO_BROWSER_ENTRY_NOT_YET_RETURNED', receipt_bindings: []};
        configs.push(entry);
        await persist('PARTIAL');
        configTimer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), batch.limits.max_test_seconds * 1000);
        let runtime;
        try { runtime = await runCI(config, ROOT); }
        finally { clearTimeout(configTimer); configTimer = undefined; }
        entry.ended_utc = new Date().toISOString();
        entry.instrumentation_status = runtime.instrumentation?.status ?? 'UNKNOWN';
        const actualRuntime = await fs.readFile(await boundedPath(ROOT, config.artifactDir + '/ci-runtime-receipt.json', {file: true}));
        entry.manifest_sha256 = sha(actualRuntime);
        if (!same(JSON.parse(actualRuntime), runtime)) throw new Error('Actual runtime manifest differs from returned evidence');
        await persist('PARTIAL');
        entry.receipt_bindings = await verifyRuntimeEvidence(ROOT, batch, subject, registration, config, plans, runtime);
        if (entry.receipt_bindings.some(item => ['COMPILE_PREFLIGHT_UNKNOWN','BOUND_BROWSER_INCOMPLETE'].includes(item.state))) {
          gap = true;
          entry.instrumentation_status = 'CANDIDATE_INCOMPLETE_RAW_EVIDENCE_PRESERVED';
          errors.push({subject_id: subject.subject_id, config_path: registration.config_path,
            message: 'Compiler/evaluator coverage remains incomplete; bound raw evidence is preserved without browser PASS', utc: new Date().toISOString()});
        }
        await persist('PARTIAL');
      }
    }
    finalStatus = gap ? 'INSTRUMENTATION_GAP_UNKNOWN' : 'BROWSER_EVIDENCE_COLLECTED_NOT_SCORED';
    if (gap) process.exitCode = 1;
  } catch (error) {
    errors.push({message: error.message, utc: new Date().toISOString()});
    finalStatus = 'INSTRUMENTATION_GAP_UNKNOWN';
    process.exitCode = 1;
  } finally {
    clearTimeout(jobTimer);
    clearTimeout(configTimer);
    await persist(finalStatus);
    process.removeListener('SIGTERM', onTerm);
  }
  return {status: finalStatus, configs: configs.length};
}

export function parseCLI(args) {
  if (args.length === 1 && args[0] === '--verify') return {mode: 'verify'};
  if (args.length === 2 && args[0] === '--job' && args[1] === JOB) return {mode: 'job', job: JOB};
  throw new Error('Only --verify or --job candidate-ui accepted; no candidate/config/module/path override');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCLI(process.argv.slice(2));
  if (cli.mode === 'verify') {
    const result = await verifyBatch(ROOT,{requireGit:process.env.GITHUB_ACTIONS === 'true'});
    console.log(JSON.stringify({mode: 'OFFLINE_HASH_VERIFICATION', batch_sha256: result.batch_sha256,
      candidates: result.batch.candidates.length, browser_functionality: 'UNKNOWN', native_counso: 'UNKNOWN'}));
  } else console.log(JSON.stringify(await runBatch(cli.job)));
}
