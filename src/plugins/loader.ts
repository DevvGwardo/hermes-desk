/**
 * Runtime plugin loader — ported from Hermes desktop's `contrib/runtime-loader.ts`.
 *
 *   source (plain ESM js) -> [integrity check] -> bare-specifier rewrite
 *   (`@hermes/plugin-sdk` / `react*` -> live shim blobs) -> blob `import()`
 *   -> validate default HermesPlugin -> register(ctx)
 *
 * Sources: the on-disk doors `<hermes home>/desktop-plugins/<name>/plugin.js`
 * and `<hermes home>/plugins/<name>/desktop/plugin.js`.
 * Both roots are default-off and require native approval of exact bytes.
 *
 * SECURITY — this is NOT a capability boundary. A loaded plugin is evaluated
 * as ESM in the renderer realm with full app authority. Acceptable for local
 * explicitly trusted files only. A remote source must NOT
 * reuse this pipeline without a real boundary (iframe/worker + CSP + gating).
 *
 * The linked-VM root (`/opt/data/.hermes/desktop-plugins`) is exactly such a
 * remote source — the deployed agent owns that filesystem, so a compromised
 * agent can write a plugin.js there (sweep-5 D-01). Those files are gated by
 * a main-owned TOFU pin: a plugin never auto-loads on first sighting, loads
 * only while its sha256 matches the hash the user last trusted, and any
 * change unloads it until the user explicitly re-enables it (the re-enable
 * re-pins the current bytes). The local human is the consent boundary.
 */
import type { HermesPlugin, PluginInventoryEntry } from '../lib/plugins/types'
import { getPluginBridge, type PluginBridgeEntry } from '../lib/plugins/bridge'
import { vmFsDoor, vmFsDoorAvailable, VM_PLUGIN_ROOT } from '../lib/plugins/vm-fs-door'
import { installPluginSdk, sdkImportMap } from './sdk-runtime'
import { createPluginContext } from './ctx'
import { disposePluginContributions, dropPlugin, publishPlugin } from './areas'
import { logger } from '../lib/logger'

// Matches the specifier of a static `import … from '…'` / `export … from '…'`
// (including MULTILINE import blocks — the real hermes-bots imports span
// lines), a side-effect `import '…'`, or a dynamic `import('…')` — anchored to
// the import/export keywords so a bare string literal or comment (e.g.
// `const s = "from 'x'"`) is never touched. One `\s` after the keyword (the
// lazy run already covers whitespace) keeps long blank runs from being split
// every possible way between `\s+` and the lazy run.
const importSpecifierRe = () => /(import\s*\(\s*|(?:import|export)\s[^'"]*?from\s*|import\s+)(['"])([^'"]+)\2/g

/** Rewrite ONLY mapped import specifiers to their live shim blob URLs. */
function rewriteSpecifiers(source: string): string {
  const map = sdkImportMap()

  return source.replace(importSpecifierRe(), (whole, pre, quote, spec) =>
    map[spec] ? `${pre}${quote}${map[spec]}${quote}` : whole,
  )
}

/** Bare import specifiers the loader can't resolve — surfaced up-front. */
function unsupportedImports(source: string): string[] {
  const map = sdkImportMap()
  const bare = new Set<string>()

  for (const m of source.matchAll(importSpecifierRe())) {
    const spec = m[3]
    if (spec && !map[spec]) {
      bare.add(spec)
    }
  }

  return [...bare]
}

async function verifyIntegrity(source: string, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split('-', 2)

  if (algo !== 'sha256' || !expected) return false

  const actual = await hashSource(source)
  return Boolean(actual) && actual === expected
}

/** Base64 sha256 of a plugin source — the TOFU pin unit for VM plugins. */
async function hashSource(source: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
  } catch {
    return ''
  }
}

/** Only main-owned, native-approved pins authorize file-backed evaluation. */
export async function getPluginPinAsync(file: string): Promise<null | string> {
  try {
    const ipc = (
      window as unknown as {
        nubAgent?: { plugins?: { getPin?: (file: string) => Promise<string | null> } }
      }
    ).nubAgent?.plugins?.getPin
    if (ipc) {
      const v = await ipc(file)
      return typeof v === 'string' && v ? v : null
    }
  } catch {
    return null
  }
  // Renderer localStorage is not a trust authority.
  return null
}

export function unloadRuntimePlugin(id: string): void {
  disposePluginContributions(id)
  loaded.delete(id)
}

/** Test-only: the pure specifier rewrite (exported for unit tests). */
export const __rewriteSpecifiers = rewriteSpecifiers
/** Test-only: the pure unsupported-import scan (exported for unit tests). */
export const __unsupportedImports = unsupportedImports
/** Test-only: the VM-plugin TOFU pin store + hasher (exported for unit tests). */
export const __pluginPins = { getAsync: getPluginPinAsync, hash: hashSource }

/** Evaluate + register one runtime plugin. Returns its id, or null on failure. */
export async function loadRuntimePlugin(
  source: string,
  origin: string,
  options: { file?: string; integrity?: string; defaultEnabled?: boolean; kind?: 'disk' | 'agent-plugin' } = {},
): Promise<null | string> {
  if (!pluginActive(options.file ?? origin, options.file ? false : options.defaultEnabled ?? true)) {
    publishPlugin({ id: origin, name: origin, file: options.file, kind: options.kind ?? 'disk', status: 'disabled' })
    return null
  }
  installPluginSdk()

  try {
    if (options.integrity && !(await verifyIntegrity(source, options.integrity))) {
      throw new Error(`integrity check failed for ${origin}`)
    }

    const unsupported = unsupportedImports(source)

    if (unsupported.length > 0) {
      throw new Error(
        `unsupported import${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')} — ` +
          `runtime plugins may only import @hermes/plugin-sdk and react`,
      )
    }

    const url = URL.createObjectURL(new Blob([rewriteSpecifiers(source)], { type: 'text/javascript' }))

    let mod: { default?: HermesPlugin }

    try {
      mod = await import(/* @vite-ignore */ url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const plugin = mod.default

    if (!plugin?.id || typeof plugin.register !== 'function') {
      throw new Error(`${origin} has no valid default HermesPlugin export`)
    }

    const record = {
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      description: plugin.description,
      kind: options.kind ?? 'disk',
      file: options.file,
    }

    const activate = () => {
      unloadRuntimePlugin(plugin.id)
      plugin.register(createPluginContext(plugin.id))
      loaded.set(plugin.id, true)
      publishPlugin({ ...record, status: 'loaded' })
    }

    publishPlugin({ ...record, status: 'disabled' })

    if (pluginActive(plugin.id, (plugin.defaultEnabled ?? true) && (options.defaultEnabled ?? true))) {
      activate()
    }

    return plugin.id
  } catch (error) {
    logger.error(`[plugins] runtime load failed (${origin})`, error)
    publishPlugin({
      id: origin,
      name: origin,
      kind: options.kind ?? 'disk',
      file: options.file,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** User enable toggle wins; else plugin+root default. */
export function pluginActive(id: string, defaultOn: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(`maia:plugins:enabled:${id}`)
    if (raw !== null) return raw === '1'
  } catch {
    /* no storage — default */
  }
  return defaultOn
}

export function setPluginActive(id: string, active: boolean): void {
  try {
    window.localStorage.setItem(`maia:plugins:enabled:${id}`, active ? '1' : '0')
  } catch {
    /* no-op */
  }
}

/** Live loaded plugin ids (for activation state queries). */
const loaded = new Map<string, boolean>()

export function isPluginLoaded(id: string): boolean {
  return loaded.get(id) === true
}

/**
 * Enable/disable a plugin at runtime. Persists the toggle, then applies it:
 * enabling reloads the disk plugin fresh (register), disabling unloads its
 * contributions + inventory row. No-op when the plugin isn't a known disk
 * plugin (e.g. an error-origin record with no loaded id).
 */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  if (enabled) {
    // Find the disk record whose LOADED id matches (or whose origin folder
    // name matches — covers error records that never loaded).
    let target: DiskPlugin | null = null
    for (const record of disk.values()) {
      if (record.id === id || record.origin === id) {
        target = record
        break
      }
    }
    if (target) {
      // Enabling a VM plugin is the human consent moment: pin the CURRENT
      // bytes so exactly this version is trusted, then load.
      let fresh: string | undefined
      if (target.pinned) {
        try {
          const { text } = await target.readFileText(target.file)
          fresh = text
          const hash = await hashSource(text)
          const bridge = (window as unknown as { nubAgent?: { plugins?: {
            trust?: (file: string, hash: string) => Promise<{ ok: boolean }>
          } } }).nubAgent?.plugins
          if (!bridge?.trust || !(await bridge.trust(target.file, hash)).ok) return
        } catch {
          return
        }
      }
      setPluginActive(target.origin, true)
      setPluginActive(target.file, true)
      setPluginActive(id, true)
      await loadDiskPlugin(target, fresh)
    } else {
      // Unknown id — a full rescan will reconcile it.
      await scanDiskPlugins()
    }
    return
  }

  setPluginActive(id, false)
  for (const target of disk.values()) {
    if (target.id !== id && target.origin !== id) continue
    setPluginActive(target.origin, false)
    setPluginActive(target.file, false)
    try {
      const bridge = (window as unknown as { nubAgent?: { plugins?: {
        revoke?: (file: string) => Promise<unknown>
      } } }).nubAgent?.plugins
      await bridge?.revoke?.(target.file)
    } catch { /* Local disabled state still refuses evaluation. */ }
  }
  unloadRuntimePlugin(id)
  dropPlugin(id)
}

// -- review and rollback -----------------------------------------------------

interface TrustBridge {
  history?: (file: string) => Promise<{ pin: string | null; versions: string[] }>
  trustedSource?: (file: string, hash: string) => Promise<{ ok: boolean; text?: string }>
  restore?: (file: string, hash: string) => Promise<{ ok: boolean; hash?: string }>
}

function trustBridge(): TrustBridge | null {
  return (window as unknown as { nubAgent?: { plugins?: TrustBridge } }).nubAgent?.plugins ?? null
}

export interface PluginReview {
  /** The bytes on disk now: what trusting would run. */
  source: string
  hash: string
  /** The trusted version, or null if this file was never trusted. */
  pin: string | null
  /** Trusted versions, newest first (main keeps up to five). */
  versions: string[]
}

/** What is on disk now and which versions were trusted before. */
export async function reviewPlugin(file: string): Promise<PluginReview | null> {
  const bridge = getPluginBridge()
  if (!bridge) return null
  try {
    const { text } = await bridge.readFileText(file)
    const record = await trustBridge()?.history?.(file)
    return { source: text, hash: await hashSource(text), pin: record?.pin ?? null,
      versions: Array.isArray(record?.versions) ? record.versions : [] }
  } catch {
    return null
  }
}

/** A version the user trusted earlier, verified by main against its hash. */
export async function trustedPluginSource(file: string, hash: string): Promise<string | null> {
  try {
    const result = await trustBridge()?.trustedSource?.(file, hash)
    return result?.ok && typeof result.text === 'string' ? result.text : null
  } catch {
    return null
  }
}

/** Writes a trusted version back (after a native confirm) and loads it. */
export async function restorePluginVersion(file: string, hash: string): Promise<boolean> {
  try {
    const result = await trustBridge()?.restore?.(file, hash)
    if (!result?.ok) return false
  } catch {
    return false
  }
  const record = disk.get(file)
  if (record) {
    for (const key of [record.origin, record.file, record.id]) if (key) setPluginActive(key, true)
    await loadDiskPlugin(record)
  }
  return true
}

// -- disk door ---------------------------------------------------------------

const DISK_POLL_MS = 5_000

interface DiskRoot {
  defaultEnabled?: boolean
  dir: string
  entry: (folderPath: string) => string
  /** Read door for this root — local bridge by default, VM door when linked. */
  readDir: (dir: string) => Promise<{ entries: PluginBridgeEntry[] }>
  readFileText: (file: string) => Promise<{ text: string }>
  /**
   * Optional metadata probe — when the door exposes size/mtime, unchanged
   * files skip readFileText entirely. Absent doors read as before.
   */
  stat?: (file: string) => Promise<{ size: number; mtime: number } | null>
  /** Watchable (local fs) or poll-only (VM REST). */
  watchable: boolean
  /**
   * 'agent-owned' = the deployed agent can write this root (the linked-VM
   * door) — files there need a local TOFU pin before they may load.
   */
  ownedBy?: 'user' | 'agent'
}

async function diskRoots(): Promise<DiskRoot[]> {
  const bridge = getPluginBridge()

  if (!bridge) return []

  const roots: DiskRoot[] = []
  const standalone = await bridge.desktopPluginsRoot()

  if (standalone) {
    roots.push({
      dir: standalone,
      entry: (folder) => `${folder}/plugin.js`,
      readDir: (d) => bridge.readDir(d),
      readFileText: (f) => bridge.readFileText(f),
      watchable: true,
      ownedBy: 'agent',
    })
  }

  const unified = await bridge.agentPluginsRoot()

  if (unified) {
    roots.push({
      defaultEnabled: false,
      dir: unified,
      entry: (folder) => `${folder}/desktop/plugin.js`,
      readDir: (d) => bridge.readDir(d),
      readFileText: (f) => bridge.readFileText(f),
      watchable: true,
      ownedBy: 'agent',
    })
  }

  // Linked-VM door: read the deployed cube's plugin root over /api/fs/*.
  // Read-only — no fs-watch over REST; the 5s poll fallback reconciles it.
  // The AGENT owns this filesystem, so entries are TOFU-pinned (D-01).
  if (vmFsDoorAvailable()) {
    roots.push({
      dir: VM_PLUGIN_ROOT,
      entry: (folder) => `${folder}/plugin.js`,
      readDir: (d) => vmFsDoor.readDir(d),
      readFileText: (f) => vmFsDoor.readFileText(f),
      stat: (vmFsDoor as unknown as { stat?: DiskRoot['stat'] }).stat,
      watchable: false,
      ownedBy: 'agent',
    })
  }

  return roots
}

interface DiskPlugin {
  defaultEnabled?: boolean
  file: string
  id: null | string
  origin: string
  watchId: null | string
  /** Read door for this plugin's root (VM plugins have no local bridge door). */
  readFileText: (file: string) => Promise<{ text: string }>
  /** Set for agent-owned roots — load only TOFU-pinned bytes. */
  pinned?: boolean
  /** Hash of the bytes last seen at this file (poll-only roots skip no-op reloads). */
  lastHash?: string
  /** Last metadata seen via the root stat probe (skip read when unchanged). */
  lastSize?: number
  lastMtime?: number
}

/** Live disk plugins keyed by ENTRY FILE path — unique across both roots. */
const disk = new Map<string, DiskPlugin>()
let watching = false
let scanning = false

function dropOriginRecord(origin: string, except: DiskPlugin): void {
  for (const other of disk.values()) {
    if (other !== except && other.id === origin) return
  }
  dropPlugin(origin)
}

async function loadDiskPlugin(entry: DiskPlugin, cachedText?: string): Promise<void> {
  const prevId = entry.id

  try {
    if (!pluginActive(entry.file, false)) {
      if (prevId) unloadRuntimePlugin(prevId)
      publishPlugin({ id: entry.id ?? entry.origin, name: entry.origin, file: entry.file, kind: 'disk',
        status: 'disabled', error: 'Enable and approve this version in the native trust dialog before it can execute.' })
      return
    }
    const text = cachedText ?? (await entry.readFileText(entry.file)).text

    // Agent-owned root (linked VM): the TOFU gate. Without a pin the plugin
    // is an untrusted stranger — it never auto-loads. With a pin, only the
    // exact trusted bytes load; anything else unloads and asks the user to
    // re-enable (which re-pins). This is the boundary that keeps a
    // compromised agent's file-writes from becoming desktop RCE.
      if (entry.pinned) {
        const hash = await hashSource(text)
        const pin = await getPluginPinAsync(entry.file)

        if (pin !== hash) {
          entry.lastHash = hash
          if (prevId) {
            unloadRuntimePlugin(prevId)
            dropPlugin(prevId)
            entry.id = null
          }

          publishPlugin({
            id: entry.origin,
            name: entry.origin,
            kind: 'disk',
            file: entry.file,
            status: pin ? 'error' : 'disabled',
            error: pin
              ? 'changed on disk since you trusted it — re-enable to re-trust'
              : 'waiting for your trust — enable it to load this plugin',
          })
          return
        }
      }

    const id = await loadRuntimePlugin(text, entry.origin, {
      defaultEnabled: true,
      file: entry.file,
    })

    if (id && prevId && prevId !== id) {
      unloadRuntimePlugin(prevId)
      dropPlugin(prevId)
    }

    entry.id = id ?? entry.id

    if (id && id !== entry.origin) {
      dropOriginRecord(entry.origin, entry)
    }
  } catch {
    // File vanished mid-read — the next scan reconciles.
  }
}

async function scanDiskPlugins(): Promise<void> {
  const bridge = getPluginBridge()

  if (!bridge || scanning) return

  scanning = true

  try {
    const roots = await diskRoots()

    if (roots.length === 0) return

    const seen = new Set<string>()

    for (const root of roots) {
      let entries

      try {
        ;({ entries } = await root.readDir(root.dir))
      } catch {
        continue // Root missing — the poll/watch reconciles.
      }

      for (const dir of entries.filter((e) => e.isDirectory)) {
        const file = root.entry(dir.path)
        seen.add(file)

        if (disk.has(file)) {
          const existing = disk.get(file)!
          // Watchable roots reload via their fs-watch. Poll-only roots (the
          // VM door) have no change signal — re-read on every scan; the
          // TOFU gate turns changed bytes into an unload + re-trust prompt
          // instead of code execution.
          if (!root.watchable) {
            // Metadata fast path: stat first, skip the read when size+mtime
            // match the last seen bytes (doors without stat read as before).
            if (root.stat) {
              const meta = await root.stat(file).catch(() => null)
              if (
                meta &&
                meta.size === existing.lastSize &&
                meta.mtime === existing.lastMtime
              ) {
                continue
              }
              const probe = await root.readFileText(file).catch(() => null)
              if (!probe) continue
              const hash = await hashSource(probe.text)
              if (hash && hash !== existing.lastHash) {
                existing.lastHash = hash
                existing.lastSize = meta?.size
                existing.lastMtime = meta?.mtime
                await loadDiskPlugin(existing, probe.text)
              } else if (meta) {
                existing.lastSize = meta.size
                existing.lastMtime = meta.mtime
              }
              continue
            }
            const probe = await root.readFileText(file).catch(() => null)
            if (!probe) continue
            const hash = await hashSource(probe.text)
            if (hash && hash !== existing.lastHash) {
              existing.lastHash = hash
              await loadDiskPlugin(existing, probe.text)
            }
          }
          continue
        }

        // Single fetch reused for probe + hash + load (was three reads).
        const probe = await root.readFileText(file).catch(() => null)
        if (!probe) continue // No entry file (yet).

        const record: DiskPlugin = {
          defaultEnabled: root.defaultEnabled,
          file,
          id: null,
          origin: dir.name,
          watchId: null,
          readFileText: root.readFileText,
          pinned: root.ownedBy === 'agent',
          lastHash: await hashSource(probe.text),
        }

        disk.set(file, record)
        await loadDiskPlugin(record, probe.text)

        if (root.watchable) {
          try {
            record.watchId = (await bridge.watchPluginFile(file)).id
          } catch {
            // Unwatchable — the poll still reconciles; edits need manual reload.
          }
        }
      }
    }

    // Folder deleted -> plugin gone, cleanly.
    for (const [file, record] of disk) {
      if (seen.has(file)) continue

      if (record.id) {
        unloadRuntimePlugin(record.id)
        dropPlugin(record.id)
      }

      dropOriginRecord(record.origin, record)

      if (record.watchId) {
        try {
          await bridge.stopPluginWatch(record.watchId)
        } catch {
          /* already closed */
        }
      }

      disk.delete(file)
    }
  } catch {
    // No plugin roots — nothing to reconcile.
  } finally {
    scanning = false
  }
}

/** Manual rescan (the ⌘K "Reload desktop plugins" fallback). */
export const discoverRuntimePlugins = scanDiskPlugins

/** Start the self-maintaining disk door: initial scan, per-file hot reload,
 *  fs-watched folder reconciliation (poll fallback). Idempotent. */
export function watchRuntimePlugins(): void {
  const bridge = getPluginBridge()

  if (watching || !bridge) return

  watching = true

  const dirWatchIds = new Set<string>()
  const watchedDirs = new Set<string>()

  bridge.onPluginChanged(({ id }) => {
    // Directory tick: a plugin folder appeared or vanished — reconcile.
    if (dirWatchIds.has(id)) {
      void scanDiskPlugins()
      return
    }

    for (const record of disk.values()) {
      if (record.watchId === id) {
        void loadDiskPlugin(record)
        return
      }
    }
  })

  const startDirWatches = async (): Promise<boolean> => {
    const roots = await diskRoots()

    if (roots.length === 0) return false

    let all = true

    for (const root of roots) {
      // Non-watchable roots (VM REST door) are poll-only — never try to
      // fs-watch /opt/data over the LOCAL bridge (rejected: outside home).
      if (!root.watchable) continue

      if (watchedDirs.has(root.dir)) continue

      try {
        dirWatchIds.add((await bridge.watchDirectory(root.dir)).id)
        watchedDirs.add(root.dir)
      } catch {
        all = false
      }
    }

    return all
  }

  void scanDiskPlugins()
  void startDirWatches().then((watched) => {
    if (watched) return

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return

      void scanDiskPlugins()

      void startDirWatches().then((upgraded) => {
        if (upgraded) window.clearInterval(timer)
      })
    }, DISK_POLL_MS)
  })
}

/** Reset loader state (tests / profile switches). */
export function resetRuntimePlugins(): void {
  for (const id of loaded.keys()) unloadRuntimePlugin(id)
  loaded.clear()
  disk.clear()
  watching = false
  scanning = false
}

export type { PluginInventoryEntry }
