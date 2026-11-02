# Spec — Hermes Desk verification-layer remediation

**Status:** proposed · **Written:** 2026-10-25 · **Validated against:** HEAD `3906203`

## Goal

Make Hermes Desk's quality gates *real*. The application code is strong
(strict TypeScript, hardened Electron, 4,481 tests); every gap below is in the
layer that is supposed to catch regressions, and none of them currently fire.

This spec covers only that layer. It does not refactor application code.

## Validated evidence

Every number here was measured on this machine against `3906203`, not inferred.

| # | Claim | Measurement | Source |
|---|-------|-------------|--------|
| G1 | Coverage thresholds cannot run | `--coverage` aborted: `Cannot find dependency '@vitest/coverage-v8'`. After installing it: **76.6% lines, 68.83% branches, 75.31% funcs, 73.71% stmts** — *passes* the declared 70/60 floor | `vitest.config.ts:62-70`; `npx vitest run --project unit --coverage` |
| G2 | Lint is advisory only | **2,242 warnings, 0 errors**, 349 of 1,038 files. `npm run lint` = typecheck + node syntax; ESLint appears only as `lint:advisory`, referenced by no workflow | `package.json`, `npx eslint electron/ src/` |
| G3 | Native e2e never runs in CI | **52** `tests/e2e/*.mjs` harnesses; **0** `e2e` references in `ci.yml` or `release-win.yml`. `ci.yml:98-106` runs only `npm run lint`, `test:run`, `build` | `.github/workflows/` |
| G4 | Vulnerable direct deps | `npm audit`: **17** (3 critical, 7 high, 5 moderate, 2 low). `dompurify <= 3.4.16` **critical + direct**, on the sanitizer path | `npm audit --json`, `markdown-math.ts:30`, `FilePreview.tsx:891` |
| G5 | Electron 8 majors stale | installed **37.10.3**; 7 high advisories; fix **45.0.0** | `electron/package.json`, `npm audit` |

Warning histogram (G2 detail), by rule:

| count | rule | disposition |
|------:|------|-------------|
| 1,141 | `security/detect-non-literal-fs-filename` | noise — disable |
| 758 | `security/detect-object-injection` | noise — disable |
| 63 | `no-empty` | real (36 in `electron/main.cjs`) |
| 57 | `react-hooks/exhaustive-deps` | real (`App.tsx` 10, `useAgentRuntime` 7, `ChatPanel` 6) |
| 47 | `security/detect-unsafe-regex` | review |
| 34 | `no-control-regex` | review |
| 25 | `security/detect-non-literal-regexp` | review |
| 19 | `security/detect-non-literal-require` | review |
| 13 | `no-useless-assignment` | real |
| 13 | `preserve-caught-error` | real (lost `cause` chains) |

The two flagged noise rules are **1,899 of 2,242 warnings (85%)**. They drown the
76 warnings that correspond to actual defects, which is why nobody reads the output.

---

## G1 — Enforce the coverage floor

**Problem.** `vitest.config.ts:62-70` declares `lines: 70, branches: 60` with the
comment "Floor, not aspiration: fail `--coverage` runs that drop below it." No
coverage provider is installed and no script or workflow passes `--coverage`, so
in the project's history that floor has never been enforced once.

**Change.**
1. `@vitest/coverage-v8@4.1.10` as a devDependency *(already applied — see Repo state)*.
2. `package.json`: add `"test:coverage": "vitest run --project unit --coverage"`.
3. `vitest.config.ts`: pin `coverage.include: ['src/**/*.{ts,tsx}']` and
   `coverage.exclude: ['**/__tests__/**', '**/*.test.*', '**/mock-data.ts']` so the
   percentage is a stable contract rather than a function of how many test files exist.
4. `.gitignore`: add `coverage/`.
5. `ci.yml` `full` job: run `npm run test:coverage` instead of `npm run test:run`
   (nightly + release PRs only — `quick` stays unchanged to protect Actions minutes).

**Acceptance.**
- `npm run test:coverage` exits 0 and prints the four-line summary.
- Temporarily raising `thresholds.lines` to 90 makes the same command exit non-zero.
- The nightly `full` job log contains the coverage summary.

**Risk.** Low. Measured headroom today is +6.6 pts lines, +8.8 pts branches.

---

## G2 — Turn lint into a gate with a readable signal

**Problem.** `npm run lint` never invokes ESLint. The advisory config emits 2,242
warnings, 85% of them from two low-value `eslint-plugin-security` rules, so the
output is unreadable and the real findings are invisible.

**Change.**
1. `eslint.config.mjs`: turn off `security/detect-object-injection` and
   `security/detect-non-literal-fs-filename` project-wide, with a one-line comment
   explaining that both fire on ordinary property and path access.
2. Promote `react-hooks/exhaustive-deps`, `no-empty`, `no-useless-assignment`,
   `preserve-caught-error` to `error`.
3. Fix the promoted findings:
   - `preserve-caught-error` (13): add `{ cause: err }` to the rethrow.
   - `no-empty` (63): where the swallow is intentional, state why in a comment
     (`catch { /* best-effort close */ }`) — the rule accepts a commented block;
     where it is not, log through the existing logger.
   - `react-hooks/exhaustive-deps` (57): add the missing dependency or, where the
     omission is deliberate, a `// eslint-disable-next-line` **with a reason**.
4. `package.json`: make `lint` = `typecheck && check:node && eslint electron/ src/`.
   Delete `lint:advisory`.

**Acceptance.**
- `npx eslint electron/ src/` reports **0 errors**.
- Remaining warnings are ≤ 150, all from the four "review" rules above.
- `npm run lint` fails on an injected `catch {}` in `electron/main.cjs`.
- CI `quick` and `full` both gate on it.

**Risk.** Medium — the dependency arrays in `App.tsx`/`useAgentRuntime.ts` may
surface genuine stale-closure bugs. Treat every surfaced closure bug as a real
finding, not a lint nuisance.

---

## G3 — Run native e2e in CI (by manifest, not all 52)

**Problem.** `tests/e2e/` holds 52 harnesses covering GenUI, reply timeouts,
secrets, transcript scroll, mascot, a11y, attachments, rooms. Nothing runs them;
they can only rot. This is the app's best regression net and its least-used one.

**Change.**
1. Add `tests/e2e/manifest.json`: every harness listed once as either
   `ci` (self-contained: builds/launches its own Electron instance, seeds its own
   fixtures) or `local-only`, with a `reason` string for each `local-only` entry
   (needs a live Hermes session, a real account, MCP shims, or an interactive GUI).
2. Add `npm run test:e2e:ci` — runs the `ci` subset, fails on the first non-zero exit.
3. New nightly macOS job `e2e-nightly` in `ci.yml`, gated like the existing `full`
   job (skip when no commits in 25 hours), `timeout-minutes: 30`.

**Acceptance.**
- `manifest.json` accounts for exactly 52 files (`node -e` count check).
- Every `local-only` entry has a non-empty reason.
- `npm run test:e2e:ci` passes locally, and the nightly job is green on two
  consecutive scheduled runs.

**Risk.** Medium — macOS runners have no window server session for some probes.
Classify ruthlessly; a harness that only works on a logged-in desktop is
`local-only`, and saying so is a success, not a failure.

---

## G4 — Clear critical and high dependency advisories

**Change.**
1. `dompurify` **3.4.16 → 3.4.17** (advisory range `<=3.4.16`; 3.4.17 is current).
   This is the sanitizer behind markdown math, mermaid and file previews — the exact
   path agent-supplied content travels.
2. `concurrently` → current (critical, dev-only build tooling).
3. `exceljs` → assess; moderate severity, direct, used by the sheet preview.
4. `brace-expansion` / `@vitest/mocker` → `npm audit fix` after the above.

**Acceptance.**
- `npm audit` reports **0 critical** and no high advisories outside Electron.
- `npm run test:unit` green, including the `FilePreview` and `markdown-math` suites.
- Manual: a chat message rendering inline math, a mermaid block, and a sheet preview
  all display correctly.

**Risk.** Low for dompurify (patch release). Do not run `npm audit fix --force`.

---

## G5 — Electron upgrade (separate branch, not in this spec's first pass)

**Change.** 37.10.3 → 45.x. Large jump; treat as its own change.

**Acceptance.** `lint`, `test:run`, `build`, `test:runtime`, `test:media:packaged`,
the packaged smoke, and `install:local` all pass, plus a manual pass over: browser
tab, computer-use PiP, plugin host, self-modification preview, and window drag.

**Risk.** High — preload API and `WebContentsView` behavior have moved across 8
majors. Do not bundle it with G1–G4.

---

## Sequencing

1. **G1** — cheapest, already validated, zero behavioural risk.
2. **G4** — one-line dompurify bump clears the only critical finding on a live path.
3. **G2** — highest value per hour; expect it to surface real bugs.
4. **G3** — needs classification work, highest ongoing payoff.
5. **G5** — own branch, own week.

## Out of scope (deliberate)

- Splitting `ChatPanel.tsx` (3,613 lines) or `electron/main.cjs` (2,306).
  Refactor only when already changing that file for a real defect.
- Auto-update. Local install is a deliberate choice; adding an updater is a product
  decision, not a gap.
- Public release / licensing cleanup — still blocked per `PLAN.md`.

## Repo state at time of writing

- `package.json` + `package-lock.json` are **modified**: the G1 coverage provider
  install. Uncommitted.
- `coverage/` is **untracked** output from the validation run; G1 step 4 adds it to
  `.gitignore`.
- `src/components/ChatPanel.tsx` carries an **unrelated, pre-existing** uncommitted
  change (a `/loop` slash-command draft scaffold). It is not part of this work and
  was left untouched.