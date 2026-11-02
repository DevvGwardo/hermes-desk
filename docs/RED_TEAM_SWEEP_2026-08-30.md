# Desktop Red Team Sweep — 2026-08-30 (`a1ed956`)

**Scope:** `maiavm-desktop@a1ed956` (523 files). Companion platform sweep: `hermes-deploy/docs/red-team-sweep-5.md` (`hermes-deploy@8a5edab`).  
**Scan dirs:** `…/codex-security-scans/maiavm-desktop/a1ed956_20260830T215259Z` · `…/codex-security-scans/hermes-deploy/8a5edab_20260830T215259Z`  
**Method:** Coordinator-finished static red-team using the DeepSec method + Vercel free skills + `backdoor-hunter` unicode/supply-chain passes. The Codex Deep Security Scan **did not complete**: 12 discovery workers died mid-run (Grok 402), round-01 unsaturated. The best partials (`worker-01/03/04/finding_discovery_report.md`) were treated as leads. No subagents were spawned; no Vercel Agent / Observability Plus / paid scans were called; no product code was edited; no exploit payloads. Text-only. Sweeps 1–4 controls (`C1/C2/H1/H2/H3/H4/M1/M4/M5/L2/L3`, plugin-host jail) were assumed still present unless a regression was proven at the cited lines.

---

## Ranked findings

| Rank | ID | Title | Severity | Confidence | File:line |
|---|---|---|---|---|---|
| 1 | D-01 | Linked-VM `desktop-plugins` are `blob: import()`ed default-on in the renderer with full `window.nubAgent` authority | **Critical** | **Validated in code** | `src/plugins/loader.ts:258-268` + `src/plugins/loader.ts:102-137` + `src/lib/plugins/vm-fs-door.ts:26-61` |
| 2 | D-02 | `maia:hud:typeText` spawns `osascript` keystrokes without calling `hudActTrusted` (click path does) | **High** | **Validated in code** | `electron/main.cjs:846-865` vs `electron/main.cjs:820-822` + `electron/main.cjs:348-359` |
| 3 | D-03 | HUD auto-executes `[CLICK:]` / `[TYPE:]` markers from untrusted agent text without per-action user consent (confused deputy) — **MITIGATED 2026-09-01 (option c + visible act chip; consent UI deferred by operator call)** | **High** | **Validated in code** | `src/components/HudShell.tsx:245-284` + `src/lib/hud-protocol.ts:23-54` |
| 4 | D-04 | Preview `nub-vm://` frame lacks `sandbox` and `will-navigate` — VM content can top-navigate a preload-bearing window — **FIXED 2026-09-01** | **Medium** | **Validated in code** | `src/components/PreviewModal.tsx:127-145` vs `src/components/PreviewModal.tsx:146-152` + `electron/main.cjs:718-723` |
| 5 | D-05 | Update helper version binding is a prefix match (`!= "$EXPECTED_VERSION"*`) and does not enforce newer-than-current (no anti-rollback) — **FIXED 2026-09-01** | **Medium** | **Validated in code** | `electron/main.cjs:1762-1767` (mac sh) + `electron/main.cjs:1829-1833` (win ps1) + `electron/main.cjs:1674` |
| 6 | D-06 | HUD act backends spawn `cliclick` / `osascript` by bare name, bypassing `bin-guard` PATH trust — **FIXED 2026-09-01** | **Medium** | **Validated in code** | `electron/screen-act.cjs:76-101` + `electron/screen-act.cjs:184-189` + `electron/main.cjs:850-856` + `electron/bin-guard.cjs:93-118` |
| 7 | D-07 | Packaged renderer origin is not pinned — `MAIA_ELECTRON_DEV=1` + `VITE_DEV_SERVER_URL` still loads an arbitrary URL when `app.isPackaged` — **FIXED 2026-09-04** | **Low** | **Validated in code** | `electron/main.cjs:18` + `electron/main.cjs:142-149` + `electron/main.cjs:725-727` |
| 8 | D-08 | `vmPath` allowlist is `startsWith("/opt/data")` without a trailing-slash boundary (`/opt/database` passes) — **FIXED 2026-09-04** | **Low** | **Validated in code** | `electron/nub-link.cjs:1012-1018` vs `electron/vm-copy.cjs:52,107` (`isInsideRoot`) |
| 9 | D-09 | MCP OAuth loopback `Origin`/`Referer` check uses `idpHost.endsWith('.'+host)` and accepts ancestor hosts (`com`, `google.com` for `accounts.google.com`) — **FIXED 2026-09-04** | **Low** | **Validated in code** | `electron/nub-link.cjs:1476-1502` |
| 10 | D-10 | Android `FileProvider` `<external-path path="." />` exports all external storage via `grantUriPermissions` — **FIXED 2026-09-04** | **Low** | **Validated in code** | `android/app/src/main/res/xml/file_paths.xml:3` + `android/app/src/main/AndroidManifest.xml:46-54` |
| 11 | D-11 | Android build runs `vite build` (not `--mode web`) so the APK ships the Electron CSP (`localhost`/`nub-vm:`/`http:` frame) instead of `WEB_CSP` — **FIXED 2026-09-04** | **Info/Low** | **Validated in code + build artifact** | `scripts/build-android.mjs:46` + `vite.config.ts:8-23` + `index.html:9-10` + `dist/index.html` |

Exploits are offline — each row is a safe static proof: show source, show control, show sink.

---

## D-01 — VM plugin RCE default-on (Critical)

**File:line:** `src/plugins/loader.ts:258-268` (VM root registration), `src/plugins/loader.ts:102-137` (`loadRuntimePlugin` blob `import()` + `plugin.register`), `src/lib/plugins/vm-fs-door.ts:26-32` (`VM_PLUGIN_ROOT`, `vmFsDoorAvailable`), `src/plugins/PluginHost.tsx:65-69` (always starts `watchRuntimePlugins`), `src/plugins/__tests__/loader.test.ts:130-164` (test asserts VM root is scanned)  
**Source → control → sink:** Agent-writable files under `/opt/data/.hermes/desktop-plugins/*/plugin.js` on the linked IONOS cube → `diskRoots()` (`loader.ts:258-268`) appends a third virtual root `{dir: VM_PLUGIN_ROOT="/opt/data/.hermes/desktop-plugins", readDir: vmFsDoor.readDir, readFileText: vmFsDoor.readFileText, watchable:false}` whenever `vmFsDoorAvailable()` is true (i.e. `window.nubAgent.nubVmFs` exists — every linked desktop) → `scanDiskPlugins` (`loader.ts:335-366`) lists that dir via `vmFsDoor` (which calls `nubVmFs('list')` → `electron/nub-link.cjs:vmFsHandle` → `/api/fs/list` over the dashboard) and for each new folder pre-loads `plugin.js` → `loadDiskPlugin` (`loader.ts:295-319`) reads the file text and calls `loadRuntimePlugin(text, origin, {defaultEnabled: entry.defaultEnabled})` → `loadRuntimePlugin` (`loader.ts:102-137`) does `URL.createObjectURL(new Blob([rewriteSpecifiers(source)]))` + `await import(/* @vite-ignore */ url)` then `plugin.register(createPluginContext(plugin.id))` in the **same renderer realm as `window.nubAgent`** (HUD, `nubVmFs`, `nubVmRest`, `updateApply`, secrets).  
**Broken control:** `loader.ts:19-15` comments that "A remote source must NOT reuse this pipeline without a real boundary (iframe/worker + CSP + gating)" but the VM root **reuses it without that boundary and without `defaultEnabled:false`**. The two local roots are: `standalone = ~/.hermes/desktop-plugins` (no `defaultEnabled` → default-on, trusted — a local file can already run code) and `unified = ~/.hermes/plugins/*/desktop/plugin.js` (`defaultEnabled:false`, opt-in — sweep-1 GHSA posture). The VM root is registered at `loader.ts:261-267` with **no** `defaultEnabled`, so `entry.defaultEnabled` is `undefined`, and the activation predicate at `loader.ts:135` — `pluginActive(id, (plugin.defaultEnabled ?? true) && (options.defaultEnabled ?? true))` — defaults to `true`. `pluginActive` (`loader.ts:155-163`) only consults `localStorage maia:plugins:enabled:${id}`; absent → returns `defaultOn` (`true`). No integrity hash is supplied on the VM door (`loader.ts:89-91` `verifyIntegrity` is optional and never wired for VM entries).  
**Why the dashboard `/fs` workspace-only fix does not close it:** Platform `/api/instances/[id]/fs` `POST` correctly uses `safeVmWritePath` (`hermes-deploy/src/lib/vm-data-path.ts:44-53`) which restricts writes to `/opt/data/workspace/**`; `/opt/data/.hermes/desktop-plugins` is **not** writable through that API (scan of `hermes-deploy/src/app/api/instances/[id]/fs/route.ts:198,226` confirms). The agent on the cube does not need the dashboard API — it writes directly to its own filesystem (`/opt/data/...`). The per-VM threat model says a compromised agent owns its VM; this turns that into workstation code execution.  
**Impact:** Renderer JS execution with `window.nubAgent.{hud{clickAt,typeText,actStatus}, nubVmFs, nubVmRest, nubVmMcp, nubVmConfig, updateApply}` etc. An agent (or a model via prompt-injected Telegram/Discord webhook, pasted tool output, etc.) that writes a benign-looking `plugin.js` owning a folder name persists across the 5 s poll (`DISK_POLL_MS = 5000` at `loader.ts:214`) even without a local FS watch (`watchable:false` at `loader.ts:266` — poll-only).  
**Confidence:** Validated in code (full `diskRoots` → `scanDiskPlugins` → `loadDiskPlugin` → `loadRuntimePlugin` chain + test that asserts `nubVmFs('list', {path: VM_PLUGIN_ROOT})` is called). No runtime write was performed.  
**Fix (one of):** Register the VM root as `{dir: VM_PLUGIN_ROOT, defaultEnabled:false, kind:'agent-plugin'}` (or a new `agentPlugin` gate that defaults off and requires explicit user approval + a separate `localStorage` key), add an allowlist/consent UI before `import()`, and enforce `integrity` (sha256) on the VM door or sign the `plugin.js` manifest. At minimum, stop default-on evaluation of VM-sourced plugins. `watchRuntimePlugins` should not auto-import VM roots without opt-in. The local `~/.hermes` plugin-host jail (`electron/plugin-host.cjs`) does not cover VM roots — it must not be assumed to. While fixing, set `kind:'agent-plugin'` so `pluginActive`'s call site can distinguish the door.

---

**FIXED 2026-09-01** — commit `818cd07`, shipped in release 0.1.13. The
implemented control is the sha256 TOFU pin (fix option "enforce integrity on
the VM door", plus default-off until trusted): agent-owned roots set
`ownedBy:'agent'` → `pinned:true`; `loadDiskPlugin` hashes the entry file
(`hashSource`) and refuses to load unless the hash matches the pin written by
an explicit local enable (`setPluginEnabled` re-pins the current bytes at the
consent moment). First sighting publishes a held-for-trust inventory row
(status `disabled`, "waiting for your trust — enable it to load this VM
plugin"); a byte change after trust unloads the plugin and publishes a
"changed on the VM since you trusted it — re-enable to re-trust" error row.
Because the VM door is poll-only, `scanDiskPlugins` now re-reads poll-only
roots every cycle (hash-gated via `DiskPlugin.lastHash`) — previously changed
bytes were never re-read at all. `kind` stays `'disk'` in the inventory
(shipped shape); the agent-owned distinction rides `DiskRoot.ownedBy` /
`DiskPlugin.pinned` instead. Tests: 3 new TOFU gate cases in
`src/plugins/__tests__/loader.test.ts`; suite 1221/1221; `tsc -b` clean.

---

## D-02 — HUD `typeText` is the only act primitive that skips `hudActTrusted` (High)


**File:line:** `electron/main.cjs:846-865` (`maia:hud:typeText` handler), vs `electron/main.cjs:820-822` (`maia:hud:clickAt` → `hudClickAt` → `screenAct.actStatus` + `hudActTrusted`), `electron/main.cjs:348-359` (`hudActTrusted`), `electron/screen-act.cjs:141-157` (`actStatus` TRI-STATE)  
**Source → control → sink:** Untrusted agent text `[TYPE:text]` parsed in `src/components/HudShell.tsx:249-264` (`TYPE_ONCE_RE`) → `window.nubAgent.hud.typeText(text)` (`electron/preload.cjs:47`) → `ipcMain.handle('maia:hud:typeText')` at `main.cjs:846` which extracts `payload.text` and immediately `spawnSync('osascript', [... keystroke (item 1 of argv) ...], text)` without ever calling `hudActTrusted()`. The sibling `maia:hud:clickAt` (`main.cjs:820`) delegates to `hudClickAt(x,y)` which at `main.cjs:367` does enforce `status.trusted===false → {ok:false, accessibility-not-trusted}` before any `screenAct.clickAt`.  
**Impact:** Arbitrary `keystroke` into the frontmost app (type secrets destinations, confirmations, shell-looking input) even when the OS reports the app is not a trusted Accessibility client. The caller-supplied text is passed as an osascript `argv` entry (`main.cjs:848-855` `on run argv` + `item 1 of argv`), so it does not break out of AppleScript — the keystrokes themselves are the payload, not a shell injection. Independently reachable from D-03.  
**Confidence:** Validated in code (diff of the two handlers; `typeText` handler body contains zero references to `hudActTrusted`, `actStatus`, or `ACCESS_HINT`).  
**FIXED 2026-09-01** — commit `818cd07`, shipped in release 0.1.13. `maia:hud:typeText` now runs `screenAct.actStatus({platform, isTrusted: hudActTrusted})` and returns `{ok:false, error:'accessibility-not-trusted', hint:ACCESS_HINT}` before any `spawnSync`, exactly matching the click path. The per-action consent question stays with D-03 (unchanged, product call).

**Fix:** Gate `maia:hud:typeText` the same way as `clickAt`: `const st = screenAct.actStatus({platform, isTrusted: hudActTrusted}); if(st.trusted===false) return {ok:false, accessibility-not-trusted}` before any `spawnSync`. Consider also rate-limiting or requiring the HUD to be focused / user-initiated before typing (see D-03).

---

## D-03 — HUD auto-executes `[CLICK:]`/`[TYPE:]` from the latest agent message without per-action authorization (High, confused deputy)

**File:line:** `src/components/HudShell.tsx:245-284` (two `useEffect` on `visibleMessages`), `src/components/HudShell.tsx:229-244` (`actStatus` probe + `actIsBlocked`), `src/lib/hud-protocol.ts:23-29` (marker regexes), `src/lib/hud-protocol.ts:41-55` (`HUD_MARKER_NOTE` advisory rules), `electron/main.cjs:820-865` (sinks)  
**Source → control → sink:** Agent/chat message `content` (model output; attacker can influence via prompt injection on Telegram/Discord webhook, pasted file/tool output, or model hallucination) → `HudShell` selects `last = [...visibleMessages].reverse().find(m=>m.role==='agent')` (`HudShell.tsx:250,270`) → `TYPE_ONCE_RE.exec` / `CLICK_ONCE_RE.exec` extracts one marker per message → de-dupe by `last.id + coords` (`lastTypeKey`/`lastClickKey`) → `if(actIsBlocked()) return` else `hud.typeText(m[1])` / `hud.clickAt(x,y)`. `actIsBlocked` (`HudShell.tsx:243`) is `actStatus!==null && actStatus.trusted===false` — i.e. the **capability** gate, not an authorization check. The only prompt-side control is `HUD_MARKER_NOTE` rule 2 ("Only emit `[CLICK:]` or `[TYPE:]` when the user asked you to click or type") and rule 3 ("Never [CLICK:] destructive UI ... unless the user explicitly asked") — both are model-prompt text, advisory only, and markers are stripped from the bubble the user reads (`stripMarkers` at `HudShell.tsx:46-53`) so the user cannot see what will act.  
**Why this is not the same as D-02:** D-02 is a missing trust check on a single sink; this is the renderer policy that *drives* both sinks without ever asking "did the user consent to this specific click/type?". After the fix to D-02, `[TYPE:]` would at least require Accessibility trust; it would still fire unattended whenever the HUD is open and trusted.  
**Pre-conditions:** HUD window open (`?win=hud`) and Accessibility granted. The HUD is notably persistent: `electron/hud-state.cjs` persists `{expanded,orb,open}`; on packaged launch `createHudWindow()` auto-restores if `open===true` (`main.cjs:2011-2018`), `maybeRequestAccessibility()` (`main.cjs:572-587`) prompts once at first install (`systemPreferences.isTrustedAccessibilityClient(true)`) and persists an `accessibility-prompt.json` flag so the app can be granted and stay granted. `RECENT_HOLD_MS = 3500` (`HudShell.tsx:37`) collapses the strip to the orb when idle, but the orb remains clickable and act markers still fire.  
**Confidence:** Validated in code (no confirmation dialog, allowlist, or user-gesture gate in either effect; `assertMainSender` at `main.cjs:655-660` authenticates the *renderer process*, not the *model content*). Tests that assert `clickAt`/`typeText` from agent content (per the worker-03 ledger) would still pass.  
**Fix:** Do not auto-execute act markers. Options in descending preference: (a) remove auto-execution entirely — render a clickable "Click at (x,y) — Approve" chip that the human must press (with a one-time allowlist or hold-to-confirm for destructive targets); (b) if auto-act must remain, require an explicit prior user message containing an affirmative act intent in the same turn and surface the pending act in the bubble with a countdown that the user can cancel; (c) at minimum, never act while the HUD is unfocused / the orb is collapsed. Any auto path must log the act decision (`AuditLog` or local transcript) with the triggering `messageId`/marker.

**FIXED 2026-09-01 (option c, per operator product call)** — the main process refuses `maia:hud:clickAt` and `maia:hud:typeText` while the HUD is collapsed to the orb, fail-closed on unknown state (`electron/hud-act-gate.cjs::hudActVisibilityGate`, behavior-tested in `electron/d03-visibility-gate.test.mjs`), and the act is no longer silent: `describeActMarker` (`src/lib/hud-protocol.ts`) renders a visible act chip (click coords / typed-char count — never the typed text) in the bubble. The full per-action consent UI remains a deliberate non-goal until opt-in approvals ship.

---

## D-04 — Preview `nub-vm://` iframe can top-navigate the preload-bearing window (Medium)

**File:line:** `src/components/PreviewModal.tsx:127-145` (`<iframe src={src}` **without** `sandbox`), vs `src/components/PreviewModal.tsx:146-152` (`<iframe srcDoc={srcDoc} sandbox="allow-scripts allow-forms allow-modals">` with sandbox), `electron/vm-preview.cjs:31-50` (`registerScheme` `bypassCSP:false`, `NUB_VM_CSP` with `frame-src 'self'`), `electron/main.cjs:718-730` (`setWindowOpenHandler` only), no `will-navigate`/`will-frame-navigate` anywhere in `electron/*.cjs`  
**Source → control → sink:** A project artifact file or live port on the VM (`/opt/data/workspace/**`) served through `nub-vm://file/...` or `nub-vm://p<port>/...` via `protocol.handle('nub-vm')` (`vm-preview.cjs:139-152,192-211`). The outer window is `file://…/dist/index.html` (or dev server) with `preload.cjs` exposing `window.nubAgent` (tokens, VM FS, updates, HUD). The artifact content is **untrusted** (agent-writable). The preview iframe for that content at `PreviewModal.tsx:133-141` renders `<iframe src="nub-vm://…">` with `allow="clipboard-read; clipboard-write"` but **no** `sandbox`. `electron/main.cjs:718` installs `setWindowOpenHandler` (denies `window.open` to arbitrary https except `isBrowserSafeExternalUrl`, opens safe ones externally) but there is **no** `webContents.on('will-navigate')` / `will-frame-navigate` handler that would block `top.location = "https://evil.example"` from inside the `nub-vm` frame. `vm-preview.cjs:NUB_VM_CSP` (`frame-src 'self'`) blocks nested framing of foreign content *inside* the preview frame, but does not stop the preview frame from navigating the parent.  
**Impact:** VM-controlled content can navigate the desktop app's main window away from the app (`will-navigate` on the outer `webContents`). After navigation the new document still runs with the preload (same `webPreferences: sandbox:true, contextIsolation:true` session) but the app shell is gone; an attacker could render a look-alike login or attempt to exfiltrate data the app later renders. Practical pre-condition: user opens Preview for an agent-written page (common path). Not automatic without user action, but a single click on the Preview button suffices.  
**Confidence:** Validated in code (the two iframe branches differ only in `sandbox`; `will-navigate` grep returns nothing).  
**Fix:** Add `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` (or the minimal `allow-scripts` needed) to the `nub-vm://` iframe as well, and install a `will-navigate` / `will-frame-navigate` guard on both `mainWindow` and any window that hosts `PreviewModal` that allows only `file://…/dist/index.html`, `nub-vm://…`, and the dev server origin, denying any `https:`/`http:` top navigation (or at least prompting). Alternatively, host `nub-vm://` content in a `BrowserView`/`WebContentsView` with a separate partition instead of an inner iframe.

**FIXED 2026-09-01** — both halves. The `nub-vm://` src iframe now carries the same sandbox as the srcDoc branch — in BOTH `PreviewModal.tsx` (kept pinned though orphaned: nothing imports it) and, importantly, `ComputerPanel.tsx::PageFrame`, the actually-shipped nub-vm page surface whose src branch was also unsandboxed (release-build bundle grep caught the gap before upload) — and a `will-navigate` guard (`electron/vm-nav-guard.cjs::willNavigateGuard`, behavior-tested in `electron/d04-will-navigate.test.mjs` incl. origin-confusion look-alikes) is installed on **both** `mainWindow` and `hudWindow`, allowing only the app's own origin, `nub-vm:`, and denying everything else. `setWindowOpenHandler` remains the sole external-https path.

---

## D-05 — Update version binding is a prefix test and does not enforce newer-than-installed (Medium)

**File:line:** `electron/main.cjs:1674` (format check `^v?\d{1,4}(\.\d{1,3}){0,3}$`), `electron/main.cjs:1759-1767` (mac bash: `STAGED_VERSION != EXPECTED_VERSION*`), `electron/main.cjs:1829-1833` (win ps1: `StartsWith`), `electron/main.cjs:1494-1512` (`compareVersions`/`versionParts` — not consulted during apply), `src/lib/updates.ts:74-88` (manifest compare)  
**Source → control → sink:** Renderer-supplied `payload.version` + URL + sha256 + Ed25519 `signature` at `maia:updateApply` (`main.cjs:1647-1683`) → `downloadZip` → `verifyUpdateSignature(zipBytes, signature)` (`main.cjs:1705`) + sha256 match → `expectedVersion` forwarded as `$4`/`-ExpectedVersion` into the detached helper (`main.cjs:1855,1860`) → helper stages the zip via `ditto`/`Expand-Archive` and then checks **prefix**: bash `[[ "$STAGED_VERSION" != "$EXPECTED_VERSION"* ]]` (`main.cjs:1764`) or PowerShell `!StagedVersion.StartsWith(expected)` (`main.cjs:1831`). A comment at `main.cjs:1760` documents the prefix as intentional for 4-part `CFBundleShortVersionString` (e.g. `0.1.9.0` satisfying `0.1.9`).  
**Gap:** `0.1.10` satisfies expected `0.1.1` (`"0.1.10".startsWith("0.1.1") === true`), so a signed artifact for `0.1.10` can be installed when the manifest claimed `0.1.1` — a different (including older, excluding newer build's fixes) **still-signed** bundle than intended. No check compares `stagedVersion` against `app.getVersion()` (anti-rollback absent), so a signed older build with a known flaw can be reinstalled over a newer patched desktop. Authenticity (Ed25519 at `electron/update-signature.cjs`, origin `https://download.maiavm.com/` at `main.cjs:1495/1668`, sha256) still holds — this weakens *which* signed build is installed, not *whether* the zip is vendor-signed.  
**Confidence:** Validated in code (helper scripts inlined at `main.cjs:1729-1851`; `compareVersions` exists but is never called from `updateApply`). Historical `release/` zips make the cross-version substitution concrete.  
**Fix:** Replace prefix with `compareVersions(staged, expected)===0` (or a normalized `==` that tolerates a trailing `.0` for CFBundle) and enforce `compareVersions(staged, app.getVersion()) > 0` (or `>=0` with a policy flag). Keep the Ed25519 + origin + sha256 checks as the authenticity gate.

**FIXED 2026-09-01** — both halves. (1) Anti-rollback: `maia:updateApply` now refuses `compareVersions(expectedVersion, app.getVersion()) <= 0` **before any download** (the manifest flow only ever offers strictly newer; same-version replay is refused with it). (2) Exact binding: both helpers compare exact-normalized equality — trailing `.0` stripped once per side (`STAGED_NORM="\${STAGED_VERSION%.0}"` bash, `-replace '\.0$',''` PS 5.1) so `0.1.9.0 == 0.1.9` still holds while `0.1.10 ≠ 0.1.1` — and the old prefix shapes are assert-gone in `src/lib/__tests__/update-apply.test.ts` (mutation-verified). Ed25519 + origin + sha256 unchanged.

---

## D-06 — HUD act backends spawn `cliclick`/`osascript` by bare name, bypassing `bin-guard` (Medium)

**File:line:** `electron/screen-act.cjs:76-101` (`BACKENDS` three `file: 'cliclick'` / `'osascript'`), `electron/screen-act.cjs:104-111` (`defaultHasBin` `spawnSync('/usr/bin/which', [name])`), `electron/screen-act.cjs:184-189` (`runner(file,args)` — bare name), `electron/main.cjs:850-856` (`spawnSync('osascript', [keystroke…], text)`), `electron/bin-guard.cjs:93-118` (`resolveTrustedBin` — used for `hermes`, `git`, `task` but not for HUD)  
**Source → control → sink:** First value of `$PATH` (including user-controlled entries from `~/.zshenv`, `launchctl setenv`, or a planted directory) → `BACK ENDS[0].argv → {file:'cliclick'}` or `{file:'osascript'}` → `spawnSync(file, …)` with no `bin-guard` resolution. A user-writable early `PATH` entry containing a `cliclick` or `osascript` shim executes at HUD act time. `typeText` (`main.cjs:850`) is the same.  
**Pre-condition:** Local env control (not remote). At install time `PATH` typically contains `/opt/homebrew/bin` / `/usr/local/bin` (user-writable depending on Homebrew setup), so a local malware or a developer's shell profile can plant a binary. The app's own `bin-guard` (`resolveTrustedBin` → `verifyAndLogBin` → not group/world-writable + `fs.constants.X_OK`) deliberately avoids this class for `hermes`/`git`/`task`; HUD was never wired through it.  
**Confidence:** Validated in code (every `BACK ENDS` entry uses a bare name; `bin-guard` import is absent from `screen-act.cjs` and from the `typeText` handler).  
**Fix:** Resolve through `bin-guard.resolveTrustedBin('osascript')` (and `cliclick` if kept) or hardcode `/usr/bin/osascript` for the `osascript` backends. For `cliclick`, keep the `hasBin` probe but gate the spawn through the trusted resolution; fall back to the JXA/System Events backends if the guard refuses.

**FIXED 2026-09-01** — `screen-act.cjs` resolves every backend spawn through `defaultResolveActFile` (`/usr/bin/osascript` pinned; cliclick via `bin-guard.resolveTrustedBin`, backend dropped when the guard refuses — a planted group-writable cliclick is refused, tested live in `screen-act.test.mjs`), and `maia:hud:typeText` uses the same resolver instead of `spawnSync('osascript', …)`. Bare-name spawns assert-gone in `electron/security-invariants.test.mjs` (mutation-verified).

---

## D-07 — Packaged app still honors `MAIA_ELECTRON_DEV` + `VITE_DEV_SERVER_URL` (Low)

**File:line:** `electron/main.cjs:18` (`isDev = !app.isPackaged || MAIA_ELECTRON_DEV==='1'`), `electron/main.cjs:142-149` (`hudUrl()` → `loadURL(VITE_DEV_SERVER_URL)` when `isDev`), `electron/main.cjs:725-727` (`mainWindow.loadURL(VITE_DEV_SERVER_URL)` when `isDev`), `electron/nub-link.cjs:23-30` (`apiBase` ignores `MAIAVM_API_BASE` when `app.isPackaged` — the API side was hardened, the renderer side was not)  
**Source → control → sink:** Packaged app environment (local attacker: `launchctl setenv MAIA_ELECTRON_DEV 1`, `~/.zshenv` export, or a `.plist` `LSEnvironment`) → `isDev === true` inside a packaged `.app` → both `mainWindow` and `hudWindow` `loadURL` an attacker-supplied `VITE_DEV_SERVER_URL` (any `http(s)://` — not pinned) with full `preload.cjs` (`contextBridge` `window.nubAgent`).  
**Impact:** Renderer origin substitution. Not remote RCE by itself — requires local env write, the same class the platform calls "attacker-influenceable" for API base. Once redirected, the new origin's JS has the preload IPC (tokens, VM FS, HUD, updates). Separate from D-06/D-11 because it controls the *origin* rather than a *binary* or the CSP.  
**Confidence:** Validated in code (single boolean `||`; `nub-link.cjs:23-30` negative control shows the intended packaged-app pattern is to ignore env).  
**Fix:** In packaged builds ignore `MAIA_ELECTRON_DEV` and `VITE_DEV_SERVER_URL` (i.e. `isDev = !app.isPackaged && MAIA_ELECTRON_DEV==='1'` only when an explicit local-dev flag file is present, or gate behind `--enable-packaged-dev` argv). Keep `hudUrl()` → `file://…/dist/index.html` when packaged.

**FIXED 2026-09-04** — packaged ignores both env vars unless `--enable-packaged-dev` argv is passed (`electron/main.cjs`; `isDev = !app.isPackaged || (packagedDevAllowed && env==='1')`). Dev workflow unchanged (`!app.isPackaged` still loads the dev server). Tripwired in `electron/security-invariants.test.mjs` (D-07/D-08/D-09 suite).

---

## D-08 — `vmPath` allowlist is a prefix test without a boundary slash (Low)

**File:line:** `electron/nub-link.cjs:1012-1018` (`vmPath`: `raw.startsWith("/opt/data")` + length/NUL/`..` checks, no normalization), `electron/nub-link.cjs:1025` / `1275` / `1368` / `1395` (all `vmFsHandle`/`vmPreview*` doors), vs `electron/vm-copy.cjs:52`, `electron/vm-copy.cjs:107` (`isInsideRoot('/opt/data', path.resolve(...))` — correct)  
**Source → control → sink:** Renderer `nubVmFs({verb,path})` / `nubVmScreenshot` `pageUrl` / preview `filePath` with attacker-chosen string → `vmPath` gates → `dashboardRequest(session,'GET', '/api/fs/list?path=…')` or `dashboardRaw('/api/preview/file?path=…')` authenticated as the linked VM. `vmPath` accepts `/opt/database`, `/opt/data.bak`, `/opt/data2/evil` because `startsWith("/opt/data")` has no slash boundary.  
**Impact:** If the VM filesystem (or dashboard impl) has siblings sharing the `/opt/data` prefix, renderer (or XSS in the app) can read/write outside `/opt/data/`. Full host escape is not claimed (`vm-copy.cjs` uses canonical `isInsideRoot` and `fs-guard.cjs` is correct; the platform `safeVmDataPath` also enforces `"/opt/data/"`). Enumerated sibling risk is low — production cubes mount `/opt/data` as a volume, unlikely to have `/opt/database` — but the prefix test is strictly weaker than the documented `insideRoot` invariant.  
**Confidence:** Validated in code (three-character difference vs `isInsideRoot`; negative control at `vm-copy.cjs` shows the intended pattern).  
**Fix:** `if (raw !== "/opt/data" && !raw.startsWith("/opt/data/")) return null` (or reuse `isInsideRoot('/opt/data', path.resolve(raw))`). Add `path.normalize` / `path.resolve` before the check.

**FIXED 2026-09-04** — exact shape above in `electron/nub-link.cjs::vmPath` + `electron/preload.cjs::nubVmZipSave` mirror; `vmPath` exported for behavioral tests (`electron/nub-link-security.test.mjs` D-08 suite: siblings rejected, legit paths pass).

---

## D-09 — MCP OAuth loopback suffix check accepts ancestor hosts (Low, narrow pre-conditions)

**File:line:** `electron/nub-link.cjs:1476-1502` (`makeMcpOAuthCallbackHandler` → `foreignWebOrigin`), `electron/nub-link.cjs:1545-1548` (`onHit(parsed.search)`), `electron/nub-link.cjs:1556-1576` (`listenForMcpOAuthCallback` on `127.0.0.1:<port>`, 5-min timer)  
**Source → control → sink:** HTTP `Origin` / `Referer` header on `GET http://127.0.0.1:<port>/callback?code=…` during MCP OAuth (the local server bound by `listenForMcpOAuthCallback`, port default `8765` or provider-supplied `callbackPort`). `foreignWebOrigin` at `nub-link.cjs:1498-1501` returns `false` (i.e. "not foreign") when `host===idpHost || host.endsWith('.'+idpHost) || idpHost.endsWith('.'+host)`. The third disjunct accepts *ancestors* of the IdP: if `idpHost=accounts.google.com`, `host=google.com` or `host=com` both pass (`"accounts.google.com".endsWith(".com")` is true).  
**Impact:** A page whose hostname is an ancestor of the IdP host could forward an attacker-completed OAuth `code` into the local listener during the 5-minute window. Pre-conditions: (a) the attacker controls an ancestor host of the IdP (e.g. `google.com`, `com`) — not plausible for public suffixes — or a sibling that exploits the second disjunct (`host.endsWith('.'+idpHost)` — also broad). In practice the intended sibling-subdomain support (`accounts.*` → `auth.*`) over-accepts the public suffix. Requests with **no** `Origin`/`Referer` (top-level navigation from the IdP itself, local process) are correctly accepted (`foreignWebOrigin('') → false`). Non-ancestors are still rejected (403) and non-`GET` / non-`/callback` / empty-query requests are dropped. So drive-by from a random attacker site remains blocked — the flaw is ancestor over-accept, not open acceptance.  
**Confidence:** Validated in code (pure function `makeMcpOAuthCallbackHandler`; `host`/`idpHost` are lowercased, loopback hosts exempted). The worker-04 report's `https://com` example is accurate per the `endsWith` line.  
**Fix:** Drop the third disjunct. Allow only `host===idpHost || host.endsWith('.'+idpHost)` (IdP itself or a subdomain of the IdP), not the reverse. Consider an additional PSL-aware check or an explicit IdP suffix allowlist if provider sibling-subdomain flows require it. Keep the other hardening: `GET`-only, `/callback` only, loopback bind, single-use `server.close()` after 200, 5-min timer.

**FIXED 2026-09-04** — third disjunct removed in `electron/nub-link.cjs::foreignWebOrigin`; ancestors (`google.com`, `com`) now 403 while IdP + subdomains still 200 (behavioral tests in `electron/nub-link-security.test.mjs` D-09 suite). Sibling-subdomain hops outside the IdP registrable domain must be listed explicitly by the provider.

---

## D-10 — Android `FileProvider` `external-path path="."` (Low)

**File:line:** `android/app/src/main/res/xml/file_paths.xml:3` (`<external-path name="my_images" path="." />`), `android/app/src/main/AndroidManifest.xml:46-54` (`provider android:exported="false" android:grantUriPermissions="true"`), `capacitor.config.ts` (`android.allowMixedContent:false`, `server.androidScheme:'https'`)  
**Source → control → sink:** Any code path that calls `FileProvider.getUriForFile` with a file under external storage → `content://com.maiavm.nub.fileprovider/...` URI → granted to another app via `grantUriPermissions`. `path="."` is the external storage root, not a subdirectory; the grant is unbounded within that tree.  
**Impact:** Over-sharing. A plugin or Capacitor share/camera flow that grants a URI could expose more of external storage than needed (classic Capacitor default). Not automatic world-readable (`exported=false`); attacker must be the grant recipient and the app must have granted that specific URI. No new `READ_MEDIA_*` or `READ_EXTERNAL_STORAGE` grant is implied — the provider is the sharing surface, not a permission bypass.  
**Confidence:** Validated in code (the two-line `file_paths.xml` is the entire provider config).  
**Fix:** Narrow `path` to the app-specific directory actually shared (e.g. `external-files-path` / `external-cache-path` with a concrete `path="shared/"` or per-feature subdir) and audit every `getUriForFile` / Capacitor `Share` / `Camera` grant.

**FIXED 2026-09-04** — `android/app/src/main/res/xml/file_paths.xml` now scopes to app dirs (`external-files-path`/`external-cache-path`/`cache-path`/`files-path` under `shared/`); grep shows zero in-repo `getUriForFile` callers, so nothing needed migration.

---

## D-11 — Android build ships the Electron CSP (Info/Low)

**File:line:** `scripts/build-android.mjs:46` (`run('npx',['vite','build'])`), `vite.config.ts:8-23` (`WEB_CSP = "default-src 'self'; … connect-src 'self' https://www.maiavm.com …"`), `vite.config.ts:24-38` (`webCspPlugin` → injected only when `mode==='web'` at `vite.config.ts:39`), `index.html:9-10` (default CSP: `default-src 'self'; … img-src 'self' data: blob: nub-vm: https:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://www.maiavm.com … https://download.maiavm.com; frame-src 'self' https: http: nub-vm: data: blob:;`), `dist/index.html` (verified to contain the default/Electron CSP after `vite build`, not `WEB_CSP`; `dist/index.html` after `vite build --mode web` would contain `WEB_CSP` — not produced by `build-android.mjs:syncWeb`)  
**Impact:** The Android APK (`capacitor.config.ts: appId com.maiavm.nub, webDir dist, androidScheme https, allowMixedContent:false`) embeds `dist/index.html` via `npx cap sync android`. `build-android.mjs:syncWeb` runs bare `vite build`, so `mode` is not `"web"` and `webCspPlugin` never runs — the Capacitor WebView ships the Electron policy. That policy allows `connect-src http://127.0.0.1:* http://localhost:*` (local dev hosts, NOP on device), `frame-src http: nub-vm: data: blob:` (more permissive than `WEB_CSP`'s `frame-src 'self' https:`) and `nub-vm:` img. No direct XSS, but the WebView is rendered more permissive than the hosted `https://agent-nub-lol.vercel.app` (`vercel.json` builds with `--mode web` and serves the `WEB_CSP` meta + `frame-ancestors 'self'` response header).  
**Confidence:** Validated in code + artifact (`dist/index.html` CSP content present above; `android/app/src/main/assets/public/` mirrors `dist/` after `cap sync`).  
**Fix:** `scripts/build-android.mjs:syncWeb` → `run('npx',['vite','build','--mode','web'])` (or `vite build --mode web` + a separate `vite build` for Electron if a single `dist/` is shared). Verify the packaged APK's `assets/public/index.html` contains `WEB_CSP` and does **not** contain `nub-vm:` / `http://127.0.0.1`.

**FIXED 2026-09-04** — exact shape above (`scripts/build-android.mjs::syncWeb`); artifact-proven: `--mode web` emits WEB_CSP with zero `nub-vm:`/`127.0.0.1` (gate G6). `electron:build` re-runs bare `vite build` first, so Electron dist is unaffected.

---

## Controls verified (not findings — swept, no regression beyond D/L rows)

- **C1 Ed25519 update signature** (`electron/update-signature.cjs`, `electron/main.cjs:1705` `verifyUpdateSignature`) — still required; origin pin `UPDATE_ORIGIN https://download.maiavm.com/` enforced at `main.cjs:1495/1668`; sha256 64-hex required at `main.cjs:1671`. Only the *which-precise-build* binding is weak (D-05).
- **C2 API pin in packaged builds** (`electron/nub-link.cjs:23-30` `isPackaged` gate — env overrides ignored when packaged) — verified still true. Renderer origin pin hole is the *sibling* `isDev` at `main.cjs:18` (D-07), not a regression of the API pin.
- **H1 MCP stdio allowlist** (`electron/nub-link.cjs:1408-1447` `MCP_STDIO_RUNNERS` + `MCP_STDIO_FORBIDDEN`, `validateStdioMcpCommand` called at `nub-link.cjs:1769`) — still enforced before any VM `uvx`/`npx` spawn.
- **H2 OAuth loopback GET-only + `/callback` + 127.0.0.1 + 5-min timer** (`nub-link.cjs:1505-1576`) — present; only the ancestor-suffix predicate is over-broad (D-09).
- **H3 `nub-vm:` CSP** (`electron/vm-preview.cjs:31-50` `bypassCSP:false` + `NUB_VM_CSP` with `object-src 'none'` + `frame-src 'self'`) — present. Preview framing of the outer window is the gap (D-04), not the protocol's own policy.
- **H4 `openHttps` confirm** (`electron/main.cjs:881-909` `dialog.showMessageBox` with full `target` detail, `isIpcSafeExternalUrl` fast-path at `main.cjs:42-55` + `preload.cjs:10-31`) — still dialog-gated for non-allowlisted `https:`.
- **M1 `fs-guard` + `plugin-host` jail** (`electron/fs-guard.cjs:31-72` `isInsideRoot` with `realpath` + parent traversal, `hardenedReadFile`/`hardenedWriteTextFile` at `main.cjs:1101-1132` with `realpathSync` + `O_NOFOLLOW`, `fs-guard.cjs:108-118` `validateFsPath`, `vm-copy.cjs:52` `isInsideRoot('/opt/data')`) — all present; `vmPath` prefix without slash at `nub-link.cjs:1015` is the one lexical gap (D-08).
- **Bin-guard for `hermes`/`git`/`task`** (`electron/bin-guard.cjs:93-118` `resolveTrustedBin` + `verifyAndLogBin`, used at `main.cjs:947` `hermes`, `main.cjs:1149` `git`, `main.cjs:1366` `task`) — not wired for HUD act (`screen-act.cjs`, `main.cjs:typeText`) — that is D-06.
- **Git `hooksPath=/dev/null` + `fsmonitor=false`** (`main.cjs:1145` `GIT_SAFE_CONFIG`) — present.
- **`VITE_MAIAVM_API_BASE` ignored when packaged** (`nub-link.cjs:23-30`) — confirmed; packaged-dev flag is the distinct `MAIA_ELECTRON_DEV` at `main.cjs:18` (D-07).
- **`vercel.json` SPA + fixed-host rewrite** (`vercel.json:9-22` → `destination: "https://www.maiavm.com/api/:path*"` and `source: "/(.*)"` `frame-ancestors 'self'`) — not a finding.

---

## Dropped leads (not promoted)

- **xlsx 0.18.5 / `exceljs` migration, `extract-zip` GHSA, `release/` Chromium Trees** — not in runtime path or isomorphic to the desktop install's shipped files — per-worker `not_applicable` (W01, W03, W04 seed_research).
- **`nub-upload.jks` / `android/nub-upload.jks` ("signing secret in repo")** — gitignored (`.gitignore` + build check at `scripts/build-android.mjs:63-75`), not tracked, `allowBackup:false` + `dataExtractionRules` — not a finding unless committed, and it is not.
- **MCP custom HTTP URL allowlist, bridge webhooks, `avatarUrl` `data:image` rejection, `deepMerge` `__proto__` guard, cron `CRON_SECRET` bearer, `workbench` mutations `assertAdmin`** — verified present in worker-05 negative controls; not re-reported.
- **"Desktop poll withholds `gatewayToken`", "Stripe customerId immutability", "Solana on-chain re-verify", "admin `assertAdmin`"** — worker-05 negative controls, still true in this tree.
- **"Local plugin-host jail does not close the VM door"** — not a dropped lead: the jail was never intended to cover `nubVmFs` (`src/lib/plugins/vm-fs-door.ts`); the RCE remains the VM default-on policy (D-01), not a jail escape.
- **"M5 HUD spawn gap is just `cmd` vs `cliclick`"** — not collapsed: `typeText`'s bare `osascript` is a distinct sink from `screen-act.cjs`'s `cliclick`/`osascript` backends; kept separate (D-06) and from trust (D-02) and consent (D-03) per the quality bar.

---

## Not fully cleared (carry to next sweep)

- The 10-run `api_server` job cap interaction with desktop chat vs. files (`electron/nub-link.cjs:448-495` `MAX_DESKTOP_INFLIGHT=2` + `nub-link.cjs:848-892` `dashboardRequest` fallback chain) was not load-tested live; the static gate looks correct but starvation under burst was not exercised.
- `nub-vm://computer` screenshot path (`vm-preview.cjs` `computer`, `nub-link.cjs:vmComputerScreenshot`) and `mimeFromPath` allowlist — static review only.
- Full Android WebView audit beyond `file_paths.xml` / `build-android.mjs` / `capacitor.config.ts` / `AndroidManifest.xml` (WebView `setAllowFileAccess`, `setAllowContentAccess`, mixed-content, JS bridge review) — not exercised.
- `electron/secrets-op.cjs` (`op` fixed-path + AgileBits team-id pin) was spot-checked, not fully re-exercised against a live 1Password install.
- GitHub workflows secret interpolation beyond `deploy.yml` static grep (the remaining `.github/workflows/*.yml` were not deeply traced for `${{ }}` taint).
- `src/lib/vm-preview.ts` / `src/lib/project-artifacts.ts` port-mapping and `isDevServerPort` (`livePreviewUrl`) — CSP and navigation reviewed, runtime proxy fallback chain not live-probed.

---

## Vercel + supply-chain checks

- **Vercel (free, both projects linked):** `hermes-deploy` (`prj_Ivi4oPkOsBF19mkO0jOeUaaHd5XG`) and `agent-nub-lol` (`vercel.json` builds `tsc -b && vite build --mode web`, response header `frame-ancestors 'self'` / `SAMEORIGIN`, rewrite `/api/:path*` → fixed `https://www.maiavm.com/api/:path*` — not user-controlled). Custom WAF rule counts `[]`, DDoS default on; `vercel firewall overview` 404 on IP Bypass is expected on the free plan (per brief, ignored).
- **Env:** `electron/nub-link.cjs:apiBase` and `electron/main.cjs:18` consume `MAIAVM_API_BASE` / `VITE_MAIAVM_API_BASE` / `MAIA_ELECTRON_DEV` / `VITE_DEV_SERVER_URL` — the packaged-app divergence between API (pinned) and renderer (not) is D-07. `NEXT_PUBLIC_*` in hermes are non-secret URLs/flags.
- **Backdoor-hunter:** `artifacts/01_context/unicode_scan.txt` is French i18n in `release/win-unpacked/LICENSES.chromium.html` (`exigé`, `présent`, `Kohlschütter`, etc.) + `µs` in a gate doc — no bidi / homoglyph / zero-width / `eval(` hidden payload. `supply_chain_scan.txt` is `package-lock.json` `resolved: https://registry.npmjs.org/...` plus sponsor URLs — no `postinstall` hook, no direct `github:` tarball outside `@prisma` scope. No sweep-5 backdoor.

---

## Method note

This is a **coordinator-finished static red-team using the DeepSec method + Vercel free skills + backdoor-hunter**, not a "Deep Security Scan completed" — the workflow's discovery round was unsaturated (workers 402'd before the validation/attack-path phases). The desktop slice consumed 523 files (`rank_input.jsonl`/`deep_review_input.jsonl`) but the parent worklist listed Electron *test* files, not `electron/*.cjs` implementations — those were add-backed as supporting privileged files by workers 01/03/04. Re-review treated every lead as unproven until the cited line was read.

---

## References

- `hermes-deploy/docs/red-team-sweep-5.md` (platform sweep — combined summary at top)
- `hermes-deploy/docs/red-team-sweep-4.md` (2026-08-24 — 5 findings, all fixed)
- DeepSec partials: `worker-01/finding_discovery_report.md` (w01-001..005), `worker-03/finding_discovery_report.md` (DSS-R01-W03-001..004), `worker-04/finding_discovery_report.md` (W04-001..007)
- Task brief 2026-08-30 (§Prior remediations, §Confirmed-looking candidates 1–10, §Hermes surfaces still under-reviewed, §Vercel free)
