# Hermes Desk UI/UX redesign delivery

**Date:** 7 October 2026  
**Scope:** [Redesign plan](hermes-desk-ui-ux-redesign-plan-2026-10-07.md), excluding Home changes at the user's request.

## Home is preserved

The original Home page remains intact: coastal artwork, teal/gold styling, glow, large Pip, greeting, agent actions, Recent activity, heatmap, and full-screen presentation without the sidebar. Home still opens by default unless the existing preference or a deep link says otherwise.

“Start a session” retains its original resume behavior. “All conversations” retains its original return-to-shell behavior. The new Chats archive and genuine New chat action are available in the working shell, not substituted into Home.

The following files have no Git diff:

- `src/components/home/HomePage.tsx`
- `src/components/home/home.css`
- `src/components/home/HomePage.test.tsx`
- `src/lib/home-prefs.ts`
- `src/lib/__tests__/home-prefs.test.ts`

The retained shell still preserves drafts and transcripts underneath Home. The plan's Home hierarchy, smaller mascot, palette/artwork changes, and new launch-default recommendations are deliberately excluded.

## Delivered outside Home

- **Turn control:** one current-activity row with independent Stop, unchanged Send position, pending interruption feedback, failure/retry protection, and conversation-scoped duplicate guards. A multiline draft and attachment survive Stop. Command-period retains its emergency scope.
- **Navigation:** distinct New chat and New agent actions; Home, Chats, and Routines destinations; agent details/management; Hidden agents with unchanged restore semantics; recent-chat selection; real fresh conversations without silently resuming an old one.
- **Chats archive:** searchable titles/agents/previews, agent filtering, pinned-first order, attention/running states, empty/loading states, and incremental 30-row display. Hidden work is not silently deleted.
- **Responsive shell:** measured navigation width and text scale determine layout. Split targets protect 480px chat, 360px Workspace, 320px inspector, and 280px editable composer space. Constrained windows switch between retained Chat and Workspace. New Workspace preferences default closed. Preferred widths survive temporary clamps, and separators support keyboard resizing.
- **Permissions:** explicit once/deny labels, broader grants behind disclosure, supplied matching patterns, real runtime/profile scope, and revocation guidance. High-stakes actions still allow only once/deny. No default permissive focus or duplicate decision submission.
- **Settings:** General, Agents, Workspace, Privacy & permissions, Appearance, and Advanced. Existing local aliases/search targets remain available. Host setup and diagnostics use disclosure. Selecting a search target survives the route echo instead of collapsing it.
- **Workspace:** Desk tokens and shared SVG icons, persistent textual ownership, legitimate handoff/return actions, Take control/Resume, keyboard tabs, valid empty/unavailable states, and native-safe More/Reader dialogs. Reader's preload mapping reaches the existing trusted, redacted main-process handler.
- **Accessibility:** named viewport and date groups, top-level chat title, valid connector/receipt/tool roles, decorative streaming caret, and tab close buttons outside the tablist. Shared modals trap focus, include disclosure summaries, make background branches inert, preserve overlapping ownership, and restore connected triggers.
- **Recovery:** one primary reconnect banner with diagnostics, safe offline drafting, and guarded reconnect requests.
- **Motion, corrected at the user's request:** retain the original owl flight, autonomous idle acts, working poses, and animated selected-agent card in expanded and compact navigation. Reduced-motion handling remains in place. Home's mascot is untouched.

Files remain contextual in the existing Files panel and preview, as permitted by the plan's initial-delivery scope. Existing classic/light preferences remain available; this delivery does not replace them with a new theme model. Existing onboarding, notification privacy, completed-computer-capture labeling, draft keys, route aliases, filesystem guards, browser partitions, and backend authorization boundaries are retained.

## Verification

Redesign delivery commands, before the owl-animation correction below:

```sh
npm run test:unit -- --maxWorkers=2
npm run test:electron
npm run lint
npm run build
npm run test:bundle
npm run test:e2e
node tests/e2e/home-page.mjs
node tests/e2e/sidebar-compact.mjs
node tests/e2e/layout-alignment.mjs
node tests/e2e/redesign-accessibility.mjs
```

The optional accessibility script needs the Factory `agent-browser` CLI, or `AGENT_BROWSER_BIN` pointing to it. It pins the disposable app renderer, not a native website or the user's browser.

| Automated gate | Result |
| --- | --- |
| Complete unit suite, two workers | 3,477 passed in 376 files; 1 expected failure, 18 skipped, 1 todo |
| Complete Electron suite | 983 passed in 64 files; 2 skipped |
| Lint | Both TypeScript projects and syntax checks for 173 Node JavaScript files passed |
| Production build | Passed |
| Bundle budgets | All 15 checks passed; existing ceilings unchanged |
| Existing native E2E suite | All 4 tests across 2 files passed |

One high-contention run alongside multiple builds/native captures had 10 failures, including seven 5-second timeouts and follow-on fixture assertions. The complete unit suite subsequently passed with two workers, without changing application code or test timeouts. Earlier unrestricted full runs also passed. Run expensive verification jobs separately on resource-constrained machines.

### Rendered evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Shell/layout and native overlays | 40 checks passed; 19 screenshots; no renderer errors | [Report](../tests/e2e/artifacts/layout-alignment-1791417661054/report.json) |
| Original Home | 13 checks passed; unchanged 168px centered Pip, launch/actions/heatmap/transcript retention | [Report](../tests/e2e/artifacts/home/report.json) |
| Compact sidebar, rerun after restoring the owl | 16 checks passed in messenger/classic at 960px and 1440px | [Report](../tests/e2e/artifacts/sidebar-compact-1791421244280/report.json) |
| Rendered axe-core 4.12.1 | Zero violations across 11 audited app states; contrast incompletes remain | [Report](../tests/e2e/artifacts/redesign-accessibility-1791417798856/report.json) |

The layout run covers 1440×900, 1280×800, 1024×700, and 960×640; docked/main-area/closed Workspace; compact navigation; enlarged text; keyboard resizing; draft continuity; native bounds; real takeover/resume; More, Reader, Settings, palette, and file-preview overlays; real interrupted turn with draft/attachment; archive resume and fresh New chat.

The axe run covers messenger/classic with both saved theme choices, empty/populated Workspace, More, General settings, real denied permission, Chats, and disconnect/draft recovery. The final run verifies explicit Reconnect without losing the draft; earlier successful runs also exercised automatic recovery. Submission/failure/duplicate guards have unit coverage. No standing permission is granted.

All native runs use fresh temporary HOME, Hermes profiles, and Electron userData, a loopback fake model/website, a read-only sandbox around the installed Hermes source, and off-screen unfocused windows. Owned app/runtime process groups and temporary profiles are cleaned up. Real chats, credentials, and user-owned services are not used.

### Owl animation correction

The user clarified that owl animations were not to be removed. Sidebar flight and autonomous idle acts are restored, along with the animated selected-agent card in both layouts. The card keeps its presence/model display, expanded info disclosure, and direct compact info action. Reduced-motion and focus guards remain. Home's component, styles, preferences, actions, and launch default have no Git changes.

After this correction, **239 focused tests across 27 files**, lint/type checks, production build, and **15 bundle checks** pass. The complete unit/Electron suites and axe matrix above predate this narrow correction and were not repeated.

`node tests/e2e/mascot-stage.mjs` passes **7 native checks**, verifying visibly changing idle frames, continuous reply delivery and return, approval perching and return after denial, frame cadence, and no renderer errors. Both landings align exactly with their target edges. [Owl motion report](../tests/e2e/artifacts/mascot-1791421201575/report.json). The final compact-sidebar run passes **16 checks**, and original Home passes **13 checks** again. One earlier motion capture used the wrong selector for tracked stage perches; the corrected harness supports both tracked and reparented perches.

### Known limits

- Axe leaves manual contrast review for the classic composer gradient, current-activity gradient, and selected General settings row reported as overlapped. These are **incomplete checks**, not certified passes. Messenger chat and Workspace states have no remaining incomplete rules in this fixture.
- VoiceOver, representative participant usability sessions, native OS permission/dialog behavior, and launch/latency/memory benchmarks were not performed. Phase E remains manual research, not an automated success claim.
- This is not an exhaustive long-content, many-agent, IME, theme, zoom, or assistive-technology matrix. Existing regression tests cover additional states, but do not replace native manual checks.
- Before/after screenshots are useful inspection evidence, not a pixel-matched baseline or measured usability improvement.
- Production builds retain existing non-fatal Vite warnings about the non-module theme bootstrap, mixed static/dynamic imports, and large optional chunks. No unrelated bundling rewrite was made.
- Earlier failed layout/audit directories are retained as superseded diagnostics. Use the successful reports above for delivery evidence.

Existing dirty-tree work was preserved. No commit, push, installation, or deployment was performed.
