"""MinerU bridge regression tests. No GPU, model, or external executable used."""
import hashlib
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import mineru_bridge as module
from mineru_bridge import MinerUJobs, host_environment
from local_workspace import LocalWorkspace


PDF = b'%PDF-1.7\nimmutable synthetic fixture\n%%EOF\n'
SHA = hashlib.sha256(PDF).hexdigest()
UUID = 'GPU-ab0e31f0-8d04-f7f3-8c1e-284cec042fde'
OTHER_UUID = 'GPU-d1111111-2222-3333-4444-555555555555'
MD = '# 完整正文\n\n$x^2 + y^2 = z^2$\n\n![图](images/figure.png)\n末行保留\n'


class FakeProcess:
    def __init__(self, argv, blocked=False):
        self.args = argv
        self.pid = 987654
        self.returncode = None if blocked else 0

    def wait(self, timeout=None):
        if self.returncode is None:
            time.sleep(0.003)
            raise subprocess.TimeoutExpired(self.args, timeout)
        return self.returncode

    def poll(self):
        return self.returncode


class FakePopen:
    def __init__(self, mode='success'):
        self.mode = mode
        self.calls = []
        self.processes = []
        self.conversion_started = threading.Event()
        self.conversion_count = 0

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs.copy()))
        process = FakeProcess(argv)
        self.processes.append(process)
        log = kwargs['stdout']
        if argv[0] == '/usr/bin/nvidia-smi':
            # Intentionally list the other card first: PCI sorting must select 0.
            rows = f'0, {OTHER_UUID}, NVIDIA RTX PRO 6000, 00000000:21:00.0\n'
            if self.mode != 'no_target':
                rows += f'1, {UUID}, NVIDIA GeForce RTX 5060 Ti, 00000000:01:00.0\n'
            if self.mode == 'two_targets':
                rows += f'2, GPU-a1111111-2222-3333-4444-555555555555, NVIDIA GeForce RTX 5060 Ti, 00000000:02:00.0\n'
            log.write(rows.encode())
        elif argv[0] == '/usr/bin/pdfinfo':
            if self.mode == 'pdfinfo_error':
                process.returncode = 3
                log.write(b'Synthetic PDF inspection error\n')
            else:
                log.write(b'Pages: 2\n' if self.mode != 'pdfinfo_bad_count' else b'Pages: 0\n')
        elif 'python' in argv:
            name = 'NVIDIA RTX PRO 6000' if self.mode == 'wrong_gpu' else 'NVIDIA GeForce RTX 5060 Ti'
            log.write(json.dumps({'count': 1, 'name': name}).encode())
        elif '--version' in argv:
            log.write(b'mineru, version 3.4.5\n' if self.mode != 'bad_version' else b'unknown build\n')
        else:
            self.conversion_count += 1
            if self.mode == 'spawn_error':
                raise FileNotFoundError('synthetic missing executable')
            output = Path(argv[argv.index('-o') + 1]) / 'source/hybrid_auto'
            output.mkdir(parents=True)
            source = Path(argv[argv.index('-p') + 1])
            text = '' if self.mode == 'empty_md' else MD
            if self.mode == 'too_long':
                text = '文' * (module.MAX_MARKDOWN_CHARS + 1)
            (output / 'source.md').write_bytes(text.encode())
            (output / 'source_middle.json').write_text(json.dumps({'pdf_info': [{'page_idx': 0}, {'page_idx': 1}]}))
            (output / 'source_content_list.json').write_text('[{"type":"text","text":"fixture"}]')
            (output / 'source_origin.pdf').write_bytes(PDF + b'MinerU may rewrite its own copy')
            (output / 'images').mkdir()
            (output / 'images/figure.png').write_bytes(b'preserved mock image')
            log.write(b'MinerU full diagnostic log\n')
            if self.mode == 'two_md':
                (output / 'other.md').write_text('Ambiguous second main document')
            if self.mode == 'wrong_layout':
                (output / 'source.md').rename(output / 'other.md')
            if self.mode == 'missing_middle':
                (output / 'source_middle.json').unlink()
            if self.mode == 'missing_page':
                (output / 'source_middle.json').write_text('{"pdf_info":[{"page_idx":0},{"page_idx":2}]}')
            if self.mode == 'partial_pages':
                (output / 'source_middle.json').write_text('{"pdf_info":[{"page_idx":0}]}')
            if self.mode == 'symlink':
                (output / 'linked.md').symlink_to(output / 'source.md')
            if self.mode == 'changed_source':
                source.write_bytes(PDF + b'changed')
            if self.mode == 'exit_error':
                process.returncode = 7
            if self.mode == 'exit_second' and self.conversion_count == 2:
                process.returncode = 7
            if self.mode == 'blocked':
                process.returncode = None
            self.conversion_started.set()
        log.flush()
        return process

    def kill(self, pid, sig):
        if sig == signal.SIGTERM:
            self.processes[-1].returncode = -15


class MinerUTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paperbench-mineru-test-')
        self.base = Path(self.tmp.name)
        self.workspace = LocalWorkspace(self.base)
        self.workspace.pdf_bytes = lambda digest: PDF if digest == SHA else (_ for _ in ()).throw(ValueError('missing PDF'))
        self.jobs = []

    def tearDown(self):
        for jobs in self.jobs:
            jobs.close()
        self.tmp.cleanup()

    def make(self, mode='success', timeout=2):
        factory = FakePopen(mode)
        jobs = MinerUJobs(self.workspace, _popen=factory, _timeout=timeout)
        self.jobs.append(jobs)
        return jobs, factory

    def request(self, count=1):
        return {'papers': [{'paperId': f'paper-{index}', 'sha256': SHA, 'title': '公式论文 / 安全路径'}
                           for index in range(count)], 'outputPath': str(self.base / '报告')}

    def wait(self, jobs, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = jobs.status({'jobId': job_id})
            if result['status'] != 'running':
                return result
            time.sleep(0.005)
        self.fail('Mock conversion did not finish')

    def test_success_preserves_full_markdown_pdf_outputs_and_audit(self):
        jobs, factory = self.make()
        initial = jobs.start(self.request(2))
        self.assertEqual(initial['status'], 'running')
        result = self.wait(jobs, initial['jobId'])
        self.assertEqual(result['status'], 'complete', result['message'])
        self.assertEqual((result['total'], result['completed'], result['current']), (2, 2, None))
        self.assertEqual(len(factory.calls), 7)
        self.assertEqual([item['paperId'] for item in result['items']], ['paper-0', 'paper-1'])
        for item in result['items']:
            self.assertEqual(item['text'], MD)
            provenance = item['provenance']
            self.assertEqual(provenance['pdfSha256'], SHA)
            self.assertEqual(provenance['markdownSha256'], hashlib.sha256(MD.encode()).hexdigest())
            self.assertEqual(provenance['version'], '3.4.5')
            self.assertEqual(provenance['gpu']['uuid'], UUID)
            self.assertEqual(provenance['gpu']['cudaOrdinal'], 0)
            self.assertEqual(provenance['gpu']['nvidiaSmiIndex'], 1)
            self.assertEqual(provenance['gpu']['verifiedDeviceCount'], 1)
            self.assertEqual(provenance['command']['exitCode'], 0)
            self.assertEqual(provenance['sourcePageCount'], 2)
            self.assertEqual(provenance['pagesReported'], provenance['sourcePageCount'])
            self.assertEqual(provenance['pageCountCommand']['argv'][0], '/usr/bin/pdfinfo')
            self.assertEqual(provenance['pageCountCommand']['exitCode'], 0)
            self.assertEqual(Path(provenance['markdownPath']).read_bytes(), MD.encode())
            directory = Path(provenance['conversionDir'])
            self.assertEqual((directory / 'source.pdf').read_bytes(), PDF)
            self.assertEqual(json.loads((directory / 'conversion-manifest.json').read_text())['status'], 'complete')
            for asset in provenance['assets']:
                content = (directory / asset['relativePath']).read_bytes()
                self.assertEqual(asset['sha256'], hashlib.sha256(content).hexdigest())
                self.assertEqual(asset['bytes'], len(content))
            names = [asset['relativePath'] for asset in provenance['assets']]
            self.assertIn('outputs/source/hybrid_auto/images/figure.png', names)
            self.assertIn('mineru.log', names)
            self.assertIn('conversion-manifest.json', names)
            trusted = jobs.get_conversion(provenance['conversionId'])
            self.assertEqual(trusted['directory'], str(directory))
            trusted['assets'].clear()
            self.assertTrue(jobs.get_conversion(provenance['conversionId'])['assets'])
        manifest = json.loads((Path(result['conversionRoot']) / 'job-manifest.json').read_text())
        self.assertEqual(manifest['status'], 'complete')
        self.assertEqual(len(manifest['preflightCommands']), 3)
        self.assertNotIn('text', manifest['items'][0])

    def test_host_environment_discards_appimage_libraries_and_credentials(self):
        polluted = {'PATH': '/tmp/.mount_app/usr/bin', 'HOME': '/tmp/.mount_app/home',
                    'PYTHONHOME': '/tmp/.mount_app', 'PYTHONPATH': '/tmp/evil', 'LD_LIBRARY_PATH': '/tmp/evil',
                    'LD_PRELOAD': '/tmp/evil.so', 'BASH_ENV': '/tmp/evil.sh', 'ENV': '/tmp/evil.sh',
                    'APPDIR': '/tmp/.mount_app', 'APPIMAGE': '/tmp/file', 'POPPLER_DATADIR': '/tmp/evil',
                    'CONDA_PREFIX': '/tmp/evil', 'VIRTUAL_ENV': '/tmp/evil', 'OPENAI_API_KEY': 'secret',
                    'CUDA_VISIBLE_DEVICES': '1', 'HTTP_PROXY': 'http://example.test'}
        with patch.dict(os.environ, polluted):
            env = host_environment(0)
        for key in polluted:
            if key not in {'PATH', 'HOME', 'CUDA_VISIBLE_DEVICES'}:
                self.assertNotIn(key, env)
        self.assertEqual(env['PATH'], module.HOST_PATH)
        self.assertNotEqual(env['HOME'], polluted['HOME'])
        self.assertEqual(env['CUDA_VISIBLE_DEVICES'], '0')
        self.assertEqual(env['CUDA_DEVICE_ORDER'], 'PCI_BUS_ID')
        self.assertEqual(env['MINERU_MODEL_SOURCE'], 'local')
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')
        for invalid in (True, '0', UUID, -1):
            with self.assertRaises(ValueError):
                host_environment(invalid)

    def test_fixed_command_uses_only_target_gpu_and_new_process_group(self):
        jobs, factory = self.make()
        result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'complete')
        for argv, options in factory.calls:
            self.assertTrue(options['start_new_session'])
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            self.assertEqual(options['stderr'], subprocess.STDOUT)
            self.assertNotIn('shell', options)
            self.assertEqual(options['env']['MINERU_MODEL_SOURCE'], 'local')
            if argv[0] not in {'/usr/bin/nvidia-smi', '/usr/bin/pdfinfo'}:
                self.assertEqual(options['env']['CUDA_VISIBLE_DEVICES'], '0')
        argv = factory.calls[-1][0]
        self.assertEqual(argv[:3], ['/bin/bash', module.ENV_SCRIPT, 'mineru'])
        self.assertEqual(argv[-4:], ['-b', 'hybrid-engine', '--effort', 'high'])

    def test_invalid_requests_never_start_a_process(self):
        jobs, factory = self.make()
        bad_requests = [dict(self.request(), cmd='id'), dict(self.request(), env_script='/tmp/evil'),
                        dict(self.request(), papers=[]), dict(self.request(), outputPath='../escape')]
        for request in bad_requests:
            with self.assertRaises(ValueError):
                jobs.start(request)
        request = self.request(2)
        request['papers'][1]['paperId'] = request['papers'][0]['paperId']
        with self.assertRaises(ValueError):
            jobs.start(request)
        request = self.request()
        request['papers'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            jobs.start(request)
        self.assertEqual(factory.calls, [])

    def test_snapshot_hash_mismatch_rejected_before_process(self):
        jobs, factory = self.make()
        self.workspace.pdf_bytes = lambda digest: PDF + b'mutated'
        with self.assertRaisesRegex(ValueError, '哈希'):
            jobs.start(self.request())
        self.assertEqual(factory.calls, [])

    def test_output_symlink_rejected_before_process(self):
        jobs, factory = self.make()
        (self.base / 'link').symlink_to(self.base, target_is_directory=True)
        request = self.request()
        request['outputPath'] = str(self.base / 'link/new')
        with self.assertRaises(ValueError):
            jobs.start(request)
        self.assertEqual(factory.calls, [])

    def test_missing_ambiguous_or_wrong_target_gpu_blocks_conversion(self):
        for mode in ('no_target', 'two_targets', 'wrong_gpu', 'bad_version'):
            with self.subTest(mode=mode):
                jobs, factory = self.make(mode)
                result = self.wait(jobs, jobs.start(self.request())['jobId'])
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['items'], [])
                self.assertFalse(factory.conversion_started.is_set())

    def test_invalid_or_partial_outputs_never_become_scoring_text(self):
        for mode in ('empty_md', 'two_md', 'wrong_layout', 'missing_middle', 'missing_page', 'symlink', 'changed_source', 'exit_error'):
            with self.subTest(mode=mode):
                jobs, factory = self.make(mode)
                result = self.wait(jobs, jobs.start(self.request())['jobId'])
                self.assertEqual(result['status'], 'failed', mode)
                self.assertEqual(result['completed'], 0)
                self.assertEqual(result['items'], [])
                directory = next(Path(result['conversionRoot']).glob('01__*'))
                self.assertTrue((directory / 'mineru.log').exists())
                manifest = json.loads((directory / 'conversion-manifest.json').read_text())
                self.assertEqual(manifest['status'], 'failed')
                self.assertIsNotNone(manifest['command']['exitCode'])
                with self.assertRaises(ValueError):
                    jobs.get_conversion(manifest['conversionId'])

    def test_oversized_markdown_is_rejected_without_truncation(self):
        jobs, factory = self.make('too_long')
        result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('未截断', result['message'])
        self.assertEqual(result['items'], [])
        path = next(Path(result['conversionRoot']).rglob('source.md'))
        self.assertEqual(len(path.read_text()), module.MAX_MARKDOWN_CHARS + 1)

    def test_async_cancel_terminates_group_and_does_not_run_later_papers(self):
        jobs, factory = self.make('blocked')
        with patch.object(module.os, 'killpg', side_effect=factory.kill) as kill:
            initial = jobs.start(self.request(2))
            self.assertTrue(factory.conversion_started.wait(2))
            self.assertEqual(jobs.status({})['status'], 'running')
            with self.assertRaisesRegex(ValueError, '已有'):
                jobs.start(self.request())
            before = time.monotonic()
            jobs.cancel({'jobId': initial['jobId']})
            self.assertLess(time.monotonic() - before, 0.2)
            result = self.wait(jobs, initial['jobId'])
            self.assertEqual(result['status'], 'cancelled')
            self.assertEqual(result['items'], [])
            self.assertEqual(len(factory.calls), 5)
            self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
            manifest = json.loads(next(Path(result['conversionRoot']).rglob('conversion-manifest.json')).read_text())
            self.assertTrue(manifest['command']['cancelled'])
            self.assertEqual(manifest['status'], 'cancelled')

    def test_timeout_preserves_exit_diagnostics_and_rejects_partial_output(self):
        jobs, factory = self.make('blocked', timeout=0.02)
        with patch.object(module.os, 'killpg', side_effect=factory.kill):
            result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['items'], [])
        manifest = json.loads(next(Path(result['conversionRoot']).rglob('conversion-manifest.json')).read_text())
        self.assertTrue(manifest['command']['timedOut'])
        self.assertEqual(manifest['command']['exitCode'], -15)

    def test_close_cancels_process_and_prevents_new_jobs(self):
        jobs, factory = self.make('blocked')
        with patch.object(module.os, 'killpg', side_effect=factory.kill):
            job_id = jobs.start(self.request())['jobId']
            self.assertTrue(factory.conversion_started.wait(2))
            jobs.close()
            self.assertEqual(jobs.status({'jobId': job_id})['status'], 'cancelled')
        with self.assertRaisesRegex(ValueError, '关闭'):
            jobs.start(self.request())

    def test_status_and_capability_are_copies_and_unknown_ids_rejected(self):
        jobs, _ = self.make()
        result = self.wait(jobs, jobs.start(self.request())['jobId'])
        result['items'].clear()
        self.assertEqual(len(jobs.status({})['items']), 1)
        with self.assertRaises(ValueError):
            jobs.status({'jobId': 'missing'})
        with self.assertRaises(ValueError):
            jobs.status({'path': '/etc/passwd'})
        with self.assertRaises(ValueError):
            jobs.get_conversion('/etc/passwd')

    def test_second_failure_keeps_first_verified_item_but_batch_is_failed(self):
        jobs, factory = self.make('exit_second')
        result = self.wait(jobs, jobs.start(self.request(3))['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual((result['total'], result['completed']), (3, 1))
        self.assertEqual([item['paperId'] for item in result['items']], ['paper-0'])
        self.assertEqual(result['failures'][0]['paperId'], 'paper-1')
        self.assertEqual(len(factory.calls), 7)
        self.assertTrue(jobs.get_conversion(result['items'][0]['provenance']['conversionId']))
        self.assertFalse(list(Path(result['conversionRoot']).glob('03__*')))

    def test_startup_failure_has_command_and_log_audit(self):
        jobs, _ = self.make('spawn_error')
        result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['items'], [])
        manifest = json.loads(next(Path(result['conversionRoot']).rglob('conversion-manifest.json')).read_text())
        self.assertTrue(manifest['command']['startupFailed'])
        self.assertIsNone(manifest['command']['exitCode'])
        self.assertIn('synthetic missing executable', Path(manifest['command']['logPath']).read_text())

    def test_job_manifest_failure_never_publishes_complete_status(self):
        jobs, _ = self.make()
        original_write = module._write_json
        def fail_final(path, obj):
            if path.name == 'job-manifest.json':
                raise OSError('synthetic disk full')
            return original_write(path, obj)
        with patch.object(module, '_write_json', side_effect=fail_final):
            result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('清单保存失败', result['message'])

    def test_contiguous_partial_pages_rejected_against_original_pdf_count(self):
        jobs, _ = self.make('partial_pages')
        result = self.wait(jobs, jobs.start(self.request())['jobId'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['items'], [])
        self.assertIn('原 PDF 共 2 页', result['message'])
        manifest = json.loads(next(Path(result['conversionRoot']).rglob('conversion-manifest.json')).read_text())
        self.assertEqual(manifest['sourcePageCount'], 2)
        self.assertEqual(manifest['pageCountCommand']['exitCode'], 0)
        self.assertEqual(manifest['command']['exitCode'], 0)
        self.assertEqual(manifest['status'], 'failed')

    def test_unverifiable_source_page_count_blocks_mineru(self):
        for mode in ('pdfinfo_error', 'pdfinfo_bad_count'):
            with self.subTest(mode=mode):
                jobs, factory = self.make(mode)
                result = self.wait(jobs, jobs.start(self.request())['jobId'])
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['items'], [])
                self.assertFalse(factory.conversion_started.is_set())
                manifest = json.loads(next(Path(result['conversionRoot']).rglob('conversion-manifest.json')).read_text())
                self.assertIn('pageCountCommand', manifest)
                self.assertNotIn('sourcePageCount', manifest)

    def test_lost_start_response_recovers_running_job_without_duplicate_conversion(self):
        jobs, factory = self.make('blocked')
        request = dict(self.request(), requestId='request_lost_001')
        with patch.object(module.os, 'killpg', side_effect=factory.kill):
            first = jobs.start(request)
            self.assertTrue(factory.conversion_started.wait(2))
            recovered = jobs.status({'requestId': request['requestId']})
            self.assertEqual(recovered['jobId'], first['jobId'])
            self.assertEqual(recovered['requestId'], request['requestId'])
            self.assertEqual(recovered['papers'], [{'paperId': 'paper-0', 'sha256': SHA}])
            retried = jobs.start(copy.deepcopy(request))
            self.assertEqual(retried['jobId'], first['jobId'])
            self.assertEqual(retried['status'], 'running')
            self.assertEqual(factory.conversion_count, 1)
            jobs.cancel({'requestId': request['requestId']})
            self.assertEqual(self.wait(jobs, first['jobId'])['status'], 'cancelled')
            self.assertEqual(jobs.start(request)['status'], 'cancelled')
            self.assertEqual(factory.conversion_count, 1)

    def test_completed_idempotent_retry_does_not_need_pdf_cache_or_follow_latest_job(self):
        jobs, factory = self.make()
        request = dict(self.request(), requestId='request_complete_001')
        result = self.wait(jobs, jobs.start(request)['jobId'])
        other = dict(self.request(), requestId='request_other_tab')
        other['outputPath'] = str(self.base / '其他报告')
        self.wait(jobs, jobs.start(other)['jobId'])
        self.workspace.pdf_bytes = lambda digest: (_ for _ in ()).throw(ValueError('cache expired'))
        retried = jobs.start(request)
        self.assertEqual(retried['jobId'], result['jobId'])
        self.assertEqual(retried['status'], 'complete')
        self.assertEqual(jobs.status({'requestId': request['requestId']})['jobId'], result['jobId'])
        self.assertEqual(jobs.status({})['requestId'], other['requestId'])
        self.assertEqual(factory.conversion_count, 2)

    def test_same_request_id_rejects_changed_path_paper_hash_title_or_order(self):
        jobs, factory = self.make()
        request = dict(self.request(2), requestId='request_immutable_001')
        self.wait(jobs, jobs.start(request)['jobId'])
        variants = []
        changed = copy.deepcopy(request)
        changed['outputPath'] = str(self.base / 'different_output')
        variants.append(changed)
        for key, value in [('paperId', 'different-paper'), ('sha256', '0' * 64), ('title', 'new title')]:
            changed = copy.deepcopy(request)
            changed['papers'][0][key] = value
            variants.append(changed)
        changed = copy.deepcopy(request)
        changed['papers'].reverse()
        variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed):
                with self.assertRaisesRegex(ValueError, '不同的论文或输出路径'):
                    jobs.start(changed)
        self.assertEqual(factory.conversion_count, 2)

    def test_request_id_validation_unknown_lookup_and_mutual_exclusion(self):
        jobs, factory = self.make()
        for invalid in ('short', '../unsafe-request', '', None, 123, 'x' * 101):
            with self.assertRaises(ValueError):
                jobs.start(dict(self.request(), requestId=invalid))
            with self.assertRaises(ValueError):
                jobs.status({'requestId': invalid})
        with self.assertRaisesRegex(ValueError, '不存在'):
            jobs.status({'requestId': 'unknown_request_001'})
        with self.assertRaisesRegex(ValueError, '不能同时提供'):
            jobs.status({'jobId': 'missing', 'requestId': 'unknown_request_001'})
        self.assertEqual(factory.calls, [])

    def test_concurrent_retries_create_one_job_and_conversion(self):
        jobs, factory = self.make()
        request = dict(self.request(), requestId='request_concurrent_001')
        barrier = threading.Barrier(4)
        def submit(_):
            barrier.wait(timeout=2)
            return jobs.start(copy.deepcopy(request))['jobId']
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(submit, range(4)))
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(self.wait(jobs, ids[0])['status'], 'complete')
        self.assertEqual(factory.conversion_count, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
