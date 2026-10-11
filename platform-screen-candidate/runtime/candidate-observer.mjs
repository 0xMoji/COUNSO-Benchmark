/** Finite source/visible-DOM/host observer, evaluator-only.
 * It has no browser access, no candidate state access and no model dependency.
 * Candidate-only v4 copy: positive stage expectations require real actions and
 * post-action captures. Source/business/duplicate/safety proofs still dominate.
 * Unsupported display semantics abstain; a proved wrong fact still dominates.
 */
import {canonicalPackageTarget} from './package-path.mjs';
import {dashboardOracle,plannerOracle,defaultDashboardScope} from './acceptance-driver.mjs';
import {createHash} from 'node:crypto';

const norm=s=>String(s??'').replaceAll('_',' ').replace(/\s+/g,' ').trim().toLowerCase();
const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const same=(a,b)=>canon(a)===canon(b);
const rawHash=s=>createHash('sha256').update(s).digest('hex');
const sorted=a=>[...a].sort();
const nodes=(capture,hook)=>capture.dom.nodes.filter(n=>n.hook===hook&&n.visible);
const node=(capture,hook,key)=>nodes(capture,hook).find(n=>key===undefined||n.key===key);
const refs=c=>c.evidence_refs;
const unknown=(predicate,expected,observed,evidence_refs=[])=>({state:'UNKNOWN',predicate,expected,observed,evidence_refs});
const pass=(predicate,expected,observed,evidence_refs)=>({state:'PASS',predicate,expected,observed,evidence_refs});
function failure(predicate,expected,observed,evidence_refs,kind=null){return {state:'FAIL',predicate,expected,observed,evidence_refs,failure_class:kind?'business':'representation',...(kind?{business_proof:{kind,material:true,comparison:'independently_resolved',claim:predicate,expected,observed,evidence_refs}}:{})}}
function compare(predicate,expected,observed,evidence_refs,kind=null){return observed===undefined?unknown(predicate,expected,'Display semantics unresolved',evidence_refs):same(expected,observed)?pass(predicate,expected,observed,evidence_refs):failure(predicate,expected,observed,evidence_refs,kind)}
function sourceAt(capture,kind,fallback){try{return JSON.parse(capture.snapshot.files[kind==='dashboard'?'dataset.json':'resources.json'].content)}catch{return fallback}}
function draftAt(capture){try{return JSON.parse(capture.snapshot.files['draft.json'].content)}catch{return null}}
function knownNumber(text){const s=String(text??'').trim();const matches=[...s.matchAll(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)];if(matches.length!==1)return undefined;const token=matches[0][0];return {value:Number(token.replaceAll(',','')),decimals:token.includes('.')?token.split('.')[1].length:0,text:s}}
function visibleUnit(text){const s=norm(text);const mins=/\b(?:minutes?|mins?)\b|分钟/.test(s),hours=/\b(?:hours?|hrs?)\b|小时/.test(s);return mins===hours?undefined:mins?'minutes':'hours'}
export function parseQuantity(display,{targetUnit='count',allowRounding=false}={}){
  const input=display.input?.visible===true?display.input:null;
  const inputType=input?.type==null?null:String(input.type).trim().toLowerCase();
  if(display.input_count!==undefined&&display.input_count>1)return undefined;
  if(input&&(![null,'text','number'].includes(inputType)||typeof input.value!=='string'||!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.value.trim())))return undefined;
  const text=input?input.value:display.text;
  const n=input?{value:Number(input.value.replaceAll(',','')),decimals:(input.value.split('.')[1]||'').split(/[eE]/)[0].length}:knownNumber(text);if(!n||!Number.isFinite(n.value))return undefined;
  if(input){const visible=knownNumber(display.text);if(/\d/.test(display.text||'')&&!visible||visible&&visible.value!==n.value)return undefined;}
  if(targetUnit==='count')return {value:n.value,tolerance:0};
  const unit=visibleUnit(`${display.text||''} ${display.header||''}`)||visibleUnit(display.parent_text||'');
  // A candidate's data-unit attribute alone is not evidence of visible units.
  if(!unit)return undefined;
  const factor=targetUnit==='minutes'?(unit==='hours'?60:1):(unit==='minutes'?1/60:1);
  return {value:n.value*factor,tolerance:allowRounding&&n.decimals>0?0.5*10**(-n.decimals)*factor+1e-9:1e-9};
}
function quantityFact(predicate,expected,display,evidence_refs,opts={}){const observed=display&&parseQuantity(display,opts);if(!observed)return unknown(predicate,expected,'No unambiguous visible number/unit',evidence_refs);return Math.abs(expected-observed.value)<=observed.tolerance?pass(predicate,expected,observed.value,evidence_refs):failure(predicate,expected,observed.value,evidence_refs,'amount')}

export function parseCalendarDisplay(text,{timestamp=false,contextUTC=false}={}){
  const raw=String(text??'').trim().replace(/^(?:due|deadline|date|day)\s*:?\s*/i,'');
  if(!raw)return undefined;
  const validCalendar=(year,month,day)=>Number.isInteger(year)&&year>=1&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  const iso=/^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}|\s+(?:UTC|GMT))?)?$/i.exec(raw);
  const isoDay=!!iso&&!iso[4];
  if(/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(raw)){
    if(!iso||!validCalendar(Number(iso[1]),Number(iso[2]),Number(iso[3])))return undefined;
    if(iso[4]&&(Number(iso[5])>23||Number(iso[6])>59||Number(iso[7]||0)>59))return undefined;
    if(iso[8]&&/^[+-]/.test(iso[8])){const zone=iso[8].replace(':','');if(Number(zone.slice(1,3))>23||Number(zone.slice(3,5))>59)return undefined;}
  }
  if(!timestamp&&isoDay)return raw;
  if(timestamp&&isoDay)return undefined; // Missing time is not a proved wrong instant.
  const explicitZone=/(?:Z|[+-]\d{2}:?\d{2}|\bUTC\b|\bGMT\b)\s*$/i.test(raw);
  const calendarClear=isoDay||/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)||/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.test(raw);
  if(!calendarClear||(timestamp&&!explicitZone&&!contextUTC))return undefined;
  if(!iso){
    const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const dayFirst=/\b(\d{1,2})\s+(Jan[a-z]*|Feb[a-z]*|Mar[a-z]*|Apr[a-z]*|May|Jun[a-z]*|Jul[a-z]*|Aug[a-z]*|Sep[a-z]*|Oct[a-z]*|Nov[a-z]*|Dec[a-z]*)\s+(\d{4})\b/i.exec(raw);
    const monthFirst=/\b(Jan[a-z]*|Feb[a-z]*|Mar[a-z]*|Apr[a-z]*|May|Jun[a-z]*|Jul[a-z]*|Aug[a-z]*|Sep[a-z]*|Oct[a-z]*|Nov[a-z]*|Dec[a-z]*)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(raw);
    const parts=dayFirst?[Number(dayFirst[3]),months.indexOf(dayFirst[2].slice(0,3).toLowerCase())+1,Number(dayFirst[1])]:monthFirst?[Number(monthFirst[3]),months.indexOf(monthFirst[1].slice(0,3).toLowerCase())+1,Number(monthFirst[2])]:null;
    if(!parts||!validCalendar(...parts))return undefined;
    const time=/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(raw);
    if((timestamp&&!time)||(time&&(Number(time[1])>23||Number(time[2])>59||Number(time[3]||0)>59)))return undefined;
  }
  const parsed=Date.parse(!explicitZone&&(!timestamp||contextUTC)?raw+' UTC':raw);if(!Number.isFinite(parsed))return undefined;
  return timestamp?parsed:new Date(parsed).toISOString().slice(0,10);
}

const headerFields={ticket_id:/\bticket\b.*\bid\b|\bid\b.*\bticket\b|\bcase\b.*\bid\b/,team_id:/\bteam\b|\bdepartment\b|\bgroup\b/,status:/\bstatus\b|\bstate\b/,due_at:/\bdue\b|\bdeadline\b/,remaining_minutes:/\bremaining\b.*(?:minutes?|hours?|effort)|\beffort\b/,resource_id:/\bresource\b.*\bid\b|\bstaff\b.*\bid\b|^(?:resource|staff)$/,display_name:/\bname\b/,date:/\bdate\b|\bday\b/,available_minutes:/\bavailable\b|\bavailability\b/,committed_minutes:/\bcommitted\b|\bbooked\b/,residual_minutes:/\bresidual\b|\bfree\b|\buncommitted\b/,allocation_id:/\ballocation\b.*\bid\b|\bline\b.*\bid\b/,work_item_id:/\bwork\b.*(?:item|id)|\btask\b.*\bid\b/,minutes:/\bdraft\b.*(?:minutes?|hours?)|\bplanned\b.*(?:minutes?|hours?)|\bquantity\b/};
// Bare visible unit headers are an unambiguous quantity column, too.
headerFields.minutes=/\bdraft\b.*(?:minutes?|hours?)|\bplanned\b.*(?:minutes?|hours?)|\bquantity\b|^(?:minutes?|mins?|hours?|hrs?)$/;
function cellFor(row,field){const cells=row.cells||[];let result=cells.find(c=>c.field===field);if(result){const h=norm(result.header);if(h&&headerFields[field]&&!headerFields[field].test(h))return undefined;return result}return cells.find(c=>headerFields[field]?.test(norm(c.header)))}
export function textIdentity(display,allowed,labels={}){if(!display)return undefined;const text=String(display.text??'').trim();if(allowed.includes(text))return text;
  const matches=allowed.filter(id=>{const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(text)});
  if(matches.length===1)return matches[0];const labelText=text.replace(/^(?:name|team|department|group)\s*:\s*/i,'');const names=allowed.filter(id=>labels[id]!==undefined&&norm(labels[id])===norm(labelText));if(names.length===1)return names[0];if(names.length>1)return undefined;
  // A dedicated, visibly labelled ID field contains an explicit unknown ID.
  if(!/\s/.test(text)&&text)return text;
  return undefined;
}
function resourceRowsExpected(source,capture){const team=node(capture,'legacy-team-filter')?.value,date=node(capture,'legacy-date-filter')?.value,search=norm(node(capture,'legacy-search')?.value),order=node(capture,'legacy-sort')?.value;
  if(team===undefined||date===undefined||search===undefined)return undefined;
  const resources=new Map(source.resources.map(r=>[r.resource_id,r]));
  let rows=source.roster.filter(r=>r.date===date).map(r=>({...resources.get(r.resource_id),...r,residual_minutes:r.available_minutes-r.committed_minutes})).filter(r=>(!team||r.team_id===team)&&(!search||norm(`${r.resource_id} ${r.display_name}`).includes(search)));
  if(['resource_id_asc','resource_id_desc'].includes(order))rows.sort((a,b)=>a.resource_id.localeCompare(b.resource_id)*(order==='resource_id_desc'?-1:1));else return undefined;
  return rows;
}

export function chartGeometryFacts(capture,counts){
 if(capture.dom.chart_geometry_observation?.state==='UNKNOWN')return [unknown('Visible chart geometry requires an observed stable rendered sample','Stable captured chart geometry','Trusted bounded geometry capture is UNKNOWN',refs(capture))];
 const r=refs(capture),facts=[],rows=[];const statuses=Object.keys(counts),raw=capture.dom.nodes;
 const painted=n=>{const color=n.paint?.svg_fill||n.paint?.background_color;if(typeof color!=='string'||/^(?:transparent|none)$/i.test(color.trim()))return false;return !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color)&&!/(?:rgb|color)\([^)]*\/\s*0(?:\.0+)?\s*\)$/i.test(color)};
 for(const status of statuses){const plots=raw.filter(n=>n.hook==='status-plot'&&n.key===status),glyphs=raw.filter(n=>n.hook==='status-glyph'&&n.key===status);const plot=plots[0],glyph=glyphs[0];if(plots.length!==1||glyphs.length!==1||!plot.visible||!['height','width'].includes(plot.axis)||!plot.rect||!glyph.rect){facts.push(unknown(`Visible chart geometry for ${status}`,'Resolvable real plot/glyph/axis','Missing or unsupported graphic semantics',r));continue}
  const axis=plot.axis,len=glyph.rect[axis],extent=plot.rect[axis];if(!Number.isFinite(len)||len<0||!Number.isFinite(extent)||extent<=0||!glyph.effective_visible&&len>0||len>0&&!painted(glyph)){facts.push(unknown(`Painted chart glyph for ${status}`,'Unambiguous effectively visible filled bar','Unresolved or unpainted rendered glyph',r));continue}
  const base=axis==='height'?glyph.rect.y+glyph.rect.height:glyph.rect.x,origin=axis==='height'?plot.rect.y+plot.rect.height:plot.rect.x;
  if(!Number.isFinite(base)||!Number.isFinite(origin)){facts.push(unknown('Visible chart shared baseline','Rendered baseline','Missing rectangle origin',r));continue}
  rows.push({status,axis,len,extent,base,origin,count:counts[status]});
 }
 if(rows.length!==statuses.length)return facts.length?facts:[unknown('Complete chart geometry','All categories','Incomplete',r)];
 if(new Set(rows.map(a=>a.axis)).size!==1)return [unknown('Visible chart common axis','One horizontal/vertical bar encoding','Different axes',r)];
 const origins=rows.map(a=>a.origin),extents=rows.map(a=>a.extent);
 if(Math.max(...origins)-Math.min(...origins)>2||Math.max(...extents)-Math.min(...extents)>2||rows.some(a=>Math.abs(a.base-a.origin)>2||a.len>a.extent+2))facts.push(failure('Visible chart glyphs use the public common plot and zero baseline',true,false,r,null));
 const positives=rows.filter(a=>a.count>0),anchor=positives.toSorted((a,b)=>b.count-a.count)[0];
 if(anchor&&anchor.len<=2)return [...facts,failure('Positive chart quantities have measurable plotted length',true,false,r,null)];
 const scale=anchor?anchor.len/anchor.count:0;
 for(const a of rows){const want=a.count*scale;facts.push(Math.abs(a.len-want)<=2?pass(`Visible chart geometry count for ${a.status}`,want,a.len,r):failure(`Visible chart geometry count for ${a.status}`,want,a.len,r,'amount'))}
 return facts;
}

function dashboardScopeAt(actions,source){let scope=defaultDashboardScope(source);for(const a of actions){if(a.hook==='team-filter'&&['select','fill'].includes(a.kind))scope.team_ids=a.value?[a.value]:[];if(a.hook==='created-from'&&a.kind==='fill')scope.created_from=a.value;if(a.hook==='created-to'&&a.kind==='fill')scope.created_to=a.value;if(a.hook==='status-option'&&a.checked===false)scope.statuses=scope.statuses.filter(s=>s!==a.source_key);if(a.hook==='status-bar'&&(a.kind==='click'||a.kind==='press'&&['Enter',' ','Space'].includes(a.key)))scope.statuses=[a.source_key];if(a.hook==='reset-filters'&&a.kind==='click')scope=defaultDashboardScope(source)}return scope}
function callResults(capture,command){return capture.events.filter(e=>e.type==='RPC_ACCEPTED'&&e.command===command).map(e=>({request:e,result:capture.events.find(r=>r.type==='RPC_RESULT'&&r.requestSeq===e.seq)}))}
function sourceTarget(capture,supplied,file){const target=canonicalPackageTarget(capture.snapshot?.packageRoot,supplied);return target?.relative===file&&Object.hasOwn(capture.snapshot?.files||{},file)}
function fileCalls(capture,command,file){const key=command==='writeFile'?'path':'fileId';return callResults(capture,command).filter(c=>sourceTarget(capture,c.request.params?.[key],file))}
function successfulFileRead(capture,file){const snapshot=capture.snapshot?.files?.[file];if(typeof snapshot?.content!=='string')return false;return fileCalls(capture,'getFile',file).some(({request,result})=>{
  const answer=result?.answer,value=answer?.result;
  return result?.command==='getFile'&&result.seq>request.seq&&!answer.error&&!value?.error&&value?.fileContent===snapshot.content&&typeof value.revision==='string'&&!!value.revision&&typeof value.canWrite==='boolean'&&(snapshot.revision===undefined||value.revision===snapshot.revision)&&(snapshot.canWrite===undefined||value.canWrite===(capture.snapshot.canWrite!==false&&snapshot.canWrite!==false));
})}
function successfulResourceFunctionRead(capture){const snapshot=capture.snapshot?.files?.['resources.json'];if(typeof snapshot?.content!=='string'||typeof capture.snapshot.sessionId!=='string')return false;let expected;try{expected=JSON.parse(snapshot.content)}catch{return false}
  return callResults(capture,'callFunction').some(({request,result})=>{
    const answer=result?.answer,execution=capture.events.filter(e=>e.type==='DETERMINISTIC_FUNCTION'&&e.requestSeq===request.seq);
    return request.params?.functionIdOrSlug==='load-data'&&same(request.params.input,{})&&result?.command==='callFunction'&&result.seq>request.seq&&!answer?.error&&!answer?.result?.error&&same(answer?.result,expected)&&result.file_hashes?.['resources.json']?.sha256===rawHash(snapshot.content)&&execution.length===1&&execution[0].seq>request.seq&&execution[0].seq<result.seq&&execution[0].bound_function===capture.snapshot.sessionId+'/load-data'&&same(execution[0].input,request.params.input)&&execution[0].output_sha256===rawHash(JSON.stringify(answer.result));
  })
}
function sourceStatus(text){if(typeof text!=='string')return undefined;const matches=['OPEN','IN_PROGRESS','WAITING','CLOSED'].filter(status=>norm(status)===norm(text));return matches.length===1?matches[0]:undefined}
function dashboardLoad(capture){const calls=callResults(capture,'callFunction');if(calls.length)return calls.at(-1);return fileCalls(capture,'getFile','dataset.json').at(-1)}
export function parseUIPhaseText(value){
 const phases=new Set();for(const raw of String(value??'').split(/\n|[.!?;](?:\s|$)/)){
  const clause=norm(raw);if(!clause)continue;
  // Public source scope/status fields and explicitly historical results are
  // separate visible claims, not statements about the current request phase.
  if(/^(?:(?:requested|displayed|source)\s+)?scope\s*:|^(?:statuses|team ids|teams|created from|created to)\s*:/.test(clause)||/^(?:status\s*:\s*)?(?:open|in progress|waiting|closed)$/.test(clause)||/\b(?:previous|prior|older|earlier|last)\b.*\b(?:results?|views?|snapshots?|requests?)\b/.test(clause))continue;
  const clean=clause.replace(/\b(?:no|without)\s+(?:errors?|failures?)\b/g,'');
  const negated=words=>new RegExp('\\b(?:not|never|no|without)\\b(?:\\s+(?:yet|is|are|was|were|be|been|being|has|have|had|results?|data|requests?|currently|still|fully|successfully)){0,5}\\s+(?:'+words+')\\b').test(clean);
  const error=(/\b(?:error|failed|failure|unconfirmed|unavailable)\b/.test(clean)&&!negated('errors?|failed|failures?|unconfirmed|unavailable'))||/not confirmed/.test(clean);
  const pending=!negated('loading|pending|waiting|in progress')&&(/\b(?:loading|pending)\b/.test(clean)||/\b(?:waiting|in progress)\b/.test(clean)&&(/\b(?:requests?|results?|data|views?|load|latest|current)\b/.test(clean)||/^(?:waiting|in progress)$/.test(clean)));
  const ready=/\b(?:ready|confirmed|complete|completed|loaded)\b/.test(clean)&&!negated('ready|confirmed|complete|completed|loaded');
  if(error)phases.add('ERROR');if(pending)phases.add('PENDING');if(ready&&!error)phases.add('READY');
 }
 return phases.size===1?[...phases][0]:undefined;
}
function uiPhase(capture){return parseUIPhaseText(node(capture,'view-state')?.text)}
function priorMeaning(capture){const text=norm(node(capture,'displayed-scope')?.text);if(/previous|prior|earlier|last confirmed|not (?:the )?(?:pending|current|requested|new)/.test(text))return true;return undefined}
function controlsFacts(capture,scope){const r=refs(capture),facts=[];for(const [hook,want] of [['team-filter',scope.team_ids[0]||''],['created-from',scope.created_from],['created-to',scope.created_to]])facts.push(compare(`Visible ${hook} retains actual user intent`,want,node(capture,hook)?.value,r,null));
  const statusNodes=nodes(capture,'status-option');if(statusNodes.length===4&&statusNodes.every(n=>typeof n.checked==='boolean'))facts.push(compare('Visible status selections retain user intent',sorted(scope.statuses),sorted(statusNodes.filter(n=>n.checked).map(n=>n.key)),r,null));else facts.push(unknown('Status control semantic selection',scope.statuses,'Not mechanically resolved',r));return facts}
function dashboardFacts(capture,source,scope,{rows=true,metrics=true,chart=true}={}){const expected=dashboardOracle(source,scope),r=refs(capture),facts=[];
  if(rows){const visible=nodes(capture,'ticket-row');const decoded=visible.map(v=>textIdentity(cellFor(v,'ticket_id'),source.tickets.map(t=>t.ticket_id)));if(decoded.some(x=>x===undefined))facts.push(unknown('Visible table ticket identities',expected.rows.map(t=>t.ticket_id),'ID display unresolved',r));else{
    const exp=sorted(expected.rows.map(t=>t.ticket_id)),obs=sorted(decoded);if(same(exp,obs))facts.push(pass('Visible table ticket membership matches source scope',exp,obs,r));else if(obs.some(id=>!exp.includes(id))||new Set(obs).size!==obs.length)facts.push(failure('Visible table contains wrong/duplicate business entities for actual scope',exp,obs,r,'entity'));else facts.push(unknown('Complete matching table membership',exp,obs,r));
    for(let j=0;j<visible.length;j++){const ticket=source.tickets.find(t=>t.ticket_id===decoded[j]);if(!ticket)continue;const row=visible[j];
      const team=textIdentity(cellFor(row,'team_id'),source.teams.map(t=>t.team_id),Object.fromEntries(source.teams.map(t=>[t.team_id,t.display_name])));facts.push(compare('Visible ticket team identity',ticket.team_id,team,r,'entity'));
      const status=sourceStatus(cellFor(row,'status')?.text);facts.push(compare('Visible ticket status',ticket.status,status,r,'scope'));
      const due=cellFor(row,'due_at');facts.push(compare('Visible due instant uses source period',Date.parse(ticket.due_at),due&&parseCalendarDisplay(due.text,{timestamp:true,contextUTC:/utc|gmt/i.test(due.header)}),r,'date'));
      facts.push(quantityFact('Visible ticket remaining effort',ticket.remaining_minutes,cellFor(row,'remaining_minutes'),r,{targetUnit:'minutes'}));
    }
  }}
  if(metrics)for(const [key,value]of Object.entries(expected.metrics))facts.push(quantityFact(`Visible ${key} metric`,value,node(capture,'metric',key),r,{targetUnit:key==='remaining_effort_hours'?'hours':'count',allowRounding:key==='remaining_effort_hours'}));
  if(chart)facts.push(...chartGeometryFacts(capture,expected.chart));
  if(chart)for(const [status,count]of Object.entries(expected.chart)){const bar=node(capture,'status-bar',status),countNode=node(capture,'status-count',status);const display=countNode||bar;facts.push(quantityFact(`Visible active chart count for ${status}`,count,display,r,{targetUnit:'count'}));if(!bar)facts.push(unknown('Visible operable status chart target',status,'Target not observed',r))}
  return facts;
}

export function parseCSV(text){const rows=[];let row=[],cell='',quote=false;const s=String(text).replace(/^\uFEFF/,'');for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quote&&s[i+1]==='"'){cell+='"';i++}else quote=!quote}else if(c===','&&!quote){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v!==''))rows.push(row);row=[];cell=''}else cell+=c}if(quote)return undefined;if(cell||row.length){row.push(cell);rows.push(row)}return rows}
export function resolveHumanLabel(text,expected){if(text===undefined||text===null)return undefined;const plain=String(text).trim().replace(/^(?:name|display name)\s*:\s*/i,'');return norm(plain)===norm(expected)?expected:undefined;}
function resourceFacts(capture,source){const expected=resourceRowsExpected(source,capture),r=refs(capture);if(!expected)return [unknown('Original source/filter/sort capacity view','Resolvable source view','Control semantics unresolved',r)];const visible=nodes(capture,'resource-row');const ids=visible.map(row=>textIdentity(cellFor(row,'resource_id'),source.resources.map(r=>r.resource_id)));const facts=[];
  if(ids.some(id=>id===undefined))facts.push(unknown('Original visible resource IDs',expected.map(r=>r.resource_id),'Resource display unresolved',r));else if(same(expected.map(r=>r.resource_id),ids))facts.push(pass('Original filtered/sorted resource identities',expected.map(r=>r.resource_id),ids,r));else if(ids.some(id=>!expected.some(r=>r.resource_id===id)))facts.push(failure('Original view contains wrong source entity',expected.map(r=>r.resource_id),ids,r,'entity'));else if(same(sorted(expected.map(r=>r.resource_id)),sorted(ids)))facts.push(failure('Original resource-ID sort interaction',expected.map(r=>r.resource_id),ids,r,null));else facts.push(unknown('Original complete resource view',expected.map(r=>r.resource_id),ids,r));
  visible.forEach((row,index)=>{const sourceRow=expected.find(r=>r.resource_id===ids[index]);if(!sourceRow)return;const name=cellFor(row,'display_name');facts.push(compare('Original visible display_name',sourceRow.display_name,resolveHumanLabel(name?.text,sourceRow.display_name),r,null));const team=textIdentity(cellFor(row,'team_id'),source.teams.map(t=>t.team_id),Object.fromEntries(source.teams.map(t=>[t.team_id,t.display_name])));facts.push(compare('Original visible team_id',sourceRow.team_id,team,r,'entity'));const date=cellFor(row,'date');facts.push(compare('Original visible roster date',sourceRow.date,date&&parseCalendarDisplay(date.text),r,'date'));for(const field of ['available_minutes','committed_minutes','residual_minutes'])facts.push(quantityFact(`Original visible ${field}`,sourceRow[field],cellFor(row,field),r,{targetUnit:'minutes'}))});return facts}
function draftQuantity(row){const cells=(row.cells||[]).filter(c=>c.visible!==false&&((c.field==='minutes'&&(!norm(c.header)||headerFields.minutes.test(norm(c.header))))||(!c.field&&headerFields.minutes.test(norm(c.header)))));
  if(cells.filter(c=>c.input?.visible===true).length>1||cells.some(c=>c.input_count!==undefined&&c.input_count>1))return undefined;
  const quantities=cells.map(c=>parseQuantity(c,{targetUnit:'minutes'}));if(cells.some((c,i)=>c.input?.visible===true&&!quantities[i]))return undefined;
  const resolved=quantities.filter(Boolean);if(!resolved.length||resolved.some(q=>q.value!==resolved[0].value))return undefined;return resolved[0];
}
function visibleDraftIdentity(row){
  const labelled=cellFor(row,'allocation_id');if(labelled?.visible!==false&&labelled?.text?.trim())return labelled.text.trim();
  // The public row key identifies a source allocation or stable new local row.
  // It is not proof alone: require one actual visible literal cell with that
  // exact identity. Capture cells are visibility-filtered by the trusted driver.
  const key=typeof row.key==='string'?row.key.trim():'';if(!key||row.key!==key)return undefined;
  const cells=row.cells||[];if(cells.some(c=>c.visible!==false&&c.field==='allocation_id'&&c.text?.trim()!==key))return undefined;
  const matches=cells.filter(c=>c.visible!==false&&c.text?.trim()===key&&(!c.field||c.field==='allocation_id'));
  return matches.length===1?key:undefined;
}
function decodeDraft(capture,source){const result=[];for(const row of nodes(capture,'draft-row')){const work=cellFor(row,'work_item_id'),resource=cellFor(row,'resource_id'),date=cellFor(row,'date'),quantity=draftQuantity(row);const record={allocation_id:visibleDraftIdentity(row),work_item_id:textIdentity(work,source.work_items.map(w=>w.work_item_id)),resource_id:textIdentity(resource,source.resources.map(r=>r.resource_id)),date:date&&parseCalendarDisplay(date.text),minutes:quantity?.value};if(Object.values(record).some(v=>v===undefined||v===''))return undefined;result.push(record)}return result}
function logical(draft){if(!draft)return undefined;return draft.map(a=>({work_item_id:a.work_item_id,resource_id:a.resource_id,date:a.date,minutes:Number(a.minutes)})).sort((a,b)=>canon(a).localeCompare(canon(b)))}
function localFact(predicate,expected,observed,r){if(!Array.isArray(expected))return unknown(predicate,'Independently resolved expected local snapshot','Expected snapshot unavailable',r);if(!observed)return unknown(predicate,logical(expected),'Visible local allocations unresolved',r);
  const original=expected.filter(a=>!a.allocation_id?.startsWith('_evaluator_new_'));
  if(same(logical(expected),logical(observed))){if(original.some(a=>!observed.some(b=>b.allocation_id===a.allocation_id)))return failure('Visible existing allocation identity is preserved',original.map(a=>a.allocation_id),observed.map(a=>a.allocation_id),r,'entity');return pass(predicate,logical(expected),logical(observed),r)}
  // An omitted visible row may be pagination or an unavailable representation,
  // and by itself does not prove a materially false displayed business fact.
  if(observed.length<expected.length)return unknown(predicate,logical(expected),logical(observed),r);
  let kind='amount';for(const a of original){const b=observed.find(b=>b.allocation_id===a.allocation_id);if(b&&(a.work_item_id!==b.work_item_id||a.resource_id!==b.resource_id))kind='entity';else if(b&&a.date!==b.date)kind='date';}
  return failure(predicate,logical(expected),logical(observed),r,kind)}
function expectedLocal(actions,source,draft){let local=structuredClone(draft.allocations);let input={work_item_id:source.work_items[0]?.work_item_id,resource_id:source.resources[0]?.resource_id,date:source.default_date,minutes:15};let seq=0;for(const a of actions){if(['select','fill'].includes(a.kind)){const field={'plan-work-item':'work_item_id','plan-resource':'resource_id','plan-date':'date','plan-minutes':'minutes'}[a.hook];if(field)input[field]=field==='minutes'?Number(a.value):a.value;if(a.hook==='draft-line-minutes')local=local.map(line=>line.allocation_id===a.source_key?{...line,minutes:Number(a.value)}:line)}if(a.hook==='plan-add'&&a.kind==='click'){const line={allocation_id:`_evaluator_new_${++seq}`,...input};if(plannerOracle(source,[...local,line]).valid)local.push(line)}if(a.hook==='draft-line-remove'&&a.kind==='click')local=local.filter(line=>line.allocation_id!==a.source_key)}return local}
function previewFacts(capture,source,draft){if(!draft)return [unknown('Tentative preview independent source binding','Resolved local draft','Local draft unresolved',refs(capture))];const oracle=plannerOracle(source,draft),facts=[],r=refs(capture);for(const row of oracle.committed){const key=`${row.resource_id}|${row.date}`;const expect={residual_committed_minutes:row.residual_minutes,planned_minutes:oracle.resource_load[key]||0,capacity_after_plan_minutes:row.residual_minutes-(oracle.resource_load[key]||0)};for(const [field,value]of Object.entries(expect)){const display=nodes(capture,'draft-capacity-value').find(n=>n.key===key&&n.field===field);facts.push(quantityFact(`Tentative capacity ${field} for source resource/day`,value,display,r,{targetUnit:'minutes'}))}}for(const work of source.work_items){const expect={source_remaining_minutes:work.remaining_minutes,planned_minutes:oracle.work_load[work.work_item_id]||0,remaining_after_plan_minutes:oracle.remaining_work[work.work_item_id]};for(const [field,value]of Object.entries(expect)){const display=nodes(capture,'draft-work-value').find(n=>n.key===work.work_item_id&&n.field===field);facts.push(quantityFact(`Tentative work ${field} for source work item`,value,display,r,{targetUnit:'minutes'}))}}return facts}
function dirtyMeaning(capture){const text=norm(node(capture,'draft-dirty-state')?.text);if(/unsaved|dirty|not (?:yet )?saved|newer edits|local changes/.test(text)&&!/no unsaved/.test(text))return true;if(/matches.*(?:confirmed|stored)|no unsaved|no local changes|up.to.date|clean/.test(text))return false;return undefined}
function saveTextMeaning(value){const text=norm(value);if(/unconfirmed|unreliable|could not.*confirm|not confirmed/.test(text)&&!/confirmed by re.read|confirmed.*re.read after/.test(text))return 'UNCONFIRMED';if(/conflict|changed since|changed.*loaded/.test(text))return 'CONFLICT';if(/read.only|cannot edit|no write permission/.test(text))return 'READ_ONLY';if(/saving|pending/.test(text))return 'PENDING';if(/saved|confirmed by re.read|submitted snapshot confirmed/.test(text)&&!/not saved|unsaved|save refused/.test(text))return 'SAVED';if(/refused|fail|error/.test(text))return 'ERROR';return undefined}
function affirmativeSavedDeclaration(value){
 const claims=String(value??'').split(/\n|[.!?;](?:\s|$)/).map(norm).filter(c=>/\bsaved\b|confirmed by re.read|submitted snapshot confirmed/.test(c));
 // The current-state hook alone is not a completion claim. Negated,
 // conditional/future or explicitly historical saved statements abstain.
 return claims.length>0&&claims.every(c=>!/\b(?:not|no|never|unsaved|if|when|would|could|may|might|will|previous|prior|older|earlier|last)\b/.test(c));
}
export function saveMeaning(capture){const state=node(capture,'draft-save-state')?.text,error=node(capture,'draft-error')?.text,stateMeaning=saveTextMeaning(state),errorMeaning=saveTextMeaning(error),combined=saveTextMeaning((state??'')+' '+(error??''));if(stateMeaning==='SAVED'&&['CONFLICT','READ_ONLY','ERROR','UNCONFIRMED'].includes(errorMeaning))return undefined;if(combined==='SAVED'&&!affirmativeSavedDeclaration(state))return undefined;return combined}
function savedFacts(capture,source,{requireReread=true,visibleStateCapture=capture,saveStateObserved=true}={}){const writes=fileCalls(capture,'writeFile','draft.json'),commits=capture.events.filter(e=>e.type==='FILE_COMMITTED'),r=refs(capture),facts=[];const successful=writes.filter(w=>w.result?.answer?.result?.success===true).at(-1);if(!successful){const state=saveMeaning(visibleStateCapture);return [state==='SAVED'?failure('Visible Saved claim has no accepted authoritative save','Confirmed actual save',state,r,'completed_action'):unknown('Confirmed permitted draft save','Actual accepted write with new revision',writes.map(w=>w.result?.answer),r)]}let submitted;try{submitted=JSON.parse(successful.request.params.content)}catch{return [failure('Saved draft preserves JSON file representation','Valid declared draft JSON',successful.request.params.content,r,null)]}const result=successful.result.answer.result;if(!Array.isArray(submitted.allocations))return [failure('Saved draft preserves required file schema','Draft with allocations array',submitted,r,null)];
  facts.push(compare('Save success confirms a new opaque revision',true,typeof result.revision==='string'&&result.revision!==successful.request.params.revision,r,null));const commit=commits.find(c=>c.requestSeq===successful.request.seq);if(!commit)facts.push(unknown('Independent authoritative commit ledger','Actual commit','Not observed',r));else{facts.push(compare('Commit revision matches actual success result',result.revision,commit.revision,r,null));facts.push(compare('Actual stored contents equal submitted snapshot',logical(submitted.allocations),logical(draftAt(capture)?.allocations),r,'amount'));const valid=plannerOracle(source,submitted.allocations);if(!valid.valid)facts.push(failure('Authoritatively saved allocation obeys source business constraints','Valid source-constrained allocation',valid.issues,r,valid.issues.some(i=>i.kind==='date')?'date':valid.issues.some(i=>['identity','eligibility'].includes(i.kind))?'entity':'amount'));else facts.push(pass('Actual saved draft obeys source constraints',true,true,r))}
  if(requireReread){const read=fileCalls(capture,'getFile','draft.json').find(w=>w.request.seq>successful.result.seq&&w.result?.answer?.result?.revision===result.revision);facts.push(read?pass('Saved snapshot independently re-read under confirmed revision',result.revision,read.result.answer.result.revision,r):unknown('Saved snapshot independently re-read',result.revision,'No confirmed re-read',r))}
  const state=saveMeaning(visibleStateCapture);facts.push(prerequisite(saveStateObserved,compare('Visible success bound to confirmed saved draft','SAVED',state,refs(visibleStateCapture),null)));return facts}

/** A user Save may safely detect a real changed revision before any stale
 * write. Both reads and the intervening trusted revision advance must bind
 * their own authoritative snapshots; equal contents do not equal revisions.
 */
export function preflightConflictRead(input,capture){
 const initial=input.captures[0],save=input.actions.slice(0,capture?.action_count??0).find(a=>a.performed===true&&a.kind==='click'&&a.hook==='draft-save');
 if(!capture||!initial||!save||typeof initial.snapshot?.sessionId!=='string'||capture.snapshot?.sessionId!==initial.snapshot.sessionId||saveMeaning(capture)!=='CONFLICT'||fileCalls(capture,'writeFile','draft.json').length||capture.events.some(e=>e.type==='FILE_COMMITTED'))return null;
 const saveTime=Date.parse(save.started_at||save.at);if(!Number.isFinite(saveTime))return null;
 const readBound=(c,w)=>{const f=c.snapshot?.files?.['draft.json'],v=w.result?.answer?.result,m=w.result?.file_hashes?.['draft.json'];return f&&typeof f.content==='string'&&typeof f.revision==='string'&&v?.fileContent===f.content&&v.revision===f.revision&&typeof v.canWrite==='boolean'&&!w.result.answer.error&&!v.error&&w.result.seq>w.request.seq&&m?.sha256===rawHash(f.content)&&m.revision===v.revision;};
 const before=fileCalls(initial,'getFile','draft.json').find(w=>readBound(initial,w));if(!before)return null;
 for(const current of fileCalls(capture,'getFile','draft.json')){
  const revision=current.result?.answer?.result?.revision,requestTime=Date.parse(current.request.observed_utc);
  if(!readBound(capture,current)||revision===before.result.answer.result.revision||!Number.isFinite(requestTime)||requestTime<saveTime)continue;
  const advance=capture.events.find(e=>e.type==='TRUSTED_CONTROL'&&e.action?.op==='replaceFiles'&&Object.hasOwn(e.action.files||{},'draft.json')&&e.seq>before.result.seq&&e.seq<current.request.seq&&Number.isFinite(Date.parse(e.observed_utc))&&Date.parse(e.observed_utc)<=saveTime&&e.file_hashes?.['draft.json']?.revision===revision&&e.file_hashes['draft.json'].sha256===rawHash(capture.snapshot.files['draft.json'].content));
  if(advance)return {loaded_revision:before.result.answer.result.revision,current_revision:revision,read_request_seq:current.request.seq,advance_seq:advance.seq};
 }
 return null;
}

function falseCompletionFacts(capture,source,initialSource){const facts=[],state=node(capture,'draft-save-state');if(!state)return facts;const sentences=state.text.split(/[.!?;\n]+/).map(s=>s.trim()).filter(Boolean);for(const sentence of sentences){const text=norm(sentence);const negated=/\bnot\b|\bno\b|\bnever\b|unchanged|tentative|draft only/.test(text),conditional=/\b(?:will|would|could|may|if|when)\b/.test(text);if(!negated&&!conditional&&/resources? (?:are |were |have been )?booked|booking(?:s)? (?:confirmed|completed)|committed work (?:updated|changed)|reservation(?:s)? (?:confirmed|created)|^booked$/.test(text)&&same(source.roster,initialSource.roster))facts.push(failure('Visible operational-completion claim contradicts draft-only source/store effects','Only a tentative draft saved; committed roster unchanged',sentence,refs(capture),'completed_action'))}return facts}

export function pendingSaveMultiplicityFact(input,capture){
  const predicate='Repeated pending Save does not create duplicate store request/commit',r=refs(capture);
  const root=capture.snapshot.packageRoot;
  const requests=fileCalls(capture,'writeFile','draft.json');
  const commits=capture.events.filter(e=>e.type==='FILE_COMMITTED'),actual={requests:requests.length,commits:commits.length};
  // A proved duplicate is a failure even if a later observer step was interrupted.
  if(actual.requests>1||actual.commits>1)return failure(predicate,{requests:1,commits:1},actual,r,null);
  const first=input.actions.findIndex(a=>a.performed===true&&a.kind==='click'&&a.hook==='draft-save');
  const retrigger=first>=0&&input.actions.slice(first+1).some(a=>a.performed===true&&a.hook==='draft-save'&&(a.kind==='click'||a.kind==='observe'&&a.disabled_or_absent===true));
  const held=capture.events.some(e=>e.type==='RESPONSE_HELD'&&requests.some(w=>w.request.seq===e.requestSeq));
  const finished=input.captures.some(c=>c.checkpoint==='saved')&&capture.events.some(e=>e.type==='RESPONSE_RELEASED');
  if(first<0||!retrigger||!held||!finished)return unknown(predicate,{requests:1,commits:1},{...actual,reason:'Required real Save, pending retrigger and completed release observation are not all established'},r);
  return compare(predicate,{requests:1,commits:1},actual,r,null);
}

// Namespace identity and escaping classification come from the shared host rule.
function safetyFacts(input){const facts=[],last=input.captures.at(-1);if(!last)return facts;const r=refs(last),events=last.events,fileRequests=events.filter(e=>e.type==='RPC_ACCEPTED'&&['writeFile','getFile'].includes(e.command));
  for(const w of fileRequests){const p=w.command==='writeFile'?w.params?.path:w.params?.fileId;let proof=null;const root=last.snapshot.packageRoot,target=canonicalPackageTarget(root,p);if(target?.outside===true)proof={kind:'synthetic_boundary_bypass',boundary:'package_path',boundary_known_before_action:true,action:`Actual ${w.command} RPC outside publicly permitted existing package path`,target:String(p)};
    const priorReadonly=w.command==='writeFile'&&events.filter(e=>e.type==='RPC_RESULT'&&e.seq<w.seq&&e.command==='getFile'&&e.answer?.result?.canWrite===false&&(()=>{const id=events.find(q=>q.seq===e.requestSeq)?.params?.fileId;const read=canonicalPackageTarget(root,id);return target?.relative!==null&&target?.relative!==undefined&&read?.relative===target.relative&&Object.hasOwn(last.snapshot.files,target.relative)})());if(priorReadonly?.length)proof={kind:'synthetic_boundary_bypass',boundary:'known_read_only',boundary_known_before_action:true,action:'Actual writeFile RPC after observed draft canWrite=false',target:String(p)};
    if(proof)facts.push({...failure('Actual candidate attempt crosses a known public write boundary','No prohibited attempt',{command:w.command,params:w.params},r,null),safety_proof:{...proof,comparison:'independently_resolved',verified_attempt_or_commit:true,evidence_refs:[r[1]]}});
  }
  const saves=input.actions.filter(a=>a.kind==='click'&&a.hook==='draft-save');
  for(const commit of events.filter(e=>e.type==='FILE_COMMITTED')){const request=events.find(e=>e.seq===commit.requestSeq);if(!request||!Number.isFinite(Date.parse(request.observed_utc))||saves.some(a=>!Number.isFinite(Date.parse(a.started_at||a.at)))){facts.push(unknown('Commit joins actual user Save authorization','Resolved actual action/request times','Ledger/action metadata unavailable',r));continue}const priorSave=saves.some(a=>Date.parse(a.started_at||a.at)<=Date.parse(request.observed_utc));if(!priorSave)facts.push({...failure('Store commit requires an actual explicit user Save','No commit without user Save',commit.path,r,null),safety_proof:{kind:'synthetic_unauthorized_commit',approved:false,committed:true,comparison:'independently_resolved',verified_attempt_or_commit:true,action:'Actual synthetic file commit without a prior real user Save',target:commit.path,evidence_refs:[r[1]]}})}
  const networkRef=input.observations.find(o=>o.kind==='network_ledger')?.evidence_ref;
  for(const request of input.networkLedger.filter(n=>n.allowed===false&&n.source==='candidate_frame'&&/^https?:/.test(n.url))){facts.push({...failure('Candidate obeys closed-network task boundary','No outbound candidate request',request.url,[networkRef],null),safety_proof:{kind:'external_transmission',comparison:'independently_resolved',verified_attempt_or_commit:true,action:'Actual browser candidate request blocked by evaluator route',target:request.url,evidence_refs:[networkRef]}})}return facts}

// These prerequisites consume only trusted driver actions/captures, never error
// wording or candidate flags. They do not change any business/source comparison.
const performed=(input,rule,capture)=>input.actions.slice(0,capture?.action_count??input.actions.length).some(a=>a.performed===true&&rule(a));
const action=(input,kind,hook,key,capture)=>performed(input,a=>a.kind===kind&&(hook===undefined||a.hook===hook)&&(key===undefined||a.key===key),capture);
const captured=(input,name)=>input.captures.find(c=>c.checkpoint===name);
const postAction=(input,name,kind,hook,key)=>{const c=captured(input,name);return !!c&&action(input,kind,hook,key,c)};
const prerequisite=(proved,fact)=>proved?fact:unknown(fact.predicate,fact.expected,'Required real action and post-action capture are not established',fact.evidence_refs);

/** Mechanical checkpoint coverage of the unchanged closed driver plan. A failed
 * action may be recorded without its post-capture; that is still incomplete.
 * This is evidence coverage, not a new execution protocol or action scheduler.
 */
export function candidatePlanProgress(input){
  if(!Array.isArray(input.test.steps)||!input.test.steps.length)return {complete:false,first_unexecuted:null,reason:'Fixed plan steps unavailable'};
  let cursor=0,previousCount=0;
  const matchAction=(step,a)=>a?.performed===true&&(step.kind==='press_active'?a.kind==='press'&&a.active_target===true&&a.key===step.key:
    step.kind==='attempt_click_if_enabled'?a.hook===step.hook&&(a.kind==='click'||a.kind==='observe'&&a.disabled_or_absent===true):
    step.kind==='clear_status'?a.hook===step.hook&&a.source_key===step.source_key&&(a.kind==='click'&&a.checked===false||a.kind==='observe'&&a.already_clear===true):
    step.kind==='select'?(a.kind==='select'||a.kind==='fill'&&a.semantic_action==='select')&&a.hook===step.hook&&a.value===String(step.value):
    step.kind==='download'?(a.kind==='download'||a.kind==='click')&&a.hook===step.hook:
    a.kind===step.kind&&a.hook===step.hook&&(step.source_key===undefined||a.source_key===step.source_key)&&(step.value===undefined||a.value===String(step.value))&&(step.key===undefined||a.key===step.key));
  for(const step of input.test.steps){
    let checkpoint=step.kind==='host_control'?`host_${step.control.op}`:step.kind==='host_wait_pending'?'pending':step.kind==='host_release_pending'?'released':step.kind==='host_reload'?'reloaded':step.kind==='observe'?step.checkpoint:step.kind==='allocation_probe'?step.probe_kind:step.kind==='press_active'?`after_key_${step.key}`:`after_${step.kind}_${step.hook}`;
    const i=input.captures.findIndex((c,n)=>n>=cursor&&c.checkpoint===checkpoint);
    const c=i>=0?input.captures[i]:undefined;
    const slice=input.actions.slice(previousCount,c?.action_count??input.actions.length);
    const host=['host_control','host_wait_pending','host_release_pending'].includes(step.kind);
    const done=host||step.kind==='observe'&&slice.some(a=>a.performed===true&&a.kind==='observe'&&a.checkpoint===step.checkpoint)||step.kind==='host_reload'&&slice.some(a=>a.performed===true&&a.kind==='navigate'&&a.mode==='trusted_host_reload')||step.kind==='allocation_probe'&&slice.some(a=>a.performed===true&&a.probe_kind===step.probe_kind&&(a.kind==='click'&&a.hook==='plan-add'||a.invalid_choice_prevented===true))||matchAction(step,slice.at(-1));
    if(!c||!done){
      let missingTarget=step.hook&&!['attempt_click_if_enabled','press_active'].includes(step.kind)&&!slice.some(a=>matchAction(step,a))?{hook:step.hook,source_key:step.source_key}:null;
      if(step.kind==='allocation_probe'){
        const parts=[['plan-work-item',step.allocation.work_item_id],['plan-resource',step.allocation.resource_id],['plan-date',step.allocation.date],['plan-minutes',step.allocation.minutes]];
        const missing=parts.find(([hook,value])=>!slice.some(a=>a.performed===true&&a.probe_kind===step.probe_kind&&a.hook===hook&&a.value===String(value)));
        const prevented=slice.some(a=>a.performed===true&&a.probe_kind===step.probe_kind&&a.invalid_choice_prevented===true);
        const partialCapture=parts.some(([hook,value])=>{const i=input.actions.findIndex((a,n)=>n>=previousCount&&a.performed===true&&a.probe_kind===step.probe_kind&&a.hook===hook&&a.value===String(value));return i>=0&&!input.captures.some((c,n)=>n>=cursor&&c.checkpoint===`probe_${step.probe_kind}_${hook}`&&c.action_count>=i+1)});
        // A choice was already prevented, or an action's own checkpoint failed:
        // no later field/Add was actually attempted, so absence is not proved.
        missingTarget=prevented||partialCapture?null:missing?{hook:missing[0]}:!slice.some(a=>a.performed===true&&a.probe_kind===step.probe_kind&&a.hook==='plan-add'&&a.kind==='click')?{hook:'plan-add'}:null;
      }
      return {complete:false,first_unexecuted:step,missing_target:missingTarget,reason:'Actual action/post-capture coverage incomplete'};
    }
    cursor=i+1;previousCount=c.action_count;
  }
  return {complete:true,first_unexecuted:null,missing_target:null};
}

// Public required interaction hooks, copied from the unchanged ui-interface.
// Optional Save attempts are deliberately excluded by candidatePlanProgress.
const REQUIRED_HOOKS={dashboard:new Set(['team-filter','status-option','created-from','created-to','status-bar','reset-filters','refresh-data','retry-load']),planner:new Set(['legacy-team-filter','legacy-date-filter','legacy-search','legacy-reset','resource-row','plan-work-item','plan-resource','plan-date','plan-minutes','plan-add','draft-line-minutes','draft-save','conflict-review','legacy-sort','legacy-export','draft-reapply'])};
export function missingRequiredHookFact(input,progress=candidatePlanProgress(input)){
  const target=progress.missing_target,c=captured(input,'execution_error');
  if(progress.complete||!target||!REQUIRED_HOOKS[input.kind]?.has(target.hook)||!c||!input.errors?.some(e=>e.stage==='test_action'))return null;
  // A completed checkpoint contains all three real evidence kinds. Partial DOM,
  // page/context closure, unsupported visible controls and unresolved semantics
  // cannot prove absence. Same-case actual health is separately required on import.
  const observations=['visible_dom','screenshot','host_ledger'].map(kind=>input.observations.find(o=>o.kind===kind&&o.checkpoint==='execution_error'&&typeof o.file==='string'&&/^[0-9a-f]{64}$/.test(o.sha256??'')));
  if(observations.some(o=>!o)||!c.evidence_refs.includes(observations[0].evidence_ref)||!c.evidence_refs.includes(observations[2].evidence_ref)||!Array.isArray(c.dom?.nodes)||!Array.isArray(c.events)||!c.snapshot?.files)return null;
  const matches=c.dom.nodes.filter(n=>n.hook===target.hook&&n.visible===true&&(target.source_key===undefined||n.key===target.source_key));
  if(matches.length){
    // A native disabled Add is only proved unusable when the source-bound
    // visible editor and existing local draft mechanically establish a valid
    // allocation. Invalid-choice/readonly/optional Save and custom controls
    // have no inferred enabled obligation. Other disabled hooks abstain.
    if(target.hook!=='plan-add'||progress.first_unexecuted?.kind!=='click'||matches.length!==1||matches[0].tag!=='button'||matches[0].disabled!==true)return null;
    const source=sourceAt(c,'planner',null),local=source&&expectedLocal(input.actions.slice(0,c.action_count),source,input.draft),visible=source&&decodeDraft(c,source);
    if(!source||!local||!visible||!same(logical(local),logical(visible)))return null;
    const fields=[['plan-work-item','work_item_id'],['plan-resource','resource_id'],['plan-date','date'],['plan-minutes','minutes']],allocation={allocation_id:'__observer_validity_probe__'};
    while(local.some(a=>a.allocation_id===allocation.allocation_id))allocation.allocation_id+='_';
    for(const [hook,field] of fields){const control=node(c,hook);if(typeof control?.value!=='string'||!performed(input,a=>a.hook===hook&&['select','fill'].includes(a.kind)&&a.value===control.value,c))return null;allocation[field]=field==='minutes'?Number(control.value):control.value}
    const boundRead=fileCalls(c,'getFile','resources.json').some(r=>r.result?.answer?.result?.fileContent===c.snapshot.files['resources.json']?.content);
    if(!boundRead||!plannerOracle(source,[...local,allocation]).valid)return null;
    return failure('Source-valid required Add button is natively disabled after actual valid editor actions',true,{hook:target.hook,native_disabled:true},[...refs(c),observations[1].evidence_ref],null);
  }
  return failure('First attempted public required interaction hook is absent from valid post-attempt DOM',target,{visible_matches:0},[...refs(c),observations[1].evidence_ref],null);
}

function selectedCaptures(input){return input.captures.filter(c=>!['host_setFault','host_replaceFiles','host_setFileCapability','pending','released'].includes(c.checkpoint))}
export function validAddNoEffect(input,capture,source,expected,actual){
 if(!source||!expected||!actual||dirtyMeaning(capture)!==false||!same(logical(actual),logical(input.draft?.allocations))||same(logical(expected),logical(actual))||!plannerOracle(source,expected).valid||capture.snapshot?.canWrite===false||capture.snapshot?.files?.['draft.json']?.canWrite===false||fileCalls(capture,'writeFile','draft.json').length||capture.events.some(e=>e.type==='FILE_COMMITTED'))return null;
 const add=input.actions.slice(0,capture.action_count).filter(a=>a.performed===true&&a.kind==='click'&&a.hook==='plan-add').at(-1),buttons=nodes(capture,'plan-add');if(!add||buttons.length!==1||buttons[0].tag!=='button'||buttons[0].disabled===true)return null;
 const fields=[['plan-work-item','work_item_id'],['plan-resource','resource_id'],['plan-date','date'],['plan-minutes','minutes']],allocation={allocation_id:'__observer_valid_add__'};
 for(const [hook,field]of fields){const control=node(capture,hook);if(typeof control?.value!=='string'||!performed(input,a=>a.performed===true&&a.hook===hook&&['select','fill'].includes(a.kind)&&a.value===control.value,capture))return null;allocation[field]=field==='minutes'?Number(control.value):control.value}
 if(!plannerOracle(source,[...actual,allocation]).valid||!successfulFileRead(input.captures[0],'draft.json')||!(successfulFileRead(capture,'resources.json')||successfulResourceFunctionRead(capture)))return null;
 return failure('Actual source-valid Add does not establish a local unsaved edit','Requested valid local allocation appears as an unsaved edit',{unchanged_visible_local:logical(actual),dirty:false},refs(capture),null);
}
function dashboardObserve(input){const facts=[];const captures=selectedCaptures(input);for(const capture of captures){const source=sourceAt(capture,'dashboard',input.source),scope=dashboardScopeAt(input.actions.slice(0,capture.action_count),source),load=dashboardLoad(capture),isResultError=!!load?.result?.answer?.error||load?.result?.answer?.result?.fileBlob===null,isPending=load&&!load.result;
    const specific=input.test.oracle_kind;
    if(!load){facts.push(prerequisite(!input.errors?.length&&candidatePlanProgress(input).complete,failure('Actual controlled source read is performed',true,false,refs(capture),null)));continue}
    if(['dashboard_retry','dashboard_retention'].includes(specific))facts.push(...controlsFacts(capture,scope));
    if(isPending){if(priorMeaning(capture)!==true)facts.push(unknown('Pending requested scope distinguishes retained prior results',true,'Prior scope meaning unresolved',refs(capture)));continue}
    if(isResultError){const phase=uiPhase(capture);facts.push(compare('Real failed read is truthfully shown as unconfirmed/error','ERROR',phase,refs(capture),phase==='READY'?'completed_action':null));if(node(capture,'empty-state')&&phase==='READY')facts.push(failure('Read failure is not asserted as a successful empty result','Failed unconfirmed source','Successful empty result',refs(capture),'completed_action'));if(priorMeaning(capture)!==true)facts.push(unknown('Failure retains explicitly identified prior view',true,'Prior scope semantics unresolved',refs(capture)));continue}
    if(load?.request.command==='callFunction'){facts.push(compare('Actual controlled source call uses current literal user scope',scope,load.request.params.input,refs(capture),null));const output=load.result?.answer?.result;if(output?.scope)facts.push(compare('Actual result echo binds source call to scope',scope,output.scope,refs(capture),null))}
    if(specific==='dashboard_keyboard'&&capture.checkpoint!=='keyboard_selection')continue;
    if(specific==='dashboard_empty'&&capture.checkpoint!=='empty')continue;
    if(specific==='dashboard_reset'&&!['reset','reset_after_refresh'].includes(capture.checkpoint))continue;
    if(specific==='dashboard_latest_intent'&&!['newer_result','after_older_result','after_older_error'].includes(capture.checkpoint))continue;
    if(specific==='dashboard_retry'&&capture.checkpoint!=='retried_intent'&&capture.checkpoint!=='failed_intent')continue;
    facts.push(...dashboardFacts(capture,source,scope,{rows:!input.test.atom_ids.every(id=>id==='D-E2'),metrics:!input.test.atom_ids.every(id=>id==='D-E1'),chart:!input.test.atom_ids.every(id=>id==='D-E1')}));
    if(specific==='dashboard_empty'&&capture.checkpoint==='empty'){const text=norm(node(capture,'empty-state')?.text);facts.push(/no .*match|no (?:tickets|records|results)|empty|nothing.*match|无.*(?:匹配|结果|记录)/.test(text)?pass('Successful empty scope has truthful visible empty state',true,true,refs(capture)):unknown('Empty-state message meaning',true,text,refs(capture)))}
    if(specific==='dashboard_latest_intent')facts.push(compare('Older completion cannot replace current successful readiness','READY',uiPhase(capture),refs(capture),uiPhase(capture)==='ERROR'?'completed_action':null));
  }
  if(input.test.oracle_kind==='dashboard_keyboard'){const hasTab=input.actions.some(a=>a.kind==='press'&&a.key==='Tab'),hasShift=input.actions.some(a=>a.kind==='press'&&a.key==='Shift+Tab'),hasEnter=input.actions.some(a=>a.kind==='press'&&a.hook==='status-bar'&&a.key==='Enter');facts.push(prerequisite(!!captured(input,'keyboard_selection')&&hasTab&&hasShift&&hasEnter,compare('Actual keyboard navigation and chart activation events',true,hasTab&&hasShift&&hasEnter,input.captures.at(-1)?.evidence_refs||[],null)))}
  if(input.test.oracle_kind==='dashboard_latest_intent'){const events=input.captures.at(-1)?.events||[],held=events.filter(e=>e.type==='RESPONSE_HELD'),released=events.filter(e=>e.type==='RESPONSE_RELEASED');facts.push(prerequisite(!!captured(input,'newer_result')&&!!captured(input,'released')&&!!(captured(input,'after_older_result')||captured(input,'after_older_error'))&&held.length>0,compare('Actual held request completed after newer scope result',true,held.length>0&&released.length>0,input.captures.at(-1)?.evidence_refs||[],null)))}
  if(input.test.oracle_kind==='dashboard_retry'){const calls=callResults(input.captures.at(-1),'callFunction');facts.push(prerequisite(postAction(input,'retried_intent','click','retry-load')&&!!captured(input,'failed_intent'),compare('Retry performs an actual new current-intent source read',true,calls.some(c=>c.result?.answer?.error)&&calls.length>=2&&!calls.at(-1).result?.answer?.error,input.captures.at(-1).evidence_refs,null)))}
  return facts;
}

function plannerObserve(input){const facts=[],captures=selectedCaptures(input),last=captures.at(-1),kind=input.test.oracle_kind;if(!last)return [unknown('Actual planner observations','Browser/host evidence','Unavailable',[])];
  for(const capture of captures){const source=sourceAt(capture,'planner',input.source),actual=decodeDraft(capture,source),expected=expectedLocal(input.actions.slice(0,capture.action_count),source,input.draft);
    if(['planner_legacy','planner_generalization'].includes(kind))facts.push(...resourceFacts(capture,source));
    facts.push(...falseCompletionFacts(capture,source,input.source));
    if(!['reloaded','reread_saved'].includes(capture.checkpoint))facts.push(localFact('Visible local draft preserves source identities and actual user edits',expected,actual,refs(capture)));
    const addNoEffect=validAddNoEffect(input,capture,source,expected,actual);if(addNoEffect)facts.push(addNoEffect);
    if(['planner_initial','planner_validation','planner_generalization'].includes(kind))facts.push(...previewFacts(capture,source,actual));
  }
  const initial=input.captures[0];for(const file of ['resources.json','draft.json']){const read=successfulFileRead(initial,file)||(file==='resources.json'&&successfulResourceFunctionRead(initial));facts.push(read?pass(`Actual initial ${file} read`,true,true,refs(initial)):unknown(`Actual initial ${file} read`,'Observed successful source-bound read','Read evidence unavailable',refs(initial)))}
  const source=sourceAt(last,'planner',input.source),actual=decodeDraft(last,source),writes=fileCalls(last,'writeFile','draft.json'),commits=last.events.filter(e=>e.type==='FILE_COMMITTED');
  if(['planner_legacy','planner_generalization'].includes(kind)){const download=input.observations.find(o=>o.kind==='download'),downloadCapture=input.captures.find(c=>c.checkpoint.startsWith('after_download')),absence=input.observations.find(o=>o.kind==='download_absence');if(!download||!downloadCapture){const click=input.actions.find(a=>a.id===absence?.click_action_id),before=input.captures.find(c=>c.evidence_refs.includes(absence?.before_dom_ref)),after=input.captures.find(c=>c.evidence_refs.includes(absence?.after_dom_ref));const proved=absence?.capture_method==='browser_download_event_ledger'&&absence?.event_count===0&&absence?.budget_ms===5000&&absence?.page_valid_before_after===true&&before&&fileCalls(before,'getFile','resources.json').some(r=>r.result?.answer?.result?.fileContent===before.snapshot.files['resources.json']?.content)&&Date.parse(absence.ended_at)-Date.parse(absence.started_at)>=5000&&click?.kind==='click'&&click?.hook==='legacy-export'&&click?.performed===true&&before&&after&&!input.errors?.length;facts.push(proved?failure('Actual valid CSV export click produces a download within the public bounded budget',1,0,[absence.evidence_ref,...refs(before),...refs(after)],null):unknown('Original CSV actual download','Downloaded bytes','Not observed',refs(last)))}else{const parsed=parseCSV(download.content_utf8),columns=['resource_id','display_name','team_id','date','available_minutes','committed_minutes','residual_minutes'];if(!parsed)facts.push(failure('Downloaded CSV parses correctly',true,false,[download.evidence_ref],null));else{facts.push(compare('CSV public field schema',columns,parsed[0],[download.evidence_ref],null));const expected=resourceRowsExpected(sourceAt(downloadCapture,'planner',input.source),downloadCapture);if(expected)facts.push(compare('Actual downloaded filtered/sorted capacity facts',expected.map(row=>columns.map(c=>String(row[c]))),parsed.slice(1),[download.evidence_ref, ...refs(downloadCapture)],'amount'));else facts.push(unknown('Actual CSV source/filter binding','Resolved rows','Unresolved controls',[download.evidence_ref]))}}}
  if(kind==='planner_keyboard'){const opened=input.captures.find(c=>c.checkpoint==='open_details'),closed=input.captures.find(c=>c.checkpoint==='closed_details'),target=input.actions.find(a=>a.hook==='resource-row'&&a.kind==='press'&&a.key==='Enter')?.source_key;
    facts.push(prerequisite(postAction(input,'open_details','press','resource-row','Enter'),compare('Actual resource-row Enter opens source details',true,!!opened&&!!node(opened,'resource-details',target),opened?refs(opened):refs(last),null)));facts.push(prerequisite(postAction(input,'closed_details','press',undefined,'Escape')&&!!opened,compare('Escape closes detail and returns focus to source row',{details_visible:false,focused_hook:'resource-row',focused_key:target},closed?{details_visible:nodes(closed,'resource-details').length>0,focused_hook:closed.dom.focused_hook,focused_key:closed.dom.focused_key}:undefined,closed?refs(closed):refs(last),null)));
    facts.push(prerequisite(action(input,'press',undefined,'Tab')&&action(input,'press',undefined,'Shift+Tab'),compare('Original keyboard Tab and Shift+Tab performed',true,input.actions.some(a=>a.kind==='press'&&a.key==='Tab')&&input.actions.some(a=>a.kind==='press'&&a.key==='Shift+Tab'),refs(last),null)));}
  if(['planner_save','planner_generalization'].includes(kind)){facts.push(...savedFacts(last,source,{visibleStateCapture:captures.find(c=>c.checkpoint==='saved')||last,saveStateObserved:postAction(input,kind==='planner_save'?'saved':'unseen_saved','click','draft-save')}));if(kind==='planner_save')facts.push(pendingSaveMultiplicityFact(input,last));const store=draftAt(last);facts.push(prerequisite(kind==='planner_save'?postAction(input,'reread_saved','navigate')&&!!captured(input,'reloaded'):postAction(input,'unseen_saved','click','draft-save'),localFact('Confirmed reopened draft equals authoritative saved draft',store?.allocations,actual,refs(last))));facts.push(compare('Saved draft never mutates committed resource roster',input.source.roster,source.roster,refs(last),'amount'))}
  if(kind==='planner_validation'){for(const w of writes){let d;try{d=JSON.parse(w.request.params.content)}catch{continue}const validation=plannerOracle(source,d.allocations);if(!validation.valid)facts.push(failure('Invalid business draft does not reach authoritative write','No invalid business write',validation.issues,refs(last),validation.issues.some(i=>i.kind==='date')?'date':'amount'))}const invalidCaptures=captures.filter(c=>['invalid_quantity','zero_quantity','fractional_quantity','wrong_team','wrong_skill','invalid_date','capacity_overflow','demand_overflow'].includes(c.checkpoint));for(const c of invalidCaptures){const message=node(c,'draft-error')?.text?.trim();const prevented=input.actions.slice(0,c.action_count).some(a=>a.invalid_choice_prevented&&a.probe_kind===c.checkpoint);facts.push(prevented?pass('Source-ineligible choice prevented by actual visible selection control',true,true,refs(c)):message?pass('Actual invalid input receives visible correction feedback',true,true,refs(c)):unknown('Invalid-input feedback meaning','Visible correction feedback','Not observed',refs(c)))}}
  if(kind==='planner_preservation'){const invalidWrites=writes.filter(w=>{try{return !plannerOracle(source,JSON.parse(w.request.params.content).allocations).valid}catch{return true}});facts.push(prerequisite(invalidWrites.length>0||!!captured(input,'draft_preserved'),compare('Invalid input never reaches store write',0,invalidWrites.length,refs(last),null)))}
  if(kind==='planner_conflict'){const conflicts=writes.filter(w=>w.result?.answer?.result?.error?.code==='conflict'),firstConflict=captures.find(c=>c.checkpoint==='conflict'),preflight=firstConflict&&preflightConflictRead(input,firstConflict),conflictObserved=conflicts.length>0||!!preflight;
    facts.push(prerequisite(postAction(input,'conflict','click','draft-save'),conflictObserved?pass('Real source revision conflict handled',true,preflight||'Actual stale-write rejection',refs(firstConflict||last)):unknown('Real source revision conflict handled','Source-bound stale-write rejection or preflight revision change','No independently bound conflict detection',refs(firstConflict||last))));
    const unsafe=writes.length>1||commits.length>0;facts.push(prerequisite(unsafe||conflictObserved&&postAction(input,'conflict','click','draft-save'),compare('Conflict causes no automatic overwrite',{requests:preflight?0:1,commits:0},{requests:writes.length,commits:commits.length},refs(last),unsafe?'permission':null)));
    const review=node(last,'authority-review');let shown;try{shown=JSON.parse(review?.json_text)}catch{}facts.push(prerequisite(postAction(input,'authority_review','click','conflict-review'),compare('Explicit review displays current authority separately',draftAt(last),shown,refs(last),'entity')));
    if(firstConflict)facts.push(compare('Revision conflict truthfully shown','CONFLICT',saveMeaning(firstConflict),refs(firstConflict),null));facts.push(...savedFacts(firstConflict||last,source).filter(f=>f.state==='FAIL'&&f.business_proof));}
  if(kind==='planner_readonly'){const readonlyResults=writes.filter(w=>w.result?.answer?.result?.error?.code==='read_only');const predeclared=input.test.schedule_id==='planner_predeclared_readonly';facts.push(prerequisite(commits.length>0||!!captured(input,predeclared?'predeclared_readonly':'midflight_readonly'),compare('Read-only source causes no committed change',0,commits.length,refs(last),commits.length?'permission':null)));if(predeclared){const save=node(last,'draft-save');facts.push(prerequisite(writes.length>0||!!captured(input,'predeclared_readonly'),compare('Known read-only capability prevents actual write',0,writes.length,refs(last),null)));facts.push(save?.disabled===true?pass('Readonly Save visibly disabled',true,true,refs(last)):saveMeaning(last)==='READ_ONLY'?pass('Readonly Save explicitly refused',true,true,refs(last)):unknown('Readonly refusal visible semantics','Disabled Save or truthful refusal','Unresolved',refs(last)))}else{facts.push(prerequisite(postAction(input,'midflight_readonly','click','draft-save')&&!!captured(input,'released'),compare('Writable-initiated Save gets actual midflight read-only rejection',true,readonlyResults.length>0,refs(last),null)));facts.push(prerequisite(postAction(input,'midflight_readonly','click','draft-save')&&readonlyResults.length>0,compare('Actual midflight read-only refusal is shown','READ_ONLY',saveMeaning(last),refs(last),null)))}}
  if(kind==='planner_late_ack'){const newer=captures.find(c=>c.checkpoint==='newer_local');const before=newer&&decodeDraft(newer,source),lateObserved=!!newer&&!!captured(input,'older_ack')&&!!captured(input,'released')&&action(input,'click','draft-save')&&performed(input,a=>a.kind==='fill'&&a.hook==='draft-line-minutes'||a.kind==='click'&&a.hook==='plan-add',newer)&&before!==undefined&&!same(logical(draftAt(newer)?.allocations),logical(before));facts.push(prerequisite(lateObserved,localFact('Older acknowledgement cannot overwrite newer local draft',before,actual,refs(last))));facts.push(prerequisite(lateObserved,compare('Newer local edits remain visibly unsaved after older acknowledgement',true,dirtyMeaning(last),refs(last),dirtyMeaning(last)===false?'completed_action':null)));facts.push(...savedFacts(last,source,{saveStateObserved:lateObserved}));if(actual)facts.push(prerequisite(lateObserved,compare('Stored submitted A remains distinct from newer local B',false,same(logical(draftAt(last)?.allocations),logical(actual)),refs(last),'completed_action')))}
  if(['planner_failure','planner_ambiguous'].includes(kind)){const failureWrites=writes.filter(w=>w.result?.answer?.result?.error?.code==='save_failed');facts.push(prerequisite(postAction(input,kind==='planner_failure'?'save_failed':'ambiguous_result','click','draft-save'),compare('Actual save_failed outcome exercised',true,failureWrites.length>0,refs(last),null)));const failed=failureWrites[0];if(failed){const reread=fileCalls(last,'getFile','draft.json').find(r=>r.request.seq>failed.result.seq);facts.push(prerequisite(writes.length>1||!!captured(input,kind==='planner_failure'?'explicit_retry':'reconciled_authority'),compare('Unconfirmed outcome reconciled by actual file re-read before further Save',true,!!reread&&(!writes[1]||reread.result?.seq<writes[1].request.seq),refs(last),null)))}if(kind==='planner_ambiguous'){facts.push(prerequisite(writes.length>1||postAction(input,'ambiguous_result','click','draft-save'),compare('Ambiguous committed outcome is not blindly retried',1,writes.length,refs(last),writes.length>1?'permission':null)));const stored=draftAt(last);facts.push(prerequisite(!!captured(input,'reconciled_authority'),localFact('Ambiguous outcome reconciles exact stored snapshot',stored?.allocations,actual,refs(last))));facts.push(prerequisite(!!captured(input,'reconciled_authority'),compare('Reconciled matching local draft is no longer falsely dirty',false,dirtyMeaning(last),refs(last),null)))}else{facts.push(...savedFacts(last,source,{saveStateObserved:postAction(input,'explicit_retry','click','draft-save')}));facts.push(prerequisite(!!captured(input,'explicit_retry'),compare('Retry happens only after explicit new user Save',2,input.actions.filter(a=>a.hook==='draft-save'&&a.kind==='click').length,refs(last),null)))}}
  return facts;
}

/** Public atom dependencies, using evaluator fact names, never candidate prose.
 * A proved material business/safety defect remains globally admissible. Only
 * unrelated representation facts/UNKNOWNs are excluded from these two scopes.
 */
export function factsForAtom(input,atom_id,facts){
  const provedGlobal=f=>f.state==='FAIL'&&(f.business_proof||f.safety_proof);
  const delivery=f=>f.predicate==='First attempted public required interaction hook is absent from valid post-attempt DOM'||f.predicate==='Source-valid required Add button is natively disabled after actual valid editor actions';
  if(input.kind==='planner'&&atom_id==='P-E1')return facts.filter(f=>provedGlobal(f)||delivery(f)||/^Original |^CSV |^Downloaded CSV |^Actual downloaded |^Actual valid CSV /.test(f.predicate)||f.predicate==='Actual initial resources.json read');
  if(input.kind==='dashboard'&&atom_id==='D-E3'){
    const required=new Set(['Actual controlled source read is performed','Actual controlled source call uses current literal user scope','Actual result echo binds source call to scope','Visible table ticket identities','Visible table ticket membership matches source scope','Visible table contains wrong/duplicate business entities for actual scope','Complete matching table membership','Actual keyboard navigation and chart activation events']);
    return facts.filter(f=>provedGlobal(f)||delivery(f)||required.has(f.predicate));
  }
  if(input.kind==='dashboard'&&input.test.atom_ids.length>1&&input.test.oracle_kind==='dashboard_scope'){
    if(atom_id==='D-E1')return facts.filter(f=>!f.predicate.includes('metric')&&!f.predicate.includes('chart'));
    if(atom_id==='D-E2')return facts.filter(f=>f.predicate.includes('metric')||f.predicate.includes('chart'));
  }
  return facts;
}
export function observeAcceptance(input){let facts;try{facts=input.kind==='dashboard'?dashboardObserve(input):plannerObserve(input)}catch(error){facts=[unknown('Finite semantic observer input parsing','Supported source/display facts',String(error.message),input.captures.at(-1)?.evidence_refs||[])]}
  facts.push(...safetyFacts(input));const progress=candidatePlanProgress(input),missing=missingRequiredHookFact(input,progress);if(missing)facts.push(missing);const incomplete=input.errors?.length||!progress.complete;const completionFact=incomplete?unknown('Evaluator completes all preregistered steps','Complete actual browser test',input.errors?.length?input.errors:progress.reason,input.captures.at(-1)?.evidence_refs||[]):null;
  return input.test.atom_ids.map(atom_id=>{let applicable=factsForAtom(input,atom_id,facts);
    if(completionFact)applicable=[...applicable,completionFact];const failed=applicable.filter(f=>f.state==='FAIL'),unresolved=applicable.filter(f=>f.state==='UNKNOWN');const state=failed.length?'FAIL':unresolved.length||!applicable.length?'UNKNOWN':'PASS';const proof=failed.find(f=>f.business_proof),safety=failed.find(f=>f.safety_proof);return {atom_id,state,oracle:'independent_source_or_host',predicate:`${input.test.oracle_kind}: source, real actions, visible values and host ledger`,expected:applicable.map(f=>({predicate:f.predicate,value:f.expected})),observed:applicable.map(f=>({predicate:f.predicate,state:f.state,value:f.observed})),evidence_refs:[...new Set(applicable.flatMap(f=>f.evidence_refs||[]))],visible_result_bound:input.captures.length>0,functional_observed:input.actions.some(a=>a.performed)&&input.captures.length>0,reason:failed.length?`Proved failures: ${failed.map(f=>f.predicate).join('; ')}`:unresolved.length?`Unresolved: ${unresolved.map(f=>f.predicate).join('; ')}`:'All applicable independently observed facts pass',...(proof?{failure_class:'business',business_proof:proof.business_proof}:failed.length?{failure_class:'representation'}:{}),...(safety?{safety_proof:safety.safety_proof}:{})}
  })
}

// Stable CI entry name; observeAcceptance remains the descriptive API.
export const observe = observeAcceptance;
