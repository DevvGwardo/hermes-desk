import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createPermissions } from './permissions.cjs'

function fixture() {
  let url = 'https://fixture.invalid/page'
  const contents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, getURL: () => url })
  const tab = { id: 't_1', laneId: 'you', controller: 'user', partition: 'persist:ws-user' }
  const config = { workspace: { permissions: {} } }
  const setConfig = vi.fn(async patch => {
    for (const [origin, entries] of Object.entries(patch.workspace.permissions)) {
      config.workspace.permissions[origin] = { ...config.workspace.permissions[origin], ...entries }
    }
  })
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: true })) }
  const ses = {
    setPermissionRequestHandler(fn) { this.request = fn },
    setPermissionCheckHandler(fn) { this.check = fn },
    setDevicePermissionHandler(fn) { this.device = fn },
  }
  const permissions = createPermissions({ dialog, getMainWindow: () => ({ isDestroyed: () => false }),
    getTabForContents: wc => wc === contents ? tab : null, getConfig: () => config, setConfig,
    audit: { log: vi.fn() } })
  permissions.install(ses)
  const request = (permission = 'geolocation', details = { requestingUrl: url, isMainFrame: true }) =>
    new Promise(resolve => ses.request(contents, permission, resolve, details))
  return { contents, tab, config, setConfig, dialog, ses, permissions, request,
    navigate(value) { url = value; contents.emit('did-start-navigation', {}, value) } }
}

describe('origin-bound user permissions', () => {
  it('prompts natively, remembers the exact origin, and checks only user-controlled tabs', async () => {
    const f = fixture()
    expect(f.ses.check(f.contents, 'geolocation', 'https://fixture.invalid')).toBe(false)
    expect(await f.request()).toBe(true)
    expect(f.setConfig).toHaveBeenCalledWith({ workspace: { permissions: { 'https://fixture.invalid': { geolocation: true } } } })
    expect(await f.request()).toBe(true)
    expect(f.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(f.ses.check(f.contents, 'geolocation', 'https://fixture.invalid')).toBe(true)
    expect(f.ses.check(f.contents, 'geolocation', 'https://other.invalid')).toBe(false)
    f.tab.controller = 'agent'
    f.tab.laneId = 'profile:scout'
    expect(await f.request()).toBe(false)
    expect(f.ses.check(f.contents, 'geolocation', 'https://fixture.invalid')).toBe(false)
    expect(f.ses.device({ deviceType: 'usb' })).toBe(false)
  })

  it('remembers denials and separates microphone consent from camera consent', async () => {
    const f = fixture()
    f.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    expect(await f.request('media', { mediaTypes: ['audio'], requestingUrl: f.contents.getURL() })).toBe(false)
    expect(f.config.workspace.permissions['https://fixture.invalid']).toEqual({ 'media:audio': false })
    f.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true })
    expect(await f.request('media', { mediaTypes: ['video'], requestingUrl: f.contents.getURL() })).toBe(true)
    expect(f.ses.check(f.contents, 'media', 'https://fixture.invalid', { mediaType: 'video' })).toBe(true)
    expect(f.ses.check(f.contents, 'media', 'https://fixture.invalid', { mediaType: 'audio' })).toBe(false)
    expect(await f.request('media', { mediaTypes: ['audio'], requestingUrl: f.contents.getURL() })).toBe(false)
    expect(await f.request('media', {})).toBe(false)
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it.each(['navigation', 'same-origin-navigation', 'handoff', 'frame', 'dispose'])('refuses an approval after %s changed', async mode => {
    const f = fixture()
    f.dialog.showMessageBox.mockImplementation(async () => {
      if (mode === 'navigation') f.navigate('https://attacker.invalid/')
      if (mode === 'same-origin-navigation') f.navigate('https://fixture.invalid/other')
      if (mode === 'handoff') { f.tab.controller = 'agent'; f.tab.laneId = 'profile:scout' }
      if (mode === 'dispose') f.permissions.dispose()
      return { response: 1, checkboxChecked: true }
    })
    expect(await f.request('geolocation', mode === 'frame' ?
      { requestingUrl: 'https://attacker.invalid/', isMainFrame: false } : undefined)).toBe(false)
    expect(f.setConfig).not.toHaveBeenCalled()
  })
})
