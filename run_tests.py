#!/usr/bin/env python3
"""Run the shipped tests against code extracted from the delivered single HTML.

Requires Python 3 and Node.js 20+. Uses only built-in libraries.
Model calls are mocked; proxy tests bind temporary loopback ports only.
"""
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parent
    node = shutil.which("node")
    if not node:
        raise SystemExit("测试需要 Node.js 20+；日常打开 index.html 不需要 Node.js。")
    html = (root / "index.html").read_text(encoding="utf-8")
    tests = root / "tests"
    if not tests.is_dir():
        tests = root  # source workspace convenience
    with tempfile.TemporaryDirectory(prefix="paperbench-test-") as temp:
        out = Path(temp)
        for name in ("core.js", "transport.js", "app.js"):
            match = re.search(r"/\* BEGIN " + re.escape(name) + r" \*/\n(.*?)\n/\* END " + re.escape(name) + r" \*/", html, re.S)
            if not match:
                raise SystemExit("HTML中未找到模块：" + name)
            (out / name).write_text(match.group(1), encoding="utf-8")
            subprocess.run([node, "--check", str(out / name)], check=True)
        template = (root / "template.html").read_text(encoding="utf-8")
        style = (root / "style.css").read_text(encoding="utf-8")
        joined = '\n;\n'.join(f'/* BEGIN {name} */\n' + (out / name).read_text() + f'\n/* END {name} */' for name in ("core.js", "transport.js", "app.js"))
        if template.replace('/* INLINE_STYLE */', style).replace('// INLINE_SCRIPT', joined) != html:
            raise SystemExit("模板与实际交付HTML不一致，请重新assemble。")
        (out / "template.html").write_text(template, encoding="utf-8")
        (out / "style.css").write_text(style, encoding="utf-8")
        (out / "index.html").write_text(html, encoding="utf-8")
        for name in ("core.test.cjs", "core_v2.test.cjs", "source_catalog.test.cjs", "source_transport.test.cjs", "direct_sources.test.cjs", "robust_validation.test.cjs", "v2_fixture.cjs", "transport.test.cjs", "app.test.cjs", "multimodal_runner.test.cjs", "offline_v2.test.cjs", "proxy_test.py", "local_server_test.py", "local_gateway_test.py", "local_workspace_test.py", "mineru_test.py", "workflow_smoke_test.py"):
            shutil.copy2(tests / name, out / name)
        for file in ("local_proxy.py", "start_local.py", "configure_local.py", "multimodal_runner.cjs", "export_offline.cjs", "local_workspace.py", "mineru_bridge.py"):
            shutil.copy2(root / file, out / file)
        for name in ("core.test.cjs", "core_v2.test.cjs", "source_catalog.test.cjs", "source_transport.test.cjs", "direct_sources.test.cjs", "robust_validation.test.cjs", "transport.test.cjs", "app.test.cjs", "multimodal_runner.test.cjs", "offline_v2.test.cjs"):
            subprocess.run([node, str(out / name)], check=True, cwd=out)
        for file in ("proxy_test.py", "local_server_test.py", "local_gateway_test.py", "local_workspace_test.py", "mineru_test.py", "workflow_smoke_test.py"):
            subprocess.run([sys.executable, str(out / file)], check=True, cwd=out)
    print("全部验证通过。测试未调用真实模型；未执行浏览器视觉测试。")


if __name__ == "__main__":
    main()
