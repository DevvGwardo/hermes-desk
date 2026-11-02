import { beforeEach, describe, expect, it, vi } from 'vitest'
import { absorbHermesSessionRows, hydrateHermesSessions, pruneHydratedSessionDump } from '../agents/hermes-sessions'
import { createConversation, getState, resetStore, setState, upsertSubagent } from '../agents/store'
import type { SubagentRun } from '../agents/types'

const listConversations = vi.hoisted(() => vi.fn(async () => []))
vi.mock('../agents/active-transport', () => ({ getActiveTransport: async () => ({ transport: { listConversations } }) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T12:00:00Z'))
  resetStore()
})

describe('absorbHermesSessionRows', () => {
  it('claims a worker session onto the matching subagent run instead of the sidebar', () => {
    const run: SubagentRun = {
      id: 'run_abc',
      parentAgentId: 'inst_a',
      kind: 'bash',
      title: 'echo hi',
      status: 'running',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
    }
    upsertSubagent(run)
    const before = getState().conversations.length
    const added = absorbHermesSessionRows([
      {
        id: '20260812_170840_d90055',
        title: '[maia-run:run_abc] echo hi',
        createdAt: '2026-08-12T12:00:00Z',
      },
    ])
    expect(added).toBe(0)
    expect(getState().conversations.length).toBe(before)
    expect(getState().subagentsById.run_abc?.hermesSessionId).toBe('20260812_170840_d90055')
  })

  it('does not hydrate an unmatched [maia-run:] worker as a sidebar row', () => {
    const before = getState().conversations.length
    const added = absorbHermesSessionRows([
      {
        id: '20260813_120000_bbbbbb',
        title: '[maia-run:run_msqmt5k] check flights',
        createdAt: '2026-08-13T12:00:00Z',
      },
    ])
    expect(added).toBe(0)
    expect(getState().conversations.length).toBe(before)
  })

  it('does not dump an unmatched session as a sidebar row', () => {
    const before = getState().conversations.length
    const added = absorbHermesSessionRows([
      {
        id: '20260812_111111_aaaaaa',
        title: 'some other chat',
        createdAt: '2026-08-12T12:00:00Z',
      },
    ])
    expect(added).toBe(0)
    expect(getState().conversations.length).toBe(before)
    expect(getState().conversations.some((c) => c.id.startsWith('hermes_'))).toBe(false)
  })

  it('prunes persisted hermes_* session-dump rows', () => {
    setState((prev) => ({
      conversations: [
        ...prev.conversations,
        {
          id: 'hermes_20260812_111111_aaaaaa',
          title: 'dumped session',
          target: { type: 'agent', agentId: 'local-hermes' },
          createdAt: '2026-08-12T12:00:00Z',
          lastUsedAt: '2026-08-12T12:00:00Z',
          hermesSessionId: '20260812_111111_aaaaaa',
        },
      ],
    }))
    const removed = pruneHydratedSessionDump()
    expect(removed).toBe(1)
    expect(getState().conversations.some((c) => c.id.startsWith('hermes_'))).toBe(false)
  })

  it('pins the newest leftover session onto an existing agent chat', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_a' }, 'Research Alpha')
    absorbHermesSessionRows([
      {
        id: '20260812_111111_aaaaaa',
        title: 'old leftover',
        createdAt: '2026-08-12T11:00:00Z',
      },
      {
        id: '20260812_222222_bbbbbb',
        title: 'newer leftover',
        createdAt: '2026-08-12T12:00:00Z',
      },
    ])
    expect(getState().conversations.find((c) => c.id === conv.id)?.hermesSessionId).toBe(
      '20260812_222222_bbbbbb',
    )
  })
})

describe('hydrateHermesSessions Electron IPC', () => {
  it('uses the profile-scoped transport instead of the hermes CLI bridge', async () => {
    const hermes = vi.fn(async () => ({ ok: true, data: 'Title  Workspace  Last Active  ID\n' }))
    ;(window as unknown as { nubAgent: { hermes: typeof hermes } }).nubAgent = { hermes }
    await hydrateHermesSessions()
    expect(hermes).not.toHaveBeenCalled()
    expect(listConversations).toHaveBeenCalled()
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
  })

  it('is a no-op in a plain browser (no bridge)', async () => {
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
    await expect(hydrateHermesSessions()).resolves.toBeTypeOf('number')
  })
})

