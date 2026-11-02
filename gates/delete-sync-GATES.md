# Gates: cross-device conversation delete sync (desktop ↔ Android)

Scope: deletes (and hide-from-sidebar) propagate through server state
(Postgres ChatTurn + VM roster.json) instead of per-device localStorage
tombstones. Two repos: hermes-deploy (backend) + maiavm-desktop (client).

- [x] G1: hermes-deploy DELETE /api/chat/conversations deletes ChatTurn rows
  and strips the matching roster.json conversation row; pure roster-filter
  helper is unit-tested in repo style (tests/ dir, vitest).
  CHECK: cd ../hermes-deploy && echo "del=$(grep -c 'export async function DELETE' src/app/api/chat/conversations/route.ts) $(npx vitest run tests/conversations-delete.test.ts 2>&1 | grep -o '[0-9]* passed' | head -1)"
  EXPECT: /del=1.*passed/
  EVIDENCE: del=1 1 passed

- [x] G2: client transport interface gains deleteConversation; deploy
  transport issues the server DELETE (sessionId + rosterId); runtime delete
  handler fires it best-effort while keeping the local tombstone race-guard.
  CHECK: echo "files=$(grep -l deleteConversation src/lib/agents/transport.ts src/lib/agents/hermes-deploy-transport.ts src/lib/agents/useAgentRuntime.ts | wc -l | tr -d ' ')"
  EXPECT: /files=3/
  EVIDENCE: files=3

- [x] G3: hide-from-sidebar syncs via roster.json — serializer writes the
  flag instead of dropping the row, and applyConversationBinding restores it,
  so hide converges across devices like delete does.
  CHECK: grep -n "hiddenFromSidebar" src/lib/agents/vm-roster.ts | wc -l
  EXPECT: /[3-9]/
  EVIDENCE: 8

- [x] G4: no new type errors in either repo vs baseline (baselines captured
  before edits: maiavm tsc, hermes-deploy tsc).
  CHECK: echo "maiavm=$(npx tsc -b 2>&1 | grep -c 'error TS') hermes=$(cd ../hermes-deploy && npx tsc --noEmit 2>&1 | grep -c 'error TS')"
  EXPECT: /maiavm=20 hermes=0/
  EVIDENCE: maiavm=20 hermes=0
  BASELINES: maiavm=20 hermes-deploy=0 (captured pre-edit; verified by stash — no new errors)

- [x] G5: maiavm agents test suite passes (tombstone/transport/store tests
  must stay green after wiring).
  CHECK: npx vitest run src/lib/agents/__tests__ src/lib/__tests__ 2>&1 | tail -4
  EXPECT: /Tests\s+[0-9]+ passed/
  EVIDENCE: Start at  21:28:33 | Duration  4.00s (transform 1.84s, setup 0ms, import 3.31s, tests 2.36s, environment 31.17s)

- [x] G6: audit doc lists ≥4 DB-grounded sync findings with file:line cites,
  each labeled FIXED or DEFERRED.
  CHECK: echo "findings=$(grep -cE '^## F[0-9]' docs/delete-sync-audit.md) cites=$(grep -cE '`[^`]+:[0-9]+`' docs/delete-sync-audit.md) labels=$(grep -cE 'FIXED|DEFERRED' docs/delete-sync-audit.md)"
  EXPECT: /findings=6 cites=1[0-9] labels=[1-9][0-9]?/
  EVIDENCE: findings=6 cites=13 labels=8
