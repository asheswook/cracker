"""Watch Linux pidfds independently of JavaScript and release the owned X11 inputs."""
from contextlib import ExitStack
import fcntl
import hashlib
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys


def release_inputs() -> None:
    """Run the shared verifier without inheriting caller output pipes."""
    helper = Path(__file__).with_name("desktop-release.py")
    subprocess.run([sys.executable, "-I", str(helper)], check=True, timeout=3,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    """Hold the display lease until the worker group is dead and inputs are released."""
    release_only = sys.argv[1:] == ["--release"]
    parent_pid, worker_pid = (0, 0) if release_only else (int(value) for value in sys.argv[1:3])
    if not release_only and (parent_pid <= 1 or worker_pid <= 1 or not hasattr(os, "pidfd_open")):
        return 1
    display = os.environ.get("DISPLAY", "")
    lock_name = hashlib.sha256(display.encode()).hexdigest()[:24]
    lock_path = f"/tmp/assistant-desktop-{os.getuid()}-{lock_name}.lock"
    with ExitStack() as resources:
        lock = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        resources.callback(os.close, lock)
        info = os.fstat(lock)
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
            return 1
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if release_only:
            release_inputs()
            os.write(sys.stdout.fileno(), b'{"ready": true}\n{"released": true}\n')
            return 0
        parent = os.pidfd_open(parent_pid)
        resources.callback(os.close, parent)
        worker = os.pidfd_open(worker_pid)
        resources.callback(os.close, worker)
        # Startup reset is protected by the display lease and precedes all model actions.
        release_inputs()
        parent_lost = False
        try:
            os.write(sys.stdout.fileno(), b'{"ready": true}\n')
        except BrokenPipeError:
            parent_lost = True
        if not parent_lost:
            select.select([parent, worker], [], [])
        termination_failed = False
        try:
            os.killpg(worker_pid, signal.SIGKILL)
        except ProcessLookupError:
            # A group with no remaining members is already terminated.
            group_missing = True
        except OSError:
            group_missing = False
            termination_failed = True
        else:
            group_missing = False
        exited, _, _ = select.select([worker], [], [], 1)
        if not exited and not group_missing:
            termination_failed = True
        release_inputs()
        if termination_failed:
            return 1
        try:
            os.write(sys.stdout.fileno(), b'{"released": true}\n')
        except BrokenPipeError:
            # Cleanup remains successful after parent death; no receiver remains.
            return 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Fixed diagnostics only: never emit environment, argv, paths or input contents.
        print('{"guardian_failed":true}', file=sys.stderr, flush=True)
        sys.exit(1)
