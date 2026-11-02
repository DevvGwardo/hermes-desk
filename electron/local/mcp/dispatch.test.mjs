import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDispatch, agentColor } from './dispatch.cjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const disposals = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  vi.useRealTimers()
})

function fixture(options = {}) {
  const lanes = new EventEmitter()
  const tabs = new Map()
  const active = new Map()
  const paused = new Set()
  let counter = 0
  lanes.ensureLane = vi.fn((id) => ({ id }))
  lanes.getTab = (id) => tabs.get(id)
  lanes.getActiveTab = (laneId) => tabs.get(active.get(laneId))
  lanes.listTabs = (laneId) => [...tabs.values()].filter((tab) => tab.laneId === laneId)
  lanes.isPaused = (laneId) => paused.has(laneId)
  function tab(laneId) {
    const entry = { id: `t_${++counter}`, laneId, url: 'https://example.invalid/path?fake=unused', title: 'Fixture' }
    tabs.set(entry.id, entry)
    active.set(laneId, entry.id)
    return entry
  }
  lanes.openTab = vi.fn(async (id) => tab(id))
  lanes.closeTab = vi.fn((id) => {
    tabs.delete(id)
    for (const [laneId, activeId] of active) if (activeId === id) active.delete(laneId)
  })
  const executor = { run: vi.fn(async () => ({ url: 'https://example.invalid', title: 'Fixture' })), dispose: vi.fn() }
  const audit = { log: vi.fn() }
  const config = { workspace: { enabledProfiles: ['alpha', 'beta'] } }
  const serveClient = { call: vi.fn(async () => ({})) }
  const dispatch = createDispatch({ lanes, audit, getConfig: () => config, serveClient,
    redactor: { scrubText: (text) => text.replaceAll('OBVIOUSLY_FAKE_TOKEN', '[secret]') },
    createExecutor: () => executor, ...options })
  disposals.push(dispatch.dispose)
  const call = (profile = 'alpha', name = 'browser_back', args = {}, callId = `call-${++counter}`, context) =>
    dispatch.call({ profile, name, arguments: args, callId }, context)
  return { dispatch, call, lanes, tabs, active, paused, tab, executor, audit, config, serveClient }
}

describe('MCP browser dispatch', () => {
  it('renders structured data through the same gated queue without opening a tab or invoking CDP', async () => {
    const f = fixture()
    const args = { version: 1, components: [{ type: 'stat', title: 'Tasks', value: '3' }] }
    const result = await f.call('alpha', 'render_ui', args, 'reused-provider-id')
    const genuiOccurrence = result.structuredContent.genuiOccurrence
    expect(genuiOccurrence).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ genui: args, genuiOccurrence }) }],
      structuredContent: { genui: args, genuiOccurrence }, isError: false })
    const repeated = await f.call('alpha', 'render_ui', args, 'reused-provider-id')
    expect(repeated.structuredContent.genui).toEqual(args)
    expect(repeated.structuredContent.genuiOccurrence).not.toBe(genuiOccurrence)
    expect(f.lanes.openTab).not.toHaveBeenCalled()
    expect(f.executor.run).not.toHaveBeenCalled()
    expect(f.audit.log).toHaveBeenCalledWith(expect.objectContaining({ agent: 'alpha', action: 'render_ui', tab: null, result: 'ok' }))
    expect((await f.call('disabled', 'render_ui', args)).isError).toBe(true)
    f.paused.add('profile:alpha')
    expect((await f.call('alpha', 'render_ui', args)).content[0].text).toMatch(/^user_took_control:/)
    expect((await f.call('beta', 'render_ui', { ...args, action: 'browser_navigate' })).isError).toBe(true)
    expect((await f.call('beta', 'render_ui', { ...args, genuiOccurrence })).isError).toBe(true)
    expect(f.executor.run).not.toHaveBeenCalled()
  })

  it('keeps data renders behind active browser work and applies queued cancellation and enable/resource fences', async () => {
    const f = fixture({ maxQueuedCallsPerLane: 2 })
    const block = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call()
    await entered.promise
    const args = { version: 1, components: [{ type: 'stat', title: 'Tasks', value: '3' }] }
    const second = f.call('alpha', 'render_ui', args, 'render')
    expect((await f.call('alpha', 'render_ui', args)).content[0].text).toMatch(/^resource_limit:/)
    f.dispatch.cancel('render')
    expect((await second).content[0].text).toMatch(/^blocked_by_policy:/)
    const revoked = f.call('alpha', 'render_ui', args)
    f.config.workspace.enabledProfiles = ['beta']
    block.resolve()
    await first
    expect((await revoked).content[0].text).toMatch(/^not_enabled:/)
    expect(f.executor.run).toHaveBeenCalledTimes(1)
  })

  it('gates invalid and disabled profiles before creating a lane or executing, and audits failures', async () => {
    const f = fixture()
    expect(await f.call('../alpha')).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^bad_args:/) }] })
    expect(await f.call({ toString: 'invalid' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^bad_args:/) }] })
    expect(await f.call('disabled')).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^not_enabled:/) }] })
    expect(f.lanes.ensureLane).not.toHaveBeenCalled()
    expect(f.executor.run).not.toHaveBeenCalled()
    expect(f.audit.log).toHaveBeenCalledTimes(3)
  })

  it('opens only the profile lane without a user-created tab and passes ghost cursor identity', async () => {
    const f = fixture({ getAgentMeta: () => ({ name: 'Alpha Agent', color: '#123456' }) })
    await f.call()
    expect(f.lanes.openTab).toHaveBeenCalledWith('profile:alpha', undefined, { createdBy: 'agent' })
    expect(f.executor.run).toHaveBeenCalledWith(expect.objectContaining({ laneId: 'profile:alpha' }), 'browser_back', {}, {
      signal: expect.any(AbortSignal), agent: { profile: 'alpha', name: 'Alpha Agent', color: '#123456' },
    })
  })

  it('falls back to a stable profile name and hashed colour', async () => {
    const f = fixture()
    await f.call()
    expect(f.executor.run.mock.calls[0][3].agent).toEqual({ profile: 'alpha', name: 'alpha', color: agentColor('alpha') })
    expect(agentColor('alpha')).toMatch(/^#[a-f0-9]{6}$/)
  })

  it('runs one command per lane FIFO while other lanes run in parallel', async () => {
    const f = fixture()
    const first = deferred()
    const entered = deferred()
    f.executor.run.mockImplementation(async (_tab, _name, _args, { agent }) => {
      if (agent.profile === 'alpha' && f.executor.run.mock.calls.length === 1) {
        entered.resolve()
        await first.promise
      }
      return { text: agent.profile }
    })
    const a1 = f.call('alpha')
    await entered.promise
    const a2 = f.call('alpha')
    const b1 = f.call('beta')
    expect((await b1).isError).toBeUndefined()
    expect(f.executor.run.mock.calls.map(([tab]) => tab.laneId)).toEqual(['profile:alpha', 'profile:beta'])
    first.resolve()
    await Promise.all([a1, a2])
    expect(f.executor.run.mock.calls.map(([tab]) => tab.laneId)).toEqual(['profile:alpha', 'profile:beta', 'profile:alpha'])
  })

  it('cancels queued calls by callId without cancelling a different call in the lane', async () => {
    const f = fixture()
    const block = deferred()
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call('alpha', 'browser_back', {}, 'first')
    await entered.promise
    const second = f.call('alpha', 'browser_back', {}, 'second')
    f.dispatch.cancel('second')
    expect(await second).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^blocked_by_policy:/) }] })
    block.resolve()
    await first
    expect(f.executor.run).toHaveBeenCalledTimes(1)
  })

  it('aborts active calls immediately but does not run the next until the executor unwinds', async () => {
    const f = fixture()
    const unwind = deferred()
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await unwind.promise; return { text: 'late' } })
    const first = f.call('alpha', 'browser_back', {}, 'first')
    await entered.promise
    const second = f.call('alpha', 'browser_back', {}, 'second')
    f.dispatch.cancel('first')
    expect((await first).isError).toBe(true)
    expect(f.executor.run.mock.calls[0][3].signal.aborted).toBe(true)
    expect(f.executor.run).toHaveBeenCalledTimes(1)
    unwind.resolve()
    await second
    expect(f.executor.run).toHaveBeenCalledTimes(2)
    expect(f.audit.log).toHaveBeenCalledTimes(2)
  })

  it('scopes cancellation and duplicate call IDs to their connection', async () => {
    const f = fixture()
    const owners = [{}, {}]
    const blocks = [deferred(), deferred()]
    const entered = deferred()
    f.executor.run.mockImplementation(async (tab) => {
      if (f.executor.run.mock.calls.length === 2) entered.resolve()
      await blocks[tab.laneId === 'profile:alpha' ? 0 : 1].promise
      return {}
    })
    const first = f.call('alpha', 'browser_back', {}, 'same', { owner: owners[0] })
    const second = f.call('beta', 'browser_back', {}, 'same', { owner: owners[1] })
    await entered.promise
    f.dispatch.cancel('same', { owner: {} })
    expect(f.executor.run.mock.calls.every((args) => !args[3].signal.aborted)).toBe(true)
    f.dispatch.cancel('same', { owner: owners[0] })
    expect((await first).isError).toBe(true)
    expect(f.executor.run.mock.calls[1][3].signal.aborted).toBe(false)
    blocks.forEach((block) => block.resolve())
    await second
  })

  it('rejects active and queued calls on takeover, gates paused lanes, and steers only the owning runtime session', async () => {
    const sessionLookup = vi.fn((profile) => profile === 'alpha' ? 'runtime-alpha' : null)
    const f = fixture({ getSessionForProfile: sessionLookup })
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async (_tab, _name, _args, { signal }) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {}
    })
    const first = f.call('alpha')
    await entered.promise
    const second = f.call('alpha')
    f.paused.add('profile:alpha')
    f.lanes.emit('changed')
    f.lanes.emit('user-input', { laneId: 'profile:alpha', tabId: 't_1' })
    for (const result of await Promise.all([first, second, f.call('alpha')])) {
      expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^user_took_control:/) }] })
    }
    expect(sessionLookup).toHaveBeenCalledWith('alpha')
    await vi.waitFor(() => expect(f.serveClient.call).toHaveBeenCalledWith('session.steer', {
      session_id: 'runtime-alpha', text: expect.stringContaining('User took control of tab t_1'),
    }))
    await f.call('beta')
    expect(f.executor.run).toHaveBeenCalledTimes(2)
  })

  it('rechecks the enabled-profile gate after a queued call is admitted', async () => {
    const f = fixture()
    const block = deferred()
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call('alpha')
    await entered.promise
    const second = f.call('alpha')
    f.config.workspace.enabledProfiles = ['beta']
    block.resolve()
    for (const result of await Promise.all([first, second])) expect(result.content[0].text).toMatch(/^not_enabled:/)
    expect(f.executor.run).toHaveBeenCalledTimes(1)
  })

  it('returns screenshots as JPEG image content and snapshots as text, never audit content', async () => {
    const f = fixture()
    const data = Buffer.from('OBVIOUSLY_FAKE_JPEG').toString('base64')
    f.executor.run.mockResolvedValueOnce({ screenshot: `data:image/jpeg;base64,${data}` })
    expect(await f.call('alpha', 'browser_screenshot')).toEqual({ content: [{ type: 'image', data, mimeType: 'image/jpeg' }] })
    f.executor.run.mockResolvedValueOnce({ snapshot: '[ref=e1] button "Fixture"' })
    expect(await f.call('alpha', 'browser_snapshot')).toEqual({ content: [{ type: 'text', text: '[ref=e1] button "Fixture"' }] })
    const audit = JSON.stringify(f.audit.log.mock.calls)
    expect(audit).not.toContain(data)
    expect(audit).not.toContain('[ref=e1]')
    expect(audit).not.toContain('/path')
  })

  it('fails closed for malformed screenshot and snapshot results', async () => {
    const f = fixture()
    f.executor.run.mockResolvedValueOnce({ screenshot: 'data:image/png;base64,AAAA' })
    expect((await f.call('alpha', 'browser_screenshot')).isError).toBe(true)
    f.executor.run.mockResolvedValueOnce({})
    expect((await f.call('alpha', 'browser_snapshot')).isError).toBe(true)
  })

  it('keeps secret-fill results metadata-free and excludes arguments from audits', async () => {
    const f = fixture()
    f.executor.run.mockResolvedValueOnce({ text: 'typed [secret]', url: 'https://example.invalid/OBVIOUSLY_FAKE_TOKEN', title: 'OBVIOUSLY_FAKE_TOKEN' })
    expect(await f.call('alpha', 'browser_type', { ref: '@e1', text: '{{secret:fake-password}}' })).toEqual({
      content: [{ type: 'text', text: 'typed [secret]' }],
    })
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('fake-password')
  })

  it.each(['user_took_control', 'blocked_by_policy', 'timeout', 'no_such_ref', 'tab_closed', 'bad_args'])(
    'maps %s failures to model-visible safe text rather than raw errors', async (code) => {
      const f = fixture()
      f.executor.run.mockRejectedValueOnce(Object.assign(new Error('OBVIOUSLY_FAKE_TOKEN'), { code }))
      const result = await f.call()
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(new RegExp(`^${code}:`))
      expect(JSON.stringify(result)).not.toContain('OBVIOUSLY_FAKE_TOKEN')
    },
  )

  it('lists an empty lane without opening a tab and rejects activation outside its lane', async () => {
    const f = fixture()
    expect(await f.call('alpha', 'browser_tabs')).toEqual({ content: [{ type: 'text', text: '[]' }] })
    const other = f.tab('profile:beta')
    expect((await f.call('alpha', 'browser_tab_activate', { id: other.id })).content[0].text).toMatch(/^bad_args:/)
    expect(f.lanes.openTab).not.toHaveBeenCalled()
    expect(f.executor.run).not.toHaveBeenCalled()
  })

  it('validates actions, arguments, and unique call IDs before execution', async () => {
    const f = fixture()
    expect((await f.call('alpha', 'browser_evaluate')).content[0].text).toMatch(/^bad_args:/)
    expect((await f.call('alpha', 'browser_type', { text: 'fake' })).isError).toBe(true)
    expect((await f.call('alpha', 'browser_back', {}, '')).isError).toBe(true)
    expect((await f.call('alpha', 'browser_back', null)).isError).toBe(true)
    expect((await f.dispatch.call(null)).isError).toBe(true)
    expect(f.executor.run).not.toHaveBeenCalled()
  })

  it('includes scrubbed URL/title for short action results and lists only executor-returned lane tabs', async () => {
    const f = fixture()
    const tab = f.tab('profile:alpha')
    tab.title = 'OBVIOUSLY_FAKE_TOKEN'
    f.executor.run.mockResolvedValueOnce({ text: 'pressed' })
    const pressed = await f.call('alpha', 'browser_press', { key: 'Enter' })
    expect(pressed.content[0].text).toBe(`pressed\n${tab.url}\n[secret]`)
    const tabs = [{ id: tab.id, url: tab.url, title: 'Fixture', active: true }]
    f.executor.run.mockResolvedValueOnce({ tabs })
    expect(JSON.parse((await f.call('alpha', 'browser_tabs')).content[0].text)).toEqual(tabs)
  })

  it('times out a command and releases the lane after abort', async () => {
    const f = fixture({ commandTimeoutMs: 100 })
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async (_tab, _name, _args, { signal }) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {}
    })
    vi.useFakeTimers()
    const first = f.call()
    await entered.promise
    await vi.advanceTimersByTimeAsync(100)
    expect((await first).content[0].text).toMatch(/^timeout:/)
    vi.useRealTimers()
    expect((await f.call()).isError).toBeUndefined()
  })

  it('aborts disconnected clients and removes takeover listeners on dispose', async () => {
    const f = fixture()
    const entered = deferred()
    f.executor.run.mockImplementationOnce(async (_tab, _name, _args, { signal }) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {}
    })
    const connection = new AbortController()
    const result = f.call('alpha', 'browser_back', {}, 'disconnect', { signal: connection.signal })
    await entered.promise
    connection.abort()
    expect((await result).content[0].text).toMatch(/^blocked_by_policy:/)
    await f.dispatch.dispose()
    expect(f.lanes.listenerCount('user-input')).toBe(0)
    expect(f.lanes.listenerCount('changed')).toBe(0)
    expect(f.executor.dispose).toHaveBeenCalledOnce()
    expect((await f.call()).content[0].text).toMatch(/^app_unavailable:/)
  })

  it('HD-07 caps all admitted work across owners and lanes, retaining capacity until an aborted executor unwinds', async () => {
    const f = fixture({ maxQueuedCalls: 3, maxQueuedCallsPerLane: 2 })
    const block = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call('alpha', 'browser_back', {}, 'first', { owner: {} })
    await entered.promise
    const second = f.call('alpha', 'browser_back', {}, 'second', { owner: {} })
    expect((await f.call('alpha')).content[0].text).toMatch(/^resource_limit:/)
    // Keep Beta queued/active while Alpha is blocked.
    const betaBlock = deferred(), betaEntered = deferred()
    f.executor.run.mockImplementationOnce(async () => { betaEntered.resolve(); await betaBlock.promise; return {} })
    const beta = f.call('beta', 'browser_back', {}, 'beta', { owner: {} })
    await betaEntered.promise
    expect((await f.call('beta')).content[0].text).toMatch(/^resource_limit:/)
    f.dispatch.cancelLane('profile:alpha', 'blocked_by_policy')
    expect((await first).isError).toBe(true)
    expect((await second).isError).toBe(true)
    // Alpha's cancelled active call still consumes one global/lane slot.
    const replacement = f.call('alpha')
    expect((await f.call('alpha')).content[0].text).toMatch(/^resource_limit:/)
    expect(f.executor.run).toHaveBeenCalledTimes(2)
    block.resolve()
    expect((await replacement).isError).toBeUndefined()
    betaBlock.resolve()
    await beta
    expect((await f.call('beta')).isError).toBeUndefined()
  })

  it('HD-07 starts deadlines at admission, expires queued work, and keeps the active lane locked', async () => {
    const f = fixture({ commandTimeoutMs: 100, maxQueuedCalls: 2 })
    const block = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    vi.useFakeTimers()
    const first = f.call()
    await entered.promise
    await vi.advanceTimersByTimeAsync(10)
    const queued = f.call()
    await vi.advanceTimersByTimeAsync(90)
    expect((await first).content[0].text).toMatch(/^timeout:/)
    await vi.advanceTimersByTimeAsync(10)
    expect((await queued).content[0].text).toMatch(/^timeout:/)
    expect(f.executor.run).toHaveBeenCalledTimes(1)
    expect(f.audit.log).toHaveBeenCalledTimes(2)
    const replacement = f.call()
    expect((await f.call('beta')).content[0].text).toMatch(/^resource_limit:/)
    expect(f.executor.run).toHaveBeenCalledTimes(1)
    block.resolve()
    expect((await replacement).isError).toBeUndefined()
    vi.useRealTimers()
    expect((await f.call('beta')).isError).toBeUndefined()
  })

  it('HD-07 rejects oversized arguments before queue admission and freezes admitted arguments', async () => {
    const f = fixture({ maxArgumentBytes: 64 })
    expect((await f.call('alpha', 'browser_type', { ref: 'e1', text: 'é'.repeat(100) })).content[0].text)
      .toMatch(/^resource_limit:/)
    expect(f.lanes.ensureLane).not.toHaveBeenCalled()
    const block = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call()
    await entered.promise
    const args = { ref: 'e1', text: 'fake' }
    const second = f.call('alpha', 'browser_type', args)
    args.text = 'changed-after-admission'
    block.resolve()
    await Promise.all([first, second])
    expect(f.executor.run.mock.calls[1][2].text).toBe('fake')
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('changed-after-admission')
  })

  it('HD-07 bounds unresolved active dependencies even after repeated cancellation by new clients', async () => {
    const f = fixture({ maxQueuedCalls: 1 })
    const block = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); await block.promise; return {} })
    const first = f.call('alpha', 'browser_back', {}, 'same', { owner: {} })
    await entered.promise
    f.dispatch.cancelLane('profile:alpha')
    expect((await first).isError).toBe(true)
    for (let i = 0; i < 5; i++) {
      expect((await f.call('beta', 'browser_back', {}, `new-${i}`, { owner: {} })).content[0].text)
        .toMatch(/^resource_limit:/)
    }
    block.resolve()
    await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => expect((await f.call('beta')).isError).toBeUndefined())
  })

  it('C9 tears down a stuck tab before releasing its lane, ignores late results, and bounds disposal', async () => {
    vi.useFakeTimers()
    const f = fixture({ commandTimeoutMs: 100, abortGraceMs: 20 })
    const stuck = deferred(), entered = deferred()
    f.executor.run.mockImplementationOnce(async () => { entered.resolve(); return stuck.promise })
    const first = f.call('alpha')
    await entered.promise
    const oldTab = f.executor.run.mock.calls[0][0]
    await vi.advanceTimersByTimeAsync(100)
    expect((await first).content[0].text).toMatch(/^timeout:/)
    const second = f.call('alpha')
    expect(f.executor.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(f.lanes.closeTab).toHaveBeenCalledExactlyOnceWith(oldTab.id)
    expect((await second).isError).toBeUndefined()
    expect(f.executor.run.mock.calls[1][0]).not.toBe(oldTab)
    stuck.resolve({ text: 'late unsafe result' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.audit.log).toHaveBeenCalledTimes(2)
    const never = deferred()
    f.executor.run.mockImplementationOnce(() => never.promise)
    const third = f.call('beta')
    await vi.advanceTimersByTimeAsync(0)
    const disposal = f.dispatch.dispose()
    await vi.advanceTimersByTimeAsync(20)
    await disposal
    expect((await third).content[0].text).toMatch(/^app_unavailable:/)
    expect(f.executor.dispose).toHaveBeenCalledOnce()
  })

  it('C9 quarantines a lane when forced tab teardown fails, without blocking other lanes', async () => {
    vi.useFakeTimers()
    const f = fixture({ commandTimeoutMs: 100, abortGraceMs: 20 })
    f.executor.run.mockImplementationOnce(() => new Promise(() => {}))
    f.lanes.closeTab.mockImplementation(() => { throw new Error('fake teardown failure') })
    const first = f.call()
    await vi.advanceTimersByTimeAsync(120)
    expect((await first).content[0].text).toMatch(/^timeout:/)
    expect((await f.call()).content[0].text).toMatch(/^blocked_by_policy:/)
    expect((await f.call('beta')).isError).toBeUndefined()
  })
  it('C9 tears down initialization and activation targets, not an unrelated active tab', async () => {
    vi.useFakeTimers()
    const f = fixture({ commandTimeoutMs: 100, abortGraceMs: 20 })
    const initialization = deferred()
    f.lanes.openTab.mockImplementationOnce((laneId) => {
      const tab = f.tab(laneId)
      return initialization.promise.then(() => tab)
    })
    const first = f.call()
    const initializing = f.lanes.getActiveTab('profile:alpha')
    await vi.advanceTimersByTimeAsync(120)
    expect((await first).content[0].text).toMatch(/^timeout:/)
    expect(f.lanes.closeTab).toHaveBeenCalledWith(initializing.id)
    expect(f.executor.run).not.toHaveBeenCalled()
    initialization.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.executor.run).not.toHaveBeenCalled()
    const target = f.tab('profile:alpha')
    const unrelated = f.tab('profile:alpha')
    f.executor.run.mockImplementationOnce(() => new Promise(() => {}))
    const activation = f.call('alpha', 'browser_tab_activate', { id: target.id })
    await vi.advanceTimersByTimeAsync(120)
    expect((await activation).content[0].text).toMatch(/^timeout:/)
    expect(f.lanes.closeTab).toHaveBeenCalledWith(target.id)
    expect(f.lanes.getTab(unrelated.id)).toBe(unrelated)
  })
})
