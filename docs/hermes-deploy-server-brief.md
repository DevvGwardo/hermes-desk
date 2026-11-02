# Brief: server work in Maia-VM/hermes-deploy (www.maiavm.com)

Paste this into a Claude Code session started on `Maia-VM/hermes-deploy`. It is written to stand alone. Push the work to branch `claude/sweet-euler-np1alh`.

Read these first. They are in this repo (`DevvGwardo/maiavm-desktop`, branch `claude/sweet-euler-np1alh`):
- `docs/platform-cost-reduction.md`: Vercel Fluid Active CPU is at 100% of the free 4 h, and the Upstash `hermes-deploy-cache` Redis is at 90% of 500k commands/month. **Urgent.**
- `docs/maiavm-proxy-hardening.md`: the route allowlist, the `PUT /api/config` key allowlist, the `/api/env` rules, managed-scope pins and the VM image items.
- `electron/dashboard-routes.cjs`: the exact dashboard route allowlist the app enforces. The server must enforce the same list.

## Tasks, in priority order

Each task needs tests that follow the repo's conventions. Run lint, typecheck and tests before every push.

1. **Cut Redis commands (urgent).**
   - Audit every Redis call on the hot paths: auth, session and token lookups, instance lookups, rate limiting, chat sync, notifications and usage.
   - Add a module-level in-memory LRU for session and instance lookups, with a 30–60 s TTL and invalidation on unlink or rotation. This works because Fluid reuses warm instances.
   - If you use `@upstash/ratelimit`, turn on its `ephemeralCache`. Stop spending several commands on each cheap authenticated GET poll.
   - Collapse multiple `GET`s into one hash read.
   - Stop writing on every poll. Write only when the value changed, or at most once a minute.
   - Measure commands per request, before and after, for the top routes.
2. **Cut Vercel Active CPU.**
   - Replace per-request SSH to VMs (dashboard and fs proxy) with HTTPS and a keep-alive agent. If VMs lack a resolvable HTTPS hostname, fix it in provisioning with per-VM DNS plus Caddy/TLS. The desktop's direct path then works and those requests skip Vercel. Keep SSH for provisioning and repair only.
   - Add a "nothing changed" fast path to `/api/chat/sync`, `/api/notifications` and `/api/llm/usage`: check a version or cursor first, then return 304 or an empty response.
   - Set `Cache-Control` with `s-maxage` on non-private cacheable GETs.
3. **Harden the dashboard proxy.**
   - Enforce the route allowlist from `dashboard-routes.cjs`. Check the deny list first; a denied route returns 403 `blocked by Nub Agent`.
   - Enforce the `PUT /api/config` key allowlist. Flatten the body to dotted paths, then refuse the whole request if any leaf path is not allowed.
   - Enforce the `/api/env` key rules.
   - Refuse `POST /api/env/reveal`.
   - Deny `POST /api/ops/backup`, `GET /api/ops/backup/download` and `POST /api/ops/import-upload` (sweep 3, M-1).
4. **Provisioning and image** (where this repo builds them).
   - **Install hermes from the fork, pinned.** Use `DevvGwardo/hermes-agent` at a `maiavm-YYYY.MM.DD` tag or an exact commit on the `maiavm` branch. Never use a moving branch, and never use NousResearch directly. Roll each new pin to one canary VM before the fleet.
   - Pin hermes settings with managed scope: a root-owned `/etc/hermes`.
   - Run hermes as a non-root user.
   - Block the cloud metadata IP 169.254.169.254.
   - Push the user's timezone at provision time.
   - Preinstall node, gh, jq, himalaya, chromium/agent-browser, faster-whisper and piper.
5. **Relay agent prompts for linked VMs.** The hermes fork `DevvGwardo/hermes-agent` (branch `maiavm`, see its `FORK.md`) adds these to the gateway API server run stream.
   - **Events.** Each arrives as a `data:` JSON frame of the form `{event, run_id, timestamp, …}`:

     | Event | Payload |
     |---|---|
     | `secret.request` | `{request_id, env_var, prompt, url?, help?, skill?}` |
     | `clarify.request` | `{request_id, question, choices, multi_select?}` or `{request_id, questions: [{qid, question, choices, multi_select}]}` |
     | `secret.expire`, `secret.responded` | `{request_id}` (`secret.responded` also carries `skipped`) |
     | `clarify.expire`, `clarify.responded` | `{request_id}` |

   - **Opt-in.** Clients opt in on `POST /v1/runs` with the header `X-Hermes-Client-Capabilities: clarify,secret`.
   - **Answer routes:**
     - `POST /v1/runs/{run_id}/secret` with `{request_id, value}`
     - `POST /v1/runs/{run_id}/clarify` with `{request_id, answer, question_id?}`
   - **How to relay.** Mirror exactly how `approval.request` is relayed today (the app sees it as `hermes.approval.request`) and how `/api/chat/runs/:turnId/approval` is forwarded:
     - Forward the capability header.
     - Relay the new events under the same naming convention.
     - Add `/api/chat/runs/:turnId/secret` and `/api/chat/runs/:turnId/clarify`, with the same ownership and auth checks and the same control-route feature detection.
     - Never log secret values.

## Status and follow-ups (2026-10-05)

Task 5 is **done** on both sides: hermes-deploy serves `/api/chat/runs/:turnId/secret` and `/clarify`, relays `secret.*` / `clarify.*`, and the app declares `X-Hermes-Client-Capabilities: clarify,secret` (probes are now warmed when the transport starts, so the first send declares too). Tasks 1–4 can't be verified from the app repo.

New, found in the 2026-10-05 web/desktop gap pass. Each is small and app-visible:

6. **`clear-jobs` on `POST /api/nub/desktop/instance`.** Only `update-agent | restart` parse today (`parseDesktopInstanceAction`). The desktop clears stuck runs itself with the gateway token (abort → `/health/detailed` → gateway bounce, `electron/nub-link.cjs` `clearStuckRuns`); web and Android can't, so Settings hides the button there. Add the action server-side (SSH gateway restart, same rate budget as restart) and the app can show it everywhere.
7. **Make the run-control probe answerable.** The `[[...rest]]` catch-all answers `OPTIONS` with 204 for every path, so the app's `OPTIONS /api/chat/runs/__probe__/<action>` probe can't tell a real control route from a missing one. Harmless today (all six exist), but a future action (e.g. `mcp-setup`) would be "detected" with nothing behind it. Either 404 `OPTIONS` under `/api/chat/runs/*/` for unknown actions, or add `X-Nub-Route: missing` to the catch-all (and list it in `Access-Control-Expose-Headers`).
8. **Structured errors on 1:1 chat.** Rooms return codes (`agent_not_running`, `rate_limited`); `/api/chat` and its run events pass raw `detail` text, so the app guesses usage limits from reply text (`src/lib/usage-limit.ts`). Return `{ code: "usage_limit" | "agent_stopped" | "needs_subscription" | "provisioning", resetAt? }`.
9. **Relay `mcp.setup.request`** like `secret.request` (fork event + `POST /api/chat/runs/:turnId/mcp-setup`), so plugin setup prompts reach linked VMs; today only the local `hermes serve` transport sees them.
10. **CORS on `/api/instances/:id/mcp*`** (OPTIONS + `applyDesktopCors`, as `/resize` does). Hosted web reaches them same-origin through the Vercel rewrite, but the Capacitor app is cross-origin and can't — a prerequisite for Plugins on web/phone.
11. **A zip op for project downloads** (`/api/instances/:id/fs?op=zip`). Only the desktop main process can zip a VM folder, so web hides "Download zip".

Finish with a `docs/` note in that repo. It should cover every change, the command and CPU reduction (measured or estimated), any settings the owner must change, and anything left undone.
