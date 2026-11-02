/**
 * VM fs door — read the plugin roots on a LINKED deployed VM through the
 * existing dashboard `/api/fs/*` bridge (`window.nubAgent.nubVmFs`), so
 * `~/.hermes/desktop-plugins` on an IONOS cube is reachable from maia.
 *
 * Exposes the SAME shape as the local bridge (`readDir` → { entries },
 * `readFileText` → { text }) so the loader's diskRoots() can treat it as a
 * third virtual root. No fs-watch over REST — the loader's 5s poll fallback
 * covers it. Returns null when the VM bridge is absent (plain browser or
 * unlinked).
 */

interface NubVmFsResult {
  ok: boolean
  data?: { entries?: Array<{ name: string; path: string; isDirectory?: boolean }>; text?: string }
  error?: string
}

type NubVmFsFn = (verb: string, args: { path?: string; content?: string }) => Promise<NubVmFsResult>

function vmFsBridge(): NubVmFsFn | null {
  const w = window as unknown as { nubAgent?: { nubVmFs?: NubVmFsFn } }
  return w.nubAgent?.nubVmFs ?? null
}

/** VM plugin root (deployed Hermes home on the cube). */
export const VM_PLUGIN_ROOT = '/opt/data/.hermes/desktop-plugins'

/** True when the VM fs bridge is present (linked desktop app). */
export function vmFsDoorAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(vmFsBridge())
}

async function vmReadDir(dir: string): Promise<{ entries: Array<{ name: string; path: string; isDirectory: boolean }> }> {
  const fn = vmFsBridge()
  if (!fn) throw new Error('VM fs bridge unavailable')

  const res = await fn('list', { path: dir })

  if (!res.ok) throw new Error(res.error || `VM readDir failed: ${dir}`)

  const entries = Array.isArray(res.data?.entries) ? res.data.entries : []
  return {
    entries: entries.map((e) => ({
      name: e.name,
      path: `${dir}/${e.name}`,
      isDirectory: e.isDirectory ?? true,
    })),
  }
}

async function vmReadFileText(file: string): Promise<{ text: string }> {
  const fn = vmFsBridge()
  if (!fn) throw new Error('VM fs bridge unavailable')

  const res = await fn('read-text', { path: file })

  if (!res.ok) throw new Error(res.error || `VM readFileText failed: ${file}`)

  return { text: typeof res.data?.text === 'string' ? res.data.text : '' }
}

/** The VM door in the loader's bridge shape — read-only (no watch). */
export const vmFsDoor = {
  readDir: vmReadDir,
  readFileText: vmReadFileText,
}
