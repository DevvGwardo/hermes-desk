import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadLocalRoutines, markLocalRun, NEXT_RUN_CAP_MS, nextRunAt, routineDraftOf,
  saveLocalRoutines, upsertRoutine, type Routine,
} from '../routines'

const T0 = Date.parse('2026-10-09T08:00:00Z')

function job(id: string, schedule = 'every 1h'): Routine {
  return {
    id, origin: 'local', name: 'Synthetic interval routine', prompt: 'Synthetic interval instruction.',
    schedule, enabled: true, agentId: 'profile:alpha', lastRunAt: null, nextRunAt: null,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers(); window.localStorage.clear() })

describe('exact interval prediction anchors', () => {
  it.each([
    ['1m', 60_000],
    ['every 2 minutes', 120_000],
    ['every 7hours', 7 * 3_600_000],
    ['3d', 3 * 86_400_000],
  ] as const)('recomputes %s from each exact supplied instant within a minute', (schedule, interval) => {
    expect(nextRunAt(schedule, T0 + 1_250)).toBe(T0 + 1_250 + interval)
    expect(nextRunAt(schedule, T0 + 50_750)).toBe(T0 + 50_750 + interval)
  })

  it('does not keep a later anchor after the clock moves back within a minute', () => {
    const schedule = 'every 11h', interval = 11 * 3_600_000
    expect(nextRunAt(schedule, T0 + 55_000)).toBe(T0 + 55_000 + interval)
    expect(nextRunAt(schedule, T0 + 5_000)).toBe(T0 + 5_000 + interval)
  })

  it('persists a local edit at its own time instead of an earlier preview anchor', async () => {
    const original = job('rt-synthetic-interval-save', 'every 13h')
    saveLocalRoutines([original])
    nextRunAt(original.schedule, T0 + 2_000)
    vi.setSystemTime(T0 + 57_000)
    const saved = await upsertRoutine(routineDraftOf(original), original)
    const expected = new Date(T0 + 57_000 + 13 * 3_600_000).toISOString()
    expect(saved.nextRunAt).toBe(expected)
    expect(loadLocalRoutines()[0]?.nextRunAt).toBe(expected)
  })

  it('gives two completed local jobs their own anchors even with the same interval', () => {
    const first = job('rt-synthetic-first', 'every 17h'), second = job('rt-synthetic-second', 'every 17h')
    saveLocalRoutines([first, second])
    const one = markLocalRun(first, T0 + 3_000)
    const two = markLocalRun(second, T0 + 59_000)
    expect(one.nextRunAt).toBe(new Date(T0 + 3_000 + 17 * 3_600_000).toISOString())
    expect(two.nextRunAt).toBe(new Date(T0 + 59_000 + 17 * 3_600_000).toISOString())
    expect(loadLocalRoutines()).toEqual([one, two])
  })

  it('keeps preset and scanned cron occurrences stable across one minute', () => {
    for (const schedule of ['0 * * * *', '*/7 * * * *']) {
      const first = nextRunAt(schedule, T0 + 1_000)
      expect(first).not.toBeNull()
      expect(nextRunAt(schedule, T0 + 59_000)).toBe(first)
      expect(first).toBeGreaterThan(T0 + 59_000)
    }
  })

  it('retains exact absolute occurrences, including the elapsed boundary', () => {
    const schedule = '2026-10-09T08:00:30.125Z', at = Date.parse(schedule)
    expect(nextRunAt(schedule, at - 1)).toBe(at)
    expect(nextRunAt(schedule, at)).toBeNull()
  })

  it('retains the recurring horizon for interval arithmetic', () => {
    expect(nextRunAt('every 366d', T0 + 12_345)).toBe(T0 + 12_345 + NEXT_RUN_CAP_MS)
    expect(nextRunAt('every 367d', T0 + 12_345)).toBeNull()
  })

  it('keeps invalid, zero and unsupported intervals rejected', () => {
    for (const schedule of ['every 0m', '0h', 'every -2h', 'every 1.5h', 'every 3seconds', 'nonsense']) {
      expect(nextRunAt(schedule, T0)).toBeNull()
    }
  })
})
