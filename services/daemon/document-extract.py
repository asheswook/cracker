# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: python3 -I document-extract.py pdf|docx OWNED_INPUT
"""Extract bounded document text in a separately supervised, unprivileged process."""
import resource

# Apply before loading parsers. The service cgroup supplies aggregate limits.
resource.setrlimit(resource.RLIMIT_CPU, (2, 3))
resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))

import sys

if sys.platform == "linux":
    resource.setrlimit(resource.RLIMIT_AS, (134217728, 134217728))

import binascii
import json
import os
import re
import struct
import subprocess
import zipfile
import zlib
from pathlib import Path
from typing import Final, TypedDict
from xml.parsers import expat

MAX_XML: Final = 4 * 1024 * 1024
MAX_TEXT: Final = 200000
WORD: Final = "http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class Outcome(TypedDict):
    kind: str
    text: str | None
    truncated: bool
    code: str


class Rejected(Exception):
    """A terminal document condition with a public, content-free code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def bounded_text(text: str, truncated: bool = False) -> Outcome:
    encoded = text.replace("\0", "").encode("utf-16-le")
    clipped = encoded[:MAX_TEXT * 2].decode("utf-16-le", errors="ignore").strip()
    return {"kind": "complete", "text": clipped or None,
            "truncated": truncated or len(encoded) > MAX_TEXT * 2,
            "code": "text" if clipped else "empty"}


def command_output(argv: list[str], limit: int) -> tuple[bytes, bool, int]:
    """Bound pipe accumulation and reap the native parser on output overflow."""
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        if child.stdout is None:
            raise Rejected("parser_unavailable")
        chunks: list[bytes] = []
        length = 0
        while True:
            part = child.stdout.read(min(8192, limit + 1 - length))
            if not part:
                break
            chunks.append(part)
            length += len(part)
            if length > limit:
                child.kill()
                break
        return b"".join(chunks)[:limit], length > limit, child.wait()


def pdf(path: Path) -> Outcome:
    with path.open("rb") as source:
        if not source.read(1024).startswith(b"%PDF-"):
            raise Rejected("signature_mismatch")
    info, overflow, code = command_output(["pdfinfo", str(path)], 65536)
    if overflow:
        raise Rejected("resource_limit")
    if code != 0:
        raise Rejected("encrypted_or_malformed")
    page_match = re.search(rb"(?m)^Pages:\s+(\d+)\s*$", info)
    if page_match is None:
        raise Rejected("malformed")
    pages = int(page_match[1])
    output, overflow, code = command_output(
        ["pdftotext", "-f", "1", "-l", "100", "-enc", "UTF-8", "-nopgbrk", str(path), "-"],
        MAX_TEXT * 4)
    if code != 0 and not overflow:
        raise Rejected("resource_limit" if code < 0 else "malformed")
    return bounded_text(output.decode("utf-8", errors="replace"), overflow or pages > 100)


def main_xml(path: Path) -> bytes:
    """Inflate only the main part, checking actual length, stream end and CRC."""
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 512 or sum(item.file_size for item in entries) > 32 * 1024 * 1024:
            raise Rejected("resource_limit")
        names: set[str] = set()
        for item in entries:
            if item.filename in names or item.filename.startswith("/") or "\\" in item.filename or ".." in item.filename.split("/"):
                raise Rejected("malformed")
            names.add(item.filename)
            if item.flag_bits & 1:
                raise Rejected("encrypted")
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise Rejected("unsupported")
        entry = archive.getinfo("word/document.xml")
        if entry.file_size > MAX_XML:
            raise Rejected("resource_limit")
        with path.open("rb") as source:
            source.seek(entry.header_offset)
            header = source.read(30)
            if len(header) != 30 or header[:4] != b"PK\x03\x04":
                raise Rejected("malformed")
            name_length, extra_length = struct.unpack_from("<HH", header, 26)
            raw_name = source.read(name_length)
            if raw_name != b"word/document.xml" or struct.unpack_from("<H", header, 8)[0] != entry.compress_type:
                raise Rejected("malformed")
            source.seek(extra_length, os.SEEK_CUR)
            compressed = source.read(entry.compress_size)
        if entry.compress_type == zipfile.ZIP_DEFLATED:
            inflater = zlib.decompressobj(-15)
            data = inflater.decompress(compressed, MAX_XML + 1)
            if len(data) > MAX_XML or inflater.unconsumed_tail:
                raise Rejected("resource_limit")
            if not inflater.eof or inflater.unused_data:
                raise Rejected("malformed")
        elif entry.compress_type == zipfile.ZIP_STORED:
            data = compressed
        else:
            raise Rejected("unsupported")
        if len(data) > MAX_XML:
            raise Rejected("resource_limit")
        if len(data) != entry.file_size or binascii.crc32(data) != entry.CRC:
            raise Rejected("malformed")
        return data


def docx(path: Path) -> Outcome:
    data = main_xml(path)
    parser = expat.ParserCreate(namespace_separator="}")
    parts: list[str] = []
    length = 0
    text_depth = 0
    deleted_depth = 0

    def append(value: str) -> None:
        nonlocal length
        if length <= MAX_TEXT:
            parts.append(value[:MAX_TEXT + 1 - length])
            length += len(value)

    def start(name: str, _attrs: dict[str, str]) -> None:
        nonlocal text_depth, deleted_depth
        if name == WORD + "del":
            deleted_depth += 1
        if name == WORD + "t":
            text_depth += 1
        if not deleted_depth and name in (WORD + "tab", WORD + "br", WORD + "cr"):
            append("\t" if name == WORD + "tab" else "\n")

    def end(name: str) -> None:
        nonlocal text_depth, deleted_depth
        if name == WORD + "t":
            text_depth -= 1
        if not deleted_depth and name in (WORD + "p", WORD + "tc"):
            append("\n" if name == WORD + "p" else "\t")
        if name == WORD + "del":
            deleted_depth -= 1

    def characters(value: str) -> None:
        if text_depth and not deleted_depth:
            append(value)

    def doctype(_name: str, _system: str | None, _public: str | None, _internal: int) -> None:
        raise Rejected("unsupported")

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = characters
    parser.StartDoctypeDeclHandler = doctype
    parser.Parse(data, True)
    return bounded_text("".join(parts), length > MAX_TEXT)


def main() -> None:
    try:
        path = Path(sys.argv[2])
        if path.stat().st_size > 10 * 1024 * 1024:
            raise Rejected("input_limit")
        if sys.argv[1] not in ("pdf", "docx"):
            raise Rejected("unsupported")
        result = pdf(path) if sys.argv[1] == "pdf" else docx(path)
    except Rejected as error:
        result = {"kind": "complete", "text": None, "truncated": False, "code": error.code}
    except (zipfile.BadZipFile, expat.ExpatError, zlib.error, UnicodeError, ValueError):
        result = {"kind": "complete", "text": None, "truncated": False, "code": "malformed"}
    except MemoryError:
        result = {"kind": "complete", "text": None, "truncated": False, "code": "resource_limit"}
    except OSError:
        result = {"kind": "complete", "text": None, "truncated": False, "code": "parser_unavailable"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
