import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { renderCapture } from '../../lib/render-capture'
import type { ChatMessage } from '../../lib/agents'

const message: ChatMessage = {
  id: 'FAKE private message identity', threadId: 'FAKE private thread', role: 'agent', content: 'FAKE private transcript',
  createdAt: '2026-10-01T12:00:00Z',
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) })
})
afterEach(() => { cleanup(); renderCapture.clear() })

describe.each(['messenger', 'classic'] as const)('chat render metadata (%s)', skin => {
  it('captures commit, scroll and thread transitions without text, dates or identity', () => {
    renderCapture.start()
    const props = { messages: [message], threadKey: 'FAKE private thread', skin, onSend: vi.fn() }
    const view = render(<ChatPanel {...props} />)
    fireEvent.wheel(screen.getByTestId('chat-scroller'))
    fireEvent.scroll(screen.getByTestId('chat-scroller'))
    view.rerender(<ChatPanel {...props} threadKey="FAKE other private thread" sending />)
    const snapshot = renderCapture.read()
    expect(snapshot.entries.some(entry => entry.event === 'commit' && entry.data.skin === skin && entry.data.rows === 1)).toBe(true)
    expect(snapshot.entries.some(entry => entry.event === 'scroll')).toBe(true)
    expect(snapshot.entries.some(entry => entry.event === 'intent')).toBe(true)
    const epochs = snapshot.entries.filter(entry => entry.event === 'thread').map(entry => entry.data.epoch)
    expect(new Set(epochs).size).toBe(2)
    expect(JSON.stringify(snapshot)).not.toMatch(/FAKE|private|2026-10|transcript|identity/)
  })

  it('leaves diagnostic memory empty when capture was not enabled', () => {
    render(<ChatPanel messages={[message]} threadKey="FAKE private thread" skin={skin} onSend={vi.fn()} />)
    fireEvent.scroll(screen.getByTestId('chat-scroller'))
    expect(renderCapture.read().entries).toEqual([])
  })
})
