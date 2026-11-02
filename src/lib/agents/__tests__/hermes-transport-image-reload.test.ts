import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import { INLINE_IMAGE_PLACEHOLDER } from '../persist'
import { getMessagesForConversation, resetStore, setState } from '../store'
import type { ChatMessage, Conversation } from '../types'

vi.mock('../../maiavm-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../maiavm-api')>()
  return {
    ...actual,
    resolveNubApiConnection: vi.fn(async () => null),
    getHermesServeUrl: vi.fn(() => 'http://127.0.0.1:8899'),
  }
})

vi.mock('../../build-env', () => ({ isProdBuild: () => false }))

const PNG = `data:image/png;base64,${'A'.repeat(200)}`
const CONV: Conversation = {
  id: 'conv_serve',
  title: 'Serve chat',
  target: { type: 'agent', agentId: 'local-hermes' },
  createdAt: '2026-08-13T00:00:00Z',
  lastUsedAt: '2026-08-13T00:00:00Z',
  hermesSessionId: 'sess_1',
}

const row = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  threadId: CONV.id,
  role: 'agent',
  content: '',
  createdAt: '2026-08-13T00:00:01Z',
  ...patch,
})

function seed(messages: ChatMessage[]) {
  setState(() => ({
    conversations: [CONV],
    messagesByThreadId: { [CONV.id]: messages },
  }))
}

function serveReturns(messages: { id: number; role: string; content: string }[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => resetStore())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HermesServeTransport.getMessages inline image reload', () => {
  it('re-fetches the transcript when a persisted image placeholder is present', async () => {
    seed([
      row({ id: 'u', role: 'user', content: 'chart please' }),
      row({ id: 'a', content: `here ${INLINE_IMAGE_PLACEHOLDER}`, reactions: [] }),
    ])
    const fetchMock = serveReturns([
      { id: 1, role: 'user', content: 'chart please' },
      { id: 2, role: 'assistant', content: `here ![chart](${PNG})` },
    ])
    const transport = new HermesServeTransport({ baseUrl: 'http://127.0.0.1:8899', token: 'tok' })
    const out = await transport.getMessages(CONV.id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out[1]?.content).toContain(PNG)
    expect(out.every((m) => m.threadId === CONV.id)).toBe(true)
    expect(getMessagesForConversation(CONV.id)[1]?.content).toContain(PNG)
  })

  it('also reloads rows stripped by earlier builds (old placeholder text)', async () => {
    seed([
      row({ id: 'u', role: 'user', content: 'chart please' }),
      row({ id: 'a', content: 'here *[image not saved offline — reopen to reload]*', reactions: [] }),
    ])
    const fetchMock = serveReturns([
      { id: 1, role: 'user', content: 'chart please' },
      { id: 2, role: 'assistant', content: `here ![chart](${PNG})` },
    ])
    const transport = new HermesServeTransport({ baseUrl: 'http://127.0.0.1:8899', token: 'tok' })
    const out = await transport.getMessages(CONV.id)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out[1]?.content).toContain(PNG)
  })

  it('serves the local copy without a fetch when nothing was stripped', async () => {
    seed([row({ id: 'u', role: 'user', content: 'hi' }), row({ id: 'a', content: 'hello' })])
    const fetchMock = serveReturns([])
    const transport = new HermesServeTransport({ baseUrl: 'http://127.0.0.1:8899', token: 'tok' })
    const out = await transport.getMessages(CONV.id)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.map((m) => m.content)).toEqual(['hi', 'hello'])
  })

  it('keeps the local copy while a turn is streaming', async () => {
    seed([
      row({ id: 'a', content: INLINE_IMAGE_PLACEHOLDER }),
      row({ id: 'live', content: 'typing', streaming: true }),
    ])
    const fetchMock = serveReturns([{ id: 1, role: 'assistant', content: `![x](${PNG})` }])
    const transport = new HermesServeTransport({ baseUrl: 'http://127.0.0.1:8899', token: 'tok' })
    const out = await transport.getMessages(CONV.id)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out).toHaveLength(2)
  })

  it('keeps the placeholder copy when serve has no transcript', async () => {
    seed([row({ id: 'a', content: INLINE_IMAGE_PLACEHOLDER })])
    serveReturns([])
    const transport = new HermesServeTransport({ baseUrl: 'http://127.0.0.1:8899', token: 'tok' })
    const out = await transport.getMessages(CONV.id)
    expect(out[0]?.content).toBe(INLINE_IMAGE_PLACEHOLDER)
  })
})
