import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import {
  appendMessage,
  flushMessagePatches,
  getMessagesForConversation,
  getState,
  resetStore,
  setState,
} from '../store'
import type { Conversation } from '../types'

vi.mock('../../maiavm-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../maiavm-api')>()
  return {
    ...actual,
    resolveNubApiConnection: vi.fn(async () => null),
    getHermesServeUrl: vi.fn(() => 'http://127.0.0.1:8899'),
  }
})

vi.mock('../../build-env', () => ({ isProdBuild: () => false }))

function conversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv_serve',
    title: 'Serve chat',
    target: { type: 'agent', agentId: 'inst_nub_1' },
    createdAt: '2026-08-13T00:00:00Z',
    lastUsedAt: '2026-08-13T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  resetStore()
})

describe('HermesServeTransport.sendMessage busy-gate', () => {
  it('replies with the busy bubble instead of stacking a second live reply', async () => {
    const transport = new HermesServeTransport({})
    const conv = conversation()
    setState((prev) => ({ conversations: [...prev.conversations, conv] }))
    // A turn is already streaming in this thread.
    appendMessage(conv.id, {
      id: 'turn_live',
      threadId: conv.id,
      role: 'agent',
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      toolEvents: [],
    })

    const { turnId } = await transport.sendMessage(conv, 'hello again')
    flushMessagePatches()

    const msgs = getMessagesForConversation(conv.id)
    // No second streaming bubble; the new send produced a settled busy note.
    expect(msgs.filter((m) => m.streaming)).toHaveLength(1)
    const last = msgs[msgs.length - 1]
    expect(last?.content).toMatch(/Still working on your last one/)
    expect(last?.streaming).toBeUndefined()
    expect(turnId).toBeTruthy()
  })
})

describe('HermesServeTransport hung-stream settle', () => {
  it('writes visible timeout copy instead of silently stopping an empty bubble', async () => {
    vi.useFakeTimers()
    const transport = new HermesServeTransport({})
    const conv = conversation()
    setState((prev) => ({ conversations: [...prev.conversations, conv] }))
    appendMessage(conv.id, {
      id: 'turn_stuck',
      threadId: conv.id,
      role: 'agent',
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      toolEvents: [],
    })
    // Simulate the send path marking the conversation live, then the idle
    // watchdog firing with no frames ever arriving.
    ;(transport as unknown as {
      streamingByConversation: Map<string, boolean>
    }).streamingByConversation.set(conv.id, true)
    ;(transport as unknown as {
      onStreamWatchFire: (id: string) => void
    }).onStreamWatchFire(conv.id)

    flushMessagePatches()
    const stuck = getMessagesForConversation(conv.id).find((m) => m.id === 'turn_stuck')
    expect(stuck?.streaming).toBe(false)
    expect(stuck?.content).toMatch(/didn't finish a reply/)
    expect(stuck?.error).toBe(true)
    expect(stuck?.content).not.toMatch(/overloaded/i)

    // Partial content keeps the text and appends the stop marker.
    const conv2 = conversation({ id: 'conv_serve_2' })
    setState((prev) => ({ conversations: [...prev.conversations, conv2] }))
    appendMessage(conv2.id, {
      id: 'turn_partial',
      threadId: conv2.id,
      role: 'agent',
      content: 'half an answer',
      createdAt: new Date().toISOString(),
      streaming: true,
      toolEvents: [],
    })
    ;(transport as unknown as {
      streamingByConversation: Map<string, boolean>
    }).streamingByConversation.set(conv2.id, true)
    ;(transport as unknown as {
      onStreamWatchFire: (id: string) => void
    }).onStreamWatchFire(conv2.id)

    flushMessagePatches()
    const partial = getMessagesForConversation(conv2.id).find((m) => m.id === 'turn_partial')
    expect(partial?.content).toBe('half an answer')
    expect(partial?.error).toBe(true)
    expect(partial?.errorNote).toMatch(/timed out.*without updates/i)
    vi.useRealTimers()
  })
})

describe('HermesServeTransport unsuccessful completion', () => {
  it.each(['error', 'interrupted'])('does not call a %s completion done or discard its partial reply', (status) => {
    const transport = new HermesServeTransport({})
    const conv = conversation({ hermesSessionId: 'session-failed' })
    setState((prev) => ({ conversations: [...prev.conversations, conv] }))
    appendMessage(conv.id, {
      id: 'partial-reply', threadId: conv.id, role: 'agent',
      content: 'A partial fixture reply.', streaming: true, createdAt: new Date().toISOString(),
    })
    ;(transport as unknown as {
      handleServeEvent: (event: { type: string; session_id: string; payload: { status: string; text: string } }) => void
    }).handleServeEvent({ type: 'message.complete', session_id: 'session-failed', payload: { status, text: '' } })
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id).at(-1)).toMatchObject({
      content: 'A partial fixture reply.', streaming: false, error: true, errorNote: expect.any(String),
    })
    expect(Object.values(getState().turnsById).at(-1)?.phase).toBe('failed')
  })
})

describe('appendMessageContent token coalescing', () => {
  it('keeps both deltas when two arrive inside one rAF window', async () => {
    const { appendMessageContent, flushMessagePatches } = await import('../store')
    const conv = conversation({ id: 'conv_append' })
    setState((prev) => ({ conversations: [...prev.conversations, conv] }))
    appendMessage(conv.id, {
      id: 'turn_app',
      threadId: conv.id,
      role: 'agent',
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      toolEvents: [],
    })

    // Two appends with no flush between them (same rAF window).
    appendMessageContent(conv.id, 'turn_app', 'first ')
    appendMessageContent(conv.id, 'turn_app', 'second')
    expect(getMessagesForConversation(conv.id).find((m) => m.id === 'turn_app')?.content).toBe('')

    flushMessagePatches()
    const msg = getMessagesForConversation(conv.id).find((m) => m.id === 'turn_app')
    // The naive read-then-replace would yield 'second' here.
    expect(msg?.content).toBe('first second')
  })
})
