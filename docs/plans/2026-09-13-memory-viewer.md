# Per-agent Memory viewer (Muse-inspired) — plan

Date: 2026-09-13. Status: planned, no code changed.

## 1. Goal

Let users view (read-only) each agent's long-term memory from the desktop,
using Muse's profile UX as inspiration (SOUL/MEMORY cards, "access with care",
activity + pending approvals) without copying Muse claims we can't verify.

## 2. Source screens analyzed

- Onboarding: explainer bullets (approval-gated writes; own computer+browser
  works while away; improves together) + naming prompt (Phoenix / Pepper /
  Something else) + right-rail avatar/Connected + 4-tab bar + dated timeline.
- Profile: avatar edit + Connected + 4 tabs (fingerprint active) + Name/Edit +
  SOUL (red) / MEMORY (blue) cards with "ACCESS WITH CARE", date, heart.

Research note: Meta sources confirm `MEMORY.md` + ask-to-edit + Forget skill +
reset. SOUL-vs-MEMORY as user-facing Muse UX is unconfirmed (OSS convention);
do not claim Muse parity on SOUL.

## 3. Current state (verified)

- No `Memory`/`Soul` table in `hermes-deploy/prisma/schema.prisma`;
  `ChatTurn`/`BotChatMessage` are short transcripts only.
- Memory/soul is on-VM hermes-agent state under `/opt/data`.
- Desktop reads memory direct-to-serve today:
  `src/lib/hermes-rest.ts:370-412` (`GET /api/memory`,
  `GET /api/memory/pending`, `PUT /api/memory/pending/{id}`),
  rendered in `src/components/HermesSurfacesPanel.tsx:382-435`.
- Via platform, `memory` is already in
  `hermes-deploy/src/lib/dashboard-proxy-path.ts:29`, so
  `/api/instances/[id]/dashboard/api/memory*` works on desktop bearer.
  `profiles` is NOT allowlisted, so `PUT /api/profiles/{name}/soul`
  (`docs/HERMES_SERVE_PROTOCOL.md:143`) 403s.
- `src/components/AgentInfo.tsx:880-887` memory section is mock-only.
- Per-agent mapping: `src/lib/agents/hermes-profiles.ts:37-55`
  (`profile:xxx` rows); VM agents resolve instanceId per
  `AgentInfo.tsx:663-675`; per-instance probe pattern at
  `src/lib/hermes-rest.ts:584-642`.

## 4. Plan

Phase 1 — read-only Memory per agent (next implement step, no backend change):
1. Add live Memory section to `src/components/AgentInfo.tsx` reusing
   `getServeMemory`, `listServeMemoryPending`, `resolveServeMemoryPending`,
   `memoryFieldRows` from `src/lib/hermes-rest.ts`.
2. Scope by selected agent's instanceId (follow `probeResize(instanceId)`
   pattern); linked-VM session auth only as fallback.
3. Show provider/enabled/stats + pending-approval rows with Approve/Reject
   (same as `HermesSurfacesPanel.tsx:402-433`).
4. Add one-line hint: "Ask in chat what it remembers, or tell it to forget X"
   (Muse dual path: conversational + direct).
5. Soul stays read-only: existing `persona.title/description` + profile path.
   No soul PUT.

Phase 2 — cheap Muse ports (copy only):
- Onboarding explainer bullets + sticky name/avatar/tone in `AgentEditor.tsx` /
  `TelegramConnect.tsx`.
- Provenance line per memory + "disconnect stops sync, old memories remain —
  purge?" note.
- Scoped Forget (topic/person) as chat command before file-delete UI.

Explicitly out of scope:
- Soul write via platform (needs allowlist + step-up/security review).
- Training/opt-out toggles, proactivity dial, overnight reflection (no backend).
- Merging Soul+Memory into one card.

## 5. Acceptance

- Selecting a VM agent shows live memory provider/stats or an explicit
  "memory route unavailable" state (never silent empty).
- Pending approvals approve/reject and refresh.
- Local/mock agents keep today's mock section unchanged.
- No `hermes-deploy` changes; no new env; no schema migration.

## 6. Files to claim on implement

- `src/components/AgentInfo.tsx`
- `src/lib/hermes-rest.ts` (only if instanceId threading needs a helper)
