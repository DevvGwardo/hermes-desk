import { describe, expect, it } from 'vitest'
import { pickRun } from '../NotificationDetail'

const run = (id: string, startedAt: number) => ({ id, startedAt, endedAt: startedAt + 1000, status: 'ok' as const, endReason: '' })
const runs = [run('r3', 3_000_000), run('r2', 2_000_000), run('r1', 1_000_000)]

describe('pickRun', () => {
  it('uses the stored run id', () => {
    expect(pickRun(runs, { runId: 'r1' })?.id).toBe('r1')
  })
  it('falls back to the newest run that started before the notification', () => {
    expect(pickRun(runs, { at: new Date(2_500_000).toISOString() })?.id).toBe('r2')
  })
  it('takes the newest run when the time is unknown', () => {
    expect(pickRun(runs, {})?.id).toBe('r3')
  })
})
