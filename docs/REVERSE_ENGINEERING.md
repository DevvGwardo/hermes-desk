# Reverse-engineering map (UX only)

Clean-room mapping of a Grok Bot-like agent desktop surface onto Nub Agent and the hermes-deploy / MaiaVM backend. No proprietary implementation details.

## Desktop shell parity

Grok Bot ships as an **Electron** desktop client. Nub Agent matches that shape:

- `electron/main.cjs` — `BrowserWindow`, loads Vite in dev and `dist/index.html` in prod
- `electron/preload.cjs` — `contextIsolation` + minimal `window.nubAgent` API
- Renderer is Vite + React (Nub / nubapp v2 visual language)

| Grok Bot-like surface | Nub Agent surface | hermes-deploy / MaiaVM API or entity |
| --- | --- | --- |
| Named agents list (left sidebar) | Sidebar — list from listInstances() | Instance (Hetzner VM) |
| Agent status indicator | Status pill (running pulse / provisioning shimmer) | Instance lifecycle / power state |
| Main chat thread | ChatPanel — bubbles, attachments, choices + Framer Motion | Chat/task messages scoped to Instance id |
| Composer / send | Chat input to sendChat(instanceId, message) | POST /api/instances/:id/chat (stub) |
| Live Computer pane | ComputerPanel — Connect → faux desktop or iframe | noVNC via getComputerUrl(instanceId) |
| Agent name in chrome | TopBar | Instance name |
| Per-agent info / meta | AgentInfo slide-over | Instance metadata |
| Routines | Routines placeholder | Scheduled jobs / cron (future) |
| Connectors / integrations | Connectors placeholder | OAuth apps, GitHub, Slack (future) |
| Settings | SettingsStub — API base, mock vs live, runtime versions | Env + session/bearer auth config |
| Cloud Linux box per agent | Computer View target | Hetzner VM via hermes-deploy |
| Auth session | Mock mode today; cookie/bearer later | MaiaVM session cookie / bearer token |

## FatCatIcon — code-morph mascot (clean-room)

Grok Bot uses a **procedural, code-only morphing face icon** (SVG/canvas geometry driven by expression parameters that spring between states). Nub Agent mirrors the *idea* only — not any proprietary paths, meshes, or brand marks — with an original **fat cat head** inspired by the Nub mascot (`docs/nub-mascot-ref.png`):

| Concept | Nub Agent |
| --- | --- |
| Shared parametric face | `src/lib/cat-face.ts` — `FaceParams` vector (ear tilt, cheek puff, eye open L/R, pupil look, brow, mouth smile/open, whisker droop) |
| Expression presets | `idle` · `happy` · `curious` · `thinking` · `working` · `sleeping` · `error` |
| Smooth morph | `FatCatIcon` spring-interpolates all params via framer-motion `useSpring`; `prefers-reduced-motion` snaps |
| Idle life | Subtle blink + gaze drift when idle/happy/working (disabled under reduced motion) |
| Agent status map | `statusToExpression()` — running→happy/working, stopped→sleeping, provisioning→curious, error→error |
| Render | Pure SVG (`src/components/FatCatIcon.tsx`) — light-blue `#9ecdff` fur, navy `#1a3d6b` features, pink blush, optional blue accent |
| Demo strip | `FatCatIconDemo` in Settings cycles expressions |

This is a **clean-room fat cat**, not a Grok clone: different silhouette (chubby Nub blob head, short ears, black-dot eyes, W mouth + nose dot), Nub palette, original control mapping.

## Product rules for this scaffold

- Agents are Instances — one sidebar row equals one VM.
- Computer View is the primary differentiator after chat; treat noVNC as the MVP embed target.
- Keep mock mode until auth is real so demos never need secrets in the repo.
- Visual language follows Nub Agent (`--ca-*` tokens), not MaiaVM dark gold.

## Multi-agent / subagents

Canonical design: [`docs/SUBAGENTS_AND_MULTI_AGENT.md`](./SUBAGENTS_AND_MULTI_AGENT.md) (types, transport, UI diffs). Do not duplicate that doc here.

| Grok-shaped cue (IPC name only) | Nub Agent surface | MaiaVM / hermes later |
| --- | --- | --- |
| `listAgents` | Sidebar → Agents (`AgentTransport.listAgents`) | `listInstances()` → Instance rows |
| `createAgent` | Sidebar “+ Agent” → mock `createAgent` | Provision Instance |
| `createGroup` / `setGroupMembers` | Sidebar → Groups + mock group room | Future room service (not an Instance) |
| `getSubagents` | AgentInfo → Live / Recent subagents | Child jobs / runners on Instance |
| `getAsyncTasks` | `Turn` + `SubagentRun` in store | Chat stream / job status |
| `broadcastToAgents` | Group thread send (mock member reply) | Fan-out to member Instance chats |
| Shared room / add agent | Ops Desk group + `memberAgentIds` | Room membership API |
| Subagent kinds (executor / browser / computer / …) | `SubagentKind` + thread digest chips | Instance-local runners / hermes jobs |

MVP lives under `src/lib/agents/` (`types`, `store`, `mock-transport`) and is offline-capable behind `VITE_MAIAVM_MOCK`.
