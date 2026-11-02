#!/bin/bash
# Normal launch sanity check: app must boot and stay alive with no errors.
set -u
cd "$(dirname "$0")/.." || exit 1
BIN="release/mac-arm64/Nub Agent.app/Contents/MacOS/Nub Agent"

"$BIN" >/tmp/maia-normal-launch.log 2>&1 &
sleep 6

PID=$(pgrep -f "Nub Agent.app/Contents/MacOS/Nub Agent" | head -1)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "NORMAL-LAUNCH: alive"
else
  echo "NORMAL-LAUNCH: DIED"
fi
echo "--- log (uncaught/EPIPE/error lines) ---"
grep -i "uncaught\|EPIPE\|error" /tmp/maia-normal-launch.log | head -5 || echo "(none)"

pkill -f "Nub Agent.app/Contents/MacOS/Nub Agent" 2>/dev/null
sleep 1
echo "done"
exit 0
