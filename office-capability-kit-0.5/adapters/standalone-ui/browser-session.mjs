import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {Controller,IntegrationDefect} from './controller.mjs';
import {startServer} from './server.mjs';
export const sha = value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const fact=(ok,expected,observed,error_class='BUSINESS_FACT')=>({status:ok?'PASS':'FAIL',expected,observed,error_class});
export const unknown=reason=>({status:'UNKNOWN',reason,error_class:'UNKNOWN_SOURCE'});
export async function until(fn,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Observable result did not settle in acceptance window');}
/** Capture a failed probe's actual last state before pending requests/contexts are torn down.
 * This is diagnostic evidence only; no check is promoted to PASS or FAIL. */
export async function captureTerminalDOM(page) {
 return page.locator('body').evaluate(body=>{
  function visible(el){if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
  const nodes=Array.from(body.querySelectorAll('input,select,textarea,button,output,h1,h2,p,[role],table th,table td')).filter(visible);
  return {kind:'TERMINAL_ACTUAL_DOM_DIAGNOSTIC',url:location.href,scroll:{x:scrollX,y:scrollY},body_text:body.innerText,
   truncated:nodes.length>2000,nodes:nodes.slice(0,2000).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,role:el.getAttribute('role'),accessible_label:el.getAttribute('aria-label'),text:el.innerText??el.textContent,value:['INPUT','SELECT','TEXTAREA'].includes(el.tagName)?el.value:null,checked:el.tagName==='INPUT'?el.checked:null,disabled:'disabled'in el?el.disabled:null,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};})};
 });
}
export async function preserveTerminalEvidence({page,snapshot,blocked}) {
 try{return {status:'CAPTURED',observation_id:(await snapshot(async()=>({terminal:await captureTerminalDOM(page),blocked}),'terminal-error')).observation_id};}
 catch(error){return {status:'UNAVAILABLE',reason:error.message,error_class:'TERMINAL_CAPTURE_UNAVAILABLE'};}
}
export async function browserSession({browser,kind,fixture,mutation,mapping,output,probe_id,candidateDir,assets,initialCanWrite=true},work) {
 const host=await startServer({fixture,candidateDir,assets,kind});const fixture_sha256=sha({dashboard:host.authority.dashboard,resources:host.authority.resources,draft:host.authority.draft});if(!initialCanWrite)host.authority.setWritable(false);const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:960},acceptDownloads:true});const outbound=[];
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===host.origin&&host.allowedPaths.includes(url.pathname)){await route.continue();return;}outbound.push({url:url.href,method:route.request().method(),effect:'blocked_request_attempt',boundary:url.origin===host.origin?'same_origin_undeclared_path':'external_origin',attribution:'browser_page_request'});await route.abort('blockedbyclient');});
 const page=await context.newPage();page.setDefaultTimeout(7000);const c=new Controller(page,mapping[kind]);const observations=[];const checks={};const prefix=`${kind}-${fixture}-${probe_id}${mutation?'-'+mutation:''}`;const directory=join(output,prefix);await mkdir(directory,{recursive:true});
 c.measurements=[];c.captureMeasurementImage=async label=>{const relative=`${prefix}/measurement-${c.measurements.length}-${label}.png`;const path=join(output,relative);await page.screenshot({path,fullPage:false});return {png_artifact:relative,png_sha256:sha(await readFile(path))};};
 const waitTool=async(tool,phase='result',after=0)=>{await until(()=>host.authority.ledger.slice(after).find(e=>e.tool===tool&&e.phase===phase));await page.waitForTimeout(100);};
 const snapshot=async(data,label='state')=>{
  // A stable geometric/semantic observation and the PNG are bound to the same stage/ledger tail.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(typeof data==='function'){const capture=data;data=await capture();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));data.__recapture=capture;}
  const recapture=data.__recapture;delete data.__recapture;const semanticBefore=await c.fullVisibleText();
  const event_ids=host.authority.ledger.map(e=>e.event_id);const path=join(directory,`${observations.length+1}-${label}.png`);await page.screenshot({path,fullPage:true});
  const png=await readFile(path);const semanticAfter=await c.fullVisibleText();const recaptured=recapture?await recapture():null;const stable=JSON.stringify(semanticBefore)===JSON.stringify(semanticAfter)&&(!recaptured||JSON.stringify(data)===JSON.stringify(recaptured));if(!stable&&data.checks)for(const key of Object.keys(data.checks))data.checks[key]=unknown('Semantic/geometry state changed across screenshot capture; evidence binding is UNKNOWN');const record={observation_id:`observation-${observations.length+1}`,actual_browser_executed:true,data,evidence_binding:stable?'STABLE':'UNKNOWN',semantic_before:semanticBefore,semantic_after:semanticAfter,event_ids,actions:c.actions.filter(a=>a.performed).map(a=>a.event_id),png_artifact:path.slice(output.length+1),png_sha256:sha(png),visually_inspected:false};observations.push(record);return record;
 };
 let blocked=null,terminal_capture=null;
 try {await page.goto(`${host.origin}/?task=${kind}${mutation?'&mutation='+encodeURIComponent(mutation):''}`);await waitTool(kind==='dashboard'?'dashboard_load':'draft_read');await work({page,c,host,waitTool,snapshot,checks,directory});}
 catch(error){blocked={error_class:error instanceof IntegrationDefect?'PROTOCOL_INTEGRATION':'INSTRUMENTATION',reason:error.message};terminal_capture=await preserveTerminalEvidence({page,snapshot,blocked});}
 finally {for(const pending of [...host.authority.pending])host.authority.release(pending.request_id,'observer_teardown');await context.close();await host.close();}
 const ledger_artifact=`${prefix}/tool-ledger.json`;await writeFile(join(output,ledger_artifact),JSON.stringify(host.authority.ledger,null,2)+'\n');
 const receipt={probe_id,actual_browser_executed:true,execution:'actual_browser',session_id:host.authority.session_id,fixture_id:fixture,fixture_sha256,final_source_sha256:sha({dashboard:host.authority.dashboard,resources:host.authority.resources}),candidate_digest:null,actions:c.actions,measurement_actions:c.measurements,terminal_capture,observations,tool_ledger:host.authority.ledger,ledger_artifact,event_ids:host.authority.ledger.map(e=>e.event_id),network_attempts:outbound,integration_defects:c.integration_defects,blocked,checks,atom_checks:{}};
 if(blocked&&blocked.error_class==='PROTOCOL_INTEGRATION')receipt.integration_defects.push({reason:blocked.reason,error_class:blocked.error_class});
 await writeFile(join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');receipt.artifact=`${prefix}/receipt.json`;receipt.sha256=sha(await readFile(join(directory,'receipt.json')));return receipt;
}
export function bind(receipt,atom,keys) {receipt.atom_checks[atom]=keys.map(k=>receipt.checks[k]||unknown(receipt.blocked?.reason||`Missing completed check ${k}`));return receipt;}
