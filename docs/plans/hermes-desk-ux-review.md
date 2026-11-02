# Hermes Desk UI/UX review

Wave 7, UI worker. Product code is unchanged. This is a measured findings ledger, not a redesign or a claim that the product passes.

Final run: **2773/3696 checks pass, 923 fail**, 16 matrix combinations, 360 measured renderer screenshots plus 1 separate native-view capture. Started 2026-10-06T23:24:47.051Z; completed 2026-10-06T23:27:45.375Z. Baseline main: `b8d0eacc8436a1e9a1b2aadb0e6eacd767382529`. Failures are repeated state checks, not 923 distinct bugs. Raw evidence: `blueprint-out/data/report-sweep.json` and `blueprint-out/data/ui-measurements.json`.

## Evidence and scope

Run `node tools/blueprint/sweep.mjs` from the repository root. The full matrix is 1440×900, 1280×800, 1024×700, and the native minimum 960×640, each with workspace open/closed and messenger/classic skin.

The sweep launches the actual Electron app, actual isolated Hermes serve, and the existing deterministic loopback model/site. HOME, HERMES_HOME, and userData are disposable. Windows stay background-only. Production homes, ports 8642/9119, hosted models, real desktop input, secrets, and OS permission prompts are not used.

Real flows cover profile selection, streaming, model-driven browsing, user takeover, Resume, and Files. Long Markdown, terminal/browser tool chips, approval, and clarification are explicitly labelled renderer presentation fixtures on a real-bound session. Only replies to those synthetic request IDs stop at a disposable reply collector. These cards do **not** prove backend approval authority or backend tool execution.

Every captured renderer state runs computed-colour WCAG checks, header/toolbar intersections, sticky-date intersections, independently decoded PNG edge/bottom sampling, overflow/control bounds, mascot pixel diversity, 28px targets, hover/chip intersections, theme surfaces, and screenshot scale checks. Inactive controls use the WCAG exception. Image-backed backgrounds are reported as approximations, not certified contrast results. Native browser views are captured separately from parent renderer screenshots. Long-answer captures target the current unique fixture heading and check its visible bounds after offscreen layout settles. Each Files palette result is captured before any presentation recovery.

The matrix uses the actual Appearance switch, native content-size changes, and visible Settings sections. Keyboard palette/Settings routes permit measurement despite overlapping header buttons or clipped sidebar controls. The Files palette's real no-op remains red; an explicit DOM button-click fixture then opens Files for layout measurements. Geometry failures also remain red. It is not a backend reconnect/session-lease test.

## Fix-first ledger

P1 means blocks or confuses users. P2 means friction. P3 means polish. “Known” refers to the owner's existing bug list. Each measured P1/P2 maps to a sweep check; the complete per-state values live in the JSON and worker report.

### UX-1 · P1 · Header controls collide with the selected-agent pill

- **Flow/step:** choose an agent, open workspace, then use Files or workspace controls, especially at 1024px/minimum width.
- **Experience:** the centred pill looks important but sits over other actions. A user clicks a visible icon and opens agent info instead. Long names amplify the collision. The open workspace leaves too little room for chat and navigation.
- **Evidence:** `BP-UI-1`, 89 failing state checks. At 1024×700/dock open: `[{"first":"Toggle sidebar","second":"Show info for Alpha","area":557.53,"firstBox":{"x":254,"y":8,"width":38,"height":38,"right":292,"bottom":46},"secondBox":{"x":277.328125,"y":8,"width":89.328125,"height":39,"right":366.65625,"bottom":47}},{"first":"Toggle sidebar","second":"Notifications, 10 unread","area":128,"firstBox":{"x":254,"y":8,"width":38,"height":38,"right":292,"bottom":46},"secondBox":{"x":226,"y":11.5,"width":32,"height":32,"right":258,"bottom":43.5}},{"first":"Toggle sidebar","second":"Toggle files","area":975,"firstBox":{"x":254,"y":8,"width":38,"height":38,"right":292,"bottom":46},"secondBox":{"x":266,"y":8.5,"width":38,"height":38,"right":304,"bottom":46.5}}]`. Screenshot: `blueprint-out/ui/113-messenger-1024x700-dock-open-sidebar-chat.png`.
- **Heuristic:** hierarchy, error prevention, density, alignment.
- **Check:** `Header and toolbar controls do not overlap`, plus control bounds/hit targets for narrow splits.
- **Fix:** reserve separate left/centre/right header tracks, give the title a bounded ellipsis with a full-name tooltip, and collapse secondary actions before the chat becomes unusable. Constrain dock width against a usable chat column rather than only a percentage of the parent. Likely `src/components/TopBar.tsx`, `src/styles/skin-messenger.css:181`, `src/components/SidePanel.tsx:119`.
- **Size:** M. **Known:** E1, not a new backend Files failure.

### UX-2 · P1 · Markdown and small status text lose contrast

- **Flow/step:** read a long answer, table, inline code, starter chip, sidebar activity, or workspace Computer label.
- **Experience:** code/table tokens and pale starter chips are hard to read; secondary status text becomes almost invisible. Smaller type makes the problem worse.
- **Evidence:** `BP-UI-5`, 208 failing state checks. Long-answer examples: `[{"text":"inline code","ratio":1.101,"required":4.5,"size":12.75},{"text":"Area","ratio":1.101,"required":4.5,"size":12},{"text":"Result","ratio":1.101,"required":4.5,"size":12},{"text":"Next step","ratio":1.101,"required":4.5,"size":12},{"text":"js","ratio":1.123,"required":4.5,"size":10},{"text":"Latest","ratio":1.622,"required":4.5,"size":12}]`. Screenshot: `blueprint-out/ui/017-messenger-1440x900-dock-closed-long-markdown-top.png`.
- **Heuristic:** hierarchy, recognition over recall, visibility of status.
- **Check:** `Visible text meets WCAG AA`, including placeholders, alpha/ancestor opacity, large-text thresholds, links, inline code, table headers, and chips.
- **Fix:** complete messenger token coverage for Markdown, starters, sidebar status, and launcher text. Raise timestamp opacity enough to meet AA rather than copying the reference's 55% literally. Keep 15px body text and make secondary text readable, not simply fainter. Likely `src/styles/skin-messenger.css:2`, `src/index.css`, `src/components/MessageBody.tsx`, `src/styles/skin-messenger-sidebar.css`.
- **Size:** S. **Known:** U1 for inline code/table headers; other text failures share this repair.

### UX-3 · P2 · Sticky dates cover the words being read

- **Flow/step:** scroll a long answer.
- **Experience:** “Today” stays legible by painting over actual message text.
- **Evidence:** `BP-UI-8`, 70 failing state checks. Measured intersection: `[{"text":"The agent should make its current status clear without asking you to remember a ","area":995.63,"date":{"x":498.34375,"y":80,"width":55.3125,"height":24.5,"right":553.65625,"bottom":104.5},"textBox":{"x":287.25,"y":82.8125,"right":754.421875,"bottom":100.8125,"width":467.171875,"height":18,"text":"The agent should make its current status clear without asking you to remember a ","date":false}}]`. Screenshot: `blueprint-out/ui/038-messenger-1440x900-dock-open-long-markdown-scrolled.png`.
- **Heuristic:** visibility, hierarchy, error prevention.
- **Check:** `Date pills do not cover message text`.
- **Fix:** put the sticky date in a reserved full-width gutter or make it non-sticky. Pointer-events alone do not prevent visual occlusion. Likely `src/styles/skin-messenger.css:29`, `src/components/ChatPanel.tsx`.
- **Size:** S. **Known:** U2/U9.

### UX-4 · P2 · White workspace bottom strip breaks the dark cockpit

- **Flow/step:** open the workspace in messenger skin.
- **Experience:** a bright strip and mismatched Computer launcher appear under otherwise dark workspace chrome.
- **Evidence:** `BP-UI-2`, 65 failing state checks. Decoded PNG samples: `[{"pane":"aside.flex.ca-enter.fixed","x":407,"y":698,"rgb":[255,255,255]},{"pane":"aside.flex.ca-enter.fixed","x":407,"y":695,"rgb":[255,255,255]},{"pane":"aside.flex.ca-enter.fixed","x":407,"y":691,"rgb":[255,255,255]}]`. Screenshot: `blueprint-out/ui/113-messenger-1024x700-dock-open-sidebar-chat.png`.
- **Heuristic:** consistency, hierarchy, reference fidelity.
- **Check:** `Dark chrome has no light edge or bottom patches`.
- **Fix:** apply the dark palette to the complete dock, including its bottom launcher and wrapper, not only the inner WorkspacePane. Likely `src/App.tsx`, `src/styles/workspace.css`, `src/components/SidePanel.tsx`.
- **Size:** S. **Known:** U4. White content inside a real browser page is not this finding.

### UX-5 · P2 · Files and Settings escape the messenger theme

- **Flow/step:** open Files or any Settings section from the dark chat.
- **Experience:** bright cards, controls, and panel surfaces interrupt the visual hierarchy and inherit incompatible text tokens.
- **Evidence:** `BP-UI-6`, 65 failing state checks. Computed auxiliary surfaces: `[{"selector":"div.relative.flex.max-h-[86vh]","background":[255,255,255,1],"dark":false}]`. Screenshot: `blueprint-out/ui/124-messenger-1024x700-dock-open-settings-hermes.png`.
- **Heuristic:** consistency, hierarchy.
- **Check:** `Messenger auxiliary panels retain dark surfaces`, with contrast checked separately.
- **Fix:** propagate the messenger theme to modal and side-panel roots; share semantic surface/text tokens instead of nesting isolated light defaults. Likely `src/components/SettingsStub.tsx`, `src/components/settings/local/common.tsx`, `src/components/SidePanel.tsx`, `src/styles/skin-messenger.css`.
- **Size:** M.

### UX-6 · P2 · Completed terminal chips still say “Running terminal”

- **Flow/step:** wait for a successful terminal tool to finish.
- **Experience:** a completion mark and elapsed time conflict with a present-tense “Running” caption.
- **Evidence:** `BP-UI-7`, 8 failing state checks. `{"toolChips":["⌘\nmcp__hermes_desk__browser_navigate\n✓","⌘\nmcp__hermes_desk__browser_snapshot\n✓","⌘\nmcp__hermes_desk__browser_click\n✓","⌘\nRunning terminal\n✓","🌐\nbrowser_navigate\n✓"]}`. Screenshot: `blueprint-out/ui/015-messenger-1440x900-dock-closed-fixture-tools-completed.png`.
- **Heuristic:** visibility of status, consistency.
- **Check:** `Completed chips stop saying Running terminal`.
- **Fix:** derive captions from `ToolEvent.status`; use “Ran terminal” or a completed command summary. Likely `src/components/chat/ToolChipRow.tsx:21`.
- **Size:** S. **Known:** U8. These matrix chips are presentation fixtures, not proof of a real terminal execution.

### UX-7 · P2 · Hover actions obscure tool activity

- **Flow/step:** hover an answer with completed tool chips.
- **Experience:** the floating action toolbar covers the chips a user wants to inspect.
- **Evidence:** `BP-UI-10`, 3 failing state checks. Measured chip/action intersection: `[{"chip":"🌐browser_navigate✓","button":"Add reaction","area":686},{"chip":"🌐browser_navigate✓","button":"Reply to Alpha","area":673.37}]`. Screenshot: `blueprint-out/ui/036-messenger-1440x900-dock-open-completed-tool-hover.png`.
- **Heuristic:** hierarchy, affordance, error prevention.
- **Check:** `Hover actions do not cover tool chips`.
- **Fix:** reserve an action gutter or place the toolbar beside/below the answer; do not position it over the preceding chip row. Likely `src/components/MessageActions.tsx`, `src/styles/skin-messenger.css`.
- **Size:** S. **Known:** U10.

### UX-8 · P2 · Classic sidebar controls fall outside the window

- **Flow/step:** show the full roster at compact heights, then look for the bottom agent card or Settings.
- **Experience:** the footer extends below the window instead of leaving a scrollable roster and an anchored action area.
- **Evidence:** `BP-UI-11`, 69 failing state checks. Window 960×640: `[{"label":"About Alpha","x":0,"y":582,"width":240,"height":102,"right":240,"bottom":684}]`. Screenshot: `blueprint-out/ui/318-classic-960x640-dock-open-sidebar-chat.png`.
- **Heuristic:** recovery, hierarchy, density.
- **Check:** `Controls stay inside the window without sideways overflow`.
- **Fix:** share structural sidebar flex/scroll rules between skins: fixed header/footer, `min-height:0` on the roster, and a scrollable middle region. Likely `src/components/Sidebar.tsx:507`, `src/styles/skin-messenger-sidebar.css`.
- **Size:** M.

### UX-9 · P2 · Hit targets are smaller than their visible intent

- **Flow/step:** use history arrows, sidebar search/new-agent controls, workspace tab controls, or approval/settings actions.
- **Experience:** tiny glyphs need precise clicks; the open dock compresses some controls further.
- **Evidence:** `BP-UI-3`, 328 failing state checks. Measured targets: `[{"label":"Go back","x":296,"y":8,"width":6.8125,"height":39,"right":302.8125,"bottom":47},{"label":"Go forward","x":306.8125,"y":8,"width":6.8125,"height":39,"right":313.625,"bottom":47},{"label":"Add emoji","x":364,"y":613,"width":16.21875,"height":33,"right":380.21875,"bottom":646},{"label":"Close Hermes Desk Local Fixture","x":603.9375,"y":83.46875,"width":22,"height":24,"right":625.9375,"bottom":107.46875}]`. Screenshot: `blueprint-out/ui/113-messenger-1024x700-dock-open-sidebar-chat.png`.
- **Heuristic:** affordance, error prevention, spacing rhythm.
- **Check:** `Active controls have at least 28px hit targets`.
- **Fix:** keep glyphs small but use at least 28×28px interactive boxes, preferably shared 32/36px control tokens. Avoid shrinking flex items that contain icon buttons. Likely `src/components/TopBar.tsx`, `src/components/workspace/WorkspaceNav.tsx`, `src/components/settings/local`, `src/components/Sidebar.tsx`.
- **Size:** S.

### UX-10 · P2 · Fresh local setup has no clear next-step guide

- **Flow/step:** launch with fresh userData and a valid local Hermes fixture.
- **Experience:** the shell appears before a clear local-setup explanation. “Select an agent” and unrelated starter suggestions do not explain profiles, connector opt-in, or what stays on this Mac.
- **Evidence:** `BP-UI-4`, 1 failing state check. `{"dialogs":0,"freshUserData":true,"automationHook":"undefined"}`. Screenshot: `blueprint-out/ui/001-flow-fresh-userData-first-run.png`.
- **Heuristic:** recognition over recall, empty-state guidance, error recovery.
- **Check:** `First run explains local setup before asking users to chat`.
- **Fix:** show a short local-only checklist: Hermes detected/running, choose a profile, send a message, optionally enable the browser connector. Missing-Hermes guidance should offer a concrete Settings action and preserve the same wording. Likely `src/App.tsx`, `src/components/settings/local/HermesPane.tsx`.
- **Size:** M. This does not claim to test first-ever OS permissions or a physically empty profiles directory.

### UX-11 · P2 · Normal and offline endpoint errors reach the renderer console

- **Flow/step:** keep the app open, then stop the harness-owned serve and inspect the offline banner.
- **Experience:** the banner is useful, but background endpoint failures continue. Console errors alone are not proof that chat or Files is broken.
- **Evidence:** `BP-UI-12`, 1 failing state check. 72 collected console entries (including native-window annotations, not unique error types). Unique failing paths/statuses: `[{"path":"/api/notifications","status":502},{"path":"/api/sessions/20261006_192500_62d020","status":502}]`. The screenshot shows the offline UI context, not the console ledger itself. Screenshot: `blueprint-out/ui/348-messenger-1024x700-dock-open-offline-banner.png`.
- **Heuristic:** visibility of status, error recovery.
- **Check:** final `No console errors`; failed response paths/statuses are also recorded.
- **Fix:** separate unavailable optional endpoints from disconnection, stop unnecessary polling while offline, and expose one actionable recovery state. Browser-generated HTTP errors from the deliberate offline test remain explicitly distinguishable from normal-operation errors. Likely `src/lib/hermes-rest.ts`, notification polling, and the local API proxy in `vite.config.ts`.
- **Size:** M.

### UX-12 · P3 · Icon and control tokens mix several visual languages

- **Flow/step:** compare chat, sidebar, workspace navigation, and Computer launcher.
- **Experience:** emoji, Unicode glyphs, and SVG icons differ in baseline, weight, and perceived clickability. Text-sized search/add glyphs compete with larger round buttons.
- **Evidence:** the header/targets screenshots above show the mixture; no unsupported quantitative “icon consistency score” is claimed.
- **Heuristic:** consistency, alignment, spacing rhythm.
- **Fix:** use one labelled SVG family for navigation and tools; reserve emoji for content. Share spacing, radius, glyph-size, and focus-visible tokens while keeping the reference's bubble-tail shape. Likely `TopBar.tsx`, `Sidebar.tsx`, `components/workspace/*`, `styles/workspace.css`.
- **Size:** S.

### UX-13 · P2 · Files is a no-op in the local command palette

- **Flow/step:** press Cmd+K, choose Actions, then Files.
- **Experience:** Search closes but the Files panel does not open in either skin. The user loses the keyboard recovery route just when narrow header controls collide.
- **Evidence:** `BP-UI-9`, 16 failing state checks. `{"skin":"messenger","filesOpen":false,"route":"actual Cmd+K → Actions → Files"}`. Screenshot: `blueprint-out/ui/029-messenger-1440x900-dock-closed-files-palette-result.png`.
- **Heuristic:** consistency, keyboard recovery, visibility of feedback.
- **Check:** `The Files palette action opens Files`.
- **Fix:** supply `onOpenFiles` to the local shell's CommandPalette, or let the registered command run when the optional callback is absent. `src/App.tsx:439` registers the action, while `src/components/CommandPalette.tsx:446` bypasses it for the optional callback.
- **Size:** S. This is new action wiring, not a claim that backend Files listing fails. The matrix records the failed real palette action, then explicitly uses a DOM button-click presentation fixture to measure Files and continue through Settings.

## Already-known bugs: current status, not duplicate tickets

| Known issue | Final-run status |
| --- | --- |
| U1 | Reproduced, UX-2. Computed contrast examples and every failing state remain in the report. |
| U2/U9 | Reproduced, UX-3. Sticky-date/message intersections are measured. |
| U4 | Reproduced, UX-4. Independent PNG samples include bright/white bottom pixels. |
| U5 | Not reproduced in the completed live Alpha chat. Restored-session preview ownership is not tested. |
| U6 | Not reproduced on the real initial Files flow. New palette wiring failure is separate, UX-13. |
| U7 | Not reproduced in presentation fixtures or the successful real browser flow. Other real tools remain outside this sweep. |
| U8 | Reproduced in messenger tool-chip presentation, UX-6. |
| U10 | Reproduced, UX-7. Hover/chip intersections are measured. |
| E1 | Reproduced, UX-1. Includes compact split and long-name cases. |

## Keep these behaviours

- Profile-based roster, hidden-profile restoration, and scratch visibility make agent selection understandable.
- Actual local streaming, model-driven browsing, native browser-view evidence, takeover, and Resume provide a credible end-to-end workspace flow.
- The offline banner and missing-Hermes Settings guidance communicate local dependency status.
- Settings has separate local sections for Hermes, agents, workspace, computer, secrets, appearance, and diagnostics.
- Messenger's 15px body typography, system font, 18px bubbles, avatar-led rows, and near-black canvas are a good base. Repair the token/layout gaps rather than replacing the skin.
- Keyboard palette and Settings shortcuts provide recovery when pointer controls collide. Focus and reduced-motion results are reported below, not assumed to pass.

## Reference fidelity and interaction audit

| Area | Assessment against spec §2 / §8.1 |
| --- | --- |
| Three-column cockpit | Present at wide sizes; narrow dock/header collisions undermine the intended hierarchy. |
| Charcoal messenger / rounded bubbles | Close to the reference. Auxiliary panels and bottom launcher break the palette. |
| Typography and status | Body scale is appropriate. Small low-opacity metadata and mixed icon sizes need repair. AA must take precedence over the literal 55% timestamp opacity. |
| Sidebar density | Nine profiles are represented; classic needs shared scroll/footer structure at compact heights. |
| Sticky dates | Reference intent is implemented, but it must not occlude message words. |
| Tool/approval/clarify feedback | Cards/chips are represented; completed-terminal wording and hover placement need repair. Backend authority remains outside this sweep. |
| Workspace ownership | Browser lane status, takeover, and Resume are driven on the real connector path. |
| Empty/error states | Hidden-all, empty chat/lane, offline, and missing-Hermes are captured. Fresh setup needs a clearer first action. |
| Focus / reduced motion | Explicit checks, with actual computed styles and animation lists, rather than visual assumptions. |
| PiP / HUD | Isolated native-window presentation only; no live screen capture, dictation, or OS input is exercised. |

- **PASS** Settings arrow keys select and focus the next section: `{"focus":"Agents","current":"Agents"}`.
- **PASS** Keyboard-focused Settings controls show a focus indicator: `{"outline":"solid","width":"2px","shadow":"none"}`.
- **PASS** Reduced-motion preference stops decorative infinite animation: `[]`.
- **PASS** Computer preview honestly labels the last completed capture: `● Computer · alpha\nTake control\nPaste\n⤢\n×\nNo completed capture yet.\nThis preview is not a live Mac feed.\nNo completed capture\nWatching · drag anywhere · Take control for mouse and keyboard\nComputer-use permissions or driver unavailable.`.
- **PASS** The background HUD renders its mascot: `{"viewport":{"width":620,"height":340,"scale":1},"mascots":[{"selector":"svg.","x":282,"y":278,"width":56,"height":56,"right":338,"bottom":334,"paths":9,"colours":37,"nonBlank":true}]}`.
- **PASS** Offline cached chats remain visible and the composer is disabled: `{"disabled":true,"bubblesBeforeStop":53,"bubbles":53}`.
- Cold launch to populated roster: **3939.7 ms**. Existing isolated launchHarness launchedAt to visible Alpha after reload/observer installation; includes instrumentation overhead.
- Submit to first visible streamed text: **2842.5 ms**. Real UI Enter → real Hermes → existing fake-model → visible bubble text.
- Serve stop to visible offline banner: **215.1 ms**. Stop harness-owned real serve supervision/process group → renderer offline status.
- Latencies are single instrumented samples, not performance certification. Cold-roster timing includes reload/instrumentation overhead.

## Validation and honest limits

Owned-script syntax checks and the helper's 10/10 independent measurement invariants pass. Six targeted UI unit files pass, 85/85 tests. `npm run build` passes, with existing Vite bundling/chunk warnings. The sweep intentionally exits non-zero for product findings; no thresholds were relaxed to make product failures pass.

Development-only runs corrected fixture/socket routing, synthetic reply isolation, a persisted Settings modal, Files close selection, rendered-Markdown matching, PNG/mascot/date/hover coverage, debounced palette selection, and native-window URLs. Screenshot inspection also caught scrolling to an older long-answer fixture and a transparent HUD capture during lazy loading. The sweep now targets the current heading and waits for the real HUD shell/mascot, with explicit checks. Explicit HUD close avoids the rapid-toggle guard before the offline matrix. Aborted or stale runs are not the reported result.

Only the final report's screenshot manifest/contact sheets belong to this review. Earlier development PNGs may still exist under the gitignored output directory.
All 361 final-manifest images were inspected through 31 contact sheets, with full-size checks of key failures and PiP/HUD. The final long-answer and HUD captures are not blank.

- Physical zero profiles (Hermes always exposes a default profile; empty-visible-roster uses disposable preferences).
- Backend-generated approval/clarify authority round trips; matrix cards are labelled presentation fixtures.
- Pointer access to an overlapped Files button is not claimed by the DOM fixture recovery; the real palette no-op and header intersections remain failing checks.
- Backend reconnect/session-lease ownership is outside the UI matrix; development reloads exposed unstable fixture bindings, so the measured matrix keeps one real-bound session alive.
- True OS focus without an offscreen background window, native file/consent dialogs, permissions, 1Password, live Mac capture.
- Collapsed HUD presentation is not asserted: document.hasFocus() may be true while the native test window remains unfocused. The actual expanded or collapsed shell and mascot are measured.
- Workspace/chrome content inside native WebContentsViews is not in renderer screenshots; separately captured below.
- 4202 image-backed/unsupported-background text observations are labelled approximations across repeated states. Do not treat them as an AA certificate.
- First-run, hidden/scratch restoration, hidden-all roster, missing-Hermes, PiP/HUD and keyboard/motion are dedicated tours, not a full cross-product. Main chat/cards, Files, all seven Settings sections, and offline states run across the full size/dock/skin matrix.
- Screenshot device scale is 1, matching these Electron windows, as allowed by the brief.
