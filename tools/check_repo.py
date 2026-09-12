#!/usr/bin/env python3
"""Check Git candidates, optional frozen-source hashes and local release assets.

This is a bounded pre-push check, not a guarantee that every possible secret is
detectable. It never prints matched values or sends data over the network.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = {'.private', 'output', 'backups', 'validation', 'local-snapshot',
             'dist', 'node_modules', '__pycache__', '.venv', 'venv'}
PATTERNS = {
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    'GitHub token': rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b',
    'API key prefix': rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b',
    'BigModel key shape': rb'\b[a-fA-F0-9]{32}\.[A-Za-z0-9]{12,}\b',
    'AWS access key': rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
}


def candidates():
    result = subprocess.run(['git', 'ls-files', '--cached', '--others',
                             '--exclude-standard', '-z'], cwd=ROOT,
                            check=True, stdout=subprocess.PIPE)
    return sorted(set(x.decode('utf-8') for x in result.stdout.split(b'\0') if x))


def ordinary(relative):
    path = ROOT / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT):
        raise ValueError('not a regular repository file: ' + relative)
    return path


def digest(path):
    with path.open('rb') as stream:
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def inspect_files(names, known_key=None):
    errors = []
    for name in names:
        path = Path(name)
        if (any(part in FORBIDDEN for part in path.parts)
                or path.name == 'model_config.json'
                or (path.name.startswith('.env') and path.name != '.env.example')
                or path.suffix.lower() in {'.pdf', '.appimage', '.log', '.pyc'}):
            errors.append('local-only file is in Git candidates: ' + name)
            continue
        try:
            file = ordinary(name)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if file.stat().st_size > 50 * 1024 * 1024:
            errors.append('large file should be a Release asset: ' + name)
            continue
        raw = file.read_bytes()
        for label, pattern in PATTERNS.items():
            if re.search(pattern, raw):
                errors.append(f'possible {label} (value hidden): {name}')
        if known_key and known_key in raw:
            errors.append('known local credential detected (value hidden): ' + name)
    return errors


def verify_snapshot():
    snapshot = json.loads((ROOT / 'SOURCE_SNAPSHOT.json').read_text())
    errors = []
    for name, expected in snapshot['applicationFiles'].items():
        if digest(ordinary(name)) != expected:
            errors.append('differs from original v2.5.0 snapshot: ' + name)
    return errors


def verify_release():
    snapshot = json.loads((ROOT / 'SOURCE_SNAPSHOT.json').read_text())
    image = snapshot['appImage']
    path = ordinary(image['path'])
    errors = []
    if path.stat().st_size != image['bytes'] or digest(path) != image['sha256']:
        errors.append('AppImage differs from the saved release')
    for sums in [ROOT / 'dist/SHA256SUMS',
                 ROOT / 'release/v2.5.0/RELEASE_SHA256SUMS']:
        for line in sums.read_text().splitlines():
            expected, name = line.split('  ', 1)
            if not re.fullmatch('[a-f0-9]{64}', expected) or Path(name).name != name:
                raise ValueError('invalid release checksum entry')
            if digest(ordinary('dist/' + name)) != expected:
                errors.append('release asset checksum mismatch: ' + name)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-snapshot', action='store_true')
    parser.add_argument('--check-release', action='store_true')
    parser.add_argument('--known-key-file', type=Path,
                        help='optional local profile for an exact credential check; never copied or printed')
    args = parser.parse_args()
    try:
        known_key = None
        if args.known_key_file:
            value = json.loads(args.known_key_file.read_text()).get('api_key')
            if not isinstance(value, str) or not value.strip():
                raise ValueError('local credential profile is empty or invalid')
            known_key = value.encode()
        names = candidates()
        errors = inspect_files(names, known_key)
        if args.verify_snapshot:
            errors += verify_snapshot()
        if args.check_release:
            errors += verify_release()
        if errors:
            for error in errors:
                print('ERROR:', error, file=sys.stderr)
            return 1
        print(json.dumps({'checkedGitCandidates': len(names), 'passed': True,
                          'originalSnapshotVerified': args.verify_snapshot,
                          'localReleaseVerified': args.check_release}))
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('Check could not complete; verify Git initialization, paths and JSON files.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
