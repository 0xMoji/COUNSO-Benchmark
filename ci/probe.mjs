// Trusted synthetic browser capability probe, not a candidate-performance trial.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from './probe-runtime/node_modules/playwright/index.mjs';
const out=path.resolve('ci-results/probe');await fs.mkdir(out,{recursive:true});
const started=new Date().toISOString();const fixture={unit_price_eur:5};
const html=`<!doctype html><meta charset="utf-8"><title>Synthetic calculator probe</title><h1>Synthetic order calculator</h1><label>Units <input id="qty" type="number" value="2"></label><button id="calculate">Calculate</button><p role="status" id="total">Not calculated</p><script>document.getElementById('calculate').onclick=async()=>{let f=await (await fetch('/fixture.json')).json();document.getElementById('total').textContent='Total: '+(Number(document.getElementById('qty').value)*f.unit_price_eur)+' EUR';};</script>`;
const events=[];const server=http.createServer((req,res)=>{events.push({at:new Date().toISOString(),method:req.method,path:req.url});if(req.method!=='GET'||!['/','/fixture.json','/hardcoded'].includes(req.url)){res.writeHead(404);res.end();return;}res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");res.setHeader('Content-Type',req.url==='/fixture.json'?'application/json':'text/html; charset=utf-8');res.end(req.url==='/fixture.json'?JSON.stringify(fixture):req.url==='/hardcoded'?html.replace('*f.unit_price_eur','*5'):html);});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const observations=[];let failure;
try{
 // Default, officially documented Playwright launch; no custom browser security flags.
 // Only ordinary runner PATH/HOME are passed, never repository/account credentials.
 browser=await chromium.launch({headless:true,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.RUNNER_TEMP||'/tmp'}});
 const context=await browser.newContext({viewport:{width:960,height:640}});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==origin)await route.abort('blockedbyclient');else await route.continue();});
 const page=await context.newPage();await page.goto(origin);await page.locator('#qty').fill('3');await page.getByRole('button',{name:'Calculate',exact:true}).click();await page.getByRole('status').getByText('Total: 15 EUR',{exact:true}).waitFor();
 observations.push({step:'initial-fixture',action:['navigate','fill 3','click Calculate'],observed:await page.getByRole('status').innerText(),expected:'Total: 15 EUR'});
 await page.screenshot({path:path.join(out,'initial-fixture.png'),fullPage:true});
 fixture.unit_price_eur=7;await page.getByRole('button',{name:'Calculate',exact:true}).click();await page.getByRole('status').getByText('Total: 21 EUR',{exact:true}).waitFor();
 observations.push({step:'same-schema-unseen-value',action:['trusted fixture unit_price 5 to 7','click Calculate'],observed:await page.getByRole('status').innerText(),expected:'Total: 21 EUR'});
 await page.screenshot({path:path.join(out,'changed-fixture.png'),fullPage:true});
 // A separate deliberate hardcoding control must be detected by the same value oracle.
 await page.goto(origin+'/hardcoded');await page.locator('#qty').fill('3');await page.getByRole('button',{name:'Calculate',exact:true}).click();await page.getByRole('status').getByText('Total: 15 EUR',{exact:true}).waitFor();
 const bad=await page.getByRole('status').innerText();if(bad==='Total: 21 EUR')throw new Error('Mutation oracle failed to reject known hardcoded value');
 observations.push({step:'deliberate-hardcoded-value-control',source_unit_price_eur:fixture.unit_price_eur,mutation:'same frontend with unit price hardcoded to5',action:['navigate mutation','fill 3','click Calculate'],observed:bad,expected:'Total: 21 EUR',detected:true});
 await fs.writeFile(path.join(out,'dom.txt'),await page.content());
}catch(error){failure={name:error.name,message:error.message};process.exitCode=1;}
finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
 const receipt={probe_version:1,phase:'INSTRUMENT_PROBE_NOT_CANDIDATE',started_at:started,ended_at:new Date().toISOString(),ci_run_id:process.env.CI_EVIDENCE_RUN_ID||'UNKNOWN',ci_commit:process.env.CI_EVIDENCE_COMMIT||'UNKNOWN',node_version:process.version,html_sha256:crypto.createHash('sha256').update(html).digest('hex'),functional_status:failure?'UNKNOWN':'PASS',failure:failure||null,observations,events,browser_validation_is_candidate_generation_time:false,actual_counso_native_status:'UNKNOWN',external_network_allowed:false};
 await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
