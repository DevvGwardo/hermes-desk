import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

beforeEach(() => {
  cleanup()
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
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const messages: ChatMessage[] = [
  {
    id: 'u1',
    threadId: 't1',
    role: 'user',
    content: 'Happy eyes at 28/40 are a pass now.',
    createdAt: '2026-08-14T00:00:00Z',
  },
  {
    id: 'a1',
    threadId: 't1',
    role: 'agent',
    content: 'Deploy check landed on the cube.',
    createdAt: '2026-08-14T00:00:01Z',
  },
]

function renderChat() {
  return render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />)
}

describe('ChatPanel find in chat', () => {
  it('⌘F opens a bar over the open thread', () => {
    renderChat()
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(screen.getByLabelText('Find in chat')).toBeTruthy()
  })

  it('typing jumps to a matching message', () => {
    renderChat()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'happy eyes' } })
    const hit = document.querySelector('[data-message-id="u1"]')
    expect(hit?.className).toMatch(/ring-2/)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('Esc closes the bar', () => {
    renderChat()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Escape' })
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
  })

  it('key handler does not steal ⌘K', () => {
    renderChat()
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
  })

  it('opens from maia:find-in-chat (palette command)', () => {
    renderChat()
    fireEvent(window, new CustomEvent('maia:find-in-chat'))
    expect(screen.getByLabelText('Find in chat')).toBeTruthy()
  })

  it('ignores find and composer events while the chat is inactive, retaining its draft', () => {
    const props = { messages, threadKey: 't1', onSend: vi.fn() }
    const { rerender } = render(<ChatPanel {...props} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Keep this draft' } })
    rerender(<ChatPanel {...props} active={false} />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent(window, new CustomEvent('maia:find-in-chat'))
    fireEvent(window, new CustomEvent('maia:spawn-scaffold'))
    expect(screen.queryByLabelText('Find in chat')).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement).value).toBe('Keep this draft')
    rerender(<ChatPanel {...props} active />)
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(screen.getByLabelText('Find in chat')).toBeTruthy()
  })

  it('find bar is scoped to the transcript when the thread rail is open', () => {
    const chain: ChatMessage[] = [
      { id: 'u1', threadId: 't1', role: 'user', content: 'root question', createdAt: '2026-08-14T00:00:00Z' },
      { id: 'a1', threadId: 't1', role: 'agent', content: 'first answer', createdAt: '2026-08-14T00:00:01Z', replyTo: { id: 'u1', role: 'user', snippet: 'root', thread: true } },
    ]
    render(<ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />)
    fireEvent.click(screen.getByTestId('thread-chip'))
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const bar = screen.getByLabelText('Find in chat')
    const scrollList = bar.closest('.overflow-y-auto')
    expect(scrollList).toBeTruthy()
    // Sticky within the transcript column — never an overlay spanning the rail.
    expect(bar.parentElement?.className).toContain('sticky')
    expect(scrollList?.contains(screen.getByTestId('thread-pane'))).toBe(false)
  })
})
