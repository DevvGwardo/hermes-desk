import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notificationsEnabled,
  notify,
  onNotificationClick,
  previewText,
  resetSystemNotifyForTests,
  setNotificationsEnabled,
} from '../system-notify'

function setFront(front: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front ? 'visible' : 'hidden') })
  vi.spyOn(document, 'hasFocus').mockReturnValue(front)
}

beforeEach(() => {
  resetSystemNotifyForTests()
  window.localStorage.clear()
})
afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  vi.unstubAllGlobals()
})

describe('notify (desktop bridge)', () => {
  it('posts through the main process when the app is not in front, and routes the click', async () => {
    let click: ((v: unknown) => void) | undefined
    const bridge = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { notify: bridge, onNotifyClick: (cb: (v: unknown) => void) => ((click = cb), () => {}) }
    setFront(false)
    const opened = vi.fn()
    onNotificationClick(opened)
    expect(await notify({ title: 'Phoenix', body: 'Done', target: { kind: 'conversation', id: 'c1' }, tag: 'reply:1' })).toBe(true)
    expect(bridge).toHaveBeenCalledWith({ title: 'Phoenix', body: 'Done', target: { kind: 'conversation', id: 'c1' }, force: undefined })
    click!({ target: { kind: 'conversation', id: 'c1' } })
    expect(opened).toHaveBeenCalledWith({ kind: 'conversation', id: 'c1' })
  })

  it('stays quiet while the app is in front, when switched off, and for a repeat', async () => {
    const bridge = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { notify: bridge }
    setFront(true)
    expect(await notify({ title: 'a' })).toBe(false)
    setFront(false)
    setNotificationsEnabled(false)
    expect(notificationsEnabled()).toBe(false)
    expect(await notify({ title: 'a' })).toBe(false)
    setNotificationsEnabled(true)
    expect(await notify({ title: 'a', tag: 't' })).toBe(true)
    expect(await notify({ title: 'a', tag: 't' })).toBe(false)
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('a test (force) posts even with the app in front', async () => {
    const bridge = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { notify: bridge }
    setFront(true)
    expect(await notify({ title: 'Nub Agent', force: true })).toBe(true)
  })
})

describe('notify (browser)', () => {
  it('uses the Notification API only once allowed', async () => {
    const created: Array<{ title: string; onclick?: () => void }> = []
    class FakeNotification {
      static permission: NotificationPermission = 'default'
      onclick?: () => void
      title: string
      constructor(title: string) {
        this.title = title
        created.push(this)
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    setFront(false)
    expect(await notify({ title: 'x' })).toBe(false)
    FakeNotification.permission = 'granted'
    const opened = vi.fn()
    onNotificationClick(opened)
    expect(await notify({ title: 'x', target: { kind: 'routines', id: 'j1' } })).toBe(true)
    created[0]!.onclick!()
    expect(opened).toHaveBeenCalledWith({ kind: 'routines', id: 'j1' })
  })
})

describe('previewText', () => {
  it('turns markdown into one readable line', () => {
    expect(previewText('# Done\n\nSee **this** [link](https://x.y) and ![img](a.png)\n```js\nx()\n```')).toBe(
      'Done See this link and [image] [code]',
    )
    expect(previewText('a'.repeat(300)).length).toBe(140)
  })
})
