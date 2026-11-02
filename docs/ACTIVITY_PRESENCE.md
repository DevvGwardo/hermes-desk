# Activity → Presence → FX contract

Single source of truth for chat/agent activity mapping onto FatCatIcon
presence. The visual FX table once lived in blob-fx `PRESENCE_TO_FX` (dzt);
that module was reduced to type re-exports on 2026-09-21 (see
`docs/CHAT_LOAD_AND_MOTION_SPEC.md` M4) — the product path is now
`src/lib/grok-orb/`.

**Runtime module:** `src/lib/agents/activity.ts`  
Do **not** import `docs/grok-extracted/*` into `src/`.

## Layers

| Layer | Owns | Example keys |
|-------|------|----------------|
| ActivityPhase | chat / turn / composer | `listening`, `thinking`, `working`, `sending` |
| PresenceState | product presence | `radar`, `thinking`, `loading`, `sending` |
| FxState | visual FX engine | `radar`, `dots`, `whirl`, `send` |

`resolvePresence(input)` picks one PresenceState; FatCatIcon with
`fx="auto"` maps it through `PRESENCE_TO_FX`.

## Priority (`resolvePresence`)

1. Explicit `presence` (including `null` = force off)
2. `sending === true` → `sending`
3. Live subagents (strongest: failed → running → queued → completed)
4. `activityPhase`
5. `turnPhase`
6. `agentStatus` (+ optional `agentBusy`)
7. `null`

## Compact maps

| ActivityPhase | Presence | FX |
|---------------|----------|-----|
| listening | radar | radar |
| thinking | thinking | dots |
| working | loading | whirl |
| sending | sending | send |
| writing | writing | pencil |
| receiving | receiving | receive |
| surprised | radar | radar |
| sleeping | powering-down | standby |
| error | alerting | bang |
| idle / null | — | — |

| SubagentStatus | Presence | FX |
|----------------|----------|-----|
| queued | spawning | gather |
| running | progress | progress |
| completed | receiving | receive |
| failed | alerting | bang |
| cancelled | powering-down | standby |

| TurnPhase | Presence |
|-----------|----------|
| acked | radar |
| working | loading |
| delivering | sending |
| done | null |
| failed | alerting |

| AgentStatus | Presence |
|-------------|----------|
| error | alerting |
| provisioning | radar |
| running + busy | thinking |
| running + !busy | null |
| stopped | powering-down |

## MaiaVM Instance stream mapping (later)

| Instance event | Activity / presence | FX |
|----------------|---------------------|-----|
| chat ack / stream open | listening → radar | radar |
| reasoning / thinking | thinking → thinking | dots |
| tool/subagent start | spawning | gather |
| tool/subagent running | progress | progress |
| token stream | writing | pencil |
| outbound deliver | sending | send |
| inbound digest/result | receiving | receive |
| upload | uploading | dock |
| STT / dictation | dictating | wave |
| instance error | alerting | bang |
| stopped / power off | powering-down | standby |

Presence keys stay product-owned; FX keys are the visual layer only.


## Product path

Product UI must pass `presence` and/or `fx` explicitly on `FatCatIcon`.

- `fx={null}` disables FX even if expression would map via the fallback.
- expression→FX (`expressionToPresence`) is a **fallback for demos only**.
- `happy` no longer maps to orbit — chrome must not ambient-animate from expression alone.
- Sidebar chrome: use `chromeAvatarPresence` / `sidebarAvatarFx` — `fx` is null unless status is `provisioning` or `error` (or future live-busy from `runtime.presence`). Selected-running is **not** busy.
- ChatPanel composer: `resolvePresence(...)` + `fx="auto"` with explicit `presence`.
- TypingIndicator: pass `presence` explicitly (e.g. `loading`); do not rely on expression alone.
