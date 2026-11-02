import { describe, expect, it, vi } from 'vitest'
import { createLaneData } from './lane-data.cjs'
import { createLanes } from './lanes.cjs'
import { createUrlPolicy } from './url-policy.cjs'

function fixture() {
  const sessions = new Map()
  const session = { fromPartition(id) {
    if (!sessions.has(id)) sessions.set(id, {
      cookies: { get: vi.fn(async () => []), set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) },
      clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}),
    })
    return sessions.get(id)
  } }
  const urlPolicy = createUrlPolicy()
  const lanes = createLanes({ urlPolicy, createView: () => ({ isDestroyed: () => false }), destroyView: vi.fn() })
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }
  const audit = { log: vi.fn() }
  const data = createLaneData({ lanes, session, urlPolicy, dialog, audit,
    getMainWindow: () => ({ isDestroyed: () => false }), isDisposed: () => false })
  return { lanes, session, sessions, dialog, audit, data, urlPolicy }
}

describe('native consent for lane data', () => {
  it('copies only approved-host cookies, including scoped paths, and never returns cookie values', async () => {
    const f = fixture()
    const source = f.session.fromPartition('persist:ws-user')
    source.cookies.get.mockResolvedValue([
      { name: 'fake-login', value: 'obviously fake cookie', domain: '.example.invalid', path: '/account',
        secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 9999999999 },
      { name: 'other', value: 'obviously fake other cookie', domain: 'other.invalid', path: '/' },
      { name: 'sub', value: 'fake', domain: 'sub.example.invalid', path: '/' },
      { name: 'partitioned', value: 'fake', domain: 'example.invalid', path: '/', partitionKey: 'https://other.invalid' },
    ])
    const result = await f.data.copySignIn('https://example.invalid', 'you', 'profile:scout')
    expect(result).toBeUndefined()
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      message: expect.stringContaining('https://example.invalid'), defaultId: 0, cancelId: 0,
    }))
    expect(source.cookies.get.mock.invocationCallOrder[0]).toBeGreaterThan(f.dialog.showMessageBox.mock.invocationCallOrder[0])
    const target = f.sessions.get('persist:ws-agent-scout')
    expect(target.cookies.set).toHaveBeenCalledExactlyOnceWith({
      url: 'https://example.invalid/account', name: 'fake-login', value: 'obviously fake cookie',
      path: '/account', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 9999999999,
    })
    expect(JSON.stringify(f.audit.log.mock.calls)).not.toContain('obviously fake')
    expect(f.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'copy_sign_in', origin: 'https://example.invalid', result: 'ok', byUser: true,
    }))
    f.lanes.dispose()
  })

  it.each(['deny', 'policy-change', 'error'])('does not copy without valid consent after %s', async (mode) => {
    const f = fixture()
    const source = f.session.fromPartition('persist:ws-user')
    f.dialog.showMessageBox.mockImplementation(async () => {
      if (mode === 'policy-change') f.urlPolicy.check = () => ({ ok: false })
      if (mode === 'error') throw new Error('obviously fake private error')
      return { response: mode === 'deny' ? 0 : 1 }
    })
    await expect(f.data.copySignIn('https://example.invalid', 'you', 'profile:scout')).rejects.toMatchObject({
      code: 'blocked_by_policy', message: 'Sign-in copy did not finish',
    })
    expect(source.cookies.get).not.toHaveBeenCalled()
    expect(f.audit.log).toHaveBeenCalledOnce()
    f.lanes.dispose()
  })

  it('clears only the confirmed agent partition, retaining user and shared-login tabs', async () => {
    const f = fixture()
    const mine = await f.lanes.openTab('you', 'https://fixture.invalid/')
    const shared = await f.lanes.openTab('you', 'https://fixture.invalid/shared')
    f.lanes.moveTab(shared.id, 'profile:scout')
    const privateTab = await f.lanes.openTab('profile:scout', 'https://fixture.invalid/')
    const foreign = await f.lanes.openTab('profile:other', 'https://fixture.invalid/')
    f.session.fromPartition('persist:ws-user')
    f.session.fromPartition('persist:ws-agent-other')
    await f.data.clearLaneData('profile:scout')
    expect(f.lanes.getTab(privateTab.id)).toBeNull()
    expect(f.lanes.getTab(mine.id)).toBe(mine)
    expect(f.lanes.getTab(shared.id)).toBe(shared)
    expect(f.lanes.getTab(foreign.id)).toBe(foreign)
    expect(f.lanes.isPaused('profile:scout')).toBe(true)
    expect(f.sessions.get('persist:ws-agent-scout').clearStorageData).toHaveBeenCalledExactlyOnceWith()
    for (const id of ['persist:ws-user', 'persist:ws-agent-other']) {
      expect(f.sessions.get(id).clearStorageData).not.toHaveBeenCalled()
    }
    expect(f.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'clear_lane_data', result: 'ok' }))
    f.lanes.dispose()
  })

  it('rejects user-lane clears and denies without closing or clearing anything', async () => {
    const f = fixture()
    const tab = await f.lanes.openTab('profile:scout')
    await expect(f.data.clearLaneData('you')).rejects.toMatchObject({ code: 'bad_args' })
    f.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await expect(f.data.clearLaneData('profile:scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    expect(f.lanes.getTab(tab.id)).toBe(tab)
    expect(f.sessions.size).toBe(0)
    f.lanes.dispose()
  })

  it('locks admission until clearing unwinds, including a failed clear', async () => {
    const f = fixture()
    let finish
    const ses = f.session.fromPartition('persist:ws-agent-scout')
    ses.clearStorageData.mockImplementation(() => new Promise((_resolve, reject) => { finish = reject }))
    const clearing = f.data.clearLaneData('profile:scout')
    const assertion = expect(clearing).rejects.toMatchObject({ code: 'blocked_by_policy' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(f.lanes.openTab('profile:scout')).rejects.toMatchObject({ code: 'blocked_by_policy' })
    finish(new Error('fake storage error'))
    await assertion
    await expect(f.lanes.openTab('profile:scout')).resolves.toHaveProperty('id')
    f.lanes.dispose()
  })
})
