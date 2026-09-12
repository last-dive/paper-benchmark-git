import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from start_local import create_server, DEFAULT_ENDPOINT


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'index.html').write_text('<h1>local-workspace</h1>')
        self.server=create_server('GLM-PRIVATE-DEFAULT',0,self.root/'index.html')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)
        with urllib.request.urlopen(self.base+'/local-config') as res:self.profile=json.loads(res.read())
        self.token=self.profile['token'];self.requests=[]
        outer=self
        class FakeReply:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'{"choices":[{"message":{"content":"ok"}}]}'
        class FakeOpener:
            def open(self,request,**kwargs):outer.requests.append(request);return FakeReply()
        self.server.opener=FakeOpener()

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()

    def post(self,path,obj,headers=None):
        req=urllib.request.Request(self.base+path,data=json.dumps(obj).encode(),headers={'Content-Type':'application/json','X-Paperbench-Token':self.token,**(headers or {})})
        with urllib.request.urlopen(req) as res:return json.loads(res.read())

    def forward(self,route=None):
        return self.post('/v1/chat/completions',{'model':'custom-model','messages':[],'stream':False},{'X-Paperbench-Route':route} if route else {})

    def test_custom_and_default_keys_are_isolated_and_routes_are_immutable(self):
        a=self.post('/local-api/configure',{'useDefault':False,'endpoint':'http://127.0.0.1:9955/v1','apiKey':'CUSTOM-ONE'})
        b=self.post('/local-api/configure',{'useDefault':False,'endpoint':'http://127.0.0.1:9955/v1','apiKey':'CUSTOM-TWO'})
        default=self.post('/local-api/configure',{'useDefault':True,'endpoint':'https://unrelated.invalid','apiKey':'UNUSED'})
        blank=self.post('/local-api/configure',{'useDefault':False,'endpoint':'http://127.0.0.1:9955/v1','apiKey':''})
        for entry in [a,b,default,a,blank]:self.forward(entry['routeId'])
        self.assertEqual([r.get_header('Authorization') for r in self.requests],['Bearer CUSTOM-ONE','Bearer CUSTOM-TWO','Bearer GLM-PRIVATE-DEFAULT','Bearer CUSTOM-ONE',None])
        self.assertEqual(self.requests[2].full_url,DEFAULT_ENDPOINT)
        self.assertEqual(a['endpoint'],'http://127.0.0.1:9955/v1/chat/completions')
        self.assertNotIn('GLM-PRIVATE-DEFAULT',json.dumps(self.profile))
        self.assertTrue(self.profile['workspace']['enabled'])

    def test_all_local_mutations_require_same_origin_and_token(self):
        for route in ['/local-api/configure','/local-files/read','/local-files/upload','/local-files/pick','/local-output/validate','/local-reports/save','/local-mineru/start','/local-mineru/status','/local-mineru/cancel']:
            for headers in [{'X-Paperbench-Token':''},{'Origin':'null'},{'Origin':'https://untrusted.invalid'},{'Sec-Fetch-Site':'cross-site'}]:
                with self.assertRaises(urllib.error.HTTPError) as ctx:self.post(route,{},headers)
                self.assertEqual(ctx.exception.code,403)
        self.assertEqual(self.requests,[])

    def test_route_validation_and_no_fallback_for_expired_session(self):
        for obj in [
            {'useDefault':False,'endpoint':'http://untrusted.invalid/v1'},
            {'useDefault':False,'endpoint':self.base},
            {'useDefault':False,'endpoint':'https://foo.invalid/?api_key=secret'},
            {'useDefault':False,'endpoint':'https://foo.invalid','apiKey':'x\ny'},
            {'endpoint':'https://foo.invalid'},
        ]:
            with self.assertRaises(urllib.error.HTTPError) as ctx:self.post('/local-api/configure',obj)
            self.assertEqual(ctx.exception.code,400)
        with self.assertRaises(urllib.error.HTTPError) as ctx:self.forward('invalid-route')
        self.assertEqual(ctx.exception.code,409);self.assertEqual(self.requests,[])

    def test_reflected_custom_credentials_are_scrubbed_even_when_unicode_escaped(self):
        route=self.post('/local-api/configure',{'useDefault':False,'endpoint':'https://mock.invalid','apiKey':'CUSTOM-ONE'})
        class Reply:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'{"error":{"message":"CUSTOM\\u002dONE GLM-PRIVATE-DEFAULT"}}'
        class Opener:
            def open(self,*args,**kwargs):return Reply()
        self.server.opener=Opener()
        self.assertEqual(self.forward(route['routeId'])['error']['message'],'[API_KEY_REDACTED] [API_KEY_REDACTED]')

    def test_short_custom_placeholder_key_cannot_corrupt_static_html(self):
        raw=b'<script>const testController = /x/.test("x");</script>'
        (self.root/'index.html').write_bytes(raw)
        self.post('/local-api/configure',{'useDefault':False,'endpoint':'http://127.0.0.1:9955/v1','apiKey':'test'})
        with urllib.request.urlopen(self.base+'/index.html') as result:self.assertEqual(result.read(),raw)

    def test_authenticated_text_input_and_output_path_checks_do_not_call_models(self):
        source=self.root/'资料 示例.txt';source.write_text('A complete source paragraph with explicit study boundaries.\n')
        obj=self.post('/local-files/read',{'paths':[str(source)],'recursive':True})
        self.assertEqual(obj['files'][0]['text'],source.read_text())
        self.assertEqual(obj['files'][0]['sourcePath'],str(source))
        self.assertTrue(obj['files'][0]['sourceId'])
        output=self.root/'报告 空格'/'results'
        checked=self.post('/local-output/validate',{'path':str(output)})
        self.assertEqual(checked['path'],str(output));self.assertTrue(checked['writable'])
        self.assertFalse(output.exists());self.assertEqual(self.requests,[])


    def test_native_pdf_hydration_is_exact_and_cache_failure_never_reaches_upstream(self):
        import base64, hashlib
        from unittest.mock import patch
        original = b'%PDF-1.7\nLOCAL ORIGINAL BINARY\x00\xff'
        with patch.object(self.server.workspace, '_extract', return_value=('local text not sent', 1, [])):
            item = self.server.workspace._store(original, 'paper.pdf', 'paper.pdf', None)
        digest = hashlib.sha256(original).hexdigest()
        self.assertTrue(self.post('/local-files/pdf-check', {'hashes':[digest]})['available'])
        route = self.post('/local-api/configure', {'useDefault':True})
        body = {'model':'glm-5.3-flash','stream':False,'messages':[{'role':'user','content':[{'type':'file_url','file_url':{'url':'paperbench-pdf:'+digest}},{'type':'text','text':'Review attachment'}]}]}
        self.post('/v1/chat/completions', body, {'X-Paperbench-Route':route['routeId']})
        forwarded = json.loads(self.requests[0].data)
        url = forwarded['messages'][0]['content'][0]['file_url']['url']
        self.assertTrue(url.startswith('data:application/pdf;base64,'))
        self.assertEqual(base64.b64decode(url.split(',',1)[1]), original)
        self.assertNotIn('local text not sent', json.dumps(forwarded))
        self.server.workspace._sources.clear()
        with self.assertRaises(urllib.error.HTTPError):
            self.post('/v1/chat/completions', body, {'X-Paperbench-Route':route['routeId']})
        self.assertEqual(len(self.requests), 1)


    def test_large_reflected_pdf_error_keeps_400_and_bounded_diagnostics(self):
        import io
        from local_proxy import MAX_ERROR_RESPONSE
        route=self.post('/local-api/configure',{'useDefault':False,'endpoint':'http://127.0.0.1:9955/v1','apiKey':'CUSTOM-ONE'})
        echo='data:application/pdf;base64,'+'A'*300000
        message="25 validation errors: [{'loc': ['body', 'messages', 0, 'content'], 'msg': 'Input should be a valid string', 'input': {'type':'file_url','url':'"+echo+"'}}]"
        raw=json.dumps({'object':'error','message':message}).encode()
        reads=[]
        class Body(io.BytesIO):
            def read(self,n=-1):reads.append(n);return super().read(n)
        stream=Body(raw)
        class Opener:
            def open(self,*args,**kwargs):raise urllib.error.HTTPError('http://127.0.0.1:9955/v1/chat/completions',400,'Bad Request',{},stream)
        self.server.opener=Opener()
        body={'model':'custom-model','stream':False,'messages':[{'role':'user','content':[{'type':'file_url','file_url':{'url':'data:application/pdf;base64,JVBERg=='}}]}]}
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post('/v1/chat/completions',body,{'X-Paperbench-Route':route['routeId']})
        self.assertEqual(ctx.exception.code,400)
        result=json.loads(ctx.exception.read())
        self.assertEqual(result['error']['code'],'unsupported_input_format')
        self.assertEqual(reads,[MAX_ERROR_RESPONSE+1]);self.assertTrue(stream.closed)
        self.assertTrue(result['proxyDiagnostics']['bodyTruncated'])
        self.assertNotIn('A'*80,json.dumps(result));self.assertLess(len(json.dumps(result)),20000)

    def test_http_error_credentials_remain_redacted_and_status_is_preserved(self):
        import io
        route=self.post('/local-api/configure',{'useDefault':False,'endpoint':'https://mock.invalid','apiKey':'CUSTOM-ONE'})
        class Opener:
            def open(self,*args,**kwargs):raise urllib.error.HTTPError('https://mock.invalid',429,'Rate limited',{},io.BytesIO(b'{"error":{"message":"CUSTOM\\u002dONE GLM-PRIVATE-DEFAULT","code":"rate_limit"}}'))
        self.server.opener=Opener()
        with self.assertRaises(urllib.error.HTTPError) as ctx:self.forward(route['routeId'])
        self.assertEqual(ctx.exception.code,429)
        result=json.loads(ctx.exception.read())
        self.assertEqual(result['error']['message'],'[API_KEY_REDACTED] [API_KEY_REDACTED]')
        self.assertEqual(result['error']['code'],'rate_limit')

    def test_oversized_success_has_distinct_non_network_error_code(self):
        from local_proxy import MAX_RESPONSE
        class Reply:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return b'x'*(MAX_RESPONSE+1)
        class Opener:
            def open(self,*args,**kwargs):return Reply()
        self.server.opener=Opener()
        with self.assertRaises(urllib.error.HTTPError) as ctx:self.forward()
        self.assertEqual(ctx.exception.code,502)
        self.assertEqual(json.loads(ctx.exception.read())['error']['code'],'upstream_response_too_large')


if __name__=='__main__':unittest.main(verbosity=2)
