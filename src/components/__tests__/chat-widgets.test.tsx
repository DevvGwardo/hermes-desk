import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { AppModal } from '../AppModal'
import type { PendingToolPermission } from '../../lib/agents'

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

afterEach(() => {
  vi.useRealTimers()
})

const questionAsk: PendingToolPermission = {
  id: 'ask_q1',
  conversationId: 't1',
  sessionId: 'sess_1',
  description: 'Deploy the site to production now?',
  choices: ['once', 'deny'],
  kind: 'question',
  options: [
    { id: 'ship', label: 'Ship it', hint: 'deploy main' },
    { id: 'wait', label: 'Not yet' },
  ],
  status: 'pending',
}

type PermissionSpy = ReturnType<typeof vi.fn>

function renderChat(ask: PendingToolPermission | null, onPermission?: PermissionSpy) {
  const spy = onPermission ?? vi.fn()
  const utils = render(
    <ChatPanel
      skin="classic"
      messages={[]}
      threadKey="t1"
      onSend={() => {}}
      permissionAsk={ask}
      onPermission={spy as unknown as (choice: string, opts?: { optionId?: string }) => void}
    />,
  )
  return { ...utils, spy }
}

describe('A1 approval-dock widgets — question chips', () => {
  it('renders option chips for an options payload and resolves through onPermission', () => {
    const { spy } = renderChat(questionAsk)
    expect(screen.getByRole('region', { name: 'Agent question' })).toBeTruthy()
    expect(screen.getByText('Deploy the site to production now?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Ship it/ }))
    expect(spy).toHaveBeenCalledWith('once', { optionId: 'ship' })
  })

  it('legacy payload renders the exact current buttons and no chips', () => {
    renderChat({
      id: 'ask_cmd',
      conversationId: 't1',
      sessionId: 'sess_1',
      command: 'rm -rf build',
      choices: ['once', 'session', 'always', 'deny'],
      status: 'pending',
    })
    expect(screen.getByRole('region', { name: 'Local tool permissions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow this session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny once' })).toBeTruthy()
    expect(document.querySelectorAll('.sand-widget-option')).toHaveLength(0)
  })

  it('keys 1–9 select options but digits typed into the composer do not', () => {
    const { spy } = renderChat(questionAsk)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', cancelable: true }))
    })
    expect(spy).toHaveBeenCalledWith('once', { optionId: 'wait' })

    spy.mockClear()
    const composer = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    act(() => {
      fireEvent.keyDown(composer, { key: '2' })
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('Esc denies a question ask', () => {
    const { spy } = renderChat(questionAsk)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    })
    expect(spy).toHaveBeenCalledWith('deny')
  })

  it('an Esc the composer used (closing the slash menu) does not deny', () => {
    const { spy } = renderChat(questionAsk)
    const composer = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '/' } })
    expect(screen.getByText('/new')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(composer.value).toBe('')
    expect(spy).not.toHaveBeenCalled()
    // The next Esc, with nothing left to close, answers the question.
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(spy).toHaveBeenCalledWith('deny')
  })

  it('an Esc meant for a small layer on screen does not deny', () => {
    const { spy } = renderChat(questionAsk)
    const layer = document.createElement('div')
    layer.setAttribute('data-esc-layer', '')
    document.body.appendChild(layer)
    try {
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      layer.remove()
    }
  })

  it('closing an actual app modal does not also deny the question behind it', () => {
    const spy = vi.fn()
    const close = vi.fn()
    render(<>
      <ChatPanel messages={[]} threadKey="t1" onSend={() => {}} permissionAsk={questionAsk} onPermission={spy} />
      <AppModal open title="Foreground settings" onClose={close}><button type="button">Modal action</button></AppModal>
    </>)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Modal action' }), { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(spy).not.toHaveBeenCalled()
  })

  it('digits in an actual app modal do not answer the question behind it', () => {
    const spy = vi.fn()
    render(<>
      <ChatPanel messages={[]} threadKey="t1" onSend={() => {}} permissionAsk={questionAsk} onPermission={spy} />
      <AppModal open title="Foreground settings" onClose={() => {}}><button type="button">Modal action</button></AppModal>
    </>)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Modal action' }), { key: '1' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('a modal alert dialog also owns keys dispatched outside its focus trap', () => {
    const { spy } = renderChat(questionAsk)
    const modal = document.createElement('div')
    modal.setAttribute('role', 'alertdialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    try {
      fireEvent.keyDown(window, { key: '1' })
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(spy).not.toHaveBeenCalled()
    } finally { modal.remove() }
  })

  it('non-modal dialogs do not block foreground question shortcuts', () => {
    const { spy } = renderChat(questionAsk)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'false')
    document.body.append(dialog)
    try {
      fireEvent.keyDown(window, { key: '1' })
      expect(spy).toHaveBeenCalledWith('once', { optionId: 'ship' })
    } finally { dialog.remove() }
  })

  it('digits owned by a small keyboard layer do not answer a background question', () => {
    const { spy } = renderChat(questionAsk)
    const layer = document.createElement('div')
    layer.setAttribute('data-esc-layer', '')
    document.body.append(layer)
    try {
      fireEvent.keyDown(window, { key: '1' })
      expect(spy).not.toHaveBeenCalled()
    } finally { layer.remove() }
    fireEvent.keyDown(window, { key: '1' })
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('once', { optionId: 'ship' })
  })

  it('ignores a digit that another keyboard handler already consumed', () => {
    const { spy } = renderChat(questionAsk)
    const event = new KeyboardEvent('keydown', { key: '1', cancelable: true })
    event.preventDefault()
    fireEvent(window, event)
    expect(spy).not.toHaveBeenCalled()
  })

  it.each([{ repeat: true }, { isComposing: true }])('ignores repeated or composing permission keys: %j', (flags) => {
    const { spy } = renderChat(questionAsk)
    fireEvent.keyDown(window, { key: '1', ...flags })
    fireEvent.keyDown(window, { key: 'Escape', ...flags })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not answer a hidden chat question from window shortcuts', () => {
    const spy = vi.fn()
    const props = { messages: [], threadKey: 't1', onSend: vi.fn(), permissionAsk: questionAsk, onPermission: spy }
    const { rerender } = render(<ChatPanel {...props} active={false} />)
    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(spy).not.toHaveBeenCalled()
    rerender(<ChatPanel {...props} active />)
    fireEvent.keyDown(window, { key: '2' })
    expect(spy).toHaveBeenCalledWith('once', { optionId: 'wait' })
  })

  it('shows a brief resolved flash after answering once the dock clears', () => {
    const { rerender } = renderChat(questionAsk)
    fireEvent.click(screen.getByRole('button', { name: /Not yet/ }))
    expect(screen.queryByTestId('widget-resolved')).toBeNull()
    rerender(
      <ChatPanel messages={[]} threadKey="t1" onSend={() => {}} permissionAsk={null} />,
    )
    const flash = screen.getByTestId('widget-resolved')
    expect(flash.textContent).toContain('Answered')
    expect(flash.textContent).toContain('Not yet')
    // Reduced motion is on in this suite → no transition style.
    expect(flash.style.transition).toBe('')
  })

  it('resolved flash auto-dismisses', () => {
    vi.useFakeTimers()
    const { rerender } = renderChat(questionAsk)
    fireEvent.click(screen.getByRole('button', { name: /Not yet/ }))
    rerender(
      <ChatPanel messages={[]} threadKey="t1" onSend={() => {}} permissionAsk={null} />,
    )
    expect(screen.getByTestId('widget-resolved')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1700)
    })
    expect(screen.queryByTestId('widget-resolved')).toBeNull()
  })
})

describe('slash commands', () => {
  it('"/new" typed out in full runs New conversation, not /new-agent', () => {
    const onNewAgent = vi.fn()
    const onNewConversation = vi.fn()
    render(
      <ChatPanel messages={[]} threadKey="t1" onSend={() => {}} onNewAgent={onNewAgent} onNewConversation={onNewConversation} />,
    )
    const composer = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '/new' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onNewConversation).toHaveBeenCalledOnce()
    expect(onNewAgent).not.toHaveBeenCalled()

    fireEvent.change(composer, { target: { value: '/new-agent' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onNewAgent).toHaveBeenCalledOnce()
  })
})

describe('quick-reply chips', () => {
  const ask = {
    id: 'a1',
    threadId: 't1',
    role: 'agent' as const,
    content: 'Landing page is up.',
    createdAt: '2026-10-06T00:00:00Z',
    choices: [
      { id: 'c1', label: 'Draft API client' },
      { id: 'c2', label: 'Skip for now' },
    ],
  }
  it('stay live when the chat moves on, and retire once one was picked', () => {
    const later = { id: 'u1', threadId: 't1', role: 'user' as const, content: 'Also attach the env example.', createdAt: '2026-10-06T00:00:01Z' }
    const { rerender } = render(<ChatPanel messages={[ask, later]} threadKey="t1" onSend={() => {}} onChoice={() => {}} />)
    expect((screen.getByRole('button', { name: 'Draft API client' }) as HTMLButtonElement).disabled).toBe(false)
    const pick = { id: 'u2', threadId: 't1', role: 'user' as const, content: '[choice:c1] Draft API client', createdAt: '2026-10-06T00:00:02Z' }
    rerender(<ChatPanel messages={[ask, later, pick]} threadKey="t1" onSend={() => {}} onChoice={() => {}} />)
    expect((screen.getByRole('button', { name: 'Draft API client' }) as HTMLButtonElement).disabled).toBe(true)
    // The pick's bubble shows the label, not the token.
    expect(screen.queryByText(/\[choice:/)).toBeNull()
  })
})

