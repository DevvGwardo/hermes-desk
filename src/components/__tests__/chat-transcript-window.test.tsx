import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

beforeAll(() => {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
})

afterEach(() => cleanup())

function thread(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    threadId: 't1',
    role: i % 2 === 0 ? ('user' as const) : ('agent' as const),
    content: `message number ${i}`,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  }))
}

function baseProps(messages: ChatMessage[]) {
  return {
    messages,
    disabled: false,
    sending: false,
    threadKey: 't1',
    liveSubagents: [],
    conversationSubagents: [],
    agentName: () => 'agent',
    onSend: vi.fn(),
    parentAgentName: 'agent',
  } as unknown as Parameters<typeof ChatPanel>[0]
}

describe('ChatPanel transcript windowing', () => {
  it('mounts only the tail of a long thread and offers Load earlier', () => {
    render(<ChatPanel {...baseProps(thread(200))} />)
    const rows = document.querySelectorAll('[data-message-id]')
    expect(rows.length).toBe(60)
    // The newest turn is present, the oldest is not mounted yet.
    expect(document.querySelector('[data-message-id="m199"]')).toBeTruthy()
    expect(document.querySelector('[data-message-id="m0"]')).toBeNull()
    expect(screen.getByTestId('load-earlier').textContent).toMatch(/140/)
  })

  it('renders a short thread in full with no Load earlier control', () => {
    render(<ChatPanel {...baseProps(thread(20))} />)
    expect(document.querySelectorAll('[data-message-id]').length).toBe(20)
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it('Load earlier reveals the previous chunk', () => {
    render(<ChatPanel {...baseProps(thread(200))} />)
    fireEvent.click(screen.getByTestId('load-earlier'))
    expect(document.querySelectorAll('[data-message-id]').length).toBe(120)
    expect(screen.getByTestId('load-earlier').textContent).toMatch(/80/)
  })

  it('a jump-to-message forces the full transcript so the target is mountable', () => {
    const props = { ...baseProps(thread(200)), focusMessageId: 'm0' }
    render(<ChatPanel {...props} onFocusMessageHandled={vi.fn()} />)
    expect(document.querySelector('[data-message-id="m0"]')).toBeTruthy()
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it('at the top of downloaded rows, Load earlier pages the server when it has more', () => {
    const onLoadOlder = vi.fn(async () => true)
    const { rerender } = render(
      <ChatPanel {...baseProps(thread(20))} historyHasMore onLoadOlder={onLoadOlder} />,
    )
    const btn = screen.getByTestId('load-earlier')
    expect(btn.textContent).toBe('Load earlier messages')
    fireEvent.click(btn)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    // In flight: aria-disabled (focus is kept — no `disabled`) with a
    // loading label, a second click is ignored.
    rerender(
      <ChatPanel {...baseProps(thread(20))} historyHasMore historyLoadingOlder onLoadOlder={onLoadOlder} />,
    )
    expect(screen.getByTestId('load-earlier').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('load-earlier').hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByTestId('load-earlier'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('hides Load earlier once the server has no older page', () => {
    render(<ChatPanel {...baseProps(thread(20))} historyHasMore={false} onLoadOlder={vi.fn()} />)
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it('widens the local window before paging the server', () => {
    const onLoadOlder = vi.fn(async () => true)
    render(<ChatPanel {...baseProps(thread(200))} historyHasMore onLoadOlder={onLoadOlder} />)
    fireEvent.click(screen.getByTestId('load-earlier'))
    expect(onLoadOlder).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-message-id]').length).toBe(120)
  })

  it('a double-click before the loading flag lands pages the server once', () => {
    let resolve: (v: boolean) => void = () => {}
    const onLoadOlder = vi.fn(() => new Promise<boolean>((r) => (resolve = r)))
    render(<ChatPanel {...baseProps(thread(20))} historyHasMore onLoadOlder={onLoadOlder} />)
    fireEvent.click(screen.getByTestId('load-earlier'))
    fireEvent.click(screen.getByTestId('load-earlier'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    resolve(true)
  })

  it('keeps the reader still when a page lands under a leading system row', () => {
    const sys: ChatMessage = {
      id: 'sys0',
      threadId: 't1',
      role: 'system',
      content: 'Conversation started.',
      createdAt: new Date(1_600_000_000_000).toISOString(),
    }
    const onLoadOlder = vi.fn(async () => true)
    const initial = [sys, ...thread(10).map((m) => ({ ...m, id: `n${m.id}` }))]
    const { rerender } = render(
      <ChatPanel {...baseProps(initial)} historyHasMore onLoadOlder={onLoadOlder} />,
    )
    const list = screen.getByTestId('load-earlier').closest('.overflow-y-auto') as HTMLDivElement
    let height = 1000
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => height })
    list.scrollTop = 0
    fireEvent.click(screen.getByTestId('load-earlier'))
    // The older page lands BELOW the system row: the first row is unchanged.
    height = 1600
    rerender(
      <ChatPanel
        {...baseProps([sys, ...thread(6).map((m) => ({ ...m, id: `o${m.id}` })), ...initial.slice(1)])}
        historyHasMore
        onLoadOlder={onLoadOlder}
      />,
    )
    expect(list.scrollTop).toBe(600)
  })
})
