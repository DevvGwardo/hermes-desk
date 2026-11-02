/**
 * Once routines read in the device's timezone. The editor sends an ISO
 * instant; the agent stores `display: "once at YYYY-MM-DD HH:MM"` in UTC, so
 * rows read the agent's next run (local) instead of that text.
 */
import { describe, expect, it } from 'vitest'
import { describeCronSchedule, describeRoutineSchedule } from '../routines'

const local = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

describe('Once schedule wording', () => {
  const year = new Date().getFullYear()
  const at = `${year}-12-05T18:30:00.000Z`

  it('describes an ISO instant in local time (right after saving)', () => {
    expect(describeCronSchedule(at)).toBe(`Once on ${local(at)}`)
  })

  it("prefers the agent's next run over its UTC 'once at' display", () => {
    expect(describeRoutineSchedule({ schedule: `once at ${year}-12-05 18:30`, nextRunAt: at })).toBe(`Once on ${local(at)}`)
    expect(describeRoutineSchedule({ schedule: { kind: 'once', display: `once at ${year}-12-05 18:30` }, nextRunAt: at })).toBe(`Once on ${local(at)}`)
  })

  it('keeps the stored text when there is no next run, and leaves recurring schedules alone', () => {
    expect(describeRoutineSchedule({ schedule: `once at ${year}-12-05 18:30`, nextRunAt: null })).toBe(`once at ${year}-12-05 18:30`)
    expect(describeRoutineSchedule({ schedule: '0 8 * * *', nextRunAt: at })).toBe('Every day at 8:00 AM')
  })

  it('adds the year when the run is not this year', () => {
    const later = `${year + 1}-01-02T09:00:00Z`
    expect(describeCronSchedule(later)).toContain(String(year + 1))
  })
})
