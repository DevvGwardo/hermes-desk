# Gates: web app status report (maiavm-desktop hosted web client)

Scope: a verified status report of the hosted web app (Vercel project agent-nub-lol, build:web path) — live state, deployment currency, build/test health at HEAD — with every number measured, not recalled.

- [x] G1: Production web URL is identified from repo + Vercel account evidence
  CHECK: grep -o '"projectName":"[^"]*"' .vercel/project.json
  EXPECT: /agent-nub-lol/
  EVIDENCE: "projectName":"agent-nub-lol"

- [x] G2: Production web app responds live
  CHECK: curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://agent-nub-lol.vercel.app
  EXPECT: 200
  EVIDENCE: 200

- [x] G3: Hosted web build passes from current HEAD (typecheck + vite --mode web)
  CHECK: npm run build:web 2>&1 | tail -3
  EXPECT: /built in/
  EVIDENCE: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit. | ✓ built in 7.21s

- [x] G4: Full test suite at HEAD matches the documented baseline (1211/1213; the 2 failures are the pre-existing sandbox-only fs-guard EPERM symlink tests, electron/fs-guard.test.mjs)
  CHECK: npx vitest run 2>&1 | grep -E "Test Files|Tests " 
  EXPECT: /Tests.*2 failed.*1211 passed/
  EVIDENCE: Test Files  1 failed | 144 passed (145) | Tests  2 failed | 1211 passed (1213)

- [x] G5: Deployment currency — live index.html asset hash vs fresh local build, plus live last-modified date
  CHECK: bash -c 'LIVE=$(curl -s --max-time 15 https://agent-nub-lol.vercel.app | grep -o "assets/index-[A-Za-z0-9_-]*\.js" | head -1); LOCAL=$(grep -o "assets/index-[A-Za-z0-9_-]*\.js" dist/index.html | head -1); [ "$LIVE" != "$LOCAL" ] && echo "STALE live=$LIVE local=$LOCAL" || echo CURRENT'
  EXPECT: /STALE|CURRENT/
  EVIDENCE: STALE live=assets/index-BqP7NGF4.js local=assets/index-DN4U15P1.js

- [x] G6: Working tree has no uncommitted changes except this gates ledger itself
  CHECK: bash -c 'N=$(git status --short | grep -v "webapp-status-2026-08-29" | wc -l | tr -d " "); echo NON_GATES_DIRTY=$N'
  EXPECT: /NON_GATES_DIRTY=0/
  EVIDENCE: NON_GATES_DIRTY=0

- [x] G7: Report numbers re-measured at report time (non-test source files, test files, dist assets)
  CHECK: bash -c 'echo SRC_NONTEST=$(find src electron -name "*.ts" -o -name "*.tsx" -o -name "*.mjs" -o -name "*.cjs" | grep -v "\.test\." | wc -l | tr -d " ") TEST_FILES=$(find src electron -name "*.test.*" | wc -l | tr -d " ") DIST_ASSETS=$(ls dist/assets | wc -l | tr -d " ")'
  EXPECT: /SRC_NONTEST=\d+ TEST_FILES=\d+ DIST_ASSETS=\d+/
  EVIDENCE: SRC_NONTEST=191 TEST_FILES=142 DIST_ASSETS=18
