# Hover-label polish, October 11, 2026

## Delivered

The screenshot's clipped “Manage agents” label came from an inline tooltip
inside the sidebar's overflow boundary. The shared Tooltip now portals to the
body by default, flips placement when necessary, and keeps an 8 px window gutter.

Typography no longer inherits section-title tracking, capitalization or weight.
Labels use the existing 12 px / 16 px type scale, regular weight, a quiet border
and consistent padding. Intrinsic width is capped at 280 px or the available
window width; long labels and identifiers wrap instead of clipping.

Hover waits 200 ms to avoid flashing during pointer travel. A 120 ms exit grace
allows users to move onto the portalled label. Keyboard focus remains immediate.
Escape and activation dismiss labels; open menu triggers suppress their labels.
Existing accessible descriptions are preserved.

All shared IconButton labels inherit the fix. Compact sidebar destinations,
agent rows, Settings, Hidden agents and the selected-agent summary now use the
same component. Message-action and browser navigation buttons also use it,
without duplicate native `title` popups. Workspace navigation labels prefer
above-control placement to avoid the native browser content area.

Fixed the chat action menu's initial focus: it previously selected its trigger
instead of a button inside the popup. First Escape now closes transient menus
even when their focused control has a tooltip. Modal tooltip dismissal stays
local. Metadata/path titles outside these action surfaces remain unchanged;
this is not a replacement of unrelated toast/notification behavior.

## Validation and corrections

- Final full suite: **488 files / 5,122 tests passed**, one expected failure,
  seven skipped files, 20 skipped tests and one todo.
- Forced renderer and Electron types, script syntax and `git diff --check` passed.
- **26 native tooltip checks**, **70 sidebar checks**, and **nine message-hover
  geometry checks** passed. Includes pointer/keyboard use, Escape, activation,
  clipped chrome, window edges, shortcuts, wrapping, compact controls, both
  sidebar skins/themes, and above/below message actions.
- Inspected minimum-window, compact and right-edge screenshots.
- Initial native checks caught intrinsic-width shrinkage after narrowing the
  window and incorrect menu focus. Both were fixed without weakening assertions.
- Stabilized an existing transcript-notice test with explicit fixture
  timestamps instead of comparing two wall-clock fallbacks.
- Updated the message-hover fixture to dismiss current onboarding rather than
  looking for the retired “Skip setup” control. Retained its 390 px checks and
  added failure screenshots. Earlier failed receipts remain in artifacts.
- One full-suite attempt timed out under concurrent machine load. The final
  longer-timeout run completed successfully in 179 seconds; no other sessions
  or their test processes were stopped.

Final evidence:
`tests/e2e/artifacts/tooltips-1791762989039/report.json`,
`tests/e2e/artifacts/sidebar-compact-1791763023340/report.json`,
`tests/e2e/artifacts/message-hover-1791763551684/report.json`,
`tests/e2e/artifacts/tooltips-final-regressions-1791763551684.log`.

## Applying the update

The user explicitly approved rebuilding and reopening. The project app quit
normally, rebuilt with ad-hoc signature verification, and reopened through
LaunchServices. Confirmed `finishedLaunching: true` for
`release/mac-arm64/Hermes Desk.app`. The installed copy was not replaced.
Build receipt: `tests/e2e/artifacts/tooltips-build-1791763551684.log`.
Existing large-chunk/import and duplicate-dependency build warnings remain.
No live prompts, provider calls, credential edits, installation or publication.
