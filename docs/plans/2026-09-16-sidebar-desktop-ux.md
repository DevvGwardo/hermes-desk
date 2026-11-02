# Sidebar + desktop UX fixes — spec

Date: 2026-09-16. Status: planned, no code changed yet.
Origin: read-only review of the sidebar (shared by web + Electron) and the
Electron main process. All 41 existing sidebar tests pass; findings below are
source-confirmed with the caveat that packaged-app behavior still needs
runtime verification.

## 1. Goal

Fix the interaction-safety and navigation gaps found in the review, in priority
order, without a visual redesign:

1. Delete confirmation cannot be triggered by Enter while Cancel is focused;
   all menus and dialogs get sane keyboard + focus behavior.
2. The main window can always be reopened (Dock click, second launch, tray)
   even when only the HUD orb window remains.
3. Startup/renderer failures offer in-app recovery instead of only console logs.
4. The main window restores its previous geometry.
5. App-selected theme drives native window background (no OS/app mismatch).
6. Sidebar: a visible "Start conversation" affordance, honest compact mode,
   and small correctness fixes (section count, hidden-chats discoverability,
   group unread badge geometry).

## 2. Non-goals

- No visual redesign of the sidebar (colors, spacing, typography stay).
- No change to the orb/HUD walk/act engine.
- No new features beyond the six goals (no icon-rail redesign in this pass).
- No release/version bump; rides the next unreleased build per repo convention.

## 3. Verified current state

- `src/components/Sidebar.tsx:1145-1191` — delete confirm dialog:
  container `onKeyDown` treats ANY Enter as confirm (calls
  `onDeleteConversation`), and Cancel has `autoFocus`. So keyboard focus on
  Cancel + Enter deletes. Mouse-cancel is covered by
  `src/components/__tests__/sidebar-delete.test.tsx:108-118`; keyboard path is not.
- Context menu (`Sidebar.tsx:1053-1097`) has `role="menu"`/`menuitem` but no
  initial focus, no arrow-key navigation; pointerdown-outside + Escape work.
- Hidden-chats + delete dialogs are portals with no focus trap; focus returns
  to nobody on close; invoking control is not marked `aria-current` anywhere.
- `Sidebar.tsx:953` — section count chip shows `conversations.length` (all,
  pinned included) while the section body lists only `rest` (unpinned).
- `Sidebar.tsx:216` — "+ New" action is hover-revealed on the Conversations
  section header; `NewChatBar` picking an existing agent opens its existing
  conversation (`useAgentRuntime.ts:713-731`), it never starts a "new" thread.
- Compact mode: `toggleCompactSidebarWidth` (Sidebar.tsx:86-93) collapses
  240 → 180 px (min 180, max 480); no visible toggle control; width persists
  via `maia:sidebarWidth`. On a 800px-wide browser window a saved 480px
  sidebar leaves 320px of content (desktop shell design min is 960,
  `src/lib/platform.ts:16-19`).
- Group rows: unread badge is `absolute -top-1 -right-1` (Sidebar.tsx:367-374)
  but the group wrapper `span` at `:421` lacks `relative`, so the badge anchors
  to the nearest positioned ancestor instead of the avatar cluster.
- `electron/main.cjs:2183-2192` — `second-instance` handler returns early when
  `mainWindow` is gone; `:2264-2266` — `activate` recreates only when
  `BrowserWindow.getAllWindows().length === 0`, so a living HUD orb window
  blocks main-window re-creation on macOS dock click.
- `electron/main.cjs:721-740` — 4s force-show timeout; `unresponsive`,
  `render-process-gone`, `did-fail-load` only console.error.
- `electron/main.cjs:699-716` — main window is hard-coded 1280x800, no
  geometry persistence (contrast: HUD state via `electron/hud-state.cjs`).
- `electron/main.cjs:788-799` — `resolveAppBackground()` keys off
  `nativeTheme.shouldUseDarkColors` (OS), while the renderer stores the
  app-selected theme in localStorage (`maia:theme`, `src/lib/theme.ts:77-86`)
  — main cannot read it pre-load; STATE.md flags this as a known follow-up.
