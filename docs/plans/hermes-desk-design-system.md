# Hermes Desk design system

**06 October 2026 · implementation contract for chat and host workers**

Design-only handoff. These files do not change the running application. The
reference is the local desktop spec §2 and §8.1, not Telegram functionality.
Use `src/styles/desk-tokens.css` and the nine primitives in `src/components/ui/`.
No new dependencies, downloaded fonts, hosted assets, or remote browser needed.

## 1. Direction

**A quiet messenger for useful agents.** Charcoal planes, clear conversation
hierarchy, consistent outline controls, and Pip as a small, warm companion.

- **Calm:** no gradients, glow, decorative glass, animated backgrounds, or
  permanent notification colour. Colour reports ownership or state.
- **Dense but breathable:** 4px spacing grid, 64px headers, 76px roster rows,
  32px tool rows. Leave 16px between turns, not between fragments of a turn.
- **Content first:** answers have the strongest text contrast. Chrome is
  secondary. Timestamps remain readable, never reduced to 55% opacity.
- **One accent per agent:** selected agent colour owns read ticks, quoted
  reply bars, workspace cursor, selection controls, and the send action.
  Outgoing messages stay neutral, not coloured.
- **Truthful state:** completed tools are not failures; “offline” is not
  “ready”; no fake unread count, fabricated activity, or empty Thinking bubble.
- **Pip is identity, not an icon:** no owl instead of a panel, settings, mic,
  or attachment symbol. One icon family everywhere.

## 2. Token reference

All tokens start with `--desk-`. CSS is opt-in: add `desk-theme` to the desktop
shell and import the stylesheet once. It does not restyle old app selectors.
Primitive class names start with `desk-`.

### Colour

| Token suffix | Value | Use |
| --- | --- | --- |
| `surface-0` | `#0e0e10` | App background, behind panes |
| `surface-1` | `#161618` | Sidebar, headers, composer, workspace chrome |
| `surface-2` | `#1c1c1f` | Chat canvas, fields, inset areas |
| `surface-3` | `#2a2a2e` | Incoming bubble, selected agent, raised controls |
| `surface-4` | `#3a3a3f` | Outgoing bubble, hover |
| `text-primary` | `#f2f2f5` | Message body, titles, selected labels |
| `text-secondary` | `#c4c4ce` | Descriptions, previews, control icons |
| `text-tertiary` | `#adadb9` | Timestamp, duration, secondary chrome |
| `hairline` | `#ffffff14` | Decorative pane and section separators |
| `hairline-strong` | `#ffffff26` | Decorative raised-surface separator |
| `control-border` | `#888894` | Required input boundary, not every divider |
| `accent` | `#a7ceff` | Default agent / non-agent active action |
| `accent-surface` | `#253347` | Accent label background |
| `accent-ink` | `#102239` | Text on the solid accent |
| `agent-accent` | `var(--desk-accent)` | Scoped current agent foreground / fill |
| `agent-surface` | `var(--desk-accent-surface)` | Scoped current agent soft background |
| `agent-ink` | `var(--desk-accent-ink)` | Scoped current agent solid-button text |
| `success` / `success-surface` | `#a3d9b5` / `#24352b` | Completed, healthy |
| `warn` / `warn-surface` | `#efc58c` / `#3b3022` | Shared login, permission needed |
| `danger` / `danger-surface` | `#f2a8ad` / `#3c272b` | Failed, destructive |
| `focus-ring` | `#b8d8ff` | 2px outline, 2px offset |

All three text colours and five semantic foregrounds pass **4.5:1 on all five
surfaces**. Minimum text ratio is **5.09:1**, tertiary on surface 4. Primary is
10.12:1 on surface 4. Tone pairs and inverted accent buttons pass 4.5:1 too.
Focus ring passes 7.70:1 and input boundary 3.23:1 on surface 4.
`desk-tokens.test.ts` computes WCAG sRGB luminance from the actual CSS.
Hairlines are decorative; do not use them as the only input boundary.

An agent overrides the **three-slot set**, scoped to its chat, card, and lane:

```tsx
style={{
  '--desk-agent-accent': '#a7ceff',
  '--desk-agent-surface': '#253347',
  '--desk-agent-ink': '#102239',
} as React.CSSProperties}
```

Never blindly use `avatarColor` as text: an arbitrary avatar palette is not an
AA text palette. Validate every custom triplet against the same tests before
shipping; otherwise keep the default blue slots. Pip can still use its named
character palette. Status colours do not change with the selected agent.

### Typography

Native stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
system-ui, sans-serif`. Code: `SFMono-Regular, ui-monospace, Menlo, monospace`.
No custom font loading. No all-caps body text.

| `type-N` / `leading-N` | Size / line-height | Default weight | Use |
| --- | --- | --- | --- |
| 11 | 11 / 16px | 400 or 500 | Time, status strip, keyboard hints |
| 12 | 12 / 16px | 400 | Preview, tools, settings helper |
| 13 | 13 / 20px | 500 or 600 | Controls, agent name, settings label |
| 15 | 15 / 22px | 400 | Message body; 600 for section heading |
| 17 | 17 / 24px | 600 | Dialog title |
| 20 | 20 / 28px | 600 | Settings title |
| 24 | 24 / 32px | 600 | First-run / standalone empty heading |

Weights: `weight-regular:400`, `weight-medium:500`, `weight-semibold:600`,
`weight-bold:700`. Use semibold, not bold, for ordinary hierarchy.
Numbers in duration, time, and unread badges use tabular figures.
Uppercase section labels may use 0.9px tracking at 11px/16, never 8–10px type.

### Spacing, radius, elevation

| Family | Tokens |
| --- | --- |
| `space-0,1,2,3,4,5,6,7,8,10,12,16` | 0,4,8,12,16,20,24,28,32,40,48,64px |
| `radius-xs,sm,md,lg` | 4,8,12,16px |
| `radius-bubble,tail,pill` | 18,6,999px |
| `shadow-raised` | 2px/8px soft black + quiet 1px edge |
| `shadow-popover` | 8px/24px black + light 1px edge |
| `shadow-modal` | 24px/64px black + brighter 1px edge |

No shadows on ordinary message bubbles or roster rows. Elevation is reserved
for floating popovers, the computer preview, and modal surfaces.

### Motion and layers

`duration-fast:100ms`, `normal:160ms`, `slow:240ms`, `pulse:1200ms`.
`ease-out:cubic-bezier(.2,.8,.2,1)`;
`ease-in-out:cubic-bezier(.4,0,.2,1)`.
New bubble: fade and rise 6px over 160ms; once per **turn**, never per token.
Hover colour: 100ms. Disclosure: 160ms. No bounce, layout spring, or marquee.

`z-base:0`, `sticky:10`, `popover:30`, `pip:40`, `modal:50`, `tooltip:60`.
These describe renderer layers, not a promise to draw over WebContentsViews.
Use the app-owned overlay / main-process view handling for native browser panes.

Reduced motion zeros all duration tokens, stops spinners and scrolling motion,
and gives Pip a static state pose. Loading still has a readable text label.
Forced-colour mode preserves a system focus outline and control boundaries.

## 3. Component and icon contract

| Primitive | API and rule |
| --- | --- |
| `Icon` | `name:IconName`, optional `size` (default 20), `title` for standalone meaning. Decorative inside labelled buttons. |
| `IconButton` | **Required non-empty `aria-label`**; `size:xs/sm/md` = 28/32/36px; `variant:ghost/primary/danger`; `active`, `round`, tooltip, shortcut, tooltipSide. Native ref and disabled supported. |
| `Button` | Visible children label; `primary/secondary/ghost/danger`; `sm/md/lg` = min 28/32/36px. Loading disables and sets `aria-busy`, keeps label. Defaults to `type=button`. |
| `Pill` | Non-interactive text state, optional `tone` and dot. Never add onClick. |
| `Badge` | Non-interactive count or label, zero hidden, visual cap 99+, actual count accessible. |
| `Tooltip` | Focus + hover, Escape dismissal even when focus is elsewhere, hoverable content, shortcut via Kbd; preserves existing aria-describedby. |
| `Toolbar` | Required label. Horizontal/vertical arrow navigation, wrap, Home/End; disabled and CSS-hidden controls skipped. Native Tab retained. Input caret keys untouched. |
| `Section` | Labelled section with title, description, action, headingLevel 2/3/4. |
| `ListRow` | Native button; title, description, meta, leading, trailing, selected. `aria-current`, not an incomplete listbox. No nested interactive content. |
| `Kbd` | Native kbd; use `aria-label="Command period"` where shorthand needs expansion. |

Primitives consume the stylesheet but do not import it repeatedly. Import it at
the desktop root. Keep Tooltip anchors outside overflow-clipped ancestors.
At a viewport edge choose a safe anchor or render a popover rather than clipping
the tooltip. For a disabled action, put the reason in visible helper text;
disabled buttons do not receive keyboard focus.

45 original SVG icons, all **viewBox `0 0 20 20`, 1.6px stroke, round caps and
joins, currentColor, no fill**:
search, plus, settings, bell, paperclip, sidebar, panel, workspace, back, forward,
reload, send, mic, stop, emoji, menu, more, copy, reply, branch, retry, check,
check-double, x, chevron-left/right/up/down, external, lock, globe, terminal,
file, folder, image, tool, sparkle, shield, pause, play, computer, hand, eye,
move (lane transfer), reader.
Default 20px in chrome; 16px in tool rows and labels; 12–14px for metadata.
These are optical sizes of the same grid, not independent icon sets.
Never turn stop or send into a filled glyph while the rest use outlines.

## 4. Per-surface implementation specs

### Shell and responsive layout

- At **1440×900**: 32px native title chrome; sidebar 248px; chat and workspace
  share remaining width. Demo frame has a 16px presentation gutter.
- At **1024×700**: sidebar 212px; workspace 352px; chat gets remaining width.
  Demo gutter 12px. Production uses the actual Electron content bounds, no gutter.
- Pane headers align at 64px. Pane separators are 1px hairlines. Content scrolls;
  header, footer and composer do not. Every pane has `min-width:0; min-height:0`.
- Workspace has a 352px minimum. Below the combined 212 + 360 + 352px content
  budget, collapse workspace first, then offer compact sidebar. Never shrink
  the composer or its controls below usable targets.
- Keep optional browser actions in More below 1150px; retain back, forward,
  reload, address, and More. Do not hide a critical ownership action.
- Keep app navigation keyboard-native. These mockups propose no new global
  shortcuts; wire only shortcuts the app actually implements.

### Chat header

64px, surface 1, 12px horizontal padding, 1px bottom hairline. Leading sidebar
toggle (32px). Centre a 36px neutral pill: 28px Pip/avatar, agent name 13px
semibold, 12px chevron. Opens AgentInfo. Trailing **only** bell and panel toggle,
32px targets, 4px gap. Panel toggle has `aria-pressed` and the soft agent accent
while open. Files, computer, and HUD controls move to a labelled More/menu
surface rather than five competing round buttons. Attachment belongs in composer.

### Sidebar

- Header 64px: 15px semibold Hermes Desk, Search, New agent, 32px outline controls.
- Section labels 11/16px with count. Outer row gutter 8px.
- **Row 76px:** 40px avatar, 8px gap, name 13/20px semibold, preview 12/16px
  secondary, activity 11/16px tertiary. 12px inset at wide size, 8px narrow.
- Selected row surface 3, radius 12px. Hover surface 2. Do not colour every
  row background or add a bright selection border. Selected name stays primary.
- Unread: 20px count badge, solid owning accent + agent ink; true count via label.
  Time at top-right, count below it. Preview truncates, tooltip if needed.
- Live activity uses the relevant 12px outline icon and readable accent text.
  No emoji, no stale “Activity unavailable” when a relative time is available.
- **Selected-agent card 64px total:** horizontal 40px Pip, agent name + one
  model/presence line, chevron. Defaults collapsed. Expansion exposes SOUL /
  memory / skills without permanently consuming 180px of sidebar.
  Native button with `aria-expanded`, controlled region association in the app.
- Footer Settings + hidden-agent restore action, then **32px connector strip**:
  Hermes, Browser, Computer, tiny non-pulsing dot plus text. Provide complete
  accessible health labels. A dot alone is not health state.
- Hide is a local preference. Restore is not delete. No UI change may alter this.

### Message bubbles and assistant turn grouping

- Incoming surface 3, left; outgoing surface 4, right. 18px corners, 6px lower
  tail corner. 12px vertical / 16px horizontal padding (12px narrow).
  Transcript inset 24px wide, 16px narrow; 16px between turns.
- Short bubbles cap at **72%**. A tool-using / structured assistant turn may
  use **86%** at wide size, **96%** narrow. Code/table/diagram can use full width
  with internal horizontal scrolling. Never shrink body type to fit.
- Body 15/22px, primary. Lists use 20px indent and 4px between items. Code
  13/20px on surface 2 with primary text, including inline code. Table headers
  use surface 2 / primary text, never pale blue with white text; borders use
  hairlines. Links use agent accent plus underline.
- Timestamp **11/16px opaque tertiary**, bottom-right. Read ticks 16px agent
  accent; sent versus picked-up use real transport semantics and accessible text.
- Quoted reply: 3px agent bar, surface 2, 8/12px padding, name 12px accent,
  one-line excerpt. A quoted reference is a native link/button when navigable.
- **Exactly ONE bubble per assistant turn.** Within it, in this order:
  1. Collapsed Reasoning disclosure, only when reasoning exists; optional duration.
  2. “N steps” tool disclosure with duration; current running summary when live.
  3. The streamed/final answer.
  4. One timestamp. Actions sit beneath the turn, not over the answer.
- A reasoning-only update changes the existing turn, never creates a new
  “Thinking…” bubble. Before content arrives show one compact named activity
  row (e.g. “Hermes is preparing your answer”), not an empty message with a time.
- Tools are grouped by the actual turn identifier; do not group separate turns
  merely because adjacent sender IDs match. Retry / branch retain boundaries.
- Completed historical tool groups default collapsed. The mockup expands one
  to demonstrate the content. Live group may open automatically once, never
  reopen after the user closes it. Stable keys and scroll anchoring are mandatory.
- Preserve markdown, code, KaTeX, Mermaid, approvals, and reply references.
  Existing safe rendering and redaction contracts are not replaced by a mockup.

### Tool chips and groups

Group summary is a native disclosure with ≥28px hit height. Tool rows 32px,
12/16px text, 16px semantic icon, readable summary, trailing duration 11px
tabular, then 14px state icon. Tool arguments / output live in the disclosure,
not in a row of eight repeated chips.

| State | Display |
| --- | --- |
| Running | Agent-accent progress icon + explicit “Running” or live action label; spinner only if motion allowed |
| Completed | Neutral summary + success check + elapsed time |
| Failed | Danger x + explicit failed summary / retry affordance; do not expose raw secret-bearing error |

Do not infer failure from absent output or from a tool being historical. A status
word or accessible label accompanies every coloured state icon.
Row duration is per tool; group duration is elapsed turn-tool time, not necessarily
the sum when tools ran concurrently.

### Date, system, approval and error pills

Date centred, 24px non-interactive Pill, surface 1, 11/16px text. No timestamp
overlap with sticky dates. System notifications use one compact neutral Pill.
Do not turn all system messages into chat bubbles.
Approval / clarify stays **inside its assistant turn**, 15px question with 32px
buttons Once / Session / Always / Deny. Keyboard focus follows the existing
permission flow. Warning tone is reserved for the approval, not every tool.

### Composer

Surface 1, top hairline, 12/16px outer inset. Native 44px-min multiline field
on surface 3, radius 22px, visible input boundary, 15/22px text.
32–36px emoji inside; 36px menu and paperclip outside left; 36px circular mic
right. Text present swaps mic for outline send on solid agent accent. Active
turn shows outline stop with explicit label, not a second mic.
Grow the field to 160px maximum, then scroll. Retain native textarea semantics.
Focus uses one ring around the whole field, no doubled input ring.

Underneath: centred 11/16px “Local Hermes · profile · model”, 8px separation.
No generic account footer. Empty/offline placeholder gives the correct reason.
Keep drafts, attachments, dictation, reply quote, model selector, and keyboard
send/stop behaviour intact. Styling must not change these contracts.

### Workspace toolbar and status

Header 64px: Workspace / On your Mac 11px label, current lane 13px; Agent tabs
32px ghost Button. Tab strip 40px, selected neutral tab surface 3, outline
favicon substitute 14px, 28px close and new-tab targets. Tab activation must
be a native button or full accessible tablist in the real app.

Navigation 48px surface 3; back/forward/reload 28px, URL 32px on surface 2,
12px lock and 12px text, Ask agent and More. Reader, move lane, give/return
live in More at narrow widths; at wide widths they may use the same primitives.
Shared-login tab always shows the warning Pill and an accessible explanation.

Control ownership is never hidden in tiny text. **44px ownership strip** above
status: eye + “Watching Hermes’s lane” and 28px Take control button.
User-owned: “You’re in control” + Give to agent. Paused: “Paused, you took
control” + Resume agent. Error/off: clear helper and Settings/Retry action.
Real user input still pauses control through the existing bridge, not CSS.

Bottom **32px status bar**, 11/16px: left “On this Mac”; right ready /
connecting / not enabled. Hide only the optional “Isolated lane” suffix narrow.
Bridge/MCP ready is not the same as an agent's session having loaded its tools;
use the current host status wording and expose the restart requirement when true.

Computer preview: 280–360px wide, radius 8px, popover shadow; 40px header,
Take control/Paste/expand 28px; labelled capture freshness and watch-only state.
Do not mislabel a last completed capture as a live frame stream.

### Settings

Local sections: Hermes, Agents, Workspace, Secrets, Computer, Diagnostics,
Appearance. 20/28px title. Navigation 160px in the real page, native buttons
32px, 13px label + 16px outline icon. No Account, Billing, cloud or VPS language.
Main max width 720px with 24px gaps; cards surface 2, radius 8px, 16px inset.
Section title 15px semibold; label 13px; helper 12px or 11px. Labels associated
with native controls. Field height 32px minimum.

Separate connection health, configuration, and destructive actions. Restart /
enable / revoke / clear need the existing confirmation and state handling.
No design primitive may bypass origin approval or expose a secret value.
Logs use readable mono 12–13px and the existing scrubbed output.

### Empty, loading and error

Empty pane: 64px Pip, 15px semibold heading, 12px secondary explanation,
one primary 32px action. Keep the total block under 240px high and use the
space for content, not a giant mascot. First-run can use 96px Pip and 24px title.
Loading: reserved layout and one labelled activity line, not flashing skeletons.
Offline: persistent compact danger surface with readable explanation and
Retry / Diagnostics. Keep cached transcript visible; disable composer truthfully.
File/tab failure: actionable inline error, not a whole-app modal.

### Pip placement and motion budget

| Placement | Size / rule |
| --- | --- |
| Sidebar row | 40px, owning palette, idle/static unless actually active |
| Compact agent card | 40px, presence state |
| Chat identity pill | 28px, static; no separate mascot toolbar button |
| Empty workspace/chat | 64px, idle or waiting |
| First run | 96px maximum |
| Expanded AgentInfo | 64–80px; not a permanent sidebar hero |

Reuse `src/lib/mascot/Mascot.tsx`, `character="owl"` and its palette registry.
If the integration branch supplies an `AgentMascot` adapter, retain that adapter
and its presence mapping rather than duplicating it; this worktree's mockup
uses the underlying rig directly.
Default decorative `aria-hidden` beside visible agent name. Only label it when
the illustration independently conveys meaning. One active animated mascot
per visible agent at most; sidebar copies stay still. Pass reduced motion.
No character asset, rig, or engine edits belong to this design handoff.

## 5. Apply per file

### Chat worker

1. `src/App.tsx`: import `desk-tokens.css` once, add `desk-theme` to local shell.
   Keep responsive pane state and native workspace bounds intact.
2. `src/components/TopBar.tsx`: centred identity pill, sidebar toggle, bell, panel only.
   Move secondary actions into existing menus without removing capability.
3. `src/components/ChatPanel.tsx` and `src/components/chat/**`: build one stable
   view-model per assistant turn. Keep
   reasoning/tools/answer together, no empty intermediate bubbles. Preserve
   drafts, attachment flow, permission responses, scrolling, and interruption.
4. `src/components/MessageBody.tsx`: apply typography and surface tokens, native
   disclosures, 32px tool rows, opaque metadata; keep safe markdown renderers.
5. `src/components/MessageActions.tsx`: reply/copy/more below the turn, consistent icons.
6. `src/components/ThreadPane.tsx`: same typography, turn boundaries and actions
   as the primary transcript, no independently styled bubble family.
7. `src/styles/skin-messenger.css`: replace literals with tokens and remove old
   round filled attachment, mismatched glyph, and tiny low-opacity timestamp rules.

### Host worker

1. `src/components/Sidebar.tsx`: use ListRow, Badge, IconButton; preserve roster
   state/unread and honest all-source activity. Apply 76px rows and the footer strip.
2. `src/components/AgentCard.tsx`: horizontal default 64px, expandable; use Pip
   at specified sizes with the current presence map. Expanded details belong in
   the controlled region, not a permanently tall card.
3. `src/components/AgentInfo.tsx` / `AgentPersonaPanel.tsx`: Section, Button,
   consistent icons and 64–80px Pip; preserve editing and permission logic.
4. `src/components/SettingsStub.tsx`, `src/components/settings/**`, and
   `src/components/settings/local/common.tsx`: adopt Section, Button and token-backed
   form classes. Respect all existing save/confirm logic.
5. `src/components/BootOrbSplash.tsx`, Onboarding and EmptyState: restrained
   64px empty / 96px first-run Pip and one primary action, truthful offline state.
6. `src/components/FilesPanel.tsx`: Folder/File/Image icons, token-backed rows,
   readable error + retry; preserve allowed-root checks and default-root behaviour.
7. `src/styles/skin-messenger-sidebar.css`: host/coordinator applies the sidebar
   token rules without changing the chat worker's stylesheet.

### Workspace handoff

Route these changes to the current file owner through the coordinator. The
wave-6 host brief owns sidebar/settings, not these workspace files. This is
design guidance, not permission to cross another worker's boundary.

1. `src/components/workspace/WorkspacePane.tsx`: aligned 64px header, sane 352px minimum, responsive
   overflow menu; continue sending measured native view bounds on resize.
2. `src/components/workspace/WorkspaceTabs.tsx` / `AgentTabsPopover.tsx`: consistent outline semantics,
   28px actions, selected neutral tab, shared-login warning, accessible control.
3. `src/components/workspace/WorkspaceNav.tsx`: Toolbar + IconButton, labelled field, control grouping.
   Preserve URL parsing/security in main; More may hold secondary callbacks.
4. `src/components/workspace/WorkspaceStatusBar.tsx`: split prominent ownership + 32px connector status,
   truthful status wording and Take/Resume action. Do not fake bridge readiness.
5. `src/components/workspace/GiveToAgentDialog.tsx`: Section, Button, associated native fields and existing
   modal focus/consent handling. No automatic grant of control or copied login.
6. `src/components/ComputerPip.tsx`: outline icon header, consistent hit targets, capture
   freshness; browser ownership does not imply permission for OS control.
7. `src/components/ConnectorStrip.tsx`: calm footer labels + full accessible health wording.
8. `src/styles/workspace.css` / `src/styles/pip.css`: replace literal colours, radii, spacing, glyphs;
   no changes to main-process security, IPC, or real browser state for appearance.

## 6. Mockups and validation

Committed reference images:

- `design-mockups/hermes-desk-1440x900.png`
- `design-mockups/hermes-desk-1024x700.png`
- `design-mockups/hermes-desk-surfaces.png`

`tools/design/mockups.html` imports the real tokens, icons, all nine primitives,
and the real Pip rig. The embedded Fieldnotes page is invented local fixture
content, not a screenshot of a remote service. UI state is illustrative, not a
claim about the owner's current agents. Manual clock freezes mascot rendering.

```sh
npx vitest run --project unit src/styles/desk-tokens.test.ts src/components/ui/icons.test.tsx src/components/ui/primitives.test.tsx
npx tsc -p tsconfig.app.json --noEmit
node tools/design/render.mjs
# Only after inspecting the renders:
node tools/design/render.mjs --promote
```

Renderer binds loopback only, launches Chromium **headless**, rejects remote
asset requests, checks target sizes / labels / horizontal overflow, exercises
toolbar keys and hover-only tooltip Escape, and closes server and browser on
completion. 2× PNGs and a manifest go to ignored
`tools/design/out/`; close-ups cover sidebar, chat/header, tools, composer,
workspace/status, settings, computer preview, states, and primitives.
`--promote` copies only the three named references into the documentation.
