export const TOOL_PATHS = Object.freeze({dashboard_source:{method:'GET',path:'/api/dashboard-source'},dashboard_load:{method:'POST',path:'/api/dashboard-load'},planner_source:{method:'GET',path:'/api/planner-source'},draft_read:{method:'GET',path:'/api/draft'},draft_save:{method:'POST',path:'/api/draft'}});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,required)=>object(x)&&Object.keys(x).length===required.length&&required.every(k=>Object.hasOwn(x,k));
const text=x=>typeof x==='string'&&x.length>0;
export function calendarDate(x){if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(`${x}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;}
export function validArguments(tool,input){
 if(['dashboard_source','planner_source','draft_read'].includes(tool))return keys(input,[]);
 if(tool==='dashboard_load')return keys(input,['team_ids','statuses','created_from','created_to'])&&Array.isArray(input.team_ids)&&input.team_ids.every(text)&&new Set(input.team_ids).size===input.team_ids.length&&Array.isArray(input.statuses)&&input.statuses.every(x=>['OPEN','IN_PROGRESS','WAITING','CLOSED'].includes(x))&&new Set(input.statuses).size===input.statuses.length&&calendarDate(input.created_from)&&calendarDate(input.created_to);
 if(tool==='draft_save')return keys(input,['revision','draft'])&&text(input.revision)&&keys(input.draft,['draft_id','allocations'])&&text(input.draft.draft_id)&&Array.isArray(input.draft.allocations)&&input.draft.allocations.every(a=>keys(a,['allocation_id','work_item_id','resource_id','date','minutes'])&&['allocation_id','work_item_id','resource_id'].every(k=>text(a[k]))&&calendarDate(a.date)&&typeof a.minutes==='number'&&Number.isFinite(a.minutes));
 return false;
}
