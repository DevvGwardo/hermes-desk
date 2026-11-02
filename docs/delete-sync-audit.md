# Cross-device sync audit (desktop ↔ Android)

Grounded in the two server sources that both clients poll: Postgres `ChatTurn`
(`GET /api/chat/conversations`) and the VM roster file
`/opt/data/maia/roster.json` (`GET /api/nub/desktop/roster`). Each finding
cites the code that causes it and labels it FIXED (this change) or DEFERRED.

## F1 — Deletes are local-only (localStorage tombstone), never server-side
**FIXED.**

`deleteConversation` recorded a tombstone in `localStorage` and mutated
in-memory state, but never called the server. Both devices poll the same
server sources, so the other device re-hydrated the deleted row ~15s later.
- `src/lib/agents/store.ts:359` — `deleteConversation` (was local-only).
- `src/lib/agents/tombstones.ts:9` — tombstone persisted to `localStorage`
  (`maia:deleted-conversations:v1`), per-device.
- `src/lib/agents/hermes-deploy-transport.ts:773` — poll path filters by
  `isDeletedConversation` (this device's tombstones only).

Fix: `hermes-deploy` `DELETE /api/chat/conversations` deletes the `ChatTurn`
rows and strips the roster row (`hermes-deploy/src/app/api/chat/conversations/route.ts`);
the client fires it best-effort from `handleDeleteConversation`
(`src/lib/agents/useAgentRuntime.ts:503`) while keeping the tombstone as a
race-guard.

## F2 — Hide-from-sidebar was local-only AND the serializer dropped hidden rows
**FIXED.**

`hideConversation` set `hiddenFromSidebar` locally, and `serializeVmRoster`
*filtered hidden rows out* of roster.json. So a hide on desktop removed the
row from roster.json (other device loses it from roster) but the other device
resurrected it via the `ChatTurn` poll — hide never converged. Hide also never
triggered a roster write.
- `src/lib/agents/vm-roster.ts:201` — old `.filter((c) => !c.hiddenFromSidebar)`.
- `src/lib/agents/store.ts:376` — `hideConversation` (local state only).
- `src/lib/agents/hermes-deploy-transport.ts:340` — `scheduleRosterWrite` was
  not called from the hide path.

Fix: `serializeVmRoster` now keeps hidden rows with a `hiddenFromSidebar` flag
(`src/lib/agents/vm-roster.ts`), `applyConversationBinding` restores it, and
`handleHideConversation`/`handleUnhideConversation` call `transport.syncRoster()`
to push the flag promptly.

## F3 — Roster.json is a full-file PUT (last-write-wins) shared by both devices
**FIXED** (optimistic concurrency; one narrow residual case documented below).

`PUT /api/nub/desktop/roster` replaced the entire roster.json. Desktop and
phone both read-modify-write the same file with no version/etag, so concurrent
edits (create agent on desktop, send on phone within the 400ms debounce
window) silently clobbered each other.
- `hermes-deploy/src/app/api/nub/desktop/roster/route.ts:74` — `PUT` overwrote
  the whole file.
- `src/lib/agents/hermes-deploy-transport.ts:346` — `flushRosterWrite` writes
  the full serialized roster.

Fix (the If-Match/etag pattern):
- Server owns a monotonic `rev` stamped into roster.json.
  `resolveRosterRevision` (`hermes-deploy/src/lib/chat-conversations.ts`) is
  the pure gate: fresh `baseRev` → accept + bump; stale → reject; missing
  file → accept as rev 1; no `baseRev` (old client) → unconditional accept
  (previous behavior). Stale PUTs get a 409 carrying the current roster so the
  client can merge instead of guessing.
- Client tracks `rosterRev` from every roster GET / 409 / success response
  (`src/lib/agents/hermes-deploy-transport.ts`), sends it as `baseRev`, and on
  409 merges the returned roster via `mergeVmRosterIntoState`, then retries —
  bounded at 3 attempts (`src/lib/agents/__tests__/roster-conflict.test.ts`).
  `putVmRoster` (`src/lib/vm-fs-http.ts`) returns the conflict instead of
  falling through to the unconditional raw-FS write.
- `DELETE /api/chat/conversations` roster cleanup bumps the rev too, so a
  client holding the old rev re-merges rather than resurrecting the deleted
  row on its next write.
- Rollout-safe: old clients (no `baseRev`) and the raw-FS fallback behave
  exactly as before; backend and clients can deploy in any order.

**Residual limitation (narrow):** the 409 re-merge only adds/updates rows —
it never drops a local conversation absent from the server roster. So a
roster-only thread (no ChatTurn session) deleted on device B can still be
re-added by device A if A holds it in memory and wins a write race; it stays
gone once B's state (or the next full hydrate) reconciles. Session-bound
threads are immune — the server-side ChatTurn delete is authoritative.
Eliminating the roster-only case entirely needs op-based writes (F3 alternative
B) or server-side row ownership; not worth the surface for the current
two-writer workload.

## F4 — Bot Mode session dumps accumulate on disk (never reaped)
**DEFERRED.**

Hermes Bot Mode writes `hermes_*` session-dump rows to the VM; the roster poll
only surfaces rows that bind to a roster conversation. Deleted/orphaned
sessions stay on disk and can resurrect if a tombstone is ever cleared.
- `src/lib/agents/hermes-sessions.ts:162` — "Remove persisted `hermes_*`
  session-dump rows" (only Bot Mode path prunes; normal deletes don't).
- `src/lib/agents/tombstones.ts:53` — `clearDeletedTombstones` exists but no
  server-side reaper.

## F5 — Tombstones grow unbounded in localStorage and never sync
**DEFERRED (minor).**

`recordDeletedConversation` only ever adds to the set; nothing prunes it. With
server-side delete now in place, a tombstone could be dropped once the server
confirms the delete (the DELETE response), but the current wiring keeps them as
a permanent race-guard. Cap or reap on confirmed delete.
- `src/lib/agents/tombstones.ts:39` — `recordDeletedConversation` (add-only).
- `src/lib/agents/hermes-deploy-transport.ts` `deleteConversation` — could prune
  the tombstone on `res.ok`.

## F6 — Viewing a thread rewrites server roster `lastUsedAt`/`preview` on every poll
**DEFERRED (cosmetic).**

`applyConversationBinding` keeps the local home-row order/snippet until a send,
but the server's "latest turn" snippet is rewritten on view, so the home order
can drift between devices after a view-only session. Cosmetic, but it is a
cross-device divergence sourced from the same data model.
- `src/lib/agents/vm-roster.ts:261` — comment + lastUsedAt/preview handling.

---
**Summary:** 3 FIXED (F1 deletes, F2 hide, F3 roster concurrency), 3 DEFERRED
(F4–F6). F4 (unreaped Bot Mode session dumps) is the next-highest-value item.
