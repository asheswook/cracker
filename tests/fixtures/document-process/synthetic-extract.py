"""Synthetic lifetime fixture; deliberately not a PDF/DOCX parser."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

signal.alarm(90)
config = Path(sys.argv[2])
mode = config.read_text().strip()
child = subprocess.Popen(["/usr/bin/python3", "-I", "-c", "import time; time.sleep(90)"])
report = config.with_suffix(".pids")
report.with_suffix(".new").write_text(json.dumps({
    "supervisor": os.getppid(), "extractor": os.getpid(), "descendant": child.pid,
}))
report.with_suffix(".new").rename(report)
while not config.with_suffix(".go").exists():
    time.sleep(0.02)
match mode:  # noqa: MATCH_OK — external open-string input; unknown modes exit 64.
    case "stdout":
        os.write(1, b"x" * 1250001)
    case "stderr":
        os.write(2, b"x" * 65537)
    case "hang":
        signal.pause()
    case _:
        sys.exit(64)
child.wait()
