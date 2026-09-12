#!/usr/bin/env python3
"""Local Paperbench app: private model routes, file input and offline reports."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from local_proxy import ProxyHandler, make_server, upstream_url, MAX_RESPONSE, read_upstream_error
from local_workspace import LocalWorkspace
from mineru_bridge import MinerUJobs

ROOT = Path(__file__).resolve().parent
DEFAULT_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
DEFAULTS = dict(inputMode='pdf', model='glm-5.3-flash', temperature=0.2, topP=0.95,
                maxTokens=32768, seed=None, responseJson=True, thinking='disabled',
                reasoningEffort='omit', doSample=True, sendDoSample=True, timeout=900,
                retries=0, concurrency=1, repeats=5, maxChars=2000000,
                paperType='engineering', anchors='')
MAX_LOCAL_REQUEST = 192 * 1024 * 1024
MAX_MODEL_REQUEST = 16 * 1024 * 1024


def load_profile(file):
    file = Path(file)
    if file.is_symlink():
        raise ValueError('私密配置不可为符号链接')
    if os.name == 'posix' and stat.S_IMODE(file.stat().st_mode) & 0o077:
        raise ValueError('私密配置权限过宽，请运行 chmod 600 ' + str(file))
    obj = json.loads(file.read_text(encoding='utf-8'))
    key = obj.get('api_key')
    if not isinstance(key, str) or not key.strip():
        raise ValueError('私密配置缺少 api_key；可运行 configure_local.py 设置')
    if obj.get('endpoint', DEFAULT_ENDPOINT) != DEFAULT_ENDPOINT:
        raise ValueError('默认私密配置只用于指定的 BigModel Coding 端点')
    return key.strip()


class LocalHandler(ProxyHandler):
    server_version = 'PaperbenchResearch/2.1'

    def permitted(self):
        expected_host = '127.0.0.1:' + str(self.server.server_port)
        if self.headers.get('Host') != expected_host:
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != 'http://' + expected_host:
            return False
        return self.headers.get('Sec-Fetch-Site') in {None, 'none', 'same-origin'}

    def reply(self, code, body, content_type='application/json; charset=utf-8', sanitize=True):
        if not sanitize:
            return super().reply(code, body, content_type, redact_secrets=False)
        keys = self.server.known_secrets()
        def clean(value):
            if isinstance(value, str):
                for key in keys:
                    value = value.replace(key, '[API_KEY_REDACTED]')
                return value
            if isinstance(value, list): return [clean(x) for x in value]
            if isinstance(value, dict): return {clean(str(k)):clean(v) for k,v in value.items()}
            return value
        if isinstance(body, dict):
            body = clean(body)
        elif isinstance(body, bytes):
            for key in keys: body = body.replace(key.encode(), b'[API_KEY_REDACTED]')
            if content_type.startswith('application/json'):
                try: body = json.dumps(clean(json.loads(body)), ensure_ascii=False).encode()
                except (ValueError, UnicodeError): pass
        return super().reply(code, body, content_type)

    def do_GET(self):
        if not self.permitted(): return self.error(403, '仅允许此本机页面访问')
        if self.path in {'/', '/index.html'}:
            return self.reply(200, self.server.html_path.read_bytes(), 'text/html; charset=utf-8', sanitize=False)
        if self.path == '/local-config':
            return self.reply(200, {'config':{**DEFAULTS, 'endpoint':DEFAULT_ENDPOINT},
                'endpoint':self.server.local_endpoint, 'upstream':DEFAULT_ENDPOINT,
                'token':self.server.session_token, 'credentialReady':bool(self.server.api_key),
                'workspace':self.server.workspace.public_config()})
        if self.path == '/health':
            return self.reply(200, {'status':'ok','service':'paperbench-research-v2.2',
                                    'credentialReady':bool(self.server.api_key),'workspaceReady':True})
        if self.path.startswith('/local-reports/view/'):
            try:
                body, mime = self.server.workspace.get_report(self.path)
                return self.reply(200, body, mime, sanitize=False)
            except (ValueError, FileNotFoundError, PermissionError):
                return self.error(404, '报告资源不存在或路径不可访问')
        return self.error(404, '资源不存在')

    def read_json(self, maximum):
        if self.headers.get('Transfer-Encoding'): raise ValueError('不支持分块请求体')
        try: length = int(self.headers.get('Content-Length','0'))
        except ValueError: raise ValueError('Content-Length无效')
        if length <= 0 or length > maximum: raise ValueError(f'请求为空或超过{maximum//1024//1024}MiB')
        obj = json.loads(self.rfile.read(length))
        if not isinstance(obj, dict): raise ValueError('请求必须是JSON对象')
        return obj

    def do_POST(self):
        token=self.headers.get('X-Paperbench-Token','')
        if not self.permitted() or not secrets.compare_digest(token,self.server.session_token):
            return self.error(403, '会话验证失败，请从本机启动地址重新打开页面')
        if self.path in {'/v1/chat/completions','/chat/completions'}:
            return self.forward_model()
        actions={
            '/local-mineru/start':self.server.mineru.start,
            '/local-mineru/status':self.server.mineru.status,
            '/local-mineru/cancel':self.server.mineru.cancel,
            '/local-files/pdf-check':self.server.workspace.pdf_check,
            '/local-files/read':self.server.workspace.read_paths,
            '/local-files/upload':self.server.workspace.upload_files,
            '/local-files/pick':self.server.workspace.pick,
            '/local-output/validate':self.server.workspace.validate_output,
            '/local-reports/save':self.server.workspace.save_report,
            '/local-api/configure':self.configure_route,
        }
        action=actions.get(self.path)
        if not action: return self.error(404,'本机操作不存在')
        try:
            payload=self.read_json(MAX_LOCAL_REQUEST)
            return self.reply(200, action(payload))
        except (ValueError, UnicodeError, TypeError) as exc:
            return self.error(400,str(exc)[:1000])
        except FileNotFoundError as exc: return self.error(404,str(exc)[:1000])
        except PermissionError as exc: return self.error(403,str(exc)[:1000])
        except (RuntimeError, OSError) as exc: return self.error(500,str(exc)[:1000])

    def configure_route(self, obj):
        if not isinstance(obj.get('useDefault'),bool): raise ValueError('必须明确选择默认或自定义API')
        if obj['useDefault']:
            endpoint, key = DEFAULT_ENDPOINT, self.server.api_key
            if not key: raise ValueError('本机尚未配置默认密钥；请配置默认密钥或选择自定义API')
        else:
            if not isinstance(obj.get('endpoint'),str) or not obj['endpoint'].strip():
                raise ValueError('请填写自定义API地址')
            endpoint=upstream_url(obj['endpoint'])
            key=obj.get('apiKey','')
            if not isinstance(key,str) or len(key)>8192 or '\r' in key or '\n' in key:
                raise ValueError('API Key格式无效')
            key=key.strip()  # Empty means explicitly no key, never inherit default credentials.
        parsed=urllib.parse.urlsplit(endpoint)
        if parsed.hostname in {'127.0.0.1','localhost','::1'} and parsed.port==self.server.server_port:
            raise ValueError('上游不能指向此工作台自身；请填写实际模型服务地址')
        route_id=secrets.token_hex(24)
        with self.server.routes_lock:
            if len(self.server.routes)>=1024: raise ValueError('本机会话路由数量达到上限，请重启本机服务')
            self.server.routes[route_id]=(endpoint,key)
        return {'endpoint':endpoint,'routeId':route_id}

    def forward_model(self):
        route_id=self.headers.get('X-Paperbench-Route')
        if route_id:
            with self.server.routes_lock: route=self.server.routes.get(route_id)
            if route is None: return self.error(409,'本机API会话已失效，请重新配置后恢复任务')
        else: route=(self.server.upstream,self.server.api_key)
        endpoint,key=route
        try:
            obj=self.read_json(MAX_MODEL_REQUEST)
            if not isinstance(obj.get('model'),str) or not isinstance(obj.get('messages'),list) or obj.get('stream') is not False:
                raise ValueError('缺少model/messages或stream不是false')
        except (ValueError, UnicodeError) as exc: return self.error(400,'JSON请求无效：'+str(exc)[:160])
        try: obj=self.server.workspace.hydrate_pdf(obj)
        except (ValueError,TypeError,AttributeError) as exc: return self.error(400,str(exc))
        headers={'Content-Type':'application/json','Accept':'application/json'}
        if key: headers['Authorization']='Bearer '+key
        request=urllib.request.Request(endpoint,data=json.dumps(obj,ensure_ascii=False).encode(),headers=headers,method='POST')
        try:
            with self.server.opener.open(request,timeout=self.server.timeout_seconds) as response:
                data=response.read(MAX_RESPONSE+1)
                if len(data)>MAX_RESPONSE: return self.reply(502,{'error':{'code':'upstream_response_too_large','message':'上游成功响应超过16MiB，未作为完整评分接收；请检查模型输出设置。'}})
                return self.reply(response.status,data)
        except urllib.error.HTTPError as exc:
            if 300<=exc.code<400:
                exc.close()
                return self.error(502,'上游返回重定向，请填写最终API地址')
            status,data=read_upstream_error(exc,obj)
            return self.reply(status,data)
        except (TimeoutError,socket.timeout): return self.error(504,'等待上游超时；服务端可能仍在处理请求')
        except (urllib.error.URLError,OSError): return self.error(502,'无法连接上游，请检查API地址和网络')


def create_server(key='', port=8787, html_path=None):
    server=make_server(DEFAULT_ENDPOINT,port=port,key=key,timeout=900)
    server.RequestHandlerClass=LocalHandler
    server.html_path=Path(html_path) if html_path else ROOT/'index.html'
    server.session_token=secrets.token_hex(32)
    server.local_endpoint=f'http://127.0.0.1:{server.server_port}/v1/chat/completions'
    server.routes={};server.routes_lock=threading.Lock()
    def known_secrets():
        with server.routes_lock: return tuple({x for x in [server.api_key,*[r[1] for r in server.routes.values()]] if x})
    server.known_secrets=known_secrets
    server.workspace=LocalWorkspace(server.html_path.parent,secrets_provider=known_secrets)
    server.mineru=MinerUJobs(server.workspace)
    server.workspace.mineru_registry=server.mineru.get_conversion
    close=server.server_close
    def close_with_jobs():
        server.mineru.close()
        close()
    server.server_close=close_with_jobs
    return server


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8787)
    parser.add_argument('--profile',type=Path,default=ROOT/'.private/model_config.json')
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args()
    if not 1<=args.port<=65535: parser.error('port须为1–65535')
    try:
        key=load_profile(args.profile) if args.profile.exists() else ''
        server=create_server(key,args.port)
    except (OSError,ValueError) as exc: parser.error(str(exc))
    url=f'http://127.0.0.1:{server.server_port}/'
    print('Paperbench Research v2.5.0：'+url,flush=True)
    print('本机文件与报告服务已启用。'+('默认凭据已加载。' if key else '可在网页中配置自定义API。')+' 按 Ctrl+C 退出。',flush=True)
    if not args.no_browser: webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__=='__main__':main()
