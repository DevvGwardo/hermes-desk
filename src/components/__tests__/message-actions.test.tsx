import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { MessageActionAnchor } from '../MessageActions'
import type { ChatMessage } from '../../lib/agents'

beforeEach(() => {
  cleanup()
  delete window.nubAgent
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
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

const messages: ChatMessage[] = [
  {
    id: 'u1',
    threadId: 't1',
    role: 'user',
    content: 'ship it',
    createdAt: '2026-08-14T00:00:00Z',
  },
  {
    id: 'a1',
    threadId: 't1',
    role: 'agent',
    content: 'done',
    createdAt: '2026-08-14T00:00:01Z',
    reactions: [{ emoji: '❤️', author: 'user' }],
  },
]

describe('ChatPanel reactions + replies', () => {
  it('places floating messenger actions below a message when there is no room above', () => {
    const { container } = render(
      <div data-testid="chat-scroller">
        <MessageActionAnchor msg={messages[1]} speakerName="Hermes" skin="messenger" onCopy={() => {}}>
          <div>done</div>
        </MessageActionAnchor>
      </div>,
    )
    const scroller = screen.getByTestId('chat-scroller')
    const anchor = container.querySelector<HTMLElement>('.sand-message-action-anchor')!
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
    anchor.getBoundingClientRect = () => ({ top: 110, bottom: 170 }) as DOMRect
    fireEvent.pointerEnter(anchor)
    expect(screen.getByRole('toolbar').getAttribute('data-placement')).toBe('below')
    anchor.getBoundingClientRect = () => ({ top: 200, bottom: 260 }) as DOMRect
    fireEvent.scroll(scroller)
    expect(screen.getByRole('toolbar').getAttribute('data-placement')).toBe('above')
  })

  it.each(['available', 'missing'] as const)('uses the desktop write-only bridge with a %s browser clipboard', async kind => {
    if (kind === 'missing') {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const writeText = vi.fn(() => pending)
    Object.defineProperty(window, 'nubAgent', { configurable: true, writable: true, value: { clipboard: { writeText } } })
    const { container } = render(<ChatPanel messages={messages} threadKey="desktop-copy" onSend={() => {}} />)
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('done')
    if (kind === 'available') expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    await act(async () => { finish(); await pending })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('shows manual-copy feedback when the native write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'))
    Object.defineProperty(window, 'nubAgent', { configurable: true, writable: true, value: { clipboard: { writeText } } })
    const { container } = render(<ChatPanel messages={messages} threadKey="desktop-copy-failure" onSend={() => {}} />)
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByText('Could not copy. Select the text and copy it manually.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('confirms copy only after the clipboard write succeeds', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(pending)
    const { container } = render(<ChatPanel messages={messages} threadKey="copy-pending" onSend={() => {}} />)
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('done')
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    await act(async () => { finish(); await pending })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it.each(['denied', 'missing'] as const)('handles a %s clipboard without false success', async kind => {
    if (kind === 'denied') {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    }
    const { container } = render(<ChatPanel messages={messages} threadKey={`copy-${kind}`} onSend={() => {}} />)
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByText('Could not copy. Select the text and copy it manually.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('shows Grok hover actions and sends a reply with replyTo', () => {
    const onSend = vi.fn()
    const onReact = vi.fn()
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={onSend} onReact={onReact} />,
    )
    const anchors = container.querySelectorAll('.sand-message-action-anchor')
    expect(anchors.length).toBe(2)
    fireEvent.pointerEnter(anchors[1]!)
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reply to Hermes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Hermes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), {
      target: { value: 'nice' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('nice', {
      replyTo: { id: 'a1', role: 'agent', snippet: 'done' },
    })
  })

  it('toggles a reaction from the Grok quick row', () => {
    const onReact = vi.fn()
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={onReact} />,
    )
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }))
    fireEvent.click(screen.getByRole('button', { name: '🎉' }))
    expect(onReact).toHaveBeenCalledWith(messages[1], '🎉')
  })

  it('renders Grok reaction pills under the bubble', () => {
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />)
    expect(screen.getByRole('button', { name: /reacted with ❤️/ })).toBeTruthy()
  })

  it('a toolbar opened by keyboard focus hides when focus leaves the message', () => {
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />,
    )
    const anchors = container.querySelectorAll<HTMLElement>('.sand-message-action-anchor')
    const open = () => container.querySelectorAll('.sand-message-action-anchor--menu-open').length
    fireEvent.focus(anchors[0])
    expect(open()).toBe(1)
    // Focus moves on to the next message: only that one's bar is up.
    fireEvent.blur(anchors[0], { relatedTarget: anchors[1] })
    fireEvent.focus(anchors[1])
    expect(open()).toBe(1)
    // …and out of the transcript entirely: none.
    fireEvent.blur(anchors[1], { relatedTarget: document.body })
    expect(open()).toBe(0)
  })

  it('the right-click menu takes focus, uses menu items, and closes on Esc', () => {
    const { container } = render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />)
    const anchor = container.querySelectorAll<HTMLElement>('.sand-message-action-anchor')[1]
    fireEvent.contextMenu(anchor, { clientX: 40, clientY: 40 })
    const menu = screen.getByRole('menu', { name: 'Message actions' })
    expect(menu.hasAttribute('data-esc-layer')).toBe(true)
    const items = screen.getAllByRole('menuitem')
    expect(items.length).toBe(menu.querySelectorAll('button').length)
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Message actions' })).toBeNull()
  })

  it('places the hover toolbar above the bubble, not over the text', () => {
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />,
    )
    const anchors = container.querySelectorAll('.sand-message-action-anchor')
    expect(anchors[0]?.getAttribute('data-msg-role')).toBe('user')
    expect(anchors[1]?.getAttribute('data-msg-role')).toBe('agent')
    fireEvent.pointerEnter(anchors[1]!)
    const bar = container.querySelector('.sand-message-hover-actions')
    expect(bar).toBeTruthy()
    expect(bar?.className).toContain('bottom-full')
    expect(bar?.className).not.toContain('-top-3')
    expect(bar?.className).toContain('right-0')
  })

  it('puts user hover actions on the left of the outgoing bubble', () => {
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />,
    )
    fireEvent.pointerEnter(container.querySelectorAll('.sand-message-action-anchor')[0]!)
    const bar = container.querySelector('.sand-message-hover-actions')
    expect(bar?.className).toContain('left-0')
    expect(bar?.className).toContain('bottom-full')
  })

  it('toggles the toolbar on tap when hover is unavailable', () => {
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
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />,
    )
    const agent = container.querySelectorAll('.sand-message-action-anchor')[1]!
    expect(container.querySelector('.sand-message-hover-actions')).toBeNull()
    fireEvent.click(agent)
    expect(container.querySelector('.sand-message-hover-actions')).toBeTruthy()
    expect(agent.className).toContain('sand-message-action-anchor--menu-open')
  })

  it('makes the action anchor keyboard-focusable with an accessible label', () => {
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onReact={() => {}} />,
    )
    const anchors = container.querySelectorAll('.sand-message-action-anchor')
    expect(anchors.length).toBe(2)
    for (const anchor of Array.from(anchors)) {
      expect(anchor.getAttribute('tabindex')).toBe('0')
      expect((anchor as HTMLElement).tabIndex).toBe(0)
    }
    expect(anchors[0]?.getAttribute('aria-label')).toBe('Message actions for you')
    expect(anchors[1]?.getAttribute('aria-label')).toBe('Message actions for Hermes')
  })
})
