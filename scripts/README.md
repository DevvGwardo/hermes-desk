# Checks and probes

Run these from the repository root:

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Renderer/build TypeScript; incremental Electron checking defined in `tsconfig.electron.json`. |
| `npm run check:node` | Parse tracked and unignored Node files in Electron, scripts, E2E/fake-model tests, and README tooling. Does not execute them. |
| `npm run lint` | The two checks above, not an ESLint ruleset. |
| `npm run test:unit` | Renderer/library tests. |
| `npm run test:electron` | Node main/preload/workspace and script regressions, including mocked boundaries and real macOS socket-owner checks. |
| `npm run test:run` | Full renderer plus Node projects; not the opt-in GUI/backend suite. |
| `node scripts/build-app-icons.mjs` | Rebuild the Dock/window, package, favicon, and home-screen icons from Pip's local owl rig. Requires installed Chromium, macOS `iconutil`, and Pillow or ImageMagick. |
| `node scripts/check-icons.mjs` | Check package icon sizes/formats and the white menu-bar silhouette. |
| `npm run test:e2e` | Isolated fake-model golden path plus fake-model server tests. macOS and a trusted Hermes checkout are required. |
| `npm run test:runtime` | Production renderer: repeated chat, saved-chat switching, notifications, and stubbed clipboard behavior. |
| `npm run test:runtime:dev` | Same flow with React development diagnostics enabled. |
| `npm run test:hover` | Isolated rendered message geometry across hover, hover exit and keyboard focus at desktop and narrow widths. |
| `node tests/e2e/composer-typing.mjs` | Real typing, healthy host-status updates, and a host restart in an isolated app: connections stay stable, reconnects retain draft and focus, and thread switches preserve separate drafts. |
| `node tests/e2e/reply-recovery.mjs` | Disposable real-backend missing-completion/rejected-steer recovery, including no duplicate sends or interrupts. `--development-react` runs the same checks with React development diagnostics. |
| `node tests/e2e/reply-fanout.mjs` | Disposable real-backend main-chat/HUD shared-session streaming, with full delivery to both windows and single main-process event handling. |
| `node tests/e2e/transcript-scroll-lifetime.mjs --foreground-logic --render-capture` | Disposable both-skin transcript restoration/scroll/stream/reload checks with explicit metadata-capture opt-in. Foreground logic is simulated without focusing the desktop. |

## CI scope

The quick Ubuntu PR job runs the complete local types/syntax command, then only
affected renderer tests. It sets `ELECTRON_SKIP=1` and explicitly selects
`--project unit`; it is a reduced gate, not desktop acceptance. Only that job skips
the Electron binary download.

The full nightly/manual/release-branch job runs on macOS with `npm run lint`,
`npm run test:run` and `npm run build`. It includes real exact-peer ownership
regressions and does not use the skip flags or the inherited web-mode build.
Configuration checks and local passes do not prove a hosted Actions run succeeded.
Backend GUI golden/runtime probes still require separately provisioned trusted
Hermes and are not run by this job. No signing, installation, account action,
artifact upload or release approval is implied.

Coverage floors remain unproved without an installed provider and successful run.
Track skipped files/tests, expected failures and todos explicitly rather than
counting them as passing coverage.

## Native probe boundaries

The source checkout must contain Hermes's `hermes` entry point and `venv/bin/python`.
`HERMES_E2E_SOURCE` overrides the harness's default checkout path. The harness uses a fresh
home/profile, loopback fake model, and a sandbox denying access to real Hermes state.
Runtime clipboard tests stub the disposable Electron process and never write the system clipboard.
The typing check restarts only its disposable Hermes host, never the running source app.
Offline chat drafts remain editable; Send and attachment uploads stay unavailable.

`scripts/build-app-icons.mjs` delegates to `tools/mascot/render-icons.mjs`; both
commands now use the same owl artwork. A visual inspection sheet is generated
at `tools/mascot/out/integrate-icons/contact-sheet.png`. Runtime icons refresh
on the next app launch; generation does not restart or install the app.
Icon regression tests also keep the runtime PNG identical to the package
master and check the web icon dimensions, owl colors, and maskable opacity.

The golden suite verifies that Stop interrupts a live turn, pauses every lane, and
does not queue takeover steering or restart the turn during subsequent UI activity.
The inherited timeout was resolved by cancelling MCP lane work directly rather than
emitting a physical-takeover event. See
[the follow-up review](../docs/hermes-desk-improvements-2026-10-07.md) for validation
and remaining gaps, including one intermittent runtime transcript-restoration timeout.

The older `*-probe.*` scripts are not a batch test suite. Some target installed apps,
OS input, live services, or obsolete product surfaces. Read a probe and obtain the relevant
authorization before running it. A successful syntax check is not permission to execute it.

`assemble-grok-orb.py` is a historical Python extraction/assembly script, previously
mislabeled `.mjs`. It is not run by these checks, and its source/redistribution rights
remain a public-release blocker. Coverage thresholds in Vitest are also not claimed
enforced until a coverage provider is installed and a coverage run succeeds.
