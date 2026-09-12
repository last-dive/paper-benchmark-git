"""Development-only bundler. Delivered index.html needs no build/runtime."""
from pathlib import Path
root = Path(__file__).parent
html = (root / 'template.html').read_text()
html = html.replace('/* INLINE_STYLE */', (root / 'style.css').read_text())
js = '\n;\n'.join(f'/* BEGIN {name} */\n' + (root / name).read_text() + f'\n/* END {name} */' for name in ['core.js', 'transport.js', 'app.js'])
if '</script' in js.lower():
    raise ValueError('Unexpected closing script tag in source')
html = html.replace('// INLINE_SCRIPT', js)
(root / 'index.html').write_text(html)
print(f'Built index.html: {len(html.encode()):,} bytes')
