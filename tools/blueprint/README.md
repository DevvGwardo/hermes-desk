# Blueprint harness

Browser scripts that produce every screenshot and number in the mobile blueprint
(`docs/blueprint/nub-mobile-blueprint.html`, published at https://claude.ai/artifact/XEVXQLfPBEamD76aBZLGa7).
They drive the real app in Chrome (`playwright-core`, `channel: "chrome"`) against the dev server in
offline demo mode (fixtures in `src/lib/mock-dashboard.ts`, `mock-cron.ts`, `mock-files.ts`; compiled out of production builds) and write raw evidence to `blueprint-out/` (gitignored; override with `BP_OUT=/path`,
and the app with `APP_URL=...`).

**Stream-safe by construction** (`lib.mjs`): every request that isn't to the local dev server is aborted,
so no pairing code, account or VM is ever touched, and a run refuses to start if `APP_URL` isn't serving
Nub Agent (a dev port can be taken by another project's server).

| Script | What it checks and captures |
|---|---|
| `mobile-parity.mjs` | 30 checks at 390 × 844 (touch): home shortcuts and bell, Routines, deep links, the full Settings panes, find in chat, files, Agent info links, hidden chats, touch targets |
| `mobile-reach.mjs` | 26 checks (pass 2): search across chats and the jump landing on screen, chat history, the task board, Marketplace recipes, templates and delivery targets, run output, files and previews, invite links, ⌘K / ⌘, |
| `themes.mjs` | 23 checks (pass 3): text contrast ≥4.5:1 on six screens in light and dark (dark chosen through the phone's own Settings), the 640px tablet column at 768 / 834px, and ⌘[ / ⌘] / Alt+↑↓ |
| `sweep.mjs` | 21 checks: the desktop-width web shell after the shared-component changes, and phone screens at 360 / 390 / 430px |
| `web-panels.mjs` | 7 checks (gap loop): on the desktop-width web app, ⌘⇧M / ⌘⇧W and links naming Plugins or Hermes tools never leave a hidden panel in the URL or holding Esc |
| `routine-editor.mjs` | 7 checks (gap loop): the routine editor's two-step Delete never carries over to the next routine (Esc, Cancel, Keep), and nothing gets deleted by accident |
| `phone-signin.mjs` | 6 checks (gap loop): on the phone, "Sign in with Telegram" in the Settings sheet lands on "Link this phone" and stays there, from home and from the Settings screen, and Back doesn't reopen the sheet (the pairing request is blocked, so no code is minted) |
| `phone-preview.mjs` | 6 checks (gap loop): on the phone, Back closes a file preview before the Files panel under it, and no preview outlives Files |
| `phone-touch.mjs` | 14 checks (gap loop): on the phone, Routines' New routine, Run now and pause switch, Files' Refresh, Close and tabs, and a chat file card's View and Download answer taps across 44 × 44px (hit-tested with `elementFromPoint`), the switch still draws at 36 × 20px, and edge taps still work |
| `phone-esc.mjs` | 7 checks (gap loop): on the phone with a keyboard, Esc leaves Routines (its back link promises "Back · Esc") and closes Files, one layer at a time (a preview over Files closes first), and leaves home alone |
| `web-esc.mjs` | 4 checks (gap loop): on the desktop-width web app, Esc with Settings open over Agent info closes Settings first, then Info |
| `web-settings.mjs` | 5 checks (gap loop): on the desktop-width web app, the Settings tab on screen is the one the URL names, including after closing on one tab and reopening, and a reload lands on the same tab |
| `bell-esc.mjs` | 8 checks (gap loop): on desktop and the phone, Esc closes the notifications list from inside it and puts focus back on the bell |
| `preview-guard.mjs` | 9 checks (gap loop): on the desktop-width web app, once a file preview with unsaved edits is closed with Discard, Back / Forward and a link to the file never ask about those edits again (and the file opens), while fresh edits still guard Close, Esc and Back, and Cancel keeps the draft and the URL |
| `delete-confirm.mjs` | 10 checks (gap loop): on the desktop-width web app, the sidebar's "Delete conversation?" names the chat as its row does, opens with Cancel focused and Enter there cancels (the chat stays), Esc cancels, Esc with Agent info open closes the dialog or the row menu before Info, and Tab-to-Delete + Enter or a click still delete |
| `palette-enter.mjs` | 6 checks (gap loop): on the desktop-width web app, ⌘K acts on what was typed when Enter or ⌘1 comes faster than the 150 ms search debounce (All, Agents and Routines tabs), and unhurried typing still works |
| `palette-focus.mjs` | 8 checks (gap loop): on the desktop-width web app, closing ⌘K (Esc or a click outside) puts focus back in the composer so typing lands there, the search is `aria-modal`, Tab / Shift+Tab never leave it, and a pick that opens the routine editor keeps the editor's focus |
| `toast-contrast.mjs` | 4 checks (gap loop): on the desktop-width web app, the app toast (raised by an unknown chat link) meets 4.5:1 in light and dark, and sits in a `role="status"` live region |
| `desktop-themes.mjs` | 21 checks (gap loop): on the desktop-width web app, every visible text meets 4.5:1 in light and dark on nine screens (chat, Agent info, ⌘K, a file preview, notifications, Connect apps and its Agents, Routines, the routine editor), with translucent backgrounds composited, plus the "from <agent>" chip on its own |
| `routine-resave.mjs` | 6 checks (gap loop): on the desktop-width web app, after "Save & run now" in the routine editor, a second Save that turns Active back on (or puts the time back) really reaches the demo agent, and the button stops offering to save what was just saved |
| `esc-layers.mjs` | 5 checks (gap loop): on the desktop-width web app with Agent info open, Esc closes the notifications list (focus back on the bell) or an agent's profile card first and leaves Info; Info alone still closes on Esc |
| `routine-switch-focus.mjs` | 5 checks (gap loop): on the Routines page, desktop and phone, Space on a routine's pause switch keeps focus on that switch as the row moves to Paused and back |
| `files-refresh.mjs` | 5 checks (gap loop): in the Files panel, desktop and phone, Refresh keeps what's typed in the search and its filtered list, and opening a folder still starts with an empty search |
| `bell-list.mjs` | 8 checks (gap loop): with two unread notifications seeded, the open notifications list is really on top (four points hit-tested) on desktop, desktop with Agent info open and the phone, and the bell's accessible name says "2 unread", dropping the count after Mark all read |
| `layers-on-top.mjs` | 15 checks (gap loop): ten floating layers on the desktop-width web app and four on the phone, opened one at a time, are really on top (five points hit-tested with `elementFromPoint`); with #248's header fix reverted it fails the desktop bell list |
| `slash-exact.mjs` | 5 checks (gap loop): in the chat composer, "/new" typed out in full lists New conversation first and Enter doesn't open the agent creator; "/new-agent" still does; a prefix keeps list order |
| `message-toolbar.mjs` | 4 checks (gap loop): a chat message's action toolbar shows while pointed at and hides after, tabbing through the chat leaves at most one open, and none stays once focus is in the composer |
| `message-menu.mjs` | 6 checks (gap loop): a chat message's right-click menu takes focus on its first item, uses menu items, moves with Arrow Down, closes on Esc with focus back on the message, and with Agent info open Esc closes the menu, not Info |
| `phone-row-menu.mjs` | 5 checks (gap loop): on the phone with a keyboard, a chat row's long-press menu takes focus on its first item, moves with Arrow Down, and closes on Esc with focus back on the row, leaving home in place |
| `telegram-focus.mjs` | 5 checks (gap loop): "Connect with Telegram" (opened by /new-agent in the unlinked demo) takes focus, keeps 10 Tabs inside, announces its error, and Esc puts focus back in the composer |
| `sign-in-screens.mjs` | 5 checks (gap loop): web sign-in, against a **production** build on :4329 (`WEB_URL`), says an unreachable server in words, keeps focus in the code box while typing on the error screen, and flags a bad pasted code while waiting; phone sign-in (demo) says a blocked request in words. Build and serve commands are at the top of the script |
| `paste-race.mjs` | 5 checks (gap loop): on phone (demo) and web (production build on :4329) sign-in, a code pasted while "Getting a code…" is still loading stays, whether the slow request then answers with another code or fails |
| `quick-reply.mjs` | 5 checks (gap loop): on desktop and phone (demo), a tapped quick-reply chip posts its words (no `[choice:…]` token) and the chips retire once one was picked |
| `analytics-off.mjs` | 8 checks: the offline demo never contacts PostHog (desktop and phone, while sending a message and creating a routine), and Settings → Safety shows no analytics switch in a build that can't send |
| `replay-masking.mjs` | 15 checks: session replays from a **production** build (dummy key, PostHog answered locally with the live project's config, served on :4319, not the demo server) carry no words: on-screen text, a message added later, typed text and alt text are all hidden. Console output, request addresses, heatmaps and web vitals aren't sent, the support widget stays off, an uncaught error still reaches error tracking, replay turns on without a feature-flags call, and no PostHog script is fetched. Build and serve commands are at the top of the script |
| `demo-agent-info.mjs` | 4 checks: the demo's Agent info shows a real agent's sections. Research Alpha counts its own routines ("2 routines · 1 active", not "Nothing scheduled yet"), the count fits within ⌘K's Routines list, and no section says the agent can't be reached |
| `walk.mjs` | the recorded phone tour (`blueprint-out/mp4/phone-walk.webm`) |
| `build-report.mjs` | writes the report from `docs/blueprint/nub-mobile-blueprint.template.html`, filling the test table and counts from the JSON reports |
| `lib.mjs` | shared launch, network blocking, report and `check` / `step` helpers |

Run them one after another (never in parallel; timings skew and logs clobber):

```sh
VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1 &
for s in mobile-parity mobile-reach themes sweep web-panels routine-editor phone-signin phone-preview phone-touch phone-esc web-esc web-settings bell-esc preview-guard delete-confirm palette-enter palette-focus toast-contrast desktop-themes routine-resave esc-layers routine-switch-focus files-refresh bell-list layers-on-top slash-exact message-toolbar message-menu phone-row-menu telegram-focus analytics-off walk build-report; do node tools/blueprint/$s.mjs || echo "$s FAILED"; done
```

Each check script writes `blueprint-out/data/report-<script>.json` (`{checks, perf, errors, blockedHosts}`)
and exits non-zero on any failed check. `BP_NAME=mobile-parity-before` runs the parity script under another
report name (used for the "before" baseline). Report media is built with the blueprint skill's
`scripts/media.py` into `docs/blueprint/media/`.
