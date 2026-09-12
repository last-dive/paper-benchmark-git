#!/usr/bin/env python3
"""Local filesystem/GUI/export checks; no upstream or model calls."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import local_workspace as module
from local_workspace import LocalWorkspace, REPORT_PREFIX


ROOT = Path(__file__).resolve().parent
EXISTING_PDF = Path('/home/xx/chatgpt/paper_benchmark_input/01_2016_Optimality_AIPN_TAES52-2.pdf')
TEXT = '第1节：这是本地文件与离线报告流程的模拟正文，不是模型评价。' * 20


def archive(text=TEXT):
    paper = {'id': 'p01', 'title': '模拟论文', 'group': '', 'version': 'test',
             'kind': 'reference', 'change': 'other', 'text': text,
             'hash': hashlib.sha256(text.encode()).hexdigest()}
    config = {'model': 'custom / 测试模型', 'repeats': 3}
    batch = {'id': 'batch-01', 'name': '本地保存测试', 'createdAt': '2026-09-08T00:00:00Z',
             'status': 'paused', 'papers': [paper], 'config': config,
             'protocol': {'id': 'legacy-fixture', 'systemPrompt': '这是仅用于程序测试的固定协议'},
             'runs': [{'id': f'r{i}', 'paperId': 'p01', 'round': i, 'status': 'pending', 'attempts': []}
                      for i in range(1, 4)]}
    return {'schemaVersion': 1, 'config': config, 'papers': [paper],
            'batches': [batch], 'currentBatchId': 'batch-01'}


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='paperbench-workspace-test-')
        self.base = Path(self.tmp.name)
        self.root = self.base / '应用 目录'
        self.root.mkdir()
        self.workspace = LocalWorkspace(self.root, lambda: ['private-key-for-test'])
        self.input = self.base / '论文 输入'
        self.input.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name='论文 文件.txt', data=None):
        path = self.input / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(TEXT.encode() if data is None else data)
        return path

    def imported(self, path=None):
        result = self.workspace.read_paths({'paths': [str(path or self.file())]})
        self.assertEqual(result['errors'], [])
        return result['files'][0]

    @staticmethod
    def fake_export(args, **kwargs):
        if Path(args[1]).name != 'export_offline.cjs':
            raise AssertionError('Unexpected external process: ' + str(args))
        work = Path(args[2])
        for name in ['index.html', 'summary.csv', 'run_scores.csv', 'usage.csv', 'README.md']:
            (work / name).write_text('<html>离线测试</html>' if name.endswith('.html') else '离线测试', encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, b'{}', b'')

    def save(self, refs=None, state=None):
        with patch.object(module.subprocess, 'run', side_effect=self.fake_export) as run:
            result = self.workspace.save_report({'outputPath': str(self.base / '中文 输出' / '新目录'),
                                                'archive': state or archive(), 'sourceRefs': refs or {}})
        args, kwargs = run.call_args
        self.assertIsInstance(args[0], list)
        self.assertNotIn('shell', kwargs)
        self.assertIn('pass_fds', kwargs)
        return result

    def test_read_utf8_file_uri_fulltext_hash_and_original_read_only(self):
        path = self.file()
        before = (path.read_bytes(), path.stat().st_mtime_ns)
        result = self.workspace.read_paths({'paths': [path.as_uri(), str(path)], 'recursive': True})
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['files']), 1)
        item = result['files'][0]
        self.assertEqual(item['text'], TEXT)
        self.assertEqual(item['sourcePath'], str(path))
        self.assertEqual(item['relativePath'], path.name)
        self.assertEqual(item['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertIsNone(item['pages'])
        self.assertEqual(before, (path.read_bytes(), path.stat().st_mtime_ns))

    def test_directories_recurse_skip_hidden_symlinks_and_nonpapers(self):
        self.file('first.txt')
        self.file('nested/second.md')
        self.file('.hidden/secret.txt')
        self.file('data.json')
        (self.input / 'alias.txt').symlink_to(self.input / 'first.txt')
        (self.input / 'nested-link').symlink_to(self.input / 'nested', target_is_directory=True)
        result = self.workspace.read_paths({'paths': [str(self.input)], 'recursive': True})
        self.assertEqual({p['relativePath'] for p in result['files']}, {'first.txt', 'nested/second.md'})
        self.assertEqual(result['errors'], [])
        result = self.workspace.read_paths({'paths': [str(self.input)], 'recursive': False})
        self.assertEqual([p['relativePath'] for p in result['files']], ['first.txt'])

    def test_explicit_private_config_traversal_remote_uri_and_symlinks_rejected(self):
        self.file('safe.txt')
        alias = self.base / 'alias'
        alias.symlink_to(self.input, target_is_directory=True)
        private = self.root / '.private'
        private.mkdir()
        (private / 'key.txt').write_text('private-key-for-test')
        paths = [str(private / 'key.txt'), str(self.file('model_config.txt')),
                 str(self.input / '../论文 输入/safe.txt'), str(alias / 'safe.txt'),
                 'file://remote.example/tmp/hello.txt', 'file:///tmp/test.txt?key=x',
                 'relative/file.txt', str(self.input / '.hidden.txt')]
        for path in paths:
            with self.subTest(path=path):
                result = self.workspace.read_paths({'paths': [path]})
                self.assertEqual(result['files'], [])
                self.assertEqual(len(result['errors']), 1)

    def test_bounded_directory_count_and_text_never_silently_truncated(self):
        for i in range(3):
            self.file(str(i) + '.txt')
        with patch.object(module, 'MAX_FILES', 2):
            result = self.workspace.read_paths({'paths': [str(self.input)]})
        self.assertEqual(len(result['files']), 2)
        self.assertIn('上限', result['errors'][0]['message'])
        with patch.object(module, 'MAX_ENTRIES', 2):
            result = self.workspace.read_paths({'paths': [str(self.input)]})
        self.assertEqual(result['files'], [])
        self.assertIn('扫描', result['errors'][0]['message'])
        with patch.object(module, 'MAX_TEXT_CHARS', 10):
            result = self.workspace.read_paths({'paths': [str(self.input / '0.txt')]})
        self.assertEqual(result['files'], [])
        self.assertIn('未静默截断', result['errors'][0]['message'])

    def test_upload_retains_browser_relative_path_without_inventing_absolute_path(self):
        result = self.workspace.upload_files({'files': [{'name': '论文.txt', 'relativePath': '目录/论文.txt',
                                                        'base64': base64.b64encode(TEXT.encode()).decode()}]})
        self.assertEqual(result['errors'], [])
        item = result['files'][0]
        self.assertEqual(item['text'], TEXT)
        self.assertIsNone(item['sourcePath'])
        self.assertEqual(item['relativePath'], '目录/论文.txt')
        out = self.save({'p01': item['sourceId']})
        metadata = json.loads((Path(out['path']) / 'source_metadata.json').read_text())
        self.assertIsNone(metadata['sources'][0]['sourcePath'])

    def test_upload_rejects_fake_paths_binary_invalid_base64_and_secret_content(self):
        bad = [{'name': '../a.txt'}, {'name': '/a.txt'}, {'name': 'a.txt', 'relativePath': '../a.txt'},
               {'name': 'a.txt', 'relativePath': '/root/a.txt'}, {'name': 'a.txt', 'relativePath': 'b.txt'},
               {'name': 'a.txt', 'relativePath': 'x//a.txt'}, {'name': 'a.txt', 'base64': '!!!'},
               {'name': 'a.txt', 'base64': base64.b64encode(b'\xff').decode()},
               {'name': 'a.txt', 'base64': base64.b64encode(b'\x00binary').decode()},
               {'name': 'a.txt', 'base64': base64.b64encode(b'private-key-for-test').decode()}]
        result = self.workspace.upload_files({'files': [{'base64': base64.b64encode(TEXT.encode()).decode(), **x} for x in bad]})
        self.assertEqual(result['files'], [])
        self.assertEqual(len(result['errors']), len(bad))
        self.assertNotIn('private-key-for-test', json.dumps(result))

    def test_pdf_default_reading_order_page_count_and_empty_scan_warning(self):
        path = self.file('文献.pdf', b'%PDF-1.7\nfake fixture only')

        def extract(args, **kwargs):
            self.assertNotIn('-layout', args)
            self.assertNotIn('shell', kwargs)
            if Path(args[0]).name == 'pdftotext':
                Path(args[-1]).write_text(TEXT, encoding='utf-8')
                return subprocess.CompletedProcess(args, 0, b'', b'')
            return subprocess.CompletedProcess(args, 0, b'Pages: 12\n', b'')

        with patch.object(module.subprocess, 'run', side_effect=extract):
            item = self.imported(path)
        self.assertEqual(item['pages'], 12)
        self.assertEqual(item['text'], TEXT)
        self.assertTrue(any('文字索引与PDF原件一并发送' in warning for warning in item['warnings']))

        def empty(args, **kwargs):
            if Path(args[0]).name == 'pdftotext':
                Path(args[-1]).write_text('\f\f', encoding='utf-8')
            return subprocess.CompletedProcess(args, 0, b'Pages: 2\n', b'')

        with patch.object(module.subprocess, 'run', side_effect=empty):
            scanned = self.imported(path)
        self.assertFalse(scanned['text'].strip())
        self.assertTrue(any('评分开始前会阻止请求' in warning for warning in scanned['warnings']))

    def test_pdf_failure_missing_poppler_and_cache_limit_are_explicit(self):
        pdf = self.file('broken.pdf', b'%PDF-1.7\nfake')
        with patch.object(module.shutil, 'which', return_value=None):
            result = self.workspace.read_paths({'paths': [str(pdf)]})
        self.assertEqual(result['errors'], []); self.assertIn('pdftotext', result['files'][0]['warnings'][0]); self.assertEqual(result['files'][0]['text'], '')
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'bad PDF')):
            result = self.workspace.read_paths({'paths': [str(pdf)]})
        self.assertEqual(result['files'][0]['text'], '')
        with patch.object(module, 'MAX_CACHE_BYTES', 1):
            result = self.workspace.read_paths({'paths': [str(self.file())]})
        self.assertIn('缓存已满', result['errors'][0]['message'])

    def test_validate_output_no_creation_and_reject_file_link_private(self):
        output = self.base / '输出 空格' / '未创建'
        result = self.workspace.validate_output({'path': str(output)})
        self.assertEqual(result, {'path': str(output), 'exists': False, 'writable': True})
        self.assertFalse(output.parent.exists())
        alias = self.base / 'linked-output'
        alias.symlink_to(self.input, target_is_directory=True)
        for path in [self.file(), alias / 'new', self.root / '.private' / 'output']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.workspace.validate_output({'path': str(path)})

    def test_picker_cancel_missing_gui_and_literal_paths_without_shell(self):
        with patch.object(module.shutil, 'which', return_value=None), self.assertRaisesRegex(ValueError, '手动'):
            self.workspace.pick({'kind': 'files'})
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')):
            self.assertEqual(self.workspace.pick({'kind': 'files'}), {'paths': [], 'cancelled': True})
        path = self.file('$(touch never-run) 中文.txt')
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, (str(path) + '\n').encode(), b'')) as run:
            result = self.workspace.pick({'kind': 'files'})
        self.assertEqual(result, {'paths': [str(path)], 'cancelled': False})
        self.assertIsInstance(run.call_args.args[0], list)
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertFalse((self.base / 'never-run').exists())

    def test_save_source_snapshot_current_text_hash_unique_directory_and_capability(self):
        path = self.file()
        item = self.imported(path)
        path.write_text('原路径已经修改，但是缓存必须保持导入时字节', encoding='utf-8')
        edited = TEXT + '\n用户修改后的评审正文'
        result = self.save({'p01': item['sourceId']}, archive(edited))
        directory = Path(result['path'])
        self.assertEqual((directory / 'assets/prepared/p01/source.txt').read_text(), TEXT)
        self.assertEqual((directory / 'assets/prepared/p01/review_text.txt').read_text(), edited)
        meta = json.loads((directory / 'source_metadata.json').read_text())
        self.assertTrue(meta['sources'][0]['textEdited'])
        self.assertFalse(meta['sources'][0]['archiveTextMatchesImported'])
        self.assertTrue(meta['reviewTexts'][0]['declaredHashMatchesText'])
        self.assertIn('不代表当前被评文本版本', meta['sources'][0]['warning'])
        again = self.save({'p01': item['sourceId']})
        self.assertNotEqual(result['path'], again['path'])
        self.assertTrue((directory / 'index.html').is_file())
        data, mime = self.workspace.get_report(result['indexUrl'])
        self.assertIn('离线测试'.encode(), data)
        self.assertEqual(mime, 'text/html; charset=utf-8')
        url = result['indexUrl'].rsplit('/', 1)[0] + '/assets/prepared/p01/source.txt'
        self.assertEqual(self.workspace.get_report(url)[0], TEXT.encode())
        self.assertNotIn(result['indexUrl'].split('/')[3], (directory / 'archive.json').read_text())

    def test_unknown_source_reference_saves_full_report_without_arbitrary_path_read(self):
        secret = self.file('not-cached.txt', b'must-not-be-read')
        result = self.save({'p01': str(secret)})
        directory = Path(result['path'])
        meta = json.loads((directory / 'source_metadata.json').read_text())
        self.assertEqual(meta['sources'], [])
        self.assertEqual(meta['missingPaperIds'], ['p01'])
        self.assertEqual(meta['missingSources'][0]['reason'], 'source_cache_unavailable')
        self.assertEqual((directory / 'assets/prepared/p01/review_text.txt').read_text(), TEXT)
        self.assertFalse((directory / 'assets/prepared/p01/source.txt').exists())

    def test_known_and_structured_credentials_removed_everywhere(self):
        state = archive()
        state['config'] = {**state['config'], 'apiKey': 'structured-secret', 'routeId': 'local-route'}
        state['batches'][0]['extra'] = {'headers': {'Authorization': 'Bearer unknown-secret'},
                                         'echo': 'private-key-for-test / structured-secret / local-route / Bearer unknown-secret'}
        result = self.save(state=state)
        text = (Path(result['path']) / 'archive.json').read_text()
        for secret in ['private-key-for-test', 'structured-secret', 'local-route', 'Bearer unknown-secret']:
            self.assertNotIn(secret, text)
        self.assertNotIn('apiKey', text)
        self.assertNotIn('routeId', text)
        self.assertIn('[REDACTED]', text)

    def test_report_failure_cleans_partial_directory_and_does_not_register(self):
        output = self.base / 'failed-output'
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'invalid archive')):
            with self.assertRaisesRegex(ValueError, '验证'):
                self.workspace.save_report({'outputPath': str(output), 'archive': archive(), 'sourceRefs': {}})
        self.assertEqual(list(output.iterdir()), [])
        self.assertEqual(self.workspace._reports, {})
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            with self.assertRaisesRegex(RuntimeError, '完整'):
                self.workspace.save_report({'outputPath': str(output), 'archive': archive(), 'sourceRefs': {}})
        self.assertEqual(list(output.iterdir()), [])

    def test_report_get_rejects_unregistered_traversal_added_files_symlink_and_directory_swap(self):
        result = self.save()
        prefix = result['indexUrl'].rsplit('/', 1)[0] + '/'
        for url in [REPORT_PREFIX + 'x' * 43 + '/index.html', prefix + '../archive.json',
                    prefix + '%2e%2e/archive.json', prefix + '%2fetc/passwd',
                    prefix + '.private/config.json', prefix + 'index.html?x=y',
                    prefix + 'unregistered.txt']:
            with self.subTest(url=url), self.assertRaises(FileNotFoundError):
                self.workspace.get_report(url)
        directory = Path(result['path'])
        (directory / 'unregistered.txt').write_text('not registered')
        with self.assertRaises(FileNotFoundError):
            self.workspace.get_report(prefix + 'unregistered.txt')
        (directory / 'index.html').unlink()
        (directory / 'index.html').symlink_to(self.file())
        with self.assertRaises(FileNotFoundError):
            self.workspace.get_report(result['indexUrl'])
        directory.rename(directory.with_name(directory.name + '-moved'))
        directory.mkdir()
        (directory / 'archive.json').write_text('substituted')
        with self.assertRaises(FileNotFoundError):
            self.workspace.get_report(prefix + 'archive.json')

    def test_save_rejects_cross_batch_refs_unsafe_ids_and_multiple_batches(self):
        state = archive()
        with self.assertRaisesRegex(ValueError, '以外'):
            self.save({'unknown': 'source'}, state)
        state['batches'].append(state['batches'][0])
        with self.assertRaisesRegex(ValueError, '选中批次'):
            self.save(state=state)
        state = archive()
        state['batches'][0]['papers'][0]['id'] = '../outside'
        with self.assertRaisesRegex(ValueError, '目录名称'):
            self.save(state=state)

    @unittest.skipUnless(shutil.which('node'), 'Node.js unavailable')
    def test_actual_offline_exporter_validates_without_model_call(self):
        # Real local exporter; no proxy/network process and no model responses.
        for filename in ['export_offline.cjs', 'index.html']:
            shutil.copy2(ROOT / filename, self.root / filename)
        result = self.workspace.save_report({'outputPath': str(self.base / '实际 离线导出'),
                                            'archive': archive(), 'sourceRefs': {}})
        directory = Path(result['path'])
        self.assertEqual(json.loads((directory / 'archive.json').read_text())['batches'][0]['runs'][0]['status'], 'pending')
        html = (directory / 'index.html').read_text()
        self.assertIn("connect-src 'none'", html)
        self.assertIn('PB_OFFLINE_ARCHIVE', html)
        self.assertIn('total_median_of_round_means', (directory / 'summary.csv').read_text())

    @unittest.skipUnless(EXISTING_PDF.is_file() and shutil.which('pdftotext') and shutil.which('node'),
                         'Existing user PDF/Poppler/Node unavailable; no fixture is fabricated')
    def test_existing_user_pdf_read_only_extract_and_complete_offline_report(self):
        before_bytes = EXISTING_PDF.read_bytes()
        before_stat = EXISTING_PDF.stat()
        result = self.workspace.read_paths({'paths': [str(EXISTING_PDF)]})
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['files']), 1)
        paper = result['files'][0]
        self.assertGreater(len(paper['text']), 10000)
        self.assertEqual(paper['sha256'], hashlib.sha256(before_bytes).hexdigest())
        self.assertEqual(paper['sourcePath'], str(EXISTING_PDF))
        self.assertTrue(any('文字索引与PDF原件一并发送' in warning for warning in paper['warnings']))
        for filename in ['export_offline.cjs', 'index.html']:
            shutil.copy2(ROOT / filename, self.root / filename)
        saved = self.workspace.save_report({'outputPath': str(self.base / '真实PDF 离线验证'),
                                           'archive': archive(paper['text']),
                                           'sourceRefs': {'p01': paper['sourceId']}})
        directory = Path(saved['path'])
        copied = directory / 'assets/prepared/p01/source.pdf'
        self.assertEqual(copied.read_bytes(), before_bytes)
        self.assertEqual((directory / 'assets/prepared/p01/paper_text.txt').read_text(), paper['text'])
        self.assertEqual((directory / 'assets/prepared/p01/review_text.txt').read_text(), paper['text'])
        metadata = json.loads((directory / 'source_metadata.json').read_text())
        self.assertTrue(metadata['sources'][0]['textMatchesSource'])
        self.assertTrue(metadata['reviewTexts'][0]['declaredHashMatchesText'])
        pdf_url = saved['indexUrl'].rsplit('/', 1)[0] + '/assets/prepared/p01/source.pdf'
        data, mime = self.workspace.get_report(pdf_url)
        self.assertEqual(data, before_bytes)
        self.assertEqual(mime, 'application/pdf')
        self.assertEqual(EXISTING_PDF.read_bytes(), before_bytes)
        self.assertEqual(EXISTING_PDF.stat().st_mtime_ns, before_stat.st_mtime_ns)


    def test_mineru_assets_preserve_markdown_relative_images_and_detect_changes(self):
        directory=self.base/'conversion';(directory/'outputs/source/hybrid_auto/images').mkdir(parents=True)
        md='# Converted document\n![figure](images/figure.png)\n\nEquation: $x=1$'
        (directory/'outputs/source/hybrid_auto/source.md').write_text(md)
        (directory/'outputs/source/hybrid_auto/images/figure.png').write_bytes(b'fake PNG asset')
        assets=[{'relativePath':str(p.relative_to(directory)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in directory.rglob('*') if p.is_file()]
        prep={'method':'mineru','conversionId':'test_conversion_01','pdfSha256':'a'*64,'markdownSha256':hashlib.sha256(md.encode()).hexdigest(),'markdownPath':str(directory/'outputs/source/hybrid_auto/source.md'),'conversionDir':str(directory),'version':'3.4.5'}
        record={'directory':str(directory),'assets':assets,'pdfSha256':prep['pdfSha256'],'markdownSha256':prep['markdownSha256']}
        self.workspace.mineru_registry=lambda key:record if key==prep['conversionId'] else None
        paper={'id':'p01','text':md,'preparation':prep};work=self.base/'report';work.mkdir()
        result=self.workspace._save_mineru_assets(paper,work)
        self.assertFalse(result['missingAssets'])
        copied=work/result['originalMarkdownAsset'];self.assertEqual(copied.read_text(),md)
        self.assertEqual((copied.parent/'images/figure.png').read_bytes(),b'fake PNG asset')
        self.assertEqual((work/result['markdownAsset']).read_text(),md)
        (directory/'outputs/source/hybrid_auto/images/figure.png').write_bytes(b'modified')
        with self.assertRaisesRegex(ValueError,'发生变化'):self.workspace._save_mineru_assets(paper,work)

    def test_mineru_missing_cache_preserves_exact_reviewed_md_without_reading_declared_path(self):
        md='Frozen markdown persists even without an active conversion session.'
        prep={'method':'mineru','conversionId':'expired_conversion','pdfSha256':'a'*64,'markdownSha256':hashlib.sha256(md.encode()).hexdigest(),'markdownPath':'/private/not-readable/source.md','conversionDir':'/private/not-readable','version':'3.4.5'}
        self.workspace.mineru_registry=lambda key:None
        work=self.base/'report';work.mkdir()
        result=self.workspace._save_mineru_assets({'id':'p01','text':md,'preparation':prep},work)
        self.assertTrue(result['missingAssets']);self.assertEqual((work/result['markdownAsset']).read_text(),md)
        with self.assertRaisesRegex(ValueError,'哈希'):self.workspace._save_mineru_assets({'id':'p02','text':md+'tampered','preparation':prep},work)


if __name__ == '__main__':
    unittest.main(verbosity=2)
