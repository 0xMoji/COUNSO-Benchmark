import { locator } from './controller.mjs';
import { dashboardFacts,plannerPreview,equalRows,numericFact,geometryFact } from './oracle.mjs';
const statuses=['OPEN','IN_PROGRESS','WAITING'];
export async function captureGeometry(controller) {
 const capture=async()=>{const values={};for(const status of statuses){try{const plot=locator(controller.page,controller.mapping.chart_plot,{status}),glyph=locator(controller.page,controller.mapping.chart_glyph,{status});if(await plot.count()!==1||await glyph.count()!==1)return null;
 const p=await plot.evaluate(el=>{const r=el.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})};});
 const g=await glyph.evaluate(el=>{const r=el.getBoundingClientRect();let observable=true;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)observable=false;}const style=getComputedStyle(el);if(style.backgroundColor==='rgba(0, 0, 0, 0)'||style.backgroundColor==='transparent')observable=false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.clipPath!=='none'||s.filter!=='none'||s.transform!=='none'||s.maskImage&&s.maskImage!=='none')observable=false;}if(r.width>0&&r.height>0){const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit||!(el===hit||el.contains(hit)))observable=false;}return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},observable};});values[status]={plot:p.rect,glyph:g.rect,plotVisible:p.visible,glyphObservable:g.observable};}catch{return null;}}return values;};
 const a=await capture();await controller.page.waitForTimeout(80);const b=await capture();return {stable:a!==null&&JSON.stringify(a)===JSON.stringify(b),axis:controller.mapping.chart_axis||null,values:b||{}};
}
export async function observeDashboard(c,source,scope) {
 const expected=dashboardFacts(source,scope),table=await c.table('tickets'),fields={},checks={};
 checks.rows=equalRows(table,expected.rows,['ticket_id','team_id','status','due_at','remaining_minutes']);
 for(const [key,value]of Object.entries(expected.metrics)){fields[key]=await c.field(c.mapping.metrics?.[key]);checks[key]=numericFact(fields[key],value,c.mapping.metrics?.[key]?.unit);}
 const counts={};for(const status of statuses){counts[status]=await c.field(c.mapping.chart_count,{status});checks[`chart_count_${status}`]=numericFact(counts[status],expected.chart[status],'tickets');}
 const geometry=await captureGeometry(c);checks.chart_geometry=geometryFact(geometry,expected.chart);
 const controls={team:await c.field(c.mapping.team),from:await c.field(c.mapping.created_from),to:await c.field(c.mapping.created_to)};
 const controlExpected={team:scope.team_ids[0]||'',from:scope.created_from,to:scope.created_to};
 for(const [key,value]of Object.entries(controlExpected))checks[`intent_${key}`]={status:controls[key].status==='OBSERVED'?(controls[key].value===value?'PASS':'FAIL'):'UNKNOWN',expected:value,observed:controls[key]};
 const statusControls={};for(const status of ['OPEN','IN_PROGRESS','WAITING','CLOSED']){try{const t=await c.target('status_filter',{status});statusControls[status]=await t.isChecked();checks[`intent_status_${status}`]={status:statusControls[status]===scope.statuses.includes(status)?'PASS':'FAIL',expected:scope.statuses.includes(status),observed:statusControls[status]};}catch(error){checks[`intent_status_${status}`]={status:'UNKNOWN',reason:error.message};}}
 const visible_text=await c.fullVisibleText();const known_current=visible_text.some(v=>v.role==='status'&&v.text==='Ready');for(const [key,check]of Object.entries(checks)){if(key.startsWith('intent_'))check.error_class='FUNCTIONAL_RESULT';else if(check.status==='FAIL'&&!known_current){checks[key]={status:'UNKNOWN',reason:'Mismatching values lack an unambiguous affirmative current-result state; independent full-state review required',observed:check.observed};}}return {checks,table,fields,counts,geometry,controls,statusControls,visible_text,known_current};
}
export async function observePlanner(c,source,draft) {
 const allocations=await c.table('allocations'),preview=await c.table('preview'),work=await c.table('work_preview'),expected=plannerPreview(source,draft);
 return {checks:{allocations:equalRows(allocations,draft.allocations,['allocation_id','work_item_id','resource_id','date','minutes']),capacity_preview:equalRows(preview,expected.capacity,['resource_id','date','residual_minutes','tentative_minutes','remaining_minutes']),work_preview:equalRows(work,expected.work,['work_item_id','source_remaining_minutes','tentative_minutes','remaining_minutes'])},allocations,preview,work,visible_text:await c.fullVisibleText()};
}
