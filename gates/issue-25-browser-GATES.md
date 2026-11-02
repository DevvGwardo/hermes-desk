# Gates: #25 browser-use desktop slice (plan step 2, inert-off)

Scope: desktop-consume ONLY, behind per-instance probe flags. No cube
service, no gateway producer, no cookie channel (server-side, out of this
repo). Serve bridge has no browser wire shape — SSE mapping lands ONLY where
a real wire exists (fetch-SSE path in hermes-stream.ts + deploy-stream.ts);
nothing invented. Driver-prompt content deferred (dispatch routing already
covers browserUse via spawn.ts TASK_KINDS; worker cannot reach absent API).
No release/deploy/version-bump. Main untouched until PR review.

- [x] G1: job client + probe (hermes-rest, per-instance cache, 403/404/409 → unsupported)
  CHECK: npx vitest run src/lib/__tests__/hermes-browser-jobs.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  7 passed
  EVIDENCE: 7 passed — probe-false caches + blocks all CRUD on 1 network call, probe-true, per-instance isolation, create posts goal/startUrl, empty-goal refusal, strict read + malformed drop, steer/delete routes.

- [x] G2: SSE forwarding + run applier (Browsing digest, bind-by-job, terminal states, malformed ignored)
  CHECK: npx vitest run src/lib/__tests__/browser-progress.test.ts src/lib/agents/__tests__/deploy-stream-browser.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  10 passed
  EVIDENCE: 7 applier/serve-forward + 3 deploy-forward. Bind-by-job, unbound claim + pin, done→completed, malformed→null store-untouched, no phantom pill, malformed SSE dropped. (Harness: jsdom Blob lacks .stream() → Uint8Array bodies. Tests caught a REAL prod bug: onBrowser missing from processSseBlock destructure → ReferenceError; fixed.)

- [x] G3: spawn-suggestion gate + VmShot proof (fail-closed until probe true)
  CHECK: npx vitest run src/components/__tests__/chat-spawn-browser.test.tsx src/lib/__tests__/use-browser-jobs.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  6 passed
  EVIDENCE: Gate hidden/shown per probe (others unaffected); VmShot fallback copy proves job-scoped ref routing (asserts honest no-bridge fallback, not the loaded img).

- [x] G4: no regression — full suite green + tsc --force clean (counts re-measured)
  CHECK: npx tsc -b --force && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1375 passed | 1 skipped (1376)
  EVIDENCE: Test Files 160 passed (160) / Tests 1375 passed | 1 skipped (1376). Main baseline 1352 + 23 new (7 jobs + 10 SSE/applier + 6 gate) = 1375. tsc clean after typing the fetch-mock params (TS2493 noUncheckedIndexedAccess).

- [x] G5: mutation probe — new tests go red when the behavior is broken
  CHECK: break browser behavior deliberately (edit-break/edit-fix only, NEVER checkout on dirty files), run slice files, expect red, restore, expect green
  EXPECT: red-then-green (exact failing tests recorded in EVIDENCE)
  EVIDENCE: Browsing→Surfing digest swap → exactly the 2 digest tests red (2 failed | 5 passed); restored → 7 passed. Diff verified intact after.

- [x] G6: PR open for #25 from feature branch, main untouched, version pinned
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/25|browser/i.test(p.title)); if(!hit) throw new Error('no PR'); const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('version moved'); console.log('PR25_OK #'+hit.number)"
  EXPECT: PR25_OK
  EVIDENCE: PR25_OK #26 (https://github.com/DevvGwardo/maiavm-desktop/pull/26), opened 2026-09-05 from feat/issue-25-browser. Committed with this evidence line.
