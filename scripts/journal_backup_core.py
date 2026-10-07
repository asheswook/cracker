# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# ─── How to run ───
# Imported by: python3 scripts/backup-journal.py --help
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final, assert_never

REQUIRED: Final = frozenset({"checkpoints", "actions", "runs", "outbox", "commands", "settings", "memory_jobs", "rejected_events", "tool_observations", "native_context_archive"})
type_cell = str | bytes | int | float | None


class BackupError(Exception):
    """A stable diagnostic code, never database contents or paths."""


@dataclass(frozen=True, slots=True)
class TableDigest:
    name: str
    rows: int
    sha256: str


@dataclass(frozen=True, slots=True)
class Snapshot:
    schema_sha256: str
    user_version: int
    application_id: int
    tables: tuple[TableDigest, ...]


@dataclass(frozen=True, slots=True)
class Deadline:
    expires: float

    def check(self) -> None:
        if time.monotonic() >= self.expires:
            raise BackupError("deadline_exceeded")

    def progress(self, status: int, remaining: int, total: int) -> None:
        self.check()

    def query_progress(self) -> int:
        return int(time.monotonic() >= self.expires)


def encode_cell(value: type_cell) -> tuple[str, str]:
    match value:
        case None:
            return ("null", "")
        case bytes():
            return ("blob", value.hex())
        case str():
            return ("text", value)
        case int():
            return ("integer", str(value))
        case float():
            return ("real", value.hex())
        case unreachable:
            assert_never(unreachable)


def encode_row(row: tuple[type_cell, ...]) -> bytes:
    return json.dumps([encode_cell(cell) for cell in row], ensure_ascii=True, separators=(",", ":")).encode("ascii")


def identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def connect_readonly(path: Path, deadline: Deadline) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.1)
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    db.set_progress_handler(deadline.query_progress, 1000)
    return db


def snapshot(db: sqlite3.Connection, deadline: Deadline) -> Snapshot:
    """Hash schema and typed values, including identity-bearing hidden rowids."""
    deadline.check()
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise BackupError("integrity_failed")
    schema = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name,sql").fetchall()
    names = {row[1] for row in schema if row[0] == "table"}
    if not REQUIRED <= names:
        raise BackupError("required_tables_missing")
    table_flags = {row[1]: row[4] for row in db.execute("PRAGMA table_list") if row[0] == "main"}
    tables = []
    for name in sorted(names):
        columns = {row[1].lower() for row in db.execute(f"PRAGMA table_xinfo({identifier(name)})")}
        prefix = ""
        if not table_flags.get(name, 0):
            aliases = [alias for alias in ("rowid", "_rowid_", "oid") if alias not in columns]
            if not aliases:
                raise BackupError("shadowed_rowid_unsupported")
            prefix = aliases[0] + ","
        hashes = []
        for row in db.execute(f"SELECT {prefix}* FROM {identifier(name)}"):
            deadline.check()
            hashes.append(hashlib.sha256(encode_row(row)).digest())
        tables.append(TableDigest(name, len(hashes), hashlib.sha256(b"".join(sorted(hashes))).hexdigest()))
    schema_hash = hashlib.sha256(b"\n".join(encode_row(row) for row in schema)).hexdigest()
    return Snapshot(schema_hash, db.execute("PRAGMA user_version").fetchone()[0], db.execute("PRAGMA application_id").fetchone()[0], tuple(tables))


def file_hash(path: Path, deadline: Deadline) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            deadline.check()
            digest.update(chunk)
    return digest.hexdigest()


def manifest(value: Snapshot, path: Path, deadline: Deadline) -> bytes:
    """Canonical metadata includes no journal values or source location."""
    return (json.dumps({"format": 1, "database_sha256": file_hash(path, deadline), "snapshot": asdict(value)}, sort_keys=True, separators=(",", ":")) + "\n").encode()
