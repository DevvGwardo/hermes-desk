#!/bin/bash
# Exercise the EPIPE guard: launch the packaged app with stdout/stderr going
# to a pipe whose read end closes immediately. Any startup console write then
# hits a broken pipe. With the guard the app must stay alive.
set -u
cd "$(dirname "$0")/.." || exit 1
BIN="release/mac-arm64/Nub Agent.app/Contents/MacOS/Nub Agent"
MARK="epipe-guard-$$"

# Launch with stderr piped into a reader that closes right away.
"$BIN" 2>&1 | { exec 0<&-; exec 1>&-; exec 2>&-; sleep 0.1; exit 0; } &

sleep 6

# Find the electron main process for this binary (ignore the dead reader).
PID=$(pgrep -f "Nub Agent.app/Contents/MacOS/Nub Agent" | head -1)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "PIPE-LAUNCH: electron pid $PID alive 6s after broken-pipe launch (guard works)"
  RESULT=alive
else
  echo "PIPE-LAUNCH: electron process NOT alive (guard may have failed)"
  RESULT=dead
fi

pkill -f "Nub Agent.app/Contents/MacOS/Nub Agent" 2>/dev/null
sleep 1
echo "cleaned up (result=$RESULT)"
exit 0
