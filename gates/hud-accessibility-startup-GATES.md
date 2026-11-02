# Gates: HUD accessibility request-at-startup

Scope: close the macOS chicken-and-egg — a fresh Nub Agent install does not
appear in System Settings → Privacy & Security → Accessibility until SOMETHING
calls `isTrustedAccessibilityClient(true)`, and before this pass that only
happened from the HUD's Enable button, i.e. AFTER an act had already been
refused (`[CLICK:]`/`[TYPE:]` return `accessibility-not-trusted`).
This pass surfaces the request at boot, at most once per install.

Out of scope (declared): a Tray icon, auto-restoring the orb at launch.
(Both shipped 2026-08-29 — see gates/hud-mascot-widget-GATES.md G10+G11.)

---

- [x] **A1: the request is surfaced at startup, macOS only.** Called from
    `app.whenReady()`, before `createWindow()`, on darwin only.
  CHECK: `npx vitest run electron/hud-guards.test.mjs 2>&1 | tail -4`
  EXPECT: `/Test Files\s+1 passed/`
  EVIDENCE: Tests 55 passed (55) — new 'accessibility request-at-startup'
    describe: 'requests the Accessibility trust once at startup, macOS only'
    pins `process.platform !== 'darwin'` and `isTrustedAccessibilityClient(true)`.
  MUTATION-TESTED: deleting the darwin gate → 1 failed.

- [x] **A2: already-trusted installs are a no-op — no dialog, no flag file.**
    The trusted check (`(false)`) returns before the flag write.
  EVIDENCE: tripwire asserts the trusted-check index is before the flag write.

- [x] **A3: at most once per install — the "asked" flag persists in userData
    and is written BEFORE the prompt** (a crash mid-prompt must not re-prompt
    next boot; delete the file to re-prompt).
  EVIDENCE: tripwire pins `accessibility-prompt.json` under
    `app.getPath('userData')`, the exact `if (fsSync.existsSync(flagFile)) return`
    guard, and write-before-prompt ordering.
  MUTATION-TESTED: negating the flag guard (prompt only when the flag EXISTS)
    → 1 failed (this was the one mutation the first tripwire missed — it only
    matched the call, not the negation, which silently dead-features a fresh
    install; the tripwire now pins the exact guard).

- [x] **A4: smoke/probe runs never hang on the system dialog.**
  EVIDENCE: tripwire pins the `NUB_SMOKE_HUD`/`NUB_SMOKE` skip; live
    `NUB_SMOKE_HUD=1` smoke boots with no dialog and prints
    `[hud] smoke ok` + the menu lines.
  MUTATION-TESTED: dropping the smoke skip → 1 failed.

- [x] **A5: a failure never blocks boot.**
  EVIDENCE: tripwire pins the `catch` + `console.warn('... skipped:')`.
  MUTATION-TESTED: dropping the smoke skip also exercises the guard.

- [x] **A6: full suite green.**
  CHECK: `npx vitest run 2>&1 | tail -4`
  EXPECT: no failed line
  EVIDENCE: Test Files 145 passed · Tests 1198 passed (1200) — the 2 failures
    are the pre-existing sandbox-only `electron/fs-guard.test.mjs` EPERM cases
    (agent shell cannot write ~/.fs-guard-target-*); they pass outside the
    sandbox.

---

## Mutation ledger

Applied per repo rule (apply → run targeted → restore → report), via
`/tmp/hud-entry-mutations.py`-style script:

| Mutation | Caught |
|---|---|
| M1: drop `role: 'editMenu'` from the menu template | yes |
| M2: rename `id: 'hud-orb'` | yes |
| M3: delete the darwin gate in maybeRequestAccessibility | yes |
| M4: negate the once-only flag guard | yes (after strengthening) |
| M5: drop the NUB_SMOKE_HUD skip | yes |

Baseline 55 passed · restored 55 passed · failures=0.
