import { afterEach, describe, expect, it } from 'vitest'
import { continueAfterSubagent, resetSubagentContinuations } from '../subagent-continue'
import {
  createConversation,
  resetStore,
  upsertSubagent,
} from '../agents/store'
import type { SubagentRun } from '../agents/types'

afterEach(() => {
  resetSubagentContinuations()
  resetStore()
})

describe('continueAfterSubagent', () => {
  it('hands the parent a Check-style prompt once the specialist is done', async () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_a' })
    const run: SubagentRun = {
      id: 'run_c',
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'flights',
      status: 'completed',
      createdAt: new Date().toISOString(),
      digests: [],
      label: 'TravelAgent',
      conversationId: conv.id,
      result: { summary: 'DTW→ORD from $87' },
    }
    upsertSubagent(run)
    const sent: string[] = []
    await continueAfterSubagent({
      runId: run.id,
      userText: 'detroit to chicago',
      conversation: conv,
      send: async (text) => {
        sent.push(text)
      },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/TravelAgent/)
    expect(sent[0]).toMatch(/\$87/)
    expect(sent[0]).toMatch(/detroit to chicago/)
  })

  it('does not prompt the parent with a placeholder Specialist finished body', async () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_a' })
    const run: SubagentRun = {
      id: 'run_empty',
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'news',
      status: 'completed',
      createdAt: new Date().toISOString(),
      digests: [],
      conversationId: conv.id,
      result: { summary: 'Specialist finished.' },
    }
    upsertSubagent(run)
    const sent: string[] = []
    await continueAfterSubagent({
      runId: run.id,
      userText: 'solana news',
      conversation: conv,
      send: async (text) => {
        sent.push(text)
      },
    })
    expect(sent).toHaveLength(0)
  })

  it('does not prompt the parent when a failed run only has a placeholder error', async () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_a' })
    const run: SubagentRun = {
      id: 'run_ghost',
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'simple-site',
      status: 'failed',
      createdAt: new Date().toISOString(),
      digests: [],
      conversationId: conv.id,
      error: 'Specialist did not report back (parent stream ended).',
    }
    upsertSubagent(run)
    const sent: string[] = []
    await continueAfterSubagent({
      runId: run.id,
      userText: 'yo. what we building today',
      conversation: conv,
      send: async (text) => {
        sent.push(text)
      },
    })
    expect(sent).toHaveLength(0)
  })

  it('prompts the parent once when two specialists finish with the same result', async () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_a' })
    const mk = (id: string): SubagentRun => ({
      id,
      parentAgentId: 'inst_a',
      kind: 'custom',
      title: 'simple-site',
      status: 'completed',
      createdAt: new Date().toISOString(),
      digests: [],
      label: 'Specialist',
      conversationId: conv.id,
      result: { summary: 'Built /opt/data/workspace/simple-site/index.html' },
    })
    upsertSubagent(mk('run_a'))
    upsertSubagent(mk('run_b'))
    const sent: string[] = []
    await Promise.all([
      continueAfterSubagent({
        runId: 'run_a',
        userText: 'yo. what we building today',
        conversation: conv,
        send: async (text) => {
          sent.push(text)
        },
      }),
      continueAfterSubagent({
        runId: 'run_b',
        userText: 'yo. what we building today',
        conversation: conv,
        send: async (text) => {
          sent.push(text)
        },
      }),
    ])
    expect(sent).toHaveLength(1)
  })
})
