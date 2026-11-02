import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendMessage,
  appendSubagentMessage,
  autoTitleConversation,
  createConversation,
  deleteConversation,
  duplicateConversation,
  findSubagentRunForSession,
  flushMessagePatches,
  getConversation,
  getMessagesForConversation,
  getState,
  hideConversation,
  listConversations,
  listHiddenConversations,
  markConversationRead,
  markConversationUnread,
  patchMessage,
  resetStore,
  selectConversation,
  subscribe,
  syncSubagentMessage,
  togglePinConversation,
  touchConversation,
  unhideConversation,
  updateAgent,
  upsertSubagent,
} from '../store'
import type { SubagentRun } from '../types'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T12:00:00Z'))
  resetStore({ seed: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('store basics', () => {
  it('seeds agents, groups, and conversations', () => {
    const s = getState()
    expect(s.agents.length).toBeGreaterThan(0)
    expect(s.groups.length).toBeGreaterThan(0)
    expect(s.conversations.length).toBeGreaterThan(0)
    expect(s.selectedConversationId).toBeTruthy()
  })

  it('subscribes and notifies on mutation', () => {
    let calls = 0
    const unsub = subscribe(() => {
      calls += 1
    })
    createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    expect(calls).toBeGreaterThan(0)
    unsub()
    const before = calls
    createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    expect(calls).toBe(before)
  })
})

describe('conversations', () => {
  it('can retain a created room without changing the selected conversation', () => {
    const selected = getState().selectedConversationId
    const target = { type: 'group' as const, groupId: getState().groups[0]!.id }
    const conversation = createConversation(target, 'Saved room', { select: false })
    expect(getState().selectedConversationId).toBe(selected)
    expect(getConversation(conversation.id)?.target).toEqual(target)
    expect(getMessagesForConversation(conversation.id).length).toBeGreaterThan(0)
  })
  it('creates a conversation bound to a target and selects it', () => {
    const agentId = getState().agents[0]!.id
    const conv = createConversation({ type: 'agent', agentId })
    expect(getState().selectedConversationId).toBe(conv.id)
    expect(getConversation(conv.id)?.target).toEqual({ type: 'agent', agentId })
    // New conversation carries a system opener message.
    expect(getMessagesForConversation(conv.id).length).toBeGreaterThan(0)
  })

  it('auto-titles from the first reply (first line, ≤60 chars)', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    autoTitleConversation(conv.id, 'First line here\nSecond line ignored')
    expect(getConversation(conv.id)?.title).toBe('First line here')
  })

  it('does not clobber an explicit title', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    autoTitleConversation(conv.id, 'First line')
    autoTitleConversation(conv.id, 'Second title should not apply')
    expect(getConversation(conv.id)?.title).toBe('First line')
  })

  it('ignores timeout and serve-unavailable replies', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    autoTitleConversation(conv.id, 'stream timed out')
    expect(getConversation(conv.id)?.title).toBe('New conversation')
    autoTitleConversation(
      conv.id,
      '(serve unavailable: hermes serve not configured (set token via desktop bridge or env))',
    )
    expect(getConversation(conv.id)?.title).toBe('New conversation')
    autoTitleConversation(conv.id, 'Flights look good Friday')
    expect(getConversation(conv.id)?.title).toBe('Flights look good Friday')
  })

  it('sorts by lastUsedAt and re-sorts on touch', () => {
    const a = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    vi.setSystemTime(new Date('2026-08-12T12:00:01Z'))
    const b = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const list = listConversations()
    expect(list[0]!.id).toBe(b.id)
    vi.setSystemTime(new Date('2026-08-12T12:00:02Z'))
    touchConversation(a.id)
    const re = listConversations()
    expect(re[0]!.id).toBe(a.id)
  })

  it('deletes a conversation and reselects', () => {
    const a = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    deleteConversation(a.id)
    expect(getConversation(a.id)).toBeNull()
    expect(getMessagesForConversation(a.id)).toEqual([])
    expect(getState().selectedConversationId).not.toBe(a.id)
  })

  it('selection does not bump lastUsedAt', () => {
    const a = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const before = getConversation(a.id)?.lastUsedAt
    vi.setSystemTime(new Date('2026-08-12T12:00:03Z'))
    selectConversation(a.id)
    expect(getConversation(a.id)?.lastUsedAt).toBe(before)
  })
})

describe('agents', () => {
  it('updates persona + mascot profile', () => {
    const agentId = getState().agents[0]!.id
    const updated = updateAgent(agentId, {
      name: 'Renamed',
      title: 'Specialist',
      description: 'New bio',
      avatarShape: 'cat',
      avatarColor: '#123456',
    })
    expect(updated?.name).toBe('Renamed')
    expect(updated?.persona?.title).toBe('Specialist')
    expect(updated?.persona?.description).toBe('New bio')
    expect(updated?.avatarColor).toBe('#123456')
    const stored = getState().agents.find((a) => a.id === agentId)!
    expect(stored.name).toBe('Renamed')
    expect(stored.avatarShape).toBe('cat')
  })

  it('sets and clears the Chief role (the Chief switch was silently dropped)', () => {
    const agentId = getState().agents[0]!.id
    expect(updateAgent(agentId, { role: 'orchestrator' })?.role).toBe('orchestrator')
    expect(getState().agents.find((a) => a.id === agentId)?.role).toBe('orchestrator')
    expect(updateAgent(agentId, { role: 'specialist' })?.role).toBe('specialist')
    expect(updateAgent(agentId, { role: null })?.role).toBeUndefined()
    expect(updateAgent(agentId, { name: 'Other' })?.role).toBeUndefined()
  })

  it('returns null for a missing agent', () => {
    expect(updateAgent('nope', { name: 'x' })).toBeNull()
  })
})

describe('subagent bubbles (Grok Bot parity)', () => {
  function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
    return {
      id: 'run_x',
      parentAgentId: 'inst_a',
      kind: 'executor',
      title: 'Summarize docs',
      status: 'queued',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
      conversationId: 'conv_x',
      ...overrides,
    }
  }

  it('appendSubagentMessage adds one deterministic bubble per run', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const r = run({ id: 'run_x', conversationId: conv.id })
    appendSubagentMessage(conv.id, r)
    appendSubagentMessage(conv.id, r) // re-sync never duplicates
    const bubbles = getMessagesForConversation(conv.id).filter(
      (m) => m.role === 'subagent' && m.subagentRunId === 'run_x',
    )
    expect(bubbles.length).toBe(1)
    expect(bubbles[0]!.subagentStatus).toBe('queued')
    expect(bubbles[0]!.subagentKind).toBe('executor')
  })

  it('copies the peer label onto the bubble', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const r = run({ id: 'run_named', conversationId: conv.id, kind: 'custom', label: 'TravelAgent' })
    appendSubagentMessage(conv.id, r)
    const bubble = getMessagesForConversation(conv.id).find((m) => m.subagentRunId === 'run_named')
    expect(bubble?.subagentLabel).toBe('TravelAgent')
  })

  it('syncSubagentMessage updates status + body to the latest digest/result', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const r = run({ id: 'run_x', conversationId: conv.id })
    appendSubagentMessage(conv.id, r)
    syncSubagentMessage({
      ...r,
      status: 'running',
      digests: [{ id: 'd1', at: '2026-08-12T12:00:01Z', text: 'scanned context' }],
    })
    let bubble = getMessagesForConversation(conv.id).find(
      (m) => m.role === 'subagent' && m.subagentRunId === 'run_x',
    )!
    expect(bubble.subagentStatus).toBe('running')
    expect(bubble.content).toBe('scanned context')

    syncSubagentMessage({
      ...r,
      status: 'completed',
      result: { summary: 'Done: mapped instances' },
    })
    bubble = getMessagesForConversation(conv.id).find(
      (m) => m.role === 'subagent' && m.subagentRunId === 'run_x',
    )!
    expect(bubble.subagentStatus).toBe('completed')
    expect(bubble.content).toBe('Done: mapped instances')
  })

  it('syncSubagentMessage no-ops for runs without a conversation', () => {
    const before = getMessagesForConversation('nope').length
    syncSubagentMessage(run({ conversationId: undefined }))
    expect(getMessagesForConversation('nope').length).toBe(before)
  })

  it('appendSubagentMessage does not wipe a synced body on re-append', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    const r = run({ id: 'run_x', conversationId: conv.id })
    appendSubagentMessage(conv.id, r)
    syncSubagentMessage({
      ...r,
      status: 'running',
      digests: [{ id: 'd1', at: '2026-08-12T12:00:01Z', text: 'keep me' }],
    })
    appendSubagentMessage(conv.id, r)
    const bubble = getMessagesForConversation(conv.id).find(
      (m) => m.role === 'subagent' && m.subagentRunId === 'run_x',
    )!
    expect(bubble.content).toBe('keep me')
    expect(bubble.subagentStatus).toBe('running')
  })
})

describe('patchMessage coalescing', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('batches content deltas until flush (one notify)', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    appendMessage(conv.id, {
      id: 'm1',
      threadId: conv.id,
      role: 'agent',
      content: '',
      createdAt: '2026-08-12T12:00:00Z',
      streaming: true,
    })
    let calls = 0
    const unsub = subscribe(() => {
      calls += 1
    })
    patchMessage(conv.id, 'm1', { content: 'Hel' })
    patchMessage(conv.id, 'm1', { content: 'Hell' })
    patchMessage(conv.id, 'm1', { content: 'Hello' })
    expect(calls).toBe(0)
    expect(getMessagesForConversation(conv.id).find((m) => m.id === 'm1')?.content).toBe('')
    flushMessagePatches()
    expect(calls).toBe(1)
    expect(getMessagesForConversation(conv.id).find((m) => m.id === 'm1')?.content).toBe('Hello')
    unsub()
  })

  it('flushes immediately when streaming ends', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    appendMessage(conv.id, {
      id: 'm1',
      threadId: conv.id,
      role: 'agent',
      content: '',
      createdAt: '2026-08-12T12:00:00Z',
      streaming: true,
    })
    patchMessage(conv.id, 'm1', { content: 'Hi', streaming: false })
    const msg = getMessagesForConversation(conv.id).find((m) => m.id === 'm1')
    expect(msg?.content).toBe('Hi')
    expect(msg?.streaming).toBe(false)
  })
})

describe('hide from sidebar', () => {
  it('hides a conversation without deleting messages', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    hideConversation(conv.id)
    expect(getConversation(conv.id)?.hiddenFromSidebar).toBe(true)
    expect(getMessagesForConversation(conv.id).length).toBeGreaterThan(0)
    expect(getState().selectedConversationId).not.toBe(conv.id)
  })

  it('unhides a conversation and lists hidden ones', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    hideConversation(conv.id)
    expect(listHiddenConversations().some((c) => c.id === conv.id)).toBe(true)
    unhideConversation(conv.id)
    expect(getConversation(conv.id)?.hiddenFromSidebar).toBe(false)
    expect(listHiddenConversations().some((c) => c.id === conv.id)).toBe(false)
  })
})

describe('pin, unread, duplicate', () => {
  it('sorts pinned conversations first', () => {
    const agentId = getState().agents[0]!.id
    const older = createConversation({ type: 'agent', agentId })
    vi.setSystemTime(new Date('2026-08-12T12:00:01Z'))
    const newer = createConversation({ type: 'agent', agentId })
    expect(listConversations()[0]!.id).toBe(newer.id)
    togglePinConversation(older.id)
    const list = listConversations()
    expect(list[0]!.id).toBe(older.id)
    expect(list[0]!.pinned).toBe(true)
    expect(list[1]!.id).toBe(newer.id)
  })

  it('toggles unread per conversation', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    markConversationUnread(conv.id)
    expect(getConversation(conv.id)?.hasUnread).toBe(true)
    markConversationRead(conv.id)
    expect(getConversation(conv.id)?.hasUnread).toBe(false)
  })

  it('duplicates an agent conversation with the same target', () => {
    const agentId = getState().agents[0]!.id
    const conv = createConversation({ type: 'agent', agentId }, 'Flights')
    const clone = duplicateConversation(conv.id)
    expect(clone).not.toBeNull()
    expect(clone!.id).not.toBe(conv.id)
    expect(clone!.title).toBe('Flights copy')
    expect(clone!.target).toEqual({ type: 'agent', agentId })
    expect(getState().selectedConversationId).toBe(clone!.id)
    expect(getConversation(conv.id)).not.toBeNull()
  })

  it('does not duplicate a group conversation', () => {
    const groupId = getState().groups[0]!.id
    const conv = createConversation({ type: 'group', groupId })
    expect(duplicateConversation(conv.id)).toBeNull()
  })

  it('deletes a conversation so it is gone', () => {
    const conv = createConversation({ type: 'agent', agentId: getState().agents[0]!.id })
    deleteConversation(conv.id)
    expect(getConversation(conv.id)).toBeNull()
    expect(listConversations().some((c) => c.id === conv.id)).toBe(false)
  })
})

describe('subagent session claim', () => {
  it('matches a run by [maia-run:id] in the session title', () => {
    const r: SubagentRun = {
      id: 'run_abc',
      parentAgentId: 'inst_a',
      kind: 'bash',
      title: 'echo hi',
      status: 'running',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
    }
    upsertSubagent(r)
    const hit = findSubagentRunForSession('20260812_170840_d90055', '[maia-run:run_abc] echo hi')
    expect(hit?.id).toBe('run_abc')
  })

  it('returns null when no run owns the session', () => {
    expect(findSubagentRunForSession('20260812_170840_d90055', 'unrelated title')).toBeNull()
  })

  it('matches a run by bound hermesSessionId without a title', () => {
    upsertSubagent({
      id: 'run_sid',
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'flights',
      status: 'running',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
      hermesSessionId: 'child_sess_1',
      label: 'TravelAgent',
    })
    expect(findSubagentRunForSession('child_sess_1')?.id).toBe('run_sid')
    expect(findSubagentRunForSession('child_sess_1', '')?.id).toBe('run_sid')
  })

  it('matches a run by hermesSubagentId', () => {
    upsertSubagent({
      id: 'run_sa',
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'flights',
      status: 'running',
      createdAt: '2026-08-12T12:00:00Z',
      digests: [],
      hermesSubagentId: 'sa_live',
      source: 'delegate_task',
    })
    expect(findSubagentRunForSession('sa_live')?.id).toBe('run_sa')
  })
})
