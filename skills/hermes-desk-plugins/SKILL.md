---
name: hermes-desk-plugins
description: Extend the Hermes Desk Mac app itself with a desktop plugin (pages, sidebar links, title-bar and status widgets, ⌘K commands, keyboard shortcuts, colour themes). Use this, not hermes-desktop-plugins, when the user is in Hermes Desk.
version: 1.0.0
platforms: [darwin]
triggers:
  - hermes desk plugin
  - add to hermes desk
  - change the app
  - improve the app
  - add a page to the app
  - add a button to the app
  - desktop plugin
metadata:
  hermes:
    tags: [desktop, plugins, ui, self-extension, hermes-desk]
    category: desktop-ui
    related_skills: [genui]
---

# Hermes Desk plugins

Hermes Desk can grow new features without a rebuild: you write one plain
JavaScript file, the app sees it within seconds, and the user reviews and
trusts it. Use this when the user asks Hermes Desk to gain a page, a button, a
shortcut, a command or a theme.

This SDK is smaller than the upstream Hermes desktop app's. Do not use exports
from the `hermes-desktop-plugins` skill that are not listed here; a missing
import stops the plugin from loading.

## Where the file goes

`~/.hermes/desktop-plugins/<id>/plugin.js`, where the folder name equals the
plugin `id` (lowercase, `a-z0-9-`). One file per plugin. Write it with your
file tools. Do not write anywhere else in `~/.hermes`.

## What happens next (tell the user)

1. The plugin appears in **Settings → Plugins** as "waiting for your trust". It
   does not run yet.
2. The user clicks **Review code**, reads it, then **Trust this version**. A
   native macOS dialog confirms. Only then does it run.
3. If you edit the file later, it stops running until the user reviews the
   changes (shown as a diff) and trusts again, or clicks **Restore trusted
   version**. Earlier trusted versions can be rolled back.

So: after writing, say what the plugin does, that it is waiting in
Settings → Plugins (⌘K → "Desktop plugins"), and that they should review it
before trusting it. Never tell the user to skip review.

## File shape

The file is loaded uncompiled: no JSX, no TypeScript. Build elements with
`jsx` from `react/jsx-runtime`. The only imports that resolve are
`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.

```js
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'
import { host, Button, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA } from '@hermes/plugin-sdk'

function Page() {
  const [count, setCount] = useState(0)
  return jsxs('div', { className: 'space-y-3', children: [
    jsx('p', { className: 'text-[13px] text-[var(--ca-ink-soft)]', children: `Clicked ${count} times` }),
    jsx(Button, { onClick: () => setCount(count + 1), children: 'Click' }),
  ] })
}

export default {
  id: 'counter',
  name: 'Counter',
  description: 'A tiny example page.',
  register(ctx) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/counter', title: 'Counter' }, render: () => jsx(Page, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { label: 'Counter', path: '/counter' } })
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: 'open', label: 'Open counter', run: () => host.navigate('/counter') } })
  },
}
```

A starter with every area is in `templates/plugin.js` next to this file.

## Areas Hermes Desk shows

| Area constant | Contribution | Where it appears |
| --- | --- | --- |
| `ROUTES_AREA` | `data: { path, title }`, `render` | A full page in the main pane, opened with `host.navigate(path)`, from ⌘K ("Open <title>"), or a sidebar link |
| `SIDEBAR_NAV_AREA` | `data: { label, path }` (path of one of your routes) | Beside Home / Chats / Routines; the first two plugin links show |
| `PALETTE_AREA` | `data: { id, label, keywords?, detail?, run }` | ⌘K command palette |
| `KEYBINDS_AREA` | `data: { keys, label?, run }` | Global shortcut. `keys` must be `mod+shift+<key>` or `mod+alt+<key>`; anything else is ignored so app shortcuts and typing are never taken over |
| `TITLEBAR_AREAS.left` / `.right` | `render` | Small controls in the chat title bar |
| `STATUSBAR_AREAS.left` / `.right` | `render` | A small row in the sidebar footer |
| `THEMES_AREA` | `data: { id, label, tokens, dark? }` | ⌘K "Theme: <label>"; tokens are `--ca-*` / `--desk-*` colour variables only (no `url()`) |
| `PANES_AREA` | `title`, `render` | Settings → Plugins, under "Plugin panes" |
| `COMPOSER_AREAS.middleware` | `data: { handler(draft) → draft }` | Rewrites the message text before it is sent |

Every `render` runs behind its own error boundary: if it throws, Hermes Desk
unloads the plugin and shows the error in Settings → Plugins.

## SDK exports you can use

- `host.navigate(path)`, `host.notify({ kind: 'info'|'success'|'error', title?, message })`,
  `host.notifyError(err, title?)`, `host.newChat(profile?)`, `host.openExternal(url)`.
- `host.request(method, params)`: Hermes JSON-RPC over the app's live
  connection (for example `session.list`). Handle rejections; it fails when
  Hermes is offline.
- `host.state.profile|activeSessionId|cwd|model|viewport|gateway`: atoms. Read
  with `.get()` in handlers, `useValue(atom)` in components.
- `atom`, `useValue`, `useQuery`, `queryClient` for plugin state and data.
- `ctx.storage.get(key)` / `set(key, value)` / `delete(key)`: async, namespaced.
- UI: `Button`, `Input`, `Textarea`, `Checkbox`, `Switch`, `Select` (+ `SelectItem`),
  `SearchField`, `ScrollArea`, `EmptyState`, `GlyphSpinner`, `Tip`, `Dialog`
  (+ `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`,
  `DialogFooter`), `ConfirmDialog`, `ContextMenu*`, `Codicon`, `cn`,
  `relativeTime`, `profileColor`.

Not available here: `host.onEvent`, `useMutation`, `Tabs`, `SegmentedControl`,
`Badge`, `ctx.rest`, `ctx.socket`, `Contribute`, `TITLEBAR_AREAS.center`, `--ui-*` variables.

## Style

Use Tailwind classes with the app's tokens, never hard-coded colours:
`text-[var(--ca-ink)]`, `text-[var(--ca-ink-soft)]` (secondary),
`border-[var(--ca-border)]`, `bg-[var(--ca-card)]`, `bg-[var(--ca-canvas)]`.
Body text 13px, small text 11–12px. Give icon-only buttons an `aria-label`.

## Rules

- Do only what the user asked. A plugin runs with the full authority of the
  app, so never read secrets, send data to the network, or touch files
  outside what the feature needs, and say plainly what the plugin does.
- No timers faster than every few seconds; clean up intervals and listeners
  in `useEffect` returns.
- Reference only identifiers you imported; check every name in your `jsx()`
  calls against the import line.
- Keep an existing plugin's `id` when editing it, so its trust history and
  rollback stay attached.

## Verify

Ask the user to open Settings → Plugins. A load failure shows there with the
error (for example an unsupported import); fix the file and they review again.
