/**
 * Phase 2 lightweight router — state ↔ URL sync, no dependency.
 *
 * Hash-query model (`#/c/<convId>?settings=1&tools=cron&preview=<path>`):
 * every open panel is a flag, so a shared URL restores the full layout and
 * a reload is lossless. Works on `file://` (Electron), the hosted web build,
 * and `vite dev` — hash never hits the server, so no rewrite config needed
 * beyond the existing SPA fallback.
 *
 * Covered surfaces (WEBAPP_PLAN Phase 2): Settings / Kanban / MCP /
 * Hermes-Tools (+tab) / Files / Preview (path) / Info / Routines page /
 * Home page / agent / conversation. Transient UI (palette, editors, modals, toasts) is
 * deliberately NOT routed — deep-linking a half-filled form is a bug, not
 * a feature.
 *
 * Pure functions (parse/serialize) are DOM-free and unit-tested. The single
 * DOM touchpoint is `readHash()` / `writeHash()`; App.tsx owns the sync
 * effect with a last-written guard so back/forward never loops.
 */

import { isSettingsPaneRequest, type SettingsPaneRequest } from './open-settings'

export type ToolsTab = 'skills' | 'cron' | 'memory' | 'usage'

export interface RouteState {
  conversationId: string | null
  agentId: string | null
  settings: boolean
  /**
   * Which Settings pane is open (`?settings=1&pane=<id>`). Only the ids in
   * `open-settings.ts` are accepted. Null keeps General.
   */
  settingsPane: SettingsPaneRequest | null
  kanban: boolean
  mcp: boolean
  toolsTab: ToolsTab | null
  files: boolean
  previewPath: string | null
  info: boolean
  /** The Routines page (`#/routines`) replaces the chat in the main pane. */
  routines: boolean
  /** The Home page (`#/home`) replaces the whole shell: mascot + recent activity. */
  home: boolean
  /** Searchable chat archive; the retained chat rides as ?c=. */
  chats: boolean
  /** CONTRACT: legacy shell field, always null in the local app. */
  inviteCode: string | null
}

export const EMPTY_ROUTE: RouteState = {
  conversationId: null,
  agentId: null,
  settings: false,
  settingsPane: null,
  kanban: false,
  mcp: false,
  toolsTab: null,
  files: false,
  previewPath: null,
  info: false,
  routines: false,
  home: false,
  chats: false,
  inviteCode: null,
}

const TOOLS_TABS: ReadonlySet<string> = new Set(['skills', 'cron', 'memory', 'usage'])

function isToolsTab(v: string | null): v is ToolsTab {
  return v !== null && TOOLS_TABS.has(v)
}

/**
 * Parse a location.hash (`#/...` or empty) into a RouteState. Never throws —
 * malformed input yields EMPTY_ROUTE fields (fail-closed to chat).
 */
export function parseHash(hash: string): RouteState {
  const out: RouteState = { ...EMPTY_ROUTE }
  if (typeof hash !== 'string' || !hash.startsWith('#')) return out
  const rest = hash.slice(1) // strip '#'
  const q = rest.indexOf('?')
  const path = q === -1 ? rest : rest.slice(0, q)
  const query = q === -1 ? '' : rest.slice(q + 1)

  // Path carries the conversation and/or agent identity:
  //   #/c/<convId>  #/agent/<agentId>  #/  (chat)
  const segs = path.split('/').filter(Boolean)
  if (segs[0] === 'invite') return out
  if (segs[0] === 'c' && typeof segs[1] === 'string' && segs[1]) {
    out.conversationId = decodeURIComponentSafe(segs[1])
  } else if (segs[0] === 'agent' && typeof segs[1] === 'string' && segs[1]) {
    out.agentId = decodeURIComponentSafe(segs[1])
  } else if (segs[0] === 'routines') {
    // Main-pane page: the open thread (if any) rides as `?c=` below.
    out.routines = true
  } else if (segs[0] === 'home') {
    // Launch page: the thread underneath rides as `?c=` like Routines.
    out.home = true
  } else if (segs[0] === 'chats') {
    out.chats = true
  }

  if (!query) return out
  const params = new URLSearchParams(query)
  if (params.get('settings') === '1') out.settings = true
  const pane = params.get('pane')
  if (isSettingsPaneRequest(pane)) {
    out.settingsPane = pane
    out.settings = true
  }
  if (params.get('kanban') === '1') out.kanban = true
  if (params.get('mcp') === '1') out.mcp = true
  const tools = params.get('tools')
  if (isToolsTab(tools)) out.toolsTab = tools
  if (params.get('files') === '1') out.files = true
  const preview = params.get('preview')
  // Non-empty only: `?preview=` / `?preview=%20` fail closed to no-preview.
  if (preview !== null && preview.trim() !== '') out.previewPath = preview
  if (params.get('info') === '1') out.info = true
  // Unknown query params are ignored (fail-closed to chat). This keeps
  // parse/serialize extensible: new deep-link params (e.g. a future invite
  // code) add a get/set pair here without touching the path logic below.
  // Unknown query params (e.g. legacy ?computer=1 links from the removed
  // Page surface) are ignored — fail-closed to chat.
  // agent/conversation may also ride as query (written by serializeRoute
  // when the path slot is taken by the other) — path wins on conflict.
  if (!out.agentId) {
    const a = params.get('agent')
    if (a) out.agentId = a
  }
  if (!out.conversationId) {
    const c = params.get('c')
    if (c) out.conversationId = c
  }
  return out
}

/**
 * Serialize a RouteState to a hash (`''` for the bare chat route so the URL
 * stays clean when nothing is open — the router writes `location.hash = ''`
 * which drops the `#` entirely).
 */
export function serializeRoute(route: RouteState): string {
  const params = new URLSearchParams()
  if (route.settings) params.set('settings', '1')
  if (route.settings && route.settingsPane) params.set('pane', route.settingsPane)
  if (route.kanban) params.set('kanban', '1')
  if (route.mcp) params.set('mcp', '1')
  if (route.toolsTab) params.set('tools', route.toolsTab)
  if (route.files) params.set('files', '1')
  if (route.previewPath && route.previewPath.trim() !== '') params.set('preview', route.previewPath)
  if (route.info) params.set('info', '1')

  let path = '/'
  const extras: string[] = []
  if (route.routines || route.home || route.chats) {
    // The page owns the path; the thread underneath rides as query so
    // closing the page (back / Esc) lands on the same conversation.
    path = route.home ? '/home' : route.chats ? '/chats' : '/routines'
    if (route.conversationId) extras.push(`c=${encodeURIComponent(route.conversationId)}`)
    else if (route.agentId) extras.push(`agent=${encodeURIComponent(route.agentId)}`)
  } else if (route.conversationId) {
    path = `/c/${encodeURIComponent(route.conversationId)}`
    if (route.agentId) extras.push(`agent=${encodeURIComponent(route.agentId)}`)
  } else if (route.agentId) {
    path = `/agent/${encodeURIComponent(route.agentId)}`
  }
  const base = params.toString()
  const extra = extras.join('&')
  const query = [base, extra].filter(Boolean).join('&')
  if (path === '/' && !query) return ''
  return `#${path}${query ? `?${query}` : ''}`
}

/** True when the route opens nothing — the bare chat surface. */
export function isEmptyRoute(route: RouteState): boolean {
  return serializeRoute(route) === ''
}

/** Opening a surface (or choosing another routed tab/file) pushes history.
 *  Closing surfaces and switching only the conversation replace it. */
export function shouldPushRoute(previous: RouteState, next: RouteState): boolean {
  const flags = ['settings', 'kanban', 'mcp', 'files', 'info', 'routines', 'home', 'chats'] as const
  return flags.some((key) => next[key] && !previous[key]) ||
    (next.settings && previous.settings && next.settingsPane !== previous.settingsPane) ||
    (next.toolsTab !== null && next.toolsTab !== previous.toolsTab) ||
    (next.previewPath !== null && next.previewPath !== previous.previewPath)
}

export interface ResolveRouteContext {
  conversations: Array<{
    id: string
    hiddenFromSidebar?: boolean
    placeholder?: boolean
  }>
  agents: Array<{ id: string }>
}

/**
 * Fail-closed resolution of a parsed deep link against live roster data.
 * Unknown conversation/agent ids, hidden rows, and placeholder threads all
 * resolve to null (never create, never select). Callers write the returned
 * route back to the URL (canonical write-back) so a dead link does not
 * re-trigger on reload, and toast to explain the fallback.
 */
export function resolveRoute(route: RouteState, ctx: ResolveRouteContext): RouteState {
  const out: RouteState = { ...route }
  if (out.conversationId) {
    const conv = ctx.conversations.find((c) => c.id === out.conversationId)
    if (!conv || conv.hiddenFromSidebar || conv.placeholder) out.conversationId = null
  }
  if (out.agentId) {
    if (!ctx.agents.some((a) => a.id === out.agentId)) out.agentId = null
  }
  if (out.previewPath !== null && out.previewPath.trim() === '') out.previewPath = null
  return out
}

/**
 * The hash a fresh launch should land on. A bare launch (no deep link) opens
 * Home when the preference allows it; every deep link is kept untouched.
 */
export function launchHash(hash: string, homeOnLaunch: boolean): string {
  if (!isEmptyRoute(parseHash(hash))) return hash
  return homeOnLaunch ? '#/home' : hash
}

/** Read the live hash (DOM touchpoint — keep out of unit tests). */
export function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

/**
 * Write the hash without growing history when nothing changed, and without
 * leaving a stale `#` when the route is empty. Uses `replaceState` when the
 * only difference is panel state churn is NOT wanted... — senior call:
 * panel opens are user navigation, so they PUSH (back closes the panel);
 * returning to the empty route REPLACEs (back from chat must not reopen a
 * panel the user just closed). Callers pass `push = hasPanels`.
 */
export function writeHash(hash: string, push: boolean): void {
  if (typeof window === 'undefined') return
  if ((window.location.hash || '') === hash) return
  // `location.hash =` drops everything after `&` in some navigations, so a
  // tab change (`?settings=1&pane=keys`) rewrote the URL back to the previous
  // pane. pushState/replaceState keep the fragment intact. Callers that need
  // the hashchange listener also listen for popstate (the back button).
  const next = window.location.pathname + window.location.search + hash
  if (push && hash) window.history.pushState(null, '', next)
  else window.history.replaceState(null, '', next)
}

function decodeURIComponentSafe(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}
