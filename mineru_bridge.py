"""Local, serial MinerU conversion of immutable workspace PDF snapshots.

The HTTP caller selects cached papers and an output directory, never a command,
environment, GPU, or executable. Constructor overrides are for isolated tests.
"""
import copy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import stat
import subprocess
import threading
import time

from local_workspace import _open_dir, _read_regular


ENV_SCRIPT = '/home/xx/DS/MinerU/env.sh'
HOST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
MAX_MARKDOWN_CHARS = 2_000_000
MAX_PAPERS = 30
MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
MAX_ASSETS = 10000
MAX_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024
PER_PAPER_TIMEOUT_SECONDS = 3600


def _now():
    return datetime.now(timezone.utc).isoformat()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def host_environment(gpu_ordinal=None):
    """Start from host identity, not AppImage/Conda/Python/library/key settings."""
    user = pwd.getpwuid(os.getuid())
    env = {'HOME': user.pw_dir, 'USER': user.pw_name, 'LOGNAME': user.pw_name,
           'PATH': HOST_PATH, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
           'MINERU_MODEL_SOURCE': 'local', 'HF_HUB_OFFLINE': '1',
           'TRANSFORMERS_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1',
           'CUDA_DEVICE_ORDER': 'PCI_BUS_ID', 'PYTHONUNBUFFERED': '1'}
    if gpu_ordinal is not None:
        if isinstance(gpu_ordinal, bool) or not isinstance(gpu_ordinal, int) or not 0 <= gpu_ordinal <= 255:
            raise ValueError('显卡 CUDA 编号无效')
        env['CUDA_VISIBLE_DEVICES'] = str(gpu_ordinal)
    return env


def _mkdir(path):
    fd = _open_dir(path, create=True)
    os.close(fd)


def _write_new(path, data):
    parent = _open_dir(path.parent)
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(parent)


def _write_json(path, obj):
    temp = path.with_name(path.name + '.' + secrets.token_hex(5) + '.tmp')
    _write_new(temp, json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8'))
    # The containing directory is application-created, and every lookup rejects links.
    parent = _open_dir(path.parent)
    try:
        os.replace(temp.name, path.name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        os.close(parent)


def _slug(title):
    value = re.sub(r'[^\w\u4e00-\u9fff-]+', '_', title, flags=re.UNICODE).strip('_-')
    return (value or 'paper')[:64]


def _inventory(directory):
    """Inventory complete ordinary outputs, rejecting links and special files."""
    assets, total = [], 0
    for current, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs:
            if not stat.S_ISDIR((Path(current) / name).lstat().st_mode):
                raise ValueError('MinerU 输出包含符号链接或非普通目录')
        for name in sorted(files):
            path = Path(current) / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('MinerU 输出包含符号链接或非普通文件')
            if len(assets) >= MAX_ASSETS:
                raise ValueError('MinerU 输出文件过多；未截断附件清单')
            total += info.st_size
            if total > MAX_OUTPUT_BYTES:
                raise ValueError('MinerU 输出超过本机验收大小上限；未截断输出')
            parent = _open_dir(path.parent)
            try:
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
                with os.fdopen(fd, 'rb') as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode):
                        raise ValueError('MinerU 输出不是普通文件')
                    digest, size = hashlib.sha256(), 0
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_OUTPUT_BYTES or size > info.st_size:
                            raise ValueError('MinerU 输出在验收时发生变化')
                        digest.update(chunk)
                    if size != info.st_size:
                        raise ValueError('MinerU 输出在验收时发生变化')
            finally:
                os.close(parent)
            assets.append({'relativePath': path.relative_to(directory).as_posix(),
                           'sha256': digest.hexdigest(), 'bytes': size})
    return sorted(assets, key=lambda item: item['relativePath'])


class _Cancelled(Exception):
    pass


class MinerUJobs:
    def __init__(self, workspace, *, _popen=None, _env_script=None,
                 _timeout=PER_PAPER_TIMEOUT_SECONDS):
        self.workspace = workspace
        self._popen = _popen or subprocess.Popen
        self._env_script = str(_env_script or ENV_SCRIPT)
        self._timeout = _timeout
        self._lock = threading.RLock()
        self._jobs = {}
        self._requests = {}
        self._conversions = {}
        self._latest = None
        self._closed = False

    def _view(self, job):
        return copy.deepcopy({key: value for key, value in job.items() if not key.startswith('_')})

    def _find(self, obj):
        if not isinstance(obj, dict) or set(obj) - {'jobId', 'requestId'} or {'jobId', 'requestId'} <= set(obj):
            raise ValueError('任务查询接受 jobId 或 requestId，不能同时提供')
        if 'requestId' in obj:
            request_id = self._request_id(obj['requestId'])
            job_id = self._requests.get(request_id)
            if job_id is None:
                raise ValueError('此 requestId 对应的转换任务不存在或本机会话已结束')
        else:
            job_id = obj.get('jobId', self._latest)
        if not isinstance(job_id, str) or job_id not in self._jobs:
            raise ValueError('转换任务不存在或本机会话已结束')
        return self._jobs[job_id]

    @staticmethod
    def _request_id(value):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', value):
            raise ValueError('requestId 须为 8–100 位字母、数字、下划线或连字符')
        return value

    def start(self, obj):
        if not isinstance(obj, dict) or set(obj) - {'papers', 'outputPath', 'requestId'}:
            raise ValueError('转换只接受 papers、outputPath 和可选 requestId，不能自定义命令或环境')
        request_id = self._request_id(obj['requestId']) if 'requestId' in obj else None
        papers = obj.get('papers')
        if not isinstance(papers, list) or not 1 <= len(papers) <= MAX_PAPERS:
            raise ValueError('每批 MinerU 转换需要 1–30 篇 PDF')
        with self._lock:
            if self._closed:
                raise ValueError('本机转换服务已关闭')
            output = self.workspace.validate_output({'path': obj.get('outputPath')})['path']
            normalized_papers, ids = [], set()
            for paper in papers:
                if not isinstance(paper, dict) or set(paper) - {'paperId', 'sha256', 'title'}:
                    raise ValueError('论文只接受 paperId、sha256 和 title')
                paper_id, digest, title = paper.get('paperId'), paper.get('sha256'), paper.get('title')
                if not isinstance(paper_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', paper_id) or '..' in paper_id:
                    raise ValueError('论文 ID 无效')
                if paper_id in ids:
                    raise ValueError('论文 ID 重复')
                if not isinstance(title, str) or not title.strip() or len(title) > 1000:
                    raise ValueError('论文标题无效')
                if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
                    raise ValueError('PDF 哈希无效')
                ids.add(paper_id)
                normalized_papers.append({'paperId': paper_id, 'sha256': digest, 'title': title})
            request_payload = {'outputPath': output, 'papers': normalized_papers}
            if request_id in self._requests:
                existing = self._jobs[self._requests[request_id]]
                if existing['_requestPayload'] != request_payload:
                    raise ValueError('此 requestId 已用于不同的论文或输出路径；不能复用请求编号')
                # A lost response must not start a second conversion, even when
                # the first job has finished or its original PDF cache expired.
                return self._view(existing)
            if any(job['status'] == 'running' for job in self._jobs.values()):
                raise ValueError('已有 MinerU 转换正在运行；请等待或取消当前任务')
            snapshots, total_bytes = [], 0
            for paper in normalized_papers:
                digest = paper['sha256']
                data = self.workspace.pdf_bytes(digest)
                if not isinstance(data, bytes) or not data.startswith(b'%PDF-') or _sha(data) != digest:
                    raise ValueError('缓存 PDF 的类型或哈希不一致；未启动转换')
                total_bytes += len(data)
                if total_bytes > MAX_SNAPSHOT_BYTES:
                    raise ValueError('本批 PDF 快照超过 128 MiB；未启动转换')
                snapshots.append(dict(paper, _bytes=data))
            job_id = secrets.token_hex(16)
            stamp = datetime.now().strftime('%Y-%m-%d__%H%M%S')
            directory = Path(output) / 'mineru_md' / (stamp + '__' + job_id[:12])
            job = {'jobId': job_id, 'requestId': request_id,
                   'papers': [{'paperId': paper['paperId'], 'sha256': paper['sha256']} for paper in normalized_papers],
                   'status': 'running', 'total': len(snapshots), 'completed': 0,
                   'current': None, 'message': '正在检查本机 MinerU 和 RTX 5060 Ti', 'items': [],
                   'failures': [], 'outputPath': output, 'conversionRoot': str(directory),
                   'createdAt': _now(), 'finishedAt': None,
                   '_cancel': threading.Event(), '_process': None, '_thread': None,
                   '_requestPayload': request_payload}
            self._jobs[job_id] = job
            if request_id is not None:
                self._requests[request_id] = job_id
            self._latest = job_id
            thread = threading.Thread(target=self._work, args=(job, snapshots, directory),
                                      name='paperbench-mineru-' + job_id[:8], daemon=True)
            job['_thread'] = thread
            thread.start()
            return self._view(job)

    def status(self, obj):
        with self._lock:
            return self._view(self._find(obj))

    def cancel(self, obj):
        with self._lock:
            job = self._find(obj)
            if job['status'] == 'running':
                job['_cancel'].set()
                job['message'] = '正在取消 MinerU；等待进程组退出'
            return self._view(job)

    def close(self):
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
            for job in jobs:
                if job['status'] == 'running':
                    job['_cancel'].set()
        for job in jobs:
            thread = job.get('_thread')
            if thread and thread is not threading.current_thread():
                thread.join(timeout=5)

    def get_conversion(self, conversion_id):
        with self._lock:
            if not isinstance(conversion_id, str) or conversion_id not in self._conversions:
                raise ValueError('MinerU 转换附件不在当前本机会话；请重新转换原 PDF 后附加')
            return copy.deepcopy(self._conversions[conversion_id])

    def _update(self, job, **fields):
        with self._lock:
            job.update(fields)

    @staticmethod
    def _stop(process):
        # A separate session includes MinerU's spawned inference workers.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        # The parent may exit before its workers; kill the group regardless.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)

    def _execute(self, job, command, env, log_path, timeout):
        record = {'argv': list(command), 'startedAt': _now(), 'finishedAt': None,
                  'exitCode': None, 'cancelled': False, 'timedOut': False, 'logPath': str(log_path)}
        if job['_cancel'].is_set():
            raise _Cancelled('用户已取消转换')
        parent = _open_dir(log_path.parent)
        try:
            fd = os.open(log_path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
        finally:
            os.close(parent)
        with os.fdopen(fd, 'wb') as log:
            try:
                process = self._popen(command, stdin=subprocess.DEVNULL, stdout=log,
                                      stderr=subprocess.STDOUT, cwd=str(log_path.parent), env=env,
                                      start_new_session=True)
            except OSError as exc:
                record.update(startupFailed=True, error=str(exc), finishedAt=_now())
                log.write(('无法启动本机命令：' + str(exc) + '\n').encode('utf-8'))
                return record
            with self._lock:
                job['_process'] = process
            deadline = time.monotonic() + timeout
            try:
                while True:
                    if job['_cancel'].is_set():
                        record['cancelled'] = True
                        self._stop(process)
                        break
                    if time.monotonic() >= deadline:
                        record['timedOut'] = True
                        self._stop(process)
                        break
                    try:
                        process.wait(timeout=0.2)
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except Exception:
                if process.poll() is None:
                    self._stop(process)
                raise
            finally:
                record['exitCode'] = process.poll()
                record['finishedAt'] = _now()
                with self._lock:
                    job['_process'] = None
                log.flush()
        return record

    @staticmethod
    def _check_exit(record):
        if record.get('startupFailed'):
            raise ValueError('无法启动本机命令：' + record['error'])
        if record['cancelled']:
            raise _Cancelled('用户已取消转换，未将未完成输出用作评分材料')
        if record['timedOut']:
            raise ValueError('MinerU 超过本篇转换时限，进程组已停止；未采用未完成输出')
        if record['exitCode'] != 0:
            raise ValueError('本机命令退出码为 ' + str(record['exitCode']) + '；请查看转换日志')

    def _preflight(self, job, directory, commands):
        gpu_log = directory / 'gpu-discovery.log'
        result = self._execute(job, ['/usr/bin/nvidia-smi', '--query-gpu=index,uuid,name,pci.bus_id',
                                    '--format=csv,noheader'], host_environment(), gpu_log, 20)
        commands.append(result)
        self._check_exit(result)
        rows = csv.reader(io.StringIO(_read_regular(gpu_log, 65536).decode('utf-8')))
        devices = []
        for row in rows:
            if len(row) != 4:
                raise ValueError('无法核验显卡发现结果')
            index, uuid, name, pci = [value.strip() for value in row]
            if not index.isdigit() or not re.fullmatch(r'GPU-[0-9a-fA-F-]{16,64}', uuid) or not re.fullmatch(r'[0-9a-fA-F]{4,8}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]', pci):
                raise ValueError('显卡 UUID 或 PCI 地址无效')
            devices.append({'nvidiaSmiIndex': int(index), 'uuid': uuid, 'name': name, 'pciBusId': pci})
        # nvidia-smi index order can differ from CUDA's PCI_BUS_ID order.
        devices.sort(key=lambda device: tuple(int(part, 16) for part in re.split(r'[:.]', device['pciBusId'])))
        matches = [dict(device, cudaOrdinal=index) for index, device in enumerate(devices)
                   if re.search(r'\bRTX\s+5060\s+Ti\b', device['name'], re.I)]
        if len(matches) != 1:
            raise ValueError('必须检测到唯一的 RTX 5060 Ti；未使用其他显卡启动 MinerU')
        if len({device['pciBusId'].lower() for device in devices}) != len(devices):
            raise ValueError('显卡 PCI 地址重复，无法可靠选择目标卡')
        gpu = matches[0]
        # Local vLLM 0.20.2 parses CUDA_VISIBLE_DEVICES as integers, not UUIDs.
        env = host_environment(gpu['cudaOrdinal'])
        verify_log = directory / 'gpu-verification.log'
        verify_script = ('import json,torch; n=torch.cuda.device_count(); '
                         'print(json.dumps({"count":n,"name":torch.cuda.get_device_name(0) if n else None}))')
        result = self._execute(job, ['/bin/bash', self._env_script, 'python', '-c', verify_script],
                               env, verify_log, 60)
        commands.append(result)
        self._check_exit(result)
        verification = None
        for line in _read_regular(verify_log, 65536).decode('utf-8').splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict) and 'count' in value and 'name' in value:
                    verification = value
            except ValueError:
                pass
        if not verification or verification['count'] != 1 or not isinstance(verification['name'], str) or not re.search(r'\bRTX\s+5060\s+Ti\b', verification['name'], re.I):
            raise ValueError('CUDA 隔离核验未通过：必须只看到一张 RTX 5060 Ti，未启动转换')
        gpu['verifiedDeviceCount'] = verification['count']
        gpu['verifiedDeviceName'] = verification['name']
        version_log = directory / 'mineru-version.log'
        result = self._execute(job, ['/bin/bash', self._env_script, 'mineru', '--version'],
                               env, version_log, 60)
        commands.append(result)
        self._check_exit(result)
        text = _read_regular(version_log, 65536).decode('utf-8')
        match = re.search(r'(?i)(?:mineru[, ]+(?:version[ :]*?)?|version[ :]+)(\d+\.\d+\.\d+)', text)
        if not match:
            raise ValueError('无法核验 MinerU 版本；未启动论文转换')
        return gpu, match.group(1), env

    def _validate(self, directory, snapshot, source_page_count):
        if _sha(_read_regular(directory / 'source.pdf')) != snapshot['sha256']:
            raise ValueError('转换原 PDF 快照哈希改变，拒绝使用输出')
        output = directory / 'outputs'
        assets = _inventory(output)
        markdown = [item for item in assets if item['relativePath'].lower().endswith('.md')]
        expected = 'source/hybrid_auto/source.md'
        if len(markdown) != 1 or markdown[0]['relativePath'] != expected:
            raise ValueError('MinerU 必须生成且仅生成一份主 Markdown：' + expected)
        if markdown[0]['bytes'] > MAX_MARKDOWN_CHARS * 4:
            raise ValueError('MinerU Markdown 超过全文验收上限；未截断全文')
        md_path = output / expected
        data = _read_regular(md_path, MAX_MARKDOWN_CHARS * 4)
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise ValueError('MinerU Markdown 不是有效 UTF-8，未替换字符') from exc
        if not text.strip() or '\x00' in text:
            raise ValueError('MinerU Markdown 为空或包含二进制空字节')
        if len(text) > MAX_MARKDOWN_CHARS:
            raise ValueError('MinerU Markdown 超过 200 万字符；未截断全文')
        if _sha(data) != markdown[0]['sha256']:
            raise ValueError('MinerU Markdown 在验收时发生变化')
        # These default hybrid artifacts distinguish a completed conversion from
        # a lone partial Markdown left by an interrupted or incompatible tool.
        middle_path = output / 'source/hybrid_auto/source_middle.json'
        middle = json.loads(_read_regular(middle_path, 128 * 1024 * 1024))
        pages = middle.get('pdf_info') if isinstance(middle, dict) else None
        if not isinstance(pages, list) or not pages or any(not isinstance(page, dict) for page in pages):
            raise ValueError('MinerU 页面记录缺失，输出未通过完整性检查')
        indices = [page.get('page_idx') for page in pages]
        if any(type(value) is not int for value in indices) or indices != list(range(len(pages))):
            raise ValueError('MinerU 页面记录不连续，输出未通过完整性检查')
        if len(pages) != source_page_count:
            raise ValueError(f'MinerU 仅记录 {len(pages)} 页，原 PDF 共 {source_page_count} 页；输出未覆盖全部原件，未用于评分')
        content = json.loads(_read_regular(output / 'source/hybrid_auto/source_content_list.json',
                                           128 * 1024 * 1024))
        if not isinstance(content, list) or not content:
            raise ValueError('MinerU 内容记录缺失，输出未通过完整性检查')
        return text, md_path, _sha(data), len(pages)

    def _work(self, job, snapshots, directory):
        commands, conversion_manifest, paper_directory = [], None, None
        final_status, final_message = 'failed', 'MinerU 未完成转换'
        try:
            _mkdir(directory)
            source_records = [dict({k: v for k, v in snapshot.items() if k != '_bytes'},
                                   bytes=len(snapshot['_bytes'])) for snapshot in snapshots]
            _write_json(directory / 'source-snapshots.json', source_records)
            gpu, version, env = self._preflight(job, directory, commands)
            self._update(job, gpu=gpu, version=version)
            for index, snapshot in enumerate(snapshots, 1):
                if job['_cancel'].is_set():
                    raise _Cancelled('用户已取消转换')
                conversion_id = secrets.token_hex(16)
                paper_directory = directory / (f'{index:02d}__' + _slug(snapshot['title']) + '__' + snapshot['sha256'][:12])
                _mkdir(paper_directory / 'outputs')
                _write_new(paper_directory / 'source.pdf', snapshot['_bytes'])
                current = {'paperId': snapshot['paperId'], 'title': snapshot['title'], 'index': index}
                self._update(job, current=current, message=f'MinerU 正在转换第 {index}/{len(snapshots)} 篇；RTX 5060 Ti · hybrid-engine · high')
                command = ['/bin/bash', self._env_script, 'mineru', '-p', str(paper_directory / 'source.pdf'),
                           '-o', str(paper_directory / 'outputs'), '-b', 'hybrid-engine', '--effort', 'high']
                conversion_manifest = {'schemaVersion': 1, 'conversionId': conversion_id, 'status': 'running',
                                       'source': source_records[index - 1], 'pdfSha256': snapshot['sha256'],
                                       'version': version, 'gpu': gpu, 'backend': 'hybrid-engine', 'effort': 'high',
                                       'modelSource': 'local', 'createdAt': _now(), 'command': {'argv': command}}
                _write_json(paper_directory / 'conversion-manifest.json', conversion_manifest)
                page_log = paper_directory / 'source-pdfinfo.log'
                page_record = self._execute(job, ['/usr/bin/pdfinfo', str(paper_directory / 'source.pdf')],
                                            host_environment(), page_log, 30)
                conversion_manifest['pageCountCommand'] = page_record
                self._check_exit(page_record)
                page_output = _read_regular(page_log, 65536).decode('utf-8')
                page_counts = re.findall(r'^Pages:\s*(\d+)\s*$', page_output, re.M)
                if len(page_counts) != 1 or int(page_counts[0]) <= 0:
                    raise ValueError('无法从原 PDF 核验唯一的正整数页数；未启动 MinerU 转换')
                source_page_count = int(page_counts[0])
                conversion_manifest['sourcePageCount'] = source_page_count
                _write_json(paper_directory / 'conversion-manifest.json', conversion_manifest)
                record = self._execute(job, command, env, paper_directory / 'mineru.log', self._timeout)
                conversion_manifest['command'] = record
                self._check_exit(record)
                if job['_cancel'].is_set():
                    raise _Cancelled('用户已取消转换')
                text, md_path, markdown_hash, pages = self._validate(paper_directory, snapshot, source_page_count)
                if job['_cancel'].is_set():
                    raise _Cancelled('用户已取消转换')
                provenance = {'method': 'mineru', 'conversionId': conversion_id, 'pdfSha256': snapshot['sha256'],
                              'markdownSha256': markdown_hash, 'markdownPath': str(md_path),
                              'conversionDir': str(paper_directory), 'version': version, 'gpu': gpu,
                              'backend': 'hybrid-engine', 'effort': 'high', 'modelSource': 'local',
                              'sourcePageCount': source_page_count, 'pagesReported': pages,
                              'characters': len(text), 'convertedAt': _now(),
                              'command': record, 'pageCountCommand': page_record}
                conversion_manifest.update(status='complete', finishedAt=_now(), provenance=provenance)
                _write_json(paper_directory / 'conversion-manifest.json', conversion_manifest)
                assets = _inventory(paper_directory)
                asset_hashes = {item['relativePath']: item['sha256'] for item in assets}
                if asset_hashes.get('source.pdf') != snapshot['sha256'] or asset_hashes.get('outputs/source/hybrid_auto/source.md') != markdown_hash:
                    raise ValueError('MinerU 原件或 Markdown 在最终验收时发生变化')
                if job['_cancel'].is_set():
                    raise _Cancelled('用户已取消转换')
                provenance['assets'] = assets
                trusted = {'directory': str(paper_directory), 'assets': assets, 'provenance': provenance,
                           'pdfSha256': snapshot['sha256'], 'markdownSha256': markdown_hash}
                with self._lock:
                    self._conversions[conversion_id] = copy.deepcopy(trusted)
                    job['items'].append({'paperId': snapshot['paperId'], 'text': text,
                                         'provenance': provenance})
                    job['completed'] += 1
                conversion_manifest = None
            final_status, final_message = 'complete', '全部 PDF 已由 MinerU 完整转换并通过文件验收'
        except _Cancelled as exc:
            final_status, final_message = 'cancelled', str(exc)
        except Exception as exc:
            # Deliberately keep failed partial files and logs; no text fallback.
            final_status, final_message = 'failed', 'MinerU 转换失败：' + str(exc)
            with self._lock:
                job['failures'].append({'paperId': (job['current'] or {}).get('paperId'), 'message': str(exc)})
        finally:
            if final_status == 'complete' and job['_cancel'].is_set():
                final_status, final_message = 'cancelled', '用户已取消转换；已完成文件保留，未自动开始评分'
            if conversion_manifest is not None and paper_directory is not None:
                conversion_manifest.update(status=final_status, finishedAt=_now(), error=final_message)
                try:
                    _write_json(paper_directory / 'conversion-manifest.json', conversion_manifest)
                except Exception as exc:
                    final_message += '；转换清单保存失败：' + str(exc)
            finished_at = _now()
            try:
                # Text lives in the unchanged MD; this summary avoids duplicating it.
                summary = self.status({'jobId': job['jobId']})
                summary.update(status=final_status, message=final_message, finishedAt=finished_at)
                if final_status == 'complete':
                    summary['current'] = None
                summary['items'] = [{'paperId': item['paperId'], 'provenance': item['provenance']} for item in summary['items']]
                summary['preflightCommands'] = commands
                _write_json(directory / 'job-manifest.json', summary)
            except Exception as exc:
                if final_status == 'complete':
                    final_status, final_message = 'failed', '转换任务清单保存失败：' + str(exc)
            self._update(job, status=final_status, message=final_message, finishedAt=finished_at,
                         current=None if final_status == 'complete' else job['current'])
