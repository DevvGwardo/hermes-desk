import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { markLocalRun, type Routine } from '../routines'
import { useLocalRoutineScheduler } from '../use-local-routine-scheduler'

const T0 = Date.parse('2026-09-30T08:59:00Z')

function job(over: Partial<Routine> = {}): Routine {
  return {
    id: 'rt-1',
    name: 'Brief',
    prompt: 'Brief me',
    schedule: '0 9 * * *',
    enabled: true,
    agentId: null,
    origin: 'local',
    lastRunAt: null,
    nextRunAt: new Date(T0 + 60_000).toISOString(),
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useLocalRoutineScheduler', () => {
  it('fires a local job once when it comes due', async () => {
    const fire = vi.fn()
    renderHook(() => useLocalRoutineScheduler([job()], fire))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(fire).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire.mock.calls[0]![0]).toMatchObject({ id: 'rt-1' })
  })

  it('does not re-fire while the send is still in flight', async () => {
    // The caller marks the run only after the prompt is sent — until then the
    // job stays due. The old loop re-armed at 0ms and fired it again each tick.
    const fire = vi.fn(() => new Promise<void>(() => {}))
    renderHook(() => useLocalRoutineScheduler([job()], fire))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('does not retry-storm when firing throws', async () => {
    const fire = vi.fn(async () => {
      throw new Error('Pick an agent first, then test run.')
    })
    renderHook(() => useLocalRoutineScheduler([job()], fire))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('fires the next occurrence once the run is marked', async () => {
    const fire = vi.fn()
    const first = job()
    const { rerender } = renderHook(({ jobs }) => useLocalRoutineScheduler(jobs, fire), {
      initialProps: { jobs: [first] },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fire).toHaveBeenCalledTimes(1)
    const marked = markLocalRun(first, Date.now())
    const next = { ...marked, nextRunAt: new Date(Date.now() + 60_000).toISOString() }
    rerender({ jobs: [next] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fire).toHaveBeenCalledTimes(2)
  })

  it('ignores disabled, empty, VM and host jobs', async () => {
    const fire = vi.fn()
    renderHook(() =>
      useLocalRoutineScheduler(
        [
          job({ id: 'a', enabled: false }),
          job({ id: 'b', prompt: '  ' }),
          job({ id: 'c', origin: 'remote' }),
          job({ id: 'd', origin: 'hermes' }),
          job({ id: 'e', nextRunAt: null }),
        ],
        fire,
      ),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(fire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops its timer on unmount', async () => {
    const fire = vi.fn()
    const { unmount } = renderHook(() => useLocalRoutineScheduler([job()], fire))
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(fire).not.toHaveBeenCalled()
  })
})
