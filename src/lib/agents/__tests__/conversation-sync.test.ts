import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../build-env', () => ({ isProdBuild: () => false }))

import {
  ConversationSyncEngine,
  applySyncPage,
  coalesceOutboxOp,
  dropUnlisted,
  liveTurnsFromPage,
  pendingFieldsOf,
  resolveLiveTurns,
  type ConversationDTO,
  type GroupDTO,
  type OutboxOp,
  type PendingView,
  type SyncPage,
} from '../conversation-sync'
import {
  autoTitleConversation,
  createConversation,
  getHydrateStatus,
  getState,
  hideConversation,
  resetStore,
  setConversationSyncSink,
  setState,
  togglePinConversation,
  unhideConversation,
} from '../store'
import { recordDeletedConversation, resetDeletedTombstonesForTest } from '../tombstones'
import type { ChatMessage, Conversation, Group } from '../types'

const HOST = 'https://nub.example'
const INSTANCE = 'inst_nub_1'
const NO_PENDING: PendingView = { op: () => undefined }

function dto(partial: Partial<ConversationDTO> & { id: string }): ConversationDTO {
  return {
    kind: 'agent',
    targetId: INSTANCE,
    sessionId: null,
    memberSessions: null,
    title: '',
    titleSource: 'auto',
    hidden: false,
    pinned: false,
    preview: '',
    lastTurnAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    deletedAt: null,
    ...partial,
  }
}

function groupDto(partial: Partial<GroupDTO> & { id: string }): GroupDTO {
  return {
    name: 'Room',
    memberAgentIds: ['a1', 'a2'],
    extra: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    deletedAt: null,
    ...partial,
  }
}

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: 'New conversation',
    target: { type: 'agent', agentId: INSTANCE },
    createdAt: '2026-09-01T00:00:00Z',
    lastUsedAt: '2026-09-01T00:00:00Z',
    ...partial,
  }
}

function msg(threadId: string, id: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, threadId, role, content: id, createdAt: '2026-09-01T00:00:00Z' }
}

function op(partial: Partial<OutboxOp> & Pick<OutboxOp, 'id' | 'op'>): OutboxOp {
  return { entity: 'thread', attempts: 0, nextAt: 0, rev: 0, ...partial }
}

function pendingOf(...ops: OutboxOp[]): PendingView {
  return { op: (entity, id) => ops.find((o) => o.entity === entity && o.id === id) }
}

function page(partial: Partial<SyncPage>): SyncPage {
  return { conversations: [], groups: [], live: [], cursor: 'c1', hasMore: false, reset: false, ...partial }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function emptyStore(): void {
  setState({
    agents: [],
    groups: [],
    conversations: [],
    messagesByThreadId: {},
    subagentsById: {},
    turnsById: {},
    selectedConversationId: null,
  })
}

function newEngine(opts?: { isBusy?: (id: string) => boolean; onRekey?: (a: string, b: string) => void }) {
  const engine = new ConversationSyncEngine({
    host: HOST,
    instanceId: INSTANCE,
    headers: (extra) => ({ Authorization: 'Bearer nub_desk_x', ...extra }),
    ...opts,
  })
  setConversationSyncSink(engine)
  return engine
}

type Call = { url: string; method: string; body: unknown }

function calls(): Call[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => {
    const i = (init ?? {}) as RequestInit
    return { url: String(url), method: i.method ?? 'GET', body: i.body ? JSON.parse(String(i.body)) : undefined }
  })
}

beforeEach(() => {
  resetStore()
  resetDeletedTombstonesForTest()
  emptyStore()
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unhandled' }, 404)))
})

afterEach(() => {
  setConversationSyncSink(null)
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('outbox coalescing', () => {
  it('merges puts field-wise and bumps the revision', () => {
    const a = op({ id: 'c1', op: 'put', body: { hidden: true, title: 'x' }, rev: 2 })
    const b = op({ id: 'c1', op: 'put', body: { hidden: false } })
    const out = coalesceOutboxOp(a, b)
    expect(out.body).toEqual({ hidden: false, title: 'x' })
    expect(out.rev).toBe(3)
  })

  it('a delete supersedes a put, and a later put never revives a delete', () => {
    const put = op({ id: 'c1', op: 'put', body: { pinned: true } })
    const del = coalesceOutboxOp(put, op({ id: 'c1', op: 'delete' }))
    expect(del.op).toBe('delete')
    expect(coalesceOutboxOp(del, op({ id: 'c1', op: 'put', body: { pinned: false } })).op).toBe('delete')
  })

  it('maps body keys to the store fields they protect', () => {
    const fields = pendingFieldsOf(
      op({ id: 'c1', op: 'put', body: { kind: 'agent', targetId: 'a', titleSource: 'auto', hidden: true } }),
    )
    expect([...fields].sort()).toEqual(['hidden', 'target', 'title'])
    expect(pendingFieldsOf(op({ id: 'c1', op: 'delete' })).size).toBe(0)
  })
})

describe('applySyncPage', () => {
  it('server wins except fields a pending outbox op still carries', () => {
    const state = { ...getState(), conversations: [conv({ id: 'c1', title: 'Mine', hiddenFromSidebar: true })] }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'c1', title: 'Theirs', hidden: false, pinned: true })] }),
      pendingOf(op({ id: 'c1', op: 'put', body: { hidden: true } })),
    )
    const row = res.state.conversations[0]!
    expect(row.title).toBe('Theirs') // no pending title → server wins (no title fight)
    expect(row.hiddenFromSidebar).toBe(true) // pending hide survives the poll
    expect(row.pinned).toBe(true)
  })

  it('an empty server title keeps the local label', () => {
    const state = { ...getState(), conversations: [conv({ id: 'c1', title: 'New conversation' })] }
    const res = applySyncPage(state, page({ conversations: [dto({ id: 'c1', title: '' })] }), NO_PENDING)
    expect(res.state.conversations[0]!.title).toBe('New conversation')
    expect(res.changed).toBe(false)
  })

  it('unhide from another device syncs (server hidden:false clears the flag)', () => {
    const state = { ...getState(), conversations: [conv({ id: 'c1', hiddenFromSidebar: true })] }
    const res = applySyncPage(state, page({ conversations: [dto({ id: 'c1', hidden: false })] }), NO_PENDING)
    expect(res.state.conversations[0]!.hiddenFromSidebar).toBeUndefined()
  })

  it('a tombstone removes the conversation and its messages and reselects', () => {
    const state = {
      ...getState(),
      conversations: [conv({ id: 'c1' }), conv({ id: 'c2', lastUsedAt: '2026-09-02T00:00:00Z' })],
      messagesByThreadId: { c1: [msg('c1', 'm1')], c2: [msg('c2', 'm2')] },
      selectedConversationId: 'c1',
    }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'c1', deletedAt: '2026-09-03T00:00:00Z' })] }),
      NO_PENDING,
    )
    expect(res.state.conversations.map((c) => c.id)).toEqual(['c2'])
    expect(res.state.messagesByThreadId.c1).toBeUndefined()
    expect(res.state.selectedConversationId).toBe('c2')
  })

  it('a tombstone also removes a local copy still keyed by the session', () => {
    const state = { ...getState(), conversations: [conv({ id: 'conv_local', hermesSessionId: 'sess_1' })] }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'cs_sess_1', sessionId: 'sess_1', deletedAt: '2026-09-03T00:00:00Z' })] }),
      NO_PENDING,
    )
    expect(res.state.conversations).toHaveLength(0)
  })

  it('never resurrects a row this device is deleting', () => {
    const res = applySyncPage(
      getState(),
      page({ conversations: [dto({ id: 'c1', title: 'Back' })] }),
      pendingOf(op({ id: 'c1', op: 'delete' })),
    )
    expect(res.state.conversations).toHaveLength(0)
  })

  it('re-keys a local conversation onto the server id when sessions match', () => {
    const state = {
      ...getState(),
      conversations: [conv({ id: 'conv_local', hermesSessionId: 'sess_1' })],
      messagesByThreadId: { conv_local: [msg('conv_local', 'm1')] } as Record<string, ChatMessage[]>,
      selectedConversationId: 'conv_local',
    }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'cs_sess_1', sessionId: 'sess_1', title: 'Hello' })] }),
      NO_PENDING,
    )
    expect(res.rekeys).toEqual([['conv_local', 'cs_sess_1']])
    expect(res.state.conversations.map((c) => c.id)).toEqual(['cs_sess_1'])
    expect(res.state.messagesByThreadId.cs_sess_1?.[0]?.threadId).toBe('cs_sess_1')
    expect(res.state.messagesByThreadId.conv_local).toBeUndefined()
    expect(res.state.selectedConversationId).toBe('cs_sess_1')
  })

  it('defers the re-key while a local send owns the conversation', () => {
    const state = { ...getState(), conversations: [conv({ id: 'conv_local', hermesSessionId: 'sess_1' })] }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'cs_sess_1', sessionId: 'sess_1' })] }),
      NO_PENDING,
      { isBusy: (id) => id === 'conv_local' },
    )
    expect(res.state.conversations.map((c) => c.id)).toEqual(['conv_local'])
    expect(res.deferred).toEqual([{ localId: 'conv_local', sessionId: 'sess_1' }])
  })

  it('drops the unused synthesized placeholder once the server lists real rows', () => {
    const state = { ...getState(), conversations: [conv({ id: `conv_${INSTANCE}`, placeholder: true })] }
    const res = applySyncPage(state, page({ conversations: [dto({ id: 'c1', title: 'Real' })] }), NO_PENDING)
    expect(res.state.conversations.map((c) => c.id)).toEqual(['c1'])
  })

  it('applies groups, round-tripping extra fields, and group tombstones', () => {
    const res = applySyncPage(
      getState(),
      page({
        groups: [
          groupDto({ id: 'g1', extra: { primaryAgentId: 'a2', summary: 'Group room', inviteLink: 'nub-agent://group/g1' } }),
        ],
      }),
      NO_PENDING,
    )
    expect(res.state.groups[0]).toMatchObject({
      id: 'g1',
      name: 'Room',
      memberAgentIds: ['a1', 'a2'],
      primaryAgentId: 'a2',
      summary: 'Group room',
      inviteLink: 'nub-agent://group/g1',
    })
    const gone = applySyncPage(
      res.state,
      page({ groups: [groupDto({ id: 'g1', deletedAt: '2026-09-03T00:00:00Z' })] }),
      NO_PENDING,
    )
    expect(gone.state.groups).toHaveLength(0)
  })

  it('a server-minted row with an empty targetId belongs to the paired default agent', () => {
    const res = applySyncPage(
      getState(),
      page({ conversations: [dto({ id: 'cs_sess_tg', sessionId: 'sess_tg', targetId: '', title: 'From Telegram' })] }),
      NO_PENDING,
      { defaultAgentId: INSTANCE },
    )
    expect(res.state.conversations[0]!.target).toEqual({ type: 'agent', agentId: INSTANCE })
  })

  it('an empty server targetId never overwrites a real local target', () => {
    const state = {
      ...getState(),
      conversations: [conv({ id: 'room', target: { type: 'group', groupId: 'g1' } })],
    }
    const res = applySyncPage(
      state,
      page({ conversations: [dto({ id: 'room', kind: 'agent', targetId: '', sessionId: 'sess_m1' })] }),
      NO_PENDING,
      { defaultAgentId: INSTANCE },
    )
    expect(res.state.conversations[0]!.target).toEqual({ type: 'group', groupId: 'g1' })
  })

  it('never takes a group room primary sessionId from the server (touch-before-PUT artifact)', () => {
    const res = applySyncPage(
      getState(),
      page({ conversations: [dto({ id: 'room', kind: 'group', targetId: 'g1', sessionId: 'sess_member' })] }),
      NO_PENDING,
    )
    expect(res.state.conversations[0]!.hermesSessionId).toBeUndefined()
  })

  it('maps group member sessions onto the room row', () => {
    const res = applySyncPage(
      getState(),
      page({ conversations: [dto({ id: 'room', kind: 'group', targetId: 'g1', memberSessions: { a1: 's1', a2: 's2' } })] }),
      NO_PENDING,
    )
    expect(res.state.conversations[0]).toMatchObject({
      target: { type: 'group', groupId: 'g1' },
      memberSessionIds: { a1: 's1', a2: 's2' },
    })
    expect(res.state.conversations[0]!.hermesSessionId).toBeUndefined()
  })
})

describe('dropUnlisted (reset snapshot)', () => {
  it('drops rows the snapshot omits, keeping outbox-owned rows and the placeholder', () => {
    const state = {
      ...getState(),
      conversations: [conv({ id: 'listed' }), conv({ id: 'gone' }), conv({ id: 'fresh' }), conv({ id: 'ph', placeholder: true })],
      messagesByThreadId: { gone: [msg('gone', 'm1')] },
      groups: [{ id: 'g_gone', name: 'x', memberAgentIds: [], primaryAgentId: '', createdAt: '' } as Group],
    }
    const next = dropUnlisted(
      state,
      { conversations: new Set(['listed']), groups: new Set() },
      pendingOf(op({ id: 'fresh', op: 'put', body: {} })),
    )
    expect(next.conversations.map((c) => c.id)).toEqual(['listed', 'fresh', 'ph'])
    expect(next.messagesByThreadId.gone).toBeUndefined()
    expect(next.groups).toHaveLength(0)
  })
})

describe('resolveLiveTurns', () => {
  it('places a live row with a null conversationId by its (member) session', () => {
    const conversations = [
      conv({ id: 'room', target: { type: 'group', groupId: 'g1' }, memberSessionIds: { a1: 'sess_m1' } }),
      conv({ id: 'c1', hermesSessionId: 'sess_1' }),
    ]
    const out = resolveLiveTurns(
      [
        { conversationId: null, sessionId: 'sess_m1', turnId: 't1', status: 'streaming', updatedAt: '' },
        { conversationId: null, sessionId: 'sess_1', turnId: 't2', status: 'pending', updatedAt: '' },
        { conversationId: null, sessionId: 'sess_unknown', turnId: 't3', status: 'pending', updatedAt: '' },
      ],
      conversations,
    )
    expect(out.map((r) => [r.conversationId, r.turnId])).toEqual([
      ['room', 't1'],
      ['c1', 't2'],
    ])
  })
})

describe('liveTurnsFromPage', () => {
  it('keys the live set by conversation id', () => {
    expect(
      liveTurnsFromPage([
        { conversationId: 'c1', sessionId: 's1', turnId: 't1', status: 'queued', updatedAt: '' },
      ]),
    ).toEqual({ c1: { turnId: 't1', sessionId: 's1', status: 'queued' } })
  })
})

describe('ConversationSyncEngine', () => {
  it('store edits enqueue coalesced PUTs; the default label sends no title', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}))
    const engine = newEngine()
    const c = createConversation({ type: 'agent', agentId: INSTANCE })
    hideConversation(c.id)
    unhideConversation(c.id)
    togglePinConversation(c.id)
    expect(engine.pendingOps()).toHaveLength(1)
    await engine.flush()
    const puts = calls().filter((x) => x.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe(`${HOST}/api/chat/threads/${c.id}?instanceId=${INSTANCE}`)
    expect(puts[0]!.body).toEqual({ kind: 'agent', targetId: INSTANCE, hidden: false, pinned: true })
    expect(engine.pendingOps()).toHaveLength(0)
  })

  it('client auto-title goes out as titleSource auto', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}))
    const engine = newEngine()
    setState({ conversations: [conv({ id: 'c1' })] })
    autoTitleConversation('c1', 'Here is the plan\nmore')
    await engine.flush()
    expect(calls()[0]!.body).toMatchObject({ title: 'Here is the plan', titleSource: 'auto' })
  })

  it('the outbox survives a reload and goes out before the next feed read', async () => {
    const first = newEngine()
    setState({ conversations: [conv({ id: 'c1' })] })
    hideConversation('c1')
    first.dispose()
    setConversationSyncSink(null)
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes('/api/chat/sync') ? json(page({})) : json({}),
    )
    const reloaded = newEngine()
    expect(reloaded.pendingOps().map((o) => o.id)).toEqual(['c1'])
    await reloaded.sync()
    const seq = calls().map((x) => `${x.method} ${x.url.split('?')[0]}`)
    expect(seq[0]).toBe(`PUT ${HOST}/api/chat/threads/c1`)
    expect(seq[1]).toBe(`GET ${HOST}/api/chat/sync`)
    expect(reloaded.pendingOps()).toHaveLength(0)
  })

  it('retries a failed write with backoff and keeps it until acked', async () => {
    const engine = newEngine()
    setState({ conversations: [conv({ id: 'c1' })] })
    togglePinConversation('c1')
    vi.mocked(fetch).mockImplementation(async () => json({ error: 'down' }, 503))
    await engine.flush()
    const [pending] = engine.pendingOps()
    expect(pending?.attempts).toBe(1)
    expect(pending!.nextAt).toBeGreaterThan(Date.now())
    // Not due yet: a flush does not hammer the server.
    await engine.flush()
    expect(calls()).toHaveLength(1)
    pending!.nextAt = 0
    vi.mocked(fetch).mockImplementation(async () => json({}))
    await engine.flush()
    expect(engine.pendingOps()).toHaveLength(0)
  })

  it('an edit made while its PUT is in flight is not lost on ack', async () => {
    const engine = newEngine()
    setState({ conversations: [conv({ id: 'c1' })] })
    togglePinConversation('c1')
    let release!: () => void
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({}))
        }),
    )
    const flushing = engine.flush()
    await vi.waitFor(() => expect(calls()).toHaveLength(1))
    hideConversation('c1')
    release()
    await flushing
    const [left] = engine.pendingOps()
    expect(left?.body).toMatchObject({ pinned: true, hidden: true })
  })

  it('410 on PUT drops the local copy (deleted elsewhere, never resurrected)', async () => {
    const engine = newEngine()
    setState({
      conversations: [conv({ id: 'c1' })],
      messagesByThreadId: { c1: [msg('c1', 'm1')] },
    })
    togglePinConversation('c1')
    vi.mocked(fetch).mockImplementation(async () => json({ error: 'gone', deletedAt: '2026-09-03T00:00:00Z' }, 410))
    await engine.flush()
    expect(getState().conversations).toHaveLength(0)
    expect(getState().messagesByThreadId.c1).toBeUndefined()
    expect(engine.pendingOps()).toHaveLength(0)
  })

  it('409 re-keys the local conversation, messages and selection onto the canonical id', async () => {
    const rekeys: Array<[string, string]> = []
    const engine = newEngine({ onRekey: (a, b) => rekeys.push([a, b]) })
    setState({
      conversations: [conv({ id: 'conv_local', hermesSessionId: 'sess_1', hiddenFromSidebar: true })],
      messagesByThreadId: { conv_local: [msg('conv_local', 'm1')] },
      selectedConversationId: 'conv_local',
    })
    engine.putThread('conv_local', { sessionId: 'sess_1', hidden: true })
    let n = 0
    vi.mocked(fetch).mockImplementation(async () =>
      n++ === 0
        ? json({ error: 'conflict', canonical: dto({ id: 'cs_sess_1', sessionId: 'sess_1', title: 'Hello' }) }, 409)
        : json({}),
    )
    await engine.flush()
    const s = getState()
    expect(s.conversations.map((c) => c.id)).toEqual(['cs_sess_1'])
    expect(s.messagesByThreadId.cs_sess_1?.map((m) => m.threadId)).toEqual(['cs_sess_1'])
    expect(s.selectedConversationId).toBe('cs_sess_1')
    expect(rekeys).toEqual([['conv_local', 'cs_sess_1']])
    // The pending edit moved with it (hidden survives the canonical apply).
    expect(s.conversations[0]!.hiddenFromSidebar).toBe(true)
    expect(engine.pendingOps().map((o) => o.id)).toEqual(['cs_sess_1'])
  })

  it('a reset snapshot drops unlisted rows only after its last page, keeping unsent new chats', async () => {
    const engine = newEngine()
    setState({ conversations: [conv({ id: 'stale' }), conv({ id: 'p2' })] })
    const fresh = createConversation({ type: 'agent', agentId: INSTANCE })
    const pages = [
      page({ reset: true, hasMore: true, cursor: 'c1', conversations: [dto({ id: 'p1', title: 'One' })] }),
      page({ cursor: 'c2', conversations: [dto({ id: 'p2', title: 'Two' })] }),
    ]
    let i = 0
    const syncUrls: string[] = []
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/chat/sync')) {
        syncUrls.push(url)
        return json(pages[i++])
      }
      // The new chat's create PUT is still failing: it must survive the reset.
      return json({ error: 'down' }, 503)
    })
    await engine.sync()
    expect(syncUrls[1]).toContain('since=c1')
    expect(getState().conversations.map((c) => c.id).sort()).toEqual([fresh.id, 'p1', 'p2'].sort())
    expect(window.localStorage.getItem(`maia:conv-sync:v1:${INSTANCE}`)).toBe('c2')
  })

  it('a tombstone in the feed removes the row and its messages', async () => {
    const engine = newEngine()
    setState({ conversations: [conv({ id: 'c1' })], messagesByThreadId: { c1: [msg('c1', 'm1')] } })
    vi.mocked(fetch).mockImplementation(async () =>
      json(page({ conversations: [dto({ id: 'c1', deletedAt: '2026-09-03T00:00:00Z' })] })),
    )
    await engine.sync()
    expect(getState().conversations).toHaveLength(0)
    expect(getState().messagesByThreadId.c1).toBeUndefined()
  })

  it('publishes the live set on the hydrate status', async () => {
    const engine = newEngine()
    vi.mocked(fetch).mockImplementation(async () =>
      json(page({ live: [{ conversationId: 'c1', sessionId: 's1', turnId: 't1', status: 'streaming', updatedAt: '' }] })),
    )
    const res = await engine.sync()
    expect(res.live).toHaveLength(1)
    expect(getHydrateStatus().liveTurns).toEqual({ c1: { turnId: 't1', sessionId: 's1', status: 'streaming' } })
    vi.mocked(fetch).mockImplementation(async () => json(page({})))
    await engine.sync()
    expect(getHydrateStatus().liveTurns).toEqual({})
  })

  it('a locally deleted row still in the feed is deleted server-side, not re-added', async () => {
    const engine = newEngine()
    recordDeletedConversation('c_old', 'sess_old')
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes('/api/chat/sync')
        ? json(page({ conversations: [dto({ id: 'cs_sess_old', sessionId: 'sess_old', title: 'Old' })] }))
        : json({}),
    )
    await engine.sync()
    expect(getState().conversations).toHaveLength(0)
    expect(engine.pendingOps()).toMatchObject([{ id: 'cs_sess_old', op: 'delete' }])
  })

  it('restarts from a full snapshot when the store holds no rows for the cursor', async () => {
    window.localStorage.setItem(`maia:conv-sync:v1:${INSTANCE}`, 'old_cursor')
    const engine = newEngine()
    vi.mocked(fetch).mockImplementation(async () => json(page({ reset: true })))
    await engine.sync()
    expect(calls()[0]!.url).not.toContain('since=')
  })

  it('an engine that is no longer the registered sink never writes', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({}))
    const stale = newEngine()
    stale.putThread('c1', { pinned: true })
    newEngine()
    await stale.flush()
    expect(calls()).toHaveLength(0)
  })

  it('409 whose canonical is a tombstone drops the local copy instead of re-keying', async () => {
    const rekeys: Array<[string, string]> = []
    const engine = newEngine({ onRekey: (a, b) => rekeys.push([a, b]) })
    setState({
      conversations: [conv({ id: 'conv_local', hermesSessionId: 'sess_1' })],
      messagesByThreadId: { conv_local: [msg('conv_local', 'm1')] },
      selectedConversationId: 'conv_local',
    })
    engine.putThread('conv_local', { sessionId: 'sess_1' })
    vi.mocked(fetch).mockImplementation(async () =>
      json(
        {
          error: { code: 'session_conflict', message: 'taken', requestId: 'r1' },
          canonical: dto({ id: 'cs_sess_1', sessionId: 'sess_1', deletedAt: '2026-09-03T00:00:00Z' }),
        },
        409,
      ),
    )
    await engine.flush()
    expect(rekeys).toEqual([])
    expect(getState().conversations).toHaveLength(0)
    expect(getState().messagesByThreadId.conv_local).toBeUndefined()
    expect(engine.pendingOps()).toHaveLength(0)
  })

  it('a reset chain cut off by the page cap drops nothing and keeps the old cursor', async () => {
    window.localStorage.setItem(`maia:conv-sync:v1:${INSTANCE}`, 'old_cursor')
    setState({ conversations: [conv({ id: 'real_1' }), conv({ id: 'real_2' })] })
    const engine = newEngine()
    let n = 0
    vi.mocked(fetch).mockImplementation(async () => {
      n += 1
      // Endless snapshot: every page says there is more.
      return json(page({ reset: n === 1, hasMore: true, cursor: `c${n}`, conversations: [dto({ id: `p${n}` })] }))
    })
    const res = await engine.sync()
    expect(res.ok).toBe(true)
    const ids = getState().conversations.map((c) => c.id)
    expect(ids).toContain('real_1')
    expect(ids).toContain('real_2')
    // Launch always starts from a snapshot (the persisted cursor is dropped),
    // and a cut-off snapshot never commits one.
    expect(window.localStorage.getItem(`maia:conv-sync:v1:${INSTANCE}`)).toBeNull()
    // Next poll re-runs the whole snapshot.
    const before = calls().length
    await engine.sync()
    expect(calls()[before]!.url).not.toContain('since=')
  })

  it('heals a stale store on launch: persisted cursor ignored, full snapshot replaces old rows', async () => {
    // Field bug: cursor current, store stuck on rows the server deleted long ago.
    window.localStorage.setItem(`maia:conv-sync:v1:${INSTANCE}`, 'current_cursor')
    setState({ conversations: [conv({ id: 'gone_1' }), conv({ id: 'gone_2' })], groups: [] })
    const engine = newEngine()
    vi.mocked(fetch).mockImplementation(async () =>
      json(
        page({
          hasMore: false,
          cursor: 'fresh',
          conversations: [dto({ id: 'live_1' }), dto({ id: 'room_1', kind: 'group', targetId: 'g_live' })],
          groups: [{ id: 'g_live', name: 'Nub and Alien', memberAgentIds: [], extra: null, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', deletedAt: null }],
        }),
      ),
    )
    const res = await engine.sync()
    expect(res.ok).toBe(true)
    expect(calls()[0]!.url).not.toContain('since=')
    expect(getState().conversations.map((c) => c.id).sort()).toEqual(['live_1', 'room_1'])
    expect(getState().groups.map((g) => g.name)).toEqual(['Nub and Alien'])
    expect(window.localStorage.getItem(`maia:conv-sync:v1:${INSTANCE}`)).toBe('fresh')
    // Later polls in the same session are deltas again.
    await engine.sync()
    expect(calls().at(-1)!.url).toContain('since=fresh')
  })

  it('first send of an unconfirmed conversation waits for its create PUT', async () => {
    const engine = newEngine()
    const room = createConversation({ type: 'group', groupId: 'g1' }, 'Ops')
    let release!: () => void
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ conversation: dto({ id: room.id, kind: 'group', targetId: 'g1', title: 'Ops' }) }))
        }),
    )
    let done = false
    const waiting = engine.flushBeforeFirstSend(room.id).then(() => {
      done = true
    })
    await vi.waitFor(() => expect(calls()).toHaveLength(1))
    expect(calls()[0]).toMatchObject({ method: 'PUT', body: { kind: 'group', targetId: 'g1' } })
    await Promise.resolve()
    expect(done).toBe(false)
    release()
    await waiting
    expect(engine.pendingOps()).toHaveLength(0)

    // Confirmed now: a later pending edit is dispatched, never awaited.
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}))
    togglePinConversation(room.id)
    const t0 = Date.now()
    await engine.flushBeforeFirstSend(room.id)
    expect(Date.now() - t0).toBeLessThan(100)
  })

  it('an agent row never waits: its create PUT is dispatched and the send goes on', async () => {
    const engine = newEngine()
    const c = createConversation({ type: 'agent', agentId: INSTANCE })
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}))
    const t0 = Date.now()
    await engine.flushBeforeFirstSend(c.id)
    expect(Date.now() - t0).toBeLessThan(100)
    // Dispatched before the caller's POST, carrying the row's identity.
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ method: 'PUT', body: { kind: 'agent', targetId: INSTANCE } })
  })

  it('a group row waits only for its own PUT, not a flush of other ops, and never sends it twice', async () => {
    const engine = newEngine()
    const other = createConversation({ type: 'agent', agentId: INSTANCE })
    const room = createConversation({ type: 'group', groupId: 'g1' }, 'Ops')
    const releases = new Map<string, () => void>()
    vi.mocked(fetch).mockImplementation(
      (url) =>
        new Promise<Response>((resolve) => {
          const id = decodeURIComponent(String(url).split('/threads/')[1]!.split('?')[0]!)
          releases.set(id, () =>
            resolve(json({ conversation: dto({ id, ...(id === room.id ? { kind: 'group', targetId: 'g1' } : {}) }) })),
          )
        }),
    )
    // A flush is busy with the other row (sequential: the room is behind it).
    void engine.flush()
    await vi.waitFor(() => expect(releases.has(other.id)).toBe(true))
    let done = false
    const waiting = engine.flushBeforeFirstSend(room.id).then(() => {
      done = true
    })
    // The room's PUT goes out now, beside the stuck one.
    await vi.waitFor(() => expect(releases.has(room.id)).toBe(true))
    releases.get(room.id)!()
    await waiting
    expect(done).toBe(true)
    // Let the flush reach the room: it joins/acks, it does not PUT again.
    releases.get(other.id)!()
    await engine.flush()
    expect(calls().filter((c) => c.url.includes(encodeURIComponent(room.id)))).toHaveLength(1)
    expect(engine.pendingOps()).toHaveLength(0)
  })

  it('first-send wait is bounded: a hung PUT times out and the send goes on', async () => {
    const engine = newEngine()
    const c = createConversation({ type: 'group', groupId: 'g1' }, 'Ops')
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}))
    const t0 = Date.now()
    await engine.flushBeforeFirstSend(c.id, 50)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(engine.pendingOps().map((o) => o.id)).toEqual([c.id])
  })

  it('an erroring PUT does not block the first send', async () => {
    const engine = newEngine()
    const c = createConversation({ type: 'group', groupId: 'g1' }, 'Ops')
    vi.mocked(fetch).mockImplementation(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(engine.flushBeforeFirstSend(c.id, 3000)).resolves.toBeUndefined()
  })
})
