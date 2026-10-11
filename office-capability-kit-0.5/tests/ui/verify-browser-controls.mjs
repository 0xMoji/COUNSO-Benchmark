/** Executed only after the separately authorized browser CI jobs, never grants offline UI PASS. */
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
const [reference,wrongScope,oldResponse,wrongGeometry,lateAck]=process.argv.slice(2);
if(!reference||!wrongScope||!oldResponse||!wrongGeometry||!lateAck)throw new Error('Provide the five fresh authorized CI evidence directories');
const report=async(dir,cid)=>JSON.parse(await readFile(resolve(dir,`${cid}.report.json`),'utf8'));
const expected=[['ui-dashboard',reference,[],true],['ui-planner',reference,[],true],['ui-dashboard',wrongScope,['D-M1','D-E2'],false],['ui-dashboard',oldResponse,['D-H1'],false],['ui-dashboard',wrongGeometry,['D-E2'],false],['ui-planner',lateAck,['P-H3'],false]];
for(const[cid,dir,failures,referenceRun]of expected){const r=await report(dir,cid);if(r.tested_level!=='ACTUAL_BROWSER_SYNTHETIC'||r.actual_browser_executed!==true)throw new Error(`${dir} lacks actual browser evidence`);if(referenceRun&&r.atoms.some(a=>a.status!=='PASS'))throw new Error(`${cid} reference does not have complete proved browser/ledger coverage: ${r.atoms.filter(a=>a.status!=='PASS').map(a=>a.id+':'+a.status).join(', ')}`);for(const id of failures)if(r.atoms.find(a=>a.id===id)?.status!=='FAIL')throw new Error(`Mutation ${dir} did not independently fail expected ${id}`);}
console.log('Actual authorized browser reference/control patterns verified. Native platforms, real safety and rank stability remain UNKNOWN.');
