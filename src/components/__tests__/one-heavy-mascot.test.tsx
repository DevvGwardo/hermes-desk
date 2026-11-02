import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { FatCatIcon } from '../FatCatIcon'
import { sidebarOrbPaused } from '../Sidebar'
import { SideChatHeader } from '../ChatPanel'

// jsdom: no IntersectionObserver / matchMedia — GrokOrb's gating hooks stub
// them out gracefully, but the observer effect needs the global to exist.
class FakeIO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
  }
  observe(_el: Element) {
    this.cb(
      [{ isIntersecting: true } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function unpausedCount(container: HTMLElement): number {
  // Engine marker: data-mascot-profile is 'reduced' whenever the owl is
  // paused for any reason (still/fxPaused prop, OS reduced-motion). Running
  // marks report 'small' (<=48px) or 'full'.
  return Array.from(container.querySelectorAll('svg[data-mascot-profile]')).filter(
    (el) => el.getAttribute('data-mascot-profile') !== 'reduced',
  ).length
}

describe('M1: one heavy mascot (docs/CHAT_LOAD_AND_MOTION_SPEC.md)', () => {
  it('still row marks plus the activity line leave ONE engine', async () => {
    // (The desktop sidebar animates working rows within its own budget —
    // sidebar-live-orb.test.tsx.)
    const still = sidebarOrbPaused(true, true)
    expect(still).toBe(true)
    const { container } = render(
      <div>
        <FatCatIcon expression="working" still={still} />
        <FatCatIcon expression="working" still={still} />
        <FatCatIcon expression="working" still={still} />
        {/* Activity line: the only unpaused mark in the shell. */}
        <FatCatIcon expression="working" still={false} />
      </div>,
    )
    await waitFor(() => expect(container.querySelectorAll('svg[data-mascot-profile]').length).toBe(4))
    expect(unpausedCount(container)).toBe(1)
  })

  it('a still mark carries shape + color with the engine paused', async () => {
    const { container } = render(<FatCatIcon expression="working" still />)
    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy())
    expect(unpausedCount(container)).toBe(0)
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('SideChatHeader renders static Pip avatars even while the child works', async () => {
    const { container } = render(<SideChatHeader parentName="Fixture parent" childLabel="Fixture child" childRunning />)
    await waitFor(() => expect(container.querySelectorAll('svg[data-mascot-profile="reduced"]')).toHaveLength(2))
    expect(container.querySelectorAll('[data-character="owl"]')).toHaveLength(2)
  })

  it('sidebarOrbPaused stays total: no caller can un-freeze a row', () => {
    for (const focused of [true, false]) {
      for (const live of [true, false]) {
        expect(sidebarOrbPaused(focused, live)).toBe(true)
      }
    }
  })
})
