import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
  settleStaleInFlight,
} from '../persist'
import type { AgentsState } from '../store'
import type { ChatMessage, SubagentRun, Turn } from '../types'

const LEGACY_KEY = 'maia:agents-store:v1'
const META_KEY = 'maia:agents-store:v2'
const THREAD_KEY = (id: string) => `maia:agents-store:v2:t:${id}`

function state(overrides: Partial<AgentsState> = {}): AgentsState {
  return {
    agents: [],
    groups: [],
    conversations: [],
    messagesByThreadId: {},
    subagentsById: {},
    turnsById: {},
    selectedConversationId: null,
    ...overrides,
  }
}

const msg = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  threadId: 'c1',
  role: 'agent',
  content: 'hi',
  createdAt: '2026-08-13T12:00:00Z',
  ...patch,
})

const run = (patch: Partial<SubagentRun>): SubagentRun => ({
  id: 'r1',
  parentAgentId: 'a1',
  kind: 'bash',
  title: 't',
  status: 'completed',
  createdAt: '2026-08-13T12:00:00Z',
  digests: [],
  ...patch,
})

const turn = (patch: Partial<Turn>): Turn => ({
  id: 't1',
  threadId: 'c1',
  agentId: 'a1',
  userMessageId: 'u1',
  phase: 'working',
  subagentRunIds: [],
  startedAt: '2026-08-13T12:00:00Z',
  ...patch,
})

afterEach(() => {
  clearPersistedState()
})

describe('settleStaleInFlight', () => {
  it('clears persisted streaming so reload does not stay on working', () => {
    const next = settleStaleInFlight(
      state({
        messagesByThreadId: {
          c1: [msg({ streaming: true })],
          c2: [msg({ id: 'm2', streaming: false })],
        },
      }),
    )
    expect(next.messagesByThreadId.c1?.[0]?.streaming).toBe(false)
    expect(next.messagesByThreadId.c2?.[0]?.streaming).toBe(false)
  })

  it('closes running tool chips left over from a killed stream', () => {
    const next = settleStaleInFlight(
      state({
        messagesByThreadId: {
          c1: [
            msg({
              streaming: true,
              toolEvents: [
                { tool: 'read_file', status: 'running' },
                { tool: 'grep', status: 'completed' },
              ],
            }),
          ],
        },
      }),
    )
    const tools = next.messagesByThreadId.c1?.[0]?.toolEvents
    expect(tools?.[0]?.status).toBe('completed')
    expect(tools?.[1]?.status).toBe('completed')
  })

  it('cancels queued/running subagents that cannot resume after reload', () => {
    const next = settleStaleInFlight(
      state({
        subagentsById: {
          r1: run({ status: 'running' }),
          r2: run({ id: 'r2', status: 'queued' }),
          r3: run({ id: 'r3', status: 'completed' }),
        },
      }),
    )
    expect(next.subagentsById.r1?.status).toBe('cancelled')
    expect(next.subagentsById.r2?.status).toBe('cancelled')
    expect(next.subagentsById.r3?.status).toBe('completed')
  })

  it('fails in-flight turns so presence does not stay on working', () => {
    const next = settleStaleInFlight(
      state({
        turnsById: {
          t1: turn({ phase: 'acked' }),
          t2: turn({ id: 't2', phase: 'working' }),
          t3: turn({ id: 't3', phase: 'delivering' }),
          t4: turn({ id: 't4', phase: 'done', finishedAt: '2026-08-13T12:01:00Z' }),
          t5: turn({ id: 't5', phase: 'failed', finishedAt: '2026-08-13T12:01:00Z' }),
        },
      }),
    )
    expect(next.turnsById.t1?.phase).toBe('failed')
    expect(next.turnsById.t2?.phase).toBe('failed')
    expect(next.turnsById.t3?.phase).toBe('failed')
    expect(next.turnsById.t4?.phase).toBe('done')
    expect(next.turnsById.t5?.phase).toBe('failed')
  })

  it('cancels queued/running subagent bubbles on messages', () => {
    const next = settleStaleInFlight(
      state({
        messagesByThreadId: {
          c1: [
            msg({ role: 'subagent', subagentStatus: 'running', subagentRunId: 'r1' }),
            msg({ id: 'm2', role: 'subagent', subagentStatus: 'queued', subagentRunId: 'r2' }),
            msg({ id: 'm3', role: 'subagent', subagentStatus: 'completed', subagentRunId: 'r3' }),
          ],
        },
      }),
    )
    expect(next.messagesByThreadId.c1?.[0]?.subagentStatus).toBe('cancelled')
    expect(next.messagesByThreadId.c1?.[1]?.subagentStatus).toBe('cancelled')
    expect(next.messagesByThreadId.c1?.[2]?.subagentStatus).toBe('completed')
  })
})

describe('save/load persist in-flight flags', () => {
  it('strips streaming before writing so disk cannot rehydrate a live turn', () => {
    savePersistedState(
      state({
        conversations: [],
        agents: [],
        messagesByThreadId: { c1: [msg({ streaming: true })] },
        turnsById: { t1: turn({ phase: 'working' }) },
        subagentsById: { r1: run({ status: 'running' }) },
      }),
    )
    const meta = JSON.parse(window.localStorage.getItem(META_KEY)!) as {
      slice: string
      schemaVersion: number
      threads: string[]
      value: AgentsState
    }
    const thread = JSON.parse(window.localStorage.getItem(THREAD_KEY('c1'))!) as ChatMessage[]
    expect(meta.slice).toBe('maia.agents')
    expect(meta.schemaVersion).toBe(2)
    expect(meta.threads).toEqual(['c1'])
    expect(meta.value).not.toHaveProperty('messagesByThreadId')
    expect(thread[0]?.streaming).toBe(false)
    expect(meta.value.turnsById.t1?.phase).toBe('failed')
    expect(meta.value.subagentsById.r1?.status).toBe('cancelled')
  })

  it('loadPersistedState settles a dirty envelope from an older build', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        slice: 'maia.agents',
        schemaVersion: 1,
        scope: 'client-persisted',
        savedAt: '2026-08-13T18:00:11.761Z',
        value: state({
          conversations: [],
          agents: [],
          messagesByThreadId: { c1: [msg({ streaming: true })] },
          turnsById: { t1: turn({ phase: 'working' }) },
        }),
      }),
    )
    const loaded = loadPersistedState()
    expect(loaded?.messagesByThreadId.c1?.[0]?.streaming).toBe(false)
    expect(loaded?.turnsById.t1?.phase).toBe('failed')
  })
})
