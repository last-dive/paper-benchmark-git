#!/usr/bin/env python3
"""Create an explicitly synthetic text PDF for offline package smoke tests."""
import argparse
from pathlib import Path


def make_pdf():
    lines = ["PAPERBENCH SYNTHETIC TEST FIXTURE - NOT A RESEARCH PAPER"]
    lines += [f"Section {i:02d}: Synthetic material for parser and offline export tests only."
              for i in range(1, 37)]
    content = b"BT /F1 11 Tf 40 800 Td 18 TL\n"
    for line in lines:
        content += ("(" + line + ") Tj T*\n").encode("ascii")
    content += b"ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
    ]
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    target = parser.parse_args().path
    with target.open("xb") as stream:
        stream.write(make_pdf())
    print("Created synthetic PDF:", target)
