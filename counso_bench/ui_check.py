"""Portable subprocess boundary for assessor-owned browser behavior checks."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from .io import BenchError, safe_path, sha256, write_json

def ui_asset_manifest(directory, max_bytes=50_000_000, max_files=10_000):
    """Bind the complete served artifact subtree, excluding assessor-owned evidence."""
    directory=Path(directory)
    if directory.is_symlink():raise BenchError('UI resource directory cannot be a symlink')
    directory=directory.resolve()
    files=[];total=0
    for current,dirs,names in os.walk(directory,followlinks=False):
        dirs[:]=sorted(name for name in dirs if name!='.assessor')
        for name in dirs:
            if (Path(current)/name).is_symlink():raise BenchError('UI resources cannot contain symlink directories')
        for name in sorted(names):
            if name=='.assessor':continue
            relative=str((Path(current)/name).relative_to(directory))
            path=safe_path(directory,relative)
            if len(files)>=max_files:raise BenchError('UI resource subtree exceeds file-count limit')
            size=path.stat().st_size;total+=size
            if total>max_bytes:raise BenchError('UI resource subtree exceeds byte limit')
            files.append({'path':relative.replace(os.sep,'/'),'bytes':size,'sha256':sha256(path,max_bytes=max_bytes)})
    files.sort(key=lambda item:item['path'])
    payload={'files':files,'file_count':len(files),'total_bytes':total}
    canonical=json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
    return {**payload,'sha256':hashlib.sha256(canonical).hexdigest()}

def check_ui(path, task, output_dir, root):
    path, output_dir, root = Path(path), Path(output_dir).resolve(), Path(root).resolve()
    if not path.is_file() or path.suffix.lower() not in {".html", ".htm"}:
        return False, "UI 入口必须是存在的 HTML 文件"
    if path.stat().st_size > 5_000_000:
        return False, "UI 入口超过 5 MB 支持范围"
    try:
        resources=ui_asset_manifest(path.parent)
        evidence=safe_path(output_dir,'.assessor/'+task)
    except (BenchError,OSError) as exc:
        return False,'UI resource validation failed: '+str(exc)
    node = os.environ.get("COUNSO_NODE") or shutil.which("node")
    worker = Path(__file__).with_name("ui_worker.cjs")
    evidence.mkdir(parents=True, exist_ok=True)
    request = {"entry": str(path.resolve()), "task": task, "fixture_root": str((root / "fixtures/extensions").resolve()), "evidence_dir": str(evidence.resolve())}
    if not node:
        observed={'passed':None,'reason':'UNKNOWN: 缺少 Node.js；安装 UI 可选依赖后重跑，不代表 UI 通过'}
    else:
        with tempfile.TemporaryDirectory(prefix="counso-ui-check-") as tmp:
            config = Path(tmp) / "request.json"
            write_json(config, request)
            try:
                completed = subprocess.run([node, str(worker), str(config)], capture_output=True, text=True, timeout=50, check=False)
                observed = json.loads(completed.stdout)
                if not isinstance(observed,dict) or observed.get('passed') not in (True,False,None):
                    raise ValueError('invalid browser result envelope')
            except (json.JSONDecodeError,ValueError) as exc:
                observed={'passed':None,'reason':'UNKNOWN: 浏览器核验器输出错误: '+str(exc)}
            except (OSError, subprocess.TimeoutExpired) as exc:
                observed={'passed':None,'reason':'UNKNOWN: 浏览器核验器无法完成: '+str(exc)}
    observed['resource_manifest']=resources
    try:
        after=ui_asset_manifest(path.parent)
        if after['sha256']!=resources['sha256']:
            observed['resource_manifest_after']=after;observed['passed']=False;observed['reason']='UI resources changed during assessor execution'
    except (OSError,BenchError) as exc:
        observed['passed']=False;observed['reason']='UI resources became invalid during assessor execution: '+str(exc)
    observed["entry_sha256"] = next(item['sha256'] for item in resources['files'] if item['path']==path.name)
    observed["worker_sha256"] = sha256(worker)
    observed["origin"] = "ASSESSOR_BROWSER"
    observed["task"] = task
    write_json(evidence / "observations.json", observed)
    reason = observed.get("reason", "UI behavior checked")
    return observed.get("passed"), reason + "; evidence=" + str((evidence / "observations.json").relative_to(output_dir))

def preview(entry, task, root, port=8765):
    """Read-only local preview plus disposable form mock; no scoring is performed."""
    import mimetypes
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, unquote, urlsplit
    from .io import load_json
    entry,root=Path(entry).resolve(),Path(root).resolve()
    if not entry.is_file():raise BenchError('UI entry does not exist')
    fixtures=root/'fixtures/extensions'
    data={key:load_json(fixtures/filename)['data'] for key,filename in {'base':'sales.json','updated':'sales-updated.json','empty':'sales-empty.json','partial':'sales-partial.json'}.items()}
    if task=='R-U04-record-detail':data['base']=load_json(fixtures/'records.json')['data']
    events=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def send(self,status,body,content_type='application/json'):
            self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            url=urlsplit(self.path)
            if url.path=='/data.json':
                dataset=parse_qs(url.query).get('dataset',['base'])[0]
                if dataset not in data:return self.send(400,b'{"error":"unknown dataset"}')
                return self.send(200,json.dumps(data[dataset]).encode())
            try:
                path=entry if url.path=='/' else safe_path(entry.parent,unquote(url.path.lstrip('/')))
                if not path.is_file():return self.send(404,b'not found','text/plain')
                self.send(200,path.read_bytes(),mimetypes.guess_type(path)[0] or 'application/octet-stream')
            except (OSError,BenchError):self.send(404,b'not found','text/plain')
        def do_POST(self):
            if urlsplit(self.path).path!='/api/requests':return self.send(404,b'{}')
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=20000:raise ValueError('invalid size')
                payload=json.loads(self.rfile.read(size));events.append(payload)
                self.send(200,json.dumps({'id':f'REQ-{len(events):04d}'}).encode())
            except (ValueError,json.JSONDecodeError):self.send(400,b'{"error":"invalid request"}')
    with ThreadingHTTPServer(('127.0.0.1',port),Handler) as server:
        print('Preview only; no score or assessor evidence. Open http://127.0.0.1:'+str(server.server_port)+'/',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass

def main():
    import argparse
    from .io import ROOT
    parser=argparse.ArgumentParser(description='Local UI preview; does not call an agent or score an answer')
    parser.add_argument('command',choices=['preview']);parser.add_argument('--entry',required=True);parser.add_argument('--task',required=True)
    parser.add_argument('--root',default=str(ROOT));parser.add_argument('--port',default=8765,type=int)
    args=parser.parse_args();preview(args.entry,args.task,args.root,args.port)

if __name__=='__main__':main()
