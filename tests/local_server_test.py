import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

from configure_local import save_profile
from start_local import load_profile, create_server


class LocalProfileTests(unittest.TestCase):
    def test_private_permissions_and_nonsecret_server(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            profile=root/'.private/model_config.json'
            save_profile(profile,'private-test-key')
            self.assertEqual(profile.stat().st_mode & 0o777,0o600)
            self.assertEqual(profile.parent.stat().st_mode & 0o777,0o700)
            self.assertEqual(load_profile(profile),'private-test-key')
            page=root/'index.html';page.write_text('<h1>research</h1>')
            server=create_server('private-test-key',0,page)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base='http://127.0.0.1:'+str(server.server_port)
            try:
                with urllib.request.urlopen(base+'/local-config') as res:
                    data=res.read();obj=json.loads(data)
                self.assertNotIn(b'private-test-key',data)
                self.assertEqual(obj['config']['model'],'glm-5.3-flash')
                self.assertEqual(len(obj['token']),64)
                for target in ['/.private/model_config.json','/../.private/model_config.json','/backups/','/start_local.py']:
                    with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(base+target)
                    self.assertEqual(caught.exception.code,404)
                for origin in ['https://untrusted.invalid','null','http://127.0.0.1:9999']:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(urllib.request.Request(base+'/local-config',headers={'Origin':origin}))
                    self.assertEqual(caught.exception.code,403)
                request=urllib.request.Request(base+'/v1/chat/completions',data=b'{}',headers={'Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(request)
                self.assertEqual(caught.exception.code,403)
                request.add_header('X-Paperbench-Token',obj['token'])
                with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(request)
                self.assertEqual(caught.exception.code,400)  # Authorized, schema checked, no upstream call.
                class FakeResponse:
                    status=200
                    def __enter__(self):return self
                    def __exit__(self,*args):pass
                    def read(self,*args):return b'{"error":{"message":"private-test-\\u006bey"}}'
                class FakeOpener:
                    def open(self,*args,**kwargs):return FakeResponse()
                server.opener=FakeOpener()
                request=urllib.request.Request(base+'/v1/chat/completions',data=b'{"model":"glm-5.3-flash","messages":[],"stream":false}',headers={'Content-Type':'application/json','X-Paperbench-Token':obj['token']})
                with urllib.request.urlopen(request) as res:decoded=json.loads(res.read())
                self.assertEqual(decoded['error']['message'],'[API_KEY_REDACTED]')
            finally:
                server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
