import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { MessageBody } from '../MessageBody'
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

describe('C3/C5: streaming ticks stay cheap (docs/CHAT_LOAD_AND_MOTION_SPEC.md)', () => {
  it('content growth of the tail does not remount earlier rows or move the window', () => {
    const messages = thread(80)
    const { rerender } = render(<ChatPanel {...baseProps(messages)} />)
    const before = document.querySelector('[data-message-id="m30"]')
    const beforeCount = document.querySelectorAll('[data-message-id]').length
    expect(screen.getByTestId('load-earlier').textContent).toMatch(/20/)

    // One streaming tick: same ids, tail content grows, new tail message id.
    const streaming: ChatMessage[] = [
      ...messages,
      { id: 'm80', threadId: 't1', role: 'agent', content: 'pa', createdAt: new Date().toISOString(), streaming: true },
    ]
    rerender(<ChatPanel {...baseProps(streaming)} />)
    const tick1 = document.querySelector('[data-message-id="m30"]')

    const tick2: ChatMessage[] = streaming.map((m) =>
      m.id === 'm80' ? { ...m, content: 'part of a longer streaming answer' } : m,
    )
    rerender(<ChatPanel {...baseProps(tick2)} />)
    const tick3 = document.querySelector('[data-message-id="m30"]')

    // C3: earlier nodes are the SAME DOM nodes across content-only ticks.
    expect(tick1).toBeTruthy()
    expect(tick3).toBe(tick1)
    expect(tick3).toBe(before) // same DOM node from first mount through both ticks — no remount
    expect(document.querySelectorAll('[data-message-id]').length).toBe(beforeCount) // window stays 60 wide

    // C3: the settled rows carry content-visibility; the streaming row does not.
    expect(tick3?.className).toContain('ca-cv-row')
    const liveRow = document.querySelector('[data-message-id="m80"]')
    expect(liveRow?.className).not.toContain('ca-cv-row')
  })

  it('streaming growth does not change the Load earlier window on a long thread', () => {
    const messages = thread(200)
    const { rerender } = render(<ChatPanel {...baseProps(messages)} />)
    const label = screen.getByTestId('load-earlier').textContent
    const streaming: ChatMessage[] = [
      ...messages,
      { id: 'm200', threadId: 't1', role: 'agent', content: 'x', createdAt: new Date().toISOString(), streaming: true },
    ]
    rerender(<ChatPanel {...baseProps(streaming)} />)
    // The window stays 60 wide; the hidden count grows by the one new row.
    expect(screen.getByTestId('load-earlier').textContent).toBe('Load earlier messages (141)')
    void label
  })

  it('scroller opts into overflow-anchor (C5) and the voice bars promote only while live (M4)', () => {
    const { container } = render(<ChatPanel {...baseProps(thread(5))} />)
    // The transcript scroller is the .overflow-y-auto element inside ChatPanel.
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(scroller).toBeTruthy()
    expect(scroller.style.overflowAnchor).toBe('auto')
    const bars = container.querySelector('.ca-voice-bars')
    if (bars) expect(bars.getAttribute('data-live')).toBeNull()
  })
})

describe('C4: long bodies stream and settle as markdown without a reflow', () => {
  const long = 'Intro paragraph.\n\n' + 'Body text with **bold** and more words.\n\n'.repeat(120)

  it('an 8KB reply is markdown while streaming and keeps its settled chunks on settle', () => {
    const { rerender } = render(<MessageBody content={long} variant="markdown" streaming />)
    // While streaming: parsed markdown, never a plain prewrap paragraph.
    expect(document.querySelector('.nub-md')).toBeTruthy()
    expect(document.querySelector('p.whitespace-pre-wrap')).toBeNull()
    const firstBold = document.querySelector('.nub-md strong')
    expect(firstBold).toBeTruthy()

    rerender(<MessageBody content={long} variant="markdown" streaming={false} />)
    // Settle: still markdown on the same frame, and the chunks above the tail
    // keep their DOM nodes (no re-parse, no reflow).
    expect(document.querySelector('p.whitespace-pre-wrap')).toBeNull()
    expect(document.querySelector('.nub-md strong')).toBe(firstBold)
  })

  it('a long settled body mounting outside a transcript renders markdown at once', () => {
    render(<MessageBody content={long} variant="markdown" streaming={false} />)
    expect(document.querySelector('.nub-md')).toBeTruthy()
  })

  it('short bodies (≤2KB) render markdown immediately on settle', () => {
    const short = '# Title\n\nshort body'
    render(<MessageBody content={short} variant="markdown" streaming={false} />)
    expect(document.querySelector('.nub-md')).toBeTruthy()
  })
})
