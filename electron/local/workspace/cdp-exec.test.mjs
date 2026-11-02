import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createCdpExecutor, ACTIONS, maskImage } from './cdp-exec.cjs'
import { createControllerBridge, HEARTBEAT_MS } from './controller-bridge.cjs'
import realRedactor from './redactor.cjs'
import { createTakeover } from './takeover.cjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const sequence = []
  const tabs = new Map()
  const active = new Map()
  const paused = new Set()
  const states = []
  let nextId = 1
  const lanes = {
    ensureLane: vi.fn((id) => ({ id, kind: id === 'you' ? 'user' : 'agent' })),
    listTabs: (id) => [...tabs.values()].filter((tab) => tab.laneId === id),
    getTab: (id) => tabs.get(id) || null,
    getActiveTab: (id) => tabs.get(active.get(id)) || null,
    isPaused: (id) => paused.has(id),
    setTabState: (id, state) => states.push({ id, state }),
    openTab: vi.fn(async (laneId) => makeTab(laneId)),
    activateTab: vi.fn((id, opts) => { active.set(tabs.get(id).laneId, id); sequence.push(['activate', id, opts]) }),
  }
  function makeTab(laneId = 'profile:alan') {
    const wc = new EventEmitter()
    const debuggerApi = new EventEmitter()
    let attached = false
    let throttled = true
    let url = 'https://github.com/login'
    let title = 'Fake login fixture'
    let destroyed = false
    const attributes = new Map([
      [1, ['type', 'password', 'autocomplete', 'current-password', 'id', 'pw']],
      [2, ['type', 'text', 'name', 'search']],
      [3, []],
      [4, []],
    ])
    const tab = {
      id: `t_${nextId++}`, laneId, url, title, controller: 'agent',
      webContents: wc, ensureLive: vi.fn(async () => wc),
    }
    tabs.set(tab.id, tab)
    active.set(laneId, tab.id)
    const ax = [
      { nodeId: '1', backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'FAKE_PASSWORD_VALUE' } },
      { nodeId: '2', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Search' } },
      { nodeId: '3', backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Sign in' } },
    ]
    debuggerApi.attach = vi.fn((version) => { sequence.push(['attach', tab.id, version]); attached = true })
    debuggerApi.detach = vi.fn(() => { attached = false })
    debuggerApi.isAttached = () => attached
    debuggerApi.sendCommand = vi.fn(async (method, params) => {
      sequence.push([method, params, tab.id])
      if (wc.hook) {
        const response = wc.hook(method, params)
        if (response !== undefined) return response
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: ax }
      if (method === 'DOM.getDocument') return { root: { nodeName: 'HTML', backendNodeId: 100, children: [] } }
      if (method === 'DOM.describeNode') return { node: { nodeName: params.backendNodeId < 3 ? 'INPUT' : 'BUTTON', attributes: attributes.get(params.backendNodeId) || [] } }
      if (method === 'DOM.getBoxModel') return { model: { border: [1, 1, 3, 1, 3, 3, 1, 3] } }
      if (method === 'DOM.resolveNode') return { object: { objectId: `fixture-${params.backendNodeId}` } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 4, clientHeight: 4, pageX: 0, pageY: 0 } }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('FAKE_UNMASKED_IMAGE').toString('base64') }
      if (method === 'Page.navigate') {
        url = params.url
        tab.url = url
        wc.emit('did-start-navigation', {}, url, false, true)
        wc.emit('did-navigate', {}, url)
        debuggerApi.emit('message', {}, 'Page.loadEventFired', {})
        return { frameId: 'main' }
      }
      return {}
    })
    wc.debugger = debuggerApi
    wc.isDestroyed = () => destroyed
    wc.getURL = () => url
    wc.getTitle = () => title
    wc.getBackgroundThrottling = () => throttled
    wc.setBackgroundThrottling = vi.fn((value) => { throttled = value; sequence.push(['throttle', value, tab.id]) })
    wc.navigationHistory = {
      canGoBack: () => true,
      goBack: vi.fn(() => { sequence.push(['back', tab.id]); debuggerApi.emit('message', {}, 'Page.loadEventFired', {}) }),
    }
    wc.setURL = (value, emit = true) => {
      url = value
      if (emit) wc.emit('did-start-navigation', {}, url, false, true)
    }
    wc.setTitle = (value) => { title = value }
    wc.close = () => { destroyed = true; tabs.delete(tab.id); wc.emit('destroyed') }
    return { ...tab, tab, wc, ax, attributes }
  }
  const redactor = {
    scrubText: vi.fn((text) => String(text || '').replaceAll('FAKE_PASSWORD_VALUE', '[secret]')),
    isSensitiveNode: (node) => node.sensitive || node.attrs.type === 'password',
    redactNodes: vi.fn((nodes) => nodes.map((node) => ({
      ...node, name: redactor.scrubText(node.name),
      ...(node.attrs.type === 'password' ? { sensitive: true, value: undefined } :
        node.value !== undefined ? { value: redactor.scrubText(node.value) } : {}),
    }))),
    renderSnapshot: (nodes) => nodes.map((node) => `[ref=${node.ref}] ${node.role} "${node.name}"${node.sensitive ? ' (sensitive, value hidden)' : ''}`).join('\n'),
  }
  const overlay = {
    send: vi.fn((message) => sequence.push(['overlay', message])),
    waitFrame: vi.fn(async () => { sequence.push(['paint']) }),
  }
  const nativeImage = {
    createFromBuffer: vi.fn(() => ({
      getSize: () => ({ width: 4, height: 4 }),
      toBitmap: () => Buffer.alloc(64, 255),
    })),
    createFromBitmap: vi.fn((bitmap, size) => {
      sequence.push(['bitmap', bitmap, size])
      return { toJPEG: (quality) => { sequence.push(['jpeg', quality]); return Buffer.from('FAKE_MASKED_IMAGE') } }
    }),
  }
  const securePrompt = {
    requestFill: vi.fn(async () => ({ ok: true, value: 'FAKE_FILL_VALUE' })),
    confirmAction: vi.fn(async () => ({ ok: true })),
  }
  const urlPolicy = {
    check: vi.fn((url) => /^https:\/\//.test(url) ? { ok: true, url } : { ok: false, reason: 'fake policy' }),
  }
  const audit = { log: vi.fn() }
  const deps = { lanes, overlay, redactor, nativeImage, securePrompt, urlPolicy, audit, servePorts: [9123] }
  return { ...deps, deps, sequence, makeTab, tabs, active, paused, states }
}

async function takeSnapshot(exec, tab) {
  return exec.run(tab, 'browser_snapshot', {}, { agent: { profile: 'alan', name: 'Alan', color: '#123456' } })
}

afterEach(() => vi.useRealTimers())

describe('lane-scoped CDP executor', () => {
  it('renders compact and full snapshots differently without exposing redacted values', async () => {
    const f = fixture()
    const { tab, ax } = f.makeTab()
    ax.unshift({ nodeId: 'container', backendDOMNodeId: 9, role: { value: 'generic' },
      name: { value: '' }, childIds: ['1', '2', '3'] })
    const exec = createCdpExecutor(f.deps)
    const compact = await exec.run(tab, 'browser_snapshot', { full: false })
    const full = await exec.run(tab, 'browser_snapshot', { full: true })
    expect(compact.snapshot).not.toContain('generic ""')
    expect(full.snapshot).toContain('generic ""')
    expect(full.snapshot).toMatch(/\n  \[ref=e\d+\] textbox/)
    expect(JSON.stringify({ full, compact })).not.toContain('FAKE_PASSWORD_VALUE')
    await expect(exec.run(tab, 'browser_snapshot', { full: 'yes' })).rejects.toMatchObject({ code: 'bad_args' })
  })

  it.each(['confirm', 'block', 'allow'])('uses the live per-agent %s sensitive-action setting', async mode => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    ax[2].name.value = 'Continue'
    f.lanes.getWorkspaceConfig = () => ({ profiles: { alan: { sensitiveActions: mode } } })
    wc.hook = (method, params) => method === 'DOM.describeNode' && params.backendNodeId === 3 ?
      { node: { nodeName: 'BUTTON', attributes: ['id', 'delete-account'] } } : undefined
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    if (mode === 'block') {
      await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
      expect(f.securePrompt.confirmAction).not.toHaveBeenCalled()
      expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    } else {
      await exec.run(tab, 'browser_click', { ref: 'e3' })
      expect(f.securePrompt.confirmAction).toHaveBeenCalledTimes(mode === 'confirm' ? 1 : 0)
    }
  })

  it.each(['frame-before-consent', 'frame-during-consent', 'focus-stolen', 'field-detached'])(
    'fails closed for a secret fill when %s', async mode => {
      const f = fixture()
      const { tab, wc } = f.makeTab()
      const exec = createCdpExecutor(f.deps)
      await takeSnapshot(exec, tab)
      let frame = mode === 'frame-before-consent'
      f.securePrompt.requestFill.mockImplementation(async () => {
        if (mode === 'frame-during-consent') frame = true
        return { ok: true, value: 'FAKE_FILL_VALUE' }
      })
      wc.hook = method => {
        if (method === 'DOM.getDocument' && frame) return { root: { nodeName: 'HTML',
          children: [{ nodeName: 'IFRAME', backendNodeId: 8 }] } }
        if (method === 'Runtime.callFunctionOn' && ['focus-stolen', 'field-detached'].includes(mode)) {
          return { result: { value: false } }
        }
      }
      await expect(exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Fixture}}' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
      if (mode === 'frame-before-consent') expect(f.securePrompt.requestFill).not.toHaveBeenCalled()
      expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
      expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('FAKE_FILL_VALUE')
    },
  )

  it('uses metadata provided by workspace lanes for the ghost cursor', async () => {
    const f = fixture()
    const { tab } = f.makeTab()
    f.lanes.getAgentMeta = () => ({ name: 'Alan Hermes', color: '#44bd9a' })
    const exec = createCdpExecutor(f.deps)
    await exec.run(tab, 'browser_scroll')
    expect(f.overlay.send).toHaveBeenCalledWith(expect.objectContaining({
      tabId: tab.id, label: 'Alan Hermes', color: '#44bd9a',
    }))
  })
  it('HD-01 scrubs approved arbitrary values and encoded echoes in every later result', async () => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    const exec = createCdpExecutor({ ...f.deps, redactor: realRedactor })
    const marker = 'obviously fake approved value'
    f.securePrompt.requestFill.mockResolvedValue({ ok: true, value: marker })
    await takeSnapshot(exec, tab)
    await exec.run(tab, 'browser_type', { ref: 'e2', text: '{{secret:Fixture}}' })
    ax[1].value = { value: marker }
    ax.push({ nodeId: 'echo', backendDOMNodeId: 4, role: { value: 'StaticText' }, name: { value: marker } })
    wc.setTitle(marker)
    tab.title = marker
    wc.setURL(`https://github.com/${encodeURIComponent(marker)}`, false)
    tab.url = wc.getURL()
    const result = await takeSnapshot(exec, tab)
    const tabs = await exec.run(tab, 'browser_tabs')
    expect(JSON.stringify({ result, tabs })).not.toContain(marker)
    expect(JSON.stringify({ result, tabs })).not.toContain(encodeURIComponent(marker))
    expect(result.snapshot).toContain('[secret]')
    await exec.run(tab, 'browser_screenshot')
    expect(f.overlay.send.mock.calls.find(([msg]) => msg.type === 'masks')[0].rects).toHaveLength(3)
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain(marker)
  })

  it('HD-02 groups actual DOM forms and masks editable ancestor text on both output paths', async () => {
    const f = fixture()
    const { tab, wc, ax, attributes } = f.makeTab()
    ax[0].name.value = 'Email'
    ax[0].value.value = 'fake@example.invalid'
    attributes.set(1, ['type', 'email'])
    ax[1].name.value = 'Password'
    ax[1].value = { value: 'obviously fake form value' }
    ax.push({ nodeId: 'otp', backendDOMNodeId: 4, role: { value: 'StaticText' }, name: { value: '654321' } })
    wc.hook = (method) => method === 'DOM.getDocument' ? { root: { nodeName: 'FORM', backendNodeId: 100, children: [
      { nodeName: 'INPUT', backendNodeId: 1, attributes: attributes.get(1) },
      { nodeName: 'INPUT', backendNodeId: 2, attributes: attributes.get(2) },
      { nodeName: 'DIV', backendNodeId: 5, attributes: ['id', 'otp', 'contenteditable', 'true'], children: [
        { nodeName: 'SPAN', backendNodeId: 4, attributes: [] },
      ] },
    ] } } : undefined
    const exec = createCdpExecutor({ ...f.deps, redactor: realRedactor })
    const result = await takeSnapshot(exec, tab)
    expect(result.snapshot).not.toContain('obviously fake form value')
    expect(result.snapshot).not.toContain('654321')
    expect(result.snapshot).toContain('fake@example.invalid')
    await exec.run(tab, 'browser_screenshot')
    expect(f.overlay.send.mock.calls.find(([msg]) => msg.type === 'masks')[0].rects.length).toBeGreaterThanOrEqual(2)
  })

  it.each(['Enter', 'Space', ' '])('HD-04 denies effective keyboard activation by %s', async (key) => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    ax[2].name.value = 'Delete account'
    const exec = createCdpExecutor(f.deps)
    f.securePrompt.confirmAction.mockResolvedValue({ ok: false })
    await expect(exec.run(tab, 'browser_press', { key })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.securePrompt.confirmAction).toHaveBeenCalledOnce()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything())
  })

  it('HD-04 checks the fresh label after the overlay wait, not the cached safe label', async () => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    f.overlay.waitFrame.mockImplementation(async () => { ax[2].name.value = 'Confirm order' })
    f.securePrompt.confirmAction.mockResolvedValue({ ok: false })
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.securePrompt.confirmAction).toHaveBeenCalledOnce()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
  })

  it('HD-04 denies a safe-labelled form submission and a label changing during consent', async () => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    wc.setURL('https://bank.example.invalid/')
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    f.securePrompt.confirmAction.mockResolvedValueOnce({ ok: false })
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    f.securePrompt.confirmAction.mockImplementation(async () => {
      ax[2].name.value = 'Transfer everything'
      return { ok: true }
    })
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
  })

  it.each(['paint', 'capture', 'new-node'])('HD-03 masks current regions or fails closed after %s changes', async (change) => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    let position = 1
    wc.hook = (method) => {
      if (method === 'DOM.getBoxModel') return { model: { border: [position, 1, position + 1, 1, position + 1, 2, position, 2] } }
      if (method === 'Page.captureScreenshot' && change !== 'paint') {
        if (change === 'new-node') ax.push({ nodeId: 'new', backendDOMNodeId: 4, role: { value: 'textbox' },
          name: { value: 'Password' }, value: { value: 'FAKE_PASSWORD_VALUE' } })
        else position = 3
      }
    }
    f.overlay.waitFrame.mockImplementation(async () => { if (change === 'paint') position = 3 })
    const exec = createCdpExecutor(f.deps)
    if (change === 'paint') {
      await expect(exec.run(tab, 'browser_screenshot')).resolves.toHaveProperty('screenshot')
      expect(wc.debugger.sendCommand.mock.calls.filter(([method]) => method === 'DOM.getBoxModel')).toHaveLength(3)
    } else {
      await expect(exec.run(tab, 'browser_screenshot')).rejects.toMatchObject({ code: 'blocked_by_policy' })
      expect(f.nativeImage.createFromBitmap).not.toHaveBeenCalled()
    }
    expect(f.overlay.send).toHaveBeenLastCalledWith({ type: 'clear', tabId: tab.id })
  })

  it('ignores only matching CDP mouse/key input and still pauses on real input during dispatch', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    f.lanes.pauseLane = (id) => f.paused.add(id)
    f.lanes.emit = vi.fn()
    const cancelLane = vi.fn()
    const takeover = createTakeover({ lanes: f.lanes, getBridge: () => ({ cancelLane }),
      getSessionId: () => null, overlay: f.overlay, audit: f.audit })
    takeover.attach(tab, new EventEmitter())
    wc.hook = (method, params) => {
      if (method === 'Input.dispatchMouseEvent') wc.emit('before-mouse-event', {}, {
        type: params.type === 'mousePressed' ? 'mouseDown' : 'mouseUp',
        x: params.x, y: params.y, button: params.button,
      })
      if (method === 'Input.dispatchKeyEvent') wc.emit('before-input-event', {}, {
        type: params.type, key: params.key, code: params.code,
      })
    }
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    await exec.run(tab, 'browser_click', { ref: 'e3' })
    await exec.run(tab, 'browser_press', { key: 'Tab' })
    expect(cancelLane).not.toHaveBeenCalled()
    wc.hook = (method, params) => {
      if (method === 'Input.dispatchMouseEvent') wc.emit('before-mouse-event', {}, {
        type: 'mouseDown', x: params.x + 30, y: params.y + 30, button: 'left',
      })
    }
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'user_took_control' })
    expect(cancelLane).toHaveBeenCalledExactlyOnceWith(tab.laneId, 'user_took_control')
    takeover.dispose()
  })

  it('builds redacted refs, clicks with a ghost cursor, and never uses OS input', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    const snapshot = await takeSnapshot(exec, tab)
    expect(snapshot.snapshot).toContain('[ref=e1]')
    expect(snapshot.snapshot).toContain('value hidden')
    expect(JSON.stringify(snapshot)).not.toContain('FAKE_PASSWORD_VALUE')
    f.sequence.length = 0
    await exec.run(tab, 'browser_click', { ref: '@e3' }, { agent: { name: 'Alan', color: '#123456' } })
    expect(f.sequence.map((row) => row[0]).filter((name) =>
      !['Accessibility.getFullAXTree', 'DOM.getDocument', 'DOM.describeNode'].includes(name))).toEqual([
      'throttle', 'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'overlay', 'paint',
      'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'overlay', 'Input.dispatchMouseEvent',
      'overlay', 'Input.dispatchMouseEvent', 'throttle',
    ])
    expect(f.overlay.send.mock.calls.map(([msg]) => msg.phase)).toEqual(['move', 'press', 'release'])
    expect(f.overlay.send.mock.calls[0][0]).toEqual({ type: 'cursor', tabId: tab.id, x: 2, y: 2, phase: 'move', color: '#123456', label: 'Alan' })
    expect(wc.debugger.attach).toHaveBeenCalledExactlyOnceWith('1.3')
    expect(wc.getBackgroundThrottling()).toBe(true)
  })

  it('navigates only policy-approved URLs, waits for load, and invalidates refs', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    f.sequence.length = 0
    await expect(exec.run(tab, 'browser_navigate', { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything())
    await expect(exec.run(tab, 'browser_navigate', { url: 'https://example.com/' })).resolves.toMatchObject({ url: 'https://example.com/' })
    expect(f.urlPolicy.check).toHaveBeenLastCalledWith('https://example.com/', {
      laneKind: 'agent', laneId: tab.laneId, profile: 'alan', servePorts: [9123],
    })
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' })).rejects.toMatchObject({ code: 'no_such_ref' })
    expect(wc.debugger.listenerCount('message')).toBe(0)
  })

  it('times out load waits and cleans up listeners and throttling', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { tab, wc } = f.makeTab()
    wc.hook = (method) => method === 'Page.navigate' ? { frameId: 'main' } : undefined
    const exec = createCdpExecutor({ ...f.deps, loadTimeoutMs: 30 })
    const run = exec.run(tab, 'browser_navigate', { url: 'https://example.com/' })
    const assertion = expect(run).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(31)
    await assertion
    expect(wc.debugger.listenerCount('message')).toBe(0)
    expect(wc.getBackgroundThrottling()).toBe(true)
  })

  it('refuses literal password fills and resolves placeholders only into CDP', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    for (const text of ['FAKE_LITERAL_PASSWORD', 'prefix{{secret:Password}}', '{{secret:Password}}suffix']) {
      await expect(exec.run(tab, 'browser_type', { ref: 'e1', text })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    }
    expect(f.securePrompt.requestFill).not.toHaveBeenCalled()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
    const result = await exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Password}}' }, { agent: { name: 'Alan' } })
    expect(result).toEqual({ text: 'typed [secret]' })
    expect(f.securePrompt.requestFill).toHaveBeenCalledExactlyOnceWith({
      agentName: 'Alan', fieldLabel: 'Password', origin: 'https://github.com',
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 1 })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.callFunctionOn', expect.objectContaining({
      objectId: 'fixture-1', arguments: [{ value: 'https://github.com' }, { value: 'FAKE_FILL_VALUE' }],
    }))
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('FAKE_FILL_VALUE')
  })

  it.each([true, false])('binds a fill to origin even when navigation event is %s', async (emit) => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    f.securePrompt.requestFill.mockImplementation(async () => {
      wc.setURL('https://attacker.invalid/', emit)
      return { ok: true, value: 'FAKE_FILL_VALUE' }
    })
    await expect(exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Password}}' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })

  it('rejects same-origin navigation during consent, denial, and malformed placeholders', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    await expect(exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:}}' })).rejects.toMatchObject({ code: 'bad_args' })
    f.securePrompt.requestFill.mockResolvedValueOnce({ ok: false })
    await expect(exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Password}}' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    f.securePrompt.requestFill.mockImplementation(async () => {
      wc.setURL('https://github.com/other')
      return { ok: true, value: 'FAKE_FILL_VALUE' }
    })
    await expect(exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Password}}' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything())
  })

  it('rechecks a field that becomes sensitive before fill and supports per-character bound writes', async () => {
    const f = fixture()
    const { tab, wc, attributes } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    attributes.set(2, ['type', 'password'])
    await expect(exec.run(tab, 'browser_type', { ref: 'e2', text: 'unsafe' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    attributes.set(2, ['type', 'text'])
    await exec.run(tab, 'browser_type', { ref: 'e2', text: 'ab', slowly: true })
    expect(wc.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn')
      .map(([, args]) => args.arguments[1].value)).toEqual(['a', 'b'])
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything())
  })

  it('keeps secret-filled ordinary text fields masked in later snapshots and screenshots', async () => {
    const f = fixture()
    const { tab, ax } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    await exec.run(tab, 'browser_type', { ref: 'e2', text: '{{secret:Password}}' })
    ax[1].value = { value: 'FAKE_FILL_VALUE' }
    const snapshot = await takeSnapshot(exec, tab)
    expect(snapshot.snapshot).toContain('[ref=e2] textbox "Search" (sensitive, value hidden)')
    expect(JSON.stringify(snapshot)).not.toContain('FAKE_FILL_VALUE')
    await exec.run(tab, 'browser_screenshot')
    expect(f.overlay.send.mock.calls.find(([msg]) => msg.type === 'masks')[0].rects).toHaveLength(2)
    await expect(exec.run(tab, 'browser_type', { ref: 'e2', text: 'literal' })).rejects.toMatchObject({ code: 'blocked_by_policy' })
  })

  it('drops raw CDP errors even if Chromium echoes a secret', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    wc.hook = (method) => { if (method === 'Runtime.callFunctionOn') throw new Error('FAKE_FILL_VALUE') }
    const result = await exec.run(tab, 'browser_type', { ref: 'e1', text: '{{secret:Password}}' }).catch((error) => error)
    expect(result.code).toBe('blocked_by_policy')
    expect(result.message).not.toContain('FAKE_FILL_VALUE')
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('FAKE_FILL_VALUE')
  })

  it('presses keys, wheels at the viewport centre, and navigates back', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await exec.run(tab, 'browser_press', { key: 'Control+a' })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    })
    await exec.run(tab, 'browser_scroll', { dir: 'up', amount: 300 })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 2, y: 2, deltaX: 0, deltaY: -300 })
    await exec.run(tab, 'browser_back', {})
    expect(wc.navigationHistory.goBack).toHaveBeenCalledOnce()
  })

  it('lists/activates only this lane, without attaching a debugger or stealing focus', async () => {
    const f = fixture()
    const first = f.makeTab()
    const second = f.makeTab()
    const foreign = f.makeTab('profile:scout')
    const user = f.makeTab('you')
    const exec = createCdpExecutor(f.deps)
    const result = await exec.run(first.tab, 'browser_tabs', {})
    expect(result.tabs.map((tab) => tab.id)).toEqual([first.tab.id, second.tab.id])
    await exec.run(first.tab, 'browser_tab_activate', { id: first.tab.id })
    expect(f.lanes.activateTab).toHaveBeenCalledWith(first.tab.id, { steal: false })
    for (const target of [foreign, user]) {
      await expect(exec.run(first.tab, 'browser_tab_activate', { id: target.tab.id })).rejects.toMatchObject({ code: 'bad_args' })
    }
    expect(first.wc.debugger.attach).not.toHaveBeenCalled()
  })

  it('never attaches to app/overlay/user/non-lane or substituted webContents', async () => {
    const f = fixture()
    const lane = f.makeTab()
    const foreign = f.makeTab('you')
    const exec = createCdpExecutor(f.deps)
    const impostor = { ...lane.tab, webContents: foreign.wc }
    await expect(exec.run(impostor, 'browser_snapshot')).rejects.toMatchObject({ code: 'tab_closed' })
    await expect(exec.run(foreign.tab, 'browser_snapshot')).rejects.toMatchObject({ code: 'tab_closed' })
    lane.tab.ensureLive.mockResolvedValue(foreign.wc)
    await expect(exec.run(lane.tab, 'browser_snapshot')).rejects.toMatchObject({ code: 'tab_closed' })
    expect(lane.wc.debugger.attach).not.toHaveBeenCalled()
    expect(foreign.wc.debugger.attach).not.toHaveBeenCalled()
  })

  it('draws and paints masks before capture, black-fills the image in main, then clears', async () => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    ax.push({ nodeId: '4', backendDOMNodeId: 4, role: { value: 'StaticText' }, name: { value: 'FAKE_PASSWORD_VALUE' } })
    const exec = createCdpExecutor(f.deps)
    const result = await exec.run(tab, 'browser_screenshot')
    const masks = f.sequence.findIndex((row) => row[0] === 'overlay' && row[1].type === 'masks')
    const paint = f.sequence.findIndex((row) => row[0] === 'paint')
    const capture = f.sequence.findIndex((row) => row[0] === 'Page.captureScreenshot')
    expect(masks).toBeLessThan(paint)
    expect(paint).toBeLessThan(capture)
    expect(f.sequence[masks][1].rects).toHaveLength(2)
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 },
    })
    expect(f.nativeImage.createFromBitmap).toHaveBeenCalled()
    const bitmap = f.nativeImage.createFromBitmap.mock.calls[0][0]
    expect([...bitmap.subarray(0, 4)]).toEqual([0, 0, 0, 255])
    expect(result.screenshot).toBe(`data:image/jpeg;base64,${Buffer.from('FAKE_MASKED_IMAGE').toString('base64')}`)
    expect(f.overlay.send).toHaveBeenLastCalledWith({ type: 'clear', tabId: tab.id })
  })

  it('fails closed on redaction, paint, mask geometry or encoding errors', async () => {
    for (const failure of ['redaction', 'paint', 'geometry', 'encoding']) {
      const f = fixture()
      const { tab, wc } = f.makeTab()
      if (failure === 'redaction') f.redactor.redactNodes.mockImplementation(() => { throw Object.assign(new Error('private'), { name: 'RedactionError' }) })
      if (failure === 'paint') f.overlay.waitFrame.mockRejectedValue(new Error('paint failed'))
      if (failure === 'geometry') wc.hook = (method) => method === 'DOM.getBoxModel' ? { model: {} } : undefined
      if (failure === 'encoding') f.nativeImage.createFromBuffer.mockImplementation(() => { throw new Error('decode failed') })
      const exec = createCdpExecutor(f.deps)
      await expect(exec.run(tab, 'browser_screenshot')).rejects.toMatchObject({ code: 'blocked_by_policy' })
      if (failure !== 'encoding') expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
      if (failure === 'paint' || failure === 'encoding') expect(f.overlay.send).toHaveBeenLastCalledWith({ type: 'clear', tabId: tab.id })
    }
  })

  it('caps native raster dimensions even when the CDP clip is retina-sized', () => {
    const resize = vi.fn(() => ({ getSize: () => ({ width: 1568, height: 1 }), toBitmap: () => Buffer.alloc(1568 * 4, 255) }))
    const nativeImage = {
      createFromBuffer: () => ({ getSize: () => ({ width: 2000, height: 2 }), resize }),
      createFromBitmap: vi.fn(() => ({ toJPEG: () => Buffer.from('fake') })),
    }
    maskImage('fake', [], { width: 2000, height: 2 }, nativeImage)
    expect(resize).toHaveBeenCalledWith({ width: 1568, height: 1 })
  })

  it('requires main-process confirmation for sensitive checkout actions', async () => {
    const f = fixture()
    const { tab, wc, ax } = f.makeTab()
    wc.setURL('https://checkout.example.invalid/')
    ax[2].name.value = 'Confirm order'
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    f.securePrompt.confirmAction.mockResolvedValueOnce({ ok: false })
    await expect(exec.run(tab, 'browser_click', { ref: 'e3' }, { agent: { name: 'Alan' } })).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    await exec.run(tab, 'browser_click', { ref: 'e3' }, { agent: { name: 'Alan' } })
    expect(f.securePrompt.confirmAction).toHaveBeenCalledWith({ agentName: 'Alan', origin: 'https://checkout.example.invalid' })
  })

  it('aborts pending CDP on takeover and prevents subsequent input', async () => {
    const f = fixture()
    const { tab, wc } = f.makeTab()
    const exec = createCdpExecutor(f.deps)
    await takeSnapshot(exec, tab)
    const pending = deferred()
    wc.hook = (method) => method === 'DOM.scrollIntoViewIfNeeded' ? pending.promise : undefined
    const controller = new AbortController()
    const run = exec.run(tab, 'browser_click', { ref: 'e3' }, { signal: controller.signal })
    await vi.waitFor(() => expect(wc.debugger.sendCommand).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', expect.anything()))
    controller.abort({ code: 'user_took_control' })
    await expect(run).rejects.toMatchObject({ code: 'user_took_control' })
    pending.resolve({})
    await Promise.resolve()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything())
    expect(wc.getBackgroundThrottling()).toBe(true)
  })
})

function bridgeFixture() {
  const f = fixture()
  let event
  let connection
  const serveClient = {
    connected: true,
    call: vi.fn(async (method, params) => {
      if (method === 'browser.controller.register') return {
        scope: { session_id: params.session_id, profile_id: params.browser_profile_id.replace('ws-agent-', ''),
          controller_id: params.controller_id, browser_profile_id: params.browser_profile_id,
          principal_id: 'fixture-principal', transport_family: 'cloud-ticket-ws', capabilities: params.capabilities },
      }
      return method === 'browser.controller.result' ? { accepted: true } : method === 'browser.controller.detach' ? { detached: true } : { ok: true }
    }),
    onEvent: vi.fn((cb) => { event = cb; return vi.fn() }),
    onConnection: vi.fn((cb) => { connection = cb; return vi.fn() }),
  }
  const bridge = createControllerBridge({ ...f.deps, serveClient, installId: 'fake-install', commandTimeoutMs: 1000,
    getWorkspaceConfig: () => ({ nativeControllerEnabled: true }) })
  const command = (sessionId, id, action = 'browser_snapshot', args = {}) => event('browser.controller.command', {
    session_id: sessionId, payload: { command_id: id, action, arguments: args, tool_call_id: `tool-${id}` },
  })
  const results = () => serveClient.call.mock.calls.filter(([method]) => method === 'browser.controller.result').map(([, params]) => params)
  return { ...f, bridge, serveClient, command, results, event: (...args) => event(...args), connection: (...args) => connection(...args) }
}

describe('Hermes controller bridge protocol and FIFO', () => {
  it('registers lazily with real protocol names, heartbeats by session, and detaches', async () => {
    vi.useFakeTimers()
    const f = bridgeFixture()
    const statuses = []
    f.bridge.onStatus((state) => statuses.push(state))
    expect(f.serveClient.call).not.toHaveBeenCalled()
    expect(f.bridge.status()).toBe('off')
    await f.bridge.registerForSession('session-alan', 'alan')
    expect(f.serveClient.call).toHaveBeenCalledExactlyOnceWith('browser.controller.register', {
      session_id: 'session-alan', protocol_version: 1, controller_id: 'hermesdesk:fake-install',
      browser_profile_id: 'ws-agent-alan', capabilities: ACTIONS,
    })
    await f.bridge.registerForSession('session-alan', 'alan')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(f.serveClient.call).toHaveBeenCalledWith('browser.controller.heartbeat', { session_id: 'session-alan' })
    expect(f.bridge.status()).toBe('ready')
    await f.bridge.detach('session-alan')
    expect(f.serveClient.call).toHaveBeenCalledWith('browser.controller.detach', { session_id: 'session-alan' })
    expect(statuses).toEqual(['connecting', 'ready', 'off'])
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(f.serveClient.call.mock.calls.filter(([method]) => method === 'browser.controller.heartbeat')).toHaveLength(1)
    await f.bridge.dispose()
  })

  it('exposes protocol mismatch instead of silently continuing', async () => {
    const f = bridgeFixture()
    f.serveClient.call.mockRejectedValue({ code: 4403, message: 'unsupported browser-control protocol version; expected 2' })
    await expect(f.bridge.registerForSession('session-alan', 'alan')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.bridge.status()).toBe('mismatch')
    f.command('session-alan', 'cmd')
    expect(f.lanes.openTab).not.toHaveBeenCalled()
    await f.bridge.dispose()
  })

  it('returns FIFO results while another lane runs in parallel', async () => {
    const f = bridgeFixture()
    const alan = f.makeTab()
    const scout = f.makeTab('profile:scout')
    await f.bridge.registerForSession('session-alan', 'alan')
    await f.bridge.registerForSession('session-scout', 'scout')
    const pending = deferred()
    alan.wc.hook = (method) => method === 'Accessibility.getFullAXTree' ? pending.promise : undefined
    f.command('session-alan', 'a1')
    f.command('session-alan', 'a2')
    f.command('session-scout', 's1')
    await vi.waitFor(() => expect(f.results().map((res) => res.command_id)).toEqual(['s1']))
    expect(scout.wc.getBackgroundThrottling()).toBe(true)
    expect(alan.wc.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Accessibility.getFullAXTree')).toHaveLength(1)
    alan.wc.hook = null
    pending.resolve({ nodes: alan.ax })
    await vi.waitFor(() => expect(f.results().map((res) => res.command_id)).toEqual(['s1', 'a1', 'a2']))
    expect(f.results()[1]).toMatchObject({ session_id: 'session-alan', ok: true, result: { snapshot: expect.any(String) } })
    expect(f.audit.log).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('FAKE_PASSWORD_VALUE')
    await f.bridge.dispose()
  })

  it.each(['takeover', 'wire'])('cancels the in-flight and queued commands on %s without more CDP', async (kind) => {
    const f = bridgeFixture()
    const alan = f.makeTab()
    await f.bridge.registerForSession('session-alan', 'alan')
    const pending = deferred()
    alan.wc.hook = (method) => method === 'Accessibility.getFullAXTree' ? pending.promise : undefined
    f.command('session-alan', 'a1')
    f.command('session-alan', 'a2')
    await vi.waitFor(() => expect(alan.wc.getBackgroundThrottling()).toBe(false))
    if (kind === 'takeover') {
      f.paused.add('profile:alan')
      f.bridge.cancelLane('profile:alan', 'user_took_control')
    } else {
      f.event('browser.controller.cancel', { session_id: 'session-alan', payload: { command_id: 'a1', tool_call_id: 'tool-a1' } })
    }
    await vi.waitFor(() => expect(f.results()).toHaveLength(2))
    expect(f.results().every((result) => result.ok === false)).toBe(true)
    if (kind === 'takeover') expect(f.results().every((result) => result.error.code === 'user_took_control')).toBe(true)
    expect(f.audit.log).toHaveBeenCalledTimes(2)
    expect(alan.wc.getBackgroundThrottling()).toBe(true)
    pending.resolve({ nodes: alan.ax })
    await Promise.resolve()
    expect(alan.wc.debugger.sendCommand).not.toHaveBeenCalledWith('DOM.getDocument', expect.anything())
    await f.bridge.dispose()
  })

  it('requires session envelope identity, rejects cross-session cancels, and ignores duplicate commands', async () => {
    const f = bridgeFixture()
    f.makeTab()
    await f.bridge.registerForSession('session-alan', 'alan')
    f.command('foreign-session', 'foreign')
    f.event('browser.controller.command', { command_id: 'missing-envelope', action: 'browser_snapshot', arguments: {} })
    f.command('session-alan', 'valid')
    f.command('session-alan', 'valid')
    f.event('browser.controller.cancel', { session_id: 'foreign', payload: { command_id: 'valid' } })
    await vi.waitFor(() => expect(f.results()).toHaveLength(1))
    expect(f.results()[0]).toMatchObject({ command_id: 'valid', ok: true })
    await f.bridge.dispose()
  })

  it('opens a tab lazily and restores registration only for requested sessions on reconnect', async () => {
    const f = bridgeFixture()
    await f.bridge.registerForSession('session-alan', 'alan')
    f.command('session-alan', 'new-tab')
    await vi.waitFor(() => expect(f.results()).toHaveLength(1))
    expect(f.lanes.openTab).toHaveBeenCalledWith('profile:alan', undefined, { createdBy: 'agent' })
    f.connection(false)
    expect(f.bridge.status()).toBe('connecting')
    f.connection(true)
    await vi.waitFor(() => expect(f.bridge.status()).toBe('ready'))
    expect(f.serveClient.call.mock.calls.filter(([method]) => method === 'browser.controller.register')).toHaveLength(2)
    await f.bridge.dispose()
  })

  it('does not register a different profile under an existing session', async () => {
    const f = bridgeFixture()
    await f.bridge.registerForSession('session-alan', 'alan')
    await expect(f.bridge.registerForSession('session-alan', 'scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.lanes.ensureLane).not.toHaveBeenCalledWith('profile:scout')
    await f.bridge.dispose()
  })

  it('does not create an empty-lane tab merely to enumerate tabs', async () => {
    const f = bridgeFixture()
    await f.bridge.registerForSession('session-alan', 'alan')
    f.command('session-alan', 'tabs', 'browser_tabs')
    await vi.waitFor(() => expect(f.results()).toHaveLength(1))
    expect(f.results()[0]).toMatchObject({ ok: true, result: { tabs: [] } })
    expect(f.lanes.openTab).not.toHaveBeenCalled()
    await f.bridge.dispose()
  })

  it('audits and reports unsupported actions with a typed error and no page content', async () => {
    const f = bridgeFixture()
    const { wc } = f.makeTab()
    await f.bridge.registerForSession('session-alan', 'alan')
    f.command('session-alan', 'raw-cdp', 'browser_evaluate', { expression: 'FAKE_PRIVATE_SCRIPT' })
    await vi.waitFor(() => expect(f.results()).toHaveLength(1))
    expect(f.results()[0]).toMatchObject({ ok: false, error: { code: 'bad_args' } })
    expect(wc.debugger.attach).not.toHaveBeenCalled()
    expect(f.audit.log.mock.calls[0][0].action).toBe('unsupported')
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('FAKE_PRIVATE_SCRIPT')
    await f.bridge.dispose()
  })

  it('cancels a stalled command at the broker deadline and lets later work run', async () => {
    vi.useFakeTimers()
    const f = bridgeFixture()
    const { wc } = f.makeTab()
    await f.bridge.registerForSession('session-alan', 'alan')
    wc.hook = (method) => method === 'Accessibility.getFullAXTree' ? new Promise(() => {}) : undefined
    f.command('session-alan', 'stalled')
    await vi.advanceTimersByTimeAsync(1001)
    expect(f.results()[0]).toMatchObject({ command_id: 'stalled', error: { code: 'timeout' } })
    expect(wc.getBackgroundThrottling()).toBe(true)
    wc.hook = null
    f.command('session-alan', 'next')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.results()[1]).toMatchObject({ command_id: 'next', ok: true })
    await f.bridge.dispose()
  })

  it('rejects mismatched negotiated scope and handles late registration after detach', async () => {
    const f = bridgeFixture()
    const registration = deferred()
    f.serveClient.call.mockImplementation(async (method) => {
      if (method === 'browser.controller.register') return registration.promise
      return { detached: true }
    })
    const registering = f.bridge.registerForSession('session-alan', 'alan')
    await f.bridge.detach('session-alan')
    registration.resolve({ scope: {} })
    await registering
    expect(f.bridge.status()).toBe('off')
    expect(f.serveClient.call).toHaveBeenCalledWith('browser.controller.detach', { session_id: 'session-alan' })
    await f.bridge.dispose()
  })
})
