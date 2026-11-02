import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

// Regression: the transcript stopped following new messages on the website.
// Browser-initiated `scroll` events (scroll anchoring, content-visibility rows
// swapping their 88px estimate for a real height) were read as "the user
// scrolled up", which disarmed stick-to-bottom, so replies landed off-screen.

let roCallbacks: Array<() => void> = []

class FakeResizeObserver {
  private cb: () => void
  constructor(cb: () => void) {
    this.cb = cb
    roCallbacks.push(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    roCallbacks = roCallbacks.filter((c) => c !== this.cb)
  }
}

function fireResize() {
  for (const cb of roCallbacks) cb()
}

beforeEach(() => {
  cleanup()
  roCallbacks = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      addEventListener: () => {},
      removeListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function msg(
  partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>,
): ChatMessage {
  return { threadId: 't1', createdAt: '2026-09-22T12:00:00Z', ...partial }
}

const BASE = [
  msg({ id: 'u1', role: 'user', content: 'should i get claude or gpt' }),
  msg({ id: 'a1', role: 'agent', content: 'depends what you want it for' }),
]

/** Give the scroller controllable layout metrics (jsdom has no layout). */
function metrics(el: HTMLElement, init: { scrollHeight: number; clientHeight: number }) {
  const m = { scrollHeight: init.scrollHeight, clientHeight: init.clientHeight, scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => m.scrollTop,
    set: (v: number) => {
      m.scrollTop = Math.max(0, Math.min(v, m.scrollHeight - m.clientHeight))
    },
  })
  m.scrollTop = m.scrollHeight - m.clientHeight
  return m
}

function renderPanel(messages: ChatMessage[]) {
  const props = { threadKey: 't1', onSend: () => {} }
  const view = render(<ChatPanel messages={messages} {...props} />)
  const scroller = view.container.querySelector('.overflow-y-auto') as HTMLElement
  return {
    scroller,
    rerender: (next: ChatMessage[]) => view.rerender(<ChatPanel messages={next} {...props} />),
  }
}

describe('transcript follows new messages', () => {
  it('keeps following after a browser-initiated scroll away from the bottom', () => {
    const { scroller, rerender } = renderPanel(BASE)
    const m = metrics(scroller, { scrollHeight: 1000, clientHeight: 400 })

    // A row above swaps its estimate for a real height and the browser
    // re-anchors: the view is now 300px off the bottom with no user input.
    m.scrollHeight = 1300
    fireEvent.scroll(scroller)

    // A reply arrives and the content grows.
    m.scrollHeight = 1500
    rerender([...BASE, msg({ id: 'a2', role: 'agent', content: 'good pick. noted.' })])
    act(() => fireResize())

    expect(m.scrollTop).toBe(m.scrollHeight - m.clientHeight)
  })

  it('stops following when the user scrolls up on purpose', () => {
    const { scroller, rerender } = renderPanel(BASE)
    const m = metrics(scroller, { scrollHeight: 1000, clientHeight: 400 })

    fireEvent.wheel(scroller, { deltaY: -300 })
    m.scrollTop = 100
    fireEvent.scroll(scroller)

    m.scrollHeight = 1200
    rerender([...BASE, msg({ id: 'a2', role: 'agent', content: 'a reply while reading' })])
    act(() => fireResize())

    expect(m.scrollTop).toBe(100)
  })

  it("jumps to the bottom on the user's own send even after scrolling up", () => {
    const { scroller, rerender } = renderPanel(BASE)
    const m = metrics(scroller, { scrollHeight: 1000, clientHeight: 400 })

    fireEvent.wheel(scroller, { deltaY: -300 })
    m.scrollTop = 100
    fireEvent.scroll(scroller)

    m.scrollHeight = 1100
    rerender([...BASE, msg({ id: 'u2', role: 'user', content: 'i got claude' })])

    expect(m.scrollTop).toBe(m.scrollHeight - m.clientHeight)

    // …and the reply that follows stays in view.
    m.scrollHeight = 1250
    rerender([
      ...BASE,
      msg({ id: 'u2', role: 'user', content: 'i got claude' }),
      msg({ id: 'a2', role: 'agent', content: 'good pick. noted.' }),
    ])
    act(() => fireResize())
    expect(m.scrollTop).toBe(m.scrollHeight - m.clientHeight)
  })
})
