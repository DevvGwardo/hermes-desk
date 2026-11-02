# maiavm proxy & VM image hardening spec

Status: **2026-09-26**, spec for the maiavm.com server and the hermes-deploy VM
image. Companion to `docs/hermes-saas-coverage.md` §2 (items S1–S6). The desktop
app already enforces §1–§3 client-side (`electron/dashboard-routes.cjs`,
`src/lib/agent-config.ts`, `src/lib/messaging.ts`), but a client check is
advisory: anyone holding a desktop token can call the proxy directly. Every
rule below must be enforced **server-side**.

Terms: *proxy* = `https://www.maiavm.com/api/instances/{id}/dashboard/*`, which
forwards to the VM's hermes dashboard (`/api/*`). *Dashboard token* = the one
session token the hermes dashboard accepts; it grants every route, so the proxy
and network rules are the only thing standing between a user and the platform
secrets on the VM.

## 1. Route allowlist (S1)

The proxy must forward **only** the routes below, matched on method + path, and
answer everything else with `403 {"error": "blocked by Nub Agent"}` without
contacting the VM. This table is generated from `electron/dashboard-routes.cjs`
(`DASHBOARD_ROUTES`) and must stay identical to it —
`src/lib/__tests__/maiavm-proxy-spec.test.ts` fails if a route is missing here.

Matching rules (same as the app):

- Strip the query string; match the path only.
- Refuse non-canonical paths before matching: `..`, `.`, empty segments (`//`),
  trailing `/`, backslashes, NUL, and percent-encoded `.` `/` `\` NUL
  (`%2e`, `%2f`, `%5c`, `%00`, any case).
- `:x` = exactly one non-empty path segment. `**` (last segment only) = zero or
  more further segments.
- The deny list (§1.2) is checked **first** and wins over any allow entry.
- WebSocket upgrades are denied except `GET /api/ws` (chat) — and never
  `/api/pty`, `/api/console`, `/api/events`, `/api/pub`,
  `/api/audio/speak-stream`.

### 1.1 Allowed (method, path)

| Methods | Path |
|---|---|
| GET | `/api/status` |
| GET | `/api/health` |
| GET | `/api/system/stats` |
| GET | `/api/analytics/usage` |
| GET | `/api/logs` |
| GET | `/api/hermes/update/check` |
| GET | `/api/actions/:x/status` |
| GET, PUT | `/api/config` |
| GET, PUT, DELETE | `/api/env` |
| GET | `/api/ws` |
| GET, POST | `/api/skills` |
| PUT | `/api/skills/toggle` |
| GET | `/api/skills/content` |
| GET | `/api/skills/hub/official` |
| GET | `/api/skills/hub/search` |
| GET | `/api/skills/hub/preview` |
| GET | `/api/skills/hub/scan` |
| POST | `/api/skills/hub/install` |
| POST | `/api/skills/hub/uninstall` |
| POST | `/api/skills/hub/update` |
| GET, POST | `/api/cron/jobs` |
| GET, PUT, DELETE | `/api/cron/jobs/:x` |
| POST | `/api/cron/jobs/:x/pause` |
| POST | `/api/cron/jobs/:x/resume` |
| POST | `/api/cron/jobs/:x/trigger` |
| GET | `/api/cron/jobs/:x/runs` |
| GET | `/api/cron/delivery-targets` |
| GET | `/api/cron/blueprints` |
| POST | `/api/cron/blueprints/instantiate` |
| GET | `/api/memory` |
| GET | `/api/memory/pending` |
| POST | `/api/memory/pending/:x/approve` |
| POST | `/api/memory/pending/:x/reject` |
| POST | `/api/memory/reset` |
| PUT | `/api/memory/provider` |
| GET, PUT | `/api/memory/providers/:x/config` |
| POST | `/api/memory/providers/:x/setup` |
| POST | `/api/memory/providers/:x/oauth/start` |
| GET | `/api/memory/providers/:x/oauth/status` |
| GET, POST | `/api/mcp/servers` |
| DELETE | `/api/mcp/servers/:x` |
| POST | `/api/mcp/servers/:x/test` |
| POST | `/api/mcp/servers/:x/auth` |
| PUT | `/api/mcp/servers/:x/enabled` |
| GET | `/api/mcp/catalog` |
| POST | `/api/mcp/catalog/install` |
| GET, DELETE | `/api/mcp/oauth/flows/:x` |
| GET | `/api/messaging/platforms` |
| PUT | `/api/messaging/platforms/:x` |
| POST | `/api/messaging/platforms/:x/test` |
| GET, POST, DELETE | `/api/messaging/telegram/onboarding/**` |
| GET, POST, DELETE | `/api/messaging/whatsapp/onboarding/**` |
| GET | `/api/pairing` |
| POST | `/api/pairing/approve` |
| POST | `/api/pairing/revoke` |
| POST | `/api/pairing/clear-pending` |
| POST | `/api/pairing/deny` |
| POST | `/api/gateway/restart` |
| POST | `/api/gateway/start` |
| POST | `/api/gateway/stop` |
| GET, POST | `/api/profiles` |
| PATCH, DELETE | `/api/profiles/:x` |
| GET, PUT | `/api/profiles/:x/soul` |
| PUT | `/api/profiles/:x/description` |
| GET | `/api/sessions` |
| GET | `/api/sessions/search` |
| GET, PATCH, DELETE | `/api/sessions/:x` |
| GET | `/api/sessions/:x/messages` |
| GET | `/api/sessions/:x/mutation-snapshot` |
| GET | `/api/sessions/:x/export` |
| GET | `/api/tools/toolsets` |
| PUT | `/api/tools/toolsets/:x` |
| GET | `/api/tools/toolsets/:x/config` |
| PUT | `/api/tools/toolsets/:x/env` |
| GET | `/api/tools/computer-use/status` |
| GET | `/api/computer/status` |
| GET | `/api/computer/screenshot` |
| GET, POST, PUT, PATCH, DELETE | `/api/plugins/kanban/**` |
| POST | `/api/ops/doctor` |
| POST | `/api/ops/security-audit` |
| GET | `/api/transcripts/tail` |
| GET | `/api/notifications` |
| POST | `/api/notifications/read` |
| GET, POST, DELETE | `/api/instances/:x/resize` |
| GET, POST, DELETE | `/api/instances/:x/browser/jobs/**` |

Note: `/api/instances/:x/resize` and `/api/instances/:x/browser/jobs/**` are
listed because the app falls back to the dashboard for them when the platform
route is unavailable; the platform may serve them itself instead.

### 1.2 Always denied (even if an allow entry is added later)

| Methods | Path |
|---|---|
| any | `/api/env/reveal` |
| any | `/api/config/raw` |
| any | `/api/model/**` |
| any | `/api/providers/**` |
| any | `/api/credentials/**` |
| any | `/api/tools/terminal/**` |
| any | `/api/tools/toolsets/:x/post-setup` |
| any | `/api/tools/toolsets/:x/provider` |
| any | `/api/tools/toolsets/:x/model` |
| any | `/api/tools/toolsets/:x/models` |
| any | `/api/ops/hooks` |
| any | `/api/ops/import` |
| any | `/api/ops/backup` |
| any | `/api/ops/backup/**` |
| any | `/api/ops/import-upload` |
| any | `/api/ops/debug-share` |
| any | `/api/ops/config-migrate` |
| any | `/api/ops/dump` |
| POST | `/api/hermes/update` |
| any | `/api/dashboard/agent-plugins/**` |
| any | `/api/local-models/**` |
| any | `/api/profiles/:x/open-terminal` |
| any | `/api/pty` |
| any | `/api/console` |

Additionally denied by omission (not in §1.1), called out because they are
dangerous: `/api/webhooks*`, `/api/dashboard/theme|font|plugin-providers`,
`/api/dashboard/plugins/**`, `/api/profiles/:x/model`,
`/api/profiles/:x/setup-command`, `/api/profiles/:x/export`,
`/api/profiles/import`, `/api/profiles/active`, `/api/sessions/import`,
`/api/sessions/bulk-delete`, `/api/sessions/prune`, `/api/ops/checkpoints/prune`,
`/api/ops/prompt-size`, `/api/curator/*`, `/api/learning/*`, `/api/git/**`,
`/api/files*` (except the fs remap below), `/api/media`, `/api/chat/image-upload`,
`/api/skills/content` (PUT), `/api/mcp/servers` (PUT), `/api/memory/providers/:x/…`
beyond §1.1, `/api/tools/computer-use/permissions/grant`, `/api/egress/status`,
`/api/ssh/ownership`, `/api/portal`, `/api/cron/fire`, `/api/providers/**`,
`/api/audio/**`, `/api/hermes/update/receipt`.

### 1.3 File access

`/api/fs/*` and `/api/files/upload` are **not** proxied. File access goes
through the existing platform fs remap (`/api/instances/{{id}}/fs`, SFTP/SSH on
the platform side) which pins every path to `/opt/data/**` (reject `..`, encoded
dots, and siblings like `/opt/database`). The desktop main process may call the
following dashboard routes directly with already-validated paths; the proxy
should still refuse them:

| Methods | Path |
|---|---|
| GET | `/api/fs/list` |
| GET | `/api/fs/read-text` |
| GET | `/api/fs/read-data-url` |
| GET | `/api/fs/default-cwd` |
| GET | `/api/fs/root` |
| GET | `/api/fs/git-root` |
| POST | `/api/fs/write-text` |
| POST | `/api/files/upload` |
| GET | `/api/preview/**` |

### 1.4 Backups (removed)

Denied since desktop red team sweep 3 (2026-09-28, M-1). A hermes backup zip
holds every secret on the VM (`.env`, `auth.json`, `state.db`, `vault.key`, the
license), and `import-upload` runs `hermes import --force`, which overwrites
`config.yaml` / `.env` past the `PUT /api/config` key allowlist. The proxy can't
tell the app's main process from any other desktop-token holder, so all three
routes (`POST /api/ops/backup`, `GET /api/ops/backup/download`,
`POST /api/ops/import-upload`) are denied, and the app no longer offers
Backup / Restore. Recovery is operator-side (platform snapshot scripts).

## 2. `PUT /api/config` key allowlist

hermes deep-merges `{"config": {…}}` into `config.yaml` and accepts any key.
The proxy must parse the body, flatten it to dotted paths, and refuse the whole
request (403) if any leaf path is not below. List = `AGENT_CONFIG_WRITABLE` in
`src/lib/agent-config.ts` (the test checks this doc contains every entry). A
path ending in `.*` allows exactly one further dynamic segment.

- `approvals.mode`
- `approvals.cron_mode`
- `approvals.smart_policy`
- `approvals.deny`
- `command_allowlist`
- `privacy.redact_pii`
- `security.website_blocklist.enabled`
- `security.website_blocklist.domains`
- `checkpoints.enabled`
- `timezone`
- `display.language`
- `memory.memory_enabled`
- `memory.user_profile_enabled`
- `memory.write_approval`
- `slack.require_mention`
- `slack.free_response_channels`
- `slack.allowed_channels`
- `discord.require_mention`
- `discord.free_response_channels`
- `discord.allowed_channels`
- `discord.auto_thread`
- `mattermost.require_mention`
- `matrix.require_mention`
- `streaming.enabled`
- `human_delay.mode`
- `sessions.retention_days`
- `sessions.auto_prune`
- `mattermost.allowed_channels`
- `matrix.allowed_rooms`
- `gateway.pairing_instructions`
- `platforms.telegram.unauthorized_dm_behavior`
- `platforms.discord.unauthorized_dm_behavior`
- `platforms.slack.unauthorized_dm_behavior`
- `platforms.whatsapp.unauthorized_dm_behavior`
- `platforms.signal.unauthorized_dm_behavior`
- `platforms.sms.unauthorized_dm_behavior`
- `platforms.mattermost.unauthorized_dm_behavior`
- `platforms.matrix.unauthorized_dm_behavior`
- `platforms.bluebubbles.unauthorized_dm_behavior`

Value rules (defense in depth; hermes also validates):

- `approvals.mode` ∈ {`manual`, `smart`, `off`}; `approvals.cron_mode` ∈
  {`deny`, `approve`}.
- `platforms.<id>.unauthorized_dm_behavior` ∈ {`pair`, `ignore`};
  `gateway.pairing_instructions` is a plain string ≤ 500 chars (placeholders
  `{platform}`, `{code}`).
- `command_allowlist`, `approvals.deny`, `security.website_blocklist.domains`:
  arrays of strings, ≤ 500 items, each ≤ 500 chars.
- `approvals.smart_policy` ≤ 2000 chars.
- `sessions.retention_days`: integer 1–3650; `sessions.auto_prune`: boolean.
- `timezone`: an IANA zone name; `display.language`: BCP-47 tag.
- Everything else: booleans / short strings / string arrays as in
  `hermes_cli/config_defaults.py`.
- `profile` query/body field: only the user's own profiles; never another
  HERMES_HOME.

`GET /api/config` may be forwarded, but the proxy should strip
`model`, `providers`, `auxiliary`, `delegation`, `moa`, `custom_providers`,
`dashboard`, `terminal.env`, `mcp_servers.*.env|headers` values before returning.

## 3. `/api/env` key rules (S2)

- `GET /api/env`: forward, but the response must only carry `is_set` /
  redacted values (hermes default). Never forward `POST /api/env/reveal`.
- `PUT /api/env` and `DELETE /api/env`: allow only keys matching one of

  ```
  ^[A-Z][A-Z0-9]*_(BOT_TOKEN|APP_TOKEN|TOKEN|SIGNING_SECRET|ACCESS_TOKEN|PASSWORD|ADDRESS|USERNAME|HOMESERVER|PHONE_NUMBER|ACCOUNT)$   # messaging credentials
  ^EMAIL_(ADDRESS|PASSWORD|IMAP_HOST|IMAP_PORT|SMTP_HOST|SMTP_PORT|IMAP_SECURITY|SMTP_SECURITY|POLL_INTERVAL|HOME_ADDRESS|HOME_ADDRESS_NAME)$
  ^[A-Z][A-Z0-9]*_(ALLOWED_USERS|ALLOW_ALL_USERS|GROUP_ALLOWED_USERS)$
  ^[A-Z][A-Z0-9]*_HOME_(CHANNEL|CHANNEL_NAME|CHANNEL_THREAD_ID|ROOM)$
  <skill / toolset keys declared by the hermes catalog with category "tool" or "skill">
  ```

  and **always refuse**, even if matched above: `*_API_KEY` for any LLM
  provider (OPENAI, ANTHROPIC, OPENROUTER, GOOGLE/GEMINI, GROQ, MISTRAL,
  DEEPSEEK, XAI, TOGETHER, FIREWORKS, NOUS, …), `*_BASE_URL`, `HERMES_*`
  (incl. `HERMES_DASHBOARD_*`), `TERMINAL_*`, `HTTP(S)_PROXY`, `NO_PROXY`,
  `PYTHON*`, `LD_*`, `PATH`, `HOME`, `SSL_CERT_*`, `REQUESTS_CA_BUNDLE`,
  and the platform key (`hermes_pk_…` value or its env name).
- Values: ≤ 4 KiB, no newlines / NUL.

## 4. Managed scope pins (S3)

Write `/etc/hermes/config.yaml` and `/etc/hermes/.env` at provision, owned
`root:root`, mode `0644` / `0640` (group = a group hermes is in only if it must
read `.env`), directory `0755 root:root`. hermes loads these over the user
config (`hermes_cli/managed_scope.py`); the user cannot change them because the
agent does not run as root (§5). Pin:

- `model`, `providers`, `custom_providers`, `fallback_providers`, `auxiliary`,
  `delegation`, `moa`, `model_overrides`, `model_catalog`, `openrouter`,
  `nous`, `bedrock`, `vertex`, `credential_pool_strategies`, `local_runtime`
- the platform LLM key and base URL (`/etc/hermes/.env`)
- `security.*` **except** `security.website_blocklist.*` — notably
  `security.allow_private_urls: false`, `security.redact_secrets: true`,
  `security.tirith_enabled: true`, `security.protected_instruction_files: true`,
  `security.allow_lazy_installs` (platform choice)
- `browser.allow_private_urls: false`
- `dashboard.*` (auth, trusted_proxies, public_url, basic_auth, oauth)
- `telemetry`, `monitoring`, `logging`, `updates`
- `terminal.backend` (and `terminal.env`), `code_execution` sandbox settings
- `hooks: {}` and `hooks_auto_accept: false`; `quick_commands: {}`
- `plugins` (no user-installed agent plugins), `mcp` discovery policy
- `gateway.api_server` (incl. `max_concurrent_runs`), `gateway.trust_env`
- `max_concurrent_sessions`, `max_live_sessions`
- `network`, `proxy`

Also block slash commands that repoint the model (`/model --global`, `/fast`,
`/moa`, `/reasoning`, `/provider`) — pinned model config makes them no-ops, and
the desktop filters them in the chat passthrough (S4).

## 5. VM runtime

- **Non-root hermes user.** hermes, the gateway and every tool subprocess run as
  an unprivileged `hermes` user (uid ≥ 1000) with `HERMES_HOME=/opt/data`
  owned by that user. No passwordless sudo; no membership in `docker`, `sudo`,
  `adm`, `disk`. `/etc/hermes`, `/usr`, `/opt/hermes` (code) are root-owned and
  read-only to it.
- **Metadata IP block (S5).** Drop egress to `169.254.169.254`,
  `169.254.170.2`, `fd00:ec2::254`, `metadata.google.internal` and the
  provider's link-local ranges with an nftables/iptables rule applied at boot,
  before hermes starts, for all users (not only `hermes`). Also block egress to
  the platform's private control-plane ranges.
- **Dashboard auth (S6).** Never start the dashboard with `--insecure`. It
  listens on loopback (or the private interface) only and is reached through
  the platform proxy / SSH tunnel; set `dashboard.trusted_proxies` to the proxy
  address, and enable `dashboard.oauth` or a per-instance token that the proxy
  injects server-side (the desktop never sees it). Public paths
  (`hermes_cli/dashboard_auth/public_paths.py`: `/api/health`, `/api/status`,
  `/api/config/defaults`, `/api/config/schema`, `/api/model/info`,
  `/api/dashboard/themes`, `/api/dashboard/plugins`, `/api/cron/fire`, …) must
  not be exposed on a public interface; `/api/cron/fire` in particular must be
  loopback-only.
- **Rate limits.** Per-instance: 10 req/s burst 30 on the proxy; ops actions
  (`doctor`, `security-audit`) ≤ 6/hour.
- **Logs.** The proxy logs method, path pattern, status and latency — never
  bodies, query strings of `/api/env`, or headers.

## 6. Provision-time pushes

- **Timezone & locale.** At provision (and when the desktop reports a change),
  write the user's IANA timezone to `timezone` and language to
  `display.language` in the user config (these two are user-writable; see §2),
  set the VM `TZ` / `/etc/localtime` to match, and restart the gateway once so
  cron schedules use local time.
- **Approvals default.** `approvals.mode: smart`, `approvals.cron_mode: deny`.
- **Retention default.** `sessions.auto_prune: true`, `sessions.retention_days: 90`.

## 7. Preinstalled binaries

Bake into the VM image (on `PATH` for the `hermes` user, root-owned, pinned
versions, updated with the image — never installed at runtime by the agent):

| Binary | Why |
|---|---|
| `node` (LTS) + `npm`/`npx` | MCP servers (`npx` runner), JS skills, preview dev servers |
| `gh` | GitHub skills (auth via `GITHUB_TOKEN` in `.env`) |
| `jq` | shell skills / tool output parsing |
| `himalaya` | email skill (IMAP/SMTP CLI) |
| `chromium` + `agent-browser` | browser tool / computer use / screenshots |
| `faster-whisper` (+ model cache) | local speech-to-text for voice notes |
| `piper` (+ one voice per supported language) | local text-to-speech |
| `uv` / `uvx`, `python3` | Python MCP servers (`uvx` runner), hermes itself |
| `git`, `curl`, `ffmpeg`, `unzip`, `ripgrep` | common skill dependencies |

With these present, `security.allow_lazy_installs` can be pinned `false`.
