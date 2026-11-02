import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RoomHandoffStrip } from '../RoomHandoffStrip'
import type { HandoffStrip } from '../../lib/agents/rooms'

const strip: HandoffStrip = {
  rowId: 'room_m2',
  fromMemberId: 'chief',
  pills: [
    { turnId: 't1', memberId: 'penny', name: 'Penny', state: 'replied', label: 'replied', replyRowId: 'room_m3' },
    { turnId: 't2', memberId: 'bob', name: 'CoderBob', state: 'working', label: 'using shell', replyRowId: null },
    { turnId: 't3', memberId: 'max', name: 'Max', state: 'passed', label: 'passed', replyRowId: null },
  ],
  wrap: { turnId: '', memberId: 'chief', name: 'Chief of Staff', state: 'pending', label: 'will wrap up', replyRowId: null },
  done: false,
}

afterEach(cleanup)

/** Visible pill text: the owl rig subtree is aria-hidden (its <title>/<desc>
// would otherwise leak into raw textContent), so strip hidden nodes first. */
function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[aria-hidden]').forEach((n) => n.remove())
  return clone.textContent ?? ''
}

// Pills draw the member's nubcat; its engine reads matchMedia (not in jsdom).
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

describe('RoomHandoffStrip', () => {
  it('renders one @pill per tagged member with its state, then the wrap', () => {
    render(<RoomHandoffStrip strip={strip} onJump={() => {}} />)
    const pills = screen.getAllByTestId('handoff-pill')
    expect(pills.map((p) => [visibleText(p), p.getAttribute('data-state')])).toEqual([
      ['@Pennyreplied ↓', 'replied'],
      ['@CoderBobusing shell', 'working'],
      ['@Maxpassed', 'passed'],
      ['Chief of Staffwill wrap up', 'pending'],
    ])
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe(
      'Handed off to Penny, CoderBob, Max: Penny replied, CoderBob using shell, Max passed. Chief of Staff will wrap up',
    )
  })

  it('only replied pills are buttons, and they jump to the reply row', () => {
    const onJump = vi.fn()
    render(<RoomHandoffStrip strip={strip} onJump={onJump} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(onJump).toHaveBeenCalledWith('room_m3')
  })

  it('with onOpen, every pill opens the transcript for its turn (no jump arrow)', () => {
    const onOpen = vi.fn()
    const onJump = vi.fn()
    render(<RoomHandoffStrip strip={strip} onJump={onJump} onOpen={onOpen} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    expect(visibleText(buttons[0]!)).toBe('@Pennyreplied')
    fireEvent.click(buttons[1]!)
    expect(onOpen).toHaveBeenCalledWith('room_m2', 't2')
    expect(onJump).not.toHaveBeenCalled()
  })
})
