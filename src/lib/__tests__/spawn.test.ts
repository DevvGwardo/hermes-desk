import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnAvailable, spawnSubagent, taskAddArgs } from '../spawn'

type BridgeResult = { ok: boolean; code?: number; data?: unknown; error?: string }

function setBridges(task?: (args: string[]) => Promise<BridgeResult>, hermes?: (kind: string, args: string[]) => Promise<BridgeResult>) {
  ;(window as unknown as { nubAgent?: object }).nubAgent = {
    ...(task ? { task } : {}),
    ...(hermes ? { hermes } : {}),
  }
}

afterEach(() => {
  delete window.nubAgent
})

describe('taskAddArgs', () => {
  it('omits --agent when none given', () => {
    expect(taskAddArgs('fix the bug')).toEqual(['add', 'fix the bug'])
  })

  it('includes --agent before the goal when given', () => {
    expect(taskAddArgs('fix the bug', 'hermes-local')).toEqual([
      'add',
      '--agent',
      'hermes-local',
      'fix the bug',
    ])
  })
})

describe('spawnAvailable', () => {
  it('is false with no bridges', () => {
    delete window.nubAgent
    expect(spawnAvailable()).toBe(false)
  })

  it('is true when either spawner exists', () => {
    setBridges(() => Promise.resolve({ ok: true }))
    expect(spawnAvailable()).toBe(true)
    delete window.nubAgent
    setBridges(undefined, () => Promise.resolve({ ok: true }))
    expect(spawnAvailable()).toBe(true)
  })
})

describe('spawnSubagent', () => {
  it('rejects an empty goal before touching any bridge', async () => {
    const task = vi.fn()
    setBridges(task)
    const res = await spawnSubagent('bash', '   ')
    expect(res).toMatchObject({ ok: false, channel: 'unavailable', error: 'goal is empty' })
    expect(task).not.toHaveBeenCalled()
  })

  it('reports unavailable when the task bridge is missing on web', async () => {
    delete window.nubAgent
    const res = await spawnSubagent('bash', 'do the thing')
    expect(res.ok).toBe(false)
    expect(res.channel).toBe('unavailable')
    expect(res.error).toContain('desktop app')
  })

  it('routes a task kind to the queue and parses the t- id from data', async () => {
    const task = vi.fn().mockResolvedValue({ ok: true, data: 'queued task t-abc_123 done' })
    setBridges(task)
    const res = await spawnSubagent('debug', '  hunt the leak  ')
    expect(res).toMatchObject({ ok: true, channel: 'task', taskId: 't-abc_123' })
    expect(task).toHaveBeenCalledWith(['add', 'hunt the leak'])
  })

  it('retries once without --agent when the agent-flagged add fails', async () => {
    const task = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 1, error: 'unknown agent' })
      .mockResolvedValueOnce({ ok: true, data: 't-fallback1' })
    setBridges(task)
    const res = await spawnSubagent('bash', 'go', { agent: 'nope-agent' })
    expect(res).toMatchObject({ ok: true, channel: 'task', taskId: 't-fallback1' })
    expect(task).toHaveBeenCalledTimes(2)
    expect(task).toHaveBeenNthCalledWith(2, ['add', 'go'])
  })

  it('surfaces the task error when every attempt fails', async () => {
    const task = vi.fn().mockResolvedValue({ ok: false, code: 2 })
    setBridges(task)
    const res = await spawnSubagent('shell', 'go', { agent: 'x' })
    expect(res).toMatchObject({ ok: false, channel: 'task', error: 'task add failed (2)' })
  })

  it('returns the thrown message instead of rejecting', async () => {
    const task = vi.fn().mockRejectedValue(new Error('bridge exploded'))
    setBridges(task)
    const res = await spawnSubagent('bash', 'go')
    expect(res).toMatchObject({ ok: false, channel: 'task', error: 'bridge exploded' })
  })

  it('routes an executor kind through kanban create + dispatch', async () => {
    const hermes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
    setBridges(undefined, hermes)
    const res = await spawnSubagent('executor', 'ship the fix')
    expect(res).toMatchObject({ ok: true, channel: 'kanban' })
    expect(hermes).toHaveBeenNthCalledWith(1, 'kanban', [
      'create',
      '--title',
      'ship the fix',
      '--assignee',
      'hermes',
    ])
    expect(hermes).toHaveBeenNthCalledWith(2, 'kanban', ['dispatch', '--max', '1'])
  })

  it('reports card-created-but-dispatch-failed distinctly', async () => {
    const hermes = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'worker down' })
    setBridges(undefined, hermes)
    const res = await spawnSubagent('cloudCoder', 'build thing')
    expect(res).toMatchObject({
      ok: false,
      channel: 'kanban',
      error: 'card created but dispatch failed: worker down',
    })
  })
})
