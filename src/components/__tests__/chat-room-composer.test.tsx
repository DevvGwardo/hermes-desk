import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { LocalRoomEngine } from '../../lib/agents/local-rooms'
import { emptyRoomView, roomStatusOf } from '../../lib/agents/rooms'

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

afterEach(() => {
  cleanup()
})

const members = [
  { id: 'nub', name: 'Nub' },
  { id: 'bob', name: 'CoderBob' },
]

function renderRoom(extra?: Partial<Parameters<typeof ChatPanel>[0]>) {
  const onSend = vi.fn()
  const onStopTurn = vi.fn()
  const props: Parameters<typeof ChatPanel>[0] = {
    messages: [],
    threadKey: 'room',
    onSend,
    onStopTurn,
    showAgentSpeaker: true,
    mentionMembers: members,
    ...extra,
  }
  const { rerender, container } = render(<ChatPanel {...props} />)
  return { onSend, onStopTurn, rerender, container, props, box: screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement }
}

function type(box: HTMLTextAreaElement, value: string) {
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

describe('room composer @mentions', () => {
  it.each(['messenger', 'classic'] as const)('identifies the room member owning an approval (%s)', skin => {
    renderRoom({ skin, permissionAsk: { id: 'request', conversationId: 'room', sessionId: 'alpha',
      memberId: 'alpha', memberName: 'Alpha', choices: ['deny'], status: 'pending' }, onPermission: vi.fn() })
    expect(screen.getByRole('region', { name: 'Local tool permissions' }).textContent).toContain('Alpha')
  })
  it.each(['messenger', 'classic'] as const)('welcomes a room without asking for a profile (%s)', skin => {
    renderRoom({ skin })
    expect(screen.getByText('Message the room, or @mention a member to direct the work.')).toBeTruthy()
    expect(screen.queryByText('Choose a local profile in the sidebar to start.')).toBeNull()
    if (skin === 'messenger') {
      expect(screen.getByText('Shared room · On this Mac')).toBeTruthy()
      expect(screen.queryByText('Profile default · On this Mac')).toBeNull()
    }
  })
  it.each([70, 94])('quotes Unicode safely at the room preview boundary %i', prefixLength => {
    const { container, onSend, box } = renderRoom({
      skin: 'messenger',
      messages: [{
        id: 'unicode-original', threadId: 'room', role: 'user',
        content: 'x'.repeat(prefixLength) + '😀 ' + 'tail '.repeat(20),
        createdAt: '2026-10-10T07:00:00Z',
      }],
    })
    fireEvent.contextMenu(container.querySelector('[data-message-id="unicode-original"] .sand-message-action-anchor')!,
      { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }))
    const pill = screen.getByRole('region', { name: 'Replying' }).textContent!
    expect(new TextDecoder().decode(new TextEncoder().encode(pill))).toBe(pill)
    type(box, '@CoderBob inspect this quote.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const preview = String(onSend.mock.calls[0]![1].replyTo.snippet)
    expect(new TextDecoder().decode(new TextEncoder().encode(preview))).toBe(preview)
    expect(onSend.mock.calls[0]![1].replyTo.id).toBe('unicode-original')
  })

  it.each(['', ' \n\t '])('quotes an attachment-only room message with caption %j using its filename', content => {
    const { container, onSend, box } = renderRoom({
      skin: 'messenger',
      messages: [{
        id: 'original', threadId: 'room', role: 'user', content,
        createdAt: '2026-10-10T06:00:00Z',
        attachments: [{ id: 'constraints-file', name: 'constraints.txt', path: '/fake/constraints.txt', kind: 'file' }],
      }],
    })
    const anchor = container.querySelector('[data-message-id="original"] .sand-message-action-anchor')!
    fireEvent.contextMenu(anchor, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }))
    expect(screen.getByRole('region', { name: 'Replying' }).textContent).toContain('constraints.txt')
    type(box, '@CoderBob inspect these constraints.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('@CoderBob inspect these constraints.', {
      replyTo: { id: 'original', role: 'user', snippet: 'constraints.txt' },
    })
  })

  it('lists members and @everyone after @, and inserts plain @Name', () => {
    const { box } = renderRoom()
    type(box, 'ask @')
    const picker = screen.getByTestId('mention-picker')
    expect(picker.textContent).toContain('@Nub')
    expect(picker.textContent).toContain('@CoderBob')
    expect(picker.textContent).toContain('@everyone')

    type(box, 'ask @cod')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('ask @CoderBob ')
    expect(screen.queryByTestId('mention-picker')).toBeNull()
  })

  it('puts the caret right after the inserted mention in the same commit', () => {
    const { box } = renderRoom()
    fireEvent.change(box, { target: { value: 'ask @cod later', selectionStart: 8, selectionEnd: 8 } })
    fireEvent.select(box, { target: { selectionStart: 8, selectionEnd: 8 } })
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(box.value).toBe('ask @CoderBob later')
    // Synchronously — no animation frame between insert and the next key.
    expect(box.selectionStart).toBe('ask @CoderBob '.length)
  })

  it('Escape closes the picker without clearing the draft', () => {
    const { box } = renderRoom()
    type(box, '@n')
    expect(screen.getByTestId('mention-picker')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByTestId('mention-picker')).toBeNull()
    expect(box.value).toBe('@n')
  })

  it('no picker outside a group', () => {
    const { box } = renderRoom({ mentionMembers: [] })
    type(box, '@n')
    expect(screen.queryByTestId('mention-picker')).toBeNull()
  })
})

describe('room presence + stop', () => {
  it.each(['messenger', 'classic'] as const)('offers an explicit failed-member retry only after raising an exhausted budget (%s)', skin => {
    const room = new LocalRoomEngine('room', [{ id: 'nub', profile: 'nub', name: 'Nub' }], 'Room')
    room.setTokenBudget(20)
    room.setBinding('nub', { profile: 'nub', runtimeId: 'runtime', storedId: 'stored', lastSeen: 0 })
    const root = room.send('@Nub fixture request')
    const turn = room.takeReady()[0]!
    room.recordUsage('nub', { input: 10, output: 10, total: 20 })
    room.complete(turn.id, { error: 'Model failed' })
    const status = () => roomStatusOf({
      ...emptyRoomView(), ...room.feed(), enabled: true, hasOlder: false, latestRootId: root.id,
    }, () => 'Nub')
    const retry = vi.fn()
    const { rerender, props } = renderRoom({
      skin, localRoom: room.state, roomStatus: status(), onRetryTurn: retry,
    })
    expect(screen.queryByRole('button', { name: 'Try failed members again' })).toBeNull()
    expect(screen.getByText(/Raise the limit before retrying failed members/)).toBeTruthy()

    room.setTokenBudget(100)
    rerender(<ChatPanel {...props} localRoom={room.state} roomStatus={status()} />)
    expect(retry).not.toHaveBeenCalled()
    expect(room.state.turns[0]?.status).toBe('error')
    fireEvent.click(screen.getByRole('button', { name: 'Try failed members again' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('does not keep a newer room root retry disabled or clear its newer pending request', async () => {
    let finishFirst!: (result: boolean) => void
    let finishSecond!: (result: boolean) => void
    const first = vi.fn(() => new Promise<boolean>(resolve => { finishFirst = resolve }))
    const second = vi.fn(() => new Promise<boolean>(resolve => { finishSecond = resolve }))
    const status = (passRootId: string) => ({
      live: false, presence: null, passLine: "Nub couldn't answer", canRetry: true, passRootId,
    })
    const { rerender, props } = renderRoom({ roomStatus: status('first'), onRetryTurn: first })
    fireEvent.click(screen.getByRole('button', { name: 'Try failed members again' }))
    expect((screen.getByRole('button', { name: 'Trying again…' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<ChatPanel {...props} roomStatus={status('second')} onRetryTurn={second} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try failed members again' }))
    expect(second).toHaveBeenCalledTimes(1)
    await act(async () => finishFirst(false))
    expect((screen.getByRole('button', { name: 'Trying again…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => finishSecond(true))
    expect((screen.getByRole('button', { name: 'Try failed members again' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not show a stale retry failure after a new root arrives in the same room', async () => {
    let finish!: (result: boolean) => void
    const first = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const status = (passRootId: string) => ({
      live: false, presence: null, passLine: "Nub couldn't answer", canRetry: true, passRootId,
    })
    const { rerender, props } = renderRoom({ roomStatus: status('first'), onRetryTurn: first })
    fireEvent.click(screen.getByRole('button', { name: 'Try failed members again' }))
    rerender(<ChatPanel {...props} roomStatus={status('second')} />)
    await act(async () => finish(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers safe root retry before any agent reply exists', () => {
    const onRetryTurn = vi.fn()
    renderRoom({
      messages: [{ id: 'room_first', threadId: 'room', role: 'user', content: 'Initial request.', createdAt: '2026-10-10T07:00:00Z' }],
      roomStatus: { live: false, presence: null, passLine: "Nub couldn't answer", canRetry: true },
      onRetryTurn,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try failed members again' }))
    expect(onRetryTurn).toHaveBeenCalledTimes(1)
  })

  it.each(['uncertain', 'live', 'read-only'])('hides room retry for %s state', state => {
    renderRoom({
      roomStatus: { live: state === 'live', presence: null, passLine: "Nub couldn't answer", canRetry: state !== 'uncertain' },
      onRetryTurn: vi.fn(), readOnly: state === 'read-only',
    })
    expect(screen.queryByRole('button', { name: 'Try failed members again' })).toBeNull()
  })

  it('shows the presence line and a stop control while a member turn is live', () => {
    const { onStopTurn } = renderRoom({
      roomStatus: { live: true, presence: 'CoderBob is typing', passLine: null },
    })
    expect(screen.getByText('CoderBob is typing')).toBeTruthy()
    fireEvent.click(screen.getByTestId('stop-turn'))
    expect(onStopTurn).toHaveBeenCalled()
  })

  it('shows a dismissible pass line', () => {
    renderRoom({ roomStatus: { live: false, presence: null, passLine: 'AllenNub passed' } })
    expect(screen.getByTestId('room-pass-line').textContent).toContain('AllenNub passed')
    expect(screen.queryByTestId('stop-turn')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('room-pass-line')).toBeNull()
  })

  it('hiding a pass line hides only that thread of that room (R29)', () => {
    const passed = (passRootId: string) => ({ live: false, presence: null, passLine: 'AllenNub passed', passRootId })
    const { rerender, props } = renderRoom({ roomStatus: passed('rm_1') })
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('room-pass-line')).toBeNull()
    // Same words on a later thread in the same room: shown.
    rerender(<ChatPanel {...props} roomStatus={passed('rm_2')} />)
    expect(screen.getByTestId('room-pass-line')).toBeTruthy()
    // Same words and root id in another room: shown.
    rerender(<ChatPanel {...props} threadKey="other-room" roomStatus={passed('rm_1')} />)
    expect(screen.getByTestId('room-pass-line')).toBeTruthy()
    // Back to the first room's thread: still hidden.
    rerender(<ChatPanel {...props} roomStatus={passed('rm_1')} />)
    expect(screen.queryByTestId('room-pass-line')).toBeNull()
  })
})
