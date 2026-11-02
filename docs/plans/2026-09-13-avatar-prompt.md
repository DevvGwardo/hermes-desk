# Chat-prompted avatar update (desktop + web) — plan

Date: 2026-09-13. Status: planned, no code changed.
Crew: spark-architect (plan) + spark-reviewer (gate: BLOCKED → fixes folded in below).

## 1. Goal

User can tell their agent in chat ("make yourself blue", "change your avatar
to red") and that agent's avatar updates in maiavm-desktop AND the web app.

## 2. Today (verified)

- Desktop: `avatarShape`/`avatarColor` in `src/lib/agents/types.ts:35,37`;
  writes via `updateAgent` (`store.ts:596-621`); UI in
  `AgentInfo.tsx:547-635` (AvatarEditor) + `AgentEditor.tsx`;
  render always `shape:'cat'` via `resolveAgentMascot`, 4-hex `NUBCAT_COLORS`.
- VM sync: `maia_avatar_shape/color` frontmatter in `/opt/data/agents/*.md`
  (`vm-roster.ts:94-116,138-139`); transports passthrough.
- Web (`hermes-deploy`): NO per-agent avatar. Only `User.avatarUrl`
  (`src/lib/profile.ts`, `schema.prisma:60`); `Instance` (`schema.prisma:156-161`)
  has no avatar columns.

## 3. Shared schema (both sides)

`{ shape: 'cat', color: <one of 4 palette hex> }`, nullable = reset to seed.
Closed color-name map (blue/red/pink/green/purple → hex) in one shared const.
Reject free-form hex/URL (XSS/injection); escape color before CSS/sidebar.

## 4. Phases

- P1 Desktop local: chat send-path intent parser → `updateAgent()` + persist;
  confirm message. Owner files: `useAgentRuntime.ts`, `store.ts`.
- P2 VM-persisted: agent-side `update_avatar` tool editing ONLY its own
  `.md` frontmatter (`maia_avatar_*`); enforce agent-id == filename, reject
  peer writes; path must satisfy workspace-only `safeVmWritePath`.
- P3 Web: store in `Instance.backendMeta.avatar{shape,color}` (NO migration,
  NO new columns, never `db push`); render in instance sidebar + chat header;
  update via existing instance PATCH/config route with zod enum validation.
- P4 Cross-surface: desktop reads web `backendMeta.avatar` on roster hydrate;
  e2e: "make yourself red" → same hex on both UIs after refresh.

## 5. Acceptance

- Valid color name → same hex on desktop + web after refresh.
- Invalid color → rejected with the 4 choices.
- "Default avatar" → seed color restored.
- Per-agent isolation: one agent's change never touches another.
- Peer-write attempt rejected; free hex/URL rejected.

## 6. Explicitly out of scope

Free-form image/URL upload, `User.avatarUrl` reuse for agents, new shapes
(renderer is cat-only), server-side LLM parsing in P1.
