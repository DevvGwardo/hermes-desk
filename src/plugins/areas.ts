/**
 * Contribution registry — area ids + an in-memory Map<areaId, Contribution[]>.
 *
 * The plugin's disposer filters out all contributions whose namespaced id
 * matches on unload (each plugin contributes with `<pluginId>:<localId>` ids,
 * so a plugin can never clobber another's registrations).
 */
import type {
  ComposerDraft,
  ComposerMiddlewareContribution,
  PaletteContribution,
  PaneContribution,
  PluginContribution,
  PluginInventoryEntry,
} from '../lib/plugins/types'
import { COMPOSER_AREAS, PALETTE_AREA, PANES_AREA } from '../lib/plugins/types'
import { logger } from '../lib/logger'

export type { PluginContribution }
export {
  COMPOSER_AREAS,
  KEYBINDS_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  THEMES_AREA,
  TITLEBAR_AREAS,
} from '../lib/plugins/types'

type AnyContribution = PluginContribution

const registry = new Map<string, AnyContribution[]>()
const listeners = new Set<() => void>()
const areaListeners = new Map<string, Set<() => void>>()
const EMPTY_CONTRIBUTIONS: readonly AnyContribution[] = Object.freeze([])
/** Monotonic version — bumped on every registry mutation so
 *  useSyncExternalStore(getSnapshot = () => version) re-renders. */
let version = 0

function notify(areas: Iterable<string>): void {
  version += 1
  const callbacks = new Set(listeners)
  for (const area of areas) for (const cb of areaListeners.get(area) ?? []) callbacks.add(cb)
  for (const cb of callbacks) {
    try {
      cb()
    } catch {
      /* isolated listener */
    }
  }
}

/** Register one contribution; returns a disposer that removes exactly it. */
export function registerContribution(c: AnyContribution): () => void {
  const list = registry.get(c.area) ?? []
  registry.set(c.area, [...list, c])
  notify([c.area])
  return () => {
    const current = registry.get(c.area)
    if (!current?.includes(c)) return
    const next = current.filter((x) => x !== c)
    if (next.length === 0) registry.delete(c.area)
    else registry.set(c.area, next)
    notify([c.area])
  }
}

/** Dispose every contribution whose namespaced id starts with `pluginId:`. */
export function disposePluginContributions(pluginId: string): void {
  const changed = new Set<string>()
  for (const [area, list] of registry) {
    const next = list.filter((c) => !c.id.startsWith(`${pluginId}:`))
    if (next.length === list.length) continue
    changed.add(area)
    if (next.length === 0) registry.delete(area)
    else registry.set(area, next)
  }
  if (changed.size) notify(changed)
}

/** Stable until this area changes; prior snapshots are never mutated. */
export function registrySnapshot(area: string): readonly AnyContribution[] {
  return registry.get(area) ?? EMPTY_CONTRIBUTIONS
}

export function subscribeRegistryArea(area: string, callback: () => void): () => void {
  let subscribers = areaListeners.get(area)
  if (!subscribers) { subscribers = new Set(); areaListeners.set(area, subscribers) }
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size && areaListeners.get(area) === subscribers) areaListeners.delete(area)
  }
}

export function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Registry version for useSyncExternalStore — changes on every mutation. */
export function registryVersion(): number {
  return version
}

/** Panes, grouped by side. */
export function panesBySide(side: 'left' | 'right'): PaneContribution[] {
  const panes = (registry.get(PANES_AREA) ?? []) as PaneContribution[]
  return panes.filter((p) => p.data.placement === side || p.data.placement === 'main')
}

/** ALL registered panes (settings surface renders these, not the chat). */
export function allPanes(): PaneContribution[] {
  return (registry.get(PANES_AREA) ?? []) as PaneContribution[]
}

export function paletteContributions(): PaletteContribution[] {
  return (registry.get(PALETTE_AREA) ?? []) as PaletteContribution[]
}

/** The plugin that owns a namespaced contribution id (`<pluginId>:<localId>`). */
export function contributionOwner(id: string): string {
  let owner = ''
  for (const entry of inventory.keys()) {
    if (id.startsWith(`${entry}:`) && entry.length > owner.length) owner = entry
  }
  if (owner) return owner
  const at = id.indexOf(':')
  return at < 0 ? id : id.slice(0, at)
}

export function composerMiddlewareContributions(): ComposerMiddlewareContribution[] {
  return (registry.get(COMPOSER_AREAS.middleware) ?? []) as ComposerMiddlewareContribution[]
}

/** Run composer middleware in registration order; isolated throwing handlers. */
export async function applyComposerMiddleware(draft: ComposerDraft): Promise<ComposerDraft> {
  let current = draft
  for (const c of composerMiddlewareContributions()) {
    try {
      const next = await c.data.handler(current)
      current = next ?? current
    } catch (err) {
      logger.warn('[plugins] composer middleware failed', err)
    }
  }
  return current
}

// -- inventory ---------------------------------------------------------------

const inventory = new Map<string, PluginInventoryEntry>()
const inventoryListeners = new Set<() => void>()
let inventorySnapshot: PluginInventoryEntry[] = []

/** Cached snapshot includes row replacements, not just additions/removals. */
export function pluginInventorySnapshot(): readonly PluginInventoryEntry[] {
  return inventorySnapshot
}

export function publishPlugin(entry: PluginInventoryEntry): void {
  inventory.set(entry.id, entry)
  inventorySnapshot = [...inventory.values()]
  for (const cb of [...inventoryListeners]) {
    try {
      cb()
    } catch {
      /* isolated */
    }
  }
}

export function dropPlugin(id: string): void {
  if (inventory.delete(id)) {
    inventorySnapshot = [...inventory.values()]
    for (const cb of [...inventoryListeners]) {
      try {
        cb()
      } catch {
        /* isolated */
      }
    }
  }
}

export function subscribeInventory(cb: () => void): () => void {
  inventoryListeners.add(cb)
  return () => inventoryListeners.delete(cb)
}

export function inventoryEntries(): PluginInventoryEntry[] {
  return [...inventory.values()]
}
