#!/usr/bin/env python3
"""Optional, dependency-free loopback proxy for the standalone Paperbench HTML.

OPENAI_API_KEY is read from the environment. No key or paper content is logged.
Only a fixed upstream chat/completions URL is used; never an open forward proxy.
"""
import argparse
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_REQUEST = 12 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


# Error bodies can reflect the same PDF many times during request validation.
# Bound error reads independently; never convert an upstream 400 into a retryable 502.
MAX_ERROR_RESPONSE = 256 * 1024
MAX_ERROR_PREVIEW = 4096
_DATA_URL = re.compile(r"data:[^,\s\"'<>]{0,160};base64,[A-Za-z0-9+/=_\\-]*", re.I)


def _error_text(value):
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _safe_error_text(value):
    return _DATA_URL.sub('[BINARY_DATA_OMITTED]', _error_text(value))


def _has_file_input(request):
    return any(isinstance(m, dict) and isinstance(m.get('content'), list)
               and any(isinstance(part, dict) and part.get('type') == 'file_url'
                       for part in m['content']) for m in request.get('messages', []))


def read_upstream_error(response, request):
    """Return status + bounded, explicitly transformed diagnostic envelope.

    Small ordinary JSON errors stay byte-for-byte intact. Reflected binary and
    overlarge diagnostics are normalized, with original HTTP status and limits
    recorded. Successful model replies never pass through this adapter.
    """
    status = response.code
    try:
        data = response.read(MAX_ERROR_RESPONSE + 1)
    finally:
        response.close()
    truncated = len(data) > MAX_ERROR_RESPONSE
    prefix = data[:MAX_ERROR_RESPONSE].decode('utf-8', errors='replace')
    try:
        obj = json.loads(prefix) if not truncated else None
    except (ValueError, RecursionError):
        obj = None
    details = (obj.get('error', obj) if isinstance(obj, dict) else None)
    if isinstance(details, dict):
        message = details.get('message', details.get('detail', ''))
        provider_code = details.get('code')
    else:
        message = details or prefix
        provider_code = None
    clean = _safe_error_text(message)
    # Do not diagnose from the paper copied into an error's input field.
    diagnostic = re.sub(r"(['\"]input['\"]\s*:)\s*.*", '', clean, flags=re.S)
    content_validation = bool(re.search(r'validation errors?', diagnostic, re.I)
        and re.search(r"loc.{0,350}messages", diagnostic, re.I | re.S)
        and 'file_url' in clean)
    explicit_file_rejection = bool(re.search(
        r'(?:unsupported|not supported|not allowed|unknown|invalid|不支持).{0,100}(?:file_url|pdf)|'
        r'(?:file_url|pdf).{0,100}(?:unsupported|not supported|not allowed|unknown|不支持)',
        diagnostic, re.I | re.S))
    unsupported = status in {400, 422} and _has_file_input(request) and (content_validation or explicit_file_rejection)
    binary_redacted = clean != _error_text(message)
    # Retain ordinary small provider envelopes, including usage and error codes.
    if not unsupported and not truncated and not binary_redacted and len(data) <= 16384:
        return status, data
    code = 'unsupported_input_format' if unsupported else (provider_code or 'upstream_http_error')
    if unsupported:
        summary = ('模型接口未接受当前 file_url PDF 输入格式。旧 PDF 批次不能直接补跑。'
                   '本地模型请新建批次，程序将先用 MinerU 转换 Markdown；云端接口请核对 PDF 文件输入支持。')
    else:
        summary = clean[:2000] or ('上游接口返回 HTTP ' + str(status))
        if truncated:
            summary += '（上游错误正文过长，仅保留有限摘要；HTTP 状态保持原样。）'
    normalized = {'error': {'message': summary, 'code': code, 'upstream_status': status},
                  'proxyDiagnostics': {'upstreamStatus': status, 'bodyTruncated': truncated,
                    'bytesRead': len(data), 'readLimitBytes': MAX_ERROR_RESPONSE,
                    'binaryEchoRedacted': binary_redacted,
                    'bodyPreview': clean[:MAX_ERROR_PREVIEW],
                    'note': '代理诊断摘要；不是完整上游原始正文。未保留错误中回显的文件编码。'}}
    if isinstance(obj, dict) and isinstance(obj.get('usage'), dict):
        normalized['usage'] = obj['usage']
    return status, normalized


def upstream_url(value):
    url = urllib.parse.urlsplit(value.strip())
    if url.scheme not in {"http", "https"} or not url.hostname:
        raise ValueError("upstream 必须是完整的 HTTP(S) 地址")
    if url.username or url.password or url.fragment:
        raise ValueError("不要把凭据或 fragment 写入 upstream")
    if url.scheme == "http" and url.hostname not in LOOPBACK:
        raise ValueError("远程 upstream 必须使用 HTTPS；本机模型可使用 HTTP")
    for key, _ in urllib.parse.parse_qsl(url.query):
        if key.lower().replace("-", "_") in {"key", "api_key", "token", "access_token", "authorization", "secret"}:
            raise ValueError("upstream 不得含密钥参数，请使用 OPENAI_API_KEY")
    path = url.path.rstrip("/") or "/v1"
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urllib.parse.urlunsplit((url.scheme, url.netloc, path, url.query, ""))


def allowed_origin(origin):
    if origin in {None, "null"}:
        return True
    try:
        url = urllib.parse.urlsplit(origin)
        return (url.scheme in {"http", "https"} and url.hostname in LOOPBACK
                and not url.username and not url.password and not url.query
                and not url.fragment and url.path in {"", "/"})
    except ValueError:
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "PaperbenchLocal/1.0"

    def log_message(self, *_):
        pass

    def permitted(self):
        try:
            host = urllib.parse.urlsplit("http://" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        return host in LOOPBACK and allowed_origin(self.headers.get("Origin"))

    def reply(self, code, body, content_type="application/json; charset=utf-8", redact_secrets=True):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        key = self.server.api_key
        if key and redact_secrets:
            body = body.replace(key.encode("utf-8"), b"[API_KEY_REDACTED]")
            # Provider JSON can encode reflected credentials with Unicode escapes.
            try:
                decoded = json.loads(body)
                def clean(value):
                    if isinstance(value, str): return value.replace(key, '[API_KEY_REDACTED]')
                    if isinstance(value, list): return [clean(x) for x in value]
                    if isinstance(value, dict): return {str(k).replace(key, '[API_KEY_REDACTED]'):clean(v) for k,v in value.items()}
                    return value
                cleaned = clean(decoded)
                if cleaned != decoded:
                    body = json.dumps(cleaned, ensure_ascii=False).encode('utf-8')
            except (ValueError, UnicodeError):
                pass
        self.send_response(code)
        if self.permitted():
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "null")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Expose-Headers", "Retry-After")
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, code, message):
        self.reply(code, {"error": {"message": message}})

    def do_OPTIONS(self):
        if not self.permitted():
            return self.error(403, "仅允许本地文件和localhost来源")
        self.reply(204, b"")

    def do_GET(self):
        if not self.permitted():
            return self.error(403, "来源或Host不受支持")
        if self.path == "/health":
            return self.reply(200, {"status": "ok", "service": "paperbench-local-proxy"})
        self.error(404, "此服务仅转发POST /v1/chat/completions，不托管HTML")

    def do_POST(self):
        if not self.permitted():
            return self.error(403, "仅允许本地文件和localhost来源")
        if self.path not in {"/v1/chat/completions", "/chat/completions"}:
            return self.error(404, "仅支持 /v1/chat/completions")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.error(400, "Content-Length无效")
        if length <= 0 or length > MAX_REQUEST:
            return self.error(413, "请求为空或超过12MB")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "不支持分块请求体")
        try:
            data = self.rfile.read(length)
            obj = json.loads(data)
            if not isinstance(obj, dict) or not isinstance(obj.get("model"), str) or not isinstance(obj.get("messages"), list):
                raise ValueError("缺少model或messages")
            if obj.get("stream") is not False:
                raise ValueError("只支持stream:false非流式请求")
        except (ValueError, UnicodeError) as exc:
            return self.error(400, "JSON请求无效：" + str(exc)[:160])
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.server.api_key:
            headers["Authorization"] = "Bearer " + self.server.api_key
        request = urllib.request.Request(self.server.upstream, data=data, headers=headers, method="POST")
        try:
            # Do not follow redirects with Authorization; the upstream is fixed at startup.
            with self.server.opener.open(request, timeout=self.server.timeout_seconds) as response:
                result = response.read(MAX_RESPONSE + 1)
                if len(result) > MAX_RESPONSE:
                    return self.reply(502, {"error": {"code": "upstream_response_too_large", "message": "上游成功响应超过16MiB，未作为完整评分接收；请检查模型输出设置。"}})
                self.reply(response.status, result)
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                exc.close()
                return self.error(502, "上游返回重定向，代理已停止；请配置最终接口地址")
            status, result = read_upstream_error(exc, obj)
            self.reply(status, result)
        except (TimeoutError, socket.timeout):
            self.error(504, "本地代理等待上游超时；服务端可能仍在执行请求")
        except (urllib.error.URLError, OSError):
            self.error(502, "本地代理无法连接上游，请检查网络、TLS证书、系统代理和upstream地址")


def make_server(upstream, port=8787, key="", timeout=180):
    target = upstream_url(upstream)
    server = ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    server.daemon_threads = True
    server.upstream = target
    server.api_key = key
    server.timeout_seconds = timeout
    server.opener = urllib.request.build_opener(NoRedirect())
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, help="固定上游base URL或完整chat/completions URL")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--timeout", type=int, default=180, help="上游超时秒数，默认180")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.timeout <= 900:
        parser.error("port须为1–65535，timeout须为1–900秒")
    try:
        server = make_server(args.upstream, args.port, os.environ.get("OPENAI_API_KEY", "").strip(), args.timeout)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Paperbench本地代理已启动：网页接口填写 http://127.0.0.1:{args.port}/v1，网页Key留空。")
    print("仅绑定本机；上游和密钥从启动参数/环境读取；不记录论文和密钥。按Ctrl+C退出。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
