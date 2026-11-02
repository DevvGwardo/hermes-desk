import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadLocalRoutines, markLocalRun, removeRoutine, routineDraftOf, saveLocalRoutines,
  setRoutineEnabled, upsertRoutine, type Routine,
} from '../routines'

const T0 = Date.parse('2026-10-08T08:00:00Z')
const finishedAt = T0 + 90_000

function localJob(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'rt-synthetic-run-lifetime', name: 'Synthetic original routine',
    prompt: 'Synthetic original instruction.', schedule: 'every 1h',
    enabled: true, agentId: 'profile:alpha', origin: 'local',
    lastRunAt: null, nextRunAt: new Date(T0 + 3_600_000).toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers(); window.localStorage.clear() })

describe('persisted local routine ownership at run completion', () => {
  it('retains the name, instruction and agent saved after the run started', async () => {
    const original = localJob()
    saveLocalRoutines([original])
    const edits = {
      name: 'Synthetic revised routine', prompt: 'Synthetic revised instruction.',
      agentId: 'profile:beta',
    }
    await upsertRoutine({ ...routineDraftOf(original), ...edits }, original)
    const marked = markLocalRun(original, finishedAt)
    expect(loadLocalRoutines()[0]).toMatchObject(edits)
    expect(marked).toMatchObject(edits)
    expect(marked.lastRunAt).toBe(new Date(finishedAt).toISOString())
  })

  it('does not resume a routine paused while its previous run was in flight', async () => {
    const original = localJob()
    saveLocalRoutines([original])
    await setRoutineEnabled(original, false)
    const marked = markLocalRun(original, finishedAt)
    expect(loadLocalRoutines()[0]?.enabled).toBe(false)
    expect(marked.enabled).toBe(false)
  })

  it('does not undo a later resume when a paused snapshot finishes', async () => {
    const original = localJob({ enabled: false })
    saveLocalRoutines([original])
    await setRoutineEnabled(original, true)
    const marked = markLocalRun(original, finishedAt)
    expect(loadLocalRoutines()[0]?.enabled).toBe(true)
    expect(marked.enabled).toBe(true)
  })

  it('advances the currently saved schedule instead of restoring the old one', async () => {
    const original = localJob()
    saveLocalRoutines([original])
    await upsertRoutine({ ...routineDraftOf(original), schedule: 'every 3h' }, original)
    const marked = markLocalRun(original, finishedAt)
    const expected = new Date(finishedAt + 3 * 3_600_000).toISOString()
    expect(loadLocalRoutines()[0]).toMatchObject({ schedule: 'every 3h', nextRunAt: expected })
    expect(marked).toMatchObject({ schedule: 'every 3h', nextRunAt: expected })
  })

  it('still stamps an unchanged local job and advances its next occurrence', () => {
    const original = localJob()
    saveLocalRoutines([original])
    const marked = markLocalRun(original, finishedAt)
    expect(marked).toEqual({
      ...original, lastRunAt: new Date(finishedAt).toISOString(),
      nextRunAt: new Date(finishedAt + 3_600_000).toISOString(),
    })
    expect(loadLocalRoutines()).toEqual([marked])
  })

  it('does not change unrelated local jobs', () => {
    const original = localJob(), other = localJob({ id: 'rt-synthetic-other', enabled: false })
    saveLocalRoutines([original, other])
    markLocalRun(original, finishedAt)
    expect(loadLocalRoutines()[1]).toEqual(other)
  })

  it('does not resurrect a job deleted while its run was in flight', async () => {
    const original = localJob()
    saveLocalRoutines([original])
    await removeRoutine(original)
    markLocalRun(original, finishedAt)
    expect(loadLocalRoutines()).toEqual([])
  })

  it('does not persist a host-job completion into a same-id local draft', () => {
    const original = localJob()
    saveLocalRoutines([original])
    const host = localJob({ origin: 'hermes', prompt: 'Synthetic host instruction.' })
    expect(markLocalRun(host, finishedAt)).toMatchObject({ origin: 'hermes', prompt: host.prompt })
    expect(loadLocalRoutines()).toEqual([original])
  })
})
