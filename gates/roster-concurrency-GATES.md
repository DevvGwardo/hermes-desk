# Gates: roster.json optimistic concurrency (F3 lost-update race)

Scope: PUT /api/nub/desktop/roster gains a server-owned `rev`; stale writes
409 with the current roster; client tracks rev, merges on 409, retries
bounded. DELETE conversations roster write bumps rev too. Backward compatible
(old clients / FS fallback unchanged).

- [x] G1: backend PUT honors baseRev — fresh write accepted with rev bump,
  stale baseRev rejected 409, missing roster.json accepts as rev 1; pure
  resolver helper unit-tested in hermes-deploy vitest style.
  CHECK: cd ../hermes-deploy && echo "helper=$(grep -c 'resolveRosterRevision' src/lib/chat-conversations.ts) tests=$(npx vitest run tests/roster-revision.test.ts 2>&1 | grep -o '[0-9]* passed' | head -1)"
  EXPECT: /helper=[1-9].*tests=[1-9].*passed/
  EVIDENCE: helper=1 tests=1 passed

- [x] G2: DELETE /api/chat/conversations roster write bumps rev so concurrent
  PUT holders re-merge instead of resurrecting the deleted row.
  CHECK: echo "bump=$(grep -c 'rev: currentRev + 1' ../hermes-deploy/src/app/api/chat/conversations/route.ts)"
  EXPECT: /bump=1/
  EVIDENCE: bump=1

- [x] G3: client parseVmRosterJson keeps rev; transport tracks rosterRev,
  updates from hydrate + 409 + success, retries with merge (max 3 attempts);
  putVmRoster 409 does NOT fall through to the raw-FS unconditional write.
  CHECK: echo "parse=$(grep -c 'rev' src/lib/agents/vm-roster.ts) transport=$(grep -c 'rosterRev' src/lib/agents/hermes-deploy-transport.ts) fs=$(grep -c 'conflict' src/lib/vm-fs-http.ts)"
  EXPECT: /parse=[1-9].*transport=[1-9].*fs=[1-9].*/
  EVIDENCE: parse=19 transport=5 fs=5

- [x] G4: client transport retry-on-409 behavior is unit-tested (fake fetch:
  409 then 200 → second PUT carries fresh rev; persistent 409 → stops).
  CHECK: npx vitest run src/lib/agents/__tests__/roster-conflict.test.ts 2>&1 | grep -o '[0-9]* passed' | head -1
  EXPECT: /[1-9].*passed/
  EVIDENCE: 1 passed

- [x] G5: no new type errors vs baselines (maiavm=20 hermes-deploy=0).
  CHECK: echo "maiavm=$(npx tsc -b 2>&1 | grep -c 'error TS') hermes=$(cd ../hermes-deploy && npx tsc --noEmit 2>&1 | grep -c 'error TS')"
  EXPECT: /maiavm=20 hermes=0/
  EVIDENCE: maiavm=20 hermes=0

- [x] G6: full test suites green in both repos (agents+lib; backend tests).
  CHECK: npx vitest run src/lib/agents/__tests__ src/lib/__tests__ 2>&1 | grep -o 'Tests *[0-9]* passed' | head -1
  EXPECT: /Tests *[0-9]* passed/
  EVIDENCE: Tests  441 passed
