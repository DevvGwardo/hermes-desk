# Local module refactor

## Ownership

| Module | Owns |
| --- | --- |
| `src/lib/agents/local-room-runner.ts` | Room execution, session ownership, recovery and cancellation. No app store or persistence imports. |
| `local-room-ports.ts` / `local-room-repository.ts` | Explicit repository and clock interfaces; app roster, transcript projection, unread state and durable journal adapter. |
| `local-gateway-connection.ts` | One loopback connection, incoming request subscriptions, reconnect backoff and disposal. |
| `local-history.ts` / `local-profiles.ts` | Transcript parsing/paging and local profile roster/creation/hide policy. |
| `src/components/chat/TranscriptRow.tsx` | Bubble rendering, per-row live subscription, copy/reply actions, files and artifacts. |
| `chat/useTurnControls.ts` / `chat/useThreadGroups.ts` | Thread/root-owned asynchronous controls and structural thread caches with fresh streaming content. |
| `src/plugins/areas.ts` / `PluginHost.tsx` | Copy-on-write area snapshots, scoped subscriptions and inventory replacement snapshots. |

## Preserved contracts

- `HermesLocalTransport` remains the compatibility entry point. History helpers
  and preference types remain available through their old exports. `copyTextOf`
  remains exported by `ChatPanel`; room row identities remain exported by `rooms`.
- Journal intent and member bindings must be durable before submission. A failed
  human-message save restores both routing state and the prior transcript.
  Cancellation, deletion, replay epochs, request ownership and late-attempt
  fences remain in the execution module.
- One injected clock now supplies both room journal timestamps and liveness
  checks. The app adapter uses the system clock; headless tests control time,
  scheduling, persistence and roster lifetime.
- Stop/retry wrappers stay stable across renders. Async results cannot leak into
  a different thread or a newer human root. Thread indexes remain stable during
  streaming while replies read current message objects.
- Contribution disposal still uses object identity and plugin-id prefixes.
  Multi-area unload notifies each affected subscriber once. Stale unsubscribe
  calls cannot detach replacement subscriptions. Same-count inventory status
  changes now reach the UI.

## Deliberate limits

This applies the upstream domain-module and scoped-snapshot patterns, not a
shared-client replacement. The native Electron relay still owns authentication,
secure requests and local host startup. No new dependency, plugin framework,
remote backend, profile edit, service start or publication was introduced.

The transport still inherits the proven serve streaming/delegate behavior.
Its connection, profile, history and room implementations are composed modules;
rewriting the remaining streaming engine would be a separate behavior change.
`ChatPanel` remains the view orchestrator, including composer/dictation/scroll
lifetime. This is not a claim that every large file in the app is now small.

## Validation

- Baseline: 290 affected tests and typecheck passed.
- Refactor coverage: 15 added tests, including reproduced scoped-UI failures,
  headless durable execution, loopback/disposal gates, snapshot lifetimes and
  stable chat control/thread interfaces.
- Full unit suite: 3,849 passed; 18 skipped, one expected failure and one todo.
- Full Electron suite: 1,008 passed; two skipped.
- Typecheck, 184 Node syntax checks, production build and `git diff --check`
  passed. Existing theme-script, mixed-import and large-chunk build warnings
  remain.

Evidence is controlled tests and a build, not a live model conversation or a
fresh visual acceptance run. Existing unrelated working-tree changes were kept.

The subsequent [room shell and native acceptance](2026-10-10-local-room-acceptance.md)
restores the missing app entry points and records actual Electron/Hermes room
checks, plus the separate broader browser-isolation failure.
