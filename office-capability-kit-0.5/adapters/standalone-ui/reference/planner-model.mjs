const clone = x => structuredClone(x);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function validate(source, draft) {
  const errors = [], day = new Map(), work = new Map(), ids = new Set();
  for (const a of draft.allocations) {
    const r = source.resources.find(x=>x.resource_id===a.resource_id), w=source.work_items.find(x=>x.work_item_id===a.work_item_id), roster=source.roster.find(x=>x.resource_id===a.resource_id&&x.date===a.date);
    if (!a.allocation_id || ids.has(a.allocation_id)) errors.push('Allocation identities must be unique'); ids.add(a.allocation_id);
    if (!Number.isInteger(a.minutes)||a.minutes<=0||a.minutes%15) errors.push(`${a.allocation_id}: minutes must be positive multiples of 15`);
    if (!r||!w||!roster) { errors.push(`${a.allocation_id}: unknown resource/work/date`); continue; }
    if(r.team_id!==w.team_id||!r.skills.includes(w.required_skill)||a.date<w.earliest_date||a.date>w.due_date) errors.push(`${a.allocation_id}: resource skill/team/date is ineligible`);
    const key=`${a.resource_id}|${a.date}`; day.set(key,(day.get(key)||0)+a.minutes); work.set(w.work_item_id,(work.get(w.work_item_id)||0)+a.minutes);
    if(day.get(key)>roster.available_minutes-roster.committed_minutes) errors.push(`${a.allocation_id}: cumulative draft exceeds residual capacity`);
    if(work.get(w.work_item_id)>w.remaining_minutes) errors.push(`${a.allocation_id}: cumulative draft exceeds remaining work`);
  }
  return errors;
}
export class PlannerModel {
  constructor(api,onChange=()=>{},mutation=null) { this.api=api; this.onChange=onChange; this.mutation=mutation; this.next=1; this.state={phase:'loading',source:null,local:null,confirmed:null,revision:null,canWrite:null,pending:false,error:null,review:null,requiresReview:false,view:{team_id:'',date:'',search:'',sort:'resource_id_asc'},expanded:null}; }
  notify() { if(this.state.local) { this.state.errors=validate(this.state.source,this.state.local); this.state.dirty=!same(this.state.local,this.state.confirmed); } this.onChange(this.state); }
  async init() { const source=await this.api('planner_source'), authority=await this.api('draft_read'); if(!source.ok||!authority.ok){this.state.phase='error';this.state.error=source.code||authority.code;this.notify();return;} this.state.source=source.source; this.state.local=clone(authority.draft);this.state.confirmed=clone(authority.draft); this.state.revision=authority.revision;this.state.canWrite=authority.canWrite;this.state.view.date=source.source.default_date;this.state.phase='ready';this.notify(); }
  setView(change) { this.state.view={...this.state.view,...change};this.notify(); }
  resetView() { this.state.view={team_id:'',date:this.state.source.default_date,search:'',sort:'resource_id_asc'};this.notify(); }
  add(line) { const allocation_id=`local-${this.next++}`; const next={...clone(this.state.local),allocations:[...clone(this.state.local.allocations),{...clone(line),allocation_id}]}; const errors=validate(this.state.source,next);if(errors.length){this.state.error=errors.join('; ');this.notify();return false;} this.state.local=next;this.state.error=null;this.notify();return true; }
  edit(id,change) { this.state.local.allocations=this.state.local.allocations.map(x=>x.allocation_id===id?{...x,...clone(change)}:x);this.state.error=null;this.notify(); }
  remove(id) { this.state.local.allocations=this.state.local.allocations.filter(x=>x.allocation_id!==id);this.notify(); }
  async save() {
    if(this.state.pending||this.state.canWrite!==true||this.state.requiresReview||validate(this.state.source,this.state.local).length) return false;
    const submitted=clone(this.state.local), revision=this.state.revision;
    this.state.pending=true;this.state.error=null;this.notify();
    const result=await this.api('draft_save',{draft:submitted,revision});this.state.pending=false;
    if(result.ok) { this.state.revision=result.revision;this.state.confirmed=clone(submitted);this.state.canWrite=result.canWrite;this.state.lastSaved=clone(submitted);if(this.mutation==='late-ack-clears-edits')this.state.local=clone(submitted); }
    else { this.state.error=result.code;if(result.code==='read_only')this.state.canWrite=false;if(['conflict','save_failed'].includes(result.code))this.state.requiresReview=true; }
    this.notify();return result.ok;
  }
  async review() { const result=await this.api('draft_read');if(result.ok){this.state.review=clone(result);this.state.canWrite=result.canWrite;}else this.state.error=result.code;this.notify(); }
  reapply() {
    if(!this.state.review)return;
    const old=new Map(this.state.confirmed.allocations.map(x=>[x.allocation_id,x])), local=new Map(this.state.local.allocations.map(x=>[x.allocation_id,x]));
    const merged=this.state.review.draft.allocations.filter(x=>!old.has(x.allocation_id)||local.has(x.allocation_id)).map(x=>old.has(x.allocation_id)&&!same(old.get(x.allocation_id),local.get(x.allocation_id))?clone(local.get(x.allocation_id)):clone(x));
    for(const x of local.values())if(!old.has(x.allocation_id)&&!merged.some(y=>y.allocation_id===x.allocation_id))merged.push(clone(x));
    this.state.confirmed=clone(this.state.review.draft);this.state.local={...clone(this.state.review.draft),allocations:merged};this.state.revision=this.state.review.revision;this.state.canWrite=this.state.review.canWrite;this.state.review=null;this.state.requiresReview=false;this.state.error=null;this.notify();
  }
  discard() { if(!this.state.review)return;this.state.local=clone(this.state.review.draft);this.state.confirmed=clone(this.state.review.draft);this.state.revision=this.state.review.revision;this.state.canWrite=this.state.review.canWrite;this.state.review=null;this.state.requiresReview=false;this.state.error=null;this.notify(); }
}
