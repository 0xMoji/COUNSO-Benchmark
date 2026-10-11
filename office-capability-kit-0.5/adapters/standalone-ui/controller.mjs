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
 return nodes.filter(visible).map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim(),value:['INPUT','SELECT','TEXTAREA'].includes(el.tagName)?el.value:null,unit:el.nextSibling?.textContent.trim()||'',rect:{x:r.x,y:r.y,width:r.width,height:r.height}};});
}
function observeText(body) {
 function visible(el){if(typeof el.checkVisibility==='function'&&!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
 return Array.from(body.querySelectorAll('h1,h2,p,[role="status"],[role="alert"]')).filter(visible).map(el=>({tag:el.tagName,role:el.getAttribute('role'),text:el.textContent.trim()}));
}
