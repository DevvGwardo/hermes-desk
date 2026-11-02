import { describe, expect, it } from 'vitest'
import { describeCronSchedule, displayRoutineName } from '../routines'

describe('describeCronSchedule', () => {
  it.each([
    ['28 20 * * 1-5', 'Weekdays at 8:28 PM'],
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 0 * * *', 'Every day at 12:00 AM'],
    ['30 12 * * *', 'Every day at 12:30 PM'],
    ['0 9 * * 1', 'Mondays at 9:00 AM'],
    ['0 17 * * 5', 'Fridays at 5:00 PM'],
    ['0 10 * * 0,6', 'Weekends at 10:00 AM'],
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri at 9:00 AM'],
    ['0 9 1 * *', 'Monthly on the 1st at 9:00 AM'],
    ['0 9 22 * *', 'Monthly on the 22nd at 9:00 AM'],
    ['0 9 11 * *', 'Monthly on the 11th at 9:00 AM'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at :15'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['every 30m', 'Every 30 minutes'],
    ['every 2h', 'Every 2 hours'],
    ['every 1h', 'Every hour'],
    ['every 60m', 'Every hour'],
    ['every 90m', 'Every 90 minutes'],
    ['every 120m', 'Every 2 hours'],
    ['every 48h', 'Every 2 days'],
    ['*/60 * * * *', 'Every hour'],
  ])('%s → %s', (expr, words) => {
    expect(describeCronSchedule(expr)).toBe(words)
  })

  it('reads the object shapes the agent API returns', () => {
    expect(describeCronSchedule({ expr: '0 9 * * 1-5' })).toBe('Weekdays at 9:00 AM')
  })

  it('words the expression behind an agent display, and capitalizes a display it cannot word', () => {
    expect(describeCronSchedule({ display: 'every day at 9am', expr: '0 9 * * *' })).toBe('Every day at 9:00 AM')
    expect(describeCronSchedule({ display: 'every 60m', expr: 'every 60m' })).toBe('Every hour')
    expect(describeCronSchedule({ display: 'every weekday morning', expr: '0 9-11 * * 1-5' })).toBe('Every weekday morning')
  })

  it('leaves shapes it does not know as written, never guessing', () => {
    for (const expr of ['0 9 * 3 *', '0 9-17 * * *', '0 9 1 * 1', 'at 2026-10-01 09:00', '']) {
      expect(describeCronSchedule(expr)).toBe(expr)
    }
  })
})

describe('displayRoutineName', () => {
  it.each([
    ['repo-watcher-fastlane', 'Repo watcher fastlane'],
    ['morning_brief', 'Morning brief'],
    ['repo-watcher: hermes-deploy + maiavm-desktop', 'Repo-watcher: hermes-deploy + maiavm-desktop'],
    ['Competitor news watch', 'Competitor news watch'],
    ['  ', 'Untitled routine'],
    ['---', '---'],
  ])('%s → %s', (name, shown) => {
    expect(displayRoutineName({ name })).toBe(shown)
  })
})
