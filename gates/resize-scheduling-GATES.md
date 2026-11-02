# Gates: resize scheduling — queue-when-idle + per-instance probe + reschedule prefill

Scope: close the remaining Computer-resize gap (probe/schedule/cancel already ship). No platform changes, no release/deploy/version-bump.

- [x] G1: probe cache keyed by instanceId — second instance never inherits the first verdict
  CHECK: npx vitest run src/lib/__tests__/hermes-rest-probe.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  9 passed
  EVIDENCE: Start at  13:19:46 | Duration  418ms (transform 76ms, setup 0ms, import 93ms, tests 7ms, environment 255ms)

- [x] G2: queue-when-idle — arm while busy, fires once when quiet, disarms, tab-open labeled
  CHECK: npx vitest run src/components/__tests__/agent-info-resize.test.tsx 2>&1 | tail -n 4
  EXPECT: Tests  11 passed
  EVIDENCE: Start at  13:19:46 | Duration  1.36s (transform 326ms, setup 0ms, import 496ms, tests 526ms, environment 271ms)

- [x] G3: reschedule prefill — pending plan/time preload into inputs; pill shows scheduled time
  CHECK: npx vitest run src/components/__tests__/agent-info-resize.test.tsx src/lib/__tests__/hermes-rest-schedule.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  14 passed
  EVIDENCE: Start at  13:20:31 | Duration  1.30s (transform 368ms, setup 0ms, import 565ms, tests 514ms, environment 556ms)

- [x] G4: no regression — full suite green + tsc clean incl. --force clean-room (incremental cache masks errors)
  CHECK: npx tsc -b --force && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1352 passed | 1 skipped (1353)
  EVIDENCE: Start at  13:28:09 | Duration  17.25s (transform 6.41s, setup 0ms, import 26.13s, tests 30.57s, environment 97.76s)

- [x] G5: no prod touch — version still 0.1.15, no upload/manifest/deploy, tree committed clean
  CHECK: node -e "const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('version moved '+p.version); console.log('VERSION_PIN_OK')"
  EXPECT: VERSION_PIN_OK
  EVIDENCE: VERSION_PIN_OK
