#!/usr/bin/env python3
"""Bounded, local-only paper imports and capability-scoped offline reports.

HTTP authentication belongs to start_local.LocalHandler. This module never
contacts a model and never uses a shell. Source references address immutable
in-memory byte snapshots, not client-controlled filesystem paths.
"""
import base64
import binascii
from datetime import datetime
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import threading
from urllib.parse import unquote, urlsplit


MAX_FILES = 100
MAX_ENTRIES = 10000
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_IMPORT_BYTES = 128 * 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_TEXT_CHARS = 2000000
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
EXTENSIONS = {'.pdf', '.txt', '.text', '.md'}
REPORT_PREFIX = '/local-reports/view/'
_PRIVATE_NAMES = {'config', 'configuration', 'credentials', 'credential', 'secrets',
                  'secret', 'model_config', 'api_key', 'apikey', 'api-key',
                  'id_rsa', 'id_ed25519'}
_SECRET_KEYS = {'apikey', 'authorization', 'password', 'secret', 'accesstoken',
                'token', 'sessiontoken', 'localtoken', 'routeid',
                'xpaperbenchtoken', 'xpaperbenchroute'}


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _key(name):
    return re.sub(r'[^a-z0-9]', '', str(name).lower())


def _object(obj):
    if not isinstance(obj, dict):
        raise ValueError('请求必须为 JSON 对象')
    return obj


def _safe_parts(parts):
    for part in parts:
        if part in {'/', ''}:
            continue
        if part in {'.', '..'} or part.startswith('.'):
            raise ValueError('不允许隐藏目录、私密配置或路径遍历')
        if '\\' in part or any(ord(c) < 32 or ord(c) == 127 for c in part):
            raise ValueError('路径含不支持的控制字符或反斜线')
        if part.lower() in _PRIVATE_NAMES or Path(part).stem.lower() in _PRIVATE_NAMES:
            raise ValueError('不允许访问配置或凭据文件')


def _absolute(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('需要有效的本机绝对路径')
    # Do not strip ordinary path spaces; they may be part of a real filename.
    if value.startswith('file:'):
        uri = urlsplit(value)
        if uri.scheme != 'file' or uri.netloc not in {'', 'localhost'} or uri.query or uri.fragment:
            raise ValueError('只接受本机 file:// 路径，不接受远程地址或查询参数')
        value = unquote(uri.path)
    if not value.startswith('/'):
        raise ValueError('请提供本机绝对路径或 file:// URI')
    # Check before pathlib normalization, which would erase a dot component.
    _safe_parts(value.split('/'))
    return Path(value)


def _relative(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or value.startswith('/'):
        raise ValueError('浏览器相对路径无效')
    _safe_parts(value.split('/'))
    if any(not p for p in value.split('/')):
        raise ValueError('相对路径含空目录段')
    return str(PurePosixPath(value))


def _open_dir(path, create=False):
    """Walk every ancestor with O_NOFOLLOW, including during directory creation."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for part in Path(path).parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except OSError as exc:
        os.close(fd)
        raise ValueError('目录不存在、不可访问或包含符号链接') from exc


def _read_regular(path, limit=MAX_FILE_BYTES):
    parent_fd = _open_dir(path.parent)
    try:
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        except OSError as exc:
            raise ValueError('文件不存在、不可访问或为符号链接') from exc
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('只允许读取普通文件')
            if info.st_size > limit:
                raise ValueError('文件超过单文件大小上限（32 MiB），未读取或截断')
            data = stream.read(limit + 1)
            if len(data) > limit:
                raise ValueError('文件读取期间超过大小上限，未截断导入')
            return data
    finally:
        os.close(parent_fd)


class LocalWorkspace:
    def __init__(self, root, secrets_provider=None):
        self.root = Path(root).absolute()
        self.mineru_registry = None
        self._sources = {}
        self._cache_bytes = 0
        self._reports = {}
        self._lock = threading.RLock()
        self._secrets_provider = secrets_provider or (lambda: [])

    def public_config(self):
        sibling = self.root.parent / 'paper_benchmark_input'
        outer = self.root.parent.parent / 'paper_benchmark_input'
        input_path = sibling if sibling.is_dir() else outer if outer.is_dir() else self.root
        return {'enabled': True, 'defaultInputPath': str(input_path),
                'defaultOutputPath': str(self.root / 'output'),
                'pdfTextAvailable': bool(shutil.which('pdftotext')),
                'nativePickerAvailable': bool(shutil.which('zenity')),
                'maxFiles': MAX_FILES, 'maxFileBytes': MAX_FILE_BYTES,
                'maxTextChars': MAX_TEXT_CHARS}

    def _known_secrets(self):
        values = self._secrets_provider()
        if isinstance(values, str):
            values = [values]
        return {value for value in (values or []) if isinstance(value, str) and value}

    def _redact(self, obj):
        known = self._known_secrets()

        def collect(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if _key(key) in _SECRET_KEYS and isinstance(item, str) and item:
                        known.add(item)
                    collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)
        collect(obj)
        ordered = sorted(known, key=len, reverse=True)

        def clean(value):
            if isinstance(value, dict):
                return {key: clean(item) for key, item in value.items() if _key(key) not in _SECRET_KEYS}
            if isinstance(value, list):
                return [clean(item) for item in value]
            if isinstance(value, str):
                for secret in ordered:
                    value = value.replace(secret, '[REDACTED]')
            return value
        return clean(obj)

    def _assert_no_secret(self, data):
        if any(key.encode('utf-8') in data for key in self._known_secrets()):
            raise ValueError('文件含已知 API 凭据，已拒绝导入或复制；请移除凭据后重试')

    def _extract(self, data, suffix):
        warnings, pages = [], None
        if suffix == '.pdf':
            if not data.startswith(b'%PDF-'):
                raise ValueError('文件不是可识别的 PDF')
            command = shutil.which('pdftotext')
            if not command:
                raise ValueError('未安装 pdftotext；请安装 Poppler 或提供完整 TXT 文本')
            with tempfile.TemporaryDirectory(prefix='paperbench-pdf-') as temporary:
                pdf = Path(temporary) / 'source.pdf'
                target = Path(temporary) / 'extracted.txt'
                pdf.write_bytes(data)
                try:
                    result = subprocess.run([command, '-enc', 'UTF-8', str(pdf), str(target)],
                                            capture_output=True, timeout=90, check=False)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise ValueError('PDF 文本提取失败或超时；请检查文件或提供 TXT') from exc
                if result.returncode or not target.is_file():
                    raise ValueError('PDF 无法提取文本（可能加密或损坏）；请提供可读取的 PDF/TXT')
                if target.stat().st_size > MAX_TEXT_CHARS * 4:
                    raise ValueError('PDF 全文超过 200 万字符上限；未静默截断')
                text = target.read_text(encoding='utf-8')
                # A bundled pdfinfo can shadow a working system Poppler while
                # requiring a newer libc. Fall back only to this fixed local tool.
                info_candidates = [shutil.which('pdfinfo')]
                if os.access('/usr/bin/pdfinfo', os.X_OK):
                    info_candidates.append('/usr/bin/pdfinfo')
                for info in dict.fromkeys(info_candidates):
                    if not info:
                        continue
                    try:
                        result = subprocess.run([info, str(pdf)], capture_output=True,
                                                timeout=30, check=False, env={**os.environ, 'LC_ALL': 'C'})
                        match = re.search(rb'^Pages:\s*(\d+)\s*$', result.stdout, re.M)
                        if not result.returncode and match:
                            pages = int(match.group(1))
                            break
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                if pages is None:
                    warnings.append('无法核实 PDF 页数；页数字段留空。')
            warnings.append('PDF 按默认阅读顺序提取全文；v2.3将文字索引与PDF原件一并发送，索引用于引文定位。公式、表格及双栏顺序需人工核查。')
        else:
            try:
                text = data.decode('utf-8-sig')
            except UnicodeDecodeError as exc:
                raise ValueError('文本文件必须为 UTF-8 编码；未用替换字符或猜测编码导入') from exc
            if '\x00' in text:
                raise ValueError('文本文件含二进制空字节，无法作为论文全文')
        if len(text) > MAX_TEXT_CHARS:
            raise ValueError('全文超过 200 万字符上限；未静默截断')
        if not text.strip():
            warnings.append('未提取到可评分文本（可能是扫描件）；已保留原文件，请先 OCR 或补充完整文本，当前无法创建可核验的引文索引，评分开始前会阻止请求。')
        elif len(text.strip()) < 200:
            warnings.append('提取文本不足 200 字符，可能缺页或缺少正文；请核实并补充全文后评分。')
        return text, pages, warnings

    def pdf_check(self, obj):
        hashes = _object(obj).get('hashes')
        if not isinstance(hashes, list) or not 1 <= len(hashes) <= 30:
            raise ValueError('PDF检查须含1–30个哈希')
        for value in hashes:
            self.pdf_bytes(value)
        return {'available': True, 'count': len(hashes)}

    def pdf_bytes(self, digest):
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('PDF引用哈希无效')
        with self._lock:
            for source in self._sources.values():
                if source['suffix'] == '.pdf' and source['record']['sha256'] == digest:
                    data = source['bytes']
                    if _sha(data) != digest or not data.startswith(b'%PDF-'):
                        raise ValueError('PDF原件哈希或文件类型不一致')
                    return data
        raise ValueError('PDF原件缓存不可用；请重新导入相同PDF后恢复，未调用模型')

    def hydrate_pdf(self, obj):
        # Replace only authenticated local references; never read arbitrary paths.
        count = 0
        for message in obj.get('messages', []):
            content = message.get('content')
            if not isinstance(content, list):
                continue
            for part in content:
                if part.get('type') == 'file_url' and isinstance(part.get('file_url'), dict):
                    url = part['file_url'].get('url', '')
                    if isinstance(url, str) and url.startswith('paperbench-pdf:'):
                        count += 1
                        if count > 1:
                            raise ValueError('每次论文评审只允许一份PDF')
                        data = self.pdf_bytes(url[len('paperbench-pdf:'):])
                        part['file_url']['url'] = 'data:application/pdf;base64,' + base64.b64encode(data).decode('ascii')
        return obj

    def _store(self, data, filename, relative_path, source_path):
        suffix = Path(filename).suffix.lower()
        if suffix not in EXTENSIONS:
            raise ValueError('只支持 PDF、UTF-8 TXT/TEXT/MD 文件')
        if len(data) > MAX_FILE_BYTES:
            raise ValueError('文件超过单文件 32 MiB 上限，未导入')
        self._assert_no_secret(data)
        try:
            text, pages, warnings = self._extract(data, suffix)
        except ValueError as exc:
            if suffix != '.pdf' or not data.startswith(b'%PDF-'):
                raise
            text, pages, warnings = '', None, ['本地引文核验文本不可用：'+str(exc)+'；PDF原件已保留，可使用PDF直读。没有核验文本时，引文无法自动匹配，分数可能不可汇总。']
        self._assert_no_secret(text.encode('utf-8'))
        cost = len(data) + len(text.encode('utf-8'))
        with self._lock:
            if len(self._sources) >= 500 or self._cache_bytes + cost > MAX_CACHE_BYTES:
                raise ValueError('本机会话源文件缓存已满；请先保存报告，再重启本机服务重新导入')
            source_id = secrets.token_urlsafe(24)
            result = {'sourceId': source_id, 'filename': filename, 'title': Path(filename).stem,
                      'text': text, 'sourcePath': source_path, 'relativePath': relative_path,
                      'sha256': _sha(data), 'bytes': len(data), 'pages': pages, 'warnings': warnings}
            self._sources[source_id] = {'record': result, 'bytes': data, 'suffix': suffix}
            self._cache_bytes += cost
        return {**result, 'warnings': list(warnings)}

    def read_paths(self, obj):
        obj = _object(obj)
        paths = obj.get('paths')
        recursive = obj.get('recursive', True)
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FILES or not isinstance(recursive, bool):
            raise ValueError('paths 须包含 1–100 条绝对路径，recursive 须为布尔值')
        files, errors, seen = [], [], set()
        entries, total, candidates = 0, 0, 0
        stopped = False

        def fail(path, error):
            errors.append({'path': str(path), 'message': str(error)})

        def add(path, relative_path):
            nonlocal total, candidates, stopped
            if str(path) in seen:
                return
            seen.add(str(path))
            candidates += 1
            if candidates > MAX_FILES:
                stopped = True
                raise ValueError('达到单次 100 个文件上限；其余文件未导入，请分批导入')
            data = _read_regular(path)
            total += len(data)
            if total > MAX_IMPORT_BYTES:
                stopped = True
                raise ValueError('达到单次 128 MiB 总大小上限；其余文件未导入')
            files.append(self._store(data, path.name, relative_path, str(path)))

        def directory(path, base):
            nonlocal entries, stopped
            fd = _open_dir(path)
            try:
                children = []
                with os.scandir(fd) as iterator:
                    for child in iterator:
                        entries += 1
                        if entries > MAX_ENTRIES:
                            stopped = True
                            raise ValueError('目录扫描达到 10000 项上限；剩余内容未导入，请缩小目录范围')
                        if child.name.startswith('.') or child.is_symlink():
                            continue
                        children.append((child.name, child.is_dir(follow_symlinks=False),
                                         child.is_file(follow_symlinks=False)))
            finally:
                os.close(fd)
            for name, is_directory, is_file in sorted(children):
                if stopped:
                    break
                child = path / name
                try:
                    _safe_parts(child.parts)
                    if is_directory and recursive:
                        directory(child, base)
                    elif is_file and child.suffix.lower() in EXTENSIONS:
                        add(child, str(child.relative_to(base)))
                except (OSError, ValueError) as exc:
                    fail(child, exc)

        for value in paths:
            if stopped:
                break
            try:
                path = _absolute(value)
                # lstat is only for choosing a branch. All actual reads walk via fd.
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    raise ValueError('不允许符号链接输入')
                if stat.S_ISDIR(mode):
                    directory(path, path)
                else:
                    if path.suffix.lower() not in EXTENSIONS:
                        raise ValueError('只支持 PDF、UTF-8 TXT/TEXT/MD 文件')
                    add(path, path.name)
            except (OSError, ValueError) as exc:
                fail(value, exc)
        return self._redact({'files': files, 'errors': errors})

    def upload_files(self, obj):
        supplied = _object(obj).get('files')
        if not isinstance(supplied, list) or not 1 <= len(supplied) <= MAX_FILES:
            raise ValueError('files 须包含 1–100 个上传文件')
        files, errors, total = [], [], 0
        for item in supplied:
            name = item.get('name', '') if isinstance(item, dict) else ''
            try:
                _object(item)
                if not isinstance(name, str) or '/' in name or name != _relative(name):
                    raise ValueError('上传文件名无效')
                relative = _relative(item.get('relativePath') or name)
                if PurePosixPath(relative).name != name:
                    raise ValueError('上传相对路径与文件名不一致')
                encoded = item.get('base64')
                if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
                    raise ValueError('上传文件内容无效或超过单文件 32 MiB 上限')
                try:
                    data = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error) as exc:
                    raise ValueError('上传文件不是合法 base64') from exc
                total += len(data)
                if total > MAX_IMPORT_BYTES:
                    raise ValueError('超过单次 128 MiB 总大小上限，此文件未导入')
                files.append(self._store(data, name, relative, None))
            except (OSError, ValueError) as exc:
                errors.append({'path': str(name), 'message': str(exc)})
        return self._redact({'files': files, 'errors': errors})

    def pick(self, obj):
        kind = _object(obj).get('kind')
        if kind not in {'files', 'folder', 'output'}:
            raise ValueError('kind 须为 files、folder 或 output')
        executable = shutil.which('zenity')
        if not executable:
            raise ValueError('本机没有可用文件选择器；请手动粘贴绝对路径，或拖放/上传文件')
        args = [executable, '--file-selection', '--title=选择论文文件或输出目录']
        if kind == 'files':
            args += ['--multiple', '--separator=\n', '--file-filter=论文 | *.pdf *.PDF *.txt *.text *.md']
        else:
            args += ['--directory']
        try:
            result = subprocess.run(args, capture_output=True, timeout=300, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError('本机选择器不可用或已超时；请手动粘贴绝对路径或上传文件') from exc
        if result.returncode == 1:
            return {'paths': [], 'cancelled': True}
        if result.returncode:
            raise ValueError('无法打开本机选择器；请手动粘贴绝对路径或上传文件')
        try:
            chosen = result.stdout.decode('utf-8').rstrip('\r\n')
        except UnicodeDecodeError as exc:
            raise ValueError('选择器返回的路径编码无效；请手动粘贴路径') from exc
        if not chosen:
            return {'paths': [], 'cancelled': True}
        paths = [str(_absolute(value)) for value in chosen.split('\n')]
        for value in paths:
            path = Path(value)
            if kind in {'folder', 'output'}:
                fd = _open_dir(path)
                os.close(fd)
            else:
                if path.is_symlink():
                    raise ValueError('不能选择符号链接文件')
                fd = _open_dir(path.parent)
                os.close(fd)
        return {'paths': paths, 'cancelled': False}

    def validate_output(self, obj):
        path = _absolute(_object(obj).get('path'))
        nearest = path
        while not nearest.exists() and not nearest.is_symlink():
            nearest = nearest.parent
        fd = _open_dir(nearest)
        try:
            if not os.access('.', os.W_OK | os.X_OK, dir_fd=fd, effective_ids=True):
                raise ValueError('输出目录或最近的父目录不可写')
        finally:
            os.close(fd)
        return {'path': str(path), 'exists': path.exists(), 'writable': True}

    def _save_mineru_assets(self, paper, work):
        preparation = paper.get('preparation')
        if not preparation or preparation.get('method') != 'mineru':
            return None
        if _sha(paper['text'].encode('utf-8')) != preparation.get('markdownSha256'):
            raise ValueError('MinerU评审Markdown与转换哈希不一致')
        relative = f'assets/prepared/{paper["id"]}'
        folder = work / relative
        folder.mkdir(parents=True, exist_ok=True)
        # The exact reviewed MD is always available, even after cache/session loss.
        md_asset = relative + '/score.md'
        (work / md_asset).write_text(paper['text'], encoding='utf-8')
        manifest_asset = relative + '/preparation.json'
        (work / manifest_asset).write_text(json.dumps(self._redact(preparation), ensure_ascii=False, indent=2), encoding='utf-8')
        info = {'paperId': paper['id'], 'method': 'mineru', 'markdownAsset': md_asset,
                'preparationAsset': manifest_asset, 'markdownSha256': preparation['markdownSha256'],
                'pdfSha256': preparation.get('pdfSha256'), 'assets': [], 'missingAssets': False,
                'note': '实际评分输入为冻结Markdown；图片文件未发送给评分模型。索引页号不代表原PDF物理页。'}
        try:
            record = self.mineru_registry(preparation.get('conversionId')) if self.mineru_registry else None
        except ValueError:
            record = None
        if record is None:
            info.update(missingAssets=True, warning='转换会话缓存不可用，完整转换附件未随包复制；冻结评分Markdown仍已保存。原转换目录以preparation.json记录为准。')
            return info
        for field in ('pdfSha256', 'markdownSha256'):
            if record.get(field) != preparation.get(field):
                raise ValueError('MinerU转换记录与评审快照不一致')
        total = 0
        for asset in record['assets']:
            part = _relative(asset['relativePath'])
            data = _read_regular(Path(record['directory']) / part, limit=MAX_ARCHIVE_BYTES*4)
            total += len(data)
            if total > MAX_ARCHIVE_BYTES*4:
                raise ValueError('MinerU转换附件超过单篇512MiB报告上限；未截断保存')
            if len(data) != asset['bytes'] or _sha(data) != asset['sha256']:
                raise ValueError('MinerU转换附件保存后发生变化，未保存来源不一致的报告：'+part)
            self._assert_no_secret(data)
            target_asset = relative + '/mineru/' + part
            target = work / target_asset
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            info['assets'].append({'asset': target_asset, 'sha256': asset['sha256'], 'bytes': len(data)})
        original_md = Path(preparation['markdownPath']).relative_to(Path(preparation['conversionDir'])).as_posix()
        copied_md = relative + '/mineru/' + _relative(original_md)
        if not any(a['asset'] == copied_md and a['sha256'] == preparation['markdownSha256'] for a in info['assets']):
            raise ValueError('MinerU原转换Markdown未出现在受信附件清单')
        info['originalMarkdownAsset'] = copied_md
        return info

    def save_report(self, obj):
        obj = _object(obj)
        archive = obj.get('archive')
        if not isinstance(archive, dict) or not isinstance(archive.get('batches'), list) or len(archive['batches']) != 1:
            raise ValueError('保存报告需要仅包含当前选中批次的归档对象')
        batch = archive['batches'][0]
        if not isinstance(batch, dict) or not isinstance(batch.get('papers'), list):
            raise ValueError('归档批次或论文结构无效')
        if archive.get('currentBatchId') not in {None, '', batch.get('id')}:
            raise ValueError('当前批次 ID 与归档不一致')
        refs = obj.get('sourceRefs', {})
        if not isinstance(refs, dict):
            raise ValueError('sourceRefs 须为 paperId 到 sourceId 的对象')
        ids = {paper.get('id') for paper in batch['papers'] if isinstance(paper, dict) and isinstance(paper.get('id'), str)}
        if any(paper_id not in ids for paper_id in refs):
            raise ValueError('sourceRefs 含当前批次以外的论文 ID')
        snapshots, missing_sources = [], []
        with self._lock:
            for paper_id, source_id in refs.items():
                if not isinstance(source_id, str) or len(source_id) > 200:
                    raise ValueError('源文件引用格式无效')
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', paper_id) or '..' in paper_id:
                    raise ValueError('源文件论文 ID 不适合安全的报告目录名称')
                if source_id in self._sources:
                    snapshots.append((paper_id, self._sources[source_id]))
                else:
                    missing_sources.append({'paperId': paper_id, 'sourceId': source_id,
                                            'reason': 'source_cache_unavailable',
                                            'warning': '原始附件缓存已失效（本机服务可能已重启）；评分及全文仍可阅读，请重新导入以恢复原附件。'})
        for paper_id in ids:
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', paper_id) or '..' in paper_id:
                raise ValueError('论文 ID 不适合安全的报告目录名称')
        for paper_id, source in snapshots:
            declared = next(p for p in batch['papers'] if p['id'] == paper_id).get('pdf')
            if declared and declared.get('sha256') != source['record']['sha256']:
                raise ValueError('随包PDF与评审快照哈希不一致')
            preparation = next(p for p in batch['papers'] if p['id'] == paper_id).get('preparation')
            if preparation and preparation.get('pdfSha256') != source['record']['sha256']:
                raise ValueError('MinerU源PDF与随包原件哈希不一致')
            self._assert_no_secret(source['bytes'])
        clean = self._redact(archive)
        clean_batch = clean['batches'][0]
        raw = json.dumps(clean, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
        if len(raw) > MAX_ARCHIVE_BYTES:
            raise ValueError('归档超过 128 MiB 上限')
        output = Path(self.validate_output({'path': obj.get('outputPath')})['path'])
        node = shutil.which('node')
        if not node:
            raise ValueError('保存离线报告需要本机 Node.js；请安装后重试')
        output_fd = _open_dir(output, create=True)
        temporary, final = None, None
        try:
            # Held directory fd prevents a concurrent ancestor change from redirecting writes.
            # All new content is private until export succeeds; source inputs stay read-only.
            stamp = datetime.now().strftime('%Y-%m-%d__%H%M%S')
            model = self._slug(clean_batch.get('config', {}).get('model', 'model'), 60)
            batch_id = self._slug(clean_batch.get('id', 'batch'), 40)
            repeats = batch.get('config', {}).get('repeats', 0)
            if not isinstance(repeats, int) or isinstance(repeats, bool) or not 1 <= repeats <= 30:
                raise ValueError('批次计划轮数无效')
            name = f'{stamp}__{model}__N{len(batch["papers"]):02d}_R{repeats:02d}__{batch_id}__{secrets.token_hex(4)}'
            temporary = '.paperbench-tmp-' + secrets.token_hex(12)
            os.mkdir(temporary, 0o700, dir_fd=output_fd)
            # /proc/self/fd is used only internally, with the held descriptor inherited by Node.
            work = Path('/proc/self/fd') / str(output_fd) / temporary
            (work / 'archive.json').write_bytes(raw)
            metadata = {'schemaVersion': 1, 'createdAt': datetime.now().astimezone().isoformat(),
                        'sources': [], 'missingPaperIds': sorted(ids - {p for p, _ in snapshots}),
                        'missingSources': missing_sources, 'reviewTexts': [], 'preparations': []}
            for paper in clean_batch['papers']:
                if not isinstance(paper, dict) or not isinstance(paper.get('text'), str):
                    raise ValueError('归档论文全文必须为字符串')
                review_asset = f'assets/prepared/{paper["id"]}/review_text.txt'
                (work / review_asset).parent.mkdir(parents=True, exist_ok=True)
                review_bytes = paper['text'].encode('utf-8')
                (work / review_asset).write_bytes(review_bytes)
                metadata['reviewTexts'].append({'paperId': paper['id'], 'asset': review_asset,
                                               'role': 'source_catalog_input' if batch.get('protocol', {}).get('citationMode') == 'source_ids_v1' else ('local_quote_verification' if paper.get('pdf') else 'model_input_text'),
                                               'sha256': _sha(review_bytes),
                                               'archiveDeclaredHash': paper.get('hash'),
                                               'declaredHashMatchesText': (paper.get('hash') == _sha(review_bytes)) if paper.get('hash') else None})
            for paper in clean_batch['papers']:
                prepared = self._save_mineru_assets(paper, work)
                if prepared: metadata['preparations'].append(prepared)
            for paper_id, source in snapshots:
                record = source['record']
                relative = f'assets/prepared/{paper_id}'
                folder = work / relative
                folder.mkdir(parents=True, exist_ok=True)
                asset = relative + ('/source.pdf' if source['suffix'] == '.pdf' else '/source.txt')
                text_asset = relative + '/paper_text.txt'
                (work / asset).write_bytes(source['bytes'])
                text_bytes = record['text'].encode('utf-8')
                (work / text_asset).write_bytes(text_bytes)
                paper = next(p for p in clean_batch['papers'] if p.get('id') == paper_id)
                archive_text = paper.get('text')
                if not isinstance(archive_text, str):
                    raise ValueError('归档论文全文必须为字符串')
                metadata['sources'].append({key: value for key, value in record.items() if key not in {'text', 'title'}} |
                                           {'paperId': paper_id, 'sourceAsset': asset, 'textAsset': text_asset,
                                            'textSha256': _sha(text_bytes),
                                            'archiveTextSha256': _sha(archive_text.encode('utf-8')),
                                            'archiveTextMatchesImported': archive_text == record['text'],
                                            'textMatchesSource': archive_text == record['text'],
                                            'textEdited': archive_text != record['text'],
                                            'warning': '' if archive_text == record['text'] else '评审正文与导入时提取全文不同；原附件是导入时快照，不代表当前被评文本版本。'})
            (work / 'source_metadata.json').write_text(json.dumps(self._redact(metadata), ensure_ascii=False, indent=2), encoding='utf-8')
            try:
                result = subprocess.run([node, str(self.root / 'export_offline.cjs'), str(work), str(self.root / 'index.html')],
                                        capture_output=True, timeout=120, check=False, pass_fds=(output_fd,))
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError('离线导出器执行失败或超时，未保存不完整报告') from exc
            if result.returncode:
                detail = self._redact(result.stderr.decode('utf-8', errors='replace'))[:1000]
                raise ValueError('归档验证或离线导出失败：' + detail)
            required = ['archive.json', 'index.html', 'summary.csv', 'run_scores.csv', 'usage.csv', 'README.md']
            if any(not (work / item).is_file() or (work / item).is_symlink() for item in required):
                raise RuntimeError('离线导出器未生成完整报告，已清理临时结果')
            # Reserve target exclusively, then move children; no replace/overwrite operation.
            os.mkdir(name, 0o700, dir_fd=output_fd)
            final = name
            target = Path('/proc/self/fd') / str(output_fd) / name
            for child in work.iterdir():
                os.rename(child, target / child.name)
            work.rmdir()
            temporary = None
            files = sorted(str(p.relative_to(target)) for p in target.rglob('*') if p.is_file())
            actual = output / name
            target_stat = target.stat()
            # A report must still be reachable through the checked physical ancestry.
            check_fd = _open_dir(actual)
            try:
                registered_stat = os.fstat(check_fd)
                if (registered_stat.st_dev, registered_stat.st_ino) != (target_stat.st_dev, target_stat.st_ino):
                    raise RuntimeError('输出父目录在保存期间发生变化，报告未注册')
            finally:
                os.close(check_fd)
            capability = secrets.token_urlsafe(32)
            with self._lock:
                self._reports[capability] = {'path': actual, 'device': registered_stat.st_dev,
                                            'inode': registered_stat.st_ino, 'files': set(files)}
            final = None
            return {'path': str(actual), 'indexPath': str(actual / 'index.html'),
                    'indexUrl': REPORT_PREFIX + capability + '/index.html', 'files': files}
        finally:
            for folder in (temporary, final):
                if folder:
                    shutil.rmtree(Path('/proc/self/fd') / str(output_fd) / folder, ignore_errors=True)
            os.close(output_fd)

    @staticmethod
    def _slug(value, limit):
        value = re.sub(r'[^\w.-]+', '_', str(value), flags=re.UNICODE).strip('._-')
        return (value or 'unnamed')[:limit]

    def get_report(self, path):
        try:
            if not isinstance(path, str) or '?' in path or '#' in path or not path.startswith(REPORT_PREFIX):
                raise ValueError('未知报告路径')
            tail = path[len(REPORT_PREFIX):]
            capability, separator, relative = tail.partition('/')
            if not separator or not re.fullmatch(r'[A-Za-z0-9_-]{30,100}', capability):
                raise ValueError('无效报告访问能力')
            relative = _relative(unquote(relative))
            with self._lock:
                report = self._reports.get(capability)
            if not report or relative not in report['files']:
                raise ValueError('报告文件未注册')
            fd = _open_dir(report['path'])
            try:
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) != (report['device'], report['inode']):
                    raise ValueError('报告目录已被替换')
                parent_parts = PurePosixPath(relative).parts[:-1]
                for part in parent_parts:
                    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = nxt
                item = os.open(PurePosixPath(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(item, 'rb') as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise ValueError('报告资源不是普通文件')
                    data = stream.read(MAX_ARCHIVE_BYTES * 4 + 1)
                    if len(data) > MAX_ARCHIVE_BYTES * 4:
                        raise ValueError('报告资源超过读取上限')
            finally:
                os.close(fd)
            mime = mimetypes.guess_type(relative)[0] or 'application/octet-stream'
            if mime.startswith('text/') or mime == 'application/json':
                mime += '; charset=utf-8'
            return data, mime
        except (OSError, ValueError) as exc:
            raise FileNotFoundError('报告资源不存在或访问未获授权') from exc
