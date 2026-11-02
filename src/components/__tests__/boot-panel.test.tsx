import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BOOT_SLOW_MS, BOOT_VERY_SLOW_MS, BootPanel, formatBootElapsed } from '../BootPanel'

// FatCatIcon reads prefers-reduced-motion via matchMedia.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('formatBootElapsed', () => {
  it('formats m:ss', () => {
    expect(formatBootElapsed(0)).toBe('0:00')
    expect(formatBootElapsed(7_500)).toBe('0:07')
    expect(formatBootElapsed(61_000)).toBe('1:01')
  })
})

describe('BootPanel', () => {
  it('shows connect active + sync pending while the roster hydrates', () => {
    render(<BootPanel rosterHydrating conversationsHydrating />)
    expect(screen.getByTestId('boot-panel')).toBeTruthy()
    expect(screen.getByText('Waking your agent…')).toBeTruthy()
    expect(screen.getByText('Connect to your agent')).toBeTruthy()
    expect(screen.getByText('Sync your conversations')).toBeTruthy()
    expect(screen.getByText('Waiting 0:00', { exact: false })).toBeTruthy()
  })

  it('marks connect done once the roster resolves', () => {
    render(<BootPanel rosterHydrating={false} conversationsHydrating />)
    expect(screen.getByText('Syncing your conversations…')).toBeTruthy()
  })

  it('reassures at 12s without a retry affordance', () => {
    vi.useFakeTimers()
    render(<BootPanel rosterHydrating conversationsHydrating onRetryRoster={() => {}} />)
    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_MS + 1000)
    })
    expect(
      screen.getByText('First connection can take up to a minute — your agents are on their way.'),
    ).toBeTruthy()
    expect(screen.queryByText('Retry now')).toBeNull()
  })

  it('escalates with retry at 45s', () => {
    vi.useFakeTimers()
    const onRetry = vi.fn()
    render(<BootPanel rosterHydrating conversationsHydrating onRetryRoster={onRetry} />)
    act(() => {
      vi.advanceTimersByTime(BOOT_VERY_SLOW_MS + 1000)
    })
    expect(screen.getByText('Still working — this is taking longer than usual.', { exact: false }))
      .toBeTruthy()
    fireEvent.click(screen.getByText('Retry now'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('still surfaces the error card with retry', () => {
    const onRetry = vi.fn()
    render(
      <BootPanel
        rosterHydrating={false}
        conversationsHydrating={false}
        rosterHydrateError="VM offline"
        onRetryRoster={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('fills the chat pane width so the waking block centers', () => {
    // Regression: the root once lacked flex-1, so as a flex-row item it
    // shrink-wrapped to max-w-sm and pinned the waking block to the left
    // of the chat pane instead of centering it.
    render(<BootPanel rosterHydrating conversationsHydrating />)
    const root = screen.getByTestId('boot-panel')
    expect(root.className.split(/\s+/)).toContain('flex-1')
  })
})
