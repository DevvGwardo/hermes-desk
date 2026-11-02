import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

// Regression: on agent.nub.lol the agent's reply only appeared after a page
// refresh. The transport streams into ONE bubble whose id never changes
// (empty placeholder → content → streaming:false). ChatPanel cached its
// top-level rows keyed on message ids, so it kept rendering the stale empty
// placeholder, which renders nothing.

beforeEach(() => {
  cleanup()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // No-op frames: the streaming mascot animates on rAF, and a synchronous
  // stub recurses through it.
  vi.stubGlobal('requestAnimationFrame', () => 1)
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
  return { threadId: 't1', createdAt: '2026-09-23T13:52:54Z', ...partial }
}

const USER = msg({ id: 'u1', role: 'user', content: 'good morning' })
const REPLY_TEXT = "morning! what's on the menu?"

describe('streaming reply renders without a refresh', () => {
  it('shows content that lands in the same-id placeholder bubble', () => {
    const props = { threadKey: 't1', onSend: () => {} }
    const placeholder = msg({ id: 'turn_1', role: 'agent', content: '', streaming: true })
    const view = render(<ChatPanel messages={[USER, placeholder]} {...props} />)
    expect(view.container.textContent).not.toContain(REPLY_TEXT)

    view.rerender(
      <ChatPanel messages={[USER, { ...placeholder, content: REPLY_TEXT }]} {...props} />,
    )
    expect(view.container.textContent).toContain(REPLY_TEXT)

    view.rerender(
      <ChatPanel
        messages={[USER, { ...placeholder, content: REPLY_TEXT, streaming: false }]}
        {...props}
      />,
    )
    expect(view.container.textContent).toContain(REPLY_TEXT)
  })

  it('announces once the reply settles, and says when it failed', () => {
    const props = { threadKey: 't1', onSend: () => {} }
    const placeholder = msg({ id: 'turn_1', role: 'agent', content: '', streaming: true })
    const view = render(<ChatPanel messages={[USER, placeholder]} {...props} />)
    const region = () => view.getByTestId('reply-announcement')
    expect(region().getAttribute('aria-live')).toBe('polite')
    expect(region().textContent).toBe('')
    view.rerender(<ChatPanel messages={[USER, { ...placeholder, content: REPLY_TEXT, streaming: false }]} {...props} />)
    expect(region().textContent).toBe('Reply ready')

    const failing = msg({ id: 'turn_2', role: 'agent', content: '', streaming: true })
    view.rerender(<ChatPanel messages={[USER, failing]} {...props} />)
    expect(region().textContent).toBe('')
    view.rerender(<ChatPanel messages={[USER, { ...failing, streaming: false, error: true }]} {...props} />)
    expect(region().textContent).toBe('Reply failed. Try again is available.')

    // Switching chats never announces the other chat's settled reply.
    view.rerender(<ChatPanel messages={[USER]} threadKey="t2" onSend={() => {}} />)
    expect(region().textContent).toBe('')
  })
})
