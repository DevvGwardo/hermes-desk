import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_WINDOW_MS,
  DORMANT_AFTER_MS,
  DORMANT_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  __resetPollCadenceForTests,
  noteActivity,
  onWake,
  pollDelay,
  startAdaptivePoll,
} from '../poll-cadence'

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  setVisibility('visible')
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  __resetPollCadenceForTests(Date.now())
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pollDelay', () => {
  it('uses the base interval while active and focused', () => {
    expect(pollDelay(10_000)).toBe(10_000)
  })

  it('backs off when idle, then dormant', () => {
    const t0 = Date.now()
    expect(pollDelay(10_000, { at: t0 + ACTIVE_WINDOW_MS + 1 })).toBe(IDLE_INTERVAL_MS)
    expect(pollDelay(10_000, { at: t0 + DORMANT_AFTER_MS + 1 })).toBe(DORMANT_INTERVAL_MS)
  })

  it('treats an unfocused window as idle', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(pollDelay(10_000)).toBe(IDLE_INTERVAL_MS)
  })

  it('keeps the base interval while something is live', () => {
    expect(pollDelay(1_000, { live: true, at: Date.now() + DORMANT_AFTER_MS * 2 })).toBe(1_000)
  })

  it('returns null while hidden', () => {
    setVisibility('hidden')
    expect(pollDelay(10_000)).toBeNull()
  })
})

describe('wake', () => {
  it('fires only when activity follows idle', () => {
    const fn = vi.fn()
    onWake(fn)
    noteActivity(Date.now() + 1_000)
    expect(fn).not.toHaveBeenCalled()
    noteActivity(Date.now() + 1_000 + ACTIVE_WINDOW_MS + 1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('startAdaptivePoll', () => {
  it('refreshes immediately after a short hidden period, not only after idle', async () => {
    setVisibility('hidden')
    const tick = vi.fn()
    const stop = startAdaptivePoll(tick, 10_000, { immediate: false })
    try {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(tick).not.toHaveBeenCalled()
      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(tick).toHaveBeenCalledOnce()
    } finally { stop() }
  })

  it('polls at base while active, far less when idle, and at once on wake', async () => {
    const tick = vi.fn()
    const stop = startAdaptivePoll(tick, 10_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1) // immediate
    await vi.advanceTimersByTimeAsync(60_000)
    const activeCalls = tick.mock.calls.length
    expect(activeCalls).toBeGreaterThanOrEqual(6)

    // An hour with no input: ~24 polls (was 720 at a flat 5s).
    tick.mockClear()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(tick.mock.calls.length).toBeLessThanOrEqual(25)

    // User returns → immediate refresh.
    tick.mockClear()
    noteActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not tick while hidden', async () => {
    setVisibility('hidden')
    const tick = vi.fn()
    const stop = startAdaptivePoll(tick, 10_000)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(tick).not.toHaveBeenCalled()
    stop()
  })
})
