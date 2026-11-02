// Hermes Desk plugin starter. Rename the id, delete the areas you don't need,
// and save as ~/.hermes/desktop-plugins/<id>/plugin.js.
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'
import {
  host,
  useValue,
  Button,
  EmptyState,
  KEYBINDS_AREA,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  THEMES_AREA,
  TITLEBAR_AREAS,
} from '@hermes/plugin-sdk'

const PATH = '/starter'

function StarterPage() {
  const profile = useValue(host.state.profile)
  const [sessions, setSessions] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    host.request('session.list', { profile, limit: 5 })
      .then((result) => { if (live) setSessions(Array.isArray(result?.sessions) ? result.sessions : []) })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [profile])

  if (error) return jsx(EmptyState, { title: "Couldn't load chats", description: error })
  if (!sessions) return jsx('p', { className: 'text-[13px] text-[var(--ca-ink-soft)]', children: 'Loading…' })
  return jsxs('div', { className: 'space-y-2', children: [
    jsx('p', { className: 'text-[13px] text-[var(--ca-ink-soft)]', children: `Recent chats for ${profile || 'this profile'}` }),
    jsx('ul', { className: 'space-y-1', children: sessions.map((session) => jsx('li', {
      className: 'rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-[13px] text-[var(--ca-ink)]',
      children: session.title || session.id,
    }, session.id)) }),
    jsx(Button, { onClick: () => host.notify({ kind: 'success', message: 'Hello from the starter plugin' }), children: 'Say hello' }),
  ] })
}

export default {
  id: 'starter',
  name: 'Starter',
  description: 'Shows recent chats on its own page.',
  register(ctx) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: PATH, title: 'Starter' }, render: () => jsx(StarterPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { label: 'Starter', path: PATH } })
    ctx.register({ id: 'open', area: PALETTE_AREA, data: { id: 'open', label: 'Open starter page', run: () => host.navigate(PATH) } })
    ctx.register({ id: 'key', area: KEYBINDS_AREA, data: { keys: 'mod+shift+y', label: 'Open starter page', run: () => host.navigate(PATH) } })
    ctx.register({ id: 'status', area: STATUSBAR_AREAS.right, render: () => jsx('span', { children: 'Starter on' }) })
    ctx.register({ id: 'title', area: TITLEBAR_AREAS.right, render: () => jsx('button', {
      type: 'button', 'aria-label': 'Open starter page', className: 'rounded-full px-2 text-[12px] text-[var(--ca-ink-soft)]',
      onClick: () => host.navigate(PATH), children: 'Starter',
    }) })
    ctx.register({ id: 'theme', area: THEMES_AREA, data: { id: 'starter-ocean', label: 'Ocean',
      tokens: { '--ca-primary': '#0f6fb8' }, dark: { '--ca-primary': '#5fb4f0' } } })
  },
}
