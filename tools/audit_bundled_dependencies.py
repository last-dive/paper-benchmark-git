#!/usr/bin/env python3
"""Audit an already extracted Paperbench AppImage without executing its contents.

Example (extract with unsquashfs -o 944632 -d /tmp/pb-audit IMAGE first):
  python3 tools/audit_bundled_dependencies.py --repo . --extracted /tmp/pb-audit \
    --node-release-dir /tmp/paperbench-node-audit --output /tmp/pb-notices

The output is additive: copy its third_party/* into the repository after review.
No network operations or app execution occur. Node metadata is read from the
separately verified official release binary using its process.versions API only.
The optional downloaded dependency files must be from the URLs recorded below.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from urllib.parse import quote


def digest(data, algorithm='sha256'):
    return hashlib.new(algorithm, data).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--extracted', type=Path, required=True)
    parser.add_argument('--node-release-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, help='Explicitly write additive artifacts here; omitted means audit only with temporary output.')
    args = parser.parse_args()
    scratch = tempfile.TemporaryDirectory(prefix='pb-notice-audit-') if args.output is None else None
    repo, bundle = args.repo.resolve(), args.extracted.resolve()
    out = args.output.resolve() if args.output else Path(scratch.name)
    tp = out / 'third_party'
    tp.mkdir(parents=True, exist_ok=True)
    old = repo / 'third_party'
    image = repo / 'dist/Paperbench-Research-2.5.0-x86_64.AppImage'
    image_hash = digest(image.read_bytes())
    expected_image_hash = '3af2201381c87a18e46eba301a11e4ec3f5ec942877a7f8ca8746d9f3a2df94b'
    assert image_hash == expected_image_hash, 'Unexpected AppImage: this audit targets the preserved 2.5.0 artifact.'
    manifest_path = repo / 'release/v2.5.0/bundle-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    bundle_files = {str(p.relative_to(bundle)): p for p in bundle.rglob('*') if p.is_file()}
    assert set(bundle_files) == set(manifest), 'Extracted member set differs from release manifest.'
    assert all(digest(p.read_bytes()) == manifest[rel] for rel, p in bundle_files.items()), 'Extracted member hash mismatch.'
    metadata = {}
    fields = ['package', 'version', 'source_package', 'source_version', 'homepage']
    fmt = '${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Homepage}\n'
    for line in run('dpkg-query', '-W', '-f=' + fmt).splitlines():
        values = line.split('\t')
        metadata[values[0]] = dict(zip(fields, values))
    owners = collections.defaultdict(set)
    md5sums = {}
    for path in Path('/var/lib/dpkg/info').glob('*.list'):
        for line in path.read_text().splitlines():
            owners[line].add(path.name[:-5])
    for path in Path('/var/lib/dpkg/info').glob('*.md5sums'):
        md5sums[path.name[:-8]] = {line[34:]: line[:32] for line in path.read_text().splitlines() if len(line) > 34}

    def aliases(path):
        values = [str(path), str(path.resolve())]
        return list(dict.fromkeys(values + [x[4:] for x in values if x.startswith('/usr/lib/')]))

    def ownership(path):
        al = aliases(path)
        rows = []
        for pkg in sorted(set(pkg for alias in al for pkg in owners.get(alias, []))):
            meta = metadata.get(pkg, metadata.get(pkg + ':amd64', {}))
            if not meta:
                continue
            expected = next((md5sums.get(pkg, {}).get(x.lstrip('/')) for x in al if md5sums.get(pkg, {}).get(x.lstrip('/'))), None)
            actual = digest(path.read_bytes(), 'md5')
            rows.append({'package': meta, 'dpkg_expected_md5': expected, 'actual_md5': actual,
                         'dpkg_payload_verified': expected == actual if expected else None})
        return sorted(rows, key=lambda r: r['dpkg_payload_verified'] is not True)

    release_dir = args.node_release_dir.resolve()
    release_name = 'node-v24.14.0-linux-x64'
    archive = release_dir / (release_name + '.tar.xz')
    checksums = release_dir / 'SHASUMS256.txt'
    expected_archive_hash = next(line.split()[0] for line in checksums.read_text().splitlines() if line.endswith(archive.name))
    assert expected_archive_hash == '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df'
    assert digest(archive.read_bytes()) == expected_archive_hash
    with tarfile.open(archive) as tar:
        node_bytes = tar.extractfile(release_name + '/bin/node').read()
        node_license = tar.extractfile(release_name + '/LICENSE').read()
        node_config = tar.extractfile(release_name + '/include/node/config.gypi').read()
    assert node_bytes == bundle_files['usr/bin/node.real'].read_bytes()
    assert node_license == (old / 'bundled-notices/node.txt').read_bytes()
    host_node = Path('/home/xx/.nvm/versions/node/v24.14.0/bin/node')
    assert node_bytes == host_node.read_bytes()
    node_versions = json.loads(run(str(host_node), '-p', 'JSON.stringify(process.versions)'))
    records, package_files, generated = [], collections.defaultdict(list), []
    notices, application_files = [], []
    for rel, path in sorted(bundle_files.items()):
        data = path.read_bytes()
        elf = data[:4] == b'\x7fELF'
        if rel.startswith('usr/share/licenses/'):
            notices.append(rel)
            continue
        if not (elf or rel.startswith('usr/lib/python3.10/') or rel.startswith('usr/share/poppler/')):
            application_files.append(rel)
            continue
        record = {'path': rel, 'bytes': len(data), 'sha256': digest(data), 'kind': 'ELF' if elf else 'data-or-Python-source'}
        if elf:
            dynamic = run('readelf', '-d', str(path))
            record['needed'] = re.findall(r'\(NEEDED\).*?\[(.*?)\]', dynamic)
            notes = run('readelf', '-n', str(path))
            record['build_ids'] = re.findall(r'Build ID: (\w+)', notes)
        candidates = [Path('/' + rel)]
        if rel.startswith('usr/lib/') and not rel.startswith('usr/lib/python'):
            candidates = [Path('/usr/lib/x86_64-linux-gnu') / path.name, Path('/lib/x86_64-linux-gnu') / path.name]
        elif rel == 'usr/bin/python3.real':
            candidates = [Path('/usr/bin/python3.10')]
        elif rel.endswith('.real'):
            candidates = [Path('/' + rel[:-5])]
        if rel == 'usr/bin/node.real':
            record.update({'component': 'node', 'version': node_versions['node'], 'identity': 'official-release-byte-identical',
                           'upstream_archive': 'https://nodejs.org/dist/v24.14.0/' + archive.name,
                           'notice_path': 'third_party/bundled-notices/node.txt'})
            records.append(record)
            continue
        matches = []
        for candidate in candidates:
            if not candidate.is_file() or digest(candidate.read_bytes()) != record['sha256']:
                continue
            for owner in ownership(candidate) or [{}]:
                matches.append({'host_path': str(candidate), 'resolved_host_path': str(candidate.resolve()), **owner})
        assert matches, 'No byte-identical local source for ' + rel
        matches.sort(key=lambda r: (r.get('dpkg_payload_verified') is not True, not bool(r.get('package')), r['host_path']))
        match = matches[0]
        if match.get('package'):
            assert match['dpkg_payload_verified'], 'Unverified dpkg package payload: ' + rel
            meta = match.pop('package')
            package_files[meta['package']].append(rel)
            record.update({'component': meta['package'], 'version': meta['version'], 'identity': 'dpkg-payload-byte-identical',
                           'host_match': match})
        else:
            assert path.name == '.uuid' and rel.startswith('usr/share/poppler/cMap/'), 'Unmapped non-package member: ' + rel
            record.update({'component': 'generated-poppler-directory-uuid', 'identity': 'host-byte-identical-unowned-generated-data',
                           'host_match': match, 'note': '36-character UUID directory metadata, not an additional software library; no dpkg owner.'})
            generated.append(rel)
        records.append(record)
    supplemental_inventory = []

    def save(relative, data, source):
        path = out / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        supplemental_inventory.append({'path': relative, 'bytes': len(data), 'sha256': digest(data), 'source': source})

    packages = []
    common_references = collections.defaultdict(set)
    for pkg, paths in sorted(package_files.items()):
        meta = metadata[pkg]
        name = pkg.split(':')[0]
        copyright_file = Path('/usr/share/doc') / name / 'copyright'
        data = copyright_file.read_bytes()
        doc_owners = ownership(copyright_file)
        assert doc_owners and doc_owners[0]['dpkg_payload_verified'], 'Copyright file does not match dpkg: ' + pkg
        old_notice = old / 'bundled-notices' / (name + '.txt')
        notice_rel = 'third_party/' + ('bundled-notices/' if old_notice.exists() else 'supplemental-notices/') + name + '.txt'
        if old_notice.exists():
            assert old_notice.read_bytes() == data, 'Existing preserved notice differs from verified package notice: ' + pkg
        else:
            save(notice_rel, data, {'kind': 'verified-dpkg-copyright', 'path': str(copyright_file),
                                   'resolved_path': str(copyright_file.resolve()), 'owners': doc_owners,
                                   'matched_bundled_package': pkg, 'matched_package_version': meta['version']})
        text = data.decode('utf-8')
        labels = list(dict.fromkeys(re.findall(r'^License: (\S.{0,59})$', text, re.M))) if text.startswith(('Format:', 'Format-Specification:')) else []
        upstream = re.search(r'^Source: (\S+)', text, re.M)
        upstream_name = re.search(r'^Upstream-Name: (.+)', text, re.M)
        metadata_entry = dict(meta)
        metadata_entry.update({'upstream_name': upstream_name.group(1) if upstream_name else meta['source_package'],
                               'source_url_in_notice': upstream.group(1) if upstream else None,
                               'ubuntu_source_version_url': 'https://launchpad.net/ubuntu/+source/' + quote(meta['source_package'], safe='') + '/' + quote(meta['source_version'], safe=''),
                               'notice_path': notice_rel, 'notice_sha256': digest(data), 'notice_provenance': doc_owners,
                               'notice_license_labels_verbatim': labels, 'bundled_file_count': len(paths),
                               'bundled_files': paths, 'corresponding_source_archive_in_repository': False})
        packages.append(metadata_entry)
        for ref in re.findall(r'/usr/share/common-licenses/([A-Za-z0-9_.+-]+)', text):
            common_references[ref.rstrip('.')].add(notice_rel)
        for record in records:
            if record.get('component') == pkg:
                record['notice_path'] = notice_rel
    for name, references in sorted(common_references.items()):
        common = old / 'common-licenses' / name
        assert common.is_file(), 'Missing referenced common license: ' + name
        assert common.read_bytes() == (Path('/usr/share/common-licenses') / name).read_bytes()
    save('third_party/node-dependency-licenses/SHASUMS256-v24.14.0.txt', checksums.read_bytes(),
         {'kind': 'official-upstream-release-checksum-list', 'url': 'https://nodejs.org/dist/v24.14.0/SHASUMS256.txt'})
    save('third_party/node-dependency-licenses/config-v24.14.0.gypi', node_config,
         {'kind': 'verified-official-release-member', 'url': 'https://nodejs.org/dist/v24.14.0/' + archive.name,
          'archive_sha256': expected_archive_hash, 'member': release_name + '/include/node/config.gypi'})
    pinned_source_hashes = {'deps_nbytes_LICENSE': '782ab5b8ae1540c1a2b102fdd00990ed268d4a3a98e90ad7fe724b489d7bb0f2', 'deps_nbytes_README.md': '2b8bc2cca5b61333567dacb3056533e2c644b40e63f82d3c286f4df1b4a9c98a', 'deps_ncrypto_README.md': 'eac7f233d33572e73765164256a7c92c207099722d59bd32c0e5e3a82b0ce292', 'deps_sqlite_sqlite3.c': 'f7d8b32e48849494f13851e13e659d70ef372c5d207b84bc71c05d1e62716305'}
    for name, expected_hash in pinned_source_hashes.items():
        assert digest((release_dir / name).read_bytes()) == expected_hash, 'Pinned upstream source mismatch: ' + name
    for name in ['deps_nbytes_LICENSE', 'deps_nbytes_README.md', 'deps_ncrypto_README.md']:
        source_path = name.replace('deps_nbytes_', 'deps/nbytes/').replace('deps_ncrypto_', 'deps/ncrypto/')
        save('third_party/node-dependency-licenses/' + name.replace('_', '-', 2), (release_dir / name).read_bytes(),
             {'kind': 'official-pinned-node-source', 'url': 'https://raw.githubusercontent.com/nodejs/node/v24.14.0/' + source_path,
              'node_tag': 'v24.14.0'})
    sqlite_source = (release_dir / 'deps_sqlite_sqlite3.c').read_bytes()
    sqlite_lines = sqlite_source.decode().splitlines(keepends=True)
    # Preserve both the exact version header and the first embedded public-domain notice.
    sqlite_notice = ''.join(sqlite_lines[:24] + sqlite_lines[31:42]).encode()
    assert b'author disclaims copyright' in sqlite_notice
    save('third_party/node-dependency-licenses/sqlite-PUBLIC-DOMAIN.txt', sqlite_notice,
         {'kind': 'verbatim-upstream-source-notice-excerpt', 'url': 'https://raw.githubusercontent.com/nodejs/node/v24.14.0/deps/sqlite/sqlite3.c',
          'source_sha256': digest(sqlite_source), 'source_line_ranges': [[1, 24], [32, 42]], 'version': node_versions['sqlite']})
    sections = [{'name': match.group(1), 'source_path': match.group(2),
                 'notice_start_line': node_license[:match.start()].count(b'\n') + 1}
                for match in re.finditer(rb'^- (.*?), located at (.*?), is licensed as follows:', node_license, re.M)]
    sections = [{k: v.decode() if isinstance(v, bytes) else v for k, v in entry.items()} for entry in sections]
    provided = {Path(r['path']).name for r in records if r['kind'] == 'ELF' and r['path'].startswith('usr/lib/') and '/python' not in r['path']}
    outside_needed = sorted({needed for r in records for needed in r.get('needed', [])} - provided)
    counts = {'appimage_members_verified': len(manifest), 'audited_third_party_files': len(records),
              'elf_files': sum(r['kind'] == 'ELF' for r in records),
              'dpkg_verified_elf_files': sum(r['kind'] == 'ELF' and r['identity'] == 'dpkg-payload-byte-identical' for r in records),
              'dpkg_verified_all_files': sum(r['identity'] == 'dpkg-payload-byte-identical' for r in records),
              'dpkg_binary_packages': len(packages), 'dpkg_source_packages': len({p['source_package'] for p in packages}),
              'supplemental_package_notices': sum(x['path'].startswith('third_party/supplemental-notices/') for x in supplemental_inventory),
              'preserved_bundled_notices': len(notices), 'node_official_release_verified_elf_files': 1,
              'node_upstream_license_component_sections': len(sections), 'unowned_generated_uuid_files': len(generated),
              'unmapped_elf_files': 0, 'referenced_common_license_names_verified': len(common_references)}
    report = {'schema_version': 1, 'application_version': '2.5.0', 'audit_date': '2026-09-13',
              'appimage_sha256': image_hash, 'manifest_sha256': digest(manifest_path.read_bytes()), 'counts': counts,
              'method': ['Extracted members are checked against all 1,043 SHA256 values in the preserved manifest.',
                         'Every ELF is identified by file magic; readelf inspects metadata without executing it.',
                         'dpkg binary/source versions are accepted only after matching bundled SHA256 and dpkg-recorded payload MD5.',
                         'Package copyright notices also match recorded dpkg payload MD5; symlink ownership is retained.',
                         'Node binary and LICENSE match the official release archive whose SHA256 matches the official HTTPS checksum list; signatures were not separately verified.'],
              'scope': 'Attribution, notices, package identity and source-version pointers; not a complete corresponding-source archive or a legal compliance certification.',
              'packages': packages, 'files': records,
              'node': {'version': node_versions['node'], 'process_versions': node_versions,
                       'archive_url': 'https://nodejs.org/dist/v24.14.0/' + archive.name, 'archive_sha256': expected_archive_hash,
                       'checksum_list_sha256': digest(checksums.read_bytes()), 'binary_sha256': digest(node_bytes),
                       'license_sha256': digest(node_license), 'notice_path': 'third_party/bundled-notices/node.txt',
                       'source_tag_url': 'https://github.com/nodejs/node/tree/v24.14.0',
                       'upstream_license_component_sections': sections,
                       'section_scope': 'The complete upstream LICENSE includes source, build and test components. A section alone does not prove the component is linked into this binary.',
                       'additional_notices': ['third_party/node-dependency-licenses/deps-nbytes-LICENSE', 'third_party/node-dependency-licenses/sqlite-PUBLIC-DOMAIN.txt'],
                       'ncrypto_scope': 'Node LICENSE states it applies to all parts not externally maintained. The pinned ncrypto README describes code extracted from Node.js core; no separate ncrypto LICENSE is supplied at the tested standard paths.'},
              'host_loader_sonames_not_bundled': outside_needed,
              'generated_data_without_package_owner': generated,
              'historical_notice_packages_not_individually_present': ['libgdbm-compat4', 'python3.10'],
              'common_license_references': {k: sorted(v) for k, v in sorted(common_references.items())},
              'excluded_application_and_packaging_files': application_files,
              'remaining_limits': ['No complete third-party corresponding-source packages or reproducible dependency build archive are included.',
                                   'Ubuntu source-version URLs are derived from verified local dpkg metadata; remote archive bytes were not downloaded or verified.',
                                   'AppImage runtime static dependencies are audited separately in runtime-components.json.',
                                   'Five copied .uuid metadata files have no dpkg owner; they match the build host exactly and are not software libraries.',
                                   'Host glibc/loader, MinerU, CUDA, GPU drivers and model weights are outside this AppImage payload.']}
    (tp / 'bundled-components.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    (tp / 'SUPPLEMENTAL_INVENTORY.json').write_text(json.dumps({'schema_version': 1, 'audit_date': '2026-09-13',
        'preserved_appimage_sha256': image_hash, 'scope': 'New supplemental notices and evidence; original INVENTORY.json remains unchanged.',
        'files': supplemental_inventory}, indent=2, ensure_ascii=False) + '\n')
    lines = ['# AppImage 2.5.0 实际内含组件与致谢', '',
             '感谢下列项目的作者、贡献者及 Ubuntu/Debian 维护者。第三方组件继续按各自原始许可证授权；本项目自有代码的非商业条款不改变第三方权利。', '',
             f'核验对象 SHA256：`{image_hash}`。本表来自实际提取文件，逐一匹配原发布清单；完整逐文件记录、版本和版权来源见 [bundled-components.json](bundled-components.json)。', '',
             f'共核验 **{counts["appimage_members_verified"]}** 个包内文件；其中 **98 个 ELF**（47 个独立动态库、47 个 Python 扩展、4 个程序）。97 个 ELF 与本机 dpkg 登记的包文件完全一致，另 1 个 Node.js 与官方发行包完全一致。', '',
             f'共 **{len(packages)} 个 Ubuntu 二进制包 / {counts["dpkg_source_packages"]} 个源码包系列**，覆盖 990 个包文件；另有 Node.js 与 5 个生成的目录 UUID 文件。保留原 28 份说明，补充 **23 份包版权说明**。', '',
             '版本列是准确匹配包文件后的 Ubuntu 包版本，可能含发行版修订号。版权原文保留全部作者和按文件划分的条款；其中也可能讨论源码树的测试、文档或打包脚本，不能把原文中出现的每一项许可都套用于每个二进制。', '',
             '| 项目 / 上游 | Ubuntu 二进制包 | 包版本 | 包内文件数 | 版权及许可原文 |',
             '| --- | --- | --- | ---: | --- |']
    for p in packages:
        url = p['homepage'] or p['source_url_in_notice']
        title = p['upstream_name'] if p['upstream_name'] != 'package' else p['source_package']
        project = f'[{title}]({url})' if url else title
        notice = p['notice_path'].removeprefix('third_party/')
        lines.append(f'| {project} | `{p["package"]}` | `{p["version"]}` | {p["bundled_file_count"]} | [原文]({notice}) |')
    lines += ['', '每个包的准确源码版本及 Ubuntu 对应源码页面均列在 JSON 中。本仓库未收集完整的第三方对应源码包；复制版权文件和给出源码页面不等同于履行所有再分发条件。', '',
              '## Node.js 及其内含组件', '',
              'Node.js **24.14.0** 的程序字节及完整 [LICENSE](bundled-notices/node.txt) 均与 [官方 linux-x64 发行包](https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-x64.tar.xz) 一致；归档 SHA256 已对照官方 HTTPS 校验和清单核验。未单独验证签名。', '',
              '实际 Node.js 运行时报告的组件版本如下（`modules`、`napi` 是 ABI 编号，未列为库；CLDR、时区和 Unicode 属 ICU 数据）。', '',
              '| 组件 | 版本 |', '| --- | --- |']
    for key, value in node_versions.items():
        if key not in ('node', 'modules', 'napi'):
            lines.append(f'| {key} | `{value}` |')
    lines += ['', '补充 [nbytes MIT 许可证](node-dependency-licenses/deps-nbytes-LICENSE) 与 [SQLite 公有领域声明](node-dependency-licenses/sqlite-PUBLIC-DOMAIN.txt)。ncrypto 从 Node.js 核心提取，见[该固定版本说明](node-dependency-licenses/deps-ncrypto-README.md)及 Node.js 原始 LICENSE 的适用范围。', '',
              '完整 Node.js LICENSE 含 **44 个组件条目**，以下逐项致谢；其中包含构建和测试依赖，条目本身不证明它们全部链接进此二进制。', '',
              '| 上游组件 | 上游源码位置 | 版权原文起始行 |', '| --- | --- | ---: |']
    for section in sections:
        lines.append(f'| {section["name"]} | `{section["source_path"]}` | [第 {section["notice_start_line"]} 行](bundled-notices/node.txt#L{section["notice_start_line"]}) |')
    lines += ['', '## 其他范围说明', '',
              '- AppImage 静态运行时及其依赖见 [runtime-components.json](runtime-components.json) 和 [appimage-runtime/LICENSE](appimage-runtime/LICENSE)。',
              '- Python 标准库、其扩展模块、Poppler CMap / 字符映射数据都已纳入文件与版权核验。',
              '- 5 个 `.uuid` 是复制进来的目录 UUID 元数据，无 dpkg 包归属；已记录其内容哈希及来源，不将它们作为额外软件库。',
              '- 原 `libgdbm-compat4.txt` 与 `python3.10.txt` 作为历史打包材料继续保留；实际库/解释器文件按表内真实包名归属。',
              '- 宿主系统提供的 glibc、动态加载器，以及外部 MinerU、Conda、CUDA、GPU 驱动、模型权重不在这个 AppImage 内。',
              '- 原 [INVENTORY.json](INVENTORY.json) 保持不变；新增材料来源和哈希见 [SUPPLEMENTAL_INVENTORY.json](SUPPLEMENTAL_INVENTORY.json)。', '']
    (tp / 'BUNDLED_DEPENDENCIES.md').write_text('\n'.join(lines))
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    if scratch:
        scratch.cleanup()
        print('Audit passed; no repository or durable output files changed.')
    else:
        print('Wrote additive audit output:', out)


if __name__ == '__main__':
    main()
