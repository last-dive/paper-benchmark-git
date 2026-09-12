"""One real loopback workflow with a local simulated model; no external API use."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from start_local import create_server

ROOT=Path(__file__).resolve().parent
TEXT='This controlled study reports a defined population, explicit assumptions, comparison conditions and the limits of the evidence. '


class FullWorkflowTest(unittest.TestCase):
    def test_read_custom_api_one_round_and_complete_offline_report(self):
        self.workflow(False)

    def test_native_pdf_one_round_and_offline_report(self):
        self.workflow(True)

    def workflow(self, pdf):
        node=shutil.which('node');self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix='paperbench-e2e-') as tmp:
            work=Path(tmp);app=work/'应用 程序';app.mkdir()
            for name in ['index.html','export_offline.cjs']:shutil.copy2(ROOT/name,app/name)
            source=work/('输入 文稿.pdf' if pdf else '输入 文稿.txt');source.write_bytes(b'%PDF-1.7\nMock PDF original bytes' if pdf else TEXT.encode())
            fixture=subprocess.check_output([node,'-e',"process.stdout.write(JSON.stringify(require('./v2_fixture.cjs').makeV2Review(process.argv[1],{level:3})))",TEXT],cwd=ROOT).decode()
            received=[]
            class MockModel(BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    received.append({'body':body,'authorization':self.headers.get('Authorization')})
                    result={'model':'SIMULATED-WORKFLOW','choices':[{'finish_reason':'stop','message':{'content':fixture}}],'usage':{'prompt_tokens':10,'completion_tokens':20,'total_tokens':30}}
                    data=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            upstream=ThreadingHTTPServer(('127.0.0.1',0),MockModel);ut=threading.Thread(target=upstream.serve_forever,daemon=True);ut.start()
            server=create_server('DEFAULT-KEY-MUST-NOT-REACH-MOCK',0,app/'index.html');st=threading.Thread(target=server.serve_forever,daemon=True);st.start()
            if pdf:server.workspace._extract=lambda data,suffix:(TEXT,1,['Mock text extraction for transport workflow only'])
            script=r'''
const fs=require('node:fs'),vm=require('node:vm');
for(const name of ['core.js','transport.js'])vm.runInThisContext(fs.readFileSync(name,'utf8'));
(async()=>{
 const [base,upstream,source,output]=process.argv.slice(1);
 const profile=await (await fetch(base+'/local-config')).json();
 async function post(route,body){const res=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Paperbench-Token':profile.token},body:JSON.stringify(body)});const obj=await res.json();if(!res.ok)throw new Error(JSON.stringify(obj));return obj;}
 const files=await post('/local-files/read',{paths:[source],recursive:true});if(files.errors.length||files.files.length!==1)throw new Error('Input failed');
 const entry=files.files[0];const route=await post('/local-api/configure',{endpoint:upstream,useDefault:false,apiKey:'CUSTOM-TEST-ONLY'});
 PB.setLocalRoute({upstream:route.endpoint,endpoint:profile.endpoint,routeId:route.routeId,token:profile.token});
 const cfg={...PB.DEFAULT_CONFIG,endpoint:route.endpoint,model:'SIMULATED-WORKFLOW',repeats:1,retries:0,thinking:'omit',reasoningEffort:'omit',sendDoSample:false};
 const paper={...(source.endsWith('.pdf')?{pdf:{sha256:entry.sha256,size:entry.bytes}}:{}),id:'p-smoke',title:'模拟流程验证',text:entry.text,kind:'reference',change:'other',group:'',version:'test'};
 const b=await PB.createBatch([paper],cfg,'SIMULATED · 工作流验证');try{await PB.runBatch(b,'CUSTOM-TEST-ONLY');}catch(e){if(!source.endsWith('.pdf')||!e.message.includes('部分维度'))throw e;}
 if(b.status!=='complete')throw Error('Scorable fixture should complete');
 if(b.runs.length!==1||b.runs[0].status!=='success')throw new Error('Scoring failed: '+JSON.stringify(b.runs));
 const archive=PB.exportArchive({schemaVersion:1,config:cfg,papers:[paper],batches:[b],currentBatchId:b.id});
 const saved=await post('/local-reports/save',{outputPath:output,archive,sourceRefs:{'p-smoke':entry.sourceId}});
 const page=await (await fetch(base+saved.indexUrl)).text();if(!page.includes('PB_OFFLINE_ARCHIVE'))throw new Error('Offline archive absent');
 const second=await post('/local-reports/save',{outputPath:output,archive,sourceRefs:{'p-smoke':'expired-source-id'}});
 if(saved.path===second.path)throw new Error('Report overwritten');
 console.log(JSON.stringify({saved,second,archive,metadata:JSON.parse(fs.readFileSync(saved.path+'/source_metadata.json','utf8'))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
'''
            try:
                args=[node,'-e',script,f'http://127.0.0.1:{server.server_port}',f'http://127.0.0.1:{upstream.server_port}/v1',str(source),str(work/'报告 输出')]
                result=subprocess.run(args,cwd=ROOT,text=True,capture_output=True,timeout=60)
                self.assertEqual(result.returncode,0,result.stderr)
                data=json.loads(result.stdout);self.assertEqual(len(received),1)
                self.assertEqual(received[0]['authorization'],'Bearer CUSTOM-TEST-ONLY')
                body=received[0]['body']
                if pdf:
                    import base64
                    url=body['messages'][1]['content'][0]['file_url']['url'];self.assertEqual(base64.b64decode(url.split(',',1)[1]),source.read_bytes())
                    self.assertIn('source_catalog',json.dumps(body));self.assertEqual(data['archive']['batches'][0]['papers'][0]['pdf']['size'],source.stat().st_size)
                    self.assertTrue((Path(data['saved']['path'])/'source_catalog.json').exists())
                else: self.assertIn(TEXT,body['messages'][1]['content'])
                for field in ['thinking','reasoning_effort','do_sample']:self.assertNotIn(field,body)
                for report in [data['saved'],data['second']]:
                    path=Path(report['path'])
                    for name in ['archive.json','index.html','summary.csv','run_scores.csv','usage.csv','README.md','source_metadata.json']:self.assertTrue((path/name).is_file())
                    for f in path.rglob('*'):
                        if f.is_file():
                            for secret in [b'CUSTOM-TEST-ONLY',b'DEFAULT-KEY-MUST-NOT-REACH-MOCK']:self.assertNotIn(secret,f.read_bytes())
                self.assertEqual(data['archive']['batches'][0]['config']['repeats'],1)
                self.assertEqual(source.read_bytes(),b'%PDF-1.7\nMock PDF original bytes' if pdf else TEXT.encode())
            finally:
                server.shutdown();server.server_close();st.join();upstream.shutdown();upstream.server_close();ut.join()


if __name__=='__main__':unittest.main(verbosity=2)
