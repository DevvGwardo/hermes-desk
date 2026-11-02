# Gates: #17 notify feed — desktop consume slice (CI kinds, poll, 429 backoff, docs)

Scope: desktop-consume ONLY. No hermes-rest.ts bus changes (probe/read/mark
contracts untouched — bus tests must stay green unmodified). No gateway
webhook producer (server-side, out of this repo). No release/deploy/version-bump.
Bus layer cannot see HTTP status/Retry-After through serveGet (headers dropped),
so backoff is exponential-with-cap on consecutive failed refreshes — documented
in code + docs, not header-driven. Honest limitation, satisfies "don't hammer a
rate-limited server" intent. Main untouched until PR review.

- [x] G1: bell poll + filter behavior (fake timers, mocked hermes-rest boundary)
  CHECK: npx vitest run src/components/__tests__/notifications-bell-poll.test.tsx 2>&1 | tail -n 4
  EXPECT: Tests  6 passed
  EVIDENCE: 6 passed — filter chips narrow/restore, per-filter empty copy, base-cadence refetch, zero-fetch unlinked, 4x backoff after 2 failures, hidden-skip + resume. (One test fixed mid-work: my delay arithmetic, not prod — streak hits 2 → 240s.)

- [x] G2: pure helpers (kind filter groups, poll delay growth + cap)
  CHECK: npx vitest run src/lib/__tests__/notifications.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  11 passed
  EVIDENCE: 7 pre-existing + 4 new (kindGroup, filterNotifications, kindLabel, nextPollDelayMs incl. 10-min cap).

- [x] G3: no regression — full suite green + tsc --force clean (counts re-measured)
  CHECK: npx tsc -b --force && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1362 passed | 1 skipped (1363)
  EVIDENCE: Test Files 156 passed (156) / Tests 1362 passed | 1 skipped (1363), Duration ~30s (2026-09-05). Main baseline 1352 + 10 new (6 poll + 4 lib) = 1362. tsc exit 0 after bare-setTimeout fix (repo convention, query.ts:19).

- [x] G4: mutation probe — new tests go red when the behavior is broken
  CHECK: break bell poll/filter deliberately, run G1 file, expect red, restore, expect green
  EXPECT: red-then-green (exact failing tests recorded in EVIDENCE)
  EVIDENCE: Removed the `document.hidden` guard → exactly "skips the poll while the tab is hidden and resumes when visible" red (1 failed | 5 passed); guard restored → 6 passed. (First attempt used `git checkout --` on the uncommitted bell file and wiped the implementation; re-applied identical edits, re-verified tsc 0 + 20/20, then re-probed via edit-break/edit-fix. No checkout-based probes on dirty files again.)

- [x] G5: PR open for #17 from feature branch, main untouched, version pinned
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/17|notify/i.test(p.title)); if(!hit) throw new Error('no PR'); const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('version moved'); console.log('PR17_OK #'+hit.number)"
  EXPECT: PR17_OK
  EVIDENCE: PR17_OK #24 (https://github.com/DevvGwardo/maiavm-desktop/pull/24), opened 2026-09-05 from feat/issue-17-notify. Committed with this evidence line.
