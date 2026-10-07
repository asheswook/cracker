#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# ─── How to run ───
# python3 scripts/backup-journal.py backup SOURCE.sqlite NEW_BUNDLE --timeout 60
# python3 scripts/backup-journal.py verify BUNDLE NEW_RESTORE --timeout 60
# Optional uv: uv run scripts/backup-journal.py --help
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path
from types import FrameType

from journal_backup_core import BackupError, Deadline, connect_readonly, manifest, snapshot


def interrupted(signum: int, frame: FrameType | None) -> None:
    raise BackupError("interrupted_or_deadline")


def private_write(path: Path, data: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def backup(source: Path, destination: Path, deadline: Deadline) -> bytes:
    target = destination / "journal.sqlite"
    private_write(target, b"")
    with closing(connect_readonly(source, deadline)) as origin, closing(sqlite3.connect(target, timeout=0.1)) as output:
        origin.execute("BEGIN")
        expected = snapshot(origin, deadline)
        origin.backup(output, pages=128, progress=deadline.progress, sleep=0.01)
        output.execute("PRAGMA journal_mode=DELETE")
        output.set_progress_handler(deadline.query_progress, 1000)
        if snapshot(output, deadline) != expected:
            raise BackupError("snapshot_mismatch")
    return manifest(expected, target, deadline)


def verify(bundle: Path, destination: Path, deadline: Deadline) -> bytes:
    """Restore solely from the portable bundle; never open the original source."""
    source = bundle / "journal.sqlite"
    if any(Path(str(source) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise BackupError("bundle_has_sidecars")
    expected = (bundle / "manifest.json").read_bytes()
    target = destination / "journal.sqlite"
    with source.open("rb") as origin, target.open("xb") as output:
        while chunk := origin.read(1024 * 1024):
            deadline.check()
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    with closing(connect_readonly(target, deadline)) as restored:
        actual = manifest(snapshot(restored, deadline), target, deadline)
    if actual != expected:
        raise BackupError("manifest_mismatch")
    return actual


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline-safe journal bundle backup / isolated restore verification; never starts the daemon.")
    parser.add_argument("operation", choices=("backup", "verify"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, help="New directory; existing paths are refused")
    parser.add_argument("--timeout", type=float, default=60.0, help="Total deadline in seconds (0 < seconds <= 3600)")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 3600:
        parser.error("timeout must be finite and in (0, 3600]")
    os.umask(0o077)
    deadline = Deadline(time.monotonic() + args.timeout)
    created = False
    completed = False
    try:
        for event in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            signal.signal(event, interrupted)
        signal.setitimer(signal.ITIMER_REAL, args.timeout)
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM, signal.SIGALRM})
        try:
            args.destination.mkdir(mode=0o700)
            created = True
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        operation = {"backup": backup, "verify": verify}[args.operation]
        metadata = operation(args.source, args.destination, deadline)
        private_write(args.destination / "manifest.json", metadata)
        with (args.destination / "journal.sqlite").open("rb") as stream:
            os.fsync(stream.fileno())
        directory_fd = os.open(args.destination, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        deadline.check()
        completed = True
        print(json.dumps({"ok": True, "operation": args.operation}))
        return 0
    except (BackupError, OSError, sqlite3.Error) as error:
        code = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(json.dumps({"ok": False, "error": code}), file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if created and not completed:
            shutil.rmtree(args.destination)


if __name__ == "__main__":
    sys.exit(main())
