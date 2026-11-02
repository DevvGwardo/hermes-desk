# RT-01 through RT-07 remediation

This records implementation changes, not release approval or a claim that
arbitrary same-user code is isolated. Existing owner decisions in
`plans/hermes-desk-security-acceptance.md` remain pending.

## Main-process boundaries

| Finding | Enforcement |
| --- | --- |
| RT-01, Files access | Files starts in `~/Hermes Desk`, not the home directory. A native folder chooser grants one workspace within home. Hidden paths, credential/app state and this application's source are blocked, including canonical symlink aliases. Writes require native confirmation. Navigation, crashes and destruction reset the selected workspace. |
| RT-02, legacy CLI authority | Per-command schemas reject unknown verbs, extra options and oversized arguments. MCP, cron, kanban and task mutations require default-cancel native review of escaped arguments. Commands have four slots, a 30-second deadline and a 1-MiB output budget. Timeout/output failure kills the process group on POSIX. |
| RT-03, shared sender authority | Privileged app IPC requires the main top frame. The HUD has a separate minimal preload and an explicit channel allowlist. Tool approvals require an owned session, one request and native consent. Both `approval.respond` and raw server-request replies are checked. Standing/bulk approvals are rejected. Legacy decisions bind an authoritative request ID and recheck it after confirmation; cancellation/disconnection revokes pending decisions. |
| RT-04, plugin evaluation | Both local plugin roots are default-off. Disabled or untrusted source is rejected before module evaluation. Main verifies exact bytes before and after native consent and owns persistent SHA-256 pins. Renderer localStorage is not a trust store. Plugin reads expose only desktop entry files, not backend plugin credentials. |
| RT-05, browser destinations | Agent sessions use a fixed loopback HTTP/CONNECT proxy without DIRECT fallback or implicit loopback bypass. Each connection validates every returned DNS address and dials a validated literal public IP. Mixed/private/reserved answers fail closed, including redirects, reconnects, WebSockets and CONNECT. Non-proxied WebRTC UDP is disabled. |
| RT-06, HUD native actions | A visible HUD and OS Accessibility permission are not consent. Each click/type action additionally requires a default-cancel native dialog identifying the target process/bundle and exact escaped text or coordinates. A single-use, 30-second grant checks the target again before dispatch and is revoked by navigation/crash/destruction. A later application switch cancels rather than reactivating the old target. |
| RT-07, resources/environment | Plugin source reads are capped at 1 MiB with four concurrent read/list operations, 512 inspected directory entries and 128 deduplicated owned watches. Navigation/crash/destruction closes watches. Agent subprocesses use explicit environment allowlists; git, STT and native-input helpers do not inherit provider credentials or loader-injection variables. Native input helpers also have deadlines/output limits. |

The authenticated HTTP proxy is not an alternate mutation path: non-read HTTP
requests require native review of the exact bounded body before connecting to
the backend. Renderer-authored configuration/credential routes remain blocked.
1Password mutations and clipboard copies require native confirmation as well.

## Deliberate compatibility changes

- Files is no longer a home-wide editor. Grants reset when its document dies.
- Unknown legacy CLI options are rejected. Large operations must use the CLI
  directly; they are not silently truncated in a permission dialog.
- Local approvals offer only **once** or **deny**, not session/always grants.
- Previously enabled plugins need native trust for their current bytes.
  Linked-VM plugins cannot execute without main-owned authoritative byte
  verification; the old renderer-only pin fallback is gone.
- Agent browsing permits HTTP/WS port 80 and HTTPS/WSS port 443 only. Private
  network browsing remains available in the user lane, not agent lanes.
- Shared-login handoff is blocked because Electron cannot proxy just one
  WebContents within the shared user session. Scoped, confirmed cookie copying
  into an isolated agent partition remains supported.

## Verification and remaining limits

Behavioral tests cover native denial/approval, sender and subframe rejection,
workspace aliases and chooser cancellation, option smuggling, changing/cancelled
approval requests, exact-byte plugin trust, pre-evaluation denial, bounded reads,
watch cleanup, process output limits and credential/injection environment removal.
Plugin tests execute a real synthetic ES module rather than treating a failed
`blob:mock` import as evidence of successful loading.

Opt-in native Electron probes run in fresh temporary profiles with fake values
and synthetic resolver/dial adapters. They check real Chromium proxy behavior,
private/mixed DNS denial, redirects, rebinding and no DIRECT fallback, plus the
existing workspace navigation/input/masking/cookie-isolation regressions. No
real accounts, credentials, microphone, OS input injection or installation are
used.

These are application-level controls, not a hostile-same-UID sandbox:

- Explicitly trusted plugins execute with renderer authority. Import scanning
  is compatibility validation, not a JavaScript sandbox.
- Agent/provider credentials deliberately granted through agent configuration
  remain available to that agent. Unknown secret values inside an approved
  workspace are not universally recognizable.
- Filesystem checks are pathname-based. They do not eliminate hostile
  same-user ancestor races or hard-link attacks.
- Native input consent binds an application process, not an immutable OS
  window/control or atomic screen frame. OS focus/overlay changes can race
  dispatch. No real native-input/TCC behavior is certified by synthetic tests.
- Timed-out OS DNS lookups retain bounded slots until they finish. A timeout
  cannot roll back an already-completed action. Windows command cancellation
  kills the direct child, not a guaranteed descendant job object.
- The browser proxy is for the app's agent browser partitions. It does not
  sandbox arbitrary local tools, the upstream Hermes runtime, or its separate
  computer-use/network facilities.

Run `npm run lint`, `npm run test:run`, and `npm run build`. Native probes:

```sh
HERMES_DESK_WORKSPACE_ELECTRON=1 npm run test:electron -- \
  electron/local/workspace/native-egress.test.mjs \
  electron/local/workspace/native-regressions.test.mjs
```

Validation for this change:

- Full Vitest: **6,188 passed**, 1 expected failure and 21 skipped.
- Both opt-in native Electron probes passed separately.
- Blocking lint passed: TypeScript checks and syntax checks for 307 Node files.
- Production build passed, with Vite script/chunk/import warnings.
- Scoped tracked-file whitespace checks passed.

The remaining expected failure/skips are not release acceptance, and no
dependency audit, real-secret/account exercise, installation or publication was
performed.
