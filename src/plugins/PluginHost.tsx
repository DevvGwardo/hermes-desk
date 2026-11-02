/**
 * PluginHost — the mounted provider. Starts the disk watcher, renders plugin
 * panes (left/right columns), and exposes the palette + composer middleware
 * bridges via the registry. Mounted once inside App's root.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { watchRuntimePlugins, discoverRuntimePlugins } from './loader'
import {
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  THEMES_AREA,
  pluginInventorySnapshot,
  registrySnapshot,
  subscribeInventory,
  subscribeRegistryArea,
} from './areas'
import { pluginBridgeAvailable } from '../lib/plugins/bridge'
import type {
  PaletteContribution,
  PaneContribution,
  RouteContribution,
  SidebarNavContribution,
  SlotContribution,
  ThemeContribution,
} from '../lib/plugins/types'
import { installPluginKeybinds } from './keybinds'
import { installPluginThemes } from './themes'
import { PluginRender } from './PluginBoundary'
import { logger } from '../lib/logger'

function useRegistryArea(area: string) {
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribeRegistryArea(area, cb), [area]),
    useCallback(() => registrySnapshot(area), [area]),
    useCallback(() => registrySnapshot(area), [area]),
  )
}

function useInventory() {
  return useSyncExternalStore(
    subscribeInventory,
    pluginInventorySnapshot,
    pluginInventorySnapshot,
  )
}

/** Palette commands contributed by plugins (merge into CommandPalette). */
export function usePluginPaletteCommands(): Array<{
  id: string
  label: string
  keywords?: string[]
  detail?: string
  run: () => void
}> {
  const contributions = useRegistryArea(PALETTE_AREA) as readonly PaletteContribution[]
  return useMemo(() => contributions
    .filter((c) => typeof c.data?.label === 'string' && typeof c.data.run === 'function')
    .map((c) => ({
      id: c.id,
      label: c.data.label,
      keywords: Array.isArray(c.data.keywords) ? c.data.keywords.filter((k) => typeof k === 'string') : undefined,
      detail: typeof c.data.detail === 'string' ? c.data.detail : 'Plugin',
      run: () => {
        try { c.data.run() } catch (error) { logger.warn('[plugins] palette command failed', error) }
      },
    })), [contributions])
}

/** All plugin panes (Settings → Plugins renders these). */
export function usePluginPanes() {
  return useRegistryArea(PANES_AREA) as readonly PaneContribution[]
}

/** Plugin inventory rows (Settings → Plugins / inventory UI). */
export function usePluginInventory() {
  return useInventory()
}

/** Plugin pages (`host.navigate(path)` opens one in the main pane). */
export function usePluginRoutes() {
  return useRegistryArea(ROUTES_AREA) as readonly RouteContribution[]
}

/** Sidebar links, kept only when their page exists. */
export function usePluginSidebarNav() {
  const nav = useRegistryArea(SIDEBAR_NAV_AREA) as readonly SidebarNavContribution[]
  const routes = usePluginRoutes()
  return useMemo(() => nav.filter((item) => typeof item.data?.label === 'string' &&
    routes.some((route) => route.data?.path === item.data.path)), [nav, routes])
}

export function usePluginThemes() {
  return useRegistryArea(THEMES_AREA) as readonly ThemeContribution[]
}

/** Renders a title-bar or status-row area; nothing when it is empty. */
export function PluginSlot({ area, className }: { area: SlotContribution['area']; className?: string }) {
  const items = useRegistryArea(area) as readonly SlotContribution[]
  const renderable = items.filter((item) => typeof item.render === 'function')
  if (!renderable.length) return null
  return <div className={className} data-plugin-slot={area}>
    {renderable.map((item) => <PluginRender key={item.id} id={item.id} render={item.render} />)}
  </div>
}

/** The single mounted host: starts watching + exposes a manual reload. */
export function PluginHost({ children }: { children?: ReactNode }) {
  useEffect(() => {
    const stopKeys = installPluginKeybinds()
    const stopThemes = installPluginThemes()
    if (pluginBridgeAvailable()) watchRuntimePlugins()
    return () => { stopKeys(); stopThemes() }
  }, [])

  return <>{children}</>
}

export { discoverRuntimePlugins }
