/**
 * Typed wrapper over `window.nubAgent.plugins` (the Electron main-process
 * door to the on-disk plugin roots). Returns a null-bridge whose methods
 * reject in plain-browser mode (vite dev, no Electron) — mirroring
 * `spawnAvailable()` degradation.
 */

export interface PluginBridgeEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface PluginBridge {
  desktopPluginsRoot(): Promise<string | null>
  agentPluginsRoot(): Promise<string | null>
  readDir(dir: string): Promise<{ entries: PluginBridgeEntry[] }>
  readFileText(file: string): Promise<{ text: string }>
  watchPluginFile(file: string): Promise<{ id: string }>
  stopPluginWatch(id: string): Promise<{ ok: boolean }>
  watchDirectory(dir: string): Promise<{ id: string }>
  onPluginChanged(cb: (ev: { id: string }) => void): () => void
}

interface NubAgentPlugins {
  desktopPluginsRoot?: () => Promise<string | null>
  agentPluginsRoot?: () => Promise<string | null>
  readDir?: (dir: string) => Promise<{ entries: PluginBridgeEntry[] }>
  readFileText?: (file: string) => Promise<{ text: string; ok?: boolean; error?: string }>
  watchPluginFile?: (file: string) => Promise<{ id: string }>
  stopPluginWatch?: (id: string) => Promise<{ ok: boolean }>
  watchDirectory?: (dir: string) => Promise<{ id: string }>
  onPluginChanged?: (cb: (ev: { id: string }) => void) => () => void
}

type NubAgentWindow = Window & {
  nubAgent?: { plugins?: NubAgentPlugins }
}

function rejectBridge(): PluginBridge {
  const never = () => Promise.reject(new Error('plugin bridge unavailable (plain browser)'))
  return {
    desktopPluginsRoot: never,
    agentPluginsRoot: never,
    readDir: never,
    readFileText: never,
    watchPluginFile: never,
    stopPluginWatch: never,
    watchDirectory: never,
    onPluginChanged: () => () => undefined,
  }
}

function liveBridge(plugins: NubAgentPlugins): PluginBridge {
  const need = <T,>(fn: T): T => fn ?? (rejectBridge as unknown as T)

  return {
    desktopPluginsRoot: () => plugins.desktopPluginsRoot?.() ?? Promise.resolve(null),
    agentPluginsRoot: () => plugins.agentPluginsRoot?.() ?? Promise.resolve(null),
    readDir: need(plugins.readDir!),
    readFileText: async (file) => {
      const res = await plugins.readFileText!(file)
      if (res && res.ok === false) throw new Error(res.error || 'read failed')
      return res
    },
    watchPluginFile: need(plugins.watchPluginFile!),
    stopPluginWatch: need(plugins.stopPluginWatch!),
    watchDirectory: need(plugins.watchDirectory!),
    onPluginChanged: (cb) => plugins.onPluginChanged?.(cb) ?? (() => undefined),
  }
}

/** True when the Electron plugin bridge is present (desktop only). */
export function pluginBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean((window as NubAgentWindow).nubAgent?.plugins)
}

let cached: PluginBridge | null = null

/** The singleton bridge — resolves once; the loader re-checks availability. */
export function getPluginBridge(): PluginBridge {
  if (cached) return cached
  const plugins = (window as NubAgentWindow).nubAgent?.plugins
  cached = plugins ? liveBridge(plugins) : rejectBridge()
  return cached
}

/** Reset the cached bridge (tests, or after a reconnect). */
export function resetPluginBridge(): void {
  cached = null
}
