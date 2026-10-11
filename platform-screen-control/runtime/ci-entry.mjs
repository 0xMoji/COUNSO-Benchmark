/** Fixed coordinator batch gate. No candidate/config CLI path is accepted.
 * Browser launch exists solely in the separately authorized GitHub runner.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BATCH_PATH='ci-inputs/current-batch.json';
const SHA=/^[0-9a-f]{64}$/;
const REPOSITORY='0xMoji/counso-benchmark-reconstructed';
const BRANCH='eval/counso-ui-probe';
const REPO_PREFIX='platform-screen-control/';
const ACTIVE_WORKFLOW='.github/workflows/counso-platform-screen-control.yml';
const AUTHORITY_WORKFLOW='.github/workflows/ui-acceptance.yml';
const PHASES=['reference-create','dashboard-mutations','reference-edit','planner-mutations'];
const SUBJECT_IDS=['ref-dashboard','ref-planner','d-wrong-chart-geometry','d-primary-hardcoded','d-old-response','p-cumulative-overflow','p-false-saved','p-lateack-clears-edits'];
const BATCH_KEYS=['schema_version','origin','benchmark_version','repository','branch','browser','limits','authority_files','execution','phases','subjects','content_files','preparation'];
const SUBJECT_KEYS=['subject_id','role','case_id','kind','case_dir','output_dir','package_dir','package_files','package_sha256','bundle_sha256','response_sha256','objective_path','delivery_receipt_path','configs','test_matrix','expected','mutation'];
const CONFIG_KEYS=['packageDir','fixtureDir','kind','artifactDir','interfacePath','scopePath','caseId','fixtureId','fixtureHashes','candidatePackageSha256','testIds','fixtureReplacements','actionTimeoutMs','observerModule','observerSha256','hostMetadata','registeredHealthControl','browserChannel','expectedChromeVersion'];
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const normalize=v=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v;
export const canonicalSha256=value=>sha(JSON.stringify(normalize(value)));
const same=(a,b)=>JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
const exact=(obj,keys,label)=>{if(!obj||typeof obj!=='object'||Array.isArray(obj)||!same(Object.keys(obj).sort(),[...keys].sort()))throw new Error(label+' schema/keys mismatch')};
export async function boundedPath(root,name,{file=false}={}){
  if(typeof name!=='string'||!name||name.includes('\\')||path.posix.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe relative path');
  let p=root;
  for(const part of name.split('/')){p=path.join(p,part);try{if((await fs.lstat(p)).isSymbolicLink())throw new Error('Symlink forbidden')}catch(e){if(e.code!=='ENOENT')throw e;if(file)throw e}}
  if(!p.startsWith(root+path.sep))throw new Error('Path escapes root');
  if(file&&!(await fs.stat(p)).isFile())throw new Error('Declared file missing');return p;
}
export async function fileInventory(root){const found={};async function visit(dir){for(const item of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,item.name);if(item.isSymbolicLink())throw new Error('Symlink forbidden in registered files');if(item.isDirectory())await visit(p);else if(item.isFile())found[path.relative(root,p).split(path.sep).join('/')]=sha(await fs.readFile(p));else throw new Error('Nonstatic file forbidden')}}await visit(root);return found}
async function verifyMap(root,map){if(!map||typeof map!=='object'||Array.isArray(map)||!Object.keys(map).length)throw new Error('Missing inventory');for(const [name,expected]of Object.entries(map)){if(!SHA.test(expected)||sha(await fs.readFile(await boundedPath(root,name,{file:true})))!==expected)throw new Error('Declared source hash mismatch: '+name)}}
export function phaseForSubject(sid){if(sid==='ref-dashboard')return 'reference-create';if(sid==='ref-planner')return 'reference-edit';if(sid.startsWith('d-'))return 'dashboard-mutations';if(sid.startsWith('p-'))return 'planner-mutations';throw new Error('Unregistered subject phase')}
export async function freshPhaseOutput(root,phase){if(!PHASES.includes(phase))throw new Error('Unknown fixed phase');const parent=await boundedPath(root,'ci-results');await fs.mkdir(parent,{recursive:true});return await boundedPath(root,'ci-results/'+phase)}
export async function verifyGitAnchor(root,environment,batch){
  const git=(args,encoding='utf8')=>execFileSync('git',args,{cwd:root,encoding});
  const prefix=git(['rev-parse','--show-prefix']).trim();if(prefix!==REPO_PREFIX)throw new Error('Frozen root must be the exact platform-screen-control/ repository prefix');
  const commit=git(['rev-parse','HEAD']).trim();if(environment.CI_EVIDENCE_RUN_ID!==environment.GITHUB_RUN_ID||commit!==environment.CI_EVIDENCE_COMMIT||environment.GITHUB_REPOSITORY!==REPOSITORY||environment.GITHUB_REF!==`refs/heads/${BRANCH}`||environment.GITHUB_JOB!=='controls')throw new Error('Independent runner commit/repository/ref/fixed controls job mismatch');
  for(const p of [BATCH_PATH,'ci-inputs/current-batch.sha256']){if(!Buffer.from(git(['show',`HEAD:${prefix}${p}`],null)).equals(await fs.readFile(path.join(root,p))))throw new Error('Batch anchor is not the checked-out prefixed commit bytes')}
  const active=Buffer.from(git(['show',`HEAD:${ACTIVE_WORKFLOW}`],null)),internal=await fs.readFile(path.join(root,AUTHORITY_WORKFLOW));if(!active.equals(internal)||sha(active)!==batch.authority_files[AUTHORITY_WORKFLOW])throw new Error('Published active workflow differs from authority copy');
}
export async function verifyBatch(root=ROOT,{requireGit=false}={}){
  const raw=await fs.readFile(await boundedPath(root,BATCH_PATH,{file:true}));const batch=JSON.parse(raw);exact(batch,BATCH_KEYS,'Batch');
  const expected=(await fs.readFile(await boundedPath(root,'ci-inputs/current-batch.sha256',{file:true}),'utf8')).trim();if(!SHA.test(expected)||sha(raw)!==expected)throw new Error('Coordinator batch anchor mismatch');
  if(batch.schema_version!==1||batch.origin!=='COORDINATOR_REGISTERED_UI_BATCH'||batch.repository!==REPOSITORY||batch.branch!==BRANCH||batch.benchmark_version!==(await fs.readFile(path.join(root,'VERSION'),'utf8')).trim())throw new Error('Fixed batch authority mismatch');
  if(!same(batch.execution,{github_job:'controls',repo_prefix:REPO_PREFIX,active_workflow:ACTIVE_WORKFLOW,authority_workflow:AUTHORITY_WORKFLOW,setup_npm_seconds:60,precheck_seconds:60}))throw new Error('Fixed single-job execution mapping mismatch');
  if(!same(batch.browser,{channel:'chrome',expected_version:'154.0.8037.97',binary_sha256:'ACTUAL_RECORDED_NOT_YET_FROZEN'})||!same(batch.limits,{max_job_seconds:600,phase_seconds:{'reference-create':90,'dashboard-mutations':90,'reference-edit':120,'planner-mutations':90},max_subjects:8,max_configs:16,no_candidate_execution:true}))throw new Error('Fixed batch execution limits mismatch');
  if(!Array.isArray(batch.subjects)||batch.subjects.length!==8||!same(Object.keys(batch.phases).sort(),PHASES.toSorted()))throw new Error('Bounded control batch required');
  const required=['runtime/ci-entry.mjs','runtime/ci-run.mjs','runtime/compiler.mjs','runtime/server.mjs','runtime/model.mjs','runtime/sdk.ts','runtime/runtime-data.ts','runtime/acceptance-driver.mjs','runtime/acceptance-observer.mjs','runtime/ui-interface.json','runtime/package.json','runtime/package-lock.json','platform_screen/ci_batch.py','platform_screen/ui_gate.py','platform_screen/ui_scoring.py','runtime/ui-scope.json','docs/UI_ACCEPTANCE_PLAN.json','.github/workflows/ui-acceptance.yml'];
  if(required.some(k=>!batch.authority_files[k]))throw new Error('Unbound evaluator code/contract');
  await verifyMap(root,batch.authority_files);await verifyMap(root,batch.content_files);
  const content=await fileInventory(path.join(root,'ci-inputs'));delete content['current-batch.json'];delete content['current-batch.sha256'];
  const declared=Object.fromEntries(Object.entries(batch.content_files).map(([k,v])=>[k.replace(/^ci-inputs\//,''),v]));if(!same(content,declared))throw new Error('Exhaustive coordinator input inventory mismatch');
  const seen=new Set();let n=0;
  for(const s of batch.subjects){exact(s,SUBJECT_KEYS,'Subject');if(!/^[a-z0-9-]+$/.test(s.subject_id)||seen.has(s.subject_id)||!['REFERENCE','MUTATION'].includes(s.role)||!['dashboard','planner'].includes(s.kind))throw new Error('Subject typed identity');seen.add(s.subject_id);
    const caseId=s.kind==='dashboard'?'G-UI-CREATE-M1':'G-UI-EDIT-M1';if(s.case_id!==caseId||s.case_dir!==`dataset/cases/${caseId}`||s.output_dir!==`ci-inputs/packages/${s.subject_id}`||s.package_dir!==s.output_dir+'/frame'||!SHA.test(s.bundle_sha256)||!SHA.test(s.response_sha256))throw new Error('Fixed subject boundary');
    if(!same(await fileInventory(await boundedPath(root,s.package_dir)),s.package_files)||canonicalSha256(s.package_files)!==s.package_sha256||sha(await fs.readFile(await boundedPath(root,s.output_dir+'/response.json',{file:true})))!==s.response_sha256)throw new Error('Package/response exhaustive digest mismatch');
    if(!same(s.configs.map(e=>e.fixture_id),['primary','unseen_same_schema']))throw new Error('Both same-package fixtures required');
    for(const e of s.configs){exact(e,['config_path','config_sha256','fixture_id','fixture_files','fixture_sha256','test_ids','test_plan_sha256'],'Config registration');
      if(!e.config_path.startsWith(`ci-inputs/configs/${s.subject_id}/`))throw new Error('Fixed config boundary');
      const cr=await fs.readFile(await boundedPath(root,e.config_path,{file:true}));if(sha(cr)!==e.config_sha256)throw new Error('Config hash mismatch');const c=JSON.parse(cr);exact(c,CONFIG_KEYS,'Config');
      if(c.packageDir!==s.package_dir||c.candidatePackageSha256!==s.package_sha256||c.kind!==s.kind||c.caseId!==s.case_id||c.fixtureId!==e.fixture_id||c.artifactDir!==`ci-results/${phaseForSubject(s.subject_id)}/${s.subject_id}/${e.fixture_id}`||c.fixtureDir!==`ci-inputs/fixtures/${s.subject_id}/${e.fixture_id}`||c.observerModule!=='runtime/acceptance-observer.mjs'||c.observerSha256!==batch.authority_files[c.observerModule]||c.interfacePath!=='runtime/ui-interface.json'||c.scopePath!=='runtime/ui-scope.json'||c.browserChannel!=='chrome'||c.expectedChromeVersion!==batch.browser.expected_version||c.actionTimeoutMs!==5000||!same(c.testIds,e.test_ids))throw new Error('Fixed config typed join mismatch');
      const h=c.registeredHealthControl;exact(h,['packageDir','packageSha256','bundleSha256','fixtureDir','fixtureSha256','hostMetadata','baselineTestId','baselineTestPlanSha256'],'Health control');const ref=batch.subjects.find(x=>x.subject_id===(s.kind==='dashboard'?'ref-dashboard':'ref-planner'));const baseline=(s.kind==='dashboard'?'D-':'P-')+e.fixture_id+(s.kind==='dashboard'?'-baseline':'-draft_baseline');const rc=ref.configs.find(x=>x.fixture_id===e.fixture_id);if(!same(h,{packageDir:ref.package_dir,packageSha256:ref.package_sha256,bundleSha256:ref.bundle_sha256,fixtureDir:c.fixtureDir,fixtureSha256:e.fixture_sha256,hostMetadata:c.hostMetadata,baselineTestId:baseline,baselineTestPlanSha256:rc.test_plan_sha256[baseline]}))throw new Error('Fixed known-reference health control changed');
      if(!same(Object.keys(c.hostMetadata).sort(),Object.keys(e.fixture_files).sort()))throw new Error('Authority metadata must cover every declared file');
      for(const m of Object.values(c.hostMetadata)){exact(m,['revision','canWrite'],'Host metadata');if(typeof m.revision!=='string'||!/^([1-9][0-9]*)$/.test(m.revision)||typeof m.canWrite!=='boolean')throw new Error('Invalid opaque revision/capability')}
      const actual=await fileInventory(await boundedPath(root,c.fixtureDir));if(!same(actual,e.fixture_files)||canonicalSha256({files:actual,host_metadata:c.hostMetadata})!==e.fixture_sha256||!same(c.fixtureHashes,{[e.fixture_id]:e.fixture_sha256}))throw new Error('Fixture source/authority hash mismatch');n++;
    }
  }
  if(!same([...seen].sort(),SUBJECT_IDS.toSorted()))throw new Error('Only the six predeclared mutation identities authorized');
  if(n!==16||!same(batch.phases,{'reference-create':['ref-dashboard'],'reference-edit':['ref-planner'],'dashboard-mutations':[...seen].filter(s=>s.startsWith('d-')).sort(),'planner-mutations':[...seen].filter(s=>s.startsWith('p-')).sort()}))throw new Error('Fixed bounded job allocation');
  if(requireGit)await verifyGitAnchor(root,process.env,batch);
  return {batch,batch_sha256:expected};
}
export async function runPhase(phase){
  if(process.env.GITHUB_ACTIONS!=='true'||!PHASES.includes(phase))throw new Error('Only the authorized fixed GitHub Actions controls phases may execute; no local browser/server fallback');
  const verified=await verifyBatch(ROOT,{requireGit:true});const {batch,batch_sha256}=verified;
  const {runCI}=await import('./ci-run.mjs');const {buildTestPlan}=await import('./acceptance-driver.mjs');
  const output=await freshPhaseOutput(ROOT,phase);try{await fs.mkdir(output)}catch(e){if(e.code==='EEXIST')throw new Error('Fresh phase evidence directory required');throw e}
  const started={utc:new Date().toISOString(),monotonic_ms:performance.now()};const configs=[],errors=[];let finalStatus='UNKNOWN';
  const onTerm=()=>{errors.push({message:'Actual SIGTERM observed at CI timeout/executor boundary; origin remains infrastructure/coordinator',utc:new Date().toISOString()});persist('COORDINATOR_TIMEOUT_CI_JOB').finally(()=>process.exit(143))};process.once('SIGTERM',onTerm);
  try{
    for(const sid of batch.phases[phase]){const s=batch.subjects.find(s=>s.subject_id===sid);
      for(const e of s.configs){const c=JSON.parse(await fs.readFile(path.join(ROOT,e.config_path),'utf8'));const source=JSON.parse(await fs.readFile(path.join(ROOT,c.fixtureDir,s.kind==='dashboard'?'dataset.json':'resources.json'),'utf8'));const draft=s.kind==='planner'?JSON.parse(await fs.readFile(path.join(ROOT,c.fixtureDir,'draft.json'),'utf8')):null;const plans=buildTestPlan(s.kind,source,draft,e.fixture_id);for(const id of e.test_ids){const t=plans.find(t=>t.test_id===id);if(!t||canonicalSha256(t)!==e.test_plan_sha256[id])throw new Error('Predeclared test action-plan changed')}
        const start=new Date().toISOString();const relativeDir=path.relative(output,path.join(ROOT,c.artifactDir)).split(path.sep).join('/');const entry={config_path:e.config_path,config_sha256:e.config_sha256,artifact_dir:relativeDir,manifest_path:relativeDir+'/ci-runtime-receipt.json',started_utc:start,ended_utc:null,instrumentation_status:'SUBMITTED_TO_BROWSER_ENTRY_NOT_YET_RETURNED'};configs.push(entry);await persist('PARTIAL');const receipt=await runCI(c,ROOT);entry.ended_utc=new Date().toISOString();entry.instrumentation_status=receipt.instrumentation.status;await persist('PARTIAL');
        if(receipt.instrumentation.status!=='BROWSER_RECEIPTS_RECORDED')throw new Error('Browser instrumentation incomplete; preserve UNKNOWN and stop this job');
        const seenTests=new Set();for(const r of receipt.receipts){const relativeReceipt=path.join(path.dirname(c.artifactDir+'/ci-runtime-receipt.json'),r.artifact_relative_path);const p=await boundedPath(ROOT,relativeReceipt,{file:true});const raw=await fs.readFile(p);if(sha(raw)!==r.sha256)throw new Error('Actual browser receipt hash mismatch');const payload=JSON.parse(raw);if(!e.test_ids.includes(payload.test_id)||seenTests.has(payload.test_id)||payload.test_plan_sha256!==e.test_plan_sha256[payload.test_id]||payload.candidate_package_sha256!==s.package_sha256||payload.candidate_bundle_sha256!==s.bundle_sha256)throw new Error('Actual receipt typed package/bundle/plan mismatch');seenTests.add(payload.test_id);if(s.role==='REFERENCE'&&(payload.errors.length||!same(payload.assertions.map(a=>a.atom_id).sort(),plans.find(t=>t.test_id===payload.test_id).atom_ids.toSorted())||payload.assertions.some(a=>a.state!=='PASS')))throw new Error('Reference has failed or unresolved actual observer predicates; stop before mutation jobs, preserve raw receipt')}
        if(seenTests.size!==e.test_ids.length)throw new Error('Incomplete actual browser receipt coverage');

      }
    }
    finalStatus='BROWSER_EVIDENCE_COLLECTED_NOT_SCORED';
  }catch(error){errors.push({message:error.message,utc:new Date().toISOString()});finalStatus='INSTRUMENTATION_GAP_UNKNOWN';process.exitCode=1}
  finally{await persist(finalStatus);process.removeListener('SIGTERM',onTerm)}
  async function persist(status){const files=await fileInventory(output);delete files['batch-receipt.json'];const manifest={schema_version:1,origin:'TRUSTED_CI_BATCH_ENTRY',repository:REPOSITORY,branch:BRANCH,github_commit:process.env.CI_EVIDENCE_COMMIT,github_run_id:process.env.CI_EVIDENCE_RUN_ID,github_run_attempt:process.env.GITHUB_RUN_ATTEMPT,github_job:process.env.GITHUB_JOB,phase,batch_sha256,started,ended:{utc:new Date().toISOString(),monotonic_ms:performance.now()},status,configs,errors,files,model_clock:'NOT_A_MODEL_TRIAL',native_counso:'UNKNOWN',functional_pass:'NOT_INFERRED'};await fs.writeFile(path.join(output,'batch-receipt.json'),JSON.stringify(manifest,null,2)+'\n')}
  return {status:finalStatus,configs:configs.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).join(' ')==='--verify'){const r=await verifyBatch(ROOT,{requireGit:process.env.GITHUB_ACTIONS==='true'});console.log(JSON.stringify({mode:'OFFLINE_HASH_VERIFICATION',batch_sha256:r.batch_sha256,subjects:r.batch.subjects.length,browser_functionality:'UNKNOWN'}))}
  else{if(process.argv.length!==4||process.argv[2]!=='--phase')throw new Error('Only --verify or --phase <fixed-phase-name> accepted; no input/config override');console.log(JSON.stringify(await runPhase(process.argv[3])))}
}
