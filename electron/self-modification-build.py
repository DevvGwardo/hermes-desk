"""Trusted resource entry point. Only main supplies argv; never model/renderer."""
import json
import os
import resource
import signal
import sys

data = json.loads(sys.stdin.buffer.read(20000))
seconds = data["seconds"]
if type(seconds) is not int or not 1 <= seconds <= 230:
    raise RuntimeError("Invalid independent build deadline")
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
hard = resource.getrlimit(resource.RLIMIT_NPROC)[1]
maximum = data["processLimit"] if hard == resource.RLIM_INFINITY else min(data["processLimit"], hard)
resource.setrlimit(resource.RLIMIT_NPROC, (maximum, maximum))
os.umask(0o077)
# exec preserves the timer with the default terminating SIGALRM disposition.
signal.signal(signal.SIGALRM, signal.SIG_DFL)
signal.alarm(seconds)
os.execv(data["node"], [data["node"], *data["args"]])
