import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

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
  return { threadId: 't1', createdAt: '2026-09-23T15:00:00Z', ...partial }
}

function bubbleFor(container: HTMLElement, text: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('.ca-bubble')).find((b) =>
    b.textContent?.includes(text),
  )
  if (!el) throw new Error(`no bubble for ${text}`)
  return el
}

describe('ChatPanel bubble groups', () => {
  it('marks each bubble with its side and place in the stack', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'hey there' }),
      msg({ id: 'u2', role: 'user', content: 'nice' }),
      msg({ id: 'u3', role: 'user', content: 'good morning' }),
      msg({ id: 'a1', role: 'agent', content: 'morning!' }),
      msg({ id: 'x1', role: 'agent', content: '' }),
      msg({ id: 'a2', role: 'agent', content: 'what now?' }),
    ]
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />,
    )
    const read = (t: string) => {
      const b = bubbleFor(container, t)
      return `${b.dataset.side}/${b.dataset.group}`
    }
    expect(read('hey there')).toBe('end/first')
    expect(read('nice')).toBe('end/middle')
    expect(read('good morning')).toBe('end/last')
    // The empty agent row renders nothing and must not split the agent pair.
    expect(read('morning!')).toBe('start/first')
    expect(read('what now?')).toBe('start/last')
    expect(container.querySelector('[data-message-id="x1"]')).toBeNull()
  })
})
