import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { ThreadPane } from '../ThreadPane'
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
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const chain: ChatMessage[] = [
  {
    id: 'u1',
    threadId: 't1',
    role: 'user',
    content: 'root question about deploys',
    createdAt: '2026-08-22T00:00:00Z',
  },
  {
    id: 'a1',
    threadId: 't1',
    role: 'agent',
    content: 'first answer',
    createdAt: '2026-08-22T00:00:01Z',
    replyTo: { id: 'u1', role: 'user', snippet: 'root question', thread: true },
  },
  {
    id: 'a2',
    threadId: 't1',
    role: 'agent',
    content: 'nested answer',
    createdAt: '2026-08-22T00:00:02Z',
    replyTo: { id: 'a1', role: 'agent', snippet: 'first answer', thread: true },
  },
]

function parentIsFlexRow(el: HTMLElement): boolean {
  const cls = el.parentElement?.className ?? ''
  return cls.includes('flex-row') || /(^|\s)flex(\s|$)/.test(cls)
}

describe('ThreadPane docked layout (sidebar, not overlay)', () => {
  it('docks as a flex-row sibling: no absolute, parent is a flex row', () => {
    render(<ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />)
    fireEvent.click(screen.getByTestId('thread-chip'))
    const pane = screen.getByTestId('thread-pane')
    expect(pane.className).not.toContain('absolute')
    expect(parentIsFlexRow(pane)).toBe(true)
  })

  it('does not cover the transcript: root text stays rendered and the scroll list shrinks', () => {
    const { container } = render(
      <ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />,
    )
    fireEvent.click(screen.getByTestId('thread-chip'))
    const pane = screen.getByTestId('thread-pane')
    // Transcript root is still rendered (in the main list, not just the pane).
    expect(screen.getAllByText('root question about deploys').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('thread-chip')).toBeTruthy()
    // The scroll list shrinks beside the pane instead of being covered by it.
    const scrollList = container.querySelector('.overflow-y-auto')
    expect(scrollList).toBeTruthy()
    expect(scrollList!.className).toContain('flex-1')
    expect(scrollList!.className).toContain('min-w-0')
    expect(scrollList!.contains(pane)).toBe(false)
  })

  it('keeps the full-screen sheet at narrow widths; drawer has no overlay positioning when wide', () => {
    const sheet = render(
      <ThreadPane
        open
        onClose={() => {}}
        messages={chain}
        width={480}
        onSend={() => {}}
        title="root question about deploys"
      />,
    )
    const sheetPane = sheet.container.querySelector('[data-testid="thread-pane"]')!
    expect(sheetPane.className).toContain('fixed')
    expect(sheetPane.className).toContain('inset-0')
    sheet.unmount()

    const { container } = render(
      <ThreadPane
        open
        onClose={() => {}}
        messages={chain}
        width={1000}
        onSend={() => {}}
        title="root question about deploys"
      />,
    )
    const drawerPane = container.querySelector('[data-testid="thread-pane"]')!
    expect(drawerPane.className).not.toContain('absolute')
    expect(drawerPane.className).not.toContain('fixed')
  })

  it('open / send / close still work with the docked layout', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={chain} threadKey="t1" onSend={onSend} />)
    // Chip opens the docked pane.
    fireEvent.click(screen.getByTestId('thread-chip'))
    const pane = screen.getByTestId('thread-pane')
    expect(pane.className).not.toContain('absolute')
    expect(parentIsFlexRow(pane)).toBe(true)
    // Send pins replyTo to the thread root.
    fireEvent.change(screen.getByLabelText('Reply in thread'), {
      target: { value: 'docked follow-up' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send thread reply' }))
    expect(onSend).toHaveBeenCalledWith(
      'docked follow-up',
      expect.objectContaining({
        replyTo: expect.objectContaining({ id: 'u1' }),
      }),
    )
    // Close removes the pane and leaves the collapsed transcript.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('thread-pane')).toBeNull()
    expect(screen.getByText('root question about deploys')).toBeTruthy()
  })
})
