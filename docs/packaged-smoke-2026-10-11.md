# Packaged Hermes Desk acceptance, 2026-10-11

## Outcome

The rebuilt arm64 `.app` passed **11 functional lifecycle checks** with disposable
profiles, the installed Hermes source, copied provisioned dependencies, and a
loopback fake model. It was not installed, published, or substituted for the
user's running `/Applications/Hermes Desk.app`.

Evidence:

- `tests/e2e/artifacts/packaged-smoke-1791760545725/report.json`
- Screenshots in the same directory: visible chat, native routine result,
  expanded native completion notice, and restarted app with collapsed notice.
- `tests/e2e/artifacts/packaged-smoke-build.log`
- `tests/e2e/artifacts/packaged-smoke-regressions.log`
- Archive SHA-256:
  `ff62f737586d18f5705d0150546bf77be969b7aff7b41b33cfbcf911bea639a3`

Reproduce after building:

```sh
npm run electron:build
node tests/e2e/packaged-smoke.mjs
```

## What this proves

- The actual bundle executable, `app.isPackaged === true`, packaged main/preload,
  and `file://.../app.asar/dist/index.html` renderer are used. A deliberately bad
  dev-server environment is ignored. No repository main wrapper, `hostDeps`,
  replaced archive, packaged-dev flag, or backend authentication bypass is used.
- Native peer authentication succeeds with the production PID-group/UID checks.
  HOME and userData are disposable; the existing gateway is blocked, not stopped.
- Leaving Home early does not return Home over a newly visible chat when history
  hydration finishes. Real streamed events and model output reach the renderer.
- Home retains the draft. Alpha and Beta remain separate.
- Command-period produces a real `message.complete` with `interrupted` status,
  releases the composer, and permits the next native chat. The measured
  submission-to-interrupted-completion interval was **408 ms**.
- One native Alpha routine is atomically paused on creation, executed with native
  cron, and shown in Results. Beta has no job; no local fallback is created.
- A real delegated child can be listed, tailed, steered, and interrupted through
  the scoped inspector with queued/requested, not delivered/completed, feedback.
- A genuinely completed native child hydrates as a compact system notice. Its
  output starts collapsed and expands in a plain-text `pre`, not a user bubble.
- Backend restart reauthenticates a different process and resumes chat. Full app
  restart preserves chat and routine results without reviving live child handles.
- No unexpected captured renderer errors, resource failures, render-loop warnings,
  renderer crashes, or Stop timeouts occurred in the final run. The report records
  lifecycle events and model-request counts without backend bearer tokens.

## Verified fix and notice integration

The first packaged run exposed a real early-navigation race: initial route
hydration reapplied `#/home` after the user left it. `App.tsx` now retains an
explicit startup destination, analogous to its existing Settings intent, instead
of replaying the launch destination. Two behavioral tests failed before the fix
and passed afterward. The rebuilt app also passes the early-exit native check.

Reviewed `c12abc237208aef2c6844ca0c57740a2e8b67626` from the isolated notice worktree.
Its shared projection, types, component, tests, and documentation were already
applied. The current extracted `TranscriptRow.tsx` correctly mounts `SystemNotice`;
the branch's older `ChatPanel.tsx` was not copied over unrelated changes. No
duplicate cherry-pick, history merge, commit, or push was necessary. The build
includes the reviewed integration. See [the display contract](background-process-notices.md).

## Validation and limitations

- Full suite: **488 files / 5,113 tests passed**, seven skipped files, 20 skipped
  tests, one expected failure, and one todo.
- Forced renderer TypeScript build and Electron TypeScript checks passed.
- **210** Node JavaScript files passed syntax checks. Three fake-model contracts
  passed using the E2E Vitest configuration.
- Mac build passed. Deep/strict signature verification, ad-hoc signature,
  hardened-runtime flags, and entitlements were checked after the smoke.
- Whitespace checks passed. Existing dirty work and installed runtime were preserved.

The fixture uses `--no-sandbox` **inside an outer macOS sandbox** because macOS
rejects Chromium's nested seatbelt initialization. The outer sandbox denies real
home reads/writes (except read-only packaged/source paths), external IP traffic,
and gateway/reserved-port access. Immutable `/bin/ps` alone runs outside that
sandbox because macOS refuses its setuid execution inside seatbelt; production
peer verification is not stubbed. A short temporary path avoids Darwin's Unix
socket length limit.

This is functional packaged evidence, **not** proof of default Chromium sandbox
startup, Finder/LaunchServices startup, real-provider behavior, Gatekeeper approval,
or rights clearance. Those remain separate checks. The older render-loop and
Stop issues were not reproduced here, not declared universally resolved.

Intermediate failures included isolation setup, fixture locator/readiness errors,
and one intentionally retired REST-proxy read during backend restart. The final
run has no expected restart errors either. A parallel focused run hit four async
UI wait timeouts; its isolated rerun and the final full suite passed. An initial
fake-model check used the wrong Node runner; all three contracts passed with Vitest.
