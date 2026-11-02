import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import { flushMessagePatches, getMessagesForConversation, getState, resetStore, setState } from '../store'
import type { Conversation, SubagentRun } from '../types'

const stream = vi.hoisted(() => ({ result: { ok: false, content: '' } as { ok: boolean; content: string } }))
vi.mock('../../hermes-stream', async (original) => ({
  ...(await original<typeof import('../../hermes-stream')>()),
  streamChatCompletion: vi.fn(async () => stream.result),
}))

const conversation: Conversation = {
  id: 'fake-fallback-conversation', title: 'Fixture', target: { type: 'agent', agentId: 'profile:fixture' },
  createdAt: '', lastUsedAt: '',
}
const pill = (id: string, extra: Partial<SubagentRun> = {}): SubagentRun => ({
  id, parentAgentId: 'profile:fixture', kind: 'custom', title: 'Fixture specialist', status: 'running',
  createdAt: '2026-10-20T00:00:00Z', digests: [], conversationId: conversation.id, source: 'delegate_task', ...extra,
} as SubagentRun)

function offlineTransport() {
  const transport = new HermesServeTransport({ apiUrl: 'http://127.0.0.1:1/fixture' })
  ;(transport as unknown as { ensureClient: () => Promise<never> }).ensureClient = async () => { throw new Error('Fixture offline') }
  return transport
}

beforeEach(() => {
  resetStore()
  setState({ conversations: [conversation], messagesByThreadId: {}, subagentsById: {
    stream: pill('stream'), bound: pill('bound', { hermesSessionId: 'fake-child-session' }),
  } })
})

describe('local API fallback stream failures', () => {
  it('closes helpers only the failed stream knew about and keeps its partial reply', async () => {
    stream.result = { ok: false, content: 'Partial fixture answer' }
    await expect(offlineTransport().sendMessage(conversation, 'Fixture prompt')).resolves.toMatchObject({ turnId: expect.any(String) })
    flushMessagePatches()
    expect(getState().subagentsById.stream).toMatchObject({ status: 'failed', error: 'Specialist did not report back (parent stream ended).' })
    expect(getState().subagentsById.bound.status).toBe('running')
    expect(getMessagesForConversation(conversation.id).find((m) => m.role === 'agent')).toMatchObject({
      content: 'Partial fixture answer', streaming: false,
    })
  })

  it('still reports an empty failed stream as offline', async () => {
    stream.result = { ok: false, content: '' }
    await expect(offlineTransport().sendMessage(conversation, 'Fixture prompt')).rejects.toThrow('Hermes serve offline')
    expect(getState().subagentsById.stream.status).toBe('failed')
    expect(getMessagesForConversation(conversation.id).some((m) => m.role === 'agent')).toBe(false)
  })
})
