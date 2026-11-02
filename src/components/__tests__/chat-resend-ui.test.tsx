import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'
import { TOUCH_KEYBOARD_MQ } from '../../lib/composer-enter'

let touch = false

beforeEach(() => {
  cleanup()
  touch = false
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') || (touch && query === TOUCH_KEYBOARD_MQ),
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

function msg(partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>): ChatMessage {
  return { threadId: 't-resend', createdAt: '2026-10-03T12:00:00Z', ...partial }
}

const convo = [
  msg({ id: 'u1', role: 'user', content: 'first question' }),
  msg({ id: 'a1', role: 'agent', content: 'first answer' }),
  msg({ id: 'u2', role: 'user', content: 'compare the plans' }),
  msg({ id: 'a2', role: 'agent', content: 'here is the comparison' }),
]

function actionsFor(text: string, openContextMenu = false) {
  const anchor = screen.getByText(text).closest('[role="group"]') as HTMLElement
  fireEvent.focus(anchor)
  if (openContextMenu) fireEvent.contextMenu(anchor)
  return within(anchor)
}

function composer() {
  return screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
}

describe('Ask again', () => {
  it('resends the prompt behind the newest reply', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={convo} threadKey="t-ask" onSend={onSend} />)
    fireEvent.click(actionsFor('here is the comparison').getByRole('button', { name: 'More message actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask again' }))
    expect(onSend).toHaveBeenCalledWith('compare the plans', {})
  })

  it('is only on the newest reply, and not while a reply is running', () => {
    const { rerender } = render(<ChatPanel messages={convo} threadKey="t-ask2" onSend={() => {}} />)
    expect(actionsFor('first answer', true).queryByRole('menuitem', { name: 'Ask again' })).toBeNull()
    rerender(<ChatPanel messages={convo} threadKey="t-ask2" onSend={() => {}} sending />)
    expect(actionsFor('here is the comparison', true).queryByRole('menuitem', { name: 'Ask again' })).toBeNull()
  })
})

describe('Edit and resend', () => {
  it('puts your message back in the composer without sending', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={convo} threadKey="t-edit" onSend={onSend} />)
    fireEvent.click(actionsFor('first question').getByRole('button', { name: 'More message actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and resend' }))
    expect(composer().value).toBe('first question')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('is not offered on agent replies', () => {
    render(<ChatPanel messages={convo} threadKey="t-edit2" onSend={() => {}} />)
    expect(actionsFor('first answer', true).queryByRole('menuitem', { name: 'Edit and resend' })).toBeNull()
  })
})

describe('empty chat starters', () => {
  it('fills the composer for the agent you are talking to', () => {
    const onSend = vi.fn()
    render(
      <ChatPanel
        messages={[]}
        threadKey="t-start"
        onSend={onSend}
        starterAgent={{ id: 'x', name: 'Web Researcher', status: 'running', region: 'remote', createdAt: '', summary: '' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Research the latest on…' }))
    expect(composer().value).toBe('Research the latest on ')
    expect(onSend).not.toHaveBeenCalled()
  })
  it('still shows on a new chat that only has the "Conversation started." note', () => {
    render(
      <ChatPanel messages={[msg({ id: 's1', role: 'system', content: 'Conversation started.' })]} threadKey="t-start2" onSend={() => {}} />,
    )
    expect(screen.getByTestId('chat-starters')).toBeTruthy()
  })

  it('goes away once the conversation has a message', () => {
    render(<ChatPanel messages={convo} threadKey="t-start3" onSend={() => {}} />)
    expect(screen.queryByTestId('chat-starters')).toBeNull()
  })
})

describe('Enter in the composer', () => {
  it('sends with a real keyboard', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={convo} threadKey="t-enter" onSend={onSend} />)
    fireEvent.change(composer(), { target: { value: 'hello' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', undefined)
  })

  it('does not send while an IME word is being confirmed', () => {
    const onSend = vi.fn()
    render(<ChatPanel messages={convo} threadKey="t-ime" onSend={onSend} />)
    fireEvent.change(composer(), { target: { value: 'こんにちは' } })
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('is a new line on a phone keyboard; the button still sends', () => {
    touch = true
    const onSend = vi.fn()
    render(<ChatPanel messages={convo} threadKey="t-phone" onSend={onSend} />)
    fireEvent.change(composer(), { target: { value: 'line one' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(composer().getAttribute('enterkeyhint')).toBe('enter')
  })
})

describe('file card meta', () => {
  it('says what the file is and where it lives instead of repeating the name', () => {
    render(
      <ChatPanel
        messages={[
          msg({ id: 'u1', role: 'user', content: 'write it up' }),
          msg({
            id: 'a1',
            role: 'agent',
            content: 'Done.',
            toolEvents: [
              { tool: 'write_file', status: 'completed', args: '{"file_path":"/opt/data/workspace/security-tooling-breakdown.md"}' },
            ],
          }),
        ]}
        threadKey="t-meta"
        onSend={() => {}}
        onOpenFile={() => {}}
      />,
    )
    expect(screen.getByText('security-tooling-breakdown.md')).toBeTruthy()
    expect(screen.getByText('Markdown · Workspace')).toBeTruthy()
  })
})
