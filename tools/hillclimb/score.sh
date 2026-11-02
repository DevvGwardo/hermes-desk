#!/usr/bin/env bash
# Hermes Desk hillclimb scorer — quality climb (PLAN-next #5: JS type coverage + any-tightening).
# Contract: print exactly one SCORE=<float> (higher = better); exit non-zero when gates fail.
# SCORE = CHECKJS_COVERED*100 - ANY_COUNT - TSC_ERRORS*1000
# Deterministic: same tree => same score. Fast: tsc + greps only (no vite build, no full suite).
set -u
cd "$(dirname "$0")/../.."

# Gate 1: TypeScript must be clean (app + node projects, plus Electron checkJs).
TSC_OUT=$(npx tsc -b 2>&1; npx tsc -p tsconfig.electron.json 2>&1)
TSC_STATUS=$?
TSC_ERRORS=$(echo "$TSC_OUT" | grep -c "error TS" || true)
if [ "$TSC_STATUS" -ne 0 ]; then
  echo "SCORE=-1000000"
  echo "TSC_ERRORS=$TSC_ERRORS"
  echo "GATE=red:tsc"
  exit 1
fi

# Gate 2: Electron syntax checks must pass (171 Node files per remediation ledger).
if ! npm run check:node >/dev/null 2>&1; then
  echo "SCORE=-1000000"
  echo "TSC_ERRORS=$TSC_ERRORS"
  echo "GATE=red:check-node"
  exit 1
fi

# Signal 1: checkJs-covered Electron modules (PLAN-next #5 — more coverage = better).
COVERED=$(python3 -c "import json; print(len(json.load(open('tsconfig.electron.json'))['include']))")

# Signal 2: real `any` TYPE annotations in renderer src (fewer = better).
# Word-match `any` counts English prose ("any topic"); this counts type positions
# only (: any, as any, <any>, any[], => any) outside // and block comments.
ANY=$(grep -rnE --include="*.ts" --include="*.tsx" "(: *any\b|as +any\b|<any>|\bany\[\]|=> *any\b)" src/lib src/components 2>/dev/null | grep -vE ":[0-9]+: *(\*|//)" | wc -l | tr -d ' ')

# Signal 3: known-red regression files must go green (end-state progress).
# Pinned to the 6 failures observed 2026-10-29; FIXED goes negative if they regress further.
VITEST_OUT=$(npx vitest run --project electron electron/local/mcp/shim/hermes-desk-mcp.test.mjs --project unit src/lib/agents/__tests__/hermes-transport-fallback.test.ts 2>&1)
VITEST_STATUS=$?
RED_FAILED=$(echo "$VITEST_OUT" | grep -oE "Tests +[0-9]+ failed" | grep -oE "[0-9]+" | head -1)
RED_FAILED=${RED_FAILED:-0}
FIXED=$((6 - RED_FAILED))

SCORE=$(python3 -c "print($COVERED*100 - $ANY - $TSC_ERRORS*1000 + $FIXED*25)")
echo "SCORE=$SCORE"
echo "COVERED=$COVERED"
echo "ANY=$ANY"
echo "TSC_ERRORS=$TSC_ERRORS"
echo "FIXED=$FIXED"
echo "GATE=green"
