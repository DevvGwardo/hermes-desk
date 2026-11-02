import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTaskShowToRun,
  extractHermesSessionId,
  mapStatus,
  parseTaskShow,
  pollSubagent,
  MAX_POLL_FAILURES,
  resetSubagentPolling,
  waitForSubagent,
} from '../subagent-status'
import {
  appendSubagentMessage,
  createConversation,
  getMessagesForConversation,
  getState,
  resetStore,
  setState,
  upsertSubagent,
} from '../agents/store'
import type { SubagentRun } from '../agents/types'
import { taggedSpawnGoal } from '../spawn'

const SHOW_QUEUED = `id:      t-abc
status:  queued
agent:   hermes-local
tags:    -
created: 2026-08-12 12:00
updated: 2026-08-12 12:00
desc:    [maia-run:run_x] echo hi
`

const SHOW_RUNNING = `id:      t-abc
status:  running
agent:   hermes-local
tags:    -
created: 2026-08-12 12:00
updated: 2026-08-12 12:01
desc:    [maia-run:run_x] echo hi

--- turns (1) ---
[1] assistant:
    scanning the workspace
`

const SHOW_DONE = `id:      t-abc
status:  completed
agent:   hermes-local
tags:    -
created: 2026-08-12 12:00
updated: 2026-08-12 12:02
desc:    [maia-run:run_x] echo hi

--- turns (2) ---
[1] assistant:
    scanning the workspace
[2] assistant:
    wrote the file

--- result ---
echo hi → ok
`

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T12:00:00Z'))
  resetStore()
  setState({ agents: [{
    id: 'profile:fixture',
    name: 'Fixture',
    status: 'running',
    region: 'local',
    createdAt: '2026-08-12T12:00:00Z',
    summary: 'Fake local profile',
  }] })
  resetSubagentPolling()
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('parseTaskShow', () => {
  it('reads header fields, turns, and result', () => {
    const parsed = parseTaskShow(SHOW_DONE)
    expect(parsed.fields.status).toBe('completed')
    expect(parsed.fields.desc).toContain('[maia-run:run_x]')
    expect(parsed.turns).toHaveLength(2)
    expect(parsed.turns[1]!.content).toBe('wrote the file')
    expect(parsed.result).toBe('echo hi → ok')
  })

  it('keeps the header-field contract and stays linear on space-padded lines', () => {
    vi.useRealTimers() // the file-level fake timers also freeze performance.now
    const header = [
      '  Status :  running  \r',
      'Last-Error\t: none',
      'bad!key: x',
      'no colon here',
      `wide${' '.repeat(50_000)}line`,
      `${' '.repeat(1_500)}!`,
      `note: ${' '.repeat(50_000)}tail`,
    ].join('\n')
    const started = performance.now()
    const { fields } = parseTaskShow(header)
    expect(performance.now() - started).toBeLessThan(500)
    expect(fields).toEqual({ status: 'running', 'last-error': 'none', note: 'tail' })
  })
})

describe('mapStatus', () => {
  it('maps queue words including claimed / waiting_user', () => {
    expect(mapStatus('queued')).toBe('queued')
    expect(mapStatus('claimed')).toBe('running')
    expect(mapStatus('waiting_user')).toBe('running')
    expect(mapStatus('completed')).toBe('completed')
    expect(mapStatus('nope')).toBeNull()
  })
})

describe('applyTaskShowToRun', () => {
  const base = (): SubagentRun => ({
    id: 'run_x',
    parentAgentId: 'inst_a',
    kind: 'bash',
    title: 'echo hi',
    status: 'queued',
    createdAt: '2026-08-12T12:00:00Z',
    digests: [],
    taskId: 't-abc',
    conversationId: 'conv_x',
  })

  it('promotes queued → running and copies assistant turns into digests', () => {
    const next = applyTaskShowToRun(base(), SHOW_RUNNING, '2026-08-12T12:00:01Z')
    expect(next.status).toBe('running')
    expect(next.digests).toHaveLength(1)
    expect(next.digests[0]!.text).toBe('scanning the workspace')
  })

  it('folds the result on completed', () => {
    const next = applyTaskShowToRun(base(), SHOW_DONE, '2026-08-12T12:00:02Z')
    expect(next.status).toBe('completed')
    expect(next.result?.summary).toBe('echo hi → ok')
    expect(next.digests).toHaveLength(2)
  })

  it('prefers an assistant digest over a queue status placeholder', () => {
    const raw = `id:      t-abc
status:  completed
agent:   hermes-local

--- turns (1) ---
[1] assistant:
    DTW to ORD from $87
`
    const next = applyTaskShowToRun(base(), raw, '2026-08-12T12:00:02Z')
    expect(next.status).toBe('completed')
    expect(next.result?.summary).toMatch(/\$87/)
    expect(next.result?.summary).not.toMatch(/^Task t-abc/)
  })

  it('extracts a hermes session id from the show text', () => {
    const raw = `${SHOW_RUNNING}\nsession: 20260812_170840_d90055\n`
    expect(extractHermesSessionId(raw)).toBe('20260812_170840_d90055')
    const next = applyTaskShowToRun(base(), raw)
    expect(next.hermesSessionId).toBe('20260812_170840_d90055')
  })
})

describe('taggedSpawnGoal', () => {
  it('prefixes the worker prompt with the run marker', () => {
    expect(taggedSpawnGoal('run_x', 'echo hi')).toBe('[maia-run:run_x] echo hi')
  })
})

describe('pollSubagent', () => {
  it('keeps polling through queued → running → completed', async () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const run: SubagentRun = {
      id: 'run_x',
      parentAgentId: getState().agents[0]!.id,
      kind: 'bash',
      title: 'echo hi',
      status: 'queued',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
      conversationId: conv.id,
      taskId: 't-abc',
    }
    upsertSubagent(run)
    appendSubagentMessage(conv.id, run)

    const shows = [SHOW_QUEUED, SHOW_RUNNING, SHOW_DONE]
    let i = 0
    ;(window as unknown as { nubAgent: { task: (args: string[]) => Promise<{ ok: boolean; data: string }> } }).nubAgent = {
      task: async () => ({ ok: true, data: shows[Math.min(i++, shows.length - 1)]! }),
    }

    pollSubagent(run.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(getState().subagentsById[run.id]!.status).toBe('queued')

    await vi.advanceTimersByTimeAsync(2500)
    expect(getState().subagentsById[run.id]!.status).toBe('running')
    expect(getState().subagentsById[run.id]!.digests[0]!.text).toBe('scanning the workspace')

    await vi.advanceTimersByTimeAsync(2500)
    const done = getState().subagentsById[run.id]!
    expect(done.status).toBe('completed')
    expect(done.result?.summary).toBe('echo hi → ok')
    const bubble = getMessagesForConversation(conv.id).find((m) => m.subagentRunId === run.id)!
    expect(bubble.subagentStatus).toBe('completed')
    expect(bubble.content).toBe('echo hi → ok')
  })

  it('rides out refused reads, then fails the run after MAX_POLL_FAILURES in a row', async () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const run: SubagentRun = {
      id: 'run_flaky',
      parentAgentId: getState().agents[0]!.id,
      kind: 'bash',
      title: 'echo hi',
      status: 'queued',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
      conversationId: conv.id,
      taskId: 't-flaky',
    }
    upsertSubagent(run)
    appendSubagentMessage(conv.id, run)
    // Two refusals, one good read (resets the streak), then the queue stays unreadable.
    const replies = [false, false, true]
    let i = 0
    const task = vi.fn(async () => (replies[i++] ?? false)
      ? { ok: true, data: SHOW_RUNNING }
      : { ok: false, error: 'queue locked' })
    ;(window as unknown as { nubAgent: { task: typeof task } }).nubAgent = { task }

    pollSubagent(run.id)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2500 * 2)
    expect(getState().subagentsById[run.id]!.status).toBe('running')
    await vi.advanceTimersByTimeAsync(2500 * (MAX_POLL_FAILURES - 1))
    expect(getState().subagentsById[run.id]!.status).toBe('running')
    await vi.advanceTimersByTimeAsync(2500)
    const failed = getState().subagentsById[run.id]!
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/queue locked/)
    const calls = task.mock.calls.length
    await vi.advanceTimersByTimeAsync(2500 * 3)
    expect(task.mock.calls.length).toBe(calls)
  })
})

describe('waitForSubagent', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetStore()
    resetSubagentPolling()
  })

  it('resolves once the run reaches a terminal status', async () => {
    const running: SubagentRun = {
      id: 'run_wait',
      parentAgentId: 'hermes',
      kind: 'custom',
      title: 'flights',
      status: 'running',
      createdAt: new Date().toISOString(),
      digests: [],
      label: 'TravelAgent',
    }
    upsertSubagent(running)
    const pending = waitForSubagent('run_wait', 2000)
    upsertSubagent({
      ...running,
      status: 'completed',
      finishedAt: '2026-08-13T12:00:02Z',
      result: { summary: 'DTW→ORD $87' },
    })
    const done = await pending
    expect(done.status).toBe('completed')
    expect(done.result?.summary).toBe('DTW→ORD $87')
  })
})
