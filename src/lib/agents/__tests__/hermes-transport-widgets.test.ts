import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesServeTransport } from '../hermes-transport'
import { getPendingToolPermission, setPendingToolPermission } from '../tool-permission'
import { resetStore, setState } from '../store'
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
    id: 'conv_widgets',
    title: 'Widget chat',
    target: { type: 'agent', agentId: 'inst_nub_1' },
    createdAt: '2026-08-13T00:00:00Z',
    lastUsedAt: '2026-08-13T00:00:00Z',
    hermesSessionId: 'sess_widget',
    ...overrides,
  }
}

beforeEach(() => {
  resetStore()
  setPendingToolPermission(null)
})

/** Drive the real serve event handler (same path the WS bridge feeds). */
function fireApproval(
  transport: HermesServeTransport,
  payload: Record<string, unknown>,
): void {
  (
    transport as unknown as {
      handleServeEvent: (ev: { type: string; session_id?: string; payload?: unknown }) => void
    }
  ).handleServeEvent({ type: 'approval.request', session_id: 'sess_widget', payload })
}

describe('HermesServeTransport approval widgets (A1)', () => {
  it('parses an options payload into a question ask with chips', () => {
    const transport = new HermesServeTransport({})
    const conv = conversation()
    setState((prev) => ({ conversations: [...prev.conversations, conv] }))
    fireApproval(transport, {
      command: 'deploy prod',
      description: 'Deploy now?',
      options: [
        { id: 'ship', label: 'Ship it' },
        { id: 'wait', label: 'Not yet' },
      ],
    })
    const ask = getPendingToolPermission()
    expect(ask).not.toBeNull()
    expect(ask?.kind).toBe('question')
    expect(ask?.options).toEqual([
      { id: 'ship', label: 'Ship it' },
      { id: 'wait', label: 'Not yet' },
    ])
    expect(ask?.sessionId).toBe('sess_widget')
    expect(ask?.conversationId).toBe(conv.id)
  })

  it('accepts bare-string options rows', () => {
    const transport = new HermesServeTransport({})
    setState((prev) => ({ conversations: [...prev.conversations, conversation()] }))
    fireApproval(transport, { options: ['Approve merge', 'Hold'] })
    const ask = getPendingToolPermission()
    expect(ask?.options).toEqual([
      { id: 'Approve merge', label: 'Approve merge' },
      { id: 'Hold', label: 'Hold' },
    ])
  })

  it('keeps the legacy command dock when no options ride along', () => {
    const transport = new HermesServeTransport({})
    setState((prev) => ({ conversations: [...prev.conversations, conversation()] }))
    fireApproval(transport, { command: 'rm -rf build', choices: ['once', 'deny'] })
    const ask = getPendingToolPermission()
    expect(ask?.options).toBeUndefined()
    expect(ask?.kind).toBeUndefined()
    expect(ask?.choices).toEqual(['once', 'deny'])
  })
})
