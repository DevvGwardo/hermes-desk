import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverRuntimePlugins,
  loadRuntimePlugin,
  resetRuntimePlugins,
  setPluginEnabled,
  isPluginLoaded,
} from '../loader'
import { __pluginPins, __rewriteSpecifiers, __unsupportedImports } from '../loader'
import { disposePluginContributions, inventoryEntries } from '../areas'
import { getPluginBridge, resetPluginBridge } from '../../lib/plugins/bridge'
import { webcrypto } from 'node:crypto'

// Use real SHA-256 in jsdom so same-length source edits change the trust pin.
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  })
  resetRuntimePlugins()
  resetPluginBridge()
})

afterEach(() => {
  disposePluginContributions('demo')
  disposePluginContributions('bad')
  disposePluginContributions('smoke')
  resetRuntimePlugins()
})

describe('specifier rewriting (pure)', () => {
  it('rewrites only import/from/import() specifiers, not strings', () => {
    const src = `
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
const s = "from '@hermes/plugin-sdk'"
const t = 'notify(react)'
`
    const out = __rewriteSpecifiers(src)
    // SDK import rewritten to blob URL
    expect(out).toContain("from 'blob:")
    // string literals untouched
    expect(out).toContain('const s = "from \'@hermes/plugin-sdk\'"')
    expect(out).toContain("const t = 'notify(react)'")
  })

  it('flags non-mapped bare specifiers', () => {
    const bad = __unsupportedImports(`import lodash from 'lodash'\nimport { x } from '@hermes/plugin-sdk'`)
    expect(bad).toContain('lodash')
    expect(bad).not.toContain('@hermes/plugin-sdk')
  })

  it('reads multi-line imports and stays linear on long blank runs after a keyword', () => {
    expect(__unsupportedImports(`export {\n  a,\n  b,\n} from 'left-pad'\nimport\n  'side-effect'`))
      .toEqual(['left-pad', 'side-effect'])
    const padded = `export${' \n'.repeat(50_000)}const done = 1`
    const started = performance.now()
    expect(__unsupportedImports(padded)).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('loadRuntimePlugin error paths', () => {
  it('never evaluates a disabled module, including its top-level code', async () => {
    const source = 'throw new Error("must not execute"); export default { id: "disabled", register() {} }'
    expect(await loadRuntimePlugin(source, 'disabled', { defaultEnabled: false })).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(inventoryEntries().find(row => row.id === 'disabled')?.status).toBe('disabled')
  })
  it('does not treat an unpinned local disk plugin as trusted', async () => {
    expect(await loadRuntimePlugin('throw new Error("must not execute")', 'local', {
      file: '/synthetic/.hermes/desktop-plugins/local/plugin.js',
    })).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('returns null for a bare unsupported import', async () => {
    const id = await loadRuntimePlugin(`import fs from 'node:fs'\nexport default { id: 'bad', register() {} }`, 'bad')
    expect(id).toBeNull()
  })

  it('returns null for a module with no valid default export', async () => {
    vi.mocked(URL.createObjectURL).mockReturnValue('data:text/javascript,export%20const%20notAPlugin%20%3D%201')
    const id = await loadRuntimePlugin(`export const notAPlugin = 1`, 'bad')
    expect(id).toBeNull()
  })

  it('publishes an error inventory row for a broken plugin', async () => {
    await loadRuntimePlugin(`import fs from 'node:fs'`, 'bad')
    const rows = inventoryEntries()
    expect(rows.some((r) => r.id === 'bad' && r.status === 'error')).toBe(true)
  })
})

describe('scanDiskPlugins (bridge orchestration)', () => {
  it('scans the bridge roots and loads plugin folders', async () => {
    const readDir = vi.fn().mockResolvedValue({
      entries: [{ name: 'smoke', path: '/local/.hermes/desktop-plugins/smoke', isDirectory: true }],
    })
    const readFileText = vi.fn().mockResolvedValue({
      text: `
        import { host } from '@hermes/plugin-sdk'
        export default { id: 'smoke', register(ctx) { ctx.register({ id: 'p', area: 'panes', title: 'S', data: { placement: 'left' }, render: () => null }) } }
      `,
    })
    const watchPluginFile = vi.fn().mockResolvedValue({ id: 'w1' })
    const stopPluginWatch = vi.fn().mockResolvedValue({ ok: true })
    const watchDirectory = vi.fn().mockResolvedValue({ id: 'd1' })

    ;(window as unknown as { nubAgent?: unknown }).nubAgent = {
      plugins: {
        desktopPluginsRoot: vi.fn().mockResolvedValue('/local/.hermes/desktop-plugins'),
        agentPluginsRoot: vi.fn().mockResolvedValue(null),
        readDir,
        readFileText,
        watchPluginFile,
        stopPluginWatch,
        watchDirectory,
        onPluginChanged: vi.fn(() => () => undefined),
      },
    }

    await discoverRuntimePlugins()

    expect(readDir).toHaveBeenCalledWith('/local/.hermes/desktop-plugins')
    expect(readFileText).toHaveBeenCalledWith('/local/.hermes/desktop-plugins/smoke/plugin.js')
    // Discovery must not evaluate the untrusted module, even from a local root.
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(getPluginBridge()).toBeTruthy()
  })

  it('ignores folders without a plugin.js entry file', async () => {
    const readDir = vi.fn().mockResolvedValue({
      entries: [{ name: 'empty', path: '/local/.hermes/desktop-plugins/empty', isDirectory: true }],
    })
    const readFileText = vi.fn().mockRejectedValue(new Error('ENOENT'))

    ;(window as unknown as { nubAgent?: unknown }).nubAgent = {
      plugins: {
        desktopPluginsRoot: vi.fn().mockResolvedValue('/local/.hermes/desktop-plugins'),
        agentPluginsRoot: vi.fn().mockResolvedValue(null),
        readDir,
        readFileText,
        watchPluginFile: vi.fn(),
        stopPluginWatch: vi.fn(),
        watchDirectory: vi.fn(),
        onPluginChanged: vi.fn(() => () => undefined),
      },
    }

    await discoverRuntimePlugins()
    // No crash, no inventory row for 'empty' — the door just skips it.
    expect(readFileText).toHaveBeenCalledWith('/local/.hermes/desktop-plugins/empty/plugin.js')
  })

  it('scans the linked-VM plugin root as a third door when the VM bridge is present', async () => {
    const localReadDir = vi.fn().mockResolvedValue({ entries: [] })
    const nubVmFs = vi.fn((verb: string) =>
      Promise.resolve(
        verb === 'list'
          ? {
              ok: true,
              data: {
                entries: [
                  { name: 'vm-plugin', path: '/opt/data/.hermes/desktop-plugins/vm-plugin' },
                ],
              },
            }
          : { ok: false, error: 'ENOENT' },
      ),
    )

    ;(window as unknown as { nubAgent?: unknown }).nubAgent = {
      plugins: {
        desktopPluginsRoot: vi.fn().mockResolvedValue('/local/.hermes/desktop-plugins'),
        agentPluginsRoot: vi.fn().mockResolvedValue(null),
        readDir: localReadDir,
        readFileText: vi.fn(),
        watchPluginFile: vi.fn(),
        stopPluginWatch: vi.fn(),
        watchDirectory: vi.fn(),
        onPluginChanged: vi.fn(() => () => undefined),
      },
      nubVmFs,
    }

    await discoverRuntimePlugins()
    // The VM root was scanned (list called for the VM plugin root path).
    expect(nubVmFs).toHaveBeenCalledWith('list', { path: '/opt/data/.hermes/desktop-plugins' })
  })
})

describe('VM plugin TOFU gate (sweep-5 D-01)', () => {
  const VM_ROOT = '/opt/data/.hermes/desktop-plugins'
  let fileText: string

  function stubVmRoot() {
    vi.mocked(URL.createObjectURL).mockReturnValue(`data:text/javascript;base64,${btoa(fileText)}`)
    const nativePins = new Map<string, string>()
    const nubVmFs = vi.fn((verb: string, args: { path?: string }) => {
      if (verb !== 'list') {
        return Promise.resolve(args.path?.endsWith('plugin.js') ? { ok: true, data: { text: fileText } } : { ok: false, error: 'ENOENT' })
      }
      return Promise.resolve({
        ok: true,
        data: { entries: [{ name: 'vm-plugin', path: `${VM_ROOT}/vm-plugin` }] },
      })
    })
    ;(window as unknown as { nubAgent?: unknown }).nubAgent = {
      plugins: {
        getPin: vi.fn(async (file: string) => nativePins.get(file) ?? null),
        trust: vi.fn(async (file: string, hash: string) => { nativePins.set(file, hash); return { ok: true } }),
        revoke: vi.fn(async (file: string) => { nativePins.delete(file); return { ok: true } }),
        desktopPluginsRoot: vi.fn().mockResolvedValue(null),
        agentPluginsRoot: vi.fn().mockResolvedValue(null),
        readDir: vi.fn().mockResolvedValue({ entries: [] }),
        readFileText: vi.fn(),
        watchPluginFile: vi.fn(),
        stopPluginWatch: vi.fn(),
        watchDirectory: vi.fn(),
        onPluginChanged: vi.fn(() => () => undefined),
      },
      nubVmFs,
    }
    return nubVmFs
  }

  beforeEach(() => {
    fileText = [
      'globalThis.__hdPluginEvaluations = (globalThis.__hdPluginEvaluations || 0) + 1;',
      "export default { id: 'vm-plugin', register() {} }",
    ].join('\n')
  })

  it('never auto-loads a first-sighting VM plugin (no pin = no load)', async () => {
    stubVmRoot()
    await discoverRuntimePlugins()

    const row = inventoryEntries().find((r) => r.id === 'vm-plugin')
    expect(row).toBeTruthy()
    // Surface the held-for-trust state, not a silent load.
    expect(row?.status).not.toBe('loaded')
    expect(row?.status).toBe('disabled')
  })

  it('loads after the user enables it, and the pin matches the exact bytes', async () => {
    stubVmRoot()
    await discoverRuntimePlugins()

    await setPluginEnabled('vm-plugin', true)

    const pin = await __pluginPins.getAsync(`${VM_ROOT}/vm-plugin/plugin.js`)
    expect(pin).toBeTruthy()
    const hash = await __pluginPins.hash(fileText)
    expect(pin).toBe(hash)

    // Simulate the same bytes arriving again on the next 5s poll — still trusted.
    await discoverRuntimePlugins()
    const row = inventoryEntries().find((r) => r.id === 'vm-plugin')
    expect(row?.status).toBe('loaded')
    expect(isPluginLoaded('vm-plugin')).toBe(true)
    expect((globalThis as unknown as { __hdPluginEvaluations?: number }).__hdPluginEvaluations).toBe(1)
  })

  it('unloads and flags a VM plugin whose bytes changed after trust', async () => {
    stubVmRoot()
    await discoverRuntimePlugins()
    await setPluginEnabled('vm-plugin', true)

    // The compromised agent rewrites the file.
    fileText = [
      "import { host } from '@hermes/plugin-sdk'",
      "export default { id: 'vm-plugin', register(ctx) { ctx.register({ id: 'evil', area: 'panes', title: 'E', data: { placement: 'left' }, render: () => null }) } }",
    ].join('\n')

    await discoverRuntimePlugins()

    const row = inventoryEntries().find((r) => r.id === 'vm-plugin')
    expect(row?.status).toBe('error')
    expect(row?.error).toMatch(/changed on disk/)
  })
})
