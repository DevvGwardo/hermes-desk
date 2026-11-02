import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { ThreadPane, isSheetWidth } from '../ThreadPane'
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

describe('ChatPanel transcript collapse (A4)', () => {
  it('hides replies in the main list and shows a count chip on the root', () => {
    render(<ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />)
    expect(screen.getByText('root question about deploys')).toBeTruthy()
    expect(screen.queryByText('first answer')).toBeNull()
    expect(screen.queryByText('nested answer')).toBeNull()
    const chip = screen.getByTestId('thread-chip')
    expect(chip.textContent).toBe('2 replies')
  })

  it('opens the pane with the full chain when the chip is clicked', () => {
    render(<ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />)
    fireEvent.click(screen.getByTestId('thread-chip'))
    const pane = screen.getByTestId('thread-pane')
    expect(pane).toBeTruthy()
    const messagesBox = screen.getByTestId('thread-messages')
    expect(messagesBox.textContent).toContain('root question about deploys') // root visible again (in pane)
    expect(messagesBox.textContent).toContain('first answer')
    expect(messagesBox.textContent).toContain('nested answer')
  })

  it('sends from the pane composer with replyTo pinned to the root', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={chain} threadKey="t1" onSend={onSend} />)
    fireEvent.click(screen.getByTestId('thread-chip'))
    fireEvent.change(screen.getByLabelText('Reply in thread'), {
      target: { value: 'threaded follow-up' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send thread reply' }))
    expect(onSend).toHaveBeenCalledWith(
      'threaded follow-up',
      expect.objectContaining({
        replyTo: expect.objectContaining({ id: 'u1' }),
      }),
    )
  })

  it('closes the pane and returns to the collapsed transcript', () => {
    render(<ChatPanel messages={chain} threadKey="t1" onSend={() => {}} />)
    fireEvent.click(screen.getByTestId('thread-chip'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('thread-pane')).toBeNull()
  })
})

describe('ThreadPane width variants (A4)', () => {
  function paneProps(width: number) {
    return {
      open: true as const,
      onClose: () => {},
      messages: chain,
      width,
      onSend: () => {},
      title: 'root question about deploys',
    }
  }

  it('renders the drawer variant above 720px', () => {
    const { container } = render(<ThreadPane {...paneProps(1000)} />)
    expect(isSheetWidth(1000)).toBe(false)
    expect(container.querySelector('[data-testid="thread-pane"]')?.className).toContain('w-[22rem]')
  })

  it('renders the full-screen sheet at ≤720px', () => {
    const { container } = render(<ThreadPane {...paneProps(480)} />)
    expect(isSheetWidth(480)).toBe(true)
    expect(container.querySelector('[data-testid="thread-pane"]')?.className).toContain('inset-0')
  })

  it('Enter sends, Shift+Enter does not', () => {
    const onSend = vi.fn()
    render(<ThreadPane {...paneProps(900)} onSend={onSend} />)
    const input = screen.getByLabelText('Reply in thread') as HTMLTextAreaElement
    act(() => {
      fireEvent.change(input, { target: { value: 'hello thread' } })
    })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]?.[1]?.replyTo?.id).toBe('u1')
  })
})
