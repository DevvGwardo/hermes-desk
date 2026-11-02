import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { SLOW_AGENT_MS, SlowLoading } from '../settings/SlowLoading'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SlowLoading', () => {
  it('says Loading… first, then that the agent is slow to answer', () => {
    vi.useFakeTimers()
    render(<SlowLoading />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    act(() => vi.advanceTimersByTime(SLOW_AGENT_MS - 1))
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status').textContent).toMatch(/Still waiting for your agent/)
  })

  it('stops its clock when it goes away', () => {
    vi.useFakeTimers()
    const { unmount } = render(<SlowLoading />)
    unmount()
    expect(() => act(() => vi.advanceTimersByTime(SLOW_AGENT_MS * 2))).not.toThrow()
  })
})
