from pathlib import Path
import argparse, hashlib, json, shutil, tarfile
from source_guards import verify_core_metadata_extension
base = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--target-dist', type=Path, default=Path('/home/xx/chatgpt/paper_benchmark_codex/dist'))
args = ap.parse_args()
config = json.loads((base / 'build-config.json').read_text())
immutable = json.loads((base / 'immutable-source.json').read_text())
core_guard = verify_core_metadata_extension(Path(config['source']), immutable['baselineCoreHash'])
assert all(config[name] == value for name, value in core_guard.items()), 'Core changed after package build'
image = base / config['image']
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
smoke = json.loads((base / 'smoke-results.json').read_text())
assert smoke['appImageSHA256'] == sha(image) and smoke['actualPackagedCode'] and smoke['offlineReport']
assert smoke['mineruBridgePackaged'] and smoke['mineruHostEnvironmentIsolationMock'] and smoke['realMinerUCalls'] == 0
dist = base / 'delivery'
if dist.is_symlink():
    raise ValueError('delivery must not be a symlink')
if dist.exists():
    shutil.rmtree(dist)
dist.mkdir()
for name in [image.name, 'README_AppImage.md', 'bundle-manifest.json', 'source-manifest.json', 'immutable-source.json', 'smoke-results.json']:
    shutil.copy2(base / name, dist / name)
(dist / 'build-manifest.json').write_text(json.dumps({'version': config['version'], 'applicationCore': '2.4',
    'architecture': 'x86_64', 'buildOS': 'Ubuntu 22.04',
    'runtimeSource': 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64',
    'runtimeSHA256': sha(base / 'vendor/runtime-x86_64'), 'appImageSHA256': sha(image),
    'parser': 'PB-PARSER-2.4', 'scoringCoreBaselineVersion': '2.4.1', **core_guard,
    'scoringRuntimeByteIdentical': False, 'unchangedFiles': ['style.css'],
    'mineruHostEntry': '/home/xx/DS/MinerU/env.sh', 'mineruRuntimeBundled': False,
    'realMinerUCallsDuringPackaging': 0, 'realModelCallsDuringPackaging': 0}, indent=2) + '\n')
with tarfile.open(dist / 'packaging-source.tar.gz', 'w:gz') as tar:
    for name in ['packaging/launcher.py', 'packaging/build.py', 'packaging/smoke.py', 'packaging/host_environment_smoke.py',
                 'vendor/runtime-x86_64', 'README_AppImage.md', 'immutable-source.json', 'source_guards.py', 'prepare_delivery.py']:
        tar.add(base / name, arcname=name)
target = str(args.target_dist.expanduser().resolve() / image.name)
if any(c in target for c in ['"', '\n', '\r', '`', '$']):
    raise ValueError('unsupported launcher path')
(dist / 'paperbench-research.desktop').write_text('[Desktop Entry]\nType=Application\nName=Paperbench Research\nName[zh_CN]=论文评审工作台\nComment=PDF论文评审与离线学术报告\nExec="' + target + '" --appimage-extract-and-run\nIcon=paperbench-research\nCategories=Science;\nTerminal=false\nStartupNotify=false\n')
shutil.copy2(base / 'Paperbench.AppDir/paperbench.svg', dist / 'paperbench-research.svg')
(dist / 'SHA256SUMS').write_text(''.join(sha(p) + '  ' + p.name + '\n' for p in sorted(dist.iterdir()) if p.is_file() and p.name != 'SHA256SUMS'))
print(json.dumps({'preparedFiles': len(list(dist.iterdir())), 'version': config['version'], 'path': str(dist)}))
