import { describe, expect, it } from 'vitest'
import { HudActivityTracker, hudBadge, liveConversationIds, type HudActivity } from '../hud-activity'
import type { AgentsState } from '../agents/store'
import type { ChatMessage, Conversation } from '../agents/types'

function conv(id: string, title: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title,
    target: { type: 'agent', agentId: 'a1' },
    createdAt: '2026-09-28T00:00:00Z',
    lastUsedAt: '2026-09-28T00:00:00Z',
    ...extra,
  }
}

function agentMsg(id: string, threadId: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, threadId, role: 'agent', content, createdAt: '2026-09-28T00:00:00Z', ...extra }
}

function state(conversations: Conversation[], messagesByThreadId: Record<string, ChatMessage[]>): AgentsState {
  return {
    agents: [],
    groups: [],
    conversations,
    messagesByThreadId,
    subagentsById: {},
    turnsById: {},
    selectedConversationId: null,
  }
}

const noLive = { liveTurns: {} }

describe('liveConversationIds', () => {
  it('unions local streaming bubbles with server live turns, minus hidden rows', () => {
    const s = state(
      [conv('c1', 'One'), conv('c2', 'Two'), conv('c3', 'Hidden', { hiddenFromSidebar: true })],
      { c1: [agentMsg('m1', 'c1', 'hi', { streaming: true })] },
    )
    const live = liveConversationIds(s, {
      liveTurns: {
        c2: { turnId: 't', sessionId: 's', status: 'streaming' },
        c3: { turnId: 't3', sessionId: 's3', status: 'queued' },
      },
    })
    expect([...live].sort()).toEqual(['c1', 'c2'])
  })
})

describe('HudActivityTracker', () => {
  it('boot is quiet: no finish events for turns it never saw running', () => {
    const t = new HudActivityTracker()
    const out = t.update(state([conv('c1', 'One')], { c1: [agentMsg('m1', 'c1', 'done')] }), noLive, 10)
    expect(out.events).toEqual([])
    expect(out.working).toEqual([])
  })

  it('live → idle emits a finished event with the reply preview, markers stripped', () => {
    const t = new HudActivityTracker()
    t.update(state([conv('c1', 'Deploy check')], { c1: [agentMsg('m1', 'c1', '', { streaming: true })] }), noLive, 10)
    const out = t.update(
      state([conv('c1', 'Deploy check')], { c1: [agentMsg('m1', 'c1', 'All **green** [POINT:10,20:here]')] }),
      noLive,
      20,
    )
    expect(out.events).toEqual([
      { key: 'c1:m1', id: 'c1', title: 'Deploy check', preview: 'All green', status: 'done', at: 20 },
    ])
  })

  it('a failed turn is an error event; a turn on another device uses the sync preview', () => {
    const t = new HudActivityTracker()
    const running = { liveTurns: { c2: { turnId: 't', sessionId: 's', status: 'streaming' as const } } }
    t.update(state([conv('c1', 'A'), conv('c2', 'B', { preview: 'from phone' })], { c1: [agentMsg('m1', 'c1', '', { streaming: true })] }), running, 10)
    const out = t.update(
      state([conv('c1', 'A'), conv('c2', 'B', { preview: 'from phone' })], { c1: [agentMsg('m1', 'c1', 'nope', { error: true })] }),
      noLive,
      20,
    )
    const byId = Object.fromEntries(out.events.map((e) => [e.id, e]))
    expect(byId.c1.status).toBe('error')
    expect(byId.c2).toMatchObject({ status: 'done', preview: 'from phone' })
  })

  it('a deleted conversation is not "finished"', () => {
    const t = new HudActivityTracker()
    t.update(state([conv('c1', 'A')], { c1: [agentMsg('m1', 'c1', '', { streaming: true })] }), noLive, 10)
    expect(t.update(state([], {}), noLive, 20).events).toEqual([])
  })
})

describe('hudBadge priority', () => {
  const ev = (key: string, status: 'done' | 'error') => ({ key, id: 'c', title: 'T', preview: '', status, at: 1 })
  const act = (working: number, events: ReturnType<typeof ev>[]): HudActivity => ({
    v: 1,
    working: Array.from({ length: working }, (_, i) => ({ id: `w${i}`, title: `W${i}` })),
    events,
  })

  it('none without a feed', () => {
    expect(hudBadge(null, new Set())).toEqual({ kind: 'none' })
  })
  it('unseen failure > working > unseen finish', () => {
    expect(hudBadge(act(2, [ev('a', 'done'), ev('b', 'error')]), new Set()).kind).toBe('error')
    expect(hudBadge(act(2, [ev('a', 'done')]), new Set())).toMatchObject({ kind: 'working', count: 2 })
    expect(hudBadge(act(0, [ev('a', 'done')]), new Set()).kind).toBe('done')
  })
  it('seen events draw nothing', () => {
    expect(hudBadge(act(0, [ev('a', 'done'), ev('b', 'error')]), new Set(['a', 'b']))).toEqual({ kind: 'none' })
  })
})
