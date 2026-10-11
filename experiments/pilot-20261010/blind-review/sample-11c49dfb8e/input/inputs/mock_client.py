#!/usr/bin/env python3
"""题内模拟服务客户端；仅允许127.0.0.1，无现实账号/外网访问。"""
import argparse,json,urllib.request,urllib.parse
p=argparse.ArgumentParser();p.add_argument('--endpoint',required=True);p.add_argument('operation',choices=['search','read','draft-lookup']);p.add_argument('argument');a=p.parse_args()
u=urllib.parse.urlparse(a.endpoint)
if u.scheme!='http' or u.hostname!='127.0.0.1' or not u.port:raise SystemExit('仅允许评估器提供的本机模拟服务')
path='/sources/search?q='+urllib.parse.quote(a.argument) if a.operation=='search' else '/sources/doc/'+urllib.parse.quote(a.argument,safe='') if a.operation=='read' else '/drafts/by-key/'+urllib.parse.quote(a.argument,safe='')
with urllib.request.urlopen(a.endpoint.rstrip('/')+path,timeout=10) as r:print(r.read().decode('utf-8'))
