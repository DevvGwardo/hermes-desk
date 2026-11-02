import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { HandoffTranscriptModal } from '../HandoffTranscriptModal'
import type { HandoffStrip } from '../../lib/agents/rooms'
import type { ChatMessage } from '../../lib/agents/types'

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

afterEach(cleanup)

const strips = new Map<string, HandoffStrip>([
  ['room_a', {
    rowId: 'room_a',
    fromMemberId: 'alien',
    done: false,
    pills: [
      { turnId: 't1', memberId: 'chief', name: 'Chief', state: 'replied', label: 'replied', replyRowId: 'room_b' },
      { turnId: 't2', memberId: 'bob', name: 'CoderBob', state: 'working', label: 'using shell', replyRowId: null },
    ],
    wrap: null,
  }],
])
const messages: ChatMessage[] = [
  { id: 'room_a', threadId: 'g', role: 'agent', fromAgentId: 'alien', content: 'check the recent commits', createdAt: '2026-09-29T13:00:00Z' },
  { id: 'room_b', threadId: 'g', role: 'agent', fromAgentId: 'chief', content: 'Three commits landed today.', createdAt: '2026-09-29T13:02:00Z' },
]
const names: Record<string, string> = { alien: 'AlienNub', chief: 'Chief', bob: 'CoderBob' }

describe('HandoffTranscriptModal', () => {
  it('shows the ask, the reply, and live status for members still working', () => {
    render(
      <HandoffTranscriptModal
        open
        rowId="room_a"
        focusTurnId="t1"
        strips={strips}
        messages={messages}
        agentName={(id) => names[id] ?? id}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Hand-off to Chief, CoderBob' })).toBeTruthy()
    const list = screen.getByTestId('handoff-transcript')
    expect(within(list).getByText('check the recent commits')).toBeTruthy()
    expect(within(list).getByText('Three commits landed today.')).toBeTruthy()
    expect(within(list).getByText('using shell')).toBeTruthy()
  })

  it('"Show in chat" closes the modal and jumps to that row', () => {
    const onClose = vi.fn()
    const onJump = vi.fn()
    render(
      <HandoffTranscriptModal
        open
        rowId="room_a"
        focusTurnId={null}
        strips={strips}
        messages={messages}
        agentName={(id) => names[id] ?? id}
        onJump={onJump}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Show in chat' })[1]!)
    expect(onClose).toHaveBeenCalled()
    expect(onJump).toHaveBeenCalledWith('room_b')
  })
})

describe('HandoffTranscriptModal status rows', () => {
  it('a long server status truncates instead of widening the modal', () => {
    const longLabel = 'using from hermes_tools import terminal cmd = """ BEARER="AAAA" curl -sL --max-time 15 -X POST https://api.x.com/1.1/guest/activate.json'
    const s = new Map<string, HandoffStrip>([
      ['room_a', {
        rowId: 'room_a', fromMemberId: 'alien', done: false,
        pills: [{ turnId: 't9', memberId: 'x', name: 'X Growth Analyst', state: 'working', label: longLabel, replyRowId: null }],
        wrap: null,
      }],
    ])
    render(<HandoffTranscriptModal open rowId="room_a" focusTurnId={null} strips={s} messages={messages} agentName={(id) => names[id] ?? id} onClose={() => {}} />)
    const row = document.querySelector('[data-turn-id="t9"]') as HTMLElement
    const name = within(row).getByText('X Growth Analyst')
    const label = within(row).getByText(longLabel)
    expect(name.className).toContain('whitespace-nowrap')
    expect(label.className).toContain('truncate')
    expect(label.className).toContain('min-w-0')
  })
})

describe('HandoffTranscriptModal reply composer', () => {
  it('opened from a member still working: addresses them with an @mention', () => {
    const onReply = vi.fn()
    render(<HandoffTranscriptModal open rowId="room_a" focusTurnId="t2" strips={strips} messages={messages} agentName={(id) => names[id] ?? id} onReply={onReply} onClose={() => {}} />)
    expect(screen.getByText('To CoderBob')).toBeTruthy()
    const box = screen.getByRole('textbox', { name: 'Reply in this hand-off' })
    fireEvent.change(box, { target: { value: 'status?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onReply.mock.calls[0]![0]).toBe('@CoderBob status?')
  })

  const props = {
    open: true,
    rowId: 'room_a',
    focusTurnId: null,
    strips,
    messages,
    agentName: (id: string) => names[id] ?? id,
    onClose: () => {},
  }

  it('sends a reply to the latest agent message in the thread', () => {
    const onReply = vi.fn()
    render(<HandoffTranscriptModal {...props} onReply={onReply} />)
    expect(screen.getByText('Replying to Chief')).toBeTruthy()
    const box = screen.getByRole('textbox', { name: 'Reply in this hand-off' })
    fireEvent.change(box, { target: { value: 'can you double check?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onReply.mock.calls[0]![0]).toBe('can you double check?')
    expect(onReply.mock.calls[0]![1].id).toBe('room_b')
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('Shift+Enter is a newline, empty drafts never send', () => {
    const onReply = vi.fn()
    render(<HandoffTranscriptModal {...props} onReply={onReply} />)
    const box = screen.getByRole('textbox', { name: 'Reply in this hand-off' })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onReply).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('read-only without onReply', () => {
    render(<HandoffTranscriptModal {...props} />)
    expect(screen.queryByRole('textbox', { name: 'Reply in this hand-off' })).toBeNull()
  })
})
