import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import { resetStore, setState, appendMessage, flushMessagePatches, getMessagesForConversation } from '../store'
import { __resetAgentPrompts, TYPED_REPLY_NOTE, answerAgentPrompt, getAgentPrompts } from '../agent-prompts'
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

const conv: Conversation = {
  id: 'conv_p',
  title: 'Prompt chat',
  target: { type: 'agent', agentId: 'inst_nub_1' },
  createdAt: '2026-09-26T00:00:00Z',
  lastUsedAt: '2026-09-26T00:00:00Z',
  hermesSessionId: 'sess_p',
}

type Fire = (ev: { type: string; session_id?: string; payload?: unknown }) => void

function setup() {
  const transport = new HermesServeTransport({})
  const request = vi.fn(async (_method: string, _params: object) => ({ status: 'ok' }))
  ;(transport as unknown as { ensureClient: () => Promise<unknown> }).ensureClient = async () => ({ request })
  const fire: Fire = (ev) => (transport as unknown as { handleServeEvent: Fire }).handleServeEvent(ev)
  return { transport, request, fire }
}

beforeEach(() => {
  resetStore()
  __resetAgentPrompts()
  setState((prev) => ({ conversations: [...prev.conversations, conv] }))
})

describe('HermesServeTransport in-chat prompts', () => {
  it('secret.request → card; Save answers secret.respond {request_id, value}', async () => {
    const { request, fire } = setup()
    const log = vi.spyOn(console, 'log')
    fire({ type: 'secret.request', session_id: 'sess_p', payload: { request_id: 'r1', env_var: 'TENOR_API_KEY', prompt: 'p' } })
    expect(getAgentPrompts()).toHaveLength(1)
    expect(getAgentPrompts()[0]).toMatchObject({ kind: 'secret', conversationId: 'conv_p' })
    await answerAgentPrompt('r1', { kind: 'secret', value: 'sk-live-123' })
    expect(request).toHaveBeenCalledWith('secret.respond', { request_id: 'r1', value: 'sk-live-123' })
    expect(getAgentPrompts()).toEqual([])
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain('sk-live-123')
    log.mockRestore()
  })

  it('Skip answers an empty value', async () => {
    const { request, fire } = setup()
    fire({ type: 'secret.request', session_id: 'sess_p', payload: { request_id: 'r1', env_var: 'X_KEY' } })
    await answerAgentPrompt('r1', { kind: 'secret', skip: true })
    expect(request).toHaveBeenCalledWith('secret.respond', { request_id: 'r1', value: '' })
  })

  it('clarify single answer and cancel', async () => {
    const { request, fire } = setup()
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c1', question: 'Q?', choices: ['a', 'b'] } })
    await answerAgentPrompt('c1', { kind: 'clarify', answers: [{ answer: 'b' }] })
    expect(request).toHaveBeenCalledWith('clarify.respond', { request_id: 'c1', answer: 'b' })
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c2', question: 'Q?' } })
    await answerAgentPrompt('c2', { kind: 'clarify', cancel: true })
    expect(request).toHaveBeenLastCalledWith('clarify.respond', { request_id: 'c2', answer: '' })
  })

  it('answering on the card leaves what was asked and answered in the thread', async () => {
    const { fire } = setup()
    appendMessage(conv.id, { id: 'reply', threadId: conv.id, role: 'agent', content: 'One thing:', createdAt: '2026-09-26T00:00:01Z', streaming: true })
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c1', question: 'Which city?', choices: ['Paris', 'Rome'] } })
    await answerAgentPrompt('c1', { kind: 'clarify', answers: [{ answer: 'Rome' }] })
    const msgs = getMessagesForConversation(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['agent', 'user'])
    expect(msgs[1]).toMatchObject({ content: 'Which city?\nRome', answerAt: { replyId: 'reply', offset: 10 } })
    // No live reply to anchor to (nothing streaming) → no stray bubble.
    fire({ type: 'message.complete', session_id: 'sess_p', payload: { text: 'One thing: done.' } })
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c2', question: 'Late?' } })
    await answerAgentPrompt('c2', { kind: 'clarify', answers: [{ answer: 'yes' }] })
    expect(getMessagesForConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('clarify batch answers each question with its question_id', async () => {
    const { request, fire } = setup()
    fire({
      type: 'clarify.request',
      session_id: 'sess_p',
      payload: { request_id: 'b1', questions: [{ qid: 'q1', question: 'One?', choices: ['x'] }, { qid: 'q2', question: 'Two?' }] },
    })
    await answerAgentPrompt('b1', { kind: 'clarify', answers: [{ qid: 'q1', answer: 'x' }, { qid: 'q2', answer: 'free' }] })
    expect(request.mock.calls).toEqual([
      ['clarify.respond', { request_id: 'b1', answer: 'x', question_id: 'q1' }],
      ['clarify.respond', { request_id: 'b1', answer: 'free', question_id: 'q2' }],
    ])
  })

  it('mcp.setup success reloads MCP before answering with the JSON outcome', async () => {
    const { request, fire } = setup()
    fire({ type: 'mcp.setup.request', session_id: 'sess_p', payload: { request_id: 'm1', server: 'linear', action: 'install' } })
    await answerAgentPrompt('m1', { kind: 'mcp', outcome: { status: 'installed', server: 'linear' } })
    expect(request.mock.calls).toEqual([
      ['reload.mcp', { confirm: true, session_id: 'sess_p' }],
      ['mcp.setup.respond', { request_id: 'm1', result: '{"status":"installed","server":"linear"}' }],
    ])
  })

  it('mcp.setup decline answers without reloading', async () => {
    const { request, fire } = setup()
    fire({ type: 'mcp.setup.request', session_id: 'sess_p', payload: { request_id: 'm1', server: 'linear' } })
    await answerAgentPrompt('m1', { kind: 'mcp', outcome: { status: 'declined', server: 'linear' } })
    expect(request.mock.calls).toEqual([
      ['mcp.setup.respond', { request_id: 'm1', result: '{"status":"declined","server":"linear"}' }],
    ])
  })

  it('*.expire clears the card; unknown sessions are ignored', () => {
    const { fire } = setup()
    fire({ type: 'clarify.request', session_id: 'other', payload: { request_id: 'x', question: 'Q?' } })
    expect(getAgentPrompts()).toEqual([])
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c1', question: 'Q?' } })
    fire({ type: 'clarify.expire', session_id: 'sess_p', payload: { request_id: 'c1' } })
    expect(getAgentPrompts()).toEqual([])
  })

  it('message.complete clears leftover cards and keeps a failed turn visible', () => {
    const { fire } = setup()
    appendMessage(conv.id, { id: 'reply', threadId: conv.id, role: 'agent', content: '', createdAt: '2026-09-26T00:00:01Z', streaming: true })
    fire({ type: 'secret.request', session_id: 'sess_p', payload: { request_id: 'r1', env_var: 'A_KEY' } })
    fire({ type: 'message.complete', session_id: 'sess_p', payload: { text: '', status: 'error', error: 'Error code: 429 - rate limit' } })
    expect(getAgentPrompts()).toEqual([])
    const reply = getMessagesForConversation(conv.id).find((m) => m.id === 'reply')
    expect(reply).toMatchObject({ streaming: false, error: true, content: 'Error code: 429 - rate limit' })
  })

  it('a typed message answers the waiting question instead of the busy bubble', async () => {
    const { transport, request, fire } = setup()
    appendMessage(conv.id, { id: 'reply', threadId: conv.id, role: 'agent', content: 'Two things:', createdAt: '2026-09-26T00:00:01Z', streaming: true })
    fire({
      type: 'clarify.request',
      session_id: 'sess_p',
      payload: { request_id: 'b1', questions: [{ qid: 'q0', question: 'One?', choices: ['x'] }, { qid: 'q1', question: 'Two?' }] },
    })
    await transport.sendMessage(conv, 'x, and about ten')
    expect(request.mock.calls).toEqual([
      ['clarify.respond', { request_id: 'b1', answer: 'x, and about ten', question_id: 'q0' }],
      ['clarify.respond', { request_id: 'b1', answer: TYPED_REPLY_NOTE, question_id: 'q1' }],
    ])
    expect(getAgentPrompts()).toEqual([])
    const msgs = getMessagesForConversation(conv.id)
    // The typed text shows as the user's bubble; no busy note, no second reply.
    expect(msgs.map((m) => m.role)).toEqual(['agent', 'user'])
    expect(msgs[1]?.content).toBe('x, and about ten')
    // Marked with where in the reply it was given, for the transcript order.
    flushMessagePatches()
    expect(getMessagesForConversation(conv.id)[1]?.answerAt).toEqual({ replyId: 'reply', offset: 11, tail: 'Two things:' })
  })

  it('a typed reply to a question that already timed out is sent on, not swallowed', async () => {
    const { transport, request, fire } = setup()
    // The gateway answers a late respond with `expired`.
    request.mockImplementation(async (method: string) => (method === 'clarify.respond' ? { status: 'expired' } : { status: 'ok' }))
    appendMessage(conv.id, { id: 'reply', threadId: conv.id, role: 'agent', content: 'Which one?', createdAt: '2026-09-26T00:00:01Z', streaming: true })
    fire({ type: 'clarify.request', session_id: 'sess_p', payload: { request_id: 'c1', question: 'Which one?', choices: ['a', 'b'] } })
    await transport.sendMessage(conv, 'the second')
    flushMessagePatches()
    // The dead card is gone, and the text took the normal path (here: the
    // busy note, since the turn is still streaming) instead of vanishing.
    expect(getAgentPrompts()).toEqual([])
    const msgs = getMessagesForConversation(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['agent', 'user', 'agent'])
    expect(msgs[1]).toMatchObject({ content: 'the second' })
    expect(msgs[1]?.answerAt).toBeUndefined()
  })

  it('an expired key or plugin card is removed when answered late', async () => {
    const { request, fire } = setup()
    request.mockImplementation(async () => ({ status: 'expired' }))
    fire({ type: 'secret.request', session_id: 'sess_p', payload: { request_id: 'r1', env_var: 'X_KEY' } })
    expect(await answerAgentPrompt('r1', { kind: 'secret', value: 'sk-late' })).toBe(false)
    fire({ type: 'mcp.setup.request', session_id: 'sess_p', payload: { request_id: 'm1', server: 'linear' } })
    expect(await answerAgentPrompt('m1', { kind: 'mcp', outcome: { status: 'declined', server: 'linear' } })).toBe(false)
    expect(getAgentPrompts()).toEqual([])
  })
})
