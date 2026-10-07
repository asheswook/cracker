# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
# ─── How to run ───
# uv run --with pytest python -m pytest tests/test_journal_backup.py -v
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import threading
from contextlib import closing
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "backup-journal.py"


def invoke(operation: str, paths: tuple[Path, Path], timeout: str = "30") -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(CLI), operation, *(str(path) for path in paths), "--timeout", timeout]
    result = subprocess.run(command, capture_output=True, text=True, timeout=35, check=False)
    with (paths[1].parent / "cli-invocations.jsonl").open("a") as evidence:
        evidence.write(json.dumps({"command": command, "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}) + "\n")
    return result


@pytest.fixture
def journal(tmp_path: Path) -> Path:
    source = tmp_path / "source.sqlite"
    with closing(sqlite3.connect(source)) as db:
        for filename in ("journal.ts", "tool-observations.ts", "native-context-archive.ts"):
            text = (ROOT / "services" / "daemon" / filename).read_text()
            for sql in re.findall(r"CREATE TABLE IF NOT EXISTS [^\";]+", text):
                db.execute(sql)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("INSERT INTO runs VALUES('r','finished')")
        db.executemany("INSERT INTO actions(rowid,id,run,state,result) VALUES(?,?,?,?,?)", [(7, "a", "r", "completed", "result"), (42, "b", "r", "started", None), (90, "c", "r", "effect_unknown", None)])
        db.execute("INSERT INTO checkpoints VALUES('r','checkpoint',7)")
        db.execute("INSERT INTO outbox(rowid,id,event) VALUES(91,'e','private-event')")
        db.execute("INSERT INTO settings VALUES('private','SECRET_SENTINEL')")
        db.execute("CREATE TABLE extra(id INTEGER PRIMARY KEY, payload BLOB)")
        db.executemany("INSERT INTO extra(payload) VALUES(?)", [(b"x" * 1024 * 1024,)] * 8)
        db.commit()
    return source


def test_live_wal_backup_restores_exact_identity_with_source_absent(journal: Path, tmp_path: Path) -> None:
    # Given: active WAL writer and non-contiguous rowids / uncertain actions.
    stop = threading.Event()
    ready = threading.Event()
    writes: list[int] = []
    def writer() -> None:
        with closing(sqlite3.connect(journal)) as db:
            db.execute("PRAGMA wal_autocheckpoint=0")
            db.execute("INSERT INTO commands VALUES('wal-only')")
            db.commit()
            ready.set()
            while not stop.is_set():
                db.execute("INSERT INTO commands VALUES(?)", (f"c{len(writes)}",))
                db.commit()
                writes.append(1)
    thread = threading.Thread(target=writer)
    thread.start()
    assert ready.wait(5)
    assert Path(str(journal) + "-wal").stat().st_size > 0
    before = len(writes)
    # When: snapshot the live source, remove it, restore using only the bundle.
    try:
        result = invoke("backup", (journal, tmp_path / "bundle"))
    finally:
        stop.set()
        thread.join(5)
    assert result.returncode == 0, result.stderr
    assert len(writes) > before
    assert not thread.is_alive()
    journal.unlink()
    restored = invoke("verify", (tmp_path / "bundle", tmp_path / "restored"))
    # Then: preserved data includes WAL-only commit, exact states / watermarks / rowids.
    assert restored.returncode == 0, restored.stderr
    with closing(sqlite3.connect(tmp_path / "restored/journal.sqlite")) as db:
        assert db.execute("SELECT rowid,id,state,result FROM actions ORDER BY rowid").fetchall() == [(7, "a", "completed", "result"), (42, "b", "started", None), (90, "c", "effect_unknown", None)]
        assert db.execute("SELECT payload,watermark FROM checkpoints").fetchone() == ("checkpoint", 7)
        assert db.execute("SELECT rowid,id,event FROM outbox").fetchone() == (91, "e", "private-event")
        assert db.execute("SELECT id FROM commands WHERE id='wal-only'").fetchone() == ("wal-only",)
    for folder in (tmp_path / "bundle", tmp_path / "restored"):
        assert folder.stat().st_mode & 0o777 == 0o700
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in folder.iterdir())
    assert "SECRET_SENTINEL" not in result.stdout + result.stderr + (tmp_path / "bundle/manifest.json").read_text()
    (tmp_path / "concurrency.json").write_text(json.dumps({"commits_during_cli": len(writes) - before, "source_unavailable": not journal.exists(), "backup_stdout": result.stdout, "verify_stdout": restored.stdout}))


@pytest.mark.parametrize("damage", ["content", "rowid", "table", "corruption", "manifest"])
def test_verifier_rejects_changed_bundle(journal: Path, tmp_path: Path, damage: str) -> None:
    # Given: a complete backup with a damaged component.
    bundle = tmp_path / "bundle"
    assert invoke("backup", (journal, bundle)).returncode == 0
    dbpath = bundle / "journal.sqlite"
    if damage in {"content", "rowid", "table"}:
        with closing(sqlite3.connect(dbpath)) as db:
            sql = {"content": "UPDATE actions SET state='completed' WHERE id='b'", "rowid": "UPDATE actions SET rowid=100 WHERE id='b'", "table": "DROP TABLE checkpoints"}[damage]
            db.execute(sql)
            db.commit()
    if damage == "corruption":
        with dbpath.open("r+b") as stream:
            stream.write(b"NOT-SQLITE")
    if damage == "manifest":
        (bundle / "manifest.json").write_text("{}")
    if damage in {"content", "rowid", "table"}:
        metadata = json.loads((bundle / "manifest.json").read_text())
        metadata["database_sha256"] = hashlib.sha256(dbpath.read_bytes()).hexdigest()
        (bundle / "manifest.json").write_text(json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n")
    # When: verifying the tampered bundle.
    result = invoke("verify", (bundle, tmp_path / "restore"))
    # Then: no partial restore survives.
    assert result.returncode == 1
    assert not (tmp_path / "restore").exists()


@pytest.mark.parametrize("operation", ["backup", "verify"])
def test_existing_destination_is_preserved(journal: Path, tmp_path: Path, operation: str) -> None:
    # Given: a destination which must not be touched.
    target = tmp_path / "existing"
    target.mkdir()
    marker = target / "keep"
    marker.write_text("unchanged")
    # When: attempting either operation.
    result = invoke(operation, (journal, target))
    # Then: refuse before touching contents.
    assert result.returncode == 1
    assert marker.read_text() == "unchanged"


def test_deadline_removes_incomplete_bundle(journal: Path, tmp_path: Path) -> None:
    # Given / When: tiny deadline on a real multi-megabyte source.
    result = invoke("backup", (journal, tmp_path / "bundle"), "0.0001")
    # Then: bounded failure with no completed bundle or contents leaked.
    assert result.returncode == 1
    assert not (tmp_path / "bundle").exists()
    assert "SECRET_SENTINEL" not in result.stderr


def test_missing_source_is_not_created(tmp_path: Path) -> None:
    # Given / When: source path does not exist.
    source = tmp_path / "absent"
    result = invoke("backup", (source, tmp_path / "bundle"))
    # Then: read-only open fails without creating either artifact.
    assert result.returncode == 1
    assert not source.exists()
    assert not (tmp_path / "bundle").exists()


def test_locked_source_fails_within_deadline(journal: Path, tmp_path: Path) -> None:
    # Given: a real exclusive lock that prevents source reads.
    with closing(sqlite3.connect(journal)) as lock:
        lock.execute("PRAGMA journal_mode=DELETE")
        lock.execute("BEGIN EXCLUSIVE")
        # When: backup under a bounded deadline.
        result = invoke("backup", (journal, tmp_path / "bundle"), "0.2")
        # Then: fail closed and retain no incomplete output.
        assert result.returncode == 1
        assert not (tmp_path / "bundle").exists()


def test_backup_rejects_missing_required_table(journal: Path, tmp_path: Path) -> None:
    # Given: structurally valid SQLite missing a required journal table.
    with closing(sqlite3.connect(journal)) as db:
        db.execute("DROP TABLE actions")
        db.commit()
    # When: trying to certify it as a journal backup.
    result = invoke("backup", (journal, tmp_path / "bundle"))
    # Then: missing state cannot silently become a valid backup.
    assert result.returncode == 1
    assert json.loads(result.stderr)["error"] == "required_tables_missing"
    assert not (tmp_path / "bundle").exists()
