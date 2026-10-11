/** Independent evaluator arithmetic. Does not import any reference application/model code. */
export function dashboardFacts(source,scope) {
 const rows=source.tickets.filter(r=>(!scope.team_ids.length||scope.team_ids.includes(r.team_id))&&scope.statuses.includes(r.status)&&Date.parse(r.created_at)>=Date.parse(`${scope.created_from}T00:00:00Z`)&&Date.parse(r.created_at)<Date.parse(`${scope.created_to}T00:00:00Z`));
 let active=0,overdue=0,minutes=0;const chart={OPEN:0,IN_PROGRESS:0,WAITING:0};
 for(const r of rows)if(r.status!=='CLOSED'){active++;if(Date.parse(r.due_at)<Date.parse(source.as_of))overdue++;minutes+=r.remaining_minutes;chart[r.status]++;}
 return {rows,metrics:{ticket_count:rows.length,active_count:active,overdue_active_count:overdue,remaining_effort_hours:minutes/60},chart};
}
export function plannerPreview(source,draft) {
 const capacity=source.roster.map(r=>{const tentative=draft.allocations.filter(a=>a.resource_id===r.resource_id&&a.date===r.date).reduce((v,a)=>v+a.minutes,0);const residual=r.available_minutes-r.committed_minutes;return {resource_id:r.resource_id,date:r.date,residual_minutes:residual,tentative_minutes:tentative,remaining_minutes:residual-tentative};});
 const work=source.work_items.map(w=>{const tentative=draft.allocations.filter(a=>a.work_item_id===w.work_item_id).reduce((v,a)=>v+a.minutes,0);return {work_item_id:w.work_item_id,source_remaining_minutes:w.remaining_minutes,tentative_minutes:tentative,remaining_minutes:w.remaining_minutes-tentative};});return {capacity,work};
}
export function equalRows(actual,expected,keys,{ordered=false}={}) {
 if(!actual||actual.status!=='OBSERVED')return {status:'UNKNOWN',reason:actual?.reason||'Missing visible table'};
 function normalize(rows,actualSide){
  const normalized=[];for(const row of rows){const out={};for(const key of keys){let value=row[key];
   if(key==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return null;const d=new Date(String(value)+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)return null;value=d.toISOString().slice(0,10);}
   else if(key.endsWith('_at')){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value))||!Number.isFinite(Date.parse(value)))return null;value=new Date(value).toISOString();}
   else if(key.endsWith('_minutes')||key==='minutes'){if(String(value).trim()===''||!Number.isFinite(Number(value)))return null;value=Number(value);if(actualSide&&actual.units?.[key]==='hours')value*=60;else if(actualSide&&actual.units?.[key]&&!['minutes','hours'].includes(actual.units[key]))return null;}
   out[key]=String(value);
  }normalized.push(out);}return normalized;
 }
 const a=normalize(actual.rows,true),e=normalize(expected,false);if(!a||!e)return {status:'UNKNOWN',reason:'Visible date/time/unit/number meaning unsupported; independent source-bound review needed',observed:actual};
 if(!ordered){const sort=rows=>rows.sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));sort(a);sort(e);}
 return {status:JSON.stringify(a)===JSON.stringify(e)?'PASS':'FAIL',expected:e,observed:a};
}
export function numericFact(observed,expected,unit) {
 // Decode only a complete scalar, optionally followed by one explicit unit word.
 // Commas are thousands separators in groups of three; a dot is the decimal mark.
 // No prefix extraction, locale inference, exponents, coercion or unit conversion.
 const unknown=reason=>({status:'UNKNOWN',reason});
 if(!observed||observed.status!=='OBSERVED'||typeof observed.text!=='string'||observed.text_visible===false||typeof expected!=='number'||!Number.isFinite(expected))return unknown('No unambiguous visible numeric output');
 const match=/^(-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?)(?:\s+([A-Za-z]+))?$/.exec(observed.text.trim());
 if(!match)return unknown('No unambiguous visible numeric output');
 const value=Number(match[1].replaceAll(',',''));
 if(!Number.isFinite(value))return unknown('No unambiguous visible numeric output');
 if(typeof unit!=='string'||!unit.trim()||!/^\s*[A-Za-z]+\s*$/.test(unit))return unknown('Displayed unit absent or unsupported');
 const adjacentText=observed.unit===undefined?'':typeof observed.unit==='string'?observed.unit.trim():null;
 if(adjacentText===null)return unknown('Displayed unit absent or unsupported');
 // A neighboring explanation is not a unit declaration. Only the bounded
 // ticket/hour/minute unit vocabulary can supplement or conflict with a value.
 const adjacent=/^(?:tickets?|hours?|minutes?)$/.test(adjacentText)?adjacentText:'';
 if(adjacent&&observed.unit_visible===false)return unknown('Displayed unit absent or unsupported');
 const inline=match[2]||'';
 if(inline&&adjacent&&inline!==adjacent)return unknown('Conflicting visible units');
 const displayedUnit=inline||adjacent;
 if(displayedUnit!==unit.trim())return unknown('Displayed unit absent or unsupported');
 return {status:Math.abs(value-expected)<1e-9?'PASS':'FAIL',expected,observed:value};
}
export function geometryFact(chart,expected) {
 const names=['OPEN','IN_PROGRESS','WAITING'],axis=chart?.axis||'height';
 if(!chart||!chart.stable||!['height','width'].includes(axis)||!chart.values||names.some(k=>!chart.values[k]))return {status:'UNKNOWN',reason:'Missing/unstable/unsupported real plot geometry'};
 const values=names.map(status=>[status,chart.values[status]]);
 if(values.some(([,v])=>!v.plotVisible||!v.glyphObservable||![v.plot.x,v.plot.y,v.plot.width,v.plot.height,v.glyph.x,v.glyph.y,v.glyph.width,v.glyph.height].every(Number.isFinite)||v.plot.width<=0||v.plot.height<=0||v.glyph.width<0||v.glyph.height<0))return {status:'UNKNOWN',reason:'Missing/hidden/nonmeasurable real geometry'};
 let scale=null,baseline=null;
 for(const [status,v]of values){if(Math.abs(v.plot[axis]-values[0][1].plot[axis])>2)return {status:'FAIL',reason:'Plot extents differ',observed:chart};const length=v.glyph[axis];const b=axis==='height'?v.glyph.y+length:v.glyph.x;if(baseline===null)baseline=b;else if(Math.abs(b-baseline)>2)return {status:'FAIL',reason:'Zero baseline differs',observed:chart};if(!expected[status]){if(length>2)return {status:'FAIL',reason:'Nonzero glyph for zero count',observed:chart};}else {if(length<=2)return {status:'FAIL',reason:'Positive count has no visible plotted extent',observed:chart};const thisScale=length/expected[status];if(scale===null)scale=thisScale;else if(Math.abs(length-scale*expected[status])>2)return {status:'FAIL',reason:'Wrong common count-to-length proportion',observed:chart};}}
 return {status:'PASS',expected,observed:chart,scope:'Stable linear zero-baseline geometry only; no aesthetic/image inspection claim'};
}
