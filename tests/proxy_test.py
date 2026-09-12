import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from local_proxy import make_server, upstream_url, allowed_origin


class Upstream(BaseHTTPRequestHandler):
    received = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.received.append((self.path, self.headers.get('Authorization'), json.loads(body)))
        result = json.dumps({'choices': [], 'echo': 'proxy-test-secret'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(result)


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.proxy = make_server(f'http://127.0.0.1:{cls.up.server_port}/v1', 0, 'proxy-test-secret', 2)
        cls.base = f'http://127.0.0.1:{cls.proxy.server_port}'
        for server in (cls.up, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.proxy, cls.up):
            server.shutdown()
            server.server_close()

    def post(self, path='/v1/chat/completions', origin='null', payload=None):
        data = json.dumps(payload if payload is not None else {'model': 'mock', 'messages': [], 'stream': False}).encode()
        req = urllib.request.Request(self.base + path, data=data, headers={'Origin': origin, 'Content-Type': 'application/json', 'Authorization': 'Bearer ignored-browser-key'})
        return urllib.request.urlopen(req, timeout=3)

    def test_url_normalization_and_credential_rejection(self):
        self.assertEqual(upstream_url('https://example.com/v1/'), 'https://example.com/v1/chat/completions')
        for bad in ('https://u:secret@example.com/v1', 'http://example.com/v1', 'https://example.com/v1?api_key=x'):
            with self.assertRaises(ValueError):
                upstream_url(bad)

    def test_origin_validation(self):
        self.assertTrue(allowed_origin('null'))
        self.assertTrue(allowed_origin('http://localhost:8000'))
        self.assertFalse(allowed_origin('https://localhost.evil.example'))
        self.assertFalse(allowed_origin('https://evil.example'))

    def test_forward_only_fixed_upstream_and_redact_key(self):
        with self.post() as response:
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'null')
            self.assertNotIn('proxy-test-secret', response.read().decode())
        path, auth, data = Upstream.received[-1]
        self.assertEqual(path, '/v1/chat/completions')
        self.assertEqual(auth, 'Bearer proxy-test-secret')
        self.assertEqual(data['model'], 'mock')

    def test_reject_foreign_origin_wrong_route_and_streaming(self):
        for kwargs, code in (({'origin':'https://evil.example'},403),({'path':'/forward?url=https://evil.example'},404),({'payload':{'model':'mock','messages':[],'stream':True}},400)):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(**kwargs)
            self.assertEqual(caught.exception.code, code)

    def test_preflight(self):
        req = urllib.request.Request(self.base+'/v1/chat/completions', method='OPTIONS', headers={'Origin':'null','Access-Control-Request-Method':'POST'})
        with urllib.request.urlopen(req,timeout=3) as response:
            self.assertEqual(response.status,204)
            self.assertEqual(response.headers['Access-Control-Allow-Private-Network'],'true')


if __name__ == '__main__':
    unittest.main(verbosity=2)
