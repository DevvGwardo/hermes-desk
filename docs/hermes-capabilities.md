# Hermes Agent — Capability Map (Integration Reference for MaiaVM Desktop)

> **Purpose.** Complete feature surface of **Hermes Agent** (the Nous Research agent that powers our product), organized so a desktop app can wire these features into UI. Every command, path, and format below was verified against one of: the official docs (`https://hermes-agent.nousresearch.com/docs/…`), the live CLI (`hermes …`), or the local source checkout at `~/.hermes/hermes-agent/`. Items marked *(inferred)* are reasonable extrapolations, not verified.
>
> **Version pinned:** Hermes Agent **v0.20.0 (2026.8.3)** — Python 3.11.15, install dir `/Users/devgwardo/.hermes/hermes-agent`, binary at `/Users/devgwardo/.local/bin/hermes`. Docs site version may drift ahead of the local install; CLI help is ground truth for the local box.
>
> **Quick counts (verified):**
> - **70** top-level CLI subcommands (`hermes --help`)
> - **95** built-in slash commands in the central registry (`hermes_cli/commands.py` → `COMMAND_REGISTRY`, counted `grep -c 'CommandDef('`)
> - **~83** model tools across **20+ toolsets** (local `website/docs/reference/tools-reference.md` + `hermes tools list`)
> - **45** `hermes kanban` verbs; **12** `kanban_*` model tools; kanban DB = SQLite with **8 tables**
> - **21+** messaging platforms, **18** LLM providers, **~90** bundled skills + ~60 optional
> - Gateway on **port 8642** (local process); web backend server / dashboard on **port 9119**
> - Second task surface: `~/.agent-tasks` queue (JSONL), watched by a launchd worker

---

## Table of contents

1. [Architecture in one paragraph](#1-architecture-in-one-paragraph)
2. [Slash commands (priority)](#2-slash-commands-priority)
3. [Kanban — durable multi-agent board](#3-kanban--durable-multi-agent-board)
4. [Computer use / VM / desktop automation](#4-computer-use--vm--desktop-automation)
5. [Tasks — three surfaces](#5-tasks--three-surfaces)
6. [Memory](#6-memory)
7. [Skills](#7-skills)
8. [Cron & scheduling](#8-cron--scheduling)
9. [Agents, profiles, sessions, delegation](#9-agents-profiles-sessions-delegation)
10. [MCP & ACP](#10-mcp--acp)
11. [Gateway & messaging delivery](#11-gateway--messaging-delivery)
12. [Integration hooks for a desktop app](#12-integration-hooks-for-a-desktop-app)
13. [File paths & formats cheat sheet](#13-file-paths--formats-cheat-sheet)

---

## 1. Architecture in one paragraph

Hermes runs the **same agent core** (OpenAI-format messages + tool schemas, `AIAgent` in `run_agent.py`) across four surfaces: the **CLI/TUI** (`hermes chat`, `hermes --tui`), the **messaging gateway** (local process, port 8642; 21+ platforms), the **web backend server** (`hermes serve`, port 9119, JSON-RPC/WebSocket — powers the official desktop app), and the **dashboard** (`hermes dashboard`, port 9119, React SPA with plugin tabs). A central `COMMAND_REGISTRY` in `hermes_cli/commands.py` drives slash commands on CLI *and* gateway (help text, autocomplete, platform menus all derive from it). State lives in `~/.hermes/` (config.yaml, .env, sessions DB, memory, skills, kanban.db, checkpoints, logs). The gateway hosts the **kanban dispatcher** and the **cron scheduler**; workers are spawned as full `hermes -p <profile>` OS processes. *Verified: docs index + AGENTS.md in repo + hermes --help.*

---

## 2. Slash commands (priority)

Two surfaces, one registry: **interactive CLI/TUI** (`cli.py` dispatches, autocomplete on `/`) and **messaging gateway** (`gateway/run.py` dispatches; help/menus generated from the same registry). Installed **skills become dynamic slash commands** on both surfaces (`/<skill-name>`, e.g. `/plan`, `/gif-search`, `/github-pr-workflow`).

- Registry: `~/.hermes/hermes-agent/hermes_cli/commands.py` → `COMMAND_REGISTRY` (95 `CommandDef`s, verified count)
- Official reference: https://hermes-agent.nousresearch.com/docs/reference/slash-commands (local copy: `~/.hermes/hermes-agent/website/docs/reference/slash-commands.md`)
- Permissions: messaging platforms with user allowlists support an **admin/user split** — admins get every command, regular users get only `user_allowed_commands` (plus always-allowed `/help`, `/whoami`). Configure `allow_admin_from` / `user_allowed_commands` in the platform's `extra:` block in `~/.hermes/gateway-config.yaml`. *(Verified: slash-commands.md)*
- Alias resolution: prefix matching (`/h` → `/help`); full names and aliases win over prefixes. Case-insensitive.
- Quick commands: user-defined `/name` → shell exec or alias to another slash command, in `~/.hermes/config.yaml` under `quick_commands:`.

### 2.1 Session commands

| Command | Description |
|---|---|
| `/new [name]` (alias `/reset`) | Fresh session (new session ID + history). `now`/`--yes`/`-y` skips confirmation. |
| `/clear` | Clear screen and start a new session (CLI) |
| `/history` | Show conversation history (CLI) |
| `/save` | Save the current conversation (CLI) |
| `/prompt` (alias `/compose`) | Compose next prompt in `$EDITOR` (CLI) |
| `/retry` | Retry the last message |
| `/undo` | Remove the last user/assistant exchange |
| `/title [name]` | Set session title |
| `/compress [here [N] \| focus topic]` | Manually compress context (keep recent N turns verbatim) |
| `/rollback [N]` | List/restore filesystem checkpoints |
| `/diff [staged\|all\|session] [--stat] [path...]` | Git changes in working dir (`session` = cumulative Hermes diff) |
| `/snapshot [create\|restore <id>\|prune]` (alias `/snap`) | Create/restore state snapshots of Hermes config/state |
| `/stop` | Kill all running background processes |
| `/queue <prompt>` (alias `/q`) | Queue prompt for next turn (no interrupt) |
| `/steer <prompt>` | Inject mid-run note after next tool call (no interrupt) |
| `/goal <text>` | Standing goal w/ judge loop (Ralph-style). Sub: `status`, `pause`, `resume`, `clear` |
| `/subgoal <text>` | Append criteria to active goal. Sub: `remove <N>`, `clear` |
| `/heartbeat every <interval> <prompt>` (alias `/hb`) | Recurring idle prompt for this session. Sub: `status`, `pause`, `resume`, `clear` |
| `/refine [focus]` | Run background memory/skill self-improvement review now |
| `/moa <prompt>` | One prompt through Mixture-of-Agents preset, then restore model |
| `/resume [name]` | Resume a named session |
| `/sessions` (TUI alias `/switch`) | Browse/resume previous sessions (`/sessions new` in TUI) |
| `/egress [status]` | Docker egress proxy status |
| `/redraw` | Force full UI repaint (CLI) |
| `/status` | Session info + local session recap (model, tokens, files touched) |
| `/context [all]` (alias `/ctx`) | Context-window usage gauge + per-category breakdown |
| `/agents` (alias `/tasks`) | Active agents and running tasks dashboard |
| `/background <prompt>` (alias `/bg`, `/btw`) | Run prompt in a separate background session |
| `/branch [name]` (alias `/fork`) | Branch the current session |
| `/journey [list\|delete <id>\|edit <id>]` (aliases `/learning`, `/memory-graph`) | Learning-journey timeline of skills+memories (CLI/TUI/desktop) |
| `/handoff <platform>` | Hand session to a messaging platform (CLI) |
| `/start` | Platform-protocol ping ack (silent, no session burn) — gateway |
| `/topic [off\|help\|session-id]` | Telegram DM multi-session topic mode — gateway |
| `/sethome` (alias `/set-home`) | Mark this chat as platform home channel for deliveries — gateway |

### 2.2 Configuration commands

| Command | Description |
|---|---|
| `/config` | Show current configuration (CLI) |
| `/model [model-name]` | Switch model; `--global` persists to config.yaml; supports `provider:model`, `custom:name:model`, aliases |
| `/codex-runtime [auto\|codex_app_server\|on\|off]` | Toggle Codex app-server runtime for OpenAI/Codex models |
| `/personality [name]` | Set predefined personality overlay (`none` clears) |
| `/verbose` | Cycle tool progress display: off → new → all → verbose |
| `/focus [on\|off\|status]` | Reduced-output view (prompt + final answer only) |
| `/fast [normal\|fast\|status]` | OpenAI Priority Processing / Anthropic Fast Mode |
| `/reasoning [level\|show\|hide\|full\|clamp] [--global]` | Reasoning effort (none…ultra) + display |
| `/skin` | Show/change display theme (CLI) |
| `/statusbar` (alias `/sb`) | Toggle context/model status bar (CLI) |
| `/battery [on\|off\|status]` | Battery indicator in status bar (CLI) |
| `/voice [on\|off\|tts\|join\|channel\|leave\|status]` | Voice mode; Discord voice channels via join/channel/leave |
| `/yolo` | Toggle YOLO mode (skip dangerous-command approvals) |
| `/approvals [manual\|smart\|off]` | Persistent dangerous-command approval mode |
| `/footer [on\|off\|status]` | Gateway runtime-metadata footer on replies (model, context %, cwd) |
| `/busy [queue\|steer\|interrupt\|status]` | What Enter does while Hermes works (CLI) |
| `/indicator [kaomoji\|emoji\|unicode\|ascii]` | TUI busy-indicator style (CLI) |
| `/timestamps [on\|off\|status]` | `[HH:MM]` timestamps on messages/history (CLI) |
| `/wake [on\|off\|status]` | "Hey Hermes" wake-word listener (CLI) |

### 2.3 Tools & Skills commands

| Command | Description |
|---|---|
| `/tools [list\|disable\|enable] [name...]` | Manage tools for current session (disable → session reset) |
| `/toolsets` | List available toolsets (CLI) |
| `/browser [connect\|disconnect\|status]` | CDP connection to Chromium-family browser (default `http://127.0.0.1:9222`) |
| `/skills [pending\|approve\|reject\|diff\|approval]` | Search/install skills (CLI) + write-approval-gate review (both surfaces) |
| `/memory [pending\|approve\|reject\|approval]` | Review pending memory writes / toggle write-approval gate |
| `/bundles` | List skill bundles (`/<name>` aliases preloading multiple skills) |
| `/learn <what>` | Distill a reusable skill from anything (dirs, URLs, chat, notes) |
| `/init [notes]` | Generate/update `AGENTS.md` from repo scan |
| `/cron` | Manage scheduled tasks (list, add, edit, pause, resume, run, remove) |
| `/suggestions [accept\|dismiss N\|catalog\|clear]` (alias `/suggest`) | Review suggested automations |
| `/blueprint [name] [slot=value ...]` (alias `/bp`) | Set up automation from blueprint template |
| `/curator [status\|run\|pin\|archive]` | Background skill maintenance controls |
| `/kanban <action>` | Full board surface in chat (see §3); bypasses running-agent guard |
| `/reload-mcp` (alias `/reload_mcp`) | Reload MCP servers from config |
| `/reload-skills` (alias `/reload_skills`) | Re-scan `~/.hermes/skills/` |
| `/reload` | Reload `.env` into running session (CLI) |
| `/plugins` | List installed plugins and status (CLI) |
| `/pet [list\|<slug>]` | Toggle/adopt a petdex mascot |
| `/hatch <description>` (alias `/generate-pet`) | Generate a new petdex pet from description |

### 2.4 Info commands

| Command | Description |
|---|---|
| `/help` | Show help |
| `/version` | Version, build, environment |
| `/whoami` | Slash-command access level (admin/user) |
| `/usage` | Token usage, cost, account limits |
| `/topup` | Nous balance + billing on portal |
| `/subscription` (alias `/upgrade`) | Nous plan view/change (CLI) |
| `/insights [days]` | Usage analytics |
| `/update` | Update Hermes Agent |
| `/platforms` (alias `/gateway`) | Gateway platform status (CLI) |
| `/platform [list\|pause\|resume] [name]` | Operate a gateway platform from chat (gateway) |
| `/commands [page]` | Browse all commands + skills, paginated (gateway) |
| `/copy [number]` | Copy last assistant response to clipboard (CLI) |
| `/paste` | Attach clipboard image (CLI) |
| `/image <path>` | Attach local image for next prompt (CLI) |
| `/debug` | Upload debug report (system info + logs), shareable links |
| `/profile` | Active profile name + home directory |
| `/approve [session\|always]` | Approve pending dangerous command (gateway) |
| `/deny` | Reject pending dangerous command (gateway) |
| `/restart` | Gracefully restart gateway (gateway) |

### 2.5 Exit

| Command | Description |
|---|---|
| `/quit` (also `/exit`) | Exit CLI |

### 2.6 Surface matrix (which commands exist where)

*Verified: slash-commands.md "Notes" section.*
- **CLI-only:** `/skin`, `/snapshot`, `/reload`, `/tools`, `/toolsets`, `/browser`, `/config`, `/cron`, `/platforms`, `/paste`, `/image`, `/statusbar`, `/battery`, `/focus`, `/plugins`, `/busy`, `/indicator`, `/wake`, `/journey`, `/redraw`, `/clear`, `/history`, `/save`, `/copy`, `/handoff`, `/prompt`, `/pet`, `/hatch`, `/timestamps`, `/subscription`, `/quit`
- **Messaging-only:** `/sethome`, `/restart`, `/approve`, `/deny`, `/topic`, `/platform`, `/commands`, `/start`
- **Both:** `/status`, `/egress`, `/version`, `/whoami`, `/background`, `/queue`, `/steer`, `/voice`, `/reload-mcp`, `/reload-skills`, `/rollback`, `/diff`, `/debug`, `/fast`, `/approvals`, `/footer`, `/curator`, `/kanban`, `/topup`, `/suggestions`, `/blueprint`, `/learn`, `/init`, `/sessions`, `/yolo`, `/goal`, `/subgoal`, `/heartbeat`, `/refine`, `/moa`, `/branch`, `/agents`, `/context`, `/memory`, `/model`, `/personality`, `/reasoning`, `/compress`, `/title`, `/resume`, `/usage`, `/insights`, `/whoami`, `/update`
- Slack threads: native slash blocked → use `!` prefix (`!stop`, `!new`, `!status`)

---

## 3. Kanban — durable multi-agent board

The flagship multi-agent coordination feature. **Durable SQLite task board shared across all Hermes profiles** — a message queue + state machine where every handoff is a row anyone can read/write. Each worker is a full OS process (`hermes -p <profile>` with its own identity and memory).

- **Docs:** https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban (reference), `…/kanban-tutorial` (narrative); design spec `docs/hermes-kanban-v1-spec.pdf` in repo
- **Local state:** `~/.hermes/kanban.db` (verified present on this box, 716 KB, WAL mode) — tables: `tasks`, `task_comments`, `task_links`, `task_events` (append-only, monotonic id), `task_runs`, `task_attachments`, `kanban_notify_subs`, `minion_metrics` *(verified: sqlite3 .tables)*

### 3.1 Data model

- **Board** — queue of tasks with own SQLite DB + workspaces dir + dispatcher. Single default board (`default`) at `~/.hermes/kanban.db` (back-compat); named boards at `~/.hermes/kanban/boards/<slug>/kanban.db`. Board resolution: `--board` flag → `HERMES_KANBAN_BOARD` env → `~/.hermes/kanban/current` → `default`.
- **Task** — row: title, optional body, **one assignee (a profile name)**, status `triage | todo | ready | running | blocked | review | done | archived`, optional tenant, optional idempotency key, optional `scheduled_at`, `model_override`, per-task `skills[]`, `max_retries`, `max_runtime_seconds`. ID format `t_abc123`.
- **Link** — `task_links` parent→child dependency; dispatcher promotes `todo → ready` when all parents `done`. Parent link doubles as **context handoff**: completed parent's `summary` + `metadata` are injected into the child's worker context verbatim.
- **Comment** — inter-agent protocol; a respawned worker reads the full thread.
- **Run** — one attempt row in `task_runs`; `summary` (human) + `metadata` (machine JSON) structured handoff live on the run; retries read prior attempts.
- **Workspace kinds:** `scratch` (default, tmp under `~/.hermes/kanban/workspaces/<id>/`, deleted on completion unless `kanban_complete(artifacts=[...])`), `dir:<abs-path>` (preserved), `worktree[:<path>]` (git worktree under `.worktrees/<id>/`, preserved).
- **Attachments:** `<hermes-home>/kanban/attachments/<task_id>/` (25 MB/file cap); paths injected into worker context.

### 3.2 Dispatcher

Runs **inside the gateway** by default (`kanban.dispatch_in_gateway: true`, tick every 60 s). Claims atomically, spawns assigned profiles with `HERMES_KANBAN_TASK` + `HERMES_KANBAN_WORKSPACE` + `HERMES_KANBAN_BOARD` env; auto-blocks after `kanban.failure_limit` (default 2) consecutive spawn failures; crash/stale/TTL reclamation; `protocol_violation` detection (worker exited without `kanban_complete`/`kanban_block` — bounded retry 3, then auto-block). Standalone `hermes kanban daemon` is deprecated.

### 3.3 Driving the board — three surfaces, one `kanban_db` kernel

1. **Model tools** (worker/orchestrator): 12 `kanban_*` tools — `kanban_show`, `kanban_list`, `kanban_complete(summary, metadata)`, `kanban_request_review`, `kanban_request_changes`, `kanban_block(kind=…)`, `kanban_heartbeat`, `kanban_comment`, `kanban_attach`, `kanban_attach_url`, `kanban_attachments`, `kanban_create`, `kanban_link`, `kanban_unblock` (14 tool entries incl. orchestrator-only ones). Toolset auto-enabled for dispatcher-spawned workers via `HERMES_KANBAN_TASK`; orchestrator profiles enable `kanban` toolset in config. Workers **never** shell out to the CLI.
2. **CLI**: `hermes kanban <verb>` — 45 verbs (verified `hermes kanban --help`): `init, boards, create, swarm, list/ls, show, assign, set-model, reclaim, reassign, diagnostics/diag, link, unlink, claim, comment, attach, attachments, attach-rm, complete, edit, block, schedule, unblock, request-review, request-changes, reopen-review, promote, archive, tail, dispatch, daemon, watch, stats, notify-subscribe, notify-list, notify-unsubscribe, log, runs, heartbeat, assignees, context, specify, decompose, gc, repair`. Idempotent create via `--idempotency-key`; `--json` for machine output; bulk verbs accept multiple ids.
3. **Slash command**: `/kanban <action>` — identical argparse surface as CLI, in chat (CLI + gateway). Bypasses the running-agent guard (works mid-turn). `/kanban create` auto-subscribes originating chat to terminal events (gateway).
4. **Dashboard REST** (bonus): plugin under `/api/plugins/kanban/*` (see §12) — board, tasks CRUD, bulk ops, specify/decompose LLM endpoints, profiles, orchestration settings, worker visibility, WebSocket event tail.

### 3.4 Key workflows

```bash
# Human-side quick start
hermes kanban init                 # create kanban.db (idempotent)
hermes gateway start               # dispatcher runs inside the gateway
hermes kanban create "research AI funding" --assignee researcher
hermes kanban watch                # live event stream
hermes kanban stats                # per-status + per-assignee counts

# Idempotent automation/webhook create
hermes kanban create "nightly ops review" --assignee ops \
    --idempotency-key "nightly-ops-$(date -u +%Y-%m-%d)" --json

# Orchestrator (from the model): fan-out + dependency graph
kanban_create(title="research ICP, NA", assignee="researcher-a")
kanban_create(title="synthesize launch brief", assignee="writer", parents=["t_r1","t_r2"])
kanban_complete(summary="decomposed into 2 research tasks + 1 writer")

# Worker lifecycle (from the model, injected guidance)
kanban_show() → do work in $HERMES_KANBAN_WORKSPACE →
kanban_heartbeat(note=...) → kanban_complete(summary=..., metadata={...})

# Swarm topology (one-shot parallel graph)
hermes kanban swarm "Design failover plan" \
    --workers researcher,architect,sre --verifier reviewer --synthesizer writer

# Per-task model pin + skills
hermes kanban create "hard refactor" --assignee coder \
    --model claude-opus-4.6 --provider anthropic --skill github-code-review
hermes kanban set-model t_abcd claude-opus-4.6 --provider anthropic
```

Config knobs (all under `kanban:` in `~/.hermes/config.yaml`): `dispatch_in_gateway` (true), `dispatch_interval_seconds` (60), `review_dispatch` (true), `failure_limit` (2), `auto_decompose` (true), `auto_decompose_per_tick` (3), `orchestrator_profile`, `default_assignee`, `max_in_progress`, `max_in_progress_per_profile`, `auto_promote_children` (true), `default_workdir`, `dispatch_stale_timeout_seconds` (4 h), `reconcile_orphans` (true). Aux LLM slots: `auxiliary.kanban_decomposer`, `auxiliary.triage_specifier`, `auxiliary.profile_describer`. Lifecycle plugin hooks: `kanban_task_claimed`, `kanban_task_completed`, `kanban_task_blocked`.

**Single-host by design** — `kanban.db` is a local SQLite file; no cross-host coordination. *(Verified: kanban docs "Out of scope".)*

---

## 4. Computer use / VM / desktop automation

- **Toolset:** `computer_use` — background desktop control via **cua-driver** (macOS/Windows/Linux): screenshots (SOM/vision/AX modes), click/drag/scroll/type/key/wait by element index or pixel, `list_apps`, `focus_app`. **Does not steal cursor/keyboard focus** (background delivery; foreground escalation ladder exists for stubborn apps). Works with any tool-capable model. *(Verified: local tools-reference.md §computer_use + `hermes tools list` shows it enabled)*
- **Backend management:** `hermes computer-use {install,status,doctor,permissions}` — installs cua-driver binary, runs `health_report`, grants macOS Accessibility + Screen Recording. *(Verified: `hermes computer-use --help`)*
- **Browser control:** `browser` toolset — CDP attach to Chromium-family (`/browser connect`, default `http://127.0.0.1:9222`), Browserbase/Camofox/local Chromium backends.
- **VM/remote execution:** the **terminal** tool supports 6 backends — local, Docker, SSH, Daytona, Singularity, Modal (docs: "Runs anywhere, not just your laptop"). This is the layer MaiaVM's per-agent VM model maps onto (see `docs/REVERSE_ENGINEERING.md`: Instance ↔ Hetzner VM via hermes-deploy; noVNC `getComputerUrl(instanceId)` for the live computer pane).
- **Desktop surface of Hermes itself:** `hermes desktop`/`hermes gui` builds/launches the native desktop app; `hermes serve` is the headless JSON-RPC/WS backend it talks to (port 9119) — *the* integration hook for embedding (see §12). Desktop sessions get extra tools: `read_terminal`, `close_terminal`, `open_preview`, `read_preview`, `read_window_below`, `focus_pane`, `react_to_message` + `project` tools (`desktop_ui`/`project` toolsets). *(Verified: tools-reference.md)*
- Related media tools: `vision_analyze`, `image_generate`, `text_to_speech`, `video_analyze`, `video_generate`, `xai_video_edit`, `xai_video_extend`, `x_search` (X/Twitter), spotify.

---

## 5. Tasks — three surfaces

1. **`todo` toolset** — in-session task planning (`todo` tool; per-session TodoStore; subagents get fresh isolated stores; parent can pre-populate via `initial_todos`). *(Verified: hermes-agent skill contributor notes)*
2. **`delegate_task`** (delegation toolset) — RPC-style fork→join subagents. Children default toolsets `["terminal","file","web","todo"]`; always-denied: `delegation, clarify, memory, code_execution`. Child inherits intersection of parent toolsets. Use for short reasoning answers; **not** durable. *(Verified: skill + docs delegation page)*
3. **`~/.agent-tasks` queue** — host-level shared task queue, independent of Hermes core: CLI at `~/.agent-tasks/bin/task`, append-only JSONL log at `~/.agent-tasks/tasks.jsonl`, agents registry `~/.agent-tasks/agents.json`, replies dir, launchd worker (`com.devgwardo.task-worker.hermes-local.plist`, verified on this box). Task ids `t-xxxxxxxx`. Worker opens a Hermes session per task; agent signals `<<<TASK_COMPLETE>>>` / `<<<TASK_ASK>>>` / `<<<TASK_CONTINUE>>>`; 20-turn cap. Subcommands: `add`, `list [--open|--done]`, `show`, `reply`, `cancel`, `agent list|add|remove`. Also exposed as LLM tools (`task_queue_*`) and slash `/tasks`. *(Verified: task-queue skill + files on disk)*

---

## 6. Memory

- **Built-in:** `memory` toolset — agent-curated long-term memory. Files at `~/.hermes/memory/` incl. `MEMORY.md` (agent knowledge); FTS5 cross-session recall (`session_search` toolset) with LLM summarization; write-approval gate (`memory.write_approval` in config) reviewable via `/memory pending|approve|reject|approval`. SQLite store `~/.hermes/memory_store.db` (verified present). *(Verified: docs memory page + disk)*
- **`hermes memory`** CLI: `hermes memory setup|status|off` — configure external providers: Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory. `hermes honcho setup/status` for Honcho.
- **Learning journey:** `hermes journey` CLI (alias `learning`, `memory-graph`) + `/journey` — timeline of learned skills + memories.
- **Refine loop:** `/refine` runs background memory/skill self-improvement review.
- **Context files** (not memory per se, but injected context): `.hermes.md`, `AGENTS.md`, `CLAUDE.md`, global `SOUL.md` (personality), `.cursorrules`; `@-syntax` inline context references.

---

## 7. Skills

- **Location:** `~/.hermes/skills/` (per-profile: `~/.hermes/profiles/<name>/skills/`). Format: `SKILL.md` (YAML frontmatter + markdown) + optional `references/`, `templates/`, `scripts/`.
- **CLI:** `hermes skills list|search|install|inspect|config|check|update|uninstall|publish|browse`; `hermes skills tap add <repo>`; `hermes sync` (skill sync across devices/team); `hermes bundles` (aliases preloading multiple skills).
- **Runtime:** skills are on-demand, progressive-disclosure documents; agent loads via `skill_view` when relevant. `/skill <name>` loads explicitly; `hermes -s <name>` preloads; any installed skill = dynamic `/<name>` slash command.
- **Curator:** `hermes curator status|run|pause|pin` — background maintenance (usage tracking, staleness, archival, LLM review).
- **Hub:** agentskills.io-compatible; ~90 bundled + ~60 optional (docs skills-catalog). Writing gated by `skills.write_approval` (`/skills pending|approve|reject|diff`).

---

## 8. Cron & scheduling

- **CLI:** `hermes cron {list,create,add,edit,pause,resume,run,remove,rm,delete,status,runs,history,notepad,tick}`. Schedule formats: `'30m'`, `'every 2h'`, cron `'0 9 * * *'`. `--accept-hooks` flag for headless approval. *(Verified: `hermes cron --help`)*
- **Slash:** `/cron` (list, add, edit, pause, resume, run, remove) — CLI only.
- **Model tool:** `cronjob` toolset — agent can create/manage jobs mid-session.
- **Delivery:** `Deliver: local | origin | <platform>` — scripts (`no-agent` mode, stdout delivered) or agent runs; jobs carry skills; durable notepad (KV across runs); `runs`/`history` shows execution attempts.
- **Live on this box** (verified `hermes cron list`): cheeksbase-maintenance, ig-db-backup-clone, overnight-audit + more.
- Related: **suggested automations** (`/suggestions`), **blueprints** (`/blueprint`), **webhooks** (`hermes webhook subscribe/list/remove/test` — `POST /webhooks/<name>` triggers agent runs), **session heartbeats** (`/heartbeat`, in-session, non-durable).

---

## 9. Agents, profiles, sessions, delegation

- **Profiles:** isolated Hermes instances. `hermes profile {list,create,use,delete,show,alias,rename,export,import}`. Per-profile `config.yaml`, `.env`, skills, memory, sessions, `SOUL.md` (identity). `HERMES_HOME` is injected per profile by the kanban dispatcher. Decomposer routes work to profiles by description (`hermes profile describe <name> --text|--auto`).
- **Sessions:** SQLite-backed (`hermes_state.py`). `hermes sessions {list,browse,export,rename,delete,prune,stats}`; `hermes --resume <id>`, `hermes --continue`. Session files: `~/.hermes/sessions/` (JSON dumps verified on disk) + session DB. `@session:profile/id` links.
- **Subagents:** `delegate_task` + `/agents` dashboard (`/agents tree` = spawn-tree); **spawning whole Hermes processes** for long missions: `hermes chat -q "…"` (one-shot), tmux+PTY for interactive, `-w/--worktree` to avoid git conflicts, `--continue/--resume` for pick-up. `hermes status --all` shows component state; `hermes pause`/`hermes resume` = global emergency stop (cron + kanban dispatch + new gateway turns).
- **Multi-agent rooms/swarms** via SOUL.md + brain/agent-chat-room MCP (this box runs `brain` MCP with 65 tools).
- **`delegate_task` vs Kanban** (docs table): RPC fork→join vs durable queue; anonymous vs named profiles; no resumability vs block→unblock; hierarchical vs peer.

---

## 10. MCP & ACP

- **MCP client:** `hermes mcp add NAME (--url|--command)`, `remove`, `list`, `test`, `configure` (tool selection). Tool filtering + utility-tool policy (docs `reference/mcp-config-reference`). 19 MCP servers live on this box (verified `hermes tools list`): brain, agent-chat-room, banger, chrome-data, claude-code-as-mcp, claude-codex-bridge, cursor-workflow-memory, design-tokens, devctx, google-stitch-mcp, pencil, phaser-debug, session-search, shinic, town-data, xapi, xdocs, higgsfield, agent-cli-bridge.
- **MCP server mode:** `hermes mcp serve` — run Hermes itself as an MCP server.
- **ACP:** `hermes acp` — Agent Client Protocol server for ACP-compatible editors/platforms (docs `features/acp`).

---

## 11. Gateway & messaging delivery

- **Management:** `hermes gateway {run,start,stop,restart,status,install,uninstall,list,setup,migrate-legacy,enroll}` — launchd/systemd service; `hermes gateway list` shows per-profile gateway status. Port **8642** is the local gateway process. *(Verified: `hermes gateway --help` + skill)*
- **Platforms (21+):** Telegram, Discord, Slack, WhatsApp (+Business Cloud), Signal, Email (IMAP/SMTP), SMS (Twilio), Matrix, Mattermost, Home Assistant, DingTalk, Feishu, WeCom, Weixin, QQ Bot, Yuanbao, BlueBubbles, Microsoft Teams, Google Chat, LINE, Raft, Webhooks + **API server** (OpenAI-compatible endpoint for any frontend — docs `features/api-server`). IRC/Teams via plugins.
- **Delivery:** `hermes send [-t platform[:chat[:thread]]] [message]` — scriptable push to any configured platform, no gateway/LLM needed for bot-token platforms (verified help). Home-channel concept via `/sethome`; DM pairing (`hermes pairing list/approve/revoke`); allowlists (`TELEGRAM_ALLOWED_USERS` etc. in `.env`).
- **Busy-input modes** (`display.busy_input_mode`): `interrupt` (default), `queue`, `steer`, `concurrent` (forks session, parallel agent, `⚡` prefix). Per-platform streaming config separate from CLI streaming.

---

## 12. Integration hooks for a desktop app

Ranked by fit for MaiaVM desktop (verified surfaces):

1. **`hermes serve` — headless backend server (port 9119, 127.0.0.1 default).** "The JSON-RPC/WebSocket gateway the desktop app and remote clients connect to." Flags: `--port`, `--host`, `--skip-build`, `--isolated` (per-profile server), `--stop`, `--status`, `--ssh-session-token-file`, `--ssh-owner-nonce`. Auth required for non-loopback binds (password or OAuth; `--insecure` is a no-op since June 2026 hardening). *(Verified: `hermes serve --help`)*
2. **`hermes dashboard` — web UI on the same port 9119.** React SPA: config, API keys, sessions, kanban tab. Extensible via **dashboard plugins** (`plugins/<name>/dashboard/manifest.json`; docs `features/extending-the-dashboard`). Kanban plugin REST surface (verified in kanban docs):
   - `GET /api/plugins/kanban/board?tenant=…&include_archived=…` — board grouped by status
   - `GET /api/plugins/kanban/tasks/:id` — task + comments + events + links + `runs[]`
   - `POST /api/plugins/kanban/tasks` — create (`triage: bool`, `parents: [id,…]`)
   - `PATCH /api/plugins/kanban/tasks/:id` — status/assignee/priority/title/body/result
   - `POST /api/plugins/kanban/tasks/bulk` — batch patch on `ids[]`
   - `POST /api/plugins/kanban/tasks/:id/comments|specify|decompose`
   - `GET/PATCH /api/plugins/kanban/profiles`, `POST …/describe-auto`
   - `GET/PUT /api/plugins/kanban/orchestration`
   - `POST /api/plugins/kanban/links`, `DELETE …/links?parent_id=&child_id=`
   - `POST /api/plugins/kanban/dispatch?max=&dry_run=` — nudge dispatcher
   - `GET /api/plugins/kanban/config` — dashboard.kanban prefs
   - `WS /api/plugins/kanban/events?since=<event_id>&token=…` — live event tail
   - `GET /api/plugins/kanban/workers/active`, `GET /api/plugins/kanban/runs/{id}`, `POST …/runs/{run_id}/terminate`, `GET …/inspect`
   - ⚠️ **Plugin routes are unauthenticated** (dashboard auth middleware skips `/api/plugins/`) — localhost-only by default; never bind `--host 0.0.0.0` on shared hosts.
3. **Notification bus — desktop consume contract (B3, #17).** Server routes (contract, client feature-detected — not CLI-verified): `GET /api/notifications?since=` (probed via GET, never OPTIONS — the dashboard proxy answers OPTIONS 204 even for absent routes) and `POST /api/notifications/read` (`{ids}`). Item shape: `{id, source?, kind?, title, url?, repo?, at?, read?}`; `kind` contract is `pr | issue | ci` (PR opened/updated/merged, issue events, CI pass/fail carried in the title text). Anything else (push, comment, future kinds) renders under the All filter only, never dropped. Desktop behavior (verified in `src/components/NotificationsBell.tsx` + `src/lib/notifications.ts`): unread dot + mark-read (local + server write), deep-link via `url`, kind filter chips (All/PRs/CI/Issues) with CI pill rendering, 60s visible-tab-only background poll, exponential backoff (60s doubling, 10min cap) on consecutive failed reads — 429s surface as failed reads because the bus layer drops HTTP status/`Retry-After` headers, so backoff is failure-count based, not header-driven. Zero network while the probe caches unsupported. Local mirror in `localStorage` (`maia:notifications:v1`, newest 100) keeps the bell useful offline.
4. **`hermes chat -q "…"` — one-shot CLI invocation** (non-interactive). `--model`, `--provider`, `-t toolsets`, `--resume`, `-p profile`, `--yolo`, `--accept-hooks`. Fire-and-forget agent runs from any host process.
5. **`hermes kanban …` CLI (45 verbs, `--json`)** — machine-controllable board (see §3).
6. **`~/.agent-tasks/bin/task`** — queue CLI with `--json`-friendly output; JSONL at `~/.agent-tasks/tasks.jsonl` (event-record format: `{"event","id","desc","agent","tags","ts"}`, verified sample). Launchd worker runs tasks through a Hermes session.
7. **`hermes send`** — push notifications to user chats from the app.
8. **`hermes cron` + `hermes webhook`** — schedule app jobs; `POST /webhooks/<name>` HTTP triggers.
9. **Embedding as a Python library** — `from run_agent import AIAgent` (add `~/.hermes/hermes-agent` to sys.path first). `AIAgent(enabled_toolsets=[…], callbacks=…)` — **register custom tools in `tools.registry` BEFORE constructing the agent** (tool discovery happens in `__init__`); constructor kwargs drift between versions (known-safe: `base_url, api_key, provider, model, max_iterations, enabled_toolsets, quiet_mode, platform, stream_delta_callback, tool_start_callback, tool_complete_callback, reasoning_callback, step_callback, status_callback`; do NOT pass `skip_context_files/skip_memory/persist_session` as of v0.8). *(Verified: hermes-agent skill contributor guide)*
10. **MCP/ACP modes** — `hermes mcp serve` (expose agent as MCP server), `hermes acp` (ACP server for editors).
11. **OpenAI-compatible API server** — gateway platform `api_server` (docs `features/api-server`) exposes chat completions for any frontend.
12. **`hermes proxy`** — local OpenAI-compatible proxy to OAuth providers (CLI subcommand).
13. **`hermes status`, `hermes monitor`… `hermes logs`** — health (`hermes doctor`), component status, log viewing (`~/.hermes/logs/{gateway,agent,errors}.log`).

---

## 13. File paths & formats cheat sheet

| Path | Contents |
|---|---|
| `~/.hermes/config.yaml` | Main config (model, toolsets, kanban:, cron, memory, display, aux models, quick_commands, model_aliases, bundles) |
| `~/.hermes/.env` | Secrets/API keys only (write-protected from agent edit tools) |
| `~/.hermes/gateway-config.yaml` | Gateway platform configs + allowlists |
| `~/.hermes/kanban.db` | Board DB (default board; SQLite WAL; tables: tasks, task_comments, task_links, task_events, task_runs, task_attachments, kanban_notify_subs, minion_metrics) |
| `~/.hermes/kanban/` | `.dispatcher.lock`, `logs/`, `workspaces/`, `boards/<slug>/` (named boards), `attachments/<task_id>/` |
| `~/.hermes/kanban/current` | Active board slug |
| `~/.hermes/skills/` | Installed skills (`SKILL.md` + refs/templates/scripts) |
| `~/.hermes/profiles/<name>/` | Per-profile config.yaml, .env, skills/, memory/, sessions/, SOUL.md |
| `~/.hermes/memory/` | `MEMORY.md` + topic .md files; `~/.hermes/memory_store.db` (SQLite) |
| `~/.hermes/sessions/` | Session JSON dumps; session DB via `hermes_state.py` |
| `~/.hermes/checkpoints/` | Filesystem checkpoints (`/rollback`, `/snapshot`) |
| `~/.hermes/plugins/` | User plugins (hooks, tools, dashboard plugins) |
| `~/.hermes/logs/` | `gateway.log`, `agent.log`, `errors.log` |
| `~/.hermes/cache/` | web_extract cache etc. |
| `~/.agent-tasks/` | `tasks.jsonl` (append-only JSONL), `agents.json`, `replies/`, `logs/`, `bin/task` |
| `~/.hermes/hermes-agent/` | Source checkout (CLI, gateway, cron, tools, website/) |

---

## Source map (what was verified where)

- **Slash commands:** official reference (local copy `website/docs/reference/slash-commands.md`, full read) + registry count `grep -c 'CommandDef(' hermes_cli/commands.py` = 95 + full CommandDef list extracted from `hermes_cli/commands.py`.
- **Kanban:** full kanban docs page (fetched, 87.5 KB read end-to-end) + `hermes kanban --help` + `sqlite3 ~/.hermes/kanban.db .tables`.
- **CLI:** `hermes --help` (70 subcommands listed verbatim), `hermes cron --help`, `hermes computer-use --help`, `hermes serve/dashboard/send/gateway --help`.
- **Tools:** `hermes tools list` (live enablement incl. 19 MCP servers) + local `website/docs/reference/tools-reference.md` (~83 tools).
- **Local state:** `~/.hermes/kanban.db` present (716 KB), `~/.hermes/memory_store.db`, `~/.agent-tasks/` with `tasks.jsonl`, live cron jobs, 8+ profiles.
- **Inferred (marked in doc):** anything not in the above, e.g. some §12 architecture claims flagged as such.
