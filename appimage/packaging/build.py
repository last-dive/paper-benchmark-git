"""Build a self-contained Ubuntu 22.04 x86_64 AppImage from an explicit app tree."""
from pathlib import Path
import argparse, hashlib, json, platform, re, shutil, subprocess, sys

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from source_guards import verify_core_metadata_extension
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument('--source', type=Path, required=True)
ap.add_argument('--version', default='2.5.0')
args = ap.parse_args()
source = args.source.expanduser().resolve()
immutable = json.loads((BASE / 'immutable-source.json').read_text())
core_guard = verify_core_metadata_extension(source, immutable['baselineCoreHash'])
for name, digest in immutable['files'].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != digest:
        ap.error('MinerU input-pipeline release must preserve this source byte-for-byte: ' + name)
    if name.endswith('.js'):
        match = re.search(r'/\* BEGIN ' + re.escape(name) + r' \*/\n(.*?)\n/\* END ' + re.escape(name) + r' \*/', (source / 'index.html').read_text(), re.S)
        if not match or match.group(1) != (source / name).read_text():
            ap.error('assembled HTML has different immutable source: ' + name)
    elif (source / name).read_text() not in (source / 'index.html').read_text():
        ap.error('assembled HTML omits the immutable stylesheet: ' + name)
if not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
    ap.error('version must be N.N.N')
if platform.machine() != 'x86_64':
    ap.error('this build targets x86_64')
files = ['index.html', 'export_offline.cjs', 'core.js', 'transport.js', 'start_local.py',
         'local_proxy.py', 'local_workspace.py', 'mineru_bridge.py', 'README.md']
for name in files:
    if not (source / name).is_file() or (source / name).is_symlink():
        ap.error('missing regular source file: ' + name)
APP = BASE / 'Paperbench.AppDir'
if APP.is_symlink():
    raise ValueError('AppDir must not be a symlink')
if APP.exists():
    shutil.rmtree(APP)
USR = APP / 'usr'
for rel in ['bin', 'lib', 'app']:
    (USR / rel).mkdir(parents=True)
for name in files:
    shutil.copy2(source / name, USR / 'app' / name)
shutil.copy2(BASE / 'packaging/launcher.py', USR / 'launcher.py')
(USR / 'package-version.json').write_text(json.dumps({'version': args.version, 'workVersion': '2.5.0'}))
shutil.copytree('/usr/lib/python3.10', USR / 'lib/python3.10',
                ignore=shutil.ignore_patterns('__pycache__', 'test', 'tests', 'config-*', 'sitecustomize.py'))
programs = {'python3': '/usr/bin/python3.10', 'node': shutil.which('node'),
            'pdftotext': '/usr/bin/pdftotext', 'pdfinfo': '/usr/bin/pdfinfo'}
elfs = []
for name, path in programs.items():
    if not path:
        raise ValueError('missing executable: ' + name)
    shutil.copy2(path, USR / 'bin' / (name + '.real'))
    elfs.append(Path(path))
    wrapper = '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
    if name == 'python3':
        wrapper += 'export PYTHONHOME="$base"\nexport PYTHONNOUSERSITE=1\n'
    wrapper += 'exec env LD_LIBRARY_PATH="$base/lib" "$base/bin/' + name + '.real" "$@"\n'
    p = USR / 'bin' / name
    p.write_text(wrapper)
    p.chmod(0o755)
elfs += list((USR / 'lib/python3.10/lib-dynload').glob('*.so'))
excluded = {'libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1',
            'libresolv.so.2', 'libutil.so.1', 'ld-linux-x86-64.so.2'}
for elf in elfs:
    out = subprocess.run(['ldd', str(elf)], capture_output=True, text=True, check=True).stdout
    for dep in re.findall(r'=> (/\S+)', out):
        p = Path(dep)
        if p.name not in excluded:
            shutil.copy2(p, USR / 'lib' / p.name)
shutil.copytree('/usr/share/poppler', USR / 'share/poppler')
licenses = USR / 'share/licenses'
licenses.mkdir(parents=True)
for pkg in ['python3.10', 'poppler-utils', 'libpoppler118', 'libssl3', 'libstdc++6',
            'libgcc-s1', 'libfreetype6', 'libfontconfig1', 'libjpeg-turbo8', 'libpng16-16',
            'libopenjp2-7', 'libtiff5', 'liblcms2-2', 'libnss3', 'libnspr4', 'libexpat1',
            'zlib1g', 'liblzma5', 'libbz2-1.0', 'libffi8', 'libsqlite3-0', 'libreadline8',
            'libtinfo6', 'libuuid1', 'libcrypt1', 'libgdbm6', 'libgdbm-compat4']:
    p = Path('/usr/share/doc') / pkg / 'copyright'
    if p.exists():
        shutil.copy2(p, licenses / (pkg + '.txt'))
node_license = Path(programs['node']).parent.parent / 'LICENSE'
if node_license.exists():
    shutil.copy2(node_license, licenses / 'node.txt')
(APP / 'AppRun').write_text('#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport POPPLER_DATADIR="$base/usr/share/poppler"\nexec "$base/usr/bin/python3" -s "$base/usr/launcher.py" "$@"\n')
(APP / 'AppRun').chmod(0o755)
(APP / 'paperbench.desktop').write_text('[Desktop Entry]\nType=Application\nName=Paperbench Research\nName[zh_CN]=论文评审工作台\nExec=AppRun\nIcon=paperbench\nCategories=Education;Science;\nTerminal=false\n')
(APP / 'paperbench.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="42" fill="#173849"/><path d="M62 42h92l40 40v132H62z" fill="#f4f0e6"/><path d="M154 42v40h40M84 110h86M84 132h86M84 154h55" fill="none" stroke="#173849" stroke-width="9"/><circle cx="171" cy="184" r="30" fill="#b6aa89"/><path d="m155 184 11 11 21-23" fill="none" stroke="#173849" stroke-width="7"/></svg>')
shutil.copy2(APP / 'paperbench.svg', APP / '.DirIcon')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {str(p.relative_to(APP)): sha(p) for p in APP.rglob('*') if p.is_file()}
(BASE / 'bundle-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(BASE / 'source-manifest.json').write_text(json.dumps({name: sha(source / name) for name in files}, indent=2) + '\n')
sq = BASE / 'payload.squashfs'
sq.unlink(missing_ok=True)
subprocess.run(['mksquashfs', str(APP), str(sq), '-noappend', '-comp', 'zstd', '-processors', '2', '-quiet'], check=True)
dest = BASE / ('Paperbench-Research-' + args.version + '-x86_64.AppImage')
with dest.open('wb') as f:
    f.write((BASE / 'vendor/runtime-x86_64').read_bytes())
    f.write(sq.read_bytes())
dest.chmod(0o755)
(BASE / 'build-config.json').write_text(json.dumps({'version': args.version, 'source': str(source), 'image': dest.name, **core_guard}, indent=2) + '\n')
print(json.dumps({'path': str(dest), 'bytes': dest.stat().st_size, 'sha256': sha(dest)}))
