import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel, copyTextOf } from '../ChatPanel'
import { MessageActionAnchor } from '../MessageActions'
import { resetDraftsForTests } from '../../lib/composer-drafts'
import type { ChatMessage } from '../../lib/agents'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  resetDraftsForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const box = () => screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement

describe('composer drafts', () => {
  it('keeps drafting available during reconnects but does not send offline', () => {
    const onSend = vi.fn()
    const props = { messages: [], threadKey: 'reconnect', onSend, skin: 'messenger' as const }
    const view = render(<ChatPanel {...props} />)
    act(() => box().focus())
    fireEvent.change(box(), { target: { value: 'An unfinished message' } })

    view.rerender(<ChatPanel {...props} readOnly />)
    expect(box().disabled).toBe(false)
    expect(document.activeElement).toBe(box())
    fireEvent.change(box(), { target: { value: 'An unfinished message, still typing offline' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.submit(box().closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('An unfinished message, still typing offline')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)

    view.rerender(<ChatPanel {...props} />)
    expect(document.activeElement).toBe(box())
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('An unfinished message, still typing offline', undefined)
    expect(box().value).toBe('')
  })

  it('still disables drafting when no usable conversation is selected', () => {
    render(<ChatPanel messages={[]} threadKey="none" onSend={vi.fn()} disabled readOnly />)
    expect(box().disabled).toBe(true)
  })

  it('stay with their conversation when switching chats', () => {
    const onSend = vi.fn()
    const view = render(<ChatPanel messages={[]} threadKey="a" onSend={onSend} />)
    fireEvent.change(box(), { target: { value: 'half a thought for A' } })
    view.rerender(<ChatPanel messages={[]} threadKey="b" onSend={onSend} />)
    expect(box().value).toBe('')
    fireEvent.change(box(), { target: { value: 'for B' } })
    view.rerender(<ChatPanel messages={[]} threadKey="a" onSend={onSend} />)
    expect(box().value).toBe('half a thought for A')

    // Sending clears only this conversation's draft.
    fireEvent.submit(box().closest('form')!)
    expect(onSend).toHaveBeenCalledWith('half a thought for A', undefined)
    view.rerender(<ChatPanel messages={[]} threadKey="b" onSend={onSend} />)
    expect(box().value).toBe('for B')
  })

  it('survive a reload', () => {
    vi.useFakeTimers()
    const view = render(<ChatPanel messages={[]} threadKey="c" onSend={() => {}} />)
    fireEvent.change(box(), { target: { value: 'keep me' } })
    act(() => vi.advanceTimersByTime(500))
    view.unmount()
    expect(window.localStorage.getItem('nub.composer-drafts.v1')).toContain('keep me')
  })
})

describe('copying a message', () => {
  it('copies what the bubble shows, not MEDIA tags or inlined images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const m = {
      id: 'a',
      threadId: 't',
      role: 'agent',
      content: `Here it is\nMEDIA:/opt/data/cache/screenshots/a.png\n![x](${png})`,
      createdAt: '',
    } as ChatMessage
    expect(copyTextOf(m)).toBe('Here it is')
  })

  it('is one click on the hover bar, and confirms with a check', () => {
    const onCopy = vi.fn()
    render(
      <MessageActionAnchor msg={{ id: 'a', threadId: 't', role: 'agent', content: 'hi', createdAt: '' } as ChatMessage} speakerName="Hermes" onCopy={onCopy}>
        <p>hi</p>
      </MessageActionAnchor>,
    )
    fireEvent.pointerEnter(screen.getByRole('group'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })
})

describe('jump to latest', () => {
  it('appears once scrolled up, says when a reply arrived, and returns to the bottom', () => {
    const msgs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        threadId: 't',
        role: i % 2 ? 'agent' : 'user',
        content: `message ${i}`,
        createdAt: '2026-09-30T00:00:00Z',
      })) as ChatMessage[]
    const view = render(<ChatPanel messages={msgs(4)} threadKey="t" onSend={() => {}} />)
    const list = document.querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 600 })
    list.scrollTop = 400
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()

    view.rerender(<ChatPanel messages={msgs(5)} threadKey="t" onSend={() => {}} />)
    const pill = screen.getByRole('button', { name: 'New reply below. Jump to latest' })
    fireEvent.click(pill)
    expect(screen.queryByTestId('jump-to-latest')).toBeNull()
  })
})
