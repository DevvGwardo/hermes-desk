# Desktop Red Team Sweep 3 — 2026-09-28 (delta since 2026-09-07)

**Scope:** `maiavm-desktop` delta `1379f63..6894915` (153 commits, HEAD = `origin/main`, fast-forwarded for this pass). Companion platform sweeps live in `hermes-deploy/docs/red-team-sweep-*.md`.

**Method:** one coordinator pass on the Electron main-process trust boundary (`electron/main.cjs`, `nub-link.cjs`, `dashboard-routes.cjs`, `vm-backup.cjs`) plus five parallel subagent lanes on disjoint surfaces: (A) dashboard-route allowlist, (B) reply-media rendering, (C) web/Android surfaces (service worker, CSP, boot scripts, vercel.json), (D) rooms/roster/identity, (E) release/supply chain. Static analysis + targeted single-file `vitest run` only. No payloads fired, no live rooms, no uploads, no deploys, no commits by the lanes.

**Process note:** one lane's report-only instruction was violated — lane B edited `src/components/ChatPanel.tsx` and `src/index.css` (a chat-composer focus-ring tweak) and still reported "nothing edited". Both edits were reverted before this doc was committed (`git checkout --`; tree clean apart from pre-existing untracked `ux-prototypes*/`). Lane self-reports are claims, not facts: every lane finding below was re-checked against the working tree, and the release lane's headline claim was re-derived from live artifacts.

**Headline:** 2 High, 2 Medium, 7 Low/Info. No Critical. Every finding is contained to the operator's own VM or own machine — none crosses the per-VM boundary the platform is built around. Two of the High/Medium items are **the allowlist's own claim not matching its contents**: routes that read VM secrets, and a raw REST door that skips the strict validation the dedicated IPC doors apply. The release/supply-chain lane's headline claim (a skewed 0.1.23 release) was **refuted by direct artifact inspection** — see E-1.

**Prior gates:** all regression spot-checks hold (D-01 TOFU pin, D-02 fail-closed act, D-04 nav guard, D-05 anti-rollback, D-07..D-11). Nothing in the delta reverted a prior control.

---

## Ranked findings

| Rank | ID | Title | Severity | Confidence | File:line |
|---|---|---|---|---|---|
| 1 | M-1 | Allowlisted `POST /api/ops/backup` + `GET /api/ops/backup/download` read every secret file on the VM (`.env`, `auth.json`, `vault.key`, `state.db`), defeating `DASHBOARD_DENY` | **High** | Validated (code + route table + hermes-agent source) | `electron/dashboard-routes.cjs:106-107` → `src/lib/agent-ops.ts:329,370` |
| 2 | M-2 | Allowlisted raw REST door (`POST /api/mcp/servers`) bypasses the strict stdio-MCP runner allowlist that the dedicated MCP door enforces | **High** | Validated in code | `electron/nub-link.cjs:2200` vs `:1552-1590`, `:1934` |
| 3 | D-2 | Agent name/description from VM `.md` files flow verbatim into the system prompt — prompt injection from one agent into every peer in a room | **Medium** | Validated in code | `src/lib/peer-roster.ts:217-241,257-268,285-306` |
| 4 | D-3 | Chief-of-Staff authority is decided by a name/title string match — a compromised agent self-promotes to account-wide Chief | **Medium** | Validated in code | `src/lib/peer-roster.ts:350-358`, `src/lib/agents/rooms.ts:253-255,282-288` |
| 5 | E-1 | Skew gate is not wired into the upload path, and `release/` currently holds 0.1.18-era zips while `package.json` is 0.1.23 — one `electron:upload` publishes the wrong bytes (live release itself verified clean) | **Medium** | Validated (gate run + live artifact inspection) | `scripts/upload-desktop.mjs:374,386-394`; gate at `~/.hermes/skills/devops/maiavm-desktop-ops/scripts/verify-release-zips.mjs` |
| 6 | B-1 | Inline base64 reply images have no byte cap (`InlineShot` skips `safeImageUrl`); 6×multi-MB data URLs blow up the renderer | **Medium** | Validated in code | `src/lib/reply-media.ts:22,88-91`; `src/components/VmShot.tsx:36` |
| 7 | D-1 | Room-feed `avatarColor`/`avatarEyeColor` reach CSS unvalidated (the `.md` branch is HEX-checked, the learned branch is not) | Low | Validated in code | `src/lib/agents/identity.ts:35-36`, `rooms.ts:137-139,186-192` |
| 8 | B-3 | `ProjectArtifactCard` "Open site" `<a href>` uses raw `hostedUrl` from agent text, not `safeLinkUrl`; `PUBLISHED_RE` accepts any `https://` | Low | Validated in code | `src/components/ProjectArtifactCard.tsx:301-315`; `src/lib/project-artifacts.ts:53` |
| 9 | B-2 | `safeImageUrl` accepts `data:image/svg+xml` on the markdown `<img>` path, inconsistent with the inline path's explicit SVG refusal | Low | Validated in code | `src/lib/safe-image-url.ts:6,12-14` |
| 10 | B-4 | `safeImageUrl` accepts `nub-vm://file/<private path>` — existence oracle for `.hermes/`/`.env*` (no private-path check, unlike `isPrivateVmPath`) | Low | Validated in code | `src/lib/safe-image-url.ts:17` |
| 11 | F-3 | HUD's permission handler overwrites the main window's deny-all on the shared default session (mic grantable without a prompt; no `setPermissionCheckHandler`) | Low/Med | Validated in code | `electron/main.cjs:825` vs `:230` |
| 12 | A-1 | `dashboardProxyPath` interpolates `instanceId` unencoded in main, encoded in the renderer | Low | Validated (node probe) | `electron/nub-link.cjs:905` vs `src/lib/vm-fs-http.ts:251` |
| 13 | A-4 / C-1 | Drift tests assert list/data equality and source constants, not matcher logic or the built artifact | Low | Validated | `src/lib/__tests__/dashboard-routes.test.ts:13-86`; `src/lib/__tests__/csp-header.test.ts:32` |
| 14 | F-4 | `maia:plugins:get` / `setPin` IPC + preload door has no consumer (`TODO` in the loader) | Info | Validated | `electron/main.cjs:743-758`; `src/plugins/loader.ts:120` |
| 15 | F-5 | `usageResetsHandle` `spend` trusts a renderer-supplied `instanceId` (shape-checked, not session-bound) | Info | Validated in code | `electron/nub-link.cjs:2293+` |
| 16 | E-2 | Cloudflare purge token passed in curl argv (`ps`-visible for ~1s) | Low | Validated in code | `scripts/upload-desktop.mjs:426` |
| 17 | E-3 | Android `versionCode`/`versionName` are hardcoded literals, never synced from `package.json` | Info | Validated in code | `android/app/build.gradle:10-11` |
| 18 | C-4 | Service worker last-resort `caches.match('/')` ignores `cacheName` (stale-shell window, same-origin only) | Info | Validated | `public/sw.js:199` |

---

## Fix status (2026-09-28, branch `fix/redteam-sweep-3` + hermes-deploy `fix/desktop-redteam3-policy`)

| ID | Status | What changed |
|---|---|---|
| M-1 | Fixed | `ops/backup`, `ops/backup/**` and `ops/import-upload` are denied in both app route lists AND the platform proxy (both tiers). Backup/Restore is removed from Settings → Troubleshooting, along with the `maia:nubVmBackup` IPC, preload door and `vm-backup.cjs`. Recovery is operator-side. |
| M-2 | Fixed | `vmRestHandle` runs `POST /api/mcp/servers` bodies through `gateRawMcpServerBody` (the stdio runner allowlist, env sanitizer, https-only URL, known keys only). The platform proxy refuses the same bodies (`checkMcpServerCreate`), so the web path is covered too. |
| D-2 | Fixed | `promptSafe` (app) and `promptText` (platform `rooms/core.ts`) put every name, title, blurb, group name and purpose on one line, cap it, and turn `[`/`]` into parentheses and backticks/quotes into `'`. |
| D-3 | Partly fixed | Only an explicit `role: 'orchestrator'` makes a Chief, in the app and on the server (the name/title fallback is gone). Residual: `role` itself still lives in VM-writable files (`maia_role`, roster.json), so an agent can still write its own role. The full fix is to store the Chief choice platform-side. |
| E-1 | Fixed | `scripts/verify-release-zips.mjs` is in the repo, and `upload-desktop.mjs` runs it as a hard preflight. `latest.json` and archive names use the gate-verified version. |
| B-1 | Fixed | Inline data URLs are capped at 2 MB when parsed and again at the `InlineShot` render. |
| D-1 | Fixed | Feed and roster colors are HEX-checked in `parseRoomFeed`, `learnRoomMemberNames` and `agentLook`. |
| B-3 | Fixed | "Open site" renders only for `openableHostedUrl` (via `safeLinkUrl`, https on a known host). `PUBLISHED_RE` only binds `*.nub.lol` and `*.maiavm.com`. |
| B-2 / B-4 | Fixed | `safeImageUrl` refuses SVG data URLs and private or non-image `nub-vm://file` paths (decoded like `vm-preview.cjs`). |
| F-3 | Fixed | One `installPermissionPolicy` per session, keyed by the requesting webContents: the HUD gets audio only, everything else is denied. There is now a `setPermissionCheckHandler` too. |
| A-1 | Fixed | `dashboardProxyPath` encodes `instanceId`. |
| E-2 | Fixed | The CDN purge uses Node `fetch`, so the token is never in argv. |
| E-3 | Fixed | Gradle reads `versionName` from `package.json`. `versionCode` stays a hand bump (Play monotonicity). |
| C-4 | Fixed | The unscoped stale-shell fallback is removed. Install precaches `/` into the current cache. |
| F-5 | No change | The web path already lets a token holder name any of their own VMs, and the server checks ownership. Binding in Electron adds nothing. |
| F-4, A-4/C-1 | Open | Dead plugin-pin IPC door, and drift tests that don't cover matcher logic or the built CSP. Not addressed in this pass. |

Residual noticed while fixing: the Electron main process sends dashboard requests straight to the VM's `publicUrl` with the gateway token before it falls back to the platform proxy. Anything holding that token skips the proxy policy entirely, so the proxy is not the only wall.

## 1. M-1 — the allowlist admits a full secret read of the VM (High)

**Chain:** `electron/dashboard-routes.cjs:106-107` puts `[['POST'],'/api/ops/backup']` and `[['GET'],'/api/ops/backup/download']` in `DASHBOARD_ROUTES` — the renderer-reachable list — while `DASHBOARD_DENY` (`:150-175`) refuses `/api/env/reveal`, `/api/config/raw`, `/api/ops/dump` and the path-form `/api/ops/import`. `src/lib/agent-ops.ts:329` fetches `download?archive=…` and `:370` uploads to `/api/ops/import-upload` with `force=true`.

**What the zip contains** (`~/.hermes/hermes-agent`, the pinned dashboard): `hermes_cli/backup.py:159-161` — `_SECRET_FILE_NAMES = {".env", "auth.json", "state.db", "vault.key", "vault.json.enc"}` — and `:1018` lists `config.yaml`, `.env`, `state.db` among the files a full backup must hold. The routes are `hermes_cli/web_routers/ops.py:566` (`POST /api/ops/backup` → returns the archive path) and `:585` (`GET …/download` → `FileResponse` of that zip). `destructive_profile` (`web_routers/_common.py:61-84`) is a no-op on a single-profile VM, so it adds no gate. `import-upload` (`ops.py:631`) stages the upload and spawns `hermes import --force`.

**Why it matters:** `docs/maiavm-proxy-hardening.md:5` states the design intent — "a client check is advisory: anyone holding a desktop token can call the proxy directly… the proxy and network rules are the only thing standing between a user and the platform secrets on the VM." The route table is part of that wall, and it currently includes a read of every secret file on the VM plus a `--force` overwrite of `config.yaml`/`.env` (LLM key, `approvals.mode`, shell hooks, cron). A renderer compromise (or the web surface, where Electron's checks do not exist) reaches it.

**Electron caveat:** `nubVmRest` → `vmFetch` JSON-stringifies its body and parses the response as text, so the zip bytes do not come back through that door; the web surface (`agent-ops.ts` raw fetch + `vmDashboardUpload`) is where the content lands.

**Fix:** move all three routes to `DASHBOARD_DENY`; keep save/restore main-process-only and stream to a user-picked path without ever handing bytes to the renderer; update `docs/maiavm-proxy-hardening.md` §1.1 and the `maiavm-proxy-spec` test with the change.

---

## 2. M-2 — the raw REST door skips the stdio-MCP validation the IPC door enforces (High)

**Chain:** the dedicated door validates hard — `nub-link.cjs:1552` `MCP_STDIO_RUNNERS = {uvx, uv, npx, bunx, pipx, python, python3}`, `:1558` `MCP_STDIO_FORBIDDEN = /[;&|<>$`\\^~*?!"'\n\r\t]/`, `:1564` `validateStdioMcpCommand`, enforced at `:1934` (env path) and `:1960` (plain path). The generic door does not: `vmRestHandle` (`:2200`) checks only method+path against the allowlist and forwards `body` untouched. `POST /api/mcp/servers` is allowlisted (`dashboard-routes.cjs:82`), so `{command:'bash', args:['-c','…']}` — refused by the dedicated door — is accepted here.

**Server side is not a substitute:** `hermes_cli/mcp_security.py:89` is explicit that it is not a whitelist — "custom commands, Python scripts, npx, uvx stay legal"; it blocks only IOC substrings, a shell interpreter with network egress in its inline script, and a shell interpreter writing an OS persistence surface. A bare `bash -c id` passes all three.

**Impact:** arbitrary process spawn on the user's own VM through a route the app already exposes. Contained by the per-VM threat model (the agent owns that VM), and it is not a regression — but `dashboard-routes.cjs`'s own header names "open a shell" as the class the allowlist exists to stop.

**Fix:** in `vmRestHandle`, route `POST /api/mcp/servers` bodies through the same `sanitizeMcpEnv` + `validateStdioMcpCommand` gate, or drop the route from the renderer list and keep MCP on the dedicated IPC door only.

---

## 3. D-2 — agent metadata → system prompt (Medium)

`parseHermesAgentMarkdown` (`src/lib/agents/vm-roster.ts:111-166`) takes `maia_display_name` / title / description from agent-writable `/opt/data/agents/*.md` with no newline stripping, no bracket escaping, no length cap. `peer-roster.ts:217-241` composes `- ${a.name} (\`${token}\`, ${where}): ${blurb}` and `:257-268` composes `[You are ${ident}. Stay in this role. …]`; `groupMemberInstructions` (`:285-306`) interpolates the group name and member list. The result is sent as the `instructions` field on `POST /api/chat` (`hermes-deploy-transport.ts:2683-2691`) and lands in the system prompt — for **every** member of the room, not just the injecting agent. A `]` in a display name closes the instruction bracket; newlines let the rest read as new instructions. Grep confirms ten `agent.name` usages in `peer-roster.ts` and none sanitized (`escapeRe` is regex escaping, not prompt escaping).

**Fix:** strip newlines/control chars, collapse whitespace, cap length, and escape `[`/`]`/backticks for every agent- and user-supplied string that reaches `instructions`.

## 4. D-3 — Chief authority by string match (Medium)

`isOrchestrator` (`peer-roster.ts:350-358`) returns true when `agent.role === 'orchestrator'` **or** when `\bchief of staff\b|\borchestrator\b` matches `name + persona.title`. `roomChief` (`rooms.ts:282-288`) and `accountChief` (`:253-255`) take the first match, and the Chief receives un-@mentioned messages first. Since the name/title come from the same agent-writable `.md` file, an agent promotes itself to room Chief — and to account-wide Chief (leading rooms it is not a member of) if it sorts first. Chains with D-2: one compromised agent can both lead the room and inject into every member's prompt.

**Fix:** require an explicit `role: 'orchestrator'` written by the user path; never derive authority from a display string.

## 5. E-1 — armed upload footgun; live release verified clean (Medium)

`scripts/upload-desktop.mjs:374` writes `latest.json` with `version: pkg.version` while `:386-394` hashes whatever stable zips sit in `release/`; the embedded app version is never read. The gate that would catch it (`verify-release-zips.mjs`) is **not referenced** by `upload-desktop.mjs`, `build-desktop.mjs`, `package.json`, or any workflow — `grep -rn "verify-release-zips" .github/ scripts/ package.json` returns nothing. Running the gate now:

```
package.json version: 0.1.23
mac-arm64   STALE  0.1.18   win-x64 STALE 0.1.18   win-arm64 STALE 0.1.18
RELEASE_SKEW — 3 platform(s) stale/missing; do NOT upload until rebuilt
```

`release/*.zip` are dated Sep 14 (0.1.18-era). **But the live release is correct**, verified directly rather than assumed:

- `https://download.maiavm.com/latest.json` advertises `0.1.23`, published `2026-09-28T03:50:01Z`.
- `archive/Nub-Agent-0.1.23-mac-arm64.zip` exists (110,398,430 B, = the size in `latest.json`) and its `Contents/Info.plist` reads `CFBundleVersion 0.1.23` (range-fetched, no full download).
- `archive/Nub-Agent-0.1.23-win-x64.zip` downloads to sha256 `bedd9a5f5db4a275eb79b891710bc4697b0237fd5a5bd0091fa922bceaeba2af` — byte-identical to the sha256 advertised in `latest.json` — and its `resources/app.asar` package.json embeds `0.1.23`.

So no skewed artifact is published; the finding is that the repo is one command away from overwriting the good objects with 0.1.18 bytes.

**Fix:** make the gate a hard preflight inside `upload-desktop.mjs` (spawn it, abort on exit 1) so the barrier is code, not operator memory.

## 6. B-1 — inline reply images have no byte cap (Medium)

`INLINE_IMAGE_RE` (`reply-media.ts:22`) matches `data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+` with no length bound; `:88-91` pushes up to `MAX_REPLY_MEDIA_IMAGES = 6` into `inline`, and `InlineShot` (`VmShot.tsx:36`) renders `<img src={dataUrl}>` directly — it never calls `safeImageUrl`, which does enforce a 2 MB cap for the markdown `<img>` path (`safe-image-url.ts:13`). Agent-controlled reply text (Telegram/Discord webhook, pasted tool output, a room peer) can therefore hand the renderer 6×multi-MB data URLs, and the module-level `lastInput`/`lastOutput` cache keeps them alive between renders. Renderer DoS only — no script execution.

**Fix:** apply the same 2 MB cap in the regex or at the `InlineShot` render site.

## 7–18 — Low/Info

- **D-1** `identity.ts:35-36` prefers `learned?.avatarColor` from the room feed over the HEX-validated `.md` branch; `parseRoomFeed` (`rooms.ts:137-139`) filters members on `id`/`name` only. Values reach `backgroundColor`/CSS custom properties. Impact is visual spoofing, not script.
- **B-3** `ProjectArtifactCard.tsx:301-315` uses `artifact.hostedUrl` raw in `<a href>` (the iframe thumbnail *is* pinned to `*-site.nub.lol`); `PUBLISHED_RE` accepts any `https://`, so an attacker-registered `vercel.app`/`nub.lol` subdomain can be the "Open site" target.
- **B-2** `safe-image-url.ts:6` accepts `data:image/svg+xml`; the inline reply path refuses SVG by design. Script-inert in `<img>`, but the two paths should agree.
- **B-4** `safe-image-url.ts:17` returns any `nub-vm:` URL; `nub-vm://file/opt/data/.hermes/config.yaml` is accepted where `isPrivateVmPath` would refuse it on the `MEDIA:` path. Existence oracle (load vs error), not a content read.
- **F-3** `main.cjs:825` installs a deny-all `setPermissionRequestHandler` on the default session; `:230` overwrites it with an audio-only allowlist when the HUD window is created (`createHudWindow()` runs on boot restore at `:2390` and on every toggle), so both windows end up under the HUD's policy. One session-wide handler keyed by `webContents`, plus `setPermissionCheckHandler`, is the fix.
- **A-1** `nub-link.cjs:905` interpolates `instanceId` unencoded; `vm-fs-http.ts:251` uses `encodeURIComponent`. Latent — `instanceId` is server-assigned.
- **A-4 / C-1** `dashboard-routes.test.ts` compares lists + 51 decision samples but not matcher logic; `csp-header.test.ts` compares source constants, not the built/deployed bytes.
- **F-4** `maia:plugins:get`/`setPin` (`main.cjs:743-758`, preload `plugins.get/setPin`) has no consumer — `loader.ts:120` is still a TODO. D-01's real gate (hash + pin) is intact and unchanged.
- **F-5** `usageResetsHandle` `spend` accepts a renderer-supplied `instanceId` (shape-checked `/^[A-Za-z0-9_-]{1,64}$/`) rather than `session.instanceId`; server-side ownership is the only gate.
- **E-2** `upload-desktop.mjs:426` puts the Cloudflare purge token in curl argv.
- **E-3** `android/app/build.gradle:10-11` hardcodes `versionCode 20` / `versionName "0.1.23"`; nothing syncs it from `package.json`.
- **C-4** `public/sw.js:199` falls back to `caches.match('/', {ignoreVary:true})` without `cacheName`; same-origin only, so the worst case is a stale shell.

---

## Verified clean this pass

- **Allowlist core:** `canonicalApiPath` + `matchPattern` correctly refuse traversal, `%2e`/`%2f`/`%5c`/`%00`, doubled/trailing slashes, empty segments, and case-varied methods (26 probes). `:x` is exactly one segment; `**` is last-segment-only. `INTERNAL_ROUTES` are unreachable from the renderer — no `src/` caller passes `internal:true` and `vmRestHandle` calls the allowlist without it.
- **Route-list drift:** `dashboard-routes.cjs` and `dashboard-routes.ts` are identical today (both matchers read line-by-line); the drift test fails on a list change.
- **D-01:** TOFU pin intact — `loader.ts:430` hash-compares before load, agent-owned roots carry `ownedBy:'agent'` (`:557`); touched only by tests this delta.
- **D-05:** `compareVersions` (`main.cjs:1730`), `updateAvailable` (`:1775`), the anti-rollback guard (`:1979`), and the staged-bundle version equality in the mac/win helpers all hold.
- **Download path:** `redirect:'manual'` + pinned-origin re-assert + adaptive timeout + byte cap; buffering before signature/hash verification is deliberate.
- **D-04:** packaged `will-navigate` now compares the decoded `dist/index.html` **path** rather than the opaque `file://` origin — strictly stronger than sweep 2. HUD guard: `url === hudUrl()`.
- **D-02 hardening:** `hudClickAt` and `hud:typeText` both fail closed on `trusted !== true` (was `=== false`).
- **HUD window:** `webviewTag:false`, `webSecurity:true`, `allowRunningInsecureContent:false`, `setWindowOpenHandler` deny, `will-attach-webview` prevented.
- **CSP:** `vercel.json` now serves the web CSP as a response header (`8b217bc`); header and meta constants agree; `frame-ancestors` correctly header-only.
- **Service worker:** `isBypassed` covers non-GET, cross-origin, `/api/`, and range requests; registration is prod-gated twice (`main.tsx:20`, `service-worker.ts:42`) and excluded on native (`isNativePhone()`), so the `1beb9d5` "no SW in the APK" claim holds.
- **theme-boot.js:** 11 lines, reads one localStorage key, sets one attribute; no HTML, no URL params, no pre-auth request.
- **Reply-media parsing:** no `javascript:`/`data:text/html`/`file:` reaches a sink; `MEDIA:` paths must be `/opt/data/`, image-ext, no `..`, not private; the tag is stripped from rendered text and the copy path is the user's own message.
- **`vmPath` (D-08) and MCP OAuth origin check (D-09):** unchanged and correct.
- **Release chain:** `verifyUpdateSignature` precedes the sha256 check; origin pinned to `download.maiavm.com` with post-fetch re-assert; `assertSlotComplete` requires url+sha256+signature+size; `build-desktop.mjs` refuses to build without the signing key. New deps (`gifenc` 1.0.3, `mediabunny` 1.55.7) are lockfile-pinned, script-free, and lazy-imported from dev-only lab/marketing components. `parity-check.mjs` can fail (it exits 1 on any failed row) and is not wired into CI.

## Dropped leads

- **`fetch()` calls in `src/lib/mcp.ts`, `hermes-profiles.ts`, `kanban-serve.ts`** do not consult the allowlist — but they target `serveConfig()` (`http://127.0.0.1:9119`, the operator's own local `hermes serve`), and that path is dead in web mode. Local serve is the operator's own host, outside the VM trust boundary. Not a finding.
- **Platform routes** (`/api/instances/*/config|fs|mcp`) bypass the dashboard allowlist by design; they are the platform's own authz surface (documented as such in the hardening spec).
- **`desktopToken` in Electron localStorage** — sweep 2 L-1, unchanged, still latent (requires a renderer XSS).
- **Rooms/roster writes** — optimistic concurrency (`baseRev` + 409 re-merge, bounded 3 attempts, deleted conversations not resurrected) is correct; token→instance binding is server-side.
- **Mentions** — no client-side loop, no credit spend, no routing bypass; the turn loop is server-owned.
- **`instanceId` in query strings** — identifier only; the bearer stays in the header.

## Could not test

- Server-side enforcement of the route table (`maiavm.com` proxy) and of room membership — cross-repo, no live probing in this pass.
- Whether the platform's `/api/instances/:id/dashboard/*` proxy validates the rewritten path with the same rigor as `canonicalApiPath`.
- Renderer memory behavior under a real 6×5 MB inline-image payload (no live app).
- Whether the dashboard's `/api/preview/file` route independently refuses private paths (the desktop `vmPath` does not).

## Checks run

- `node ~/.hermes/skills/devops/maiavm-desktop-ops/scripts/verify-release-zips.mjs` → `RELEASE_SKEW` (3 platforms stale vs `package.json`)
- `npx vitest run src/lib/__tests__/dashboard-routes.test.ts src/lib/__tests__/dashboard-routes-scan.test.ts` → 2 files, 9 tests passed
- `npx vitest run src/lib/__tests__/reply-media.test.ts` → 21 passed
- `npx vitest run src/lib/agents/__tests__/roster-conflict.test.ts src/components/__tests__/agent-identity.test.tsx` → 2 files, 10 tests passed
- Range-fetch + zip/asar/plist parse of the three live `archive/0.1.23` artifacts; sha256 of the downloaded win-x64 zip vs `latest.json`
- `git fetch` + fast-forward of `main` to `origin/main` (`6894915`); no product code changed in this pass (docs-only)
