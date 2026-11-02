import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import { flushMessagePatches, getMessagesForConversation, getState, resetStore, setState } from '../store'
import type { Conversation } from '../types'

vi.mock('../../spawn', async (original) => ({
  ...(await original<typeof import('../../spawn')>()),
  spawnSubagent: vi.fn(async () => ({ ok: false, error: 'Fixture worker unavailable.' })),
}))

const conversation: Conversation = {
  id: 'fake-offline-conversation', title: 'Fixture', target: { type: 'agent', agentId: 'profile:fixture' },
  createdAt: '', lastUsedAt: '',
}
beforeEach(() => {
  resetStore()
  setState({ conversations: [conversation], messagesByThreadId: {}, subagentsById: {} })
})
afterEach(() => vi.useRealTimers())
describe('honest local transport failures', () => {
  it('rejects an offline send instead of returning a demo answer', async () => {
    const transport = new HermesServeTransport({})
    ;(transport as unknown as { ensureClient: () => Promise<never> }).ensureClient = async () => { throw new Error('Fixture offline') }
    await expect(transport.sendMessage(conversation, 'Fixture prompt')).rejects.toThrow('Hermes serve offline')
    flushMessagePatches()
    const messages = getMessagesForConversation(conversation.id)
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages.filter((message) => message.role === 'agent')).toHaveLength(0)
    expect(messages.some((message) => message.streaming)).toBe(false)
  })
  it('keeps a failed real spawn failed after the former demo timeout', async () => {
    vi.useFakeTimers()
    const transport = new HermesServeTransport({})
    const run = await transport.spawnSubagentInto(conversation, 'bash', 'Fixture task')
    expect(run.status).toBe('failed')
    expect(run.error).toBe('Fixture worker unavailable.')
    await vi.advanceTimersByTimeAsync(3000)
    expect(getState().subagentsById[run.id]?.status).toBe('failed')
    expect(getState().subagentsById[run.id]?.result).toBeUndefined()
  })
})
