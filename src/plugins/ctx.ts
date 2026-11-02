/**
 * Plugin context factory — the `ctx` handed to a plugin's `register()`.
 *
 * Scopes every contribution id with `<pluginId>:<localId>` so unload can
 * dispose exactly this plugin's contributions, and namespaces storage.
 */
import type { PluginContext, PluginContribution } from '../lib/plugins/types'
import { createPluginStorage } from '../lib/plugins/storage'
import { disposePluginContributions, registerContribution } from './areas'

export function createPluginContext(
  pluginId: string,
  onDispose?: (dispose: () => void) => void,
): PluginContext {
  const track = (dispose: () => void): void => {
    onDispose?.(dispose)
  }

  const scope = (c: PluginContribution): PluginContribution => ({
    ...c,
    id: `${pluginId}:${c.id}`,
  })

  return {
    id: pluginId,
    register: (c) => {
      const contribution = scope(c)
      track(registerContribution(contribution))
    },
    storage: createPluginStorage(pluginId),
    i18n: {
      register: () => undefined,
    },
  }
}

export { disposePluginContributions }
