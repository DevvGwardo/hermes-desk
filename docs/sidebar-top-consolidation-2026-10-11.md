# Sidebar top consolidation, October 11, 2026

## Recent work reviewed

The capability ledger records persisted chat branching, profile-scoped skill
inspection and draft preparation, active-session context inspection, reliable
native routine creation/results, session-owned native delegation, and safe
profile memory status/review guidance. Direct named-profile memory editing still
requires a backend ownership contract.

The packaged acceptance ledger records the Home hydration race fix, compact
background notices, and eleven isolated lifecycle checks. These checks use a
loopback fake model, not a real-provider quality evaluation.

Sources: [capability ledger](hermes-capability-cycles-2026-10-11.md),
[packaged acceptance](packaged-smoke-2026-10-11.md).

## Change

The top previously stacked identity, New chat, and three full-width destination
rows. It now groups identity/Search, New chat, and a single labeled
Home/Chats/Routines strip. Existing colors, icons, destinations, callbacks,
keyboard order, active-page semantics and Search tooltip behavior remain.

Native measurements: the expanded top is **148 px**, with the agent roster
starting at **192 px**. Expanded navigation targets remain **44 px** tall.
The collapsed rail retains its vertical icon navigation and the same **284 px**
roster start as the baseline. Removed two competing compact padding rules from
the shell stylesheet so sidebar spacing has one owner.

## Validation

- Baseline: 18 focused unit tests and 34 native sidebar checks passed.
- Final: 104 sidebar unit tests across 14 files passed.
- Full regression: 488 files / **5,116 tests passed**, one expected failure,
  seven skipped files, 20 skipped tests and one todo.
- Forced renderer TypeScript and Electron TypeScript passed.
- Native acceptance: **70 checks**, no renderer page errors. Both skins,
  both stored themes, expanded widths 196/240/480, and 960×640 / 1440×900
  window checks. Includes keyboard creation/navigation, shared-room creation,
  resize/expand, tooltip containment, destination labels and rail geometry.
- The first updated native run failed four compact-spacing assertions.
  Removing the competing shell padding rules fixed the failure; the rerun
  passed without relaxing the assertions.
- Inspected normal/minimum-width and collapsed screenshots.
- `git diff --check`, E2E script syntax, macOS build and ad-hoc signature checks
  passed. Existing chunk-size/import and duplicate-dependency warnings remain.

Evidence:
`tests/e2e/artifacts/sidebar-compact-1791761138823/report.json` (baseline),
`tests/e2e/artifacts/sidebar-compact-1791761290972/report.json` (spacing failure),
`tests/e2e/artifacts/sidebar-compact-1791761381468/report.json` (final).

## Requested app restart

No Hermes Desk main-window process was running when checked; existing Electron
MCP shim processes were left alone. After the user requested a restart, opened
the rebuilt `release/mac-arm64/Hermes Desk.app` through LaunchServices without
disabling Chromium's sandbox. Launch returned successfully and the new main
process was present. `/Applications/Hermes Desk.app` was not replaced.

This confirms app launch, not a real-provider session or full live-profile
lifecycle acceptance. No prompts, credential changes, runtime upgrades,
installation, commits or publication were performed.

## Remaining improvements

1. Verify real-provider and ordinary installed-app lifecycle behavior before
   treating the isolated checks as live acceptance.
2. Obtain profile/session ownership in the native memory API before enabling
   direct memory content editing.
3. Measure startup and retained-panel costs before changing caching/lazy mounting.
4. Resolve reference-code/asset rights before public distribution.
