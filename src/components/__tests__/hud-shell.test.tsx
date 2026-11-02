import { HudShell } from '../HudShell'
import { agentColor } from '../AgentMascot'
import { __resetAgentPrompts, parseClarifyRequest, parseSecretRequest, setAgentPrompt } from '../../lib/agents/agent-prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// Hoisted before vi.mock factories run.
const { sendSpy, setCollapsedSpy, onPointerCapture, goToCursorSpy, moveToSpy, setClickThroughSpy, typeTextSpy, clickAtSpy, actStatusRef, requestActSpy, storeState, storeListeners, dictateStatusRef } = vi.hoisted(() => ({
  sendSpy: vi.fn(),
  setCollapsedSpy: vi.fn(),
  onPointerCapture: { cb: null as null | ((v: { phase: string; angle: number }) => void), off: vi.fn() },
  goToCursorSpy: vi.fn(),
  moveToSpy: vi.fn(),
  setClickThroughSpy: vi.fn(),
  typeTextSpy: vi.fn(),
  clickAtSpy: vi.fn(),
  actStatusRef: { current: { trusted: true, available: true, backend: 'jxa' } as unknown },
  requestActSpy: vi.fn(),
  storeState: {
    selectedConversationId: 'c1',
    conversations: [{ id: 'c1', title: 't', target: { type: 'agent', agentId: 'a1' }, createdAt: '', updatedAt: '' }],
    agents: [{ id: 'a1', avatarColor: '#ffd7e6' }],
    messages: [{ id: 'm1', role: 'user', content: 'hi' }] as Array<{ id: string; role: string; content: string; streaming?: boolean }>,
  },
  storeListeners: new Set<() => void>(),
  dictateStatusRef: { current: 'idle' as string },
}))

vi.mock('../../lib/agents/store', () => ({
  getState: () => storeState,
  subscribe: (cb: () => void) => { storeListeners.add(cb); return () => { storeListeners.delete(cb) } },
  getMessagesForConversation: () => storeState.messages,
}))

vi.mock('../../lib/agents/active-transport', () => ({
  getActiveTransport: async () => ({ transport: { sendMessage: sendSpy } }),
}))

vi.mock('../../lib/dictate', () => {
  class FakeDictate {
    start = vi.fn().mockImplementation(function (this: { status: string }) { return Promise.resolve() })
    stop = vi.fn().mockImplementation(function (this: { status: string }) { return Promise.resolve() })
  }
  return {
    DictateEngine: FakeDictate,
    appendTranscript: (d: string, c: string) => (d + ' ' + c).trim(),
    initialDictateStatus: () => dictateStatusRef.current,
    DICTATE_DENIED_COPY: 'Microphone access denied.',
  }
})
vi.mock('../../lib/stt', () => ({
  sttStatus: async () => ({ ok: true, model: 'tiny' }),
  transcribeAudio: vi.fn(),
}))

beforeEach(() => {
  cleanup()
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  window.history.replaceState(null, '', window.location.pathname + '?win=hud#/')
  storeState.messages = [{ id: 'm1', role: 'user', content: 'hi' }]
  storeListeners.clear()
  dictateStatusRef.current = 'idle'
  sendSpy.mockReset().mockResolvedValue(undefined)
  setCollapsedSpy.mockReset()
  moveToSpy.mockReset()
  setClickThroughSpy.mockReset()
  typeTextSpy.mockReset()
  clickAtSpy.mockReset().mockResolvedValue({ ok: true })
  requestActSpy.mockReset().mockResolvedValue({ ok: true, trusted: true })
  actStatusRef.current = { trusted: true, available: true, backend: 'jxa' }
  ;(window as unknown as { nubAgent?: { hud?: { close?: () => void; setCollapsed?: (c: boolean) => void; onPointer?: (cb: (v: { phase: string; angle: number }) => void) => (() => void) | void; goToCursor?: () => void; moveTo?: (x: number, y: number) => void; setClickThrough?: (v: boolean) => void; typeText?: (t: string) => void; clickAt?: (x: number, y: number) => unknown; actStatus?: () => unknown; requestActPermission?: () => unknown } } }).nubAgent = {
    hud: {
      close: vi.fn(),
      setCollapsed: setCollapsedSpy,
      onPointer: (cb) => { onPointerCapture.cb = cb; return onPointerCapture.off },
      goToCursor: goToCursorSpy,
      moveTo: moveToSpy,
      setClickThrough: setClickThroughSpy,
      typeText: typeTextSpy,
      clickAt: clickAtSpy,
      actStatus: () => Promise.resolve(actStatusRef.current),
      requestActPermission: requestActSpy,
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HudShell agent cards', () => {
  it('a question raised during a HUD turn opens the HUD and shows the card', async () => {
    __resetAgentPrompts()
    const responder = vi.fn(async () => {})
    storeState.messages = [
      { id: 'm1', role: 'user', content: 'order stickers' },
      { id: 'r1', role: 'agent', content: '', streaming: true },
    ]
    render(<HudShell />)
    // Unfocused and idle: the orb.
    expect(screen.getByTestId('hud-orb')).toBeTruthy()
    act(() => {
      setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Which city?', choices: ['Paris', 'Rome'] }, { conversationId: 'c1' })!, responder)
    })
    // The card holds the HUD open — the agent is waiting on it.
    expect(screen.queryByTestId('hud-orb')).toBeNull()
    expect(setCollapsedSpy).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('Which city?')).toBeTruthy()
    expect(screen.getByText('Waiting for your answer')).toBeTruthy()
    expect(screen.getByPlaceholderText('Type your answer…')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rome' }))
    })
    expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'Rome' }] })
    __resetAgentPrompts()
  })

  it('ignores cards for other conversations', () => {
    __resetAgentPrompts()
    render(<HudShell />)
    act(() => {
      setAgentPrompt(parseSecretRequest({ request_id: 'k', env_var: 'X_KEY' }, { conversationId: 'other' })!, vi.fn(async () => {}))
    })
    expect(screen.getByTestId('hud-orb')).toBeTruthy()
    __resetAgentPrompts()
  })
})

describe('HudShell orb idle state (G4)', () => {
  it('opens as the orb widget when unfocused (no strip flash)', () => {
    render(<HudShell />)
    expect(screen.getByTestId('hud-orb')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Ask Nub/u)).toBeNull()
    expect(setCollapsedSpy).toHaveBeenCalledWith(true)
  })

  it('renders the expanded strip when focused', () => {
    render(<HudShell />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    const input = screen.getByPlaceholderText(/Ask Nub/u)
    expect(input).toBeTruthy()
    expect(screen.queryByTestId('hud-orb')).toBeNull()
  })

  it('collapses to the orb when unfocused + idle, then expands on click', () => {
    render(<HudShell />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByPlaceholderText(/Ask Nub/u)).toBeTruthy()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    const orb = screen.getByTestId('hud-orb')
    expect(orb).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Ask Nub/u)).toBeNull()
    expect(setCollapsedSpy).toHaveBeenCalledWith(true)
    fireEvent.click(orb)
    expect(screen.getByPlaceholderText(/Ask Nub/u)).toBeTruthy()
    expect(setCollapsedSpy).toHaveBeenCalledWith(false)
  })

  it('shows Pip in the expanded strip and docks to the mascot on click', () => {
    render(<HudShell />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    const mascot = screen.getByTestId('hud-mascot')
    expect(mascot.getAttribute('data-mascot')).toBe(agentColor('a1'))
    expect(mascot.querySelector('[data-character="owl"]')).toBeTruthy()
    fireEvent.click(mascot)
    expect(screen.getByTestId('hud-orb')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Ask Nub/u)).toBeNull()
    expect(setCollapsedSpy).toHaveBeenCalledWith(true)
  })

  it('pointer state: walk → bob + aimed arrow, point → pulse, none → cleared', () => {
    render(<HudShell />)
    let orb = screen.getByTestId('hud-orb')
    expect(orb.getAttribute('data-walking')).toBeNull()
    expect(screen.queryByTestId('hud-pointer')).toBeNull()
    act(() => { onPointerCapture.cb && onPointerCapture.cb({ phase: 'walk', angle: 0.5 }) })
    orb = screen.getByTestId('hud-orb')
    expect(orb.getAttribute('data-walking')).toBe('')
    let ptr = screen.getByTestId('hud-pointer')
    expect(ptr.getAttribute('data-phase')).toBe('walk')
    expect(ptr.style.transform).toContain('rotate')
    act(() => { onPointerCapture.cb && onPointerCapture.cb({ phase: 'point', angle: 0 }) })
    orb = screen.getByTestId('hud-orb')
    expect(orb.getAttribute('data-walking')).toBeNull()
    ptr = screen.getByTestId('hud-pointer')
    expect(ptr.getAttribute('data-phase')).toBe('point')
    act(() => { onPointerCapture.cb && onPointerCapture.cb({ phase: 'none', angle: 0 }) })
    expect(screen.queryByTestId('hud-pointer')).toBeNull()
    expect(screen.getByTestId('hud-orb').getAttribute('data-walking')).toBeNull()
  })

  it('Alt-click on the orb calls goToCursor (provoked movement) and does NOT expand', () => {
    render(<HudShell />)
    const orb = screen.getByTestId('hud-orb')
    fireEvent.click(orb, { altKey: true })
    expect(goToCursorSpy).toHaveBeenCalledTimes(1)
    expect(setCollapsedSpy).not.toHaveBeenCalledWith(false)
    expect(screen.queryByPlaceholderText(/Ask Nub/u)).toBeNull()
  })

  it('stays expanded (never collapses) while focused', () => {
    render(<HudShell />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.getByPlaceholderText(/Ask Nub/u)).toBeTruthy()
    expect(screen.queryByTestId('hud-orb')).toBeNull()
  })

  it('orb reflects the selected agent mascot color', () => {
    render(<HudShell />)
    const orb = screen.getByTestId('hud-orb')
    expect(orb.getAttribute('data-mascot')).toBe(agentColor('a1'))
  })
})

describe('HudShell composer send path (G4)', () => {
  it('sends a message via the active transport', async () => {
    render(<HudShell />)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    const input = screen.getByPlaceholderText(/Ask Nub/u)
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })
})

describe('HudShell Clicky-mode (small mascot + bubble + point)', () => {
  it('expanded mode renders the speech bubble, not a transcript strip', () => {
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByTestId('hud-bubble')).toBeTruthy()
    expect(screen.getByTestId('hud-bubble-tail')).toBeTruthy()
    // current exchange only: only the last user line, not the whole history
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'old question' },
      { id: 'a1', role: 'agent', content: 'old answer' },
      { id: 'u2', role: 'user', content: 'current question' },
    ]
    act(() => { storeListeners.forEach((cb) => cb()); window.dispatchEvent(new Event('focus')) })
    expect(screen.getByText('current question')).toBeTruthy()
    expect(screen.queryByText('old question')).toBeNull()
    expect(screen.queryByText('old answer')).toBeNull()
  })

  it('[POINT:x,y] in an agent reply flies the cat there + is stripped from text', () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'where is the save button' },
      { id: 'a1', role: 'agent', content: 'Right here [POINT:300,400:save]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(moveToSpy).toHaveBeenCalledWith(300, 400)
    // marker removed from the displayed reply
    expect(screen.queryByText(/\[POINT/)).toBeNull()
    expect(screen.getByText(/Right here/)).toBeTruthy()
    // re-render with same marker does not re-fire moveTo
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(moveToSpy).toHaveBeenCalledTimes(1)
  })

  it('click-through: solid bubble = interactive, transparent root = click-through', () => {
    const { container } = render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    // bubble is solid
    fireEvent.mouseOver(screen.getByTestId('hud-bubble'))
    expect(setClickThroughSpy).toHaveBeenLastCalledWith(false)
    // a transparent area (the root, outside any solid selector)
    fireEvent.mouseOver(container.firstChild as Element)
    expect(setClickThroughSpy).toHaveBeenLastCalledWith(true)
  })

  it('[TYPE:text] in an agent reply types into the frontmost app + is stripped', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'type hello' },
      { id: 'a1', role: 'agent', content: 'Typing now [TYPE:hello world]' },
    ]
    render(<HudShell />)
    act(() => { storeListeners.forEach((cb) => cb()); window.dispatchEvent(new Event('focus')) })
    // Act markers wait for the Accessibility probe to settle before firing.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(typeTextSpy).toHaveBeenCalledWith('hello world')
    expect(screen.queryByText(/\[TYPE/)).toBeNull()
    expect(screen.getByText(/Typing now/)).toBeTruthy()
  })

  it('[POINT:x,y:label] shows the label chip while the cat is pointing', () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'where is it' },
      { id: 'a1', role: 'agent', content: 'Right there [POINT:200,300:Save button]' },
    ]
    render(<HudShell />)
    act(() => { storeListeners.forEach((cb) => cb()); window.dispatchEvent(new Event('focus')) })
    expect(moveToSpy).toHaveBeenCalledWith(200, 300)
    // simulate main telling us the cat arrived and is pointing
    act(() => { onPointerCapture.cb && onPointerCapture.cb({ phase: 'point', angle: 0 }) })
    const label = screen.getByTestId('hud-pointer-label')
    expect(label.textContent).toBe('Save button')
  })

  it('[CLICK:x,y] in an agent reply clicks there + is stripped + fires once', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'click the save button' },
      { id: 'a1', role: 'agent', content: 'On it [CLICK:842,510]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(clickAtSpy).toHaveBeenCalledWith(842, 510)
    // marker removed from the displayed reply — it is an instruction, not prose
    expect(screen.queryByText(/\[CLICK/)).toBeNull()
    expect(screen.getByText(/On it/)).toBeTruthy()
    // same marker on a later render must not click twice
    act(() => { storeListeners.forEach((cb) => cb()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(clickAtSpy).toHaveBeenCalledTimes(1)
  })

  it('negative screen coordinates survive the parser (display left of the primary)', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'where is it' },
      { id: 'a1', role: 'agent', content: 'There [POINT:-420,180:left screen]' },
    ]
    render(<HudShell />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(moveToSpy).toHaveBeenCalledWith(-420, 180)
  })

  it('D-03: an act marker renders the visible act chip — the click is never silent', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'click the save button' },
      { id: 'a1', role: 'agent', content: 'On it [CLICK:842,510]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const chip = screen.getByTestId('hud-act-chip')
    expect(chip.getAttribute('data-act')).toBe('click')
    expect(chip.textContent).toMatch(/clicked \(842, 510\)/)
    // the marker itself stays out of the prose (instruction, not sentence)
    expect(screen.queryByText(/\[CLICK/)).toBeNull()
  })

  it('D-03: [TYPE:] shows a typed-characters chip without leaking the text', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'type the password' },
      { id: 'a1', role: 'agent', content: 'Done [TYPE:hunter2]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const chip = screen.getByTestId('hud-act-chip')
    expect(chip.getAttribute('data-act')).toBe('type')
    expect(chip.textContent).toMatch(/typed 7 characters/)
    // the typed content must not surface in the chip — secrets stay out
    expect(chip.textContent).not.toContain('hunter2')
  })

  it('D-03: no chip when the reply carries no act marker', async () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'agent', content: 'Hi! Just pointing things out [POINT:10,10:x]' },
    ]
    render(<HudShell />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByTestId('hud-act-chip')).toBeNull()
  })

  it('Accessibility NOT granted → no click, and the bubble says why', async () => {
    actStatusRef.current = { trusted: false, available: false, backend: 'jxa' }
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'click it' },
      { id: 'a1', role: 'agent', content: 'Clicking [CLICK:100,200]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(clickAtSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('hud-act-hint').textContent).toMatch(/Accessibility/)
    // ...and the one button that can fix it asks the OS
    fireEvent.click(screen.getByTestId('hud-act-fix'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(requestActSpy).toHaveBeenCalledTimes(1)
  })

  it('[TYPE:] is gated by the same permission — never a silent no-op', async () => {
    actStatusRef.current = { trusted: false, available: false, backend: 'jxa' }
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'type hi' },
      { id: 'a1', role: 'agent', content: 'Typing [TYPE:hello]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(typeTextSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('hud-act-hint')).toBeTruthy()
  })

  it('unknown act status (no bridge) still attempts — old behavior preserved', async () => {
    delete (window as unknown as { nubAgent: { hud: Record<string, unknown> } }).nubAgent.hud.actStatus
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'click it' },
      { id: 'a1', role: 'agent', content: 'Clicking [CLICK:50,60]' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(clickAtSpy).toHaveBeenCalledWith(50, 60)
    expect(screen.queryByTestId('hud-act-hint')).toBeNull()
  })

  it('hold-to-talk mic button shows when stt is available, hidden when not', async () => {
    dictateStatusRef.current = 'idle'
    const { unmount } = render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByTestId('hud-mic')).toBeTruthy()
    unmount()
    // now simulate unavailable
    dictateStatusRef.current = 'unavailable'
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByTestId('hud-mic')).toBeNull()
  })
})

describe('HudShell streaming whitespace trim (trailing-newline / whitespace-only)', () => {
  it('renders streaming text with trailing newlines trimmed (no blank tail)', () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'go' },
      { id: 'a1', role: 'agent', content: 'answer with tail\n\n\n', streaming: true },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    const agent = document.querySelector('.hud-msg-agent')
    expect(agent).toBeTruthy()
    expect(agent!.textContent).toBe('answer with tail')
  })

  it('whitespace-only streaming text takes the ellipsis branch, not a blank bubble', () => {
    storeState.messages = [
      { id: 'a1', role: 'agent', content: '   \n  ', streaming: true },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    const agent = document.querySelector('.hud-msg-agent')
    expect(agent).toBeTruthy()
    expect(agent!.textContent).toBe('…')
    expect(screen.queryByTestId('hud-act-hint')).toBeNull()
  })

  it('whitespace-only settled text renders the empty state, not a blank bubble', () => {
    storeState.messages = [
      { id: 'a1', role: 'agent', content: '\n\t  \n' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(document.querySelector('.hud-msg-agent')).toBeNull()
    expect(document.querySelector('.hud-empty')).toBeTruthy()
  })

  it('trims trailing newlines from the user line (no blank tail)', () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: 'current question\n\n\n' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    const user = document.querySelector('.hud-msg-user')
    expect(user).toBeTruthy()
    expect(user!.textContent).toBe('current question')
  })

  it('whitespace-only user text renders the empty state, not a blank user bubble', () => {
    storeState.messages = [
      { id: 'u1', role: 'user', content: '  \n  ' },
    ]
    render(<HudShell />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(document.querySelector('.hud-msg-user')).toBeNull()
    expect(document.querySelector('.hud-empty')).toBeTruthy()
  })
})

describe('HudShell drag to move', () => {
  const dragStart = vi.fn()
  const dragMove = vi.fn()
  const dragEnd = vi.fn()
  beforeEach(() => {
    dragStart.mockReset().mockResolvedValue({ ok: true })
    dragMove.mockReset().mockResolvedValue({ ok: true })
    dragEnd.mockReset().mockResolvedValue({ ok: true })
    const hud = (window as unknown as { nubAgent: { hud: Record<string, unknown> } }).nubAgent.hud
    Object.assign(hud, { dragStart, dragMove, dragEnd })
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.releasePointerCapture = vi.fn()
    Element.prototype.hasPointerCapture = vi.fn(() => true)
  })

  const press = (el: Element, moves: Array<[number, number]>) => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, screenX: 100, screenY: 100 })
    for (const [x, y] of moves) {
      fireEvent.pointerMove(el, { pointerId: 1, screenX: x, screenY: y })
      act(() => {
        vi.advanceTimersByTime(20)
      })
    }
    fireEvent.pointerUp(el, { pointerId: 1, screenX: moves.at(-1)?.[0] ?? 100, screenY: moves.at(-1)?.[1] ?? 100 })
    fireEvent.click(el)
  }

  it('dragging the docked cat moves the window and is not a tap', () => {
    render(<HudShell />)
    const orb = screen.getByTestId('hud-orb')
    press(orb, [[110, 104], [140, 120], [180, 150]])
    expect(dragStart).toHaveBeenCalledTimes(1)
    expect(dragMove).toHaveBeenCalled()
    expect(dragEnd).toHaveBeenCalledTimes(1)
    // The click that ends a drag must not open the bubble.
    expect(screen.getByTestId('hud-orb')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Ask Nub/u)).toBeNull()
  })

  it('a press that moves under the threshold is still a click (opens the bubble)', () => {
    render(<HudShell />)
    const orb = screen.getByTestId('hud-orb')
    press(orb, [[102, 101]])
    expect(dragMove).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(/Ask Nub/u)).toBeTruthy()
  })

  it('Alt-press never starts a drag (Alt-click calls the cat)', () => {
    render(<HudShell />)
    const orb = screen.getByTestId('hud-orb')
    fireEvent.pointerDown(orb, { button: 0, altKey: true, pointerId: 1, screenX: 100, screenY: 100 })
    expect(dragStart).not.toHaveBeenCalled()
  })
})
