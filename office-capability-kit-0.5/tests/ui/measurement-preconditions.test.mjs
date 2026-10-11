/** Deterministic callback controls, not real browser evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptyDateChanges} from '../../adapters/standalone-ui/dashboard-probes.mjs';
import {preserveTerminalEvidence} from '../../adapters/standalone-ui/browser-session.mjs';
import {scrollChartIntoView} from '../../adapters/standalone-ui/observe.mjs';
import {geometryFact} from '../../adapters/standalone-ui/oracle.mjs';
for (const fixture of ['public','evaluator']) {
 test(`empty interval ${fixture} changes upper bound first; every intermediate interval valid`,async()=>{
  const source=JSON.parse(await readFile(new URL(`../../tasks/ui/ui-dashboard/${fixture}/public/source.json`.replace(`/${fixture}/public/`,`/${fixture}/`),import.meta.url)));
  const change=emptyDateChanges(source),scope={created_from:source.default_created_from,created_to:source.default_created_to};
  assert.deepEqual(Object.keys(change),['created_to','created_from']);
  for (const [key,value] of Object.entries(change)){scope[key]=value;assert.ok(scope.created_from<scope.created_to);}
  assert.equal(source.tickets.filter(r=>r.created_at>=scope.created_from&&r.created_at<scope.created_to).length,0);
 });
}
test('terminal capture preserves original failure and actual callback DOM; it does not generate checks',async()=>{
 const order=[],dom={kind:'TERMINAL_ACTUAL_DOM_DIAGNOSTIC',nodes:[{tag:'INPUT',value:'2031-01-01'}]};
 const page={locator:key=>{assert.equal(key,'body');return {evaluate:async()=>{order.push('dom');return dom;}};}};
 const blocked={error_class:'INSTRUMENTATION',reason:'wait failed'};
 const result=await preserveTerminalEvidence({page,blocked,snapshot:async(fn,label)=>{assert.equal(label,'terminal-error');const data=await fn();order.push('snapshot');assert.deepEqual(data,{terminal:dom,blocked});assert.equal(data.checks,undefined);return {observation_id:'actual-callback-1'};}});
 assert.deepEqual(result,{status:'CAPTURED',observation_id:'actual-callback-1'});assert.deepEqual(order,['dom','snapshot']);
});
test('closed browser terminal capture remains explicit unavailable, no invented PNG/observation',async()=>{
 const result=await preserveTerminalEvidence({page:{locator:()=>({evaluate:async()=>{throw Error('page closed');}})},blocked:{reason:'interrupted'},snapshot:async fn=>fn()});
 assert.equal(result.status,'UNAVAILABLE');assert.equal(result.reason,'page closed');assert.equal(result.observation_id,undefined);
});
function fakeScroll({inView=false,fail=false,count=1}={}){
 let scrolled=false;const controller={mapping:{chart_plot:{label:'{status} plot'}},measurements:[],images:[],page:{getByLabel:()=>({count:async()=>count,evaluate:async()=>({scroll:{x:0,y:scrolled?1100:0},viewport:{width:1280,height:960},rect:{x:10,y:inView||scrolled?100:1200,width:60,height:160}}),scrollIntoViewIfNeeded:async()=>{if(fail)throw Error('ordinary scroll unavailable');scrolled=true;}})},captureMeasurementImage:async label=>{controller.images.push(label);return {png_artifact:`${label}.png`,png_sha256:'callback-only'};}};return controller;
}
test('ordinary offviewport chart measurement scroll records before/after without changing viewport/CSS',async()=>{
 const c=fakeScroll();assert.equal((await scrollChartIntoView(c)).status,'SCROLLED');assert.deepEqual(c.images,['before-scroll','after-scroll']);assert.equal(c.measurements[0].performed,true);assert.equal(c.measurements[0].before.rect.y,1200);assert.equal(c.measurements[0].after.rect.y,100);assert.deepEqual(c.measurements[0].before.viewport,c.measurements[0].after.viewport);assert.equal(c.actions,undefined);
});
test('already-visible chart does not synthesize scroll actions/images',async()=>{const c=fakeScroll({inView:true});assert.equal((await scrollChartIntoView(c)).status,'ALREADY_IN_VIEW');assert.deepEqual(c.measurements,[]);assert.deepEqual(c.images,[]);});
test('unavailable/ambiguous normal chart scroll stays unknown and incomplete',async()=>{const c=fakeScroll({fail:true});assert.equal((await scrollChartIntoView(c)).status,'UNKNOWN');assert.equal(c.measurements[0].performed,false);assert.deepEqual(c.images,['before-scroll']);assert.equal((await scrollChartIntoView(fakeScroll({count:2}))).status,'UNKNOWN');});
test('scroll does not relax invisible/occluded glyph prerequisite or wrong ratio',()=>{
 const geometry={stable:true,axis:'height',values:Object.fromEntries(['OPEN','IN_PROGRESS','WAITING'].map((name,i)=>[name,{plotVisible:true,glyphObservable:true,plot:{x:i*70,y:0,width:60,height:160},glyph:{x:i*70,y:i===1?80:0,width:60,height:i===1?80:160}}]))};const expected={OPEN:2,IN_PROGRESS:1,WAITING:2};assert.equal(geometryFact(geometry,expected).status,'PASS');
 const hidden=structuredClone(geometry);hidden.values.OPEN.plotVisible=false;assert.equal(geometryFact(hidden,expected).status,'UNKNOWN');const occluded=structuredClone(geometry);occluded.values.OPEN.glyphObservable=false;assert.equal(geometryFact(occluded,expected).status,'UNKNOWN');const wrong=structuredClone(geometry);wrong.values.IN_PROGRESS.glyph.y=0;wrong.values.IN_PROGRESS.glyph.height=160;assert.equal(geometryFact(wrong,expected).status,'FAIL');
});
