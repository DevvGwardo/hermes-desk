# Gates: test-only hardening batch (Wave 2, zero prod touch)

Scope: pin D-10/D-11/D-07 behaviorally + budget/collision/manifest/orphan coverage — TEST FILES ONLY, no release/deploy/version-bump

- [x] G1: electron/security-invariants.test.mjs extended (D-07 hatch matrix, D-10 file_paths parse, D-11 web-mode pin, D-08 preload behavioral) + file passes
  CHECK: npx vitest run electron/security-invariants.test.mjs 2>&1 | tail -n 4
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: Start at  08:11:11 | Duration  352ms (transform 17ms, setup 0ms, import 24ms, tests 8ms, environment 255ms)

- [x] G2: src/lib/__tests__/bundle-budget.test.ts exists (builds to /tmp only, never dist/) + passes
  CHECK: npx vitest run src/lib/__tests__/bundle-budget.test.ts 2>&1 | tail -n 4
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: Start at  08:11:12 | Duration  8.04s (transform 17ms, setup 0ms, import 25ms, tests 7.69s, environment 259ms)

- [x] G3: search-index + routines collision/tz expectations pinned + both files pass
  CHECK: npx vitest run src/lib/__tests__/search-index.test.ts src/lib/__tests__/routines.test.ts 2>&1 | tail -n 4
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: Start at  08:11:21 | Duration  415ms (transform 98ms, setup 0ms, import 120ms, tests 21ms, environment 542ms)

- [x] G4: electron/update-manifest-keys.test.mjs exists (compareVersions edges; winArm64 gap NOTED, never pinned as correct) + passes
  CHECK: npx vitest run electron/update-manifest-keys.test.mjs 2>&1 | tail -n 4
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: Start at  08:11:21 | Duration  339ms (transform 12ms, setup 0ms, import 17ms, tests 2ms, environment 256ms)

- [x] G5: orphan+429 detector (scripts/probe-orphan-runs.mjs + src/lib/__tests__/orphan-probe.test.ts) exists + passes
  CHECK: npx vitest run src/lib/__tests__/orphan-probe.test.ts 2>&1 | tail -n 4
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: Start at  08:11:22 | Duration  355ms (transform 18ms, setup 0ms, import 24ms, tests 2ms, environment 265ms)

- [x] G6: full suite green + tsc clean (count re-measured at report time)
  CHECK: npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1325 passed | 1 skipped (1326)
  EVIDENCE: Start at  08:13:34 | Duration  23.58s (transform 7.12s, setup 0ms, import 34.48s, tests 42.26s, environment 138.49s)

- [x] G7: zero prod touch — every changed/tracked-new file is test, gate, plan, or probe-script
  CHECK: node -e "const{execSync}=require('child_process'); const files=(execSync('git status --porcelain',{encoding:'utf8'})+execSync('git diff --name-only HEAD',{encoding:'utf8'})).split('\n').map(s=>s.trim().replace(/^[AM?]+\s+/,'')).filter(Boolean); const ok=files.every(f=>/(__tests__|\.test\.|probe-orphan-runs|d07-d11|next-|PLAN-next)/.test(f)); if(!ok) throw new Error('prod touched: '+files.filter(f=>!/(__tests__|\.test\.|probe-orphan-runs|d07-d11|next-|PLAN-next)/.test(f)).join(',')); console.log('PROD_UNTOUCHED_OK')"
  EXPECT: PROD_UNTOUCHED_OK
  EVIDENCE: PROD_UNTOUCHED_OK
