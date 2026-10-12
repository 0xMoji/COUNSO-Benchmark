/* Assessor browser worker. It never imports candidate tests or executes their CLI. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let playwright;
try { playwright = require('playwright'); }
catch (error) { process.stdout.write(JSON.stringify({passed:null,reason:'UNKNOWN: install optional playwright dependency (npm install; npx playwright install chromium)',error:String(error)})); process.exit(0); }
const events = [], assertions = [], errors = [], blocked = [];
let browser, server, page;
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(config.fixture_root,name),'utf8')).data;
const data = {base:fixture('sales.json'),updated:fixture('sales-updated.json'),empty:fixture('sales-empty.json'),partial:fixture('sales-partial.json')};
if (config.task === 'R-U04-record-detail') data.base=fixture('records.json');
const root = path.dirname(config.entry);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
function safeAsset(relative) {
  const full = path.resolve(root,relative);
  if (!full.startsWith(root+path.sep) && full !== root) return null;
  let current=full;
  while(current!==root) { if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink()) return null; current=path.dirname(current); }
  return full;
}
const check = async(name,fn) => { await fn(); assertions.push({name,passed:true}); };
const status = name => page.getByRole('status',{name,exact:true});
const num = text => Number(String(text).replace(/[^0-9.\-]/g,''));
const amount = async(name,expected) => { await page.waitForFunction(({name,expected})=>{const e=[...document.querySelectorAll('[role="status"]')].find(x=>x.getAttribute('aria-label')===name);return e && Math.abs(Number(e.textContent.replace(/[^0-9.\-]/g,''))-expected)<0.001;},{name,expected},{timeout:2500}); assert.equal(num(await status(name).innerText()),expected); };
const ids = async(table='Sales') => { const rows=await page.getByRole('table',{name:table,exact:true}).getByRole('row').all();let result=[]; for(const row of rows){const cells=await row.getByRole('cell').allTextContents();if(cells.length)result.push(cells[0].trim());} return result; };
async function dashboard(sort) {
  const sales=data.base.filter(row=>row.type==='SALE');
  const total=rows=>rows.reduce((sum,row)=>sum+Math.round(row.amount*100),0)/100;
  const rowIDs=rows=>rows.map(row=>row.id);
  const sg=sales.filter(row=>row.region==='SG'),sgFebruary=sg.filter(row=>row.month==='2026-02');
  await check('initial revenue and records',async()=>{await amount('Revenue',total(sales));await amount('Count',sales.length);assert.deepEqual(await ids(),rowIDs(sales));});
  await page.getByLabel('Region',{exact:true}).selectOption('SG');
  await check('region filter',async()=>{await amount('Revenue',total(sg));await amount('Count',sg.length);assert.deepEqual(await ids(),rowIDs(sg));});
  await page.getByLabel('Month',{exact:true}).selectOption('2026-02');
  await check('combined filters',async()=>{await amount('Revenue',total(sgFebruary));await amount('Count',sgFebruary.length);assert.deepEqual(await ids(),rowIDs(sgFebruary));});
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  if(sort){await page.getByLabel('Sort',{exact:true}).selectOption('amount_desc');await check('descending order',async()=>assert.deepEqual(await ids(),rowIDs([...sales].sort((a,b)=>b.amount-a.amount||a.id.localeCompare(b.id)))));await page.getByLabel('Sort',{exact:true}).selectOption('amount_asc');await check('ascending order',async()=>assert.deepEqual(await ids(),rowIDs([...sales].sort((a,b)=>a.amount-b.amount||a.id.localeCompare(b.id)))));}
  await page.getByLabel('Region',{exact:true}).selectOption('JP');
  await check('empty results',async()=>{await amount('Revenue',0);await amount('Count',0);assert.equal(await page.getByText('No results',{exact:true}).isVisible(),true);});
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  await check('reset restores original state',async()=>{await amount('Revenue',total(sales));assert.equal(await page.getByLabel('Region',{exact:true}).inputValue(),'ALL');assert.equal(await page.getByLabel('Month',{exact:true}).inputValue(),'ALL');assert.deepEqual(await ids(),rowIDs(sales));});
}
async function form() {
  await page.getByRole('button',{name:'Preview',exact:true}).click();
  await check('invalid empty request blocked',async()=>{assert.equal(await page.getByRole('alert').first().isVisible(),true);assert.equal(events.length,0);});
  await page.getByLabel('Name',{exact:true}).fill('Pine team');await page.getByLabel('Email',{exact:true}).fill('ops@example.test');await page.getByLabel('Seats',{exact:true}).fill('21');await page.getByLabel('Terms',{exact:true}).check();
  if(await page.getByRole('button',{name:'Submit',exact:true}).isEnabled())await page.getByRole('button',{name:'Submit',exact:true}).click();
  await check('upper bound blocks submission',async()=>assert.equal(events.length,0));
  await page.getByLabel('Seats',{exact:true}).fill('3');await amount('Total',37.50);await page.getByRole('button',{name:'Preview',exact:true}).click();
  await check('preview is local and accurate',async()=>{const preview=await status('Preview').innerText();for(const value of ['Pine team','ops@example.test','3','37.50'])assert(preview.includes(value));assert.equal(events.length,0);});
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('[role=status]')].some(e=>e.getAttribute('aria-label')==='Receipt'&&e.textContent.includes('REQ-0001')),{},{timeout:2500});
  const submit=page.getByRole('button',{name:'Submit',exact:true});if(await submit.isEnabled())await submit.click();
  await check('single actual submission with exact payload',async()=>{assert.equal(events.length,1);assert.deepEqual(events[0].payload,{name:'Pine team',email:'ops@example.test',seats:3,total:'37.50'});});
}
async function calculator() {
  await amount('Quote',250);
  for(const [units,price,discount,expected] of [[3,19.99,10,53.97],[0,25,0,0],[1000,10000,100,0],[7,12.50,20,70]]){
    await page.getByLabel('Units',{exact:true}).fill(String(units));await page.getByLabel('Price',{exact:true}).fill(String(price));await page.getByLabel('Discount',{exact:true}).fill(String(discount));
    await check(`quote ${units}/${price}/${discount}`,async()=>amount('Quote',expected));
  }
  for(const [field,value] of [['Units','-1'],['Units',''],['Discount','101']]){
    await page.getByLabel(field,{exact:true}).fill(value);
    await check(`invalid ${field}:${value}`,async()=>{assert.equal(await page.getByRole('alert').first().isVisible(),true);const text=await status('Quote').innerText();assert(!/[0-9]/.test(text),'invalid inputs retain numeric quote');});
    await page.getByLabel(field,{exact:true}).fill(field==='Units'?'7':'20');
  }
}
async function detail() {
  await page.getByLabel('Search',{exact:true}).fill('SG');
  await check('search filters records',async()=>assert.deepEqual(await ids('Records'),['SG-001','SG-003']));
  await page.getByRole('button',{name:'View SG-003',exact:true}).click();
  await check('detail matches selected record and missing value',async()=>{const dialog=page.getByRole('dialog',{name:'Record details',exact:true});assert.equal(await dialog.isVisible(),true);const text=await dialog.innerText();for(const value of ['SG-003','Birch SG','Unknown'])assert(text.includes(value));assert(!text.includes('pine@example.test'));});
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await check('back retains filter',async()=>{assert.equal(await page.getByLabel('Search',{exact:true}).inputValue(),'SG');assert.deepEqual(await ids('Records'),['SG-001','SG-003']);});
  await page.getByLabel('Search',{exact:true}).fill('missing-record');await check('empty search',async()=>assert.equal(await page.getByText('No results',{exact:true}).isVisible(),true));
}
async function update(baseURL) {
  for(const dataset of ['base','updated','empty','partial']){
    const sales=data[dataset].filter(row=>row.type==='SALE');
    const known=sales.filter(row=>typeof row.amount==='number');
    const total=known.reduce((sum,row)=>sum+Math.round(row.amount*100),0)/100;
    await page.goto(baseURL+'/?dataset='+dataset);await check('dataset '+dataset,async()=>{await amount('Revenue',total);await amount('Count',sales.length);await amount('Unknown count',sales.length-known.length);if(!sales.length)assert.equal(await page.getByText('No results',{exact:true}).isVisible(),true);});
  }
}
(async()=>{
  try {
    server=http.createServer(async(req,res)=>{
      try{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/data.json'){const key=url.searchParams.get('dataset')||'base';if(!(key in data)){res.writeHead(400);return res.end('unknown dataset');}res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(data[key]));}
        if(url.pathname==='/api/requests'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)throw Error('payload too large');}const payload=JSON.parse(body);events.push({operation:'request_submit',payload,sequence:events.length+1});res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id:'REQ-'+String(events.length).padStart(4,'0')}));}
        const file=url.pathname==='/'?config.entry:safeAsset(decodeURIComponent(url.pathname.slice(1)));if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('not found');}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
      }catch(error){res.writeHead(400);res.end('bad request');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const baseURL='http://127.0.0.1:'+server.address().port;
    const launch={headless:true};if(process.env.COUNSO_CHROMIUM_EXECUTABLE)launch.executablePath=process.env.COUNSO_CHROMIUM_EXECUTABLE;
    try{browser=await playwright.chromium.launch(launch);}catch(error){process.stdout.write(JSON.stringify({passed:null,reason:'UNKNOWN: browser engine unavailable; run npx playwright install chromium',error:String(error)}));return;}
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===baseURL||url.protocol==='data:'||url.protocol==='blob:')return route.continue();blocked.push(route.request().url());return route.abort();});
    page=await context.newPage();page.setDefaultTimeout(2500);page.on('pageerror',e=>errors.push(String(e)));await page.goto(baseURL+'/');
    switch(config.task){case 'R-U01-dashboard':case 'R-U05-iterative-edit':await dashboard(true);break;case 'R-U05-initial':await dashboard(false);break;case 'R-U02-form':await form();break;case 'R-U03-calculator':await calculator();break;case 'R-U04-record-detail':await detail();break;case 'R-U06-data-update':await update(baseURL);break;default:throw Error('unsupported task');}
    assert.equal(errors.length,0,'uncaught browser errors');assert.equal(blocked.length,0,'external network dependency');
    const screenshot=path.join(config.evidence_dir,'render.png');await page.screenshot({path:screenshot,fullPage:true});
    process.stdout.write(JSON.stringify({passed:true,reason:'Actual browser behavior passed',assertions,events,errors,blocked,screenshot:'render.png',browser_version:browser.version()}));
  }catch(error){if(page)try{await page.screenshot({path:path.join(config.evidence_dir,'failure.png'),fullPage:true});}catch(_){}process.stdout.write(JSON.stringify({passed:page?false:null,reason:(page?'':'UNKNOWN: browser infrastructure: ')+String(error),assertions,events,errors,blocked,screenshot:page?'failure.png':null}));}
  finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
})();
