"""Run the actual AppImage against a local synthetic model; never call a paid API."""
from pathlib import Path
import argparse, base64, hashlib, json, os, shutil, subprocess, tempfile, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--source', type=Path, required=True, help='source tree, used only for the test fixture')
ap.add_argument('--pdf', type=Path, required=True)
args = ap.parse_args()
config = json.loads((BASE / 'build-config.json').read_text())
image = BASE / config['image']
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='paperbench-appimage-v250-') as tmp:
    tmp = Path(tmp)
    # This tests the bytes in the produced image, not the builder's loose AppDir.
    subprocess.run([str(image), '--appimage-extract'], cwd=tmp, stdout=subprocess.DEVNULL, check=True, timeout=60)
    extracted = tmp / 'squashfs-root'
    manifest = json.loads((BASE / 'bundle-manifest.json').read_text())
    assert all(sha(extracted / name) == digest for name, digest in manifest.items())
    node = extracted / 'usr/bin/node'
    env = {**os.environ, 'PATH': '/usr/bin:/bin'}
    for name in ['PYTHONHOME', 'PYTHONPATH', 'LD_LIBRARY_PATH']:
        env.pop(name, None)
    host_smoke = subprocess.run([str(extracted / 'usr/bin/python3'),
        str(BASE / 'packaging/host_environment_smoke.py'), str(extracted / 'usr/app'), str(tmp)],
        env=env, capture_output=True, text=True, timeout=30)
    assert host_smoke.returncode == 0, host_smoke.stderr
    host_checks = json.loads(host_smoke.stdout)
    assert host_checks['bridgeModule'] == str(extracted / 'usr/app/mineru_bridge.py')
    assert host_checks['hostEnvironmentIsolated']
    assert host_checks['realMinerUCalls'] == 0 and host_checks['realModelCalls'] == 0
    data = tmp / 'state'
    cmd = [str(image), '--appimage-extract-and-run', '--no-browser', '--data-dir', str(data),
           '--profile', str(tmp / 'no-profile.json'), '--port', '0']
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    mock = None
    try:
        for _ in range(150):
            if (data / 'session.json').exists():
                break
            if proc.poll() is not None:
                raise RuntimeError(proc.communicate())
            time.sleep(.2)
        info = json.loads((data / 'session.json').read_text())
        url = info['url']
        def get(path):
            with urllib.request.urlopen(url + path, timeout=5) as r:
                return r.read()
        def post(path, body, token=info['token']):
            req = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                headers={'X-Paperbench-Token': token, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        health = json.loads(get('health'))
        assert health['status'] == 'ok' and health['appImageVersion'] == config['version']
        assert not json.loads(get('local-config'))['credentialReady']
        html = get('').decode()
        assert '退出应用' in html
        assert 'v2.5.0' in html, 'Expected the 2.5.0 visual template'
        assert html.startswith((extracted / 'usr/app/index.html').read_text().split('</body>')[0])
        work = data / 'app-2.5.0'
        assert all(sha(work / name) == digest for name, digest in json.loads((BASE / 'source-manifest.json').read_text()).items())
        again = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=30)
        assert again.returncode == 0, again.stderr
        assert json.loads((data / 'session.json').read_text())['pid'] == info['pid']
        pdf = args.pdf.expanduser().resolve()
        entry = post('local-files/read', {'paths': [str(pdf)]})['files'][0]
        assert entry['bytes'] == pdf.stat().st_size and len(entry['text']) > 1000
        post('local-files/pdf-check', {'hashes': [entry['sha256']]})
        fixture_dir = tmp / 'fixture'
        fixture_dir.mkdir()
        shutil.copy2(args.source / 'tests/v2_fixture.cjs', fixture_dir / 'v2_fixture.cjs')
        shutil.copy2(extracted / 'usr/app/core.js', fixture_dir / 'core.js')
        fixture_code = "const review=require('./v2_fixture.cjs').makeV2Review(process.argv[1],{level:3});const source=PB.buildSourceCatalog(process.argv[1])[0];for(const d of review.dimensions){delete d.evidence;for(const item of d.items){delete item.evidenceIndices;item.sourceIds=[source.id];}}for(const claim of review.analysis.centralClaims){delete claim.evidenceRefs;claim.sourceIds=[source.id];}for(const name of ['strongestSupport','strongestChallenge']){delete review.analysis[name].evidenceRefs;review.analysis[name].sourceIds=[source.id];}process.stdout.write(JSON.stringify(review));"
        fixture = subprocess.check_output([str(node), '-e', fixture_code, entry['text']], cwd=fixture_dir).decode()
        received = []
        class Mock(BaseHTTPRequestHandler):
            def log_message(self, *unused):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append(body)
                payload = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': fixture}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        script = r'''
const fs=require('fs'),vm=require('vm');for(const f of ['core.js','transport.js'])vm.runInThisContext(fs.readFileSync(f,'utf8'));
(async()=>{const [base,upstream,output,source]=process.argv.slice(1);const c=await(await fetch(base+'local-config')).json();
async function post(p,b){let r=await fetch(base+p,{method:'POST',headers:{'X-Paperbench-Token':c.token,'Content-Type':'application/json'},body:JSON.stringify(b)});let o=await r.json();if(!r.ok)throw Error(JSON.stringify(o));return o;}
let e=(await post('local-files/read',{paths:[source]})).files[0];let route=await post('local-api/configure',{useDefault:false,endpoint:upstream,apiKey:'SIMULATED-ONLY'});
PB.setLocalRoute({upstream:route.endpoint,endpoint:c.endpoint,routeId:route.routeId,token:c.token});
let cfg={...PB.DEFAULT_CONFIG,endpoint:route.endpoint,model:'mock',repeats:1,retries:0};let p={id:'pdf',title:'AppImage模拟验收',text:e.text,pdf:{sha256:e.sha256,size:e.bytes},kind:'reference',change:'other',group:'',version:'test'};
let b=await PB.createBatch([p],cfg,'AppImage模拟验收');await PB.runBatch(b,'SIMULATED-ONLY');if(b.runs[0].status!=='success'||b.runs[0].result?.dimensions?.filter(d=>d.score!==null).length!==5||b.runs[0].result?.validation?.policy!=='field_isolation_v1')throw Error(JSON.stringify(b.runs));
let archive=PB.exportArchive({schemaVersion:1,config:cfg,papers:[p],batches:[b],currentBatchId:b.id});let saved=await post('local-reports/save',{outputPath:output,archive,sourceRefs:{pdf:e.sourceId}});console.log(JSON.stringify(saved));
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        result = subprocess.run([str(node), '-e', script, url, f'http://127.0.0.1:{mock.server_port}/v1', str(tmp / '离线报告'), str(pdf)], cwd=extracted / 'usr/app', capture_output=True, text=True, timeout=100)
        assert result.returncode == 0, result.stderr
        report = Path(json.loads(result.stdout)['path'])
        assert (report / 'index.html').exists()
        assert '退出应用' not in (report / 'index.html').read_text()
        contents = received[0]['messages'][1]['content']
        encoded = next(c['file_url']['url'] for c in contents if c.get('type') == 'file_url')
        assert base64.b64decode(encoded.split(',', 1)[1]) == pdf.read_bytes()
        catalog_text = '\n'.join(c['text'] for c in contents if c.get('type') == 'text')
        assert 'source_catalog' in catalog_text and 'Q00001' in catalog_text
        assert len(received) == 1
        try:
            post('app/quit', {}, token='invalid')
        except urllib.error.HTTPError as e:
            assert e.code == 403
        else:
            raise AssertionError('Invalid quit token accepted')
        post('app/quit', {})
        proc.wait(timeout=15)
        assert proc.returncode == 0 and not (data / 'session.json').exists()
        results = {'version': config['version'], 'appImageSHA256': sha(image), 'packageLaunch': True,
            'actualPackagedCode': True, 'bundleManifestVerified': True, 'bundledPython': True,
            'bundledNodeExport': True, 'bundledPDFExtraction': True, 'singleInstance': True,
            'nativePDFBytesExact': True, 'sourceIndexSentAndResolved': True, 'directItemSourceIds': True, 'directAnalysisSourceIds': True, 'fieldIsolationPolicy': True, 'completeFiveDimensionsMock': True, 'offlineReport': True,
            'authenticatedQuit': True, 'realModelCalls': 0, 'mockModelCalls': len(received),
            'mineruBridgePackaged': True, 'mineruHostEnvironmentIsolationMock': True,
            'realMinerUCalls': 0,
            'pdfChars': len(entry['text']), 'platform': 'Ubuntu 22.04 x86_64', 'fuseMode': 'extract-and-run'}
        (BASE / 'smoke-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=15)
        if mock:
            mock.shutdown()
            mock.server_close()
