// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createCdpExecutor } = require('../../electron/local/workspace/cdp-exec.cjs')
const { createSnapshotStore } = require('../../electron/local/workspace/snapshot.cjs')
const redactor = require('../../electron/local/workspace/redactor.cjs')
const { createUrlPolicy } = require('../../electron/local/workspace/url-policy.cjs')

// All values are inert, deliberately fake markers. No Electron process, page
// script, real credential, Hermes profile, or network connection is used.
function fixture() {
  const wc = new EventEmitter() as any
  const debuggerApi = new EventEmitter() as any
  const ax: any[] = [
    { nodeId: 'field', backendDOMNodeId: 1, role: { value: 'textbox' },
      name: { value: 'Search' }, value: { value: '' } },
    { nodeId: 'button', backendDOMNodeId: 2, role: { value: 'button' },
      name: { value: 'Continue' } },
  ]
  const attrs = new Map([
    [1, ['type', 'text', 'name', 'search']],
    [2, []],
  ])
  let title = 'Inert fixture'
  let url = 'https://checkout.example.invalid/'
  let attached = false
  let sensitivePosition = 1
  const tab: any = {
    id: 't_fake', laneId: 'profile:fake', controller: 'agent',
    url, title, webContents: wc, ensureLive: async () => wc,
  }
  const lanes = {
    getTab: (id: string) => id === tab.id ? tab : null,
    listTabs: (id: string) => id === tab.laneId ? [tab] : [],
    getActiveTab: () => tab, isPaused: () => false, setTabState: vi.fn(),
  }
  debuggerApi.isAttached = () => attached
  debuggerApi.attach = () => { attached = true }
  debuggerApi.detach = () => { attached = false }
  debuggerApi.sendCommand = vi.fn(async (method: string, params: any) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: ax }
    if (method === 'DOM.getDocument') return { root: { nodeName: 'HTML', children: [] } }
    if (method === 'DOM.describeNode') return { node: {
      nodeName: params.backendNodeId === 1 ? 'INPUT' : 'BUTTON',
      attributes: attrs.get(params.backendNodeId) || [],
    } }
    if (method === 'DOM.getBoxModel') {
      const p = sensitivePosition
      return { model: { border: [p, p, p + 2, p, p + 2, p + 2, p, p + 2] } }
    }
    if (method === 'Page.getLayoutMetrics') return {
      cssLayoutViewport: { clientWidth: 16, clientHeight: 16, pageX: 0, pageY: 0 },
    }
    if (method === 'Page.captureScreenshot') return {
      data: Buffer.from('fake-raster-marker').toString('base64'),
    }
    if (method === 'Input.insertText') ax[0].value = { value: params.text }
    return {}
  })
  wc.debugger = debuggerApi
  wc.isDestroyed = () => false
  wc.getURL = () => url
  wc.getTitle = () => title
  wc.getBackgroundThrottling = () => true
  wc.setBackgroundThrottling = vi.fn()
  const overlay = { send: vi.fn(), waitFrame: vi.fn(async () => {}) }
  const securePrompt = {
    requestFill: vi.fn(async () => ({ ok: true, value: 'obviously fake fill marker' })),
    confirmAction: vi.fn(async () => ({ ok: false })),
  }
  let bitmap: Buffer | undefined
  const nativeImage = {
    createFromBuffer: () => ({
      getSize: () => ({ width: 16, height: 16 }),
      toBitmap: () => {
        const pixels = Buffer.alloc(16 * 16 * 4, 255)
        const offset = ((sensitivePosition + 1) * 16 + sensitivePosition + 1) * 4
        Buffer.from([201, 22, 33, 255]).copy(pixels, offset)
        return pixels
      },
    }),
    createFromBitmap: (pixels: Buffer) => {
      bitmap = pixels
      return { toJPEG: () => Buffer.from('fake-output-marker') }
    },
  }
  const executor = createCdpExecutor({
    lanes, overlay, securePrompt, nativeImage, redactor,
    urlPolicy: createUrlPolicy(), audit: { log: vi.fn() },
  })
  return {
    wc, ax, attrs, tab, overlay, securePrompt, executor, debuggerApi,
    setTitle: (value: string) => { title = value; tab.title = value },
    setURL: (value: string) => { url = value; tab.url = value },
    moveSensitiveField: () => { sensitivePosition = 10 },
    bitmap: () => bitmap,
  }
}

async function secretEcho() {
  const f = fixture()
  await f.executor.run(f.tab, 'browser_snapshot')
  const filled = await f.executor.run(f.tab, 'browser_type', {
    ref: 'e1', text: '{{secret:Password}}',
  })
  expect(filled).toEqual({ text: 'typed [secret]' })
  const marker = 'obviously fake fill marker'
  f.ax.push({ nodeId: 'echo', backendDOMNodeId: 3,
    role: { value: 'StaticText' }, name: { value: marker } })
  f.setTitle(marker)
  return {
    f, marker,
    snapshot: await f.executor.run(f.tab, 'browser_snapshot'),
    tabs: await f.executor.run(f.tab, 'browser_tabs'),
  }
}

// Post-wave-5 probes assert the repaired invariants. Opt-in because the sweep
// is run explicitly, not because any expected-failure cases remain.
const probeSuite = describe.skipIf(process.env.HERMES_DESK_REDTEAM_PROBES !== '1')
probeSuite('Hermes Desk post-wave-5 red-team regressions', () => {
  it('HD-01 hides the source field and scrubs its approved-value echoes', async () => {
    const { f, marker, snapshot, tabs } = await secretEcho()
    expect(snapshot.snapshot).toContain('(sensitive, value hidden)')
    expect(snapshot.snapshot).not.toContain(marker)
    expect(snapshot.title).toBe('[secret]')
    expect(tabs.tabs[0].title).toBe('[secret]')
    expect(f.securePrompt.requestFill).toHaveBeenCalledOnce()
  })

  it('HD-01 must scrub approved values from later snapshot and metadata results', async () => {
    const { marker, snapshot, tabs } = await secretEcho()
    expect(JSON.stringify({ snapshot, tabs })).not.toContain(marker)
  })

  it('HD-02 carries DOM form and editable-ancestor context into redaction', async () => {
    const wc = new EventEmitter()
    const store = createSnapshotStore()
    const send = async (method: string, params: any) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [
        { nodeId: 'mail', backendDOMNodeId: 1, role: { value: 'textbox' },
          name: { value: 'Email' }, value: { value: 'fake@example.invalid' } },
        { nodeId: 'plain', backendDOMNodeId: 2, role: { value: 'textbox' },
          name: { value: 'Password' }, value: { value: 'obviously fake form marker' } },
        { nodeId: 'text', backendDOMNodeId: 4, role: { value: 'StaticText' },
          name: { value: '654321' } },
      ] }
      if (method === 'DOM.getDocument') return { root: { nodeName: 'FORM', children: [
        { nodeName: 'INPUT', backendNodeId: 1, attributes: ['type', 'email'] },
        { nodeName: 'INPUT', backendNodeId: 2, attributes: ['type', 'text', 'id', 'field'] },
        { nodeName: 'DIV', backendNodeId: 3, attributes: ['contenteditable', 'true', 'id', 'otp'],
          children: [{ nodeName: 'SPAN', backendNodeId: 4, attributes: [] }] },
      ] } }
      return { node: { nodeName: params.backendNodeId === 4 ? 'SPAN' : 'INPUT',
        attributes: params.backendNodeId === 1 ? ['type', 'email'] :
          params.backendNodeId === 2 ? ['type', 'text', 'id', 'field'] : [] } }
    }
    const raw = await store.build(wc, send)
    const exposed = redactor.renderSnapshot(redactor.redactNodes(raw, store.options(wc)))
    expect(exposed).not.toContain('obviously fake form marker')
    expect(exposed).not.toContain('654321')
    // Explicit caller groups remain supported too.
    const grouped = redactor.renderSnapshot(redactor.redactNodes(raw, {
      formGroups: [['e1', 'e2']],
    }))
    expect(grouped).not.toContain('obviously fake form marker')
  })

  it('HD-02 must propagate editable ancestry into snapshot text nodes', async () => {
    const f = fixture()
    f.ax.splice(0, f.ax.length, {
      nodeId: 'text', backendDOMNodeId: 4, role: { value: 'StaticText' }, name: { value: '654321' },
    })
    const original = f.debuggerApi.sendCommand.getMockImplementation()!
    f.debuggerApi.sendCommand.mockImplementation(async (method: string, params: any) => {
      if (method === 'DOM.getDocument') return { root: { nodeName: 'HTML', children: [
        { nodeName: 'DIV', backendNodeId: 3, attributes: ['contenteditable', 'true', 'id', 'otp'],
          children: [{ nodeName: 'SPAN', backendNodeId: 4, attributes: [] }] },
      ] } }
      return original(method, params)
    })
    const result = await f.executor.run(f.tab, 'browser_snapshot')
    expect(result.snapshot).not.toContain('654321')
  })

  it('HD-03 recomputes captured mask geometry after the paint wait', async () => {
    const f = fixture()
    f.attrs.set(1, ['type', 'password'])
    f.ax[0].value = { value: 'obviously fake screenshot marker' }
    let moved = false
    f.overlay.waitFrame.mockImplementation(async () => {
      moved = true
      f.moveSensitiveField()
    })
    await f.executor.run(f.tab, 'browser_screenshot')
    expect(moved).toBe(true)
    const pixels = f.bitmap()!
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255])
    // The moved field must be masked at its captured position too.
    const offset = (11 * 16 + 11) * 4
    expect([...pixels.subarray(offset, offset + 4)]).toEqual([0, 0, 0, 255])
    expect(f.debuggerApi.sendCommand.mock.calls.filter(
      ([method]: [string]) => method === 'DOM.getBoxModel',
    ).length).toBeGreaterThanOrEqual(3)
  })

  it('HD-03 must not return pixels outside stale masks after page layout changes', async () => {
    const f = fixture()
    f.attrs.set(1, ['type', 'password'])
    f.overlay.waitFrame.mockImplementation(async () => { f.moveSensitiveField() })
    try {
      await f.executor.run(f.tab, 'browser_screenshot')
    } catch (error: any) {
      expect(error.code).toBe('blocked_by_policy')
      return
    }
    const offset = (11 * 16 + 11) * 4
    expect([...f.bitmap()!.subarray(offset, offset + 4)]).toEqual([0, 0, 0, 255])
  })

  it('HD-04 denies Enter and click activation without transaction consent', async () => {
    const f = fixture()
    f.ax[1].name.value = 'Confirm order'
    await f.executor.run(f.tab, 'browser_snapshot')
    await expect(f.executor.run(f.tab, 'browser_click', { ref: 'e2' }))
      .rejects.toMatchObject({ code: 'blocked_by_policy' })
    f.securePrompt.confirmAction.mockClear()
    await expect(f.executor.run(f.tab, 'browser_press', { key: 'Enter' }))
      .rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.securePrompt.confirmAction).toHaveBeenCalledOnce()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalledWith('Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'Enter' }))
  })

  it('HD-04 must deny transaction submission by keyboard without consent', async () => {
    const f = fixture()
    f.ax[1].name.value = 'Confirm order'
    await f.executor.run(f.tab, 'browser_snapshot')
    await expect(f.executor.run(f.tab, 'browser_press', { key: 'Enter' }))
      .rejects.toMatchObject({ code: 'blocked_by_policy' })
  })

  it('HD-04 refreshes a renamed transaction button before consent', async () => {
    const f = fixture()
    await f.executor.run(f.tab, 'browser_snapshot')
    f.ax[1].name.value = 'Confirm order'
    await expect(f.executor.run(f.tab, 'browser_click', { ref: 'e2' }))
      .rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.securePrompt.confirmAction).toHaveBeenCalledOnce()
  })

  it('SAFE refuses a placeholder fill across top-level origin navigation', async () => {
    const f = fixture()
    await f.executor.run(f.tab, 'browser_snapshot')
    f.securePrompt.requestFill.mockImplementation(async () => {
      f.setURL('https://different.example.invalid/')
      f.wc.emit('did-start-navigation', {}, f.wc.getURL(), false, true)
      return { ok: true, value: 'obviously fake denied marker' }
    })
    await expect(f.executor.run(f.tab, 'browser_type', {
      ref: 'e1', text: '{{secret:Password}}',
    })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })

  it('HD-05 rejects explicit loopback and unspecified-address control-plane URLs', () => {
    const policy = createUrlPolicy({ servePorts: [49321] })
    expect(policy.check('http://127.0.0.1:49321/', { laneKind: 'agent' }).ok).toBe(false)
    expect(policy.check('http://0.0.0.0:49321/', { laneKind: 'agent' }).ok).toBe(false)
  })

  it('HD-05 must block unspecified-address aliases of local control-plane ports', () => {
    const policy = createUrlPolicy({ servePorts: [49321] })
    expect(policy.check('http://0.0.0.0:49321/', { laneKind: 'agent' }).ok).toBe(false)
  })
})
