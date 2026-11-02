# Hermes Desk isolated E2E

## Result, 2026-10-06

**The release gate fails.** Real Hermes chat streams successfully, but the unmodified
app rejects configured MCP browsing with `not_enabled`. This suite intentionally
stays red instead of marking the broken golden path skipped or expected-failure.

The diagnostic run gets **12 of 13 checks** through the real Hermes → stdio MCP
shim → app Unix socket → CDP path. It requires two explicitly labelled test
workarounds. It does **not** prove the unmodified golden path works.

No dependencies were installed. `playwright-core`, already a devDependency,
provides `_electron`; a separate Playwright test-runner package is unnecessary.

## Run

From the repository root, with the installed Hermes checkout and venv available:

```sh
npx --no-install vitest run \
  scripts/e2e-isolation.test.mjs electron/local/hermes-home.test.mjs \
  electron/local/hermes-host.test.mjs electron/local/boot.test.mjs
npx --no-install vitest run --config tests/e2e/vitest.config.mjs \
  tests/fake-model/server.test.mjs
npx --no-install vitest run --config tests/e2e/vitest.config.mjs \
  tests/e2e/golden-path.test.mjs

# Equivalent golden path without Vitest, prints JSON and exits nonzero on failure:
node scripts/e2e-hermes-desk.mjs

# Isolate the empty-tab initialization failure after adapting only Settings:
node scripts/e2e-hermes-desk.mjs --diagnostic-settings-adapter

# Exercise the rest of the real path with both diagnostic workarounds:
node tools/blueprint/hermes-desk.mjs \
  --diagnostic-settings-adapter --diagnostic-seed-tabs
```

Set `HERMES_E2E_SOURCE` to an absolute Hermes checkout path to replace the local
default `/Users/devgwardo/.hermes/hermes-agent`. This is read-only source access.
The harness requires macOS because it uses `sandbox-exec` for the backend.
Do not run multiple copies of the suite concurrently: the app's serve-port picker
does not atomically reserve its port.

The harness builds the real renderer with Vite into its temporary directory, then
serves those built files over a private loopback listener. It does not use Vite
development transforms or replace the app renderer with mocks. The normal
`npm run build` still fails on the three existing TypeScript errors listed below;
using Vite directly is an explicit typecheck bypass, not a clean production build.

## Isolation and setup

- A fresh `mkdtemp` root contains `HOME`, `HERMES_HOME`, runtime/XDG directories,
  `TMPDIR`, Electron `userData`, and the renderer build. It is removed on success
  and failure. Electron closes, the host stops its detached serve process group,
  and the harness reaps that group even if Electron failed.
- The environment is an allowlist, never a copy of the shell's provider keys,
  messaging tokens, SSH socket, or saved logins. `HERMES_DISABLE_LAZY_INSTALLS=1`
  is always set.
- The app spawns the installed, unmodified Python Hermes entry point through a
  temporary trusted `hermes` wrapper. A macOS sandbox denies real Hermes-state
  reads outside the source checkout and denies all writes to the real Hermes
  tree. Backend IP traffic is loopback-only. Binds on 8642 and 9119 are denied.
- Electron retains its normal sandboxed renderer and tab preferences. Wrapping
  the entire Electron process in `sandbox-exec` prevented Chromium from creating
  its own sandbox, so only Hermes and its MCP descendants receive that outer
  sandbox. A test-entry `webRequest` filter denies non-loopback Electron network
  requests. Playwright's inspector/CDP listeners are dev-test-only, on free ports.
- The fake OpenAI server and fixture site bind `127.0.0.1:0`. App serve selects
  9120 or another free port in its normal 9120–9220 range. No reserved port is bound.
- Profiles `alpha`, `beta`, a default fixture profile, and `session-e2e-scratch`
  have fresh fake-only config, SOUL, profile metadata, and `.env` files.
  The sidebar shows Alpha/Beta; scratch is hidden.
- `registerMcp().configEntryFor(profile)` from the actual running app supplies the
  dev Electron binary, repository shim, and temporary-userData socket.
  `config-writer.planEnable/apply` writes only the disposable profiles, preserving
  `tools: {}` and disabling the built-in browser toolset.
  Browsing is pre-enabled in disposable `settings.json`; no native user-consent
  dialog or real profile is modified.
- The temporary custom model config uses `model.provider: custom`,
  `model.default: hermes-desk-fake`, `model.base_url: <loopback>/v1`, and
  `model.api_mode: chat_completions`. The profile `.env` contains only an obviously
  fake `OPENAI_API_KEY` and the same `OPENAI_BASE_URL`.
- The installed Hermes defaults to deferred tool discovery. Disposable profiles
  set `tools.tool_search.enabled: "off"` so the fake model reads the exact
  namespaced browser tools directly from each request's tool catalog.
  `mcp_discovery_timeout: 10` gives cold discovery time to finish.

## Production hooks and diagnostic boundaries

Only `electron/local/hermes-host.cjs` and `boot.cjs` change app behavior:

1. `HERMES_DESK_HERMES_HOME` overrides the host and Settings Hermes home only in an
   unpackaged app. Absolute paths are required. Packaged apps ignore it, even
   when the caller also supplies `isPackaged: false`.
2. `HERMES_DESK_E2E=1`, also unpackaged-only, suppresses the gateway health probe.
   This prevents even read-only contact with the user's 8642 gateway.

Everything else is in the disposable launcher, not production IPC:
it sets temporary Electron paths, passes the repository `appPath`, wraps the
existing host `spawn` seam in the backend sandbox, records serve PIDs, observes
content-free event timing/native mouse metadata, and captures the existing ghost
overlay after its real `waitFrame()`. No Hermes identity, controller authorization,
tool result, browser policy, redactor, or takeover event is fabricated.

`--diagnostic-settings-adapter` replaces only the MCP factory's Settings reader
with a synchronous read of the same disposable `settings.json`. It does not
change the profile allowlist or dispatch code.

`--diagnostic-seed-tabs` opens initial Alpha/Beta fixture tabs through the real
workspace IPC before model browsing. This is a user-opened initialized tab,
**not proof that the agent can initialize its first empty tab**.

## Captured checks and blockers

Artifacts are git-ignored under `tests/e2e/artifacts/`.

| Run | Captured result |
| --- | --- |
| Golden, no adapters | 5 checks pass, MCP navigation fails, 7 dependent checks do not run |
| Settings adapter only | Same independent checks pass; first empty agent tab times out |
| Settings adapter + seeded tabs | 12/13 checks pass; agent click triggers takeover |
| Focused Vitest | 20 host/boot/isolation tests + 2 fake-model tests pass |
| Normal `npm run build` | Fails on existing UiLab, LocalHostBridge, WorkspacePane test errors |

The fully diagnostic run verifies real streamed `message.delta` events,
model-selected navigation and AX snapshot, the fixture title in the answer,
the ghost cursor painted in a visible app-owned overlay, Electron-native user
mouse input → paused lane → `user_took_control` seen by the model → UI Resume,
Give to agent/Return to me with unchanged user partition, login snapshot redaction
and absence of the fake password from every logged model request, isolated Beta
browsing, two simultaneous Alpha/Beta streaming turns without transcript crosstalk,
command-period interruption and every lane paused, and Computer PiP opening.
The PiP is a completed-capture preview, not a live Mac stream.

Outstanding app defects, outside the allowed implementation scope:

1. **Async Settings vs synchronous gate.**
   `host-config.cjs:182` declares async `getConfig()`. `boot.cjs:30` forwards its
   promise; `mcp/dispatch.cjs:46` synchronously reads `.workspace.enabledProfiles`.
   The real model receives `{"error":"not_enabled: MCP request rejected"}` despite
   Settings returning `enabledProfiles: ["alpha","beta"]`.
2. **First empty agent tab never initializes.**
   `workspace/views.cjs:164` loads a URL only when `tab.url` is nonempty.
   MCP first creates an empty tab. With the Settings adapter, that tab's real
   webContents URL stays empty, the fixture receives no navigation, and the model
   receives `timeout: Browser command timed out`. A user-opened fixture tab lets
   the unchanged CDP executor navigate and snapshot correctly.
3. **CDP input is misclassified as user takeover.**
   The seeded run's agent `browser_click` produces a native `mouseDown` while the
   tab is `agent-acting`. `takeover.cjs:43–44` pauses on that event without
   distinguishing agent input. The real click tool returns `user_took_control`;
   the fixture's click handler never fires. Do not disable genuine user takeover
   to fix this; scope a synthetic-input marker around agent CDP input.

## Blueprint numbers

One local sample, not a statistical benchmark, preserved in
`artifacts/blueprint-sample.json`:

| Metric | Result |
| --- | --- |
| Spawn → sidebar populated | 3974.0 ms |
| Submit workflow → first visible text | 1848.8 ms |
| Submit workflow → fake provider's first content chunk | 1800.1 ms |
| First serve delta → renderer text observed | 8 ms |
| Fake-model navigate tool response → fixture DOMContentLoaded event | 38.0 ms |
| Agent click → fixture page click event | Not measurable, click is rejected |

The cold-start target is 4000 ms for a spawned serve. The renderer overhead target
is 50 ms beyond serve's first token. Measurements include Playwright scheduling;
the submit measurement begins before clicking the agent/composer, not at the
raw `prompt.submit` frame. Navigation latency is not substituted for the
150 ms click target, and no 250 ms cursor-animation subtraction is claimed.
Attached-serve cold start and 6-agent/18-tab RSS were not tested.

Key screenshots in `artifacts/diagnostic-seeded/`:
`01-sidebar.png`, `02-chat.png`, `03-browser.png`, `03-browser-tab.png`,
`03-ghost-cursor.png`, `04-paused.png`, `04-paused-tab.png`,
`05-shared-tab.png`, `05-shared-tab-tab.png`, `06-redaction.png`,
`06-redaction-tab.png`, `07-beta.png`, `07-beta-tab.png`, `08-stopped.png`,
`08-stopped-tab.png`. Chrome and native-tab captures are separate because
app-renderer capture does not include sibling WebContentsViews.

Raw local evidence: `golden/result.json`, `diagnostic/result.json`,
`diagnostic-seeded/result.json`, each run's `model-requests.json` and
`build.txt`, `golden-vitest.txt`, `npm-build.txt`, and
`diagnostic-blueprint.json`, and the preserved `blueprint-sample.json`. Request logs contain fixture bodies only, never
authorization headers. All started test processes were checked after teardown;
none remained.
