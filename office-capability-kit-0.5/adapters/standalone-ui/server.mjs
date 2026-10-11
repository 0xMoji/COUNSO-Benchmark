import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import {noSymlinks,safeAsset,verifiedAsset} from './package-boundary.mjs';
import {TOOL_PATHS} from './reference/api-contract.mjs';
import {createHash} from 'node:crypto';
import { SyntheticAuthority } from './mock-service.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function fixtures(which='public') {
 if(!['public','evaluator'].includes(which))throw new Error('Unknown fixed fixture set');
 const json=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
 return { dashboard:await json(`tasks/ui/ui-dashboard/${which}/source.json`),resources:await json(`tasks/ui/ui-planner/${which}/resources.json`),draft:await json(`tasks/ui/ui-planner/${which}/draft.json`) };
}
export async function startServer({fixture='public',authority=null,candidateDir=null,assets=null,kind='dashboard'}={}) {
 if(!['dashboard','planner'].includes(kind))throw new Error('Unknown standalone task kind');
 authority ||= new SyntheticAuthority({...await fixtures(fixture),task_kind:kind});
 const staticRoot=await noSymlinks(candidateDir?resolve(candidateDir):fileURLToPath(new URL('reference',import.meta.url)));
 const allowedAssets=new Set((assets || ['/index.html','/app.mjs','/dashboard-model.mjs','/planner-model.mjs','/api-contract.mjs','/style.css']).map(safeAsset));for(const asset of allowedAssets)await verifiedAsset(staticRoot,asset);
 const api=new Map(Object.entries(TOOL_PATHS).map(([tool,{method,path}])=>[`${method} ${path}`,tool]));
 const html=(await readFile(await verifiedAsset(staticRoot,'/index.html'),'utf8')).replaceAll('\r\n','\n');const inlineHashes=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match=>!(/\bsrc\s*=/i.test(match[1]))).map(match=>"'sha256-"+createHash('sha256').update(match[2]).digest('base64')+"'");
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  try {
   if(req.url.includes('\\')||req.url.split('?')[0].includes('%')||req.url.split('?')[0].split('/').some(x=>x==='..'||x==='.')||req.url.startsWith('//')){res.writeHead(400);res.end('Invalid path');return;}
   const url=new URL(req.url,'http://127.0.0.1');const route=`${req.method} ${url.pathname}`;requests.push({method:req.method,path:url.pathname});
   res.setHeader('Content-Security-Policy',`default-src 'self'; connect-src 'self'; script-src 'self' ${inlineHashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'`);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
   if(api.has(route)) {
    let body='';for await(const chunk of req){body+=chunk;if(body.length>100000){res.writeHead(413);res.end();return;}}
    let input={};try{input=body?JSON.parse(body):{};}catch{input={decode_error:true};}const result=await authority.request(api.get(route),input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
   }
   const name=url.pathname==='/'?'/index.html':url.pathname.replace(/^\/reference/,'');
   if(req.method!=='GET'||!allowedAssets.has(name)){res.writeHead(404);res.end('Unsupported route');return;}
   const bytes=await readFile(await verifiedAsset(staticRoot,name));const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css'};res.setHeader('Content-Type',types[extname(name)]||'application/octet-stream');res.end(bytes);
  }catch(error){res.writeHead(500);res.end(JSON.stringify({ok:false,code:'host_error',error_class:'INSTRUMENTATION'}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:`http://127.0.0.1:${server.address().port}`,authority,requests,allowedPaths:['/','/api/dashboard-source','/api/dashboard-load','/api/planner-source','/api/draft',...allowedAssets].concat([...allowedAssets].map(x=>`/reference${x}`)),close:()=>new Promise(resolve=>{for(const pending of [...authority.pending])authority.release(pending.request_id,'observer_teardown');server.close(resolve);server.closeIdleConnections?.();const timer=setTimeout(()=>server.closeAllConnections?.(),1000);timer.unref();})};
}
