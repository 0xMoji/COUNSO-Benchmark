import { locator } from './controller.mjs';
import { dashboardFacts,plannerPreview,equalRows,numericFact,geometryFact } from './oracle.mjs';
const statuses=['OPEN','IN_PROGRESS','WAITING'];
/** Ordinary scroll is a measurement precondition, not a task activation or app-state edit. */
export async function scrollChartIntoView(controller) {
 const target=locator(controller.page,controller.mapping.chart_plot,{status:statuses[0]});
 if(await target.count()!==1)return {status:'UNKNOWN',reason:'No unique chart plot for ordinary scroll'};
 const read=()=>target.evaluate(el=>{const r=el.getBoundingClientRect();return {scroll:{x:scrollX,y:scrollY},viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height}};});
 const before=await read(),r=before.rect;
 if(r.x>=0&&r.y>=0&&r.x+r.width<=before.viewport.width&&r.y+r.height<=before.viewport.height)return {status:'ALREADY_IN_VIEW',before,after:before};
 controller.measurements??=[];
 const event={event_id:`measurement-${controller.measurements.length+1}`,kind:'NORMAL_CHART_SCROLL',method:'scrollIntoViewIfNeeded',performed:false,before};controller.measurements.push(event);
 try{if(controller.captureMeasurementImage)event.before_image=await controller.captureMeasurementImage('before-scroll');await target.scrollIntoViewIfNeeded();event.performed=true;event.after=await read();if(controller.captureMeasurementImage)event.after_image=await controller.captureMeasurementImage('after-scroll');return {status:'SCROLLED',before:event.before,after:event.after};}
 catch(error){event.error=error.message;return {status:'UNKNOWN',reason:'Ordinary chart scroll/capture unavailable',error:error.message};}
}
export async function captureGeometry(controller) {
 const capture=async()=>{const values={};for(const status of statuses){try{const plot=locator(controller.page,controller.mapping.chart_plot,{status}),glyph=locator(controller.page,controller.mapping.chart_glyph,{status});if(await plot.count()!==1||await glyph.count()!==1)return null;
 const p=await plot.evaluate(el=>{const r=el.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})};});
 const g=await glyph.evaluate(el=>{const r=el.getBoundingClientRect();let observable=true;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)observable=false;}const style=getComputedStyle(el);if(style.backgroundColor==='rgba(0, 0, 0, 0)'||style.backgroundColor==='transparent')observable=false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.clipPath!=='none'||s.filter!=='none'||s.transform!=='none'||s.maskImage&&s.maskImage!=='none')observable=false;}if(r.width>0&&r.height>0){const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit||!(el===hit||el.contains(hit)))observable=false;}return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},observable};});values[status]={plot:p.rect,glyph:g.rect,plotVisible:p.visible,glyphObservable:g.observable};}catch{return null;}}return values;};
 const a=await capture();await controller.page.waitForTimeout(80);const b=await capture();return {stable:a!==null&&JSON.stringify(a)===JSON.stringify(b),axis:controller.mapping.chart_axis||null,values:b||{}};
}
export function bindSharedChartUnit(observed,context) {
 // Never replace an actual inline or adjacent declaration. A visible single
 // unsupported token is undecoded unit-like evidence, not a missing unit.
 const adjacent=typeof observed?.adjacent_text==='string'?observed.adjacent_text.trim():'';
 const undeclaredVisibleToken=observed?.adjacent_text_visible!==false&&/^\S+$/.test(adjacent);
 if(observed?.status!=='OBSERVED'||typeof observed.text!=='string'||observed.unit||/[A-Za-z]/.test(observed.text)||undeclaredVisibleToken||context?.status!=='OBSERVED')return observed;
 return {...observed,unit:context.unit,unit_visible:context.unit_visible,unit_source:context.unit_source,unit_context_region:context.region,unit_context_range:context.range};
}
export async function observeDashboard(c,source,scope) {
 await scrollChartIntoView(c);
 const expected=dashboardFacts(source,scope),table=await c.table('tickets'),fields={},checks={};
 checks.rows=equalRows(table,expected.rows,['ticket_id','team_id','status','due_at','remaining_minutes']);
 for(const [key,value]of Object.entries(expected.metrics)){fields[key]=await c.field(c.mapping.metrics?.[key]);checks[key]=numericFact(fields[key],value,c.mapping.metrics?.[key]?.unit);}
 const chart_unit_context=await c.chartUnitContext();
 const counts={};for(const status of statuses){counts[status]=await c.field(c.mapping.chart_count,{status});
  // Only a missing unit on a scalar may use the actual shared zero-range unit.
  // An inline/adjacent conflicting or unsupported declaration is never replaced.
  counts[status]=bindSharedChartUnit(counts[status],chart_unit_context);
  checks[`chart_count_${status}`]=numericFact(counts[status],expected.chart[status],'tickets');}

 const geometry=await captureGeometry(c);checks.chart_geometry=geometryFact(geometry,expected.chart);
 const controls={team:await c.field(c.mapping.team),from:await c.field(c.mapping.created_from),to:await c.field(c.mapping.created_to)};
 const controlExpected={team:scope.team_ids[0]||'',from:scope.created_from,to:scope.created_to};
 for(const [key,value]of Object.entries(controlExpected))checks[`intent_${key}`]={status:controls[key].status==='OBSERVED'?(controls[key].value===value?'PASS':'FAIL'):'UNKNOWN',expected:value,observed:controls[key]};
 const statusControls={};for(const status of ['OPEN','IN_PROGRESS','WAITING','CLOSED']){try{const t=await c.target('status_filter',{status});statusControls[status]=await t.isChecked();checks[`intent_status_${status}`]={status:statusControls[status]===scope.statuses.includes(status)?'PASS':'FAIL',expected:scope.statuses.includes(status),observed:statusControls[status]};}catch(error){checks[`intent_status_${status}`]={status:'UNKNOWN',reason:error.message};}}
 const visible_text=await c.fullVisibleText();const known_current=visible_text.some(v=>v.role==='status'&&v.text==='Ready');for(const [key,check]of Object.entries(checks)){if(key.startsWith('intent_'))check.error_class='FUNCTIONAL_RESULT';else if(check.status==='FAIL'&&!known_current){checks[key]={status:'UNKNOWN',reason:'Mismatching values lack an unambiguous affirmative current-result state; independent full-state review required',observed:check.observed};}}return {checks,table,fields,counts,chart_unit_context,geometry,controls,statusControls,visible_text,known_current};
}
export async function observePlanner(c,source,draft) {
 const allocations=await c.table('allocations'),preview=await c.table('preview'),work=await c.table('work_preview'),expected=plannerPreview(source,draft);
 return {checks:{allocations:equalRows(allocations,draft.allocations,['allocation_id','work_item_id','resource_id','date','minutes']),capacity_preview:equalRows(preview,expected.capacity,['resource_id','date','residual_minutes','tentative_minutes','remaining_minutes']),work_preview:equalRows(work,expected.work,['work_item_id','source_remaining_minutes','tentative_minutes','remaining_minutes'])},allocations,preview,work,visible_text:await c.fullVisibleText()};
}
