# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# How to run: python3 -I shell-supervisor.py PARENT_PID PROGRAM [ARGS...]
"""Keep a Linux command group bounded by the daemon's lifetime using pidfds."""
from contextlib import ExitStack
import os
import select
import signal
import subprocess
import sys
from types import FrameType


def main() -> int:
    """Watch parent and command exit without polling or inherited secret access."""
    parent_pid = int(sys.argv[1])
    with ExitStack() as resources:
        parent = os.pidfd_open(parent_pid)
        resources.callback(os.close, parent)
        if select.select([parent], [], [], 0)[0]:
            return 125
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        child = subprocess.Popen(sys.argv[2:], start_new_session=True,
                                 preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, blocked))
        resources.callback(child.wait)

        def send(kind: int) -> None:
            try:
                os.killpg(child.pid, kind)
            except ProcessLookupError:
                return

        def forward(kind: int, _frame: FrameType | None) -> None:
            send(signal.SIGKILL if kind == signal.SIGTERM else kind)

        # Cleanup also covers errors opening the child pidfd or waiting for it.
        resources.callback(send, signal.SIGKILL)
        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
        worker = os.pidfd_open(child.pid)
        resources.callback(os.close, worker)
        ready, _, _ = select.select([parent, worker], [], [])
        send(signal.SIGKILL)
        code = child.wait()
        return 125 if parent in ready else (128 - code if code < 0 else code)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        print("shell_supervisor_failed", file=sys.stderr, flush=True)
        sys.exit(125)
