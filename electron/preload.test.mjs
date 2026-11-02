import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

function load() {
  let api
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = vi.fn(async () => undefined)
  runInNewContext(readFileSync(require.resolve('./preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value } }, ipcRenderer }),
    process: { platform: 'darwin', versions: {} }, URL, Uint8Array, ArrayBuffer,
  })
  return { api, ipcRenderer }
}

describe('local desktop preload contracts', () => {
  it('exposes only a write-only clipboard method mapped to its exact channel', async () => {
    const { api, ipcRenderer } = load()
    expect(Object.keys(api.clipboard ?? {})).toEqual(['writeText'])
    await api.clipboard.writeText('Obviously fake text')
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('hd:clipboard:writeText', 'Obviously fake text')
  })

  it('maps every host, workspace and computer method to one exact invoke channel', async () => {
    const { api, ipcRenderer } = load()
    const cases = [
      ['media', 'open', ['/fake/clip.mp4']], ['media', 'release', ['hd-media://fixture/media']],
      ['localFiles', 'pickMedia', []], ['localFiles', 'saveAs', ['/fake/clip.mp4']],
      ['localFiles', 'releaseImport', ['/fake/imported.mp4']],
      ['host', 'status', []], ['host', 'restartServe', []], ['host', 'enableBrowserControl', [['fake-profile']]],
      ['host', 'disableBrowserControl', [['fake-profile']]],
      ['host', 'getConfig', []], ['host', 'setConfig', [{ serve: { port: 9128 } }]], ['host', 'auditTail', [25]],
      ['host', 'sidebarActivity', []], ['host', 'secretsMetadata', []],
      ['host', 'revokeOrigin', ['https://example.invalid']],
      ['host', 'setProfileSoul', ['fake-profile', 'Fake personality']],
      ['attachments', 'pickAndUpload', [{ profile: 'fake-profile', sessionId: 'fake-session' }]],
      ['workspace', 'registerSession', [{ profile: 'scout', storedId: 'fake-stored', runtimeId: 'fake-runtime' }]],
      ['workspace', 'stopAll', []],
      ['workspace', 'setBounds', [{ x: 1, y: 2, width: 3, height: 4 }]], ['workspace', 'setVisible', [true]],
      ['workspace', 'list', []], ['workspace', 'openTab', ['you', 'https://example.invalid']],
      ['workspace', 'closeTab', ['t_1']], ['workspace', 'activate', ['t_1']], ['workspace', 'focusLane', ['you']],
      ['workspace', 'navigate', ['t_1', 'fake search']], ['workspace', 'back', ['t_1']],
      ['workspace', 'forward', ['t_1']], ['workspace', 'reload', ['t_1']],
      ['workspace', 'giveToAgent', ['t_1', 'fake-profile', 'fake instruction']],
      ['workspace', 'returnToUser', ['t_1']], ['workspace', 'resumeAgent', ['profile:fake-profile']],
      ['workspace', 'takeControl', ['t_1']],
      ['workspace', 'readerPreview', ['t_1']],
      ['workspace', 'copySignIn', ['https://example.invalid', 'you', 'profile:fake-profile']],
      ['workspace', 'clearLaneData', ['profile:fake-profile']],
      ['computer', 'open', ['fake-profile']], ['computer', 'close', []], ['computer', 'takeControl', []],
      ['computer', 'open', ['fake-profile', { docked: false }]],
      ['computer', 'paste', []],
    ]
    for (const [group, method, args] of cases) {
      await api[group][method](...args)
      expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(`hd:${group === 'workspace' ? 'ws' : group === 'localFiles' ? 'files' : group}:${method}`, ...args)
    }
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(cases.length)
  })

  it('rejects malformed PiP placement without sending IPC', async () => {
    const { api, ipcRenderer } = load()
    for (const options of [null, [], { docked: 'false' }, { docked: false, url: 'https://example.invalid' }, {}]) {
      await expect(api.computer.open('fake-profile', options)).rejects.toThrow('docked')
    }
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('subscribes to payloads only and each unsubscribe removes only its own listener', () => {
    const { api, ipcRenderer } = load()
    for (const [group, method, channel] of [
      ['host', 'onStatus', 'hd:host:status-changed'], ['workspace', 'onState', 'hd:ws:state'],
      ['workspace', 'onShortcut', 'hd:ws:shortcut'],
      ['computer', 'onState', 'hd:computer:state'], ['computer', 'onFrame', 'hd:computer:frame'],
    ]) {
      const first = vi.fn(); const second = vi.fn()
      const off = api[group][method](first)
      const offSecond = api[group][method](second)
      ipcRenderer.emit(channel, { fakeEvent: true }, { fakePayload: true })
      expect(first).toHaveBeenCalledWith({ fakePayload: true })
      off()
      ipcRenderer.emit(channel, {}, { fakePayload: false })
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(2)
      offSecond()
      expect(ipcRenderer.listenerCount(channel)).toBe(0)
    }
  })

  it('does not expose platform linking, VM, or updater methods', () => {
    const { api } = load()
    expect(Object.keys(api).some((key) => /^nub|update|onUpdate/.test(key))).toBe(false)
    expect(api).toHaveProperty('hud')
    expect(api).toHaveProperty('serveSocket')
    expect(api).toHaveProperty('secretsCopy')
  })
})
