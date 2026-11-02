import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hermesCliExtraArgs,
  parseCreatedJobId,
  removeRoutine,
  setRoutineEnabled,
  serveJobToRoutine,
  testRunRemote,
  upsertRoutine,
  type Routine,
} from '../routines'
import { createServeCron } from '../hermes-rest'
import { resolveNubApiConnection } from '../maiavm-api'

/**
 * Host routines (origin `hermes`) go through the Electron `hermes cron`
 * bridge. The argv here must match the real CLI (`hermes cron --help`,
 * hermes_cli/subcommands/cron.py) and the Electron verb allowlist.
 */

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

// Real `hermes cron create` stdout (v0.21.5).
const CREATE_OUTPUT = `Created job: adb67f1d6a23
  Name: Morning brief
  Schedule: 0 8 * * *
  Next run: 2026-09-30T08:00:00-04:00`

const bridge = vi.fn<(kind: string, args: string[]) => Promise<{ ok: boolean; data?: unknown }>>()

function hostJob(over: Partial<Routine> = {}): Routine {
  return { ...serveJobToRoutine({ id: 'adb67f1d6a23', name: 'Old', schedule: '0 9 * * *' }, 'hermes'), prompt: 'p', ...over }
}

beforeEach(() => {
  bridge.mockReset().mockResolvedValue({ ok: true, data: '' })
  ;(window as unknown as { nubAgent?: unknown }).nubAgent = { hermes: bridge }
  vi.mocked(createServeCron).mockResolvedValue(null)
  vi.mocked(resolveNubApiConnection).mockResolvedValue(null)
  window.localStorage.clear()
})

afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('parseCreatedJobId', () => {
  it('reads the id from real create output', () => {
    expect(parseCreatedJobId(CREATE_OUTPUT)).toBe('adb67f1d6a23')
  })

  it('returns null for anything else', () => {
    expect(parseCreatedJobId('Failed to create job: bad schedule')).toBeNull()
    expect(parseCreatedJobId(undefined)).toBeNull()
  })
})

describe('hermesCliExtraArgs', () => {
  const base = { name: 'n', prompt: 'p', schedule: 's', enabled: true }

  it('always sends a delivery target on create', () => {
    expect(hermesCliExtraArgs(base, 'create')).toEqual(['--deliver', 'local'])
    expect(hermesCliExtraArgs(base, 'edit')).toEqual([])
  })

  it('maps delivery, failure target, run-once and skills to CLI flags', () => {
    expect(
      hermesCliExtraArgs(
        { ...base, deliver: 'telegram', failureDeliver: 'discord', runOnce: true, skills: ['a', 'b'] },
        'edit',
      ),
    ).toEqual(['--deliver', 'telegram', '--failure-deliver', 'discord', '--repeat', '1', '--skill', 'a', '--skill', 'b'])
  })

  it('clears skills on edit only', () => {
    expect(hermesCliExtraArgs({ ...base, skills: [] }, 'edit')).toEqual(['--clear-skills'])
    expect(hermesCliExtraArgs({ ...base, skills: [] }, 'create')).toEqual(['--deliver', 'local'])
  })
})

describe('new routines do not fall back to the host', () => {
  it('does not call CLI create after an unconfirmed REST create', async () => {
    bridge.mockResolvedValue({ ok: true, data: CREATE_OUTPUT })
    await expect(upsertRoutine({ name: 'Morning brief', prompt: 'Brief me', schedule: '0 8 * * *', enabled: true }))
      .rejects.toThrow(/no local or CLI fallback/)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('does not bypass native failure for paused, delivery or skill settings', async () => {
    bridge.mockResolvedValue({ ok: true, data: CREATE_OUTPUT })
    await expect(upsertRoutine({
      name: 'Brief',
      prompt: 'Brief me',
      schedule: '1h',
      enabled: false,
      deliver: 'telegram',
      runOnce: true,
      skills: ['s1'],
    })).rejects.toThrow(/no local or CLI fallback/)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('does not infer a native receipt from an unrelated CLI job with the same name', async () => {
    bridge.mockImplementation(async (_k, args) =>
      args[0] === 'list'
        ? { ok: true, data: [{ id: 'aaaa1111bbbb', name: 'Brief' }, { id: 'cccc2222dddd', name: 'Other' }] }
        : { ok: true, data: 'ok' },
    )
    await expect(upsertRoutine({ name: 'Brief', prompt: 'x', schedule: '1h', enabled: true }))
      .rejects.toThrow(/no local or CLI fallback/)
    expect(bridge).not.toHaveBeenCalled()
  })
})

describe('edit on the host', () => {
  it('uses `edit <id>` with flags, not positional schedule/prompt', async () => {
    const saved = await upsertRoutine(
      { name: 'New', prompt: 'Do it', schedule: '0 7 * * *', enabled: true },
      hostJob(),
    )
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledWith('cron', [
      'edit', 'adb67f1d6a23', '--name', 'New', '--schedule', '0 7 * * *', '--prompt', 'Do it',
    ])
    expect(saved).toMatchObject({ name: 'New', schedule: '0 7 * * *', prompt: 'Do it' })
  })

  it('pauses and resumes when Active changes', async () => {
    await upsertRoutine({ name: 'Old', prompt: 'p', schedule: '0 9 * * *', enabled: false }, hostJob({ enabled: true }))
    expect(bridge).toHaveBeenLastCalledWith('cron', ['pause', 'adb67f1d6a23'])
    bridge.mockClear()
    await upsertRoutine({ name: 'Old', prompt: 'p', schedule: '0 9 * * *', enabled: true }, hostJob({ enabled: false }))
    expect(bridge).toHaveBeenLastCalledWith('cron', ['resume', 'adb67f1d6a23'])
  })

  it('throws instead of reporting an edit the scheduler never got', async () => {
    bridge.mockResolvedValue({ ok: false, data: 'Job not found' })
    await expect(
      upsertRoutine({ name: 'New', prompt: 'p', schedule: '1h', enabled: true }, hostJob()),
    ).rejects.toThrow(/couldn't update/i)
  })

  it('does not claim a run-once clear the CLI cannot send', async () => {
    const saved = await upsertRoutine(
      { name: 'Old', prompt: 'p', schedule: '0 9 * * *', enabled: true, runOnce: false },
      hostJob({ runOnce: true }),
    )
    expect(bridge.mock.calls[0]![1]).not.toContain('--repeat')
    expect(saved.runOnce).toBe(true)
  })
})

describe('test run on the host', () => {
  it('runs the job through `hermes cron run`', async () => {
    await expect(testRunRemote(hostJob())).resolves.toBe(true)
    expect(bridge).toHaveBeenCalledWith('cron', ['run', 'adb67f1d6a23'])
  })

  it('reports that paused host jobs need to be resumed rather than running in chat', async () => {
    await expect(testRunRemote(hostJob({ enabled: false }))).rejects.toThrow(/resume/i)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('reports failure without allowing the caller to fall back to chat', async () => {
    bridge.mockResolvedValue({ ok: false })
    await expect(testRunRemote(hostJob())).rejects.toThrow(/start this routine/i)
  })

  it('reports a disconnected host bridge as a run failure', async () => {
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    await expect(testRunRemote(hostJob())).rejects.toThrow(/start this routine/i)
  })
})

describe('host routine actions', () => {
  it('pauses without rewriting the prompt or resetting an interval schedule', async () => {
    const existing = hostJob({ schedule: 'every 2h', prompt: 'Truncated CLI prompt…', nextRunAt: '2027-10-05T14:00:00Z' })
    const saved = await setRoutineEnabled(existing, false)
    expect(bridge).toHaveBeenCalledOnce()
    expect(bridge).toHaveBeenCalledWith('cron', ['pause', existing.id])
    expect(saved).toMatchObject({ enabled: false, prompt: existing.prompt, nextRunAt: existing.nextRunAt })
  })

  it('rejects a failed host pause', async () => {
    bridge.mockResolvedValue({ ok: false })
    await expect(setRoutineEnabled(hostJob(), false)).rejects.toThrow(/pause/i)
  })

  it('rejects a failed host delete and leaves its error visible to the caller', async () => {
    bridge.mockResolvedValue({ ok: false })
    await expect(removeRoutine(hostJob())).rejects.toThrow(/delete/i)
  })
})

describe('electron cron verb allowlist', () => {
  it('allows every verb the app sends', () => {
    const src = readFileSync(resolve(__dirname, '../../../electron/main.cjs'), 'utf8')
    const block = src.match(/const CRON_VERBS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
    const verbs = new Set([...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))
    for (const verb of ['list', 'create', 'edit', 'pause', 'resume', 'run', 'delete', 'remove']) {
      expect(verbs, verb).toContain(verb)
    }
  })
})
