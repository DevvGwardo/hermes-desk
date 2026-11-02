import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'
import { hostMachinePhrase } from '../../lib/host-label'

// jsdom has no scrollIntoView; ChatPanel's auto-scroll calls it on mount.
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

function renderChat(opts: {
  toolEvents?: NonNullable<ChatMessage['toolEvents']>
  sending?: boolean
  streaming?: boolean
  agentContent?: string
  toolWhere?: 'mac' | 'vm'
}) {
  const messages: ChatMessage[] = [
    {
      id: 'u1',
      threadId: 't1',
      role: 'user',
      content: 'run the thing',
      createdAt: '2026-08-12T12:00:00Z',
    },
    {
      id: 'a1',
      threadId: 't1',
      role: 'agent',
      content: opts.agentContent ?? 'Done.',
      createdAt: '2026-08-12T12:00:01Z',
      streaming: opts.streaming,
      toolEvents: opts.toolEvents,
    },
  ]
  return render(
    <ChatPanel
      skin="classic"
      messages={messages}
      threadKey="t1"
      sending={opts.sending}
      onSend={() => {}}
      mascot={{ shape: 'blob', color: '#b7dbff' }}
      parentAgentName="Local Hermes"
      toolWhere={opts.toolWhere}
    />,
  )
}

describe('tool-call rendering (Grok Bot 0.18 transcript skip)', () => {
  it('does not nest tool-call rows inside the assistant bubble', () => {
    renderChat({
      toolEvents: [
        {
          tool: 'terminalToolCall',
          label: 'terminalToolCall',
          toolCallId: 't1',
          status: 'completed',
          summary: 'ran ls -la\n2 files',
        },
      ],
    })
    expect(screen.getByText('Done.')).toBeTruthy()
    expect(screen.queryByText('Terminal')).toBeNull()
    expect(screen.queryByText('Arguments')).toBeNull()
  })

  it('shows a spoken activity line while a tool is running', () => {
    renderChat({
      sending: true,
      streaming: true,
      agentContent: '',
      toolEvents: [{ tool: 'web_search', label: 'web_search', status: 'running' }],
    })
    expect(screen.getByText('Searching the web')).toBeTruthy()
    expect(screen.queryByText('Web search')).toBeNull()
  })

  it('lets you send a follow-up while Working… is showing', () => {
    const onSend = vi.fn()
    render(
      <ChatPanel
        skin="classic"
        messages={[
          {
            id: 'u1',
            threadId: 't1',
            role: 'user',
            content: 'run the thing',
            createdAt: '2026-08-12T12:00:00Z',
          },
          {
            id: 'a1',
            threadId: 't1',
            role: 'agent',
            content: '',
            createdAt: '2026-08-12T12:00:01Z',
            streaming: true,
          },
        ]}
        threadKey="t1"
        sending
        onSend={onSend}
        mascot={{ shape: 'blob', color: '#b7dbff' }}
        parentAgentName="Local Hermes"
      />,
    )
    expect(screen.getByText('Working…')).toBeTruthy()
    const box = screen.getByPlaceholderText('Message the agent…')
    fireEvent.change(box, { target: { value: 'follow up' } })
    const send = screen.getByRole('button', { name: 'Send' })
    expect((send as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(send)
    expect(onSend.mock.calls[0]?.[0]).toBe('follow up')
  })

  it('does not paint an empty streaming bubble; wait is FatCat on the activity line', () => {
    renderChat({ sending: true, streaming: true, agentContent: '' })
    expect(screen.getByText('Working…')).toBeTruthy()
    expect(screen.getByText('run the thing')).toBeTruthy()
    expect(document.querySelector('.streaming-caret')).toBeNull()
    expect(document.querySelector('[data-message-id="a1"]')).toBeNull()
    const line = screen.getByText('Working…').closest('[data-activity]')
    expect(line?.querySelector('svg')).toBeTruthy()
  })

  it('draws Pip at the compact 32px activity size', () => {
    renderChat({ sending: true, streaming: true, agentContent: '' })
    const line = screen.getByText('Working…').closest('[data-activity]')
    const mascot = line?.querySelector('[data-character="owl"]') as HTMLElement | null
    expect(mascot?.style.width).toBe('32px')
    expect(mascot?.querySelector('svg')).toBeTruthy()
  })

  it('docks the working mascot above the composer so the input cannot clip it', () => {
    renderChat({ sending: true, streaming: true, agentContent: '' })
    const line = screen.getByText('Working…').closest('[data-activity]')
    const form = screen.getByPlaceholderText('Message the agent…').closest('form')
    expect(line).toBeTruthy()
    // The line sits in its collapsible slot, directly above the composer.
    expect(form?.previousElementSibling?.classList.contains('ca-activity-slot')).toBe(true)
    expect(form?.previousElementSibling?.contains(line!)).toBe(true)
    expect(vi.mocked(Element.prototype.scrollIntoView)).not.toHaveBeenCalled()
  })

  it('shows Typing… after tools finish while tokens still stream', () => {
    renderChat({
      sending: true,
      streaming: true,
      agentContent: 'Here is what I found',
      toolEvents: [{ tool: 'web_search', label: 'web_search', status: 'completed', summary: 'Found 3' }],
    })
    expect(screen.getByText('Typing…')).toBeTruthy()
    expect(screen.queryByText('Searching the web')).toBeNull()
  })

  it('terminal stays local even when a legacy caller supplies the VM hint', () => {
    renderChat({
      sending: true,
      streaming: true,
      agentContent: '',
      toolWhere: 'vm',
      toolEvents: [{ tool: 'terminal', label: 'terminal', status: 'running' }],
    })
    expect(screen.getByText('Running commands')).toBeTruthy()
    const pill = screen.getByRole('img', { name: `On ${hostMachinePhrase()}` })
    expect(pill.getAttribute('data-where')).toBe('mac')
    expect(pill.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText('VM')).toBeNull()
  })

  it('local externalshell → monitor icon pill (On the host)', () => {
    renderChat({
      sending: true,
      streaming: true,
      agentContent: '',
      toolWhere: 'mac',
      toolEvents: [{ tool: 'ExternalShell', label: 'ExternalShell', status: 'running' }],
    })
    const pill = screen.getByRole('img', { name: `On ${hostMachinePhrase()}` })
    expect(pill.getAttribute('data-where')).toBe('mac')
    expect(pill.querySelector('svg')).toBeTruthy()
  })

  it('renders the local tool permission dock above the composer', () => {
    const onPermission = vi.fn()
    render(
      <ChatPanel
        skin="classic"
        messages={[
          {
            id: 'u1',
            threadId: 't1',
            role: 'user',
            content: 'rm -rf /tmp/x',
            createdAt: '2026-08-12T12:00:00Z',
          },
        ]}
        threadKey="t1"
        onSend={() => {}}
        permissionAsk={{
          id: 'ask1',
          conversationId: 't1',
          sessionId: 'sess',
          command: 'rm -rf /tmp/x',
          choices: ['once', 'always', 'deny'],
          status: 'pending',
        }}
        onPermission={onPermission}
      />,
    )
    expect(screen.getByRole('region', { name: 'Local tool permissions' })).toBeTruthy()
    expect(screen.getByText('Allow once')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onPermission).toHaveBeenCalledWith('always')
  })
})
