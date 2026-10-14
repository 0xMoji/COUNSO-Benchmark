"""Standalone public-input UI preview; copied into candidate bundles, no grader imports."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


def create_server(entry, inputs, port=8765):
    entry, inputs = Path(entry).resolve(), Path(inputs).resolve()
    if not entry.is_file():
        raise ValueError('UI entry does not exist')
    data = {}
    for key, filename in {'base': 'sales.json', 'updated': 'sales-updated.json',
                          'empty': 'sales-empty.json', 'partial': 'sales-partial.json'}.items():
        path = inputs / 'extensions' / filename
        if path.is_file():
            data[key] = json.loads(path.read_text(encoding='utf-8'))['data']
    records = inputs / 'extensions/records.json'
    if records.is_file():
        data['base'] = json.loads(records.read_text(encoding='utf-8'))['data']
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == '/data.json':
                dataset = parse_qs(url.query).get('dataset', ['base'])[0]
                if dataset not in data:
                    return self.reply(404, b'{"error":"dataset not in this input bundle"}')
                return self.reply(200, json.dumps(data[dataset]).encode())
            try:
                path = entry if url.path == '/' else entry.parent / unquote(url.path.lstrip('/'))
                if '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
                    raise ValueError('invalid asset path')
                path = path.resolve()
                if not path.is_relative_to(entry.parent) or not path.is_file() or path.stat().st_size > 50_000_000:
                    raise ValueError('invalid asset')
                return self.reply(200, path.read_bytes(), mimetypes.guess_type(path)[0] or 'application/octet-stream')
            except (OSError, ValueError):
                self.reply(404, b'not found', 'text/plain')

        def do_POST(self):
            if urlsplit(self.path).path != '/api/requests':
                return self.reply(404, b'{}')
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 20000:
                    raise ValueError('invalid size')
                payload = json.loads(self.rfile.read(size))
                requests.append(payload)
                self.reply(200, json.dumps({'id': f'REQ-{len(requests):04d}'}).encode())
            except (ValueError, UnicodeError):
                self.reply(400, b'{"error":"invalid request"}')

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser(description='Public-input UI preview, without scoring')
    parser.add_argument('--entry', required=True)
    parser.add_argument('--inputs', default=str(Path(__file__).resolve().parent / 'input/inputs'))
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    with create_server(args.entry, args.inputs, args.port) as server:
        print(f'Preview only: http://127.0.0.1:{server.server_port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
