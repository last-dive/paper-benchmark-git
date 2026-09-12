"""Verify the only allowed core extension against the installed 2.4.1 bytes."""
from pathlib import Path
import hashlib
import re


def verify_core_metadata_extension(source: Path, baseline_hash: str) -> dict:
    data = (source / 'core.js').read_bytes()
    begin, end = b'// BEGIN MINERU_ARCHIVE_METADATA', b'// END MINERU_ARCHIVE_METADATA'
    if data.count(begin) != 1 or data.count(end) != 1:
        raise ValueError('Expected exactly one MinerU archive metadata block in core.js')
    pattern = rb'^[ \t]*// BEGIN MINERU_ARCHIVE_METADATA\n.*?^[ \t]*// END MINERU_ARCHIVE_METADATA\n'
    matches = list(re.finditer(pattern, data, flags=re.M | re.S))
    if len(matches) != 1:
        raise ValueError('MinerU core markers must occupy full LF-terminated lines')
    block = matches[0]
    stripped = data[:block.start()] + data[block.end():]
    sha = lambda payload: hashlib.sha256(payload).hexdigest()
    if sha(stripped) != baseline_hash:
        raise ValueError('core.js differs from the installed baseline outside the metadata block')
    html = (source / 'index.html').read_bytes()
    embedded = re.findall(rb'/\* BEGIN core\.js \*/\n(.*?)\n/\* END core\.js \*/', html, flags=re.S)
    if len(embedded) != 1 or embedded[0] != data:
        raise ValueError('Assembled HTML must contain exactly the same extended core.js bytes')
    return {'baselineCoreHash': baseline_hash, 'coreSHA256': sha(data),
            'coreMetadataBlockSHA256': sha(block.group()),
            'scoringAlgorithmsUnchanged': True, 'coreMetadataExtended': True}
