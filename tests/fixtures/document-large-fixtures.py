# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: python3 -I tests/fixtures/document-large-fixtures.py PRIVATE_OUTPUT_DIRECTORY
import re
import sys
import zipfile
from pathlib import Path

destination = Path(sys.argv[1])
ordinary = Path("tests/fixtures/documents/ordinary.pdf").read_bytes()
offset = ordinary.index(b"\nxref\n") + 1
for name, size in (("large-binary", 700000), ("near-limit", 9 * 1024 * 1024)):
    padding = b"%" + b"p" * size + b"\n"
    pdf = ordinary[:offset] + padding + ordinary[offset:]
    pdf = re.sub(rb"startxref\s+\d+", b"startxref\n" + str(offset + len(padding)).encode(), pdf)
    (destination / (name + ".pdf")).write_bytes(pdf)
    token = "LARGEDOCXBODYTOKEN" if name == "large-binary" else "NEARLIMITDOCXTOKEN"
    with zipfile.ZipFile(destination / (name + ".docx"), "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + token + '</w:t></w:r></w:p></w:body></w:document>')
        archive.writestr("word/media/inert.bin", bytes(size))
(destination / "oversized.docx").write_bytes(bytes(10 * 1024 * 1024 + 1))

def text_pdf(pages: int, lines: int) -> bytes:
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids: list[str] = []
    for page in range(pages):
        number = len(objects) + 1
        kids.append(f"{number} 0 R")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {number + 1} 0 R >>".encode())
        token = "PREFIXTOKEN" if page < 100 else "AFTERLIMITTOKEN"
        line = "(" + token + " " + "word " * 16 + ") Tj 0 -12 Td\n"
        content = ("BT /F1 6 Tf 20 760 Td\n" + line * lines + "ET").encode()
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {pages} >>".encode()
    output = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, item in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + item + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
    for value in offsets:
        output.extend(f"{value:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)

(destination / "long-text.pdf").write_bytes(text_pdf(60, 50))
(destination / "many-pages-text.pdf").write_bytes(text_pdf(101, 1))
