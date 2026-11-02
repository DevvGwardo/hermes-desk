/**
 * Per-plugin keyed storage — namespaced under `maia:plugins:<id>:<key>` in
 * localStorage. Same surface as Hermes desktop's PluginStorage (get/set/delete)
 * but promise-tolerant so `Promise.resolve(ctx.storage.get(k))` works.
 */

const PREFIX = 'maia:plugins'

export function createPluginStorage(pluginId: string) {
  const scoped = (key: string) => `${PREFIX}:${pluginId}:${key}`

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      try {
        const raw = window.localStorage.getItem(scoped(key))
        if (raw === null) return undefined
        return JSON.parse(raw) as T
      } catch {
        return undefined
      }
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      try {
        window.localStorage.setItem(scoped(key), JSON.stringify(value))
      } catch {
        /* storage full / unavailable — plugin keeps defaults */
      }
    },
    async delete(key: string): Promise<void> {
      try {
        window.localStorage.removeItem(scoped(key))
      } catch {
        /* no-op */
      }
    },
  }
}
