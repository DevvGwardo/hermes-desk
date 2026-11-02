# Gates: sweep-5 desktop hardening batch (D-03 + D-04 + D-05 + D-06)

Scope: close the four open Medium/High desktop findings from
docs/RED_TEAM_SWEEP_2026-08-30.md, per the operator's Option-B decision for
D-03 (trust-gate, no per-action consent UI): the main process refuses
`maia:hud:clickAt`/`typeText` while the HUD is collapsed to the orb
(sweep option c — the cat never acts while invisible), the bubble surfaces
what the cat did (act chip, no more silent stripping), PreviewModal's
`nub-vm://` iframe gets a sandbox + a main-process top-navigation guard
(D-04), the update helper binds versions exactly and refuses rollback
(D-05), and every HUD act spawn resolves through bin-guard (D-06).

- [x] G1: D-03 main-side visibility gate — `maia:hud:clickAt` and `maia:hud:typeText` refuse with a distinct error while the HUD window is collapsed to the orb (`hudCollapse.collapsed === true`), before any Accessibility check or spawn; unknown state fails closed
  CHECK: npx vitest run electron/d03-visibility-gate.test.mjs 2>&1 | tail -6
  EXPECT: /Tests\s+6 passed/
  EVIDENCE: Start at  18:22:26 | Duration  512ms (transform 14ms, setup 0ms, import 23ms, tests 3ms, environment 394ms)

- [x] G2: D-03 renderer side — the act is visible: an act marker in the last agent reply renders the act chip in the HUD bubble (click coords / typed-char count), markers stay out of the prose, and no chip renders when there is no act marker
  CHECK: npx vitest run src/components/__tests__/hud-shell.test.tsx 2>&1 | tail -6
  EXPECT: /Tests\s+23 passed/
  EVIDENCE: Start at  18:22:27 | Duration  1.11s (transform 188ms, setup 0ms, import 331ms, tests 331ms, environment 362ms)

- [x] G3: D-04 sandbox — the `nub-vm://` src iframe in PreviewModal carries a `sandbox` attribute (allow-scripts allow-same-origin allow-forms allow-modals), matching the srcDoc branch
  CHECK: npx vitest run src/components/__tests__/preview-modal.test.tsx 2>&1 | tail -6
  EXPECT: /Tests\s+3 passed/
  EVIDENCE: Start at  18:22:29 | Duration  811ms (transform 132ms, setup 0ms, import 288ms, tests 54ms, environment 380ms)

- [x] G4: D-04 top-navigation guard — `will-navigate` on mainWindow (and the HUD window) denies any navigation whose origin is not the dev server, the packaged `file://` app origin, or `nub-vm://`; external https still goes through setWindowOpenHandler
  CHECK: npx vitest run electron/d04-will-navigate.test.mjs 2>&1 | tail -6
  EXPECT: /Tests\s+7 passed/
  EVIDENCE: Start at  18:22:30 | Duration  482ms (transform 19ms, setup 0ms, import 28ms, tests 3ms, environment 369ms)

- [x] G5: D-05 exact binding — both helpers (mac bash + win ps1) compare the staged version to the expected version with exact-normalized equality (trailing `.0` tolerated per 4-part CFBundle), not prefix; a signed 0.1.10 zip no longer satisfies expected 0.1.1
  CHECK: npx vitest run src/lib/__tests__/update-apply.test.ts 2>&1 | tail -6
  EXPECT: /Tests\s+31 passed/
  EVIDENCE: Start at  18:22:31 | Duration  2.02s (transform 60ms, setup 0ms, import 109ms, tests 1.23s, environment 591ms)

- [x] G6: D-05 anti-rollback — `maia:updateApply` refuses when `compareVersions(expectedVersion, app.getVersion()) <= 0` (same-version reinstall blocked too; the manifest flow only ever offers newer), and the check runs BEFORE any download
  CHECK: npx vitest run src/lib/__tests__/update-apply.test.ts 2>&1 | tail -6
  EXPECT: /Tests\s+31 passed/
  EVIDENCE: Start at  18:22:33 | Duration  1.64s (transform 56ms, setup 0ms, import 70ms, tests 1.05s, environment 422ms)

- [x] G7: D-06 — `screen-act.cjs` resolves every backend spawn through a trusted resolver (`/usr/bin/osascript` fixed path for the osascript backends; cliclick resolved through bin-guard's trust check, backend dropped when the guard refuses — planted group-writable binary refused), and `maia:hud:typeText`'s spawn uses the same resolver — no bare-name spawns left in the act path
  CHECK: npx vitest run electron/screen-act.test.mjs 2>&1 | tail -6
  EXPECT: /Tests\s+29 passed/
  EVIDENCE: Start at  18:22:36 | Duration  528ms (transform 22ms, setup 0ms, import 33ms, tests 11ms, environment 394ms)

- [x] G8: security-invariants suite extended — new invariant tests pin: no bare-name osascript/cliclick spawn in main.cjs's typeText handler, version-prefix match absent from both helpers, will-navigate guard present in main.cjs, collapsed-gate present in both act handlers
  CHECK: npx vitest run electron/security-invariants.test.mjs 2>&1 | tail -6
  EXPECT: /Tests\s+21 passed/
  EVIDENCE: Start at  18:22:37 | Duration  520ms (transform 20ms, setup 0ms, import 29ms, tests 9ms, environment 396ms)

- [x] G9: full regression — both tsconfigs typecheck clean and the whole vitest suite green (this repo has no eslint config; tsc + vitest are the regression net)
  CHECK: npx tsc -b && npx tsc -p tsconfig.node.json --noEmit && npx vitest run 2>&1 | tail -6 && echo FULL_SUITE_GREEN
  EXPECT: FULL_SUITE_GREEN
  EVIDENCE: Duration  59.27s (transform 24.13s, setup 0ms, import 95.82s, tests 68.74s, environment 413.81s) | FULL_SUITE_GREEN

- [x] G10: mutation spot-checks — the gates are not vacuous: (a) inverting the D-03 collapsed gate turns d03-visibility-gate red, (b) making the D-06 resolver hand back the bare name turns security-invariants red, (c) removing the D-05 anti-rollback gate turns update-apply red. Manual gate: mutations applied by script, suite run, tree restored.
  EVIDENCE: (a) `Tests  3 failed | 3 passed (6)` with gate inverted; (b) `Tests  1 failed | 48 passed (49)` with `defaultResolveActFile('osascript')` returning 'osascript'; (c) `Tests  1 failed | 30 passed (31)` with anti-rollback gate stubbed to `if (false)`. All three restored trees re-verified green (6, 29, 31 passed).
