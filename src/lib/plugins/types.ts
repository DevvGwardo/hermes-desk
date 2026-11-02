/**
 * Shared plugin-host type contracts — dependency-free so the loader, SDK shim,
 * and UI all import from one place.
 */
import type { ReactNode } from 'react'

/** The shape a loaded plugin.js default export must satisfy. */
export interface HermesPlugin {
  id: string
  name?: string
  description?: string
  /** Opt-in posture; false = inventory row, off until the user toggles. */
  defaultEnabled?: boolean
  register(ctx: PluginContext): void
}

/** Plugin-scoped persistence (the VS Code globalState analog). */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined> | T | undefined
  set<T = unknown>(key: string, value: T): Promise<void> | void
  delete(key: string): Promise<void> | void
}

/** Minimal i18n surface — hermes-bots never calls it; keep a no-op shape. */
export interface PluginI18n {
  register?(bundles: unknown): void
}

/** What `register(ctx)` receives. */
export interface PluginContext {
  readonly id: string
  register(contribution: PluginContribution): void
  storage?: PluginStorage
  i18n?: PluginI18n
}

// -- areas -------------------------------------------------------------------

export const PANES_AREA = 'panes'
export const PALETTE_AREA = 'hermes.palette'
export const COMPOSER_AREAS = {
  middleware: 'composer.middleware',
  attachments: 'composer.attachments',
} as const
export const KEYBINDS_AREA = 'keybinds'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' } as const
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' } as const
export const THEMES_AREA = 'themes'

export interface PaneContribution {
  id: string
  area: typeof PANES_AREA
  title: string
  data: {
    placement: 'left' | 'right' | 'main'
    width?: string
    dock?: { pane: string; pos: 'left' | 'right' }
  }
  render: () => ReactNode
}

export interface PaletteContribution {
  id: string
  area: typeof PALETTE_AREA
  data: {
    id: string
    label: string
    keywords?: string[]
    detail?: string
    run: () => void
  }
}

export interface ComposerDraft {
  text: string
}

export type ComposerMiddleware = (draft: ComposerDraft) => Promise<ComposerDraft> | ComposerDraft

export interface ComposerMiddlewareContribution {
  id: string
  area: typeof COMPOSER_AREAS['middleware']
  data: { handler: ComposerMiddleware }
}

/** `keys` is `mod+shift+<key>` or `mod+alt+<key>`; plain shortcuts stay the app's. */
export interface KeybindContribution {
  id: string
  area: typeof KEYBINDS_AREA
  data: { keys: string; label?: string; run: () => void }
}

/** A full page in the main pane, opened with `host.navigate(path)`. */
export interface RouteContribution {
  id: string
  area: typeof ROUTES_AREA
  data: { path: string; title: string }
  render: () => ReactNode
}

/** A sidebar link to a plugin route. */
export interface SidebarNavContribution {
  id: string
  area: typeof SIDEBAR_NAV_AREA
  data: { label: string; path: string }
}

/** Small inline UI in the title bar or the sidebar status row. */
export interface SlotContribution {
  id: string
  area: (typeof TITLEBAR_AREAS)[keyof typeof TITLEBAR_AREAS] | (typeof STATUSBAR_AREAS)[keyof typeof STATUSBAR_AREAS]
  render: () => ReactNode
}

/** `--ca-*` colour token overrides, picked from the command palette. */
export interface ThemeContribution {
  id: string
  area: typeof THEMES_AREA
  data: { id: string; label: string; tokens: Record<string, string>; dark?: Record<string, string> }
}

/** Unknown areas are tolerated so newer plugins still load. */
export interface NoopContribution {
  id: string
  area: string
  data?: unknown
  render?: () => ReactNode
}

export type PluginContribution =
  | PaneContribution
  | PaletteContribution
  | ComposerMiddlewareContribution
  | KeybindContribution
  | RouteContribution
  | SidebarNavContribution
  | SlotContribution
  | ThemeContribution
  | NoopContribution

/** Plugin inventory row (loader publishes; settings UI consumes). */
export type PluginStatus = 'loading' | 'loaded' | 'disabled' | 'error'

export interface PluginInventoryEntry {
  id: string
  name: string
  description?: string
  kind: 'disk' | 'agent-plugin'
  file?: string
  status: PluginStatus
  error?: string
}

// -- host --------------------------------------------------------------------

export interface HostNotifyInput {
  kind?: 'info' | 'success' | 'error'
  title?: string
  message?: string
}

export interface HostStateAtom<T> {
  get(): T
  listen(cb: (value: T) => void): () => void
  subscribe(cb: (value: T) => void): () => void
}

export interface HermesHost {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  notify(input: HostNotifyInput): void
  notifyError(err: unknown, title?: string): void
  newChat(profile?: string | null): void
  openSession(storedSessionId: string, options?: { profile?: string | null }): Promise<void>
  openExternal(url: string): void
  navigate(path: string): void
  getGateway(): unknown | null
  warmProfile(profile: string): void
  activeSessionId: HostStateAtom<string | null> & { get(): string | null }
  state: {
    profile: HostStateAtom<string>
    gateway: HostStateAtom<string>
    activeSessionId: HostStateAtom<string | null>
    cwd: HostStateAtom<string>
    model: HostStateAtom<string>
    viewport: HostStateAtom<{ width: number; height: number; narrow: boolean }>
  }
}
