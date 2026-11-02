# Gates: #18 cross-session FTS — palette merge tests (tail-read wiring proof)

Scope: behavioral tests ONLY for the B1 cross-session merge already wired in
`src/components/CommandPalette.tsx` (probe-guarded `readTranscriptTails`,
debounced, capped, server-wins dedupe with attribution, unmapped-skip,
local-only fallback). No prod-code changes expected; if a bug surfaces, fix
forward on this branch and re-prove. No release/deploy/version-bump. Main
untouched until PR review.

- [x] G1: server hits merge with attribution (conversation title + agent-transcript mark)
  CHECK: npx vitest run src/components/__tests__/command-palette-cross-session.test.tsx 2>&1 | tail -n 4
  EXPECT: Tests  7 passed
  EVIDENCE: Test Files 1 passed (1) / Tests 7 passed (7), Duration 2.97s (2026-09-05)
  HARDENING (2026-09-05, review follow-up): converted to fake timers
  (act + advanceTimersByTimeAsync) — same 7 claims, zero sleeps/waitFor;
  absence assertions are now deterministic proofs over virtual time. Suite
  re-verified 1359|1, tsc clean.

- [x] G2: no regression — full suite green + tsc --force clean (counts re-measured)
  CHECK: npx tsc -b --force && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1359 passed | 1 skipped (1360)
  EVIDENCE: Test Files 156 passed (156) / Tests 1359 passed | 1 skipped (1360), Duration 21.33s (2026-09-05).
  NOTE: STATE's "1373+1skip" conflated PR #22's unmerged +21; true main baseline is 1352+1skip, +7 here = 1359.

- [x] G3: mutation probe — new tests go red when the merge is broken
  CHECK: git stash push -- src/components/CommandPalette.tsx && npx vitest run src/components/__tests__/command-palette-cross-session.test.tsx 2>&1 | tail -n 4; git stash pop
  EXPECT: Tests  failed (red against broken prod code), then pop restores green
  EVIDENCE: Inverted the unmapped-session guard (`if (!conv)` → `if (conv)`) → 2 failed | 5 passed (attribution + unmapped-skip tests red). Restored via `git checkout --`, re-ran → 7 passed. (Equivalent break-restore; stash form N/A since prod file was never modified on this branch.)

- [x] G4: PR open for #18 from feature branch, main untouched, version pinned
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/18|cross-session|transcript/i.test(p.title)); if(!hit) throw new Error('no PR'); const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('version moved'); console.log('PR18_OK #'+hit.number)"
  EXPECT: PR18_OK
  EVIDENCE: PR18_OK #23 (https://github.com/DevvGwardo/maiavm-desktop/pull/23), opened 2026-09-05 from feat/issue-18-fts-tests. To be committed with this evidence line.
