import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vmFsDoor, vmFsDoorAvailable, VM_PLUGIN_ROOT } from '../vm-fs-door'

type NubVmFsFn = (verb: string, args: { path?: string; content?: string }) => Promise<{
  ok: boolean
  data?: { entries?: Array<{ name: string; path: string }>; text?: string }
  error?: string
}>

function stubVmFs(fn: NubVmFsFn) {
  ;(window as unknown as { nubAgent?: unknown }).nubAgent = { nubVmFs: fn }
}

afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('vm-fs-door', () => {
  beforeEach(() => {
    stubVmFs(vi.fn())
  })

  it('VM_PLUGIN_ROOT points at the deployed hermes home', () => {
    expect(VM_PLUGIN_ROOT).toBe('/opt/data/.hermes/desktop-plugins')
  })

  it('availability tracks the bridge presence', () => {
    expect(vmFsDoorAvailable()).toBe(true)
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    expect(vmFsDoorAvailable()).toBe(false)
  })

  it('readDir routes through nubVmFs list and returns the bridge shape', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        entries: [
          { name: 'hermes-bots', path: `${VM_PLUGIN_ROOT}/hermes-bots` },
          { name: 'other', path: `${VM_PLUGIN_ROOT}/other` },
        ],
      },
    })
    stubVmFs(fn)

    const { entries } = await vmFsDoor.readDir(VM_PLUGIN_ROOT)
    expect(fn).toHaveBeenCalledWith('list', { path: VM_PLUGIN_ROOT })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      name: 'hermes-bots',
      path: `${VM_PLUGIN_ROOT}/hermes-bots`,
      isDirectory: true,
    })
  })

  it('readFileText routes through nubVmFs read-text', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, data: { text: 'export default {}' } })
    stubVmFs(fn)

    const { text } = await vmFsDoor.readFileText(`${VM_PLUGIN_ROOT}/hermes-bots/plugin.js`)
    expect(fn).toHaveBeenCalledWith('read-text', { path: `${VM_PLUGIN_ROOT}/hermes-bots/plugin.js` })
    expect(text).toBe('export default {}')
  })

  it('throws when the bridge reports failure', async () => {
    stubVmFs(vi.fn().mockResolvedValue({ ok: false, error: 'not_linked' }))
    await expect(vmFsDoor.readDir(VM_PLUGIN_ROOT)).rejects.toThrow('not_linked')
  })

  it('throws when the bridge is absent', async () => {
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    await expect(vmFsDoor.readDir(VM_PLUGIN_ROOT)).rejects.toThrow(/unavailable/)
  })
})
