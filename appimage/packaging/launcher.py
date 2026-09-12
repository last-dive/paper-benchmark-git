import argparse, fcntl, json, os, signal, subprocess, sys, threading, time, urllib.request
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent
PACKAGE = json.loads((BUNDLE/'package-version.json').read_text())
sys.path.insert(0, str(BUNDLE/'app'))
from start_local import create_server, load_profile, LocalHandler

# Never pass bundled library/Python settings to the desktop browser or dialogs.
for name in ('LD_LIBRARY_PATH', 'PYTHONHOME', 'PYTHONPATH'):
    os.environ.pop(name, None)
os.environ['PATH'] = str(BUNDLE/'bin') + ':' + os.environ.get('PATH','/usr/bin:/bin')

def browse(url):
    subprocess.Popen(['/usr/bin/xdg-open',url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--no-browser',action='store_true')
    ap.add_argument('--data-dir',type=Path,default=Path(os.environ.get('XDG_DATA_HOME',str(Path.home()/'.local/share')))/'paperbench-research')
    ap.add_argument('--port',type=int,default=8788)
    ap.add_argument('--stop',action='store_true')
    ap.add_argument('--profile',type=Path,help='明确指定私密配置；指定不存在的文件时不读取其他位置')
    args=ap.parse_args()
    root=args.data_dir.expanduser().resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    state=root/'session.json'
    if args.stop:
        info=json.loads(state.read_text())
        req=urllib.request.Request(info['url']+'app/quit',data=b'{}',headers={'X-Paperbench-Token':info['token']})
        with urllib.request.urlopen(req,timeout=5) as r: print(r.read().decode())
        return
    lock=(root/'instance.lock').open('a')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        for _ in range(50):
            try:
                info=json.loads(state.read_text())
                with urllib.request.urlopen(info['url']+'health',timeout=1) as r:
                    health=json.load(r)
                    assert health['service'].startswith('paperbench-research-v')
                    if health.get('appImageVersion') != PACKAGE['version']:
                        raise RuntimeError('旧版工作台仍在运行，请在旧页面点击“退出应用”，再启动此版本。')
                if not args.no_browser: browse(info['url'])
                print('已打开正在运行的工作台：'+info['url']);return
            except (OSError,ValueError,AssertionError):time.sleep(.1)
        raise RuntimeError('另一实例正在启动，请稍后重试。')
    work=root/('app-'+PACKAGE['workVersion']);work.mkdir(exist_ok=True)
    import shutil
    for p in (BUNDLE/'app').iterdir():
        if p.is_file():shutil.copy2(p,work/p.name)
    # Only known, user-owned local configuration locations; never embed credentials.
    candidates=[root/'.private/model_config.json']
    appimage=os.environ.get('APPIMAGE')
    if appimage:
        folder=Path(appimage).resolve().parent
        candidates += [folder/'.private/model_config.json',folder.parent/'.private/model_config.json']
    candidates += [Path.home()/'chatgpt/paper_benchmark_codex/.private/model_config.json']
    if args.profile is not None:candidates=[args.profile.expanduser().resolve()]
    key=''
    for p in candidates:
        if p.is_file():key=load_profile(p);break
    try:server=create_server(key,args.port,work/'index.html')
    except OSError:server=create_server(key,0,work/'index.html')
    class DesktopHandler(LocalHandler):
        def do_GET(self):
            if self.path=='/health':
                if not self.permitted(): return self.error(403,'仅允许此本机页面访问')
                return self.reply(200,{'status':'ok','service':'paperbench-research-v'+PACKAGE['workVersion'],'appImageVersion':PACKAGE['version'],'credentialReady':bool(self.server.api_key),'workspaceReady':True})
            if self.path in {'/', '/index.html'}:
                if not self.permitted(): return self.error(403,'仅允许此本机页面访问')
                html=self.server.html_path.read_text().replace('</body>',toolbar+'</body>')
                return self.reply(200,html.encode(),'text/html; charset=utf-8',sanitize=False)
            super().do_GET()
        def do_POST(self):
            if self.path=='/app/quit':
                import secrets
                if not self.permitted() or not secrets.compare_digest(self.headers.get('X-Paperbench-Token',''),self.server.session_token):
                    return self.error(403,'会话验证失败')
                self.reply(200,{'stopped':True})
                threading.Thread(target=self.server.shutdown,daemon=True).start();return
            super().do_POST()
    server.RequestHandlerClass=DesktopHandler
    # Reports belong in writable user storage, not the read-only AppImage mount.
    default_output=Path.home()/'chatgpt/paper_benchmark_codex/output'
    if not default_output.is_dir():default_output=root/'output'
    public_config=server.workspace.public_config
    server.workspace.public_config=lambda:{**public_config(),'defaultOutputPath':str(default_output)}
    toolbar='''<div style="position:fixed;right:20px;bottom:16px;z-index:99999"><button onclick="if(confirm('退出应用会中断正在运行的评分。确定退出？'))fetch('/local-config').then(r=>r.json()).then(c=>fetch('/app/quit',{method:'POST',headers:{'X-Paperbench-Token':c.token}})).then(()=>{document.body.innerHTML='<p style=&quot;padding:3em&quot;>应用已退出，可以关闭此页面。</p>'})" style="background:#173849;color:white;border:1px solid #b6aa89;padding:10px 16px;border-radius:5px;cursor:pointer">退出应用</button></div>'''
    url=f'http://127.0.0.1:{server.server_port}/'
    fd=os.open(state,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:json.dump({'url':url,'token':server.session_token,'pid':os.getpid()},f)
    def stop(*unused):threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    print('Paperbench AppImage '+PACKAGE['version']+' '+url,flush=True)
    if not args.no_browser:browse(url)
    try:server.serve_forever()
    finally:
        server.server_close();state.unlink(missing_ok=True)

if __name__=='__main__':
    try:main()
    except Exception as exc:
        message='论文评审启动失败：'+str(exc)
        print(message,file=sys.stderr)
        if os.environ.get('DISPLAY') and '--no-browser' not in sys.argv:
            subprocess.run(['/usr/bin/zenity','--error','--text='+message],check=False)
        sys.exit(1)
