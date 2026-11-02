import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEDULE_PICKER,
  SCHEDULE_PRESETS,
  describePicker,
  isPlausibleSchedule,
  nextRunAt,
  onceRunAt,
  pickerFromSchedule,
  pickerToCron,
  type ScheduleFrequency,
} from '../routines'

describe('schedule picker ↔ cron', () => {
  it('defaults reproduce every old preset chip exactly', () => {
    const byKey: Record<string, ScheduleFrequency> = {
      hourly: 'hourly',
      daily: 'daily',
      weekdays: 'weekdays',
      weekly: 'weekly',
      monthly: 'monthly',
    }
    for (const p of SCHEDULE_PRESETS) {
      expect(pickerToCron({ ...DEFAULT_SCHEDULE_PICKER, frequency: byKey[p.key]! })).toBe(p.expr)
    }
  })

  it.each([
    ['0 * * * *', 'hourly'],
    ['28 * * * *', 'hourly'],
    ['0 9 * * *', 'daily'],
    ['28 20 * * 1-5', 'weekdays'],
    ['0 9 * * 1', 'weekly'],
    ['30 7 * * 1,3,5', 'weekly'],
    ['0 9 1 * *', 'monthly'],
    ['45 18 31 * *', 'monthly'],
  ])('%s round-trips through the %s picker', (cron, freq) => {
    const p = pickerFromSchedule(cron)
    expect(p?.frequency).toBe(freq)
    expect(pickerToCron(p!)).toBe(cron)
  })

  it('weekly normalises Sunday 7 to 0 and sorts days', () => {
    const p = pickerFromSchedule('0 9 * * 7')!
    expect(p.weekdays).toEqual([0])
    expect(pickerToCron({ ...p, weekdays: [5, 1, 3] })).toBe('0 9 * * 1,3,5')
  })

  it.each(['*/15 * * * *', '0 9-17 * * *', '0 9 * 1 *', '0 9 1 * 1', '0 9 * * MON', 'every 2h', '30m', '', '0 9 * *'])(
    '%s is not a preset (custom)',
    (cron) => {
      expect(pickerFromSchedule(cron)).toBeNull()
    },
  )

  it('Once preserves its date and still reads legacy fixed-date cron jobs', () => {
    const p = { ...DEFAULT_SCHEDULE_PICKER, frequency: 'once' as const, hour: 14, minute: 30, date: '2026-10-05' }
    expect(pickerToCron(p)).toBe(new Date(2026, 9, 5, 14, 30).toISOString())
    expect(describePicker(p)).toBe('Once on Oct 5, 2026 at 2:30 PM')
    expect(onceRunAt(p)).toBe(new Date(2026, 9, 5, 14, 30).getTime())
    const now = new Date(2026, 9, 1, 12, 0).getTime()
    expect(pickerFromSchedule('30 14 5 10 *', { runOnce: true, now })).toEqual(p)
    // Already passed this year → next year.
    expect(pickerFromSchedule('30 14 5 9 *', { runOnce: true, now })?.date).toBe('2027-09-05')
    // A fixed-date cron without runOnce is not a preset.
    expect(pickerFromSchedule('30 14 5 10 *', { now })).toBeNull()
  })

  it('a run-once job on a repeating cron opens as Once at its next run', () => {
    const now = new Date(2026, 9, 1, 12, 0).getTime()
    expect(pickerFromSchedule('0 9 * * *', { runOnce: true, now })).toMatchObject({
      frequency: 'once',
      date: '2026-10-02',
      hour: 9,
      minute: 0,
    })
  })

  it('preserves a future year and an absolute instant for Once schedules', () => {
    const picker = { ...DEFAULT_SCHEDULE_PICKER, frequency: 'once' as const, date: '2027-10-05', hour: 14, minute: 30 }
    const instant = new Date(2027, 9, 5, 14, 30).getTime()
    const schedule = pickerToCron(picker)
    expect(schedule).toBe(new Date(instant).toISOString())
    expect(nextRunAt(schedule, new Date(2026, 9, 4).getTime())).toBe(instant)
    expect(pickerFromSchedule(schedule, { runOnce: true, now: new Date(2026, 9, 4).getTime() })).toEqual(picker)
  })

  it('opens an existing one-shot interval at its stored next run, not now plus the interval', () => {
    const now = new Date(2026, 9, 5, 13).getTime()
    const next = new Date(2026, 9, 5, 14).toISOString()
    expect(pickerFromSchedule('every 2h', { runOnce: true, now, nextRunAt: next })).toMatchObject({
      frequency: 'once',
      date: '2026-10-05',
      hour: 14,
      minute: 0,
    })
    expect(pickerFromSchedule('every 2h', { runOnce: true, now })).toBeNull()
  })

  it.each(['2027-10-05T14:30:00Z', '2027-10-05T14:30:00+02:00', '2027-10-05T14:30:00.123-04:00'])(
    'accepts the timezone-qualified ISO schedule %s',
    (schedule) => expect(isPlausibleSchedule(schedule)).toBe(true),
  )

  it('does not normalize an unset date or invalid clock into a different Once run', () => {
    expect(pickerToCron({ ...DEFAULT_SCHEDULE_PICKER, frequency: 'once', date: '' })).toBe('')
    expect(onceRunAt({ ...DEFAULT_SCHEDULE_PICKER, date: '2027-10-05', hour: 24 })).toBeNull()
    expect(onceRunAt({ ...DEFAULT_SCHEDULE_PICKER, date: '2027-02-30' })).toBeNull()
  })

  it('does not return an elapsed absolute occurrence from a minute cache', () => {
    const schedule = '2027-10-05T14:30:00.000Z'
    const at = Date.parse(schedule)
    expect(nextRunAt(schedule, at - 1)).toBe(at)
    expect(nextRunAt(schedule, at)).toBeNull()
    expect(nextRunAt(schedule, at + 1)).toBeNull()
  })

  it('describePicker reuses describeCronSchedule wording', () => {
    expect(describePicker({ ...DEFAULT_SCHEDULE_PICKER, frequency: 'weekdays', hour: 20, minute: 28 })).toBe(
      'Weekdays at 8:28 PM',
    )
    expect(describePicker({ ...DEFAULT_SCHEDULE_PICKER, frequency: 'once', date: '' })).toBe('Once (pick a date)')
  })

  it('isPlausibleSchedule accepts cron, intervals and ISO dates', () => {
    for (const s of ['0 9 * * 1-5', '*/5 * * * *', '0 9 * * MON-FRI', 'every 2h', '30m', '2026-10-05T14:30'])
      expect(isPlausibleSchedule(s)).toBe(true)
    for (const s of ['', 'nonsense', '0 9 * *', 'tomorrow']) expect(isPlausibleSchedule(s)).toBe(false)
  })
})
