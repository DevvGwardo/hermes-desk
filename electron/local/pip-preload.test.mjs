import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'

describe('locked-down Computer PiP renderer', () => {
  it('exposes only five fixed capabilities and strips IPC event/sender details', async () => {
    let exposed
    const listeners = new Map()
    const ipcRenderer = {
      on: vi.fn((name, listener) => listeners.set(name, listener)),
      removeListener: vi.fn((name) => listeners.delete(name)),
      invoke: vi.fn(async () => {}),
    }
    runInNewContext(readFileSync(new URL('./pip-preload.cjs', import.meta.url), 'utf8'), {
      require: (name) => {
        expect(name).toBe('electron')
        return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => {
          expect(name).toBe('computerPip')
          exposed = value
        } } }
      },
    })
    expect(Object.keys(exposed).sort()).toEqual(['close', 'onFrame', 'onState', 'paste', 'takeControl'])
    expect(Object.isFrozen(exposed)).toBe(true)
    const callback = vi.fn()
    const off = exposed.onFrame(callback)
    listeners.get('hd:computer:frame')({ sender: 'FAKE_PRIVATE_SENDER' }, { dataUrl: 'fake-image', ts: 1 })
    expect(callback).toHaveBeenCalledExactlyOnceWith({ dataUrl: 'fake-image', ts: 1 })
    off()
    expect(listeners.size).toBe(0)
    await exposed.takeControl('arbitrary-channel')
    await exposed.paste('FAKE_SECRET_FROM_RENDERER')
    await exposed.close(true)
    await exposed.close()
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ['hd:computer:takeControl'], ['hd:computer:paste'],
      ['hd:computer:close', { dock: true }], ['hd:computer:close'],
    ])
    expect(() => exposed.onState('not-a-function')).toThrow('Callback required')
  })

  it('renders static captures with text-only agent labels, truthful age, controls, and no external image URLs', async () => {
    const callbacks = {}
    const bridge = {
      onState: (cb) => { callbacks.state = cb },
      onFrame: (cb) => { callbacks.frame = cb },
      takeControl: vi.fn(async () => {}),
      paste: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    const dom = new JSDOM(readFileSync(new URL('./pip.html', import.meta.url), 'utf8'), {
      runScripts: 'dangerously', url: 'file:///fake/pip.html',
      beforeParse(window) {
        window.computerPip = bridge
        window.ResizeObserver = class { observe() {} }
        window.setInterval = () => 1
        window.Date.now = () => 20_000
      },
    })
    try {
      const doc = dom.window.document
      callbacks.state({ open: true, mode: 'watching', profile: 'fake-agent', sessionId: 'fake-runtime',
        agentName: '<img src=x onerror=alert(1)>', agentColor: '#aa55cc' })
      expect(doc.querySelector('#agent').textContent).toBe('<img src=x onerror=alert(1)>')
      expect(doc.querySelector('#agent img')).toBeNull()
      callbacks.frame({ dataUrl: 'https://example.invalid/private.png', ts: 8000 })
      expect(doc.querySelector('#image').hasAttribute('src')).toBe(false)
      callbacks.frame({ dataUrl: 'data:image/png;base64,aGVsbG8=', ts: 8000, width: 100, height: 80 })
      expect(doc.querySelector('#age').textContent).toBe('Last capture · 12s ago')
      expect(doc.querySelector('#hint').textContent).toContain('Watching')
      doc.querySelector('#paste').click()
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(bridge.paste).toHaveBeenCalledOnce()
      doc.querySelector('#dock').click()
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(bridge.close).toHaveBeenCalledWith(true)
      callbacks.state({ mode: 'user-control', sessionId: 'fake-runtime' })
      expect(doc.querySelector('#control').disabled).toBe(true)
      expect(doc.querySelector('#paste').disabled).toBe(true)
      expect(doc.querySelector('#hint').textContent).toContain('preview is not live')
      const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain('img-src data:')
    } finally { dom.window.close() }
  })
})
