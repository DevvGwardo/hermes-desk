import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createReader } from './cdp-exec.cjs'
import redactor from './redactor.cjs'

function fixture() {
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://fixture.invalid/', getTitle: () => 'Fixture',
    debugger: { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async method => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{
        nodeId: 'p', backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'obviously fake password' },
      }] }
      if (method === 'DOM.getDocument') return { root: { nodeName: 'HTML', children: [] } }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } }
      return {}
    }) },
  })
  const tab = { id: 't_1', laneId: 'you', webContents: wc, ensureLive: async () => wc }
  const lanes = { getTab: () => tab }
  return { tab, wc, reader: createReader({ lanes, redactor }) }
}

describe('main-process reader preview', () => {
  it('reads user tabs without input and never returns sensitive values', async () => {
    const f = fixture()
    const result = await f.reader.preview(f.tab)
    expect(result).toMatchObject({ url: 'https://fixture.invalid/', title: 'Fixture' })
    expect(result.snapshot).toContain('sensitive, value hidden')
    expect(JSON.stringify(result)).not.toContain('obviously fake password')
    expect(f.wc.debugger.sendCommand.mock.calls.every(([method]) => !method.startsWith('Input.'))).toBe(true)
    f.reader.dispose()
  })
  it('fails closed on frames, redaction failures and document changes', async () => {
    for (const mode of ['frames', 'redaction', 'navigation']) {
      const f = fixture()
      const send = f.wc.debugger.sendCommand.getMockImplementation()
      f.wc.debugger.sendCommand.mockImplementation(async (...args) => {
        if (mode === 'frames' && args[0] === 'DOM.getDocument') return { root: { children: [{ nodeName: 'IFRAME' }] } }
        if (mode === 'redaction') throw new Error('fake private content')
        if (mode === 'navigation' && args[0] === 'DOM.describeNode') f.wc.emit('did-start-navigation')
        return send(...args)
      })
      await expect(f.reader.preview(f.tab)).rejects.toMatchObject({ code: 'blocked_by_policy', message: 'Reader preview unavailable for this page' })
      f.reader.dispose()
    }
  })
})
