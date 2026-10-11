import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {makeTypedReport} from './report.mjs';
import {sha} from './browser-session.mjs';
import {runDashboardProbes} from './dashboard-probes.mjs';
import {runPlannerProbes} from './planner-probes.mjs';
import {frozenPackage} from './package-boundary.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),option=(key,fallback=null)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const output=resolve(option('--output','ui-prepared'));
const json=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
const packageIdentity=frozenPackage;
export const publicCandidateIdentity=({files,digest})=>({files,digest});
export function executionMode(args,env=process.env){
 if(args.includes('--execute-ci')&&args.includes('--execute-browser'))throw new Error('Choose one browser execution mode.');
 if(args.includes('--execute-ci')){if(env.GITHUB_ACTIONS!=='true')throw new Error('--execute-ci requires an explicitly authorized GitHub CI job; use --execute-browser in an authorized ordinary Chrome environment.');return 'ci';}
 return args.includes('--execute-browser')?'browser':'prepare';
}
export async function prepareReports(output){
 await mkdir(output,{recursive:false});
 for(const case_id of ['ui-dashboard','ui-planner']){const atoms=await json(`tasks/ui/${case_id}/atoms.json`),plan=await json(`tasks/ui/${case_id}/evaluator/probes.json`);const report=makeTypedReport({case_id,atoms,dependencies:plan.atom_probe_dependencies});await writeFile(join(output,`${case_id}.report.json`),JSON.stringify(report,null,2)+'\n');}
 await writeFile(join(output,'EXECUTION_BOUNDARY.json'),JSON.stringify({tested_level:'BROWSER_PREPARED_NOT_EXECUTED',actual_browser_executed:false,model_calls:0,new_candidates:0,new_cases:0,native_frames:'UNKNOWN',native_a2ui:'UNKNOWN',browser_execution:'Use --execute-browser in an authorized ordinary official Chrome environment or --execute-ci in an authorized GitHub CI job. This prepare command never starts a server or browser.'},null,2)+'\n');
}
async function executeBrowser(){
 await mkdir(output,{recursive:false});
 const {chromium}=await import('playwright');
 const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 const browser=await chromium.launch({channel:'chrome',headless:true,env});
 const mapping=option('--mapping')?JSON.parse(await readFile(resolve(option('--mapping')),'utf8')):await json('adapters/standalone-ui/action-mapping.json');
 const candidateDir=option('--candidate-dir')?resolve(option('--candidate-dir')):null;
 const referenceDir=resolve(root,'adapters/standalone-ui/reference');
 const identity=await packageIdentity(candidateDir||referenceDir);const browser_version=browser.version();
 const options={browser,mapping,output,fixture:'public',mutation:option('--mutation'),candidateDir,assets:identity.files.map(f=>`/${f.path}`)};
 const reports=[];
 try{
  for(const [case_id,run]of [['ui-dashboard',runDashboardProbes],['ui-planner',runPlannerProbes]]){
   if(option('--case')&&option('--case')!==case_id)continue;
   const atoms=await json(`tasks/ui/${case_id}/atoms.json`),plan=await json(`tasks/ui/${case_id}/evaluator/probes.json`);const probes=await run(options);
   const unchanged=sha(await packageIdentity(candidateDir||referenceDir))===sha(identity);
   for(const p of probes){p.candidate_digest=identity.digest;if(p.probe_id==='transfer')p.atom_checks[case_id==='ui-dashboard'?'D-H4':'P-H4'].push({status:unchanged?'PASS':'UNKNOWN',expected:'Same immutable static app digest across original/transfer contexts',observed:identity.digest,error_class:unchanged?null:'INSTRUMENTATION'});}
   // Delivery remains an independent representation check; static source cannot certify a UI action.
   const delivery={probe_id:'delivery',actual_browser_executed:true,atom_checks:{[case_id==='ui-dashboard'?'D-E0':'P-E0']:[{status:identity.files.some(f=>f.path==='index.html')&&identity.files.some(f=>f.path==='response.json')?'PASS':'FAIL',expected:'Existing index.html and response.json declaring actual static assets',observed:identity.files,error_class:'FUNCTIONAL_RESULT'}]},event_ids:[],integration_defects:[]};
   if(delivery.atom_checks[case_id==='ui-dashboard'?'D-E0':'P-E0'][0].status==='PASS'){try{const response=JSON.parse(await readFile(join(candidateDir||referenceDir,'response.json'),'utf8'));delivery.atom_checks[case_id==='ui-dashboard'?'D-E0':'P-E0'][0].status=Array.isArray(response.artifacts)&&response.artifacts.includes('index.html')&&response.artifacts.every(p=>identity.files.some(f=>f.path===p))?'PASS':'FAIL';}catch{delivery.atom_checks[case_id==='ui-dashboard'?'D-E0':'P-E0'][0].status='FAIL';}}
   probes.push(delivery);const report=makeTypedReport({case_id,atoms,dependencies:plan.atom_probe_dependencies,probes,tested_level:'ACTUAL_BROWSER_SYNTHETIC',artifact:`${case_id}.report.json`});report.candidate_digest=identity.digest;report.browser={provider:'official preinstalled Chrome',channel:'chrome',version:browser_version};await writeFile(join(output,`${case_id}.report.json`),JSON.stringify(report,null,2)+'\n');reports.push(report);
  }
 }finally{await browser.close();}
 const files=[];async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else files.push({artifact:path.slice(output.length+1),sha256:sha(await readFile(path))});}}await walk(output);await writeFile(join(output,'evidence-manifest.json'),JSON.stringify({origin:'EVALUATOR_STANDALONE_BROWSER_RUNNER',execution:'actual_browser',candidate:publicCandidateIdentity(identity),browser_version,artifacts:files},null,2)+'\n');
 console.log(JSON.stringify({output,reports:reports.map(r=>({case_id:r.case_id,tested_level:r.tested_level,counts:Object.fromEntries(['PASS','FAIL','UNKNOWN'].map(s=>[s,r.atoms.filter(a=>a.status===s).length]))}))}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(executionMode(args)!=='prepare')await executeBrowser();else{await prepareReports(output);console.log(JSON.stringify({output,tested_level:'BROWSER_PREPARED_NOT_EXECUTED',actual_browser_executed:false}));}}
