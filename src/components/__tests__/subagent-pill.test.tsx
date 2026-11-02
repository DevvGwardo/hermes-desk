import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage, SubagentRun } from '../../lib/agents'

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

const run: SubagentRun = {
  id: 'run_1',
  parentAgentId: 'hermes',
  kind: 'debug',
  title: 'just to test it out and return hello',
  status: 'running',
  createdAt: '2026-08-12T12:00:00Z',
  digests: [{ id: 'd1', at: '2026-08-12T12:00:05Z', text: 'working on it' }],
  conversationId: 't1',
  taskId: 't-a995d1e6',
}

const parentMsg: ChatMessage = {
  id: 'u1',
  threadId: 't1',
  role: 'user',
  content: 'spawn a debugger',
  createdAt: '2026-08-12T12:00:00Z',
}

const pillMsg: ChatMessage = {
  id: 's1',
  threadId: 't1',
  role: 'subagent',
  content: 'Mapped Instances → agents; listed 3 open TODOs.',
  createdAt: '2026-08-12T12:00:01Z',
  subagentRunId: 'run_1',
  subagentKind: 'debug',
  subagentStatus: 'running',
}

function renderPanel(status: SubagentRun['status'] = 'running') {
  const msg: ChatMessage = { ...pillMsg, subagentStatus: status }
  return render(
    <ChatPanel
      messages={[parentMsg, msg]}
      threadKey="t1"
      onSend={() => {}}
      parentAgentName="Hermes"
      conversationSubagents={[{ ...run, status }]}
      mascot={{ shape: 'cat', color: '#b7dbff' }}
    />,
  )
}

describe('subagent pill + side chat (Grok Bot parity)', () => {
  it('renders a compact Messaged pill without dumping the digest into the parent', () => {
    renderPanel('running')
    expect(screen.getByRole('button', { name: /Messaged Debug/i })).toBeTruthy()
    expect(screen.queryByText('Mapped Instances → agents; listed 3 open TODOs.')).toBeNull()
    expect(screen.queryByText('Full conversation')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeTruthy()
  })

  it('flips copy to Message from when the worker finishes', () => {
    renderPanel('completed')
    expect(screen.getByRole('button', { name: /Message from Debug/i })).toBeTruthy()
  })

  it('uses the peer name instead of Custom for named specialists', () => {
    const msg: ChatMessage = {
      ...pillMsg,
      subagentKind: 'custom',
      subagentLabel: 'TravelAgent',
      subagentStatus: 'completed',
    }
    render(
      <ChatPanel
        messages={[parentMsg, msg]}
        threadKey="t1"
        onSend={() => {}}
        parentAgentName="Hermes"
        conversationSubagents={[{ ...run, kind: 'custom', label: 'TravelAgent', status: 'completed' }]}
        mascot={{ shape: 'cat', color: '#b7dbff' }}
      />,
    )
    expect(screen.getByRole('button', { name: /Message from TravelAgent/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Message from Custom/i })).toBeNull()
  })

  it('opens the side chat on pill click: dual header, digest in the room, no composer, no task id', () => {
    renderPanel('running')
    fireEvent.click(screen.getByRole('button', { name: /Messaged Debug/i }))
    expect(screen.getByText('Hermes')).toBeTruthy()
    expect(screen.getAllByText('Debug').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('working on it')).toBeTruthy()
    expect(screen.getByText('This chat is view-only')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close Chat/i })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Message the agent' })).toBeNull()
    expect(screen.queryByText('t-a995d1e6')).toBeNull()
    expect(screen.queryByText('This agent is working on its own')).toBeNull()
    expect(screen.queryByText('spawn a debugger')).toBeNull()
  })

  it('Close Chat returns to the parent stream with the pill still there', () => {
    renderPanel('running')
    fireEvent.click(screen.getByRole('button', { name: /Messaged Debug/i }))
    fireEvent.click(screen.getByRole('button', { name: /Close Chat/i }))
    expect(screen.getByText('spawn a debugger')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Messaged Debug/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeTruthy()
  })

  it('Escape closes the side chat', () => {
    renderPanel('running')
    fireEvent.click(screen.getByRole('button', { name: /Messaged Debug/i }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('spawn a debugger')).toBeTruthy()
  })

  it('shows Stop on a live pill and calls cancel', () => {
    const onCancel = vi.fn()
    render(
      <ChatPanel
        messages={[parentMsg, pillMsg]}
        threadKey="t1"
        onSend={() => {}}
        onCancelSubagent={onCancel}
        parentAgentName="Hermes"
        conversationSubagents={[run]}
        mascot={{ shape: 'cat', color: '#b7dbff' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Stop Debug/i }))
    expect(onCancel).toHaveBeenCalledWith('run_1')
  })

  it('a Stop that doesn\'t reach the agent says so above the composer', async () => {
    const onCancel = vi.fn(async () => false)
    render(
      <ChatPanel
        messages={[parentMsg, pillMsg]}
        threadKey="t1"
        onSend={() => {}}
        onCancelSubagent={onCancel}
        parentAgentName="Hermes"
        conversationSubagents={[run]}
        mascot={{ shape: 'cat', color: '#b7dbff' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Stop Debug/i }))
    expect((await screen.findByTestId('helper-note')).textContent).toMatch(/Couldn’t stop the helper/)
    expect(screen.getByTestId('helper-note').getAttribute('role')).toBe('alert')
  })

  it('lets you message a side chat that has a Hermes session', () => {
    const onMessage = vi.fn()
    render(
      <ChatPanel
        messages={[parentMsg, pillMsg]}
        threadKey="t1"
        onSend={() => {}}
        onMessageSubagent={onMessage}
        parentAgentName="Hermes"
        conversationSubagents={[{ ...run, hermesSessionId: 'child_sess' }]}
        mascot={{ shape: 'cat', color: '#b7dbff' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Messaged Debug/i }))
    expect(screen.queryByText('This chat is view-only')).toBeNull()
    const box = screen.getByPlaceholderText(/Message Debug/i)
    fireEvent.change(box, { target: { value: 'also check Saturday' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    expect(onMessage).toHaveBeenCalledWith('run_1', 'also check Saturday')
  })

  it('lets you message a side chat that has a Hermes subagent id even without a child session', () => {
    const onMessage = vi.fn()
    render(
      <ChatPanel
        messages={[parentMsg, pillMsg]}
        threadKey="t1"
        onSend={() => {}}
        onMessageSubagent={onMessage}
        parentAgentName="Hermes"
        conversationSubagents={[{ ...run, hermesSubagentId: 'sa_live' }]}
        mascot={{ shape: 'cat', color: '#b7dbff' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Messaged Debug/i }))
    expect(screen.queryByText('This chat is view-only')).toBeNull()
    const box = screen.getByPlaceholderText(/Message Debug/i)
    fireEvent.change(box, { target: { value: 'steer: cheaper flights' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    expect(onMessage).toHaveBeenCalledWith('run_1', 'steer: cheaper flights')
  })
})
