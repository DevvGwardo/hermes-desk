/**
 * Jump to a message (search result, notification): the target is
 * re-centred while the thread settles — cards and pictures above it lay out
 * after the first scroll and pushed it out of view on the phone — and the
 * re-centring stops as soon as the user scrolls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

const scrollIntoView = vi.fn()

beforeEach(() => {
  cleanup()
  vi.useFakeTimers()
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => vi.useRealTimers())

const messages: ChatMessage[] = [
  { id: 'u1', threadId: 't1', role: 'user', content: 'Ship it.', createdAt: '2026-08-14T00:00:00Z' },
  { id: 'a1', threadId: 't1', role: 'agent', content: 'Need the latest deploy summary.', createdAt: '2026-08-14T00:00:01Z' },
]

const targetCalls = () => scrollIntoView.mock.contexts.filter((el) => (el as HTMLElement).getAttribute?.('data-message-id') === 'a1').length

describe('ChatPanel focusMessageId', () => {
  it('re-centres the target while the thread settles, and reports it handled once', () => {
    const handled = vi.fn()
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} focusMessageId="a1" onFocusMessageHandled={handled} />)
    expect(targetCalls()).toBe(1)
    act(() => {
      vi.advanceTimersByTime(1300)
    })
    expect(targetCalls()).toBe(4)
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('stops re-centring once the user scrolls', () => {
    const { container } = render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} focusMessageId="a1" />)
    // A wheel on the row bubbles to the transcript list the effect watches.
    fireEvent.wheel(container.querySelector('[data-message-id="a1"]')!)
    act(() => {
      vi.advanceTimersByTime(1300)
    })
    expect(targetCalls()).toBe(1)
  })
})
