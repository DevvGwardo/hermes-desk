import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HudOrbButton } from '../HudOrbButton'

/**
 * The orb's visible affordance. The failures these pin are all real ones:
 * a button that renders on the web where there is no bridge (a dead control),
 * a button that guesses its own state instead of reading main's (drifts the
 * moment the hotkey or the Window menu moves the HUD), and — the one that
 * mattered most — a second owner of the toggle, which is what made ⌘⇧H able
 * to open the orb but never close it.
 */
type Changed = (v: { open: boolean }) => void

function installBridge(open = false) {
  const listeners: Changed[] = []
  const bridge = {
    toggle: vi.fn(async () => ({})),
    isOpen: vi.fn(async () => open),
    onChanged: vi.fn((cb: Changed) => {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    }),
    emit: (next: boolean) => {
      for (const cb of [...listeners]) cb({ open: next })
    },
    listenerCount: () => listeners.length,
  }
  ;(window as unknown as { nubAgent?: unknown }).nubAgent = {
    platform: 'darwin',
    hud: {
      toggle: bridge.toggle,
      isOpen: bridge.isOpen,
      onChanged: bridge.onChanged,
    },
  }
  return bridge
}

const button = () => screen.queryByTestId('hud-orb-toggle')

beforeEach(() => {
  cleanup()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  // jsdom has no matchMedia; the mascot engine asks for prefers-reduced-motion.
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

describe('HudOrbButton', () => {
  it('renders NOTHING without the desktop bridge — never a dead control on web/phone', () => {
    render(<HudOrbButton />)
    expect(button()).toBeNull()
  })

  it('seeds its state from main, so an orb hotkeyed before mount still reads as open', async () => {
    installBridge(true)
    render(<HudOrbButton />)
    await waitFor(() => expect(button()).toHaveProperty('ariaPressed', 'true'))
    expect(button()?.getAttribute('title')).toContain('Hide Nub orb')
  })

  it('starts unpressed when main reports the HUD closed', async () => {
    installBridge(false)
    render(<HudOrbButton />)
    await waitFor(() => expect(button()).toBeTruthy())
    expect(button()?.getAttribute('aria-pressed')).toBe('false')
    expect(button()?.getAttribute('title')).toContain('Show Nub orb')
  })

  it('follows the maia:hud:changed broadcast instead of tracking a local counter', async () => {
    const bridge = installBridge(false)
    render(<HudOrbButton />)
    await waitFor(() => expect(button()).toBeTruthy())

    act(() => bridge.emit(true))
    await waitFor(() => expect(button()?.getAttribute('aria-pressed')).toBe('true'))

    act(() => bridge.emit(false))
    await waitFor(() => expect(button()?.getAttribute('aria-pressed')).toBe('false'))
  })

  it('one click = one toggle invoke — the renderer never toggles a second time', async () => {
    const bridge = installBridge(false)
    render(<HudOrbButton />)
    await waitFor(() => expect(button()).toBeTruthy())

    fireEvent.click(button() as HTMLElement)
    expect(bridge.toggle).toHaveBeenCalledTimes(1)
  })

  it('never flips its own state on click — only main’s broadcast moves it', async () => {
    const bridge = installBridge(false)
    render(<HudOrbButton />)
    await waitFor(() => expect(button()).toBeTruthy())

    fireEvent.click(button() as HTMLElement)
    // No maia:hud:changed has arrived yet. The toggle may be rejected, or the
    // hotkey may have closed the orb between render and click — pressing
    // itself here would be a claim nobody made.
    expect(button()?.getAttribute('aria-pressed')).toBe('false')

    act(() => bridge.emit(true))
    await waitFor(() => expect(button()?.getAttribute('aria-pressed')).toBe('true'))
  })

  it('unsubscribes on unmount so a re-mounted TopBar does not stack listeners', async () => {
    const bridge = installBridge(false)
    const view = render(<HudOrbButton />)
    await waitFor(() => expect(bridge.listenerCount()).toBe(1))

    view.unmount()
    expect(bridge.listenerCount()).toBe(0)
  })
})
