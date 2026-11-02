import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))
const isHostedAgent = vi.fn()
vi.mock('../agent-rest', async (orig) => ({
  ...(await orig<typeof import('../agent-rest')>()),
  isHostedAgent: () => isHostedAgent(),
}))

import {
  createdTaskId,
  restBoard,
  restBoards,
  restCreateTask,
  restDecompose,
  restDispatch,
  restSwitchBoard,
  restUpdateTask,
} from '../kanban-rest'
import {
  kanbanAssign,
  kanbanBackend,
  kanbanBoards,
  kanbanComment,
  kanbanComplete,
  kanbanCreate,
  kanbanDecompose,
  kanbanList,
  kanbanSwarm,
  kanbanSwitchBoard,
} from '../kanban'
import { spawnSubagent } from '../spawn'

const w = window as unknown as { nubAgent?: unknown }
let cli: ReturnType<typeof vi.fn>

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  isHostedAgent.mockReset().mockResolvedValue(true)
  cli = vi.fn(async () => ({ ok: true, data: [] }))
  w.nubAgent = { kanban: cli, hermes: vi.fn(async () => ({ ok: true })), task: vi.fn(async () => ({ ok: true })) }
})
afterEach(() => {
  delete w.nubAgent
})

const board = {
  columns: [
    { name: 'triage', tasks: [{ id: 't1', title: 'Plan trip', status: 'triage', body: 'Paris' }] },
    { name: 'done', tasks: [{ id: 't2', title: 'Book hotel', status: 'done' }] },
  ],
}

describe('kanban-rest routes', () => {
  it('reads the board with a board query only when not default', async () => {
    serveGetDetailed.mockResolvedValue({ data: board })
    await restBoard()
    await restBoard('default')
    await restBoard('home')
    expect(serveGetDetailed.mock.calls.map((c) => c[0])).toEqual([
      '/api/plugins/kanban/board',
      '/api/plugins/kanban/board',
      '/api/plugins/kanban/board?board=home',
    ])
  })

  it('lists boards with names and the current one', async () => {
    serveGetDetailed.mockResolvedValue({
      data: {
        boards: [
          { slug: 'default', name: 'Default', is_current: false, total: 3 },
          { slug: 'home', name: 'Home jobs', is_current: true, total: 1 },
          { name: 'no slug' },
        ],
        current: 'home',
      },
    })
    const res = await restBoards()
    expect(res.data).toEqual({
      current: 'home',
      boards: [
        { slug: 'default', name: 'Default', total: 3, isCurrent: false },
        { slug: 'home', name: 'Home jobs', total: 1, isCurrent: true },
      ],
    })
  })

  it('switches boards', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { current: 'home' } })
    expect((await restSwitchBoard('home')).data).toEqual({ current: 'home' })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/boards/home/switch')
  })

  it('creates tasks and reads the id from {task:{id}}', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { task: { id: 'k9' }, warning: 'no dispatcher' } })
    const res = await restCreateTask({ title: 'Do it', body: 'details', triage: true }, 'home')
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/tasks?board=home', {
      title: 'Do it',
      body: 'details',
      triage: true,
    })
    expect(res.data).toEqual({ id: 'k9', warning: 'no dispatcher' })
    expect(createdTaskId({ id: 'old' })).toBe('old')
    expect(createdTaskId(null)).toBeUndefined()
  })

  it('patches tasks', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await restUpdateTask('t1', { status: 'done' })
    expect(serveSend).toHaveBeenCalledWith('PATCH', '/api/plugins/kanban/tasks/t1', { status: 'done' })
  })

  it('decomposes ("Break this down")', async () => {
    serveSend.mockResolvedValueOnce({ ok: true, data: { ok: true, fanout: true, child_ids: ['c1', 'c2'] } })
    expect((await restDecompose('t1')).data).toEqual({ fanout: true, childIds: ['c1', 'c2'] })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/tasks/t1/decompose', {})
    serveSend.mockResolvedValueOnce({ ok: true, data: { ok: false, reason: 'No helper model configured' } })
    expect(await restDecompose('t1')).toEqual({ ok: false, error: 'No helper model configured' })
    serveSend.mockResolvedValueOnce({ ok: false, status: 404, error: 'HTTP 404' })
    expect((await restDecompose('t1')).error).toMatch(/needs an update/)
  })

  it('dispatches one task', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await restDispatch('home', 1)
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/dispatch?max=1&board=home')
  })
})

describe('kanban.ts on a hosted VM uses REST only', () => {
  it('never touches the CLI bridge', async () => {
    serveGetDetailed.mockImplementation(async (p: string) =>
      p.endsWith('/boards') ? { data: { boards: [{ slug: 'default', name: 'Default' }], current: 'default' } } : { data: board },
    )
    serveSend.mockResolvedValue({ ok: true, data: { task: { id: 'n1' } } })
    expect(await kanbanBackend()).toBe('rest')
    const list = await kanbanList()
    expect(list.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(await kanbanBoards()).toEqual({ boards: ['default'], currentBoard: 'default', labels: { default: 'Default' } })
    expect(await kanbanCreate({ title: 'x' })).toEqual({ ok: true, id: 'n1' })
    expect((await kanbanComplete('t1')).ok).toBe(true)
    expect((await kanbanAssign('t1', 'scout')).ok).toBe(true)
    expect((await kanbanComment('t1', 'hi')).ok).toBe(true)
    expect((await kanbanSwitchBoard('home')).ok).toBe(true)
    expect((await kanbanSwarm({ goal: 'g' })).ok).toBe(false)
    expect(cli).not.toHaveBeenCalled()
  })

  it('reports REST failures instead of falling back', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: '' } })
    const res = await kanbanList()
    expect(res.tasks).toEqual([])
    expect(res.error).toMatch(/needs an update/)
    expect(cli).not.toHaveBeenCalled()
  })

  it('decompose summarises the split', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, fanout: true, child_ids: ['a', 'b', 'c'] } })
    expect(await kanbanDecompose('t1')).toEqual({ ok: true, childCount: 3, message: 'Split into 3 smaller tasks.' })
  })

  it('local hermes keeps the CLI path', async () => {
    isHostedAgent.mockResolvedValue(false)
    expect(await kanbanBackend()).toBe('local')
    const res = await kanbanDecompose('t1')
    expect(res.ok).toBe(true)
    expect(cli).toHaveBeenCalledWith(['decompose', 't1'])
  })
})

describe('/spawn on a hosted VM', () => {
  it('creates an assigned kanban task and nudges dispatch', async () => {
    serveSend
      .mockResolvedValueOnce({ ok: true, data: { task: { id: 'sp1' } } })
      .mockResolvedValueOnce({ ok: true, data: {} })
    const res = await spawnSubagent('bash', 'clean the logs', { agent: 'Scout' })
    expect(res).toEqual({ ok: true, kind: 'bash', channel: 'kanban', taskId: 'sp1' })
    expect(serveSend.mock.calls[0]).toEqual([
      'POST',
      '/api/plugins/kanban/tasks',
      { title: 'clean the logs', assignee: 'scout' },
    ])
    expect(serveSend.mock.calls[1]?.[1]).toBe('/api/plugins/kanban/dispatch?max=1')
    const bridges = w.nubAgent as { task: ReturnType<typeof vi.fn>; hermes: ReturnType<typeof vi.fn> }
    expect(bridges.task).not.toHaveBeenCalled()
    expect(bridges.hermes).not.toHaveBeenCalled()
  })

  it('defaults to the main agent and reports failures', async () => {
    serveSend.mockResolvedValueOnce({ ok: false, status: 409, error: 'board locked' })
    const res = await spawnSubagent('executor', 'ship it')
    expect(serveSend.mock.calls[0]?.[2]).toEqual({ title: 'ship it', assignee: 'default' })
    expect(res).toEqual({ ok: false, kind: 'executor', channel: 'kanban', error: 'board locked' })
  })

  it('local desktop keeps the task queue', async () => {
    isHostedAgent.mockResolvedValue(false)
    const res = await spawnSubagent('bash', 'ls')
    expect(res.channel).toBe('task')
    expect(serveSend).not.toHaveBeenCalled()
  })
})
