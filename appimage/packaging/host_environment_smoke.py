"""Exercise packaged host_environment with a fake host script, without GPU/API work."""
from pathlib import Path
import json
import os
import pwd
import subprocess
import sys

bundle_app, scratch = map(Path, sys.argv[1:])
sys.path.insert(0, str(bundle_app))
from mineru_bridge import host_environment
import mineru_bridge
assert Path(mineru_bridge.__file__).resolve() == (bundle_app / 'mineru_bridge.py').resolve()

poison = {
    'APPIMAGE': '/synthetic/AppImage',
    'APPDIR': '/synthetic/AppDir',
    'PYTHONHOME': '/synthetic/python',
    'PYTHONPATH': '/synthetic/python/path',
    'PYTHONNOUSERSITE': '1',
    'LD_LIBRARY_PATH': '/synthetic/libs',
    'LD_PRELOAD': '/synthetic/preload.so',
    'POPPLER_DATADIR': '/synthetic/poppler',
    'CUDA_VISIBLE_DEVICES': 'unselected-device',
    'CONDA_PREFIX': '/synthetic/conda',
    'VIRTUAL_ENV': '/synthetic/venv',
    'OPENAI_API_KEY': 'synthetic-key-that-must-not-reach-host',
    'ZHIPUAI_API_KEY': 'synthetic-key-that-must-not-reach-host',
    'BASH_ENV': '/synthetic/injected-shell-init',
    'ENV': '/synthetic/injected-shell-init',
    'PATH': '/synthetic/AppDir/usr/bin',
    'HOME': '/synthetic/home',
}
os.environ.update(poison)
gpu = 0
clean = host_environment(gpu)
for name in poison:
    if name not in {'PATH', 'HOME', 'CUDA_VISIBLE_DEVICES'}:
        assert name not in clean, 'Leaked host variable: ' + name
assert clean['HOME'] == pwd.getpwuid(os.getuid()).pw_dir
assert clean['CUDA_VISIBLE_DEVICES'] == str(gpu)
assert '/synthetic/' not in clean['PATH']
assert '/usr/bin' in clean['PATH'].split(':')
assert str(bundle_app.parent / 'bin') not in clean['PATH'].split(':')

script = scratch / 'fake-mineru-env.sh'
script.write_text('#!/bin/bash\nset -eu\nexec /usr/bin/python3 -c '\
                  "'import json, os, sys; print(json.dumps({\"env\": dict(os.environ), \"python\": sys.executable}))'\n")
result = subprocess.run(['/bin/bash', '--noprofile', '--norc', str(script)],
                        env=clean, cwd=scratch, capture_output=True, text=True,
                        check=True, timeout=15)
observed = json.loads(result.stdout)
for name in poison:
    if name not in {'PATH', 'HOME', 'CUDA_VISIBLE_DEVICES'}:
        assert name not in observed['env'], 'Host process inherited: ' + name
assert observed['python'] == '/usr/bin/python3'
assert observed['env']['CUDA_VISIBLE_DEVICES'] == str(gpu)
print(json.dumps({'bridgeModule': str(Path(mineru_bridge.__file__).resolve()), 'hostEnvironmentIsolated': True,
                  'fakeHostCommand': True, 'realMinerUCalls': 0, 'realModelCalls': 0}))
