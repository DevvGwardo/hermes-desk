#!/bin/bash
# Kill any running instance, relaunch the packaged app fresh.
set -u
pkill -f "Nub Agent.app/Contents/MacOS/Nub Agent" 2>/dev/null
sleep 1
open "$(dirname "$0")/../release/mac-arm64/Nub Agent.app"
sleep 5
PID=$(pgrep -f "Nub Agent.app/Contents/MacOS/Nub Agent" | head -1)
if [ -n "$PID" ]; then echo "relaunched, pid $PID"; else echo "NOT running"; fi
exit 0
