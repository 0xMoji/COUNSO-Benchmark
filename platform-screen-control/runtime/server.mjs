import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { compileFrame } from './compiler.mjs';
import { ProxySession } from './model.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const escapeScript = s => s.replace(/<\/script/gi, '<\\/script');
const styles = `body{font:15px system-ui,sans-serif;margin:16px;color:#17202a;background:#fff}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed}table{border-collapse:collapse;width:100%}th,td{padding:7px;border-bottom:1px solid #ddd;text-align:left}.bg-background{background:var(--background,#fff)}.text-foreground{color:var(--foreground,#17202a)}.font-sans{font-family:system-ui,sans-serif}*:focus-visible{outline:3px solid #1976d2;outline-offset:2px}`;
function csp(nonce, outer = false) { return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ${outer ? "'self'" : "'none'"}; frame-src ${outer ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; ${outer ? '' : 'sandbox allow-scripts allow-downloads;'}`; }
const auth = (provided, expected) => typeof provided === 'string' && provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
async function readJson(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 5 * 1024 * 1024) throw new Error('Payload too large'); }
  return JSON.parse(data);
}
function outerScript(id, token) {
  return `const id=${JSON.stringify(id)},token=${JSON.stringify(token)},iframe=document.querySelector('#frame');
  const call=async(route,payload)=>{const response=await fetch('/'+route+'/'+id,{method:payload===undefined?'GET':'POST',headers:{'X-Frame-Proxy-Token':token,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});if(!response.ok)throw new Error(await response.text());return response.json()};
  window.frameProxy=Object.freeze({control:a=>call('control',a),snapshot:()=>call('snapshot'),events:()=>call('events'),reload:()=>{iframe.src='/frame/'+id+'?reload='+crypto.randomUUID();}});
  window.addEventListener('message',async event=>{
    if(event.source!==iframe.contentWindow||event.data?.identifier!==id)return;
    const request=event.data;if(typeof request.command!=='string'||typeof request.messageUniqueId!=='string')return;
    try{
      let downloadBlob=null;
      if(request.command==='downloadFileRequest'){
        if(!(request.params?.blob instanceof Blob))throw new Error('Invalid download Blob');
        downloadBlob=request.params.blob;
        const bytes=new Uint8Array(await request.params.blob.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.slice(i,i+8192));
        request.params={contentBase64:btoa(s),filename:request.params.filename};
      }
      const answer=await call('rpc',request);
      if(downloadBlob&&!answer.error){
        const filename=answer.result?.filename||'download.txt',url=URL.createObjectURL(downloadBlob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
        answer.result={blob:downloadBlob,filename};
      }
      if(request.command==='getFile'&&answer.result&&typeof answer.result.fileContent==='string'){
        answer.result.fileBlob=new Blob([answer.result.fileContent],{type:answer.result.contentType});delete answer.result.fileContent;delete answer.result.contentType;
      }
      iframe.contentWindow.postMessage({command:'answer',identifier:id,messageUniqueId:request.messageUniqueId,...answer},'*');
    }catch(error){iframe.contentWindow.postMessage({command:'answer',identifier:id,messageUniqueId:request.messageUniqueId,error:{code:'transport_error',message:error.message}},'*');}
  });`;
}
export async function startProxy({ packageDir, kind, files, interfacePath = path.join(ROOT, 'ui-interface.json'), artifactDir, port = 0 }) {
  kind = kind === 'create' ? 'dashboard' : kind === 'edit' ? 'planner' : kind;
  if (!['dashboard', 'planner'].includes(kind)) throw new Error('Unsupported task kind');
  const iface = JSON.parse(await fs.readFile(interfacePath, 'utf8'));
  const built = await compileFrame(packageDir);
  const session = new ProxySession({ kind, files, contract: iface.tasks[kind], artifactDir });
  const token = randomBytes(32).toString('hex');
  if (artifactDir) { await fs.writeFile(path.join(artifactDir, 'build-evidence.json'), JSON.stringify(built.evidence, null, 2)); await fs.writeFile(path.join(artifactDir, 'candidate.bundle.js'), built.code); }
  const id = session.id;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && url.pathname === '/host/' + id && auth(url.searchParams.get('token'), token)) {
        const nonce = randomBytes(18).toString('base64'); res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.setHeader('Content-Security-Policy', csp(nonce, true));
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Controlled Frame proxy</title><style>body{margin:0;font:14px system-ui}header{padding:8px;background:#eef1f4}iframe{display:block;width:100%;height:calc(100vh - 36px);border:0}</style></head><body><header>Frames contract-aligned controlled proxy · native Counso status UNKNOWN</header><iframe id="frame" title="Candidate Frame" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer" src="/frame/${id}"></iframe><script nonce="${nonce}">${escapeScript(outerScript(id, token))}</script></body></html>`); return;
      }
      if (req.method === 'GET' && url.pathname === '/frame/' + id) {
        const nonce = randomBytes(18).toString('base64'); res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.setHeader('Content-Security-Policy', csp(nonce));
        const boot = `window.__FRAME_PROXY_IDENTIFIER__=${JSON.stringify(id)};window.addEventListener('error',e=>window.parent.postMessage({identifier:window.__FRAME_PROXY_IDENTIFIER__,messageUniqueId:crypto.randomUUID(),command:'proxyFrameError',params:{message:e.message,source:'browser_error'}},'*'));window.addEventListener('unhandledrejection',e=>window.parent.postMessage({identifier:window.__FRAME_PROXY_IDENTIFIER__,messageUniqueId:crypto.randomUUID(),command:'proxyFrameError',params:{message:String(e.reason),source:'unhandled_rejection'}},'*'));`;
        res.end(`<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="app"></div><script nonce="${nonce}">${escapeScript(boot + '\n' + built.code)}</script></body></html>`); return;
      }
      if (!auth(req.headers['x-frame-proxy-token'], token)) { res.writeHead(403); res.end('Forbidden'); return; }
      if (req.method === 'POST' && url.pathname === '/rpc/' + id) {
        const request = await readJson(req); if (request.identifier !== id) { res.writeHead(403); res.end('Invalid identifier'); return; }
        if (request.command === 'proxyFrameError') { session.log('FRAME_REPORTED_DIAGNOSTIC', { params: request.params, self_report_only: true }); json({ result: null }); return; }
        json(await session.rpc(request)); return;
      }
      if (req.method === 'POST' && url.pathname === '/control/' + id) { json(await session.control(await readJson(req))); return; }
      if (req.method === 'GET' && url.pathname === '/snapshot/' + id) { json(session.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/events/' + id) { json(session.events); return; }
      res.writeHead(404); res.end('Not found');
    } catch (error) { session.log('HOST_REQUEST_ERROR', { path: url.pathname, message: error.message }); res.writeHead(400); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  session.log('SERVER_READY', { origin, build_sha256: built.evidence.bundle_sha256 });
  return { url: `${origin}/host/${id}?token=${token}`, origin, sessionId: id, session, build: built.evidence,
    routeAllowlist: [`/host/${id}`, `/frame/${id}`, `/rpc/${id}`, `/control/${id}`, `/snapshot/${id}`, `/events/${id}`],
    allowedPaths: [`/host/${id}`, `/frame/${id}`, `/rpc/${id}`, `/control/${id}`, `/snapshot/${id}`, `/events/${id}`],
    close: async () => { for (const p of session.pending.values()) p.resolve(); session.pending.clear(); await new Promise(r => server.close(r)); session.log('SERVER_CLOSED'); } };
}
