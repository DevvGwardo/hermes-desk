# Hermes → Nub Agent: SaaS coverage map & simplification plan

Status: **2026-09-26.** Audited hermes-agent (DevvGwardo fork, HEAD 2026-09-12) against maiavm-desktop `main` + the Connections pane branch. Sources: hermes `hermes_cli/web_routers/*` (dashboard REST), `hermes_cli/config_defaults.py`, `toolsets.py`, `skills/`, `optional-skills/`, `optional-mcps/`, `plugins/`, the hermes web dashboard (`web/src`) and the official Hermes desktop app (`apps/desktop`). Supersedes nothing — `hermes-capabilities.md` stays the developer reference; this doc answers *"what does a SaaS user need to touch, and how simple can we make it"*.

## TL;DR

- Hermes has **~250 dashboard REST routes** and a config file with **~70 top-level sections**. Nub Agent uses **~40 routes** today. Almost every gap is **desktop UI work against REST that already exists** — only 5 items need upstream hermes changes (§6).
- Everything sorts into three tiers:
  1. **Platform-managed (hidden):** model/provider, auxiliary models, terminal backend, dashboard auth, updates policy, telemetry, logging, sandbox/security knobs. The user never sees them; maiavm pins them.
  2. **"Connect" cards (the core UX):** one card per thing the user brings — a chat app, an inbox, an API key for a skill, an MCP server, a memory provider. Fill in 1–3 fields or click an OAuth button; the app validates, restarts what's needed and shows a plain status.
  3. **Advanced (collapsed):** bring-your-own LLM key, allowlists, per-channel group policy, custom MCP servers.
- **Never** expose a raw config/env editor, terminal, arbitrary file access, plugin install, or shell hooks to SaaS users.
- **Security gates come first** (§2): the maiavm dashboard proxy currently forwards any `/api/*` path, which lets a user read or replace the platform LLM key and turn off every safety setting.

## 1. Principles

1. **Ask only for what the user uniquely owns** (their Telegram, their inbox, their Notion key). Everything the platform can supply (LLM, web search, image gen, vision, voice) is supplied and hidden.
2. **One card, one outcome.** "Connect Gmail", not "set EMAIL_IMAP_HOST". Presets fill the rest.
3. **Status in plain words:** Connected / Needs setup / Can't connect (+ reason) / Off.
4. **Let the agent ask.** Hermes already emits in-chat `secret.request`, `mcp.setup.request` and `clarify.request` events — handling them turns "go to Settings" into "paste it right here".
5. **Hide what can't work on a hosted Linux VM** (macOS skills, LAN devices, GPUs, loopback-only OAuth).

## 2. Security prerequisites (maiavm.com proxy + VM image — not in this repo)

These live in the maiavm.com server / hermes-deploy image, which this audit could not see. They gate everything else.

| # | Must do | Why |
|---|---|---|
| S1 | **Allowlist dashboard routes in the maiavm `/api/instances/{id}/dashboard/*` proxy.** Deny at minimum: `/api/env/reveal`, `/api/config/raw`, `PUT /api/config` (except a key allowlist), `/api/model/set`, `/api/model/moa`, `/api/providers/*`, `/api/credentials/pool*`, `/api/tools/terminal/backend`, `/api/tools/toolsets/*/post-setup`, `/api/ops/hooks`, `/api/ops/import` (path form), `/api/ops/debug-share`, `/api/ops/config-migrate`, `/api/hermes/update`, `/api/dashboard/agent-plugins/*`, `/api/local-models/*`, `/api/profiles/*/open-terminal`, WS `/api/pty`, WS `/api/console`, `/api/fs/*` (except via the maiavm fs remap). | Desktop `vmRestHandle` passes any `/api/*` path (`electron/nub-link.cjs:2033`). Dashboard auth is one token that grants every route. |
| S2 | **Restrict `PUT/DELETE /api/env` keys server-side** to messaging + skill keys. | Accepts `*_BASE_URL`, `TERMINAL_ENV`, and can overwrite the platform `hermes_pk_` key. (Desktop-side allowlist added in `src/lib/messaging.ts`.) |
| S3 | **Pin platform settings with hermes managed scope** (`/etc/hermes/config.yaml` + `.env`, root-owned; `hermes_cli/managed_scope.py`), with hermes running as a non-root user. Pin: model/providers/auxiliary/delegation/moa, platform LLM key, `security.*` (except `website_blocklist`), `dashboard.*`, `telemetry`, `monitoring`, `updates`, `terminal.backend`, `hooks_auto_accept: false`, `gateway.api_server`. | The agent has a shell; filesystem ownership is the only thing that makes pins stick. |
| S4 | **Block slash commands that repoint the model** (`/model --global`, `/fast`, `/moa`, `/reasoning`) — server-side via managed scope, plus a desktop denylist in the chat passthrough (`src/components/ChatPanel.tsx:180`). | Passthrough forwards any unknown `/cmd` verbatim. |
| S5 | Network-block cloud metadata (169.254.169.254) on VMs; keep `security.allow_private_urls` / `browser.allow_private_urls` false. | SSRF from browser/web tools. |
| S6 | Confirm dashboards run behind `dashboard.oauth`/proxy auth, never `--insecure`; public paths (`/api/status`, `/api/config/schema`, …) leak only version/defaults. | `hermes_cli/dashboard_auth/public_paths.py`. |

## 3. Coverage map

Legend — **Have**: shipped in Nub · **Part**: partial/buggy · **None** · Plan: **Hide** (platform-managed) · **Keep** · **Fix** · **Build** · effort S/M/L.

### 3.1 Messaging & delivery

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Platform credentials (21 platforms) | Have — Connections pane (this branch) | Keep | — |
| Email guided setup (IMAP/SMTP presets, app password, allowed senders) | Have — this branch | Keep | — |
| **Telegram one-tap bot creation (QR / deep link, no BotFather)** | None (`TelegramConnect.tsx` is account login, not this) | **Build** on `/api/messaging/telegram/onboarding/*`; auto-allow `owner_user_id` | S |
| **WhatsApp QR pairing** | None (marked "ask your agent") | **Build** on `/api/messaging/whatsapp/onboarding/*` (render rotating QR, 600s TTL, bot vs self-chat); needs Node in image | M |
| **DM pairing approvals** ("X wants to talk to your agent") | None | **Build** Requests inbox + Approved list on `/api/pairing*`, poll + bell badge; change the stranger-facing copy in hermes (§6) | M |
| Allowed users per platform | Part (email only) | **Build** chip input on each card (`*_ALLOWED_USERS`) | S |
| Home channel ("send results here") | None | **Build** "send /sethome in that chat" guide + poll `/api/cron/delivery-targets` | S |
| Group-chat policy (mention-only, channels, threads) | None | **Build** small "In group chats" card over allowlisted `/api/config` keys | M |
| Stream replies / progress chatter / typing delay | None | Build toggles on channel card (later) | S |
| Per-channel prompts, profile routing, WhatsApp Cloud, WeChat, China platforms | None | Hide v1 | — |

### 3.2 Routines, triggers, tasks

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Cron list/create/edit/pause/run/delete | Have (`RoutineEditor`, `routines.ts`) | Keep | — |
| **Delivery target** (results to Telegram/email) | **None — every routine hardcodes `deliver:'local'`** (`routines.ts:369,464`, `hermes-rest.ts:475`) | **Build** "Send results to" picker from `/api/cron/delivery-targets` + "alert me on failure" | S |
| Routine templates | None | **Build** gallery from `/api/cron/blueprints` + `/instantiate` | S |
| Run history | None | Build drawer on `/api/cron/jobs/{id}/runs` | M |
| Per-routine skills/model/toolsets | None | Advanced section (skills only; model hidden) | M |
| **Timezone** | None — VMs run **UTC**, so routines fire at wrong local time | **Build** auto-push OS timezone at link time (`timezone` config) + override | S |
| Webhook triggers (GitHub/Stripe/Zapier → agent) | None | Build "Triggers" tab on `/api/webhooks*`; needs a public ingress per VM | M |
| Kanban board | Have, but CLI-bridge fallbacks (`main.cjs:1176`) | **Fix** REST-only on hosted VMs; add board switcher, "Auto-run tasks" | M |
| `/spawn` subagent | Part — local `~/.agent-tasks` queue, absent on VMs | Re-point to kanban task create | M |
| Script/monitor-URL cron, incidents, notepad, ACP, batch runner, peers | None | Hide | — |

### 3.3 Agents, personas, sessions

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Profiles list | Part (read-only hydration) | Keep | — |
| **"New agent" creates a real profile** | **None — writes only an app-side roster entry** | **Build** `POST /api/profiles` (clone default) + `PATCH/DELETE` | M |
| Personality (SOUL.md) / description | None | Build "Personality" editor on `/api/profiles/{n}/soul`, tone presets | S |
| Project instructions (AGENTS.md) | None | Build editor writing workspace-root AGENTS.md | S |
| Sessions list/resume | Part — CLI-parse path (`hermes-sessions.ts:217`) | **Fix** use `/api/sessions` on hosted VMs; label source (Telegram, Routine…) | S |
| Session search / rename / export / delete / retention | None | Build sidebar search + context menu; Storage "keep history for N days" | S |
| Delegation / helper agents | Have (render) | Keep; hide model knobs | — |
| Slash-command autocomplete | Part (8 app cmds + passthrough) | Build registry-driven `/` menu, minus S4 denylist | M |

### 3.4 Skills

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| List / toggle | Have | Keep (+ search, categories) | S |
| **Install / uninstall / update / scan from hub + official catalog** | **None — UI says install isn't possible** (`HermesSurfacesPanel.tsx:313`) | **Build** "Add skills" gallery on `/api/skills/hub/*` + `/hub/official`, filtered by VM feasibility (Appendix A) | M |
| **"Needs setup" badge + Connect drawer** (API key / install / OAuth) | None | **Build**; needs readiness fields on `/api/skills` (§6) | M |
| **In-chat key prompt** (`secret.request`) | **Typed, unhandled** — agent blocks on a question the user never sees | **Build** masked inline card answering `secret.respond` | S |
| Create/edit own skill | Part (submits to maiavm store, not the VM) | Build editor on `/api/skills` + `/content` | M |
| Taps, reset/diff, snapshot, publish | None | Hide | — |

### 3.5 MCP (plugins / connectors)

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| List/add/remove/test/enable | Have (`McpPanel`) | Keep | — |
| **Catalog** | Part — 20 hardcoded presets vs **65** in `/api/mcp/catalog` | **Build** swap to live catalog + `/catalog/install` | M |
| API-key / header / env MCPs (e.g. n8n) | **None — add drops env/headers/bearer_token** (`mcp.ts:454`) | **Fix** add fields | S |
| OAuth completion state | **Part — opens URL, never polls** `/api/mcp/oauth/flows/{id}` | **Fix** poll → auto-test; confirm VM callback URL reachable | S |
| In-chat MCP consent (`mcp.setup.request`) | None | Build consent card | M |
| Per-tool include/exclude | None | Hide v1 | — |

### 3.6 Memory

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Status | **Broken** — reads `provider/enabled`, hermes returns `active/providers/builtin_files` (`hermes-rest.ts:541,585` vs `ops.py:434`); mock hides it | **Fix** mapping; show "Built-in (x KB)" | S |
| Pending-memory approvals | **Broken** — calls `/api/memory/pending`, which doesn't exist in hermes | **Fix** drive via `/memory pending|approve|reject` slash, or add route (§6) | M |
| Remember facts / learn about me toggles | None | Build 2 toggles (`memory.*` allowlisted config) | S |
| View / forget memory | None | Build read-only viewer + "Forget everything" (`/api/memory/reset`) | S |
| External providers (Honcho OAuth, Mem0, Supermemory, RetainDB, Hindsight, Holographic) | None | Build provider cards from `/api/memory/providers/{n}/config` schema; hide OpenViking/brain_mcp/embedded modes | M |

### 3.7 Tools / capabilities

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Capabilities on/off (web, browser, terminal, files, code, vision, image, video, TTS, todo, clarify, delegation…) | **None** — agents hardcoded `[web, file, terminal]` (`hermes-agents.ts:79`); placeholder `ToolsetConfigPanel` | **Build** "Capabilities" list on `/api/tools/toolsets` + `PUT …/{name}` | M |
| Web search, image/video gen, vision, premium TTS/STT, cloud browser keys | None | **Hide: platform-provided** — prefer a maiavm-run managed tool gateway (`TOOL_GATEWAY_*`) over raw vendor keys on each VM | L (platform) |
| BYO connect cards: Home Assistant, X search (xAI), Discord admin tools | None | Build as Connect cards (per-toolset env endpoint) | S each |
| Voice: read replies aloud / voice picker | None (desktop dictation only) | Build later (Edge free default) | M |
| Todo list / clarify rendering | **None — `clarify.request` typed, unhandled** | **Build** inline choice chips; live checklist card | S–M |
| Computer use | Part (status probe) | Hide; preinstall in image if offered | — |
| Terminal backend, code-exec mode, Langfuse, Lightpanda/Camofox, wake word, RL | None | Hide / never | — |
| Per-platform tool scoping ("no terminal in Telegram") | None | Needs hermes REST `platform` param (§6) | M |
| Spotify | None | Hide (loopback-only OAuth redirect) | — |

### 3.8 Models & usage

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Main model / provider / fallback / credential pool / MoA / auxiliary / delegation model / context length / fast mode | None (label "Maia") | **Hide: platform-managed** (S3/S4). Later: "Standard / Pro" tier mapped server-side | — |
| Bring-your-own key or subscription (OpenAI/Anthropic key, ChatGPT/Grok device-code login) | None | Optional Advanced pane; device-code providers only; separate from platform key + billing switch | M |
| Reasoning effort | None | "Quick / Balanced / Thorough" only if the platform model honours it | S |
| Usage & budgets | Have (`UsageBlock`) | **Fix** make maiavm billed usage primary (local omits aux/retries); add top-up CTA | S |
| **Rate-limit / budget-exhausted message** | **None — proxy 429 shows as an empty reply** | **Build** "Limit reached, resets at X" banner from 429 + `/api/llm/usage` resetAt | M |

### 3.9 Safety, ops, troubleshooting

| Capability | Nub today | Plan | Effort |
|---|---|---|---|
| Approval mode (Ask / Smart / Always) | Have — but **restarts the whole VM** (`nub-link.cjs:2221`, `restart:true`) | **Fix** apply live (`PUT /api/config` broadcasts; or `/approvals`) | S |
| Always-allowed commands (review/revoke) | None | Build list on `command_allowlist` | S |
| Never-allow list, "let routines run risky commands" | None | Advanced | S |
| Privacy: hide phone numbers & IDs from AI (`privacy.redact_pii`) | None | Build toggle | S |
| Blocked websites | None | Build chip list (`security.website_blocklist.domains`) | S |
| Check my agent (`/api/ops/doctor`), security check | None | Build Troubleshooting section | M |
| Error log viewer (`/api/logs`, redacted) | None | Build | M |
| Backup download / restore (upload only) | None | Build in Storage | S / M |
| Undo file changes (checkpoints) | None | Build toggle, restore later | M |
| Update agent / restart | Have | Keep; add "update available" from `/api/hermes/update/check` | S |
| Raw config, env reveal, hooks, quick commands, plugins install, debug-share, dashboard theme/auth, telemetry, logging config, session reset policies (dead code) | None | **Never / Hide** | — |

## 4. Bugs found in Nub during the audit

1. Memory tab field mismatch → always "Provider: none" (§3.6).
2. Memory approvals call a non-existent route (§3.6).
3. Routines can never deliver to chat apps (`deliver:'local'` hardcoded) (§3.2).
4. `clarify.request` / `secret.request` / `mcp.setup.request` unhandled → agent can block on invisible questions (§3.4, 3.5, 3.7).
5. MCP add drops env/headers/bearer; OAuth never polls completion (§3.5).
6. Approvals change reboots the VM unnecessarily (§3.9).
7. Proxy 429 renders as empty reply (§3.8).
8. Sessions/kanban/spawn depend on a local CLI bridge that doesn't exist for hosted-only users (§3.2, 3.3).
9. Stale comment: `usage-format.ts:5` says upstream is "MiMo V2.5"; actual is deepseek-v4-flash.
10. VM timezone is UTC for everyone (§3.2).

## 5. Roadmap

**Phase 0 — lock it down (platform, blocks launch):** S1–S6.

**Phase 1 — quick wins (desktop, ~1 week, mostly S):**
routine delivery picker + templates · timezone auto-push · Telegram QR onboarding · handle `secret.request` / `clarify.request` in chat · memory tab fix · MCP OAuth polling + key/header fields · approvals without reboot · rate-limit banner · allowed-users chips on channel cards.

**Phase 2 — the "Connect" surfaces (~2–3 weeks, M):**
DM pairing inbox · WhatsApp QR · Skills gallery (hub + official, VM-filtered) with Connect drawers · live MCP catalog · Capabilities list · real profiles/personas + personality · sessions over REST (search/rename/export) · memory toggles/viewer/providers.

**Phase 3 — depth (L):**
webhook triggers (needs ingress) · managed tool gateway for web/image/voice keys · BYO model key/subscription · troubleshooting (doctor, logs, backup/restore, checkpoints) · group-chat policy · per-channel tool scoping · voice replies.

## 6. Upstream hermes-agent changes worth making (fork)

1. `GET /api/skills`: add `setup_needed`, `missing_env`, `missing_commands`, `missing_credential_files` (logic exists in `tools/skills_tool.py:414-459`).
2. `/api/memory/pending` + approve/reject routes (logic exists behind `/memory` slash).
3. `PUT /api/tools/toolsets/{name}`: accept `platform` for per-channel scoping (`tools_config.py:132`).
4. Stranger DM copy (`gateway/run_inbound.py:97-102`): configurable text, e.g. "Ask the owner to approve you in the Nub app" instead of `hermes pairing approve …`.
5. Messaging catalog: add `EMAIL_ALLOWED_USERS`, ports, and `*_HOME_CHANNEL` to `env_vars` so `PUT /api/messaging/platforms/{id}` covers them and the generic `/api/env` can be closed to users entirely.

## Appendix A — skills that need setup, by hosted-VM feasibility

**Connect card (API key):** notion (or Notion MCP), airtable, gif-search (Tenor), shopify, canvas, here-now, telephony (Bland/Vapi), parallel-cli, pinecone, osint (optional), agentmail, grok (xAI), openhands, actual, inference-sh, cloudflare deploy/publish-site, page-agent, weights-and-biases, lambda-labs, huggingface, comfyui (Cloud), fitness-nutrition (optional), blocked-page-recovery (optional Jina), reddit (optional), 1password (service-account token).

**Install + key/login (preinstall in image):** github (`gh` + token/device code), himalaya (reuse `email-presets.ts` to write `config.toml`), box (code flow), claude-code, codex, opencode, sherlock, blogwatcher, scrapling, songsee.

**OAuth, needs platform-owned client:** google-workspace (per-user GCP client today → use Nub-owned verified client or Google MCP), Linear/Slack/GitHub etc. via MCP OAuth.

**Hide (can't work on a hosted Linux VM):** apple-notes, apple-reminders, findmy, imessage, obsidian (local vault), openhue, touchdesigner/unreal MCP, brain_mcp, neuroskill-bci, openclaw-migration, GPU mlops skills, spotify, xurl (per-user X dev app), computer-use (unless image ships a display).

**Hide v1 (sensitive/niche):** blockchain/finance wallets, stripe CLI skills, godmode, s6 supervision, docker-management (unless daemon), mcp-oauth-remote-gateway, minecraft/pokemon.

**No setup needed:** maps, youtube-content, codebase-inspection, qmd, bioinformatics, drug-discovery, hyperframes, draw-your-font, fastmcp, mcporter, memento-flashcards, shop, duckduckgo-search.
