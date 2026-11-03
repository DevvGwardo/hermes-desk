# Security baseline — inherited Maia/Nub era (historical)

> **This is an archived audit baseline, not the current policy.** For reporting a
> vulnerability now, read [`/SECURITY.md`](../SECURITY.md) at the repository root.
> The material below documents the sandbox, IPC and token invariants inherited
> from the Maia/Nub desktop codebase; it is kept because the app still enforces
> most of them, and because the red-team findings it records are still cited.
>
> Last audited: 2026-08-24 (red-team remediation pass) · Branch: `main` · Electron 37.x · Vite 6.3.5

This doc records the current `npm audit` surface, the ElectronCSP/sandbox posture, and the upgrade plan. It is the canonical place to check before shipping.

**Current RT-01–RT-07 controls:** see
[the remediation record](RED_TEAM_REMEDIATION_RT01_RT07.md). It supersedes the
historical whole-home Files boundary, renderer-only plugin pins and denylist-only
environment descriptions below. Agent private-network access and shared-login
handoff are now blocked; user-lane browsing is unchanged. This is not owner risk
acceptance or a new dependency-audit snapshot.

## 0. Red-team remediation (2026-08-24)

Findings in `docs/RED_TEAM_ASSESSMENT.md`, fixes landed:

- **Update trust anchor (C1)**: every release zip is signed at build time with an Ed25519 key (`MAIA_UPDATE_SIGNING_KEY` in `.env.local`, base64 PKCS8 DER — **back it up; losing it bricks future in-app updates**). `latest.json` carries the base64 signature per platform; `maia:updateApply` verifies it with `electron/update-signature.cjs` against the public key compiled into the app BEFORE accepting the artifact. Unsigned or foreign-signed zips are refused even when the sha256 matches — CDN/bucket compromise no longer yields mass RCE.
- **API-base pinning (C2)**: `MAIAVM_API_BASE`/`VITE_MAIAVM_API_BASE` overrides are ignored in packaged builds; auth traffic only ever goes to `https://www.maiavm.com`. Session `publicUrl`s are validated against `*.maiavm.com` (`isAllowedInstanceUrl`) before being stored or used.
- **MCP stdio commands (H1)**: renderer-supplied stdio servers must be bare allowlisted runners (uvx/npx/bunx/pipx/python3), metachar-free args, ≤32 args × 200 chars.
- **OAuth loopback listener (H2)**: GET-only, non-empty query required, cross-origin Origin/Referer requests rejected against the IdP host, port range-checked.
- **nub-vm scheme (H3)**: `bypassCSP` removed; every nub-vm response carries an explicit CSP (objects banned, framing restricted).
- **openHttps (H4)**: non-allowlisted https URLs require a native confirmation dialog showing the full target.
- **fs TOCTOU (M1)**: reads/writes re-realpath immediately before I/O and re-check containment; writes open with `O_NOFOLLOW` on POSIX.
- **Binary trust (M5/M4)**: `electron/bin-guard.cjs` refuses group/world-writable or non-regular binaries and logs resolved paths (whisper-cli, ffmpeg, task CLI); task CLI path uses `os.homedir()` (never empty).
- **Git hardening (L2)**: all git calls run with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
- **STT cap (L3)**: one concurrent transcription max (`MAX_STT_INFLIGHT = 1`).
- **Plaintext fallback (L1)**: ~~kept for systems without safeStorage, but loudly warned on every read/write.~~ Superseded 2026-10-01 (#161, see §0b): no plaintext file unless `MAIA_ALLOW_PLAINTEXT_SESSION=1`.

Deferred (documented decisions):
- **xlsx 0.18.5 (M2)**: evaluated exceljs migration vs CSV-only. Deferred: parse-surface mitigations (12 MB cap, no formulas/dates, row cap, String coercion) remain; swap carries regression risk on FilePreview for marginal gain while sheet previews see little usage. Revisit if usage grows or a new xlsx advisory lands.
- **PDF.js isolation (M3)**: pdfjs-dist 6.2.108 is the current release; keep bumping. Sandboxed-iframe isolation of PdfPane remains future work.

### Pass 2 additions (2026-08-24)

- **Plugin door confinement**: `plugin-host.cjs` file reads/watches are jailed to the plugin roots (not just `~/.hermes`, which holds `serve.token`) with pre-I/O realpath checks — `electron/plugin-host.cjs`.
- **Update version binding**: staged `.app`/exe must match the manifest version before the swap; both helpers validate pre-swap.
- **`security-invariants.test.mjs`**: structural tripwires for every hardening invariant above — a refactor that silently reverts one now fails CI instead of losing the property.



## 0b. Token handling (#160 / #161, 2026-10-01)

What the desktop app holds, and where:

| Credential | Where it lives | Renderer sees |
|------------|----------------|---------------|
| Hermes serve session token (`HERMES_DASHBOARD_SESSION_TOKEN` / `~/.hermes/serve.token`) | Main process only (`electron/serve-auth.cjs`) | `present`, `baseUrl`, `tokenSource` (`env`/`file`/`none`) — never the token or its file path |
| Nub VM gateway token | Main process + `safeStorage` | `gatewayReady` flag only (`maia:nubConnection`, `maia:nubRefresh`) |
| Nub desktop session token (`nub_desk_…`) | Main process + `safeStorage` | Still returned by `maia:nubConnection` — the deploy transport and the web/mobile clients share that contract (see "Not done" below) |
| 1Password values (`op read`) | Never stored; resolved on demand | Nothing — `maia:secretsCopy` resolves and writes the clipboard in main, then clears it after 45 s if unchanged |
| GitHub tokens | **Not held by the app** — no GitHub API calls are made by the desktop client | — |

Mechanics:

- **Serve REST**: main injects `X-Hermes-Session-Token` with `session.webRequest.onBeforeSendHeaders`, filtered to the serve origin and gated to fetch/XHR from the **main window's top frame** — sub-frames (nub-vm previews), other windows and main-process requests never get it.
- **Serve REST mutations**: every non-GET request through the app-owned REST proxy asks a native "Allow … once?" confirm, except the exact shapes in `CONFIRM_FREE` (`electron/serve-auth.cjs`): mark a chat read, rename a chat, pause or run a routine now, reject a proposed memory edit, switch the task board, and comment on, edit or add a single task. The renderer can already prompt an agent without a confirm, so these are no stronger than that; settings, secrets, schedules, toolsets, MCP, profiles, bulk dispatch and deletes still ask. Extra fields or query keys make a request ask again.
- **Serve JSON-RPC from the renderer**: `electron/local/serve-client.cjs` allowlists methods and parameters. `config.set` is limited to `key: "model"` with an explicit `<model> --provider <slug> --session|--global` value on a session the window owns; `--global` (a new profile default) asks a native confirm first. `model.options` results are projected to picker fields only.
- **Serve WebSockets**: the serve WS gate reads the credential only from the URL query string (headers are ignored) and webRequest cannot rewrite a WS URL, so main opens `/api/ws` and `/api/plugins/kanban/events` itself and relays frames over IPC (`maia:serveSocket*`). Other paths are refused; renderer-supplied `token`/`ticket` query keys are dropped.
- **Session storage**: `nub-link.cjs` encrypts with `safeStorage`. When encryption is unavailable (Linux without a keyring, headless) the session is kept **in memory for that run only** — the user re-links after a restart. Set `MAIA_ALLOW_PLAINTEXT_SESSION=1` to persist a 0o600 plaintext file instead (loudly warned). A plaintext file left by an older build is adopted into memory and deleted.
- **Agent spawn env**: `hermes` (kanban dispatch starts agent workers), the task-queue CLI and git run with `electron/agent-env.cjs`'s scrubbed env: `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `GITHUB_PAT_*`, `HERMES_DASHBOARD_SESSION_TOKEN`, the dump nonces and `MAIA_UPDATE_SIGNING_KEY` are removed; git also gets `GIT_TERMINAL_PROMPT=0`. Model-provider keys (`ANTHROPIC_API_KEY`, …) are deliberately **kept** — the hermes CLI falls back to them when `~/.hermes/.env` does not set them.

### GitHub access for agents: use fine-grained, per-repo, short-lived PATs

The app no longer forwards a GitHub token from your shell to agent processes. If an agent needs GitHub (the `gh` skill, `git push`), give it a token deliberately and keep its blast radius small:

1. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens), not a classic `repo`-scope token.
2. **Repository access → Only select repositories**: just the repos the agent works on.
3. **Permissions**: the minimum — usually `Contents: Read and write` and `Pull requests: Read and write`; add `Issues`/`Metadata` only if needed. No admin, workflow or org permissions.
4. **Expiration**: short (7–30 days). Rotate rather than extend.
5. Put it in the agent's env file (`~/.hermes/.env`, `GITHUB_TOKEN=…`, mode 0600), which hermes loads itself — not in your login shell profile, where every process you start inherits it.
6. Revoke it immediately if a VM, transcript or log that could contain it is shared or compromised.

### Not done (tracked separately)

- The `nub_desk_…` desktop session token is still readable by the renderer via `maia:nubConnection` (the Electron build uses it for the deploy transport in `src/lib/agents/active-transport.ts`, which shares its HTTP client code with the web/mobile builds where the token lives in localStorage by design). Moving those calls behind main is a larger refactor; see `RED_TEAM_SWEEP_2026-09-07.md`.

## 1. Audit snapshot

```text
npm audit --audit-level=moderate  (2026-02-13)

moderate  uuid@<11.1.1  — missing buffer bounds check (via xcode -> @capacitor/cli, dev-only)
moderate  uuid transitive (xcode) — same
high      extract-zip@2.0.1 — unvalidated symlink path traversal (GHSA-jmr9-qjv8-65gv)
high      xlsx 0.18.5 — prototype pollution + ReDoS (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9)
high      electron 37.10.3 — 13 advisories inherited via extract-zip + Chromium 134
  e.g. GHSA-4p4r… header injection, GHSA-h7rp… context isolation bypass, GHSA-v3j7… cors bypass
```

Raw output is intentionally not `--force` fixed: the fixes are breaking major bumps.

## 2. What is actually exploitable here?

| Vuln | Reachable? | Mitigation in this repo |
|------|------------|-------------------------|
| **xlsx ReDoS / proto pollution** | Yes — `FilePreview → sheet.ts → XLSX.read` parses untrusted workbooks. | `loadSheet` now **rejects >12 MB before parse**, passes `cellFormula:false, cellDates:false, WTF:false` to reduce parser surface, and caps rendered rows at 4000. `FilePreview` also `statPath` pre-checks size. Row strings are coerced via `String(cell)` — no `__proto__` path is merged into app state. Long-term: evaluate `exceljs` or drop xlsx for CSV-only if usage stays low. |
| **extract-zip symlink traversal** | No — not directly invoked by app code. It is a transitive dep of `electron` (`electron-builder` + `@electron/osx-sign`) used at build time to unpack Electron. | Build host is the operator Mac; no untrusted zip is extracted at runtime. Keep Electron builder on its pinned version and upgrade Electron incrementally (see §4). |
| **uuid buffer check** | No — only via `xcode` → `@capacitor/cli` (dev tooling for Android). Not in runtime bundle. | `uuid` is not shipped to users. Capacitor CLI is dev-only; bump when Capacitor 9 lands. |
| **Electron 37 Chromium advisories** | Limited — most require a compromised renderer or custom protocol handler. The app's `BrowserWindow` uses `contextIsolation:true, sandbox:true, nodeIntegration:false` and `isBrowserSafeExternalUrl` allowlists `https://` only (http only localhost in dev). IPC is gated by `assertMainSender`. | Stay on the 37.x line with `electron@37.10.3` (latest 37). Do **not** `npm audit fix --force` to 43 (6-major bump, sandbox regressions). Track https://github.com/electron/electron/security/advisories and upgrade 37→38→39 stepwise with manual regression on `main.cjs`, `preload.cjs`, `fs-guard`, `vm-copy`. |

## 3. Hardening already landed

- **CSP**: `index.html` meta `Content-Security-Policy` + `WEB_CSP` in `vite.config.ts` (no `unsafe-eval`, no wildcard `connect-src`, `frame-src` limited). Electron loads via `file://` with relative base.
- **Sandbox**: `main.cjs` BrowserWindow `contextIsolation:true, sandbox:true, nodeIntegration:false`, `assertMainSender` on every IPC.
- **FS confinement**: `electron/fs-guard.cjs` now uses `fs.realpathSync` to defeat symlink bypass (`~/evil -> /etc` no longer passes `isInsideRoot`); `validateFsPath` + `defaultFsRoot` enforce home containment; NUL byte and >4096 length rejected.
- **VM path safety**: `vm-copy.cjs:vmDest` uses `path.resolve` + `isInsideRoot('/opt/data')` (not substring), `copyFromBox` same; base filename sanitized.
- **Token handling**: `NUB_DUMP_GATEWAY_FILE` now requires `NUB_DUMP_GATEWAY_NONCE` (>=16 chars) and path must match `/tmp/nub-*`; the Nub session lives in `safeStorage` (OS keychain) — without a keychain it is memory-only for the run unless `MAIA_ALLOW_PLAINTEXT_SESSION=1` opts into a 0o600 plaintext file (§0b).
- **Update integrity**: `main.cjs` pins `download.maiavm.com` origin, mandates 64-hex `sha256`, **and requires a valid Ed25519 signature over the zip (C1, see §0)**; args are positional, never interpolated.
- **Preview safety**: `mermaid` `securityLevel:'strict'`, `katex` `throwOnError:false`; `dangerouslySetInnerHTML` only for those two lazy renderers, never for raw markdown (which goes through `ReactMarkdown` + `remarkGfm` without `rehype-raw`). `safe-image-url.ts` allowlists `https:` only, strips userinfo, caps data URLs at 2 MB.
- **Logging**: `src/lib/logger.ts` gates all `console.*` behind `import.meta.env.DEV` — production builds emit no logs (verified by `npm run build` grep gate).
- **Chunking**: `vite.config.ts` `manualChunks` isolates `mermaid` (2.7 MB lazy), `katex`, `pdfjs`, `xlsx`, `cytoscape`, `markdown`, `motion` so the initial `index` chunk is ~594 kB (was 891 kB).

## 4. Upgrade plan (no `audit fix --force` in CI)

1. **Electron**: stay on `^37.2.6` (resolves to 37.10.3). When a Chromium 134 CVE is flagged as reachable, bump to `38.x` in a dedicated PR, run `npm run test:run && npx tsc -b && npm run build` + manual smoke (file tree, computer panel, update check) before merging. Repeat to 39, not 37→43.
2. **xlsx**: isolated behind `loadSheet` guards. If sheet previews stay rare, consider removing `xlsx` and keeping only CSV/TSV via `loadSheet` string path. Otherwise evaluate `exceljs` (maintained, no ReDoS advisories).
3. **extract-zip**: goes away with the Electron bump; no direct action.
4. **uuid/xcode**: bump with `@capacitor/cli` next minor; not a runtime risk.

## 5. Checks to run before release

```bash
npm run test:run   # 785+ tests incl. sheet + fs-guard symlink + ErrorBoundary
npx tsc -b         # strict, noUnusedLocals/Parameters, erasableSyntaxOnly
npm run build      # chunk split, CSP injected, no TSC errors
npm audit --audit-level=high  # compare to snapshot above; no new highs without a doc update
grep -rn "console\." src --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "src/lib/logger.ts" | grep -v "src/mobile/crash-log.ts" # must be 0
```

## 6. Contacts

- Security contact for this repo: use GitHub Issues with label `security` or DM @GwardoBot (Telegram).
- Do not file public advisories for token-handling without a coordinated disclosure.
