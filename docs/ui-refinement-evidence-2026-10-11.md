# Hermes Desk UI refinement

## Changes

The existing dark desk styling, Pip, agent identities, responsive shell, backend contracts, and security boundaries remain. Existing uncommitted work was preserved. No reset, commit, application installation, or publication was performed.

Five observed friction points drove the changes:

1. **Home buried work beneath decoration and statistics.** Recent chats and pending approvals now lead. Pip stays as a compact companion, history is collapsible, and the primary action opens the exact conversation needing attention, including older chats and shared rooms.
2. **Agents, history, and shared rooms were hard to distinguish.** Chats now opens the archive. Expanded sidebar room creation, chat-type filters, room labels, and non-color selection/attention cues improve discovery. Empty room filters give room-specific guidance.
3. **Responses and composer interactions competed with metadata.** Bounded message/code measures, quieter activity text, visible attachment removal, filename tooltips, and reliable menu focus restoration improve reading and drafting.
4. **Workspace ownership was ambiguous.** Status follows the active lane and page, distinguishes Watching agent, user control, and paused states, and places takeover/resume actions beside that state. Empty lanes no longer imply control. Computer capture identifies its agent without wrapping long names.
5. **Failures and recovery needed clearer feedback.** Failed tools open by default and remain counted when collapsed. Offline drafting stays available while Send is blocked; recovery retains the multiline draft. Keyboard resize, tab switching, and Escape behavior are regression-tested.

## Validation

The original UI checkpoint below is supplemented by the [packaged playback and release follow-up](video-playback-evidence-2026-10-12.md).

- `npm run lint`: passed, including both TypeScript projects and syntax checks for 212 Node files.
- `npm run test:run`: 490 files passed; 5,137 tests passed, 1 expected failure, 20 skipped, 1 todo. The final archive-copy change was subsequently checked with 19 passing Home/archive tests and lint.
- Home E2E: 17 checks passed.
- Shared-room E2E: 11 checks passed, including real approvals, concurrent members, isolated sessions, restart/crash recovery, and budgets.
- Refinement E2E: 14 checks passed at **1024×768, 1280×800, and 1440×900**. Covers long history/names/markdown/code, native attachments, draft continuity, keyboard focus/resizing, streaming reader position, actual browser takeover/resume, tab switching, and offline recovery.
- Sidebar E2E: 70 checks passed. Native attachment lifecycle passed in messenger/classic at 960×640 and 1440×900.
- Rendered accessibility: 13 states audited, zero detected violations. The follow-up resolved the classic-light footer contrast failure and passed rendered-pixel contrast/overlap checks for axe-indeterminate classic chat, Settings, permissions, and SVG history, plus visible archive heading hierarchy checks. This is not screen-reader certification.
- `git diff --check`: passed.

Fixture startup timed out during concurrent full-suite load and once after restart. Sequential reruns passed; the stress fixture now waits explicitly for its restarted backend.

## Before and after

Both capture sets include Home, chat, and workspace at all three requested sizes.

- [Before captures](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-before-1791771866939/)
- [Final after captures and report](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-after-1791774207705/)
- [Final accessibility evidence](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/redesign-accessibility-1791776487701/)
- [Shared-room evidence](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/local-rooms-1791773889748/)

### Home before

![Home before](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-before-1791771866939/1280x800-home.png)

### Home after, with actionable work

![Home after, approval above the fold](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-after-1791774207705/home-approval.png)

### Reading and attachments at 1024×768

![Long response and removable attachment](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-after-1791774207705/1024x768-long-response-attachment.png)

### Workspace ownership

![Watching the agent with a takeover action](/Users/devgwardo/hermes-desk/tests/e2e/artifacts/ui-refinement-after-1791774207705/workspace-watching-agent.png)

## Limits

Initial UI validation used real, unfocused Electron instances with disposable HOME/userData, temporary local Hermes profiles, and a deterministic loopback model. Observation of the existing packaged window was initially refused. The follow-up inspected and reopened the exact project build with explicit user approval; the installed application was not replaced.

Renderer captures do not composite native WebContentsView page pixels. Native browser navigation, lane control, and tab activation were checked separately through the actual isolated app.

Signed packaging and packaged startup/playback were subsequently tested, as recorded in the follow-up. This is not a claim that every E2E suite, installation, screen readers, every codec, or physical macOS computer control was tested.
