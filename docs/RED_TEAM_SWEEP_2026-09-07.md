# Desktop Red Team Sweep 2 — 2026-09-07 (delta since 2026-08-30)

**Scope:** `maiavm-desktop` delta `a1ed956..HEAD` (47 commits). Focus: update-process overhaul (#29, touches the signed pipeline), browser-use runner slice (#25), notify polling (#17), LoopLab/LoopStudio dev tracks, dead-VM retry copy, plus regression check that D-01..D-11 fixes still hold.

**Method:** No subagents. No paid scans. Static analysis + live artifact checks (dist bundle grep, signature skill script executed green). No payloads fired; no prod touched.

**Headline:** No Critical or High findings. 1 Low (defense-in-depth recommendation, no code change). All prior-sweep controls verified intact.

---

## Findings

### L-1 — desktopToken lives in localStorage, not OS keychain (Low, recommendation)

**Where:** `src/mobile/session.ts:24-30` (localStorage on Capacitor/Electron, sessionStorage on web).

**Detail:** The `nub_desk_…` bearer grants full VM control via the platform API (chat, fs, MCP, config — and post-sweep-7 it clears step-up). In Electron it sits in plaintext localStorage. Exploitation requires a pre-existing renderer XSS — and the current renderer has no unsanitized sink (rich HTML goes through DOMPurify profiles, iframes sandboxed, CSP pinned, `nub-vm://` nav-guarded). So this is latent hardening, not a live hole.

**Recommendation:** Move the Electron token to `safeStorage` (AES via OS keychain) behind a small preload IPC (`nubAgent.secureStore`), keeping localStorage for Capacitor/web. Requires main-process plumbing + migration path for existing installs — deliberately NOT done in this pass (lift + regression risk outweighs a latent finding). Revisit alongside the D-03 consent UI work.

---

## Verified clean (this pass)

- **Signature-gated release chain**: skill script `verify-release-sigs.py` PASS on current tree (all zips + `.sig`, latest.json shape). `verifyUpdateSignature` still precedes checksum at `electron/main.cjs:1883`.
- **Update overhaul (786d76b)**: preload mirrors main-process validation (exact `download.maiavm.com` host pin, sha/sig/version formats, no-arg updateCheck). 25 red-verified behavioral pins.
- **D-01 TOFU pins**: `ownedBy:'agent'` + `pinned` + `hashSource` re-read intact in `src/plugins/loader.ts`.
- **D-02/D-03**: typeText trust gate + HUD visibility gate untouched.
- **D-04**: both iframe branches sandboxed; will-navigate guards on main + HUD windows.
- **D-05**: `compareVersions` still gates `updateAvailable` (`main.cjs:1664`).
- **D-06**: bin-guard act spawns untouched.
- **D-07..D-11**: zero commits to `file_paths.xml`, `build-android.mjs`, `nub-link.cjs` origin checks, `vm-copy.cjs` since the fixes.
- **LoopLab/LoopStudio prod exclusion**: `isProdBuild()` is build-time `import.meta.env.PROD`; dist bundle grep confirms zero LoopStudio code in shipped assets (sole "LoopLab" hit is mermaid's `getSelfLoopLabelPosition`).
- **XSS sinks**: only two `dangerouslySetInnerHTML` sites (mermaid SVG, KaTeX HTML), both pass DOMPurify profiles in `markdown-math.ts` (verified in code). Bell + chat bubbles render as text.
- **Unlink**: server-side `revoke` + local clear (`unlinkMobileSession`); no orphaned bearer.
- **Browser-use slice (#25)**: desktop only polls job state/progress over authenticated transport; `startUrl` is passed to the server — SSRF validation for it lives server-side (hermes-deploy/VM gateway), flagged as cross-repo follow-up, not a desktop finding.
- **Notify (#17)**: localStorage cache of server bus items, capped, shape-validated on read; no privileged actions from notification content.

## Dropped leads

- **Preload `updateApply` mirror is fail-open by comment**: preload validates shape only; main re-validates authoritatively (stated in-code). Correct layering, not a finding.
- **`latest -> 2026-08-31` stale symlink** in `~/workflow-journal/overnight/`: journal rotator issue, not this repo.
- **D-03 per-action consent**: still deferred by operator product call (unchanged scope).

---

## Checks

- `python3 verify-release-sigs.py` — PASS (3 zips + sigs)
- dist bundle grep for LoopStudio/dev tracks — clean
- No product code changed in this pass (docs-only); no test run required
