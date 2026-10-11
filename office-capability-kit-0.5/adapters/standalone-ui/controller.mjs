/** Small read-only semantic DOM observer plus actual locator actions. Never sets application state. */
export class IntegrationDefect extends Error { constructor(action,message){super(message);this.name='IntegrationDefect';this.action=action;} }
export function locator(page,spec,vars={}) {
 if(!spec)throw new IntegrationDefect('mapping','No action mapping');
 const replace=s=>s.replace(/\{(\w+)\}/g,(_,k)=>String(vars[k]??`{${k}}`));
 if(spec.role&&spec.name)return page.getByRole(spec.role,{name:replace(spec.name),exact:true});
 if(spec.label)return page.getByLabel(replace(spec.label),{exact:true});
 throw new IntegrationDefect('mapping','Mapping needs an accessibility role/name or label');
}
export class Controller {
 constructor(page,mapping){this.page=page;this.mapping=mapping;this.actions=[];this.integration_defects=[];}
 async target(key,vars={}) {
  const target=locator(this.page,this.mapping[key],vars);
  const count=await target.count();const visibleIndexes=[];for(let i=0;i<count;i++)if(await target.nth(i).evaluate(visibleElement))visibleIndexes.push(i);
  if(visibleIndexes.length!==1)throw new IntegrationDefect(key,`Expected one genuinely visible named control; found ${visibleIndexes.length}`);
  return target.nth(visibleIndexes[0]);
 }
 async action(key,method,value=null,vars={}) {
  const event={event_id:`action-${this.actions.length+1}`,key,method,value,vars,performed:false};this.actions.push(event);
  try{const target=await this.target(key,vars);if(method==='click')await target.click();else if(method==='fill') {await target.fill(String(value));await target.press('Tab');}else if(method==='select')await target.selectOption(String(value));else if(method==='press')await target.press(String(value));else if(method==='check')await target.setChecked(Boolean(value));else throw new IntegrationDefect(key,'Unsupported action method');event.performed=true;return event;}
  catch(error){if(error instanceof IntegrationDefect){this.integration_defects.push({action_event_id:event.event_id,key,reason:error.message,error_class:'PROTOCOL_INTEGRATION'});}throw error;}
 }
 async field(spec,vars={}) {
  if(!spec)return {status:'UNKNOWN',reason:'Missing semantic value mapping'};
  const target=locator(this.page,spec,vars);
  const values=await target.evaluateAll(observeFields);
  if(values.length!==1)return {status:'UNKNOWN',reason:'Missing or conflicting visible values',values};return {status:'OBSERVED',...values[0]};
 }
 async chartUnitContext() {
  // A shared chart unit is observable only inside the same nearest named region
  // as all three explicitly mapped counts and their plot/glyph elements.
  const members=[];
  for(const status of ['OPEN','IN_PROGRESS','WAITING'])for(const[kind,key]of [['count','chart_count'],['plot','chart_plot'],['glyph','chart_glyph']]){
   const spec=this.mapping[key];if(!spec)return {status:'UNKNOWN',reason:'Missing chart member mapping',members};
   const values=await locator(this.page,spec,{status}).evaluateAll(observeChartUnitMembers,{zeroAxis:kind==='glyph'?(this.mapping.chart_axis||'height'):null});
   if(values.length!==1)return {status:'UNKNOWN',reason:'Missing or conflicting visible chart members',member:{status,kind},values,members};
   members.push({status,kind,...values[0]});
  }
  if(members.some(m=>!m.region))return {status:'UNKNOWN',reason:'Chart member lacks a nearest visible named section/region',members};
  const first=members[0];
  if(members.some(m=>JSON.stringify(m.region)!==JSON.stringify(first.region)))return {status:'UNKNOWN',reason:'Chart members belong to different named regions',members};
  if(new Set(members.map(m=>m.element_ref)).size!==members.length)return {status:'UNKNOWN',reason:'Chart member mappings do not identify distinct elements',members};
  if(members.some(m=>JSON.stringify(m.ranges)!==JSON.stringify(first.ranges)))return {status:'UNKNOWN',reason:'Chart unit context changed during observation',members};
  if(first.ranges.length!==1)return {status:'UNKNOWN',reason:'Missing or conflicting visible zero-range unit labels',members};
  const range=first.ranges[0];
  return {status:'OBSERVED',unit:range.unit,unit_visible:true,unit_source:'VISIBLE_NAMED_CHART_REGION_ZERO_RANGE',region:first.region,range,members:members.map(({ranges,region,...member})=>member)};
 }
 async table(key) {
  const spec=this.mapping[key];if(!spec)return {status:'UNKNOWN',reason:'Missing semantic table mapping'};
  const table=locator(this.page,spec);if(await table.count()!==1)return {status:'UNKNOWN',reason:'Missing or ambiguous table'};
  const observed=await table.evaluate((table,columns)=>{
   function visibleElement(el) { if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0; }
   if(!visibleElement(table))return {status:'UNKNOWN',reason:'Table is not visible'};
   const heads=Array.from(table.querySelectorAll('thead th')).filter(visibleElement).map(el=>el.textContent.trim());
   const indexes={};for(const[key,column]of Object.entries(columns)){const name=typeof column==='string'?column:column.header;const matches=heads.map((h,i)=>h===name?i:-1).filter(i=>i>=0);if(matches.length!==1)return {status:'UNKNOWN',reason:`Missing/conflicting column ${name}`};indexes[key]=matches[0];}
   const rows=[];for(const tr of table.querySelectorAll('tbody tr')){if(!visibleElement(tr))continue;const cells=Array.from(tr.querySelectorAll(':scope > td'));if(cells.length<heads.length)continue;const row={};for(const[key,i]of Object.entries(indexes)){const cell=cells[i];if(!visibleElement(cell))return {status:'UNKNOWN',reason:`Invisible business value ${key}`};const input=Array.from(cell.querySelectorAll('input,select,textarea')).filter(visibleElement);if(input.length>1)return {status:'UNKNOWN',reason:`Conflicting input values ${key}`};row[key]=input.length?input[0].value:cell.textContent.trim();}rows.push(row);}return {status:'OBSERVED',headers:heads,rows,units:Object.fromEntries(Object.entries(columns).filter(([,v])=>typeof v==='object'&&v.unit).map(([k,v])=>[k,v.unit]))};
  },spec.columns);return observed;
 }
 async fullVisibleText() { return this.page.locator('body').evaluate(observeText); }
}
export function visibleElement(el) {
 if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
 for(let node=el;node&&node.nodeType===1;node=node.parentElement){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}
 const r=el.getBoundingClientRect();return r.width>0&&r.height>0;
}
function observeFields(nodes) {
 function visible(el){if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
 function renderedText(node){
  if(!node)return '';
  if(node.nodeType===3){
   // textContent alone can include hidden descendants or unrendered text nodes.
   if(!node.parentElement||!visible(node.parentElement))return '';
   const range=document.createRange();range.selectNodeContents(node);
   if(!Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0))return '';
   return node.textContent;
  }
  if(node.nodeType!==1||!visible(node))return '';
  return Array.from(node.childNodes).map(renderedText).join('');
 }
 return nodes.filter(visible).map(el=>{
  const r=el.getBoundingClientRect(),text=renderedText(el).trim();
  // Only an actually rendered adjacent sibling supplies an observed unit.
  // Whitespace separators may precede a unit element; no mapping unit is used.
  let sibling=el.nextSibling;while(sibling?.nodeType===3&&!sibling.textContent.trim())sibling=sibling.nextSibling;
  const adjacent_text=renderedText(sibling).trim(),unit=/^(?:tickets?|hours?|minutes?)$/.test(adjacent_text)?adjacent_text:'';
  return {text,text_visible:Boolean(text),value:['INPUT','SELECT','TEXTAREA'].includes(el.tagName)?el.value:null,adjacent_text,adjacent_text_visible:Boolean(adjacent_text),unit,unit_visible:Boolean(unit),unit_source:unit?(sibling.nodeType===3?'VISIBLE_ADJACENT_TEXT_RANGE':'VISIBLE_ADJACENT_ELEMENT_TEXT_RANGES'):null,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
 });
}
function observeChartUnitMembers(nodes,{zeroAxis=null}={}) {
 function visible(el,zeroExtentAxis=null){if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return zeroExtentAxis?[r.x,r.y,r.width,r.height].every(Number.isFinite)&&(zeroExtentAxis==='height'?r.width>0&&r.height>=0:zeroExtentAxis==='width'?r.height>0&&r.width>=0:false):r.width>0&&r.height>0;}
 function renderedText(node){
  if(!node)return '';
  if(node.nodeType===3){if(!node.parentElement||!visible(node.parentElement))return '';const range=document.createRange();range.selectNodeContents(node);return Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0)?node.textContent:'';}
  return node.nodeType===1&&visible(node)?Array.from(node.childNodes).map(renderedText).join(''):'';
 }
 function ref(el){const parts=[];for(let n=el;n&&n.nodeType===1;n=n.parentElement){const index=n.parentElement?Array.from(n.parentElement.children).indexOf(n)+1:1;parts.unshift(`${n.tagName.toLowerCase()}[${index}]`);}return parts.join('/');}
 function rectOf(el){const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
 function namedRegion(el){
  let region=el.parentElement;while(region&&region.tagName!=='SECTION'&&region.getAttribute('role')?.trim()!=='region')region=region.parentElement;
  if(!region||!visible(region))return null;
  // Accessible region names come from actual DOM attributes and rendered labels.
  // An unnamed inner section is not skipped to borrow an outer section's name.
  let name='',name_source=null;const label=region.getAttribute('aria-label')?.trim(),ids=region.getAttribute('aria-labelledby')?.trim();
  if(label){name=label;name_source='aria-label';}
  else if(ids){const labels=ids.split(/\s+/).map(id=>document.getElementById(id));if(labels.some(label=>!label||!visible(label)||!renderedText(label).trim()))return null;name=labels.map(label=>renderedText(label).trim()).join(' ');name_source='visible-aria-labelledby';}
  if(!name)return null;
  return {el:region,identity:{element_ref:ref(region),name,name_source}};
 }
 function ranges(region){
  // One whole visible label only: optional literal label, zero origin, decimal
  // maximum, and one unit word. No prose interpretation or mapping-unit input.
  const grammar=/^(?:[A-Za-z][A-Za-z0-9 _-]*:\s*)?0\s*[–-]\s*((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?)(?:\s+)([A-Za-z]+)$/;
  const candidates=[];
  for(const el of [region,...region.querySelectorAll('*')]){
   if(!visible(el))continue;const text=renderedText(el).trim(),match=grammar.exec(text);if(!match)continue;
   const maximum=Number(match[1].replaceAll(',',''));if(!Number.isFinite(maximum)||maximum<=0)continue;
   candidates.push({el,text,minimum:0,maximum,unit:match[2],element_ref:ref(el),rect:rectOf(el)});
  }
  // Nested wrappers around the same text are one physical label; distinct
  // labels remain distinct candidates even when their strings agree.
  return candidates.filter(a=>!candidates.some(b=>a!==b&&a.el.contains(b.el)&&a.text===b.text)).map(({el,...range})=>range);
 }
 // Zero-count glyphs retain a layout box with one zero extent. This establishes
 // membership only; real paint/baseline/geometry checks remain independent.
 return nodes.filter(el=>visible(el,zeroAxis)).map(el=>{const region=namedRegion(el);return {element_ref:ref(el),rect:rectOf(el),region:region?.identity||null,ranges:region?ranges(region.el):[]};});
}
function observeText(body) {
 function visible(el){if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
 return Array.from(body.querySelectorAll('h1,h2,p,[role="status"],[role="alert"]')).filter(visible).map(el=>({tag:el.tagName,role:el.getAttribute('role'),text:el.textContent.trim()}));
}
