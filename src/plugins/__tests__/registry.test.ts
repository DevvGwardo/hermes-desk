import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyComposerMiddleware,
  composerMiddlewareContributions,
  disposePluginContributions,
  paletteContributions,
  panesBySide,
  registerContribution,
  registrySnapshot,
  subscribeRegistry,
  subscribeRegistryArea,
} from '../areas'
import { COMPOSER_AREAS, PALETTE_AREA, PANES_AREA } from '../../lib/plugins/types'

afterEach(() => {
  disposePluginContributions('demo')
  disposePluginContributions('a')
  disposePluginContributions('b')
  disposePluginContributions('m1')
  disposePluginContributions('m2')
  disposePluginContributions('bad')
  disposePluginContributions('good')
})

describe('contribution registry', () => {
  it('retains prior area snapshots and leaves unrelated areas stable', () => {
    const palette = registrySnapshot(PALETTE_AREA)
    const panes = registrySnapshot(PANES_AREA)
    registerContribution({ id: 'demo:pane', area: PANES_AREA, title: 'Demo', data: { placement: 'left' }, render: () => null })
    expect(registrySnapshot(PALETTE_AREA)).toBe(palette)
    expect(registrySnapshot(PANES_AREA)).not.toBe(panes)
    expect(panes).toEqual([])
  })

  it('notifies each affected area and global subscribers once on plugin unload', () => {
    registerContribution({ id: 'demo:pane', area: PANES_AREA, title: 'Demo', data: { placement: 'left' }, render: () => null })
    registerContribution({ id: 'demo:command', area: PALETTE_AREA, data: { id: 'demo', label: 'Demo', run: () => {} } })
    const callback = vi.fn()
    const global = vi.fn()
    const releasePane = subscribeRegistryArea(PANES_AREA, callback)
    const releasePalette = subscribeRegistryArea(PALETTE_AREA, callback)
    const releaseGlobal = subscribeRegistry(global)
    try {
      disposePluginContributions('demo')
      expect(callback).toHaveBeenCalledOnce()
      expect(global).toHaveBeenCalledOnce()
    } finally { releasePane(); releasePalette(); releaseGlobal() }
  })

  it('does not let a repeated stale unsubscribe detach new area listeners', () => {
    const stale = subscribeRegistryArea(PANES_AREA, () => {})
    stale()
    const callback = vi.fn()
    const release = subscribeRegistryArea(PANES_AREA, callback)
    try {
      stale()
      registerContribution({ id: 'demo:pane', area: PANES_AREA, title: 'Demo', data: { placement: 'left' }, render: () => null })
      expect(callback).toHaveBeenCalledOnce()
    } finally { release() }
  })

  it('keeps contribution disposal idempotent and preserves equal-id peers', () => {
    const dispose = registerContribution({ id: 'demo:pane', area: PANES_AREA, title: 'Old', data: { placement: 'left' }, render: () => null })
    const peer = { id: 'demo:pane', area: PANES_AREA, title: 'New', data: { placement: 'left' as const }, render: () => null }
    registerContribution(peer)
    dispose()
    const snapshot = registrySnapshot(PANES_AREA)
    dispose()
    expect(registrySnapshot(PANES_AREA)).toBe(snapshot)
    expect(snapshot).toEqual([peer])
  })

  it('register + dispose adds/removes pane contributions', () => {
    const dispose = registerContribution({
      id: 'demo:pane',
      area: PANES_AREA,
      title: 'Demo',
      data: { placement: 'left', width: '200px' },
      render: () => null,
    })
    expect(panesBySide('left').some((p) => p.id === 'demo:pane')).toBe(true)
    dispose()
    expect(panesBySide('left').some((p) => p.id === 'demo:pane')).toBe(false)
  })

  it('palette contributions are extractable', () => {
    const run = () => undefined
    registerContribution({
      id: 'demo:new',
      area: PALETTE_AREA,
      data: { id: 'demo.new', label: 'New Demo', run },
    })
    const list = paletteContributions()
    expect(list.some((c) => c.data.id === 'demo.new')).toBe(true)
    disposePluginContributions('demo')
    expect(paletteContributions().some((c) => c.data.id === 'demo.new')).toBe(false)
  })

  it('disposePluginContributions removes only the named plugin', () => {
    registerContribution({ id: 'a:pane', area: PANES_AREA, title: 'A', data: { placement: 'left' }, render: () => null })
    registerContribution({ id: 'b:pane', area: PANES_AREA, title: 'B', data: { placement: 'left' }, render: () => null })
    disposePluginContributions('a')
    const ids = panesBySide('left').map((p) => p.id)
    expect(ids).toContain('b:pane')
    expect(ids).not.toContain('a:pane')
  })
})

describe('applyComposerMiddleware', () => {
  it('runs handlers in order, passing output to input', async () => {
    registerContribution({
      id: 'm1:handler',
      area: COMPOSER_AREAS.middleware,
      data: { handler: async (d) => ({ text: `${d.text} one` }) },
    })
    registerContribution({
      id: 'm2:handler',
      area: COMPOSER_AREAS.middleware,
      data: { handler: (d) => ({ text: `${d.text} two` }) },
    })
    const out = await applyComposerMiddleware({ text: 'start' })
    expect(out.text).toBe('start one two')
  })

  it('skips throwing handlers without failing the chain', async () => {
    registerContribution({
      id: 'bad:handler',
      area: COMPOSER_AREAS.middleware,
      data: { handler: async () => { throw new Error('boom') } },
    })
    registerContribution({
      id: 'good:handler',
      area: COMPOSER_AREAS.middleware,
      data: { handler: (d) => ({ text: `${d.text}!` }) },
    })
    const out = await applyComposerMiddleware({ text: 'hi' })
    expect(out.text).toBe('hi!')
  })

  it('middleware list is empty after dispose', () => {
    expect(composerMiddlewareContributions()).toHaveLength(0)
  })
})
