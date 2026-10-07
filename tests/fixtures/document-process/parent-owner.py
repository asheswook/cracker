"""A disposable parent using the real supervisor's exact ownership contract."""
import os
import signal
import subprocess
import sys

signal.alarm(90)
child = subprocess.Popen(["/usr/bin/python3", "-I", sys.argv[1], str(os.getpid()),
                          "/usr/bin/python3", "-I", sys.argv[2], "pdf", sys.argv[3]])
child.wait()
