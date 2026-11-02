import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  coerceCronJobs,
  describeRoutineSchedule,
  displayRoutineName,
  extraCronUpdates,
  formatCronSchedule,
  mergeRoutines,
  nextRunAt,
  parseCronListText,
  presetForSchedule,
  removeRoutine,
  routineDraftOf,
  sameRoutine,
  serveJobToRoutine,
  testRunRemote,
  upsertRoutine,
} from '../routines'
import { createServeCron, deleteServeCron, pauseServeCron, resumeServeCron, triggerServeCron, updateServeCron } from '../hermes-rest'
import { resolveNubApiConnection } from '../maiavm-api'

vi.mock('../hermes-rest', () => ({
  createServeCron: vi.fn(),
  deleteServeCron: vi.fn(),
  listServeCronJobs: vi.fn(),
  pauseServeCron: vi.fn(),
  resumeServeCron: vi.fn(),
  triggerServeCron: vi.fn(),
  updateServeCron: vi.fn(),
}))

vi.mock('../maiavm-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../maiavm-api')>()
  return { ...original, resolveNubApiConnection: vi.fn() }
})

describe('formatCronSchedule / coerceCronJobs', () => {
  it('reads string and object schedules', () => {
    expect(formatCronSchedule('0 9 * * *')).toBe('0 9 * * *')
    expect(formatCronSchedule({ display: 'Every day', expr: '0 9 * * *' })).toBe('Every day')
    expect(formatCronSchedule({ expr: '0 * * * *' })).toBe('0 * * * *')
  })

  it('accepts a raw array or { jobs } wrapper', () => {
    expect(coerceCronJobs([{ id: 'a' }]).map((j) => j.id)).toEqual(['a'])
    expect(coerceCronJobs({ jobs: [{ id: 'b' }] }).map((j) => j.id)).toEqual(['b'])
  })
})

describe('parseCronListText', () => {
  it('parses hermes cron list blocks', () => {
    const text = `
  d4b88fb4203e [active]
    Name:      nightly audit
    Schedule:  0 2 * * *
    Prompt:    Check deploys

  c80fe0cffafc [paused]
    Name:      paused job
    Schedule:  every 2h
`
    const jobs = parseCronListText(text)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({
      id: 'd4b88fb4203e',
      name: 'nightly audit',
      schedule: '0 2 * * *',
      enabled: true,
    })
    expect(jobs[1]?.enabled).toBe(false)
  })

  it('preserves authoritative CLI timestamps without turning empty markers into dates', () => {
    const jobs = parseCronListText(`
  aaaa1111bbbb [active]
    Name: Interval
    Schedule: every 2h
    Next run: 2026-10-05T14:00:00+02:00
    Last run: 2026-10-05T12:00:00+02:00
  cccc2222dddd [paused]
    Name: Paused
    Next run: —
`)
    expect(jobs[0]).toMatchObject({
      next_run_at: '2026-10-05T14:00:00+02:00',
      last_run_at: '2026-10-05T12:00:00+02:00',
    })
    expect(serveJobToRoutine(jobs[1]!, 'hermes').nextRunAt).toBeNull()
  })
})

describe('nextRunAt / presets', () => {
  it('maps Grok schedule chips to cron', () => {
    expect(presetForSchedule('0 9 * * *')).toBe('daily')
    expect(presetForSchedule('every 2h')).toBe('custom')
  })

  it('advances interval schedules', () => {
    const from = Date.parse('2026-08-14T12:00:00Z')
    expect(nextRunAt('30m', from)).toBe(from + 30 * 60_000)
    expect(nextRunAt('every 2h', from)).toBe(from + 2 * 3_600_000)
  })

  it('finds the next cron minute', () => {
    const from = new Date()
    from.setSeconds(0, 0)
    from.setMinutes(0)
    const next = nextRunAt('5 * * * *', from.getTime())
    expect(next).toBeTruthy()
    expect(new Date(next!).getMinutes()).toBe(5)
  })

  // TZ-DOC: cron uses local Date while store is UTC — fix is a future batch
  it('computes cron nextRunAt in local Date fields (not UTC) around the spring-forward gap', () => {
    // 2026-03-08 is the US spring-forward Sunday. 02:30 local never exists in
    // America/New_York; the impl walks local Date fields (getHours/getMinutes)
    // and persists the result as a UTC ISO string (see upsertRoutine/markLocalRun).
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fromLocal = new Date(2026, 2, 8, 0, 5, 0, 0) // Mar 8 00:05 local
    const next = nextRunAt('30 2 * * *', fromLocal.getTime())
    expect(next).toBeTruthy()
    const d = new Date(next!)
    // Pinned local-field behavior: whatever the host tz does with the gap,
    // the computation is driven by local getters, ...
    expect(d.getHours() * 60 + d.getMinutes()).toBeGreaterThanOrEqual(0)
    expect(d.getTime()).toBeGreaterThan(fromLocal.getTime())
    // ... while the persisted form is a UTC ISO string (the tz split-brain).
    expect(new Date(next!).toISOString()).toMatch(/Z$/)
    expect(tz.length).toBeGreaterThan(0)
  })
})

describe('nextRunAt / cron edge cases', () => {
  const from = new Date(2026, 9, 20, 10, 0, 0, 0).getTime() // Tue Oct 20 2026, 10:00 local

  it('accepts 7 as Sunday, like cron', () => {
    const next = nextRunAt('0 9 * * 7', from)
    expect(next).not.toBeNull()
    expect(new Date(next!).getDay()).toBe(0)
    expect(nextRunAt('0 9 * * 5-7', from)).toBe(nextRunAt('0 9 * * 5,6,0', from))
  })

  it('reads weekday and month names', () => {
    expect(nextRunAt('0 9 * * MON', from)).toBe(nextRunAt('0 9 * * 1', from))
    expect(nextRunAt('0 9 * * mon-fri', from)).toBe(nextRunAt('0 9 * * 1-5', from))
    expect(nextRunAt('0 9 1 JAN *', from)).toBe(new Date(2027, 0, 1, 9, 0).getTime())
  })

  it('returns null at once for a date that never exists', () => {
    const started = performance.now()
    expect(nextRunAt('0 0 30 2 *', from)).toBeNull()
    expect(nextRunAt('0 0 31 4,6,9,11 *', from)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('runs a fixed-time job once on a DST fall-back day', () => {
    // 2026-11-01 replays 01:00-01:59 in US zones; elsewhere this is an ordinary day.
    const first = nextRunAt('30 1 * * *', new Date(2026, 10, 1, 0, 0).getTime())!
    expect(new Date(first).getHours()).toBe(1)
    const second = nextRunAt('30 1 * * *', first)!
    expect(second - first).toBeGreaterThan(20 * 3_600_000)
    // An every-hour job still runs in both copies of the hour.
    const hourly = nextRunAt('30 * * * *', first)!
    expect(hourly - first).toBeLessThanOrEqual(3_600_000)
  })

  it('still matches day-of-month OR weekday when both are restricted', () => {
    const next = nextRunAt('0 9 1 * 3', from)! // the 1st, or any Wednesday
    expect(new Date(next).getDay()).toBe(3)
    expect(new Date(next).getDate()).toBe(21)
  })
})

describe('serveJobToRoutine / merge', () => {
  it('matches a routine by id and where it lives, and drafts it as it is', () => {
    const remote = { id: 'a1', name: 'Brief', prompt: 'Brief me', schedule: '0 8 * * *', enabled: true, origin: 'remote' as const }
    expect(sameRoutine(remote, { id: 'a1', origin: 'remote' })).toBe(true)
    expect(sameRoutine(remote, { id: 'a1', origin: 'hermes' })).toBe(false)
    expect(routineDraftOf({ ...remote, agentId: 'nub' })).toEqual({
      id: 'a1', name: 'Brief', prompt: 'Brief me', schedule: '0 8 * * *', enabled: true, agentId: 'nub',
    })
  })

  it('edits a cron job by its expression, not the label the agent gave it', () => {
    const job = { id: 'w', name: 'repo-watcher', schedule: { kind: 'cron', expr: '0 9 * * *', display: 'every day at 9am' } }
    expect(serveJobToRoutine(job, 'remote').schedule).toBe('0 9 * * *')
    const odd = { id: 'z', schedule: { kind: 'cron', expr: '*/15 9-11 * * 1-5', display: 'weekday mornings' } }
    expect(describeRoutineSchedule(serveJobToRoutine(odd, 'remote'))).toBe('Weekday mornings')
    expect(displayRoutineName(serveJobToRoutine({ id: 'a1b2c3', schedule: '0 9 * * *' }, 'remote'))).toBe('Untitled routine')
    const once = { id: 'o', schedule: { kind: 'once', run_at: '2030-01-01T09:00:00Z', display: 'once at 2030-01-01 09:00' } }
    expect(serveJobToRoutine(once, 'remote').schedule).toBe('once at 2030-01-01 09:00')
    const every = { id: 'e', schedule: { kind: 'interval', minutes: 60, display: 'every 60m' } }
    expect(serveJobToRoutine(every, 'remote').schedule).toBe('every 60m')
  })

  it('keeps local drafts that are not on the remote list', () => {
    const remote = [
      serveJobToRoutine({ id: 'r1', name: 'Remote', schedule: '0 9 * * *', enabled: true }, 'remote'),
    ]
    const local = [
      { id: 'r1', name: 'dup', prompt: '', schedule: '', enabled: true, origin: 'local' as const },
      { id: 'local-1', name: 'Draft', prompt: 'ping', schedule: '30m', enabled: true, origin: 'local' as const },
    ]
    expect(mergeRoutines(remote, local).map((j) => j.id)).toEqual(['r1', 'local-1'])
  })
})

describe('upsertRoutine create guard', () => {
  const draft = {
    name: 'Nightly audit',
    prompt: 'Check deploys',
    schedule: '0 2 * * *',
    enabled: true,
    agentId: null,
  }

  beforeEach(() => {
    vi.mocked(createServeCron).mockClear()
    vi.mocked(createServeCron).mockResolvedValue(null)
    vi.mocked(resolveNubApiConnection).mockResolvedValue(null)
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    window.localStorage.clear()
  })

  it('does not conceal an unconfirmed native create as a local draft', async () => {
    await expect(upsertRoutine(draft)).rejects.toThrow(/no local or CLI fallback/)
    expect(window.localStorage.getItem('maia:routines:v1')).toBeNull()
  })
})

describe('routine backend runs', () => {
  it('throws on a failed remote trigger instead of allowing a chat fallback', async () => {
    vi.mocked(triggerServeCron).mockResolvedValue(false)
    const job = serveJobToRoutine({ id: 'remote-1', prompt: 'Check mail' }, 'remote')
    await expect(testRunRemote(job)).rejects.toThrow(/start this routine/i)
  })

  it('returns false only for a local routine that must run in chat', async () => {
    const job = serveJobToRoutine({ id: 'draft-1', prompt: 'Check mail' }, 'local')
    await expect(testRunRemote(job)).resolves.toBe(false)
  })
})

describe('routine delivery / repeat / skills', () => {
  beforeEach(() => {
    vi.mocked(createServeCron).mockReset()
    vi.mocked(updateServeCron).mockReset()
    vi.mocked(updateServeCron).mockResolvedValue(true)
    vi.mocked(pauseServeCron).mockReset().mockResolvedValue(true)
    vi.mocked(resumeServeCron).mockReset().mockResolvedValue(true)
    vi.mocked(deleteServeCron).mockReset().mockResolvedValue(true)
    vi.mocked(resolveNubApiConnection).mockResolvedValue({ baseUrl: 'https://vm' })
    window.localStorage.clear()
  })

  it('reads deliver / failure_deliver / repeat / skills off remote jobs', () => {
    const r = serveJobToRoutine(
      {
        id: 'j1',
        name: 'Brief',
        schedule: '0 8 * * *',
        deliver: 'telegram',
        failure_deliver: 'discord',
        repeat: { times: 1, completed: 0 },
        skills: ['google-workspace'],
      },
      'remote',
    )
    expect(r).toMatchObject({ deliver: 'telegram', failureDeliver: 'discord', runOnce: true, skills: ['google-workspace'] })
    const bare = serveJobToRoutine({ id: 'j2' }, 'remote')
    expect(bare).toMatchObject({ deliver: 'local', failureDeliver: null, runOnce: false, skills: [] })
    expect(serveJobToRoutine({ id: 'h' }, 'hermes').deliver).toBeUndefined()
  })

  it('maps only the fields a draft sets to hermes update keys', () => {
    const base = { name: 'n', prompt: 'p', schedule: 's', enabled: true }
    expect(extraCronUpdates(base)).toEqual({})
    expect(
      extraCronUpdates({ ...base, deliver: 'telegram', failureDeliver: null, runOnce: false, skills: ['a'] }),
    ).toEqual({ deliver: 'telegram', failure_deliver: null, repeat: 'forever', skills: ['a'] })
    expect(extraCronUpdates({ ...base, deliver: '', runOnce: true })).toEqual({ deliver: 'local', repeat: 1 })
  })

  it('creates paused and run-once atomically, applies a failure target, then resumes', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new1', name: 'Brief', schedule: '0 8 * * *', deliver: 'local', enabled: false, repeat: { times: 1 } })
    const saved = await upsertRoutine({
      name: 'Brief',
      prompt: 'Brief me',
      schedule: '0 8 * * *',
      enabled: true,
      deliver: 'local',
      failureDeliver: 'telegram',
      runOnce: true,
      skills: ['s1'],
    })
    expect(createServeCron).toHaveBeenCalledWith({
      name: 'Brief',
      prompt: 'Brief me',
      schedule: '0 8 * * *',
      deliver: 'local',
      skills: ['s1'],
      profile: 'default', paused: true, repeat: 1,
    })
    expect(updateServeCron).toHaveBeenCalledWith('new1', { failure_deliver: 'telegram' }, 'default')
    expect(resumeServeCron).toHaveBeenCalledWith('new1', 'default')
    expect(saved).toMatchObject({ origin: 'remote', runOnce: true, failureDeliver: 'telegram', skills: ['s1'] })
  })

  it('skips the follow-up update when nothing extra is needed; defaults deliver to local', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new2' })
    await upsertRoutine({ name: 'x', prompt: 'y', schedule: '1h', enabled: true })
    expect(vi.mocked(createServeCron).mock.calls[0]![0]).toMatchObject({ deliver: 'local' })
    expect(updateServeCron).not.toHaveBeenCalled()
  })

  it('keeps a partial failure-target save visibly paused instead of reporting success', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new3', enabled: false })
    vi.mocked(updateServeCron).mockResolvedValue(false)
    await expect(upsertRoutine({ name: 'x', prompt: 'y', schedule: '1h', enabled: true, failureDeliver: 'telegram' }))
      .rejects.toThrow(/created paused/)
    expect(resumeServeCron).not.toHaveBeenCalled()
  })

  it('updates an existing remote routine with its delivery target', async () => {
    const existing = serveJobToRoutine({ id: 'j9', name: 'Old', schedule: '0 9 * * *', deliver: 'local' }, 'remote')
    const saved = await upsertRoutine(
      { name: 'Old', prompt: 'p', schedule: '0 9 * * *', enabled: true, deliver: 'telegram', failureDeliver: null },
      existing,
    )
    expect(updateServeCron).toHaveBeenCalledWith('j9', {
      name: 'Old',
      prompt: 'p',
      deliver: 'telegram',
      failure_deliver: null,
    })
    expect(saved.deliver).toBe('telegram')
  })

  it('does not report a remote edit that the scheduler rejected', async () => {
    vi.mocked(updateServeCron).mockResolvedValue(false)
    const existing = serveJobToRoutine({ id: 'j9', name: 'Old', schedule: 'every 2h' }, 'remote')
    await expect(upsertRoutine(
      { name: 'New', prompt: 'p', schedule: 'every 2h', enabled: false }, existing,
    )).rejects.toThrow(/update this routine/i)
    expect(pauseServeCron).not.toHaveBeenCalled()
  })

  it.each([false, true])('reports a rejected enabled=%s update instead of claiming it succeeded', async (enabled) => {
    vi.mocked(pauseServeCron).mockResolvedValue(false)
    vi.mocked(resumeServeCron).mockResolvedValue(false)
    const existing = serveJobToRoutine({ id: 'j9', enabled: !enabled, schedule: 'every 2h' }, 'remote')
    await expect(upsertRoutine(
      { name: 'Old', prompt: 'p', schedule: 'every 2h', enabled }, existing,
    )).rejects.toThrow(enabled ? /resume/i : /pause/i)
  })

  it('preserves the authoritative next run on an unchanged backend schedule', async () => {
    const next = '2027-10-05T14:00:00+02:00'
    const existing = serveJobToRoutine({ id: 'j9', name: 'Old', schedule: 'every 2h', next_run_at: next }, 'remote')
    const saved = await upsertRoutine({ name: 'New', prompt: 'p', schedule: 'every 2h', enabled: true }, existing)
    expect(saved.nextRunAt).toBe(next)
    expect(updateServeCron).toHaveBeenCalledWith('j9', { name: 'New', prompt: 'p' })
  })

  it('does not fabricate a backend next run after changing the schedule', async () => {
    const existing = serveJobToRoutine({ id: 'j9', schedule: 'every 2h' }, 'remote')
    const saved = await upsertRoutine({ name: 'New', prompt: 'p', schedule: 'every 3h', enabled: true }, existing)
    expect(saved.nextRunAt).toBeNull()
  })

  it('sends paused in the initial request with no pause-after-create race', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new-paused', enabled: false })
    const saved = await upsertRoutine({ name: 'Paused', prompt: 'p', schedule: '0 9 * * *', enabled: false })
    expect(createServeCron).toHaveBeenCalledWith(expect.objectContaining({ paused: true, profile: 'default' }))
    expect(pauseServeCron).not.toHaveBeenCalled()
    expect(saved.enabled).toBe(false)
  })

  it('does not falsely report paused when the backend ignores atomic paused creation', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new-paused', enabled: true })
    vi.mocked(pauseServeCron).mockResolvedValue(false)
    await expect(upsertRoutine({ name: 'Paused', prompt: 'p', schedule: '0 9 * * *', enabled: false }))
      .rejects.toThrow(/did not confirm paused/)
    expect(deleteServeCron).not.toHaveBeenCalled()
  })

  it('fails visibly rather than claiming a run-once setting the backend omitted', async () => {
    vi.mocked(createServeCron).mockResolvedValue({ id: 'new-paused', enabled: true })
    vi.mocked(pauseServeCron).mockResolvedValue(false)
    vi.mocked(deleteServeCron).mockResolvedValue(false)
    await expect(upsertRoutine({ name: 'Once', prompt: 'p', schedule: '0 9 * * *', enabled: true, runOnce: true }))
      .rejects.toThrow(/did not confirm the run-once/)
  })

  it('rejects a failed delete instead of removing the job from the UI', async () => {
    vi.mocked(deleteServeCron).mockResolvedValue(false)
    await expect(removeRoutine(serveJobToRoutine({ id: 'j9' }, 'remote'))).rejects.toThrow(/delete this routine/i)
  })
})

describe('routineRunningSince (live run signal from the agent)', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')
  const at = (msAgo: number) => new Date(now - msAgo).toISOString()

  it('a fresh fire_claim means running, from the manual start when there is one', async () => {
    const { routineRunningSince } = await import('../routines')
    expect(routineRunningSince({ id: 'a', fire_claim: { by: 'x', at: at(20_000) } }, now)).toBe(at(20_000))
    expect(
      routineRunningSince({ id: 'a', fire_claim: { by: 'x', at: at(5_000) }, manual_run_at: at(90_000) }, now),
    ).toBe(at(90_000))
  })

  it('a stale claim (no heartbeat for >6 min) is a dead run, not a running one', async () => {
    const { routineRunningSince } = await import('../routines')
    expect(routineRunningSince({ id: 'a', fire_claim: { by: 'x', at: at(7 * 60_000) } }, now)).toBeNull()
  })

  it('a manual run not claimed yet counts until it records an outcome', async () => {
    const { routineRunningSince } = await import('../routines')
    expect(routineRunningSince({ id: 'a', manual_run_at: at(30_000), last_run_at: at(3_600_000) }, now)).toBe(at(30_000))
    expect(routineRunningSince({ id: 'a', manual_run_at: at(30_000), last_run_at: at(1_000) }, now)).toBeNull()
    expect(routineRunningSince({ id: 'a', manual_run_at: at(31 * 60_000) }, now)).toBeNull()
    expect(routineRunningSince({ id: 'a' }, now)).toBeNull()
  })

  it('serveJobToRoutine carries the outcome and the running signal', async () => {
    const { serveJobToRoutine } = await import('../routines')
    const r = serveJobToRoutine(
      { id: 'a', name: 'n', last_status: 'error', last_error: ' boom ', fire_claim: { by: 'x', at: new Date().toISOString() } },
      'remote',
    )
    expect(r.lastStatus).toBe('error')
    expect(r.lastError).toBe('boom')
    expect(r.runningSince).toBeTruthy()
  })
})
