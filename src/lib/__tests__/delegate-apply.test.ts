import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applySubagentGatewayEvent,
  conversationHasLiveDelegates,
  DELEGATE_TIMEOUT_MS,
  failDelegateRuns,
  materializeDelegateRuns,
  resetDelegateTimeouts,
  settleOrphanDelegates,
  shouldFinishAfterLeavingActive,
} from '../delegate-apply'
import {
  appendMessage,
  createConversation,
  getMessagesForConversation,
  getState,
  resetStore,
  upsertSubagent,
} from '../agents/store'
import type { Agent } from '../agents/types'

afterEach(() => {
  resetDelegateTimeouts()
  resetStore()
})

function travel(): Agent {
  return {
    id: 'inst_travel',
    name: 'TravelAgent',
    status: 'running',
    region: 'local',
    createdAt: '2026-08-13T12:00:00Z',
    summary: '',
    persona: { title: 'Travel', description: 'Flights, hotels, and trip planning.' },
  }
}

describe('materializeDelegateRuns', () => {
  it('creates one pill per parallel task with TravelAgent labels', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const runs = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: {
        tasks: [
          { subagent_type: 'travel-agent', goal: 'DTW to ORD' },
          { subagent_type: 'research-alpha', goal: 'weekend hotels' },
        ],
      },
    })
    expect(runs).toHaveLength(2)
    expect(runs[0]?.label).toBe('TravelAgent')
    expect(runs[1]?.label).toBe('research-alpha')
    expect(runs[0]?.source).toBe('delegate_task')
    expect(runs[0]?.status).toBe('running')
    const pills = getMessagesForConversation(conv.id).filter((m) => m.role === 'subagent')
    expect(pills).toHaveLength(2)
    expect(pills[0]?.subagentLabel).toBe('TravelAgent')
  })

  it('is idempotent for the same tool call', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const args = { subagent_type: 'travel-agent', goal: 'flights' }
    const first = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args,
    })
    const second = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args,
    })
    expect(second[0]?.id).toBe(first[0]?.id)
    const pills = getMessagesForConversation(conv.id).filter((m) => m.role === 'subagent')
    expect(pills).toHaveLength(1)
  })

  it('labels TravelAgent from the last user message when the tool omits subagent_type', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    appendMessage(conv.id, {
      id: 'usr_travel',
      threadId: conv.id,
      role: 'user',
      content: 'call the travel agent and check a flight from Detroit to Chicago',
      createdAt: '2026-08-13T12:00:00Z',
    })
    const chief: Agent = {
      id: 'inst_chief',
      name: 'nubbystuffy',
      status: 'running',
      region: 'local',
      createdAt: '2026-08-13T12:00:00Z',
      summary: '',
    }
    const runs = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_sse',
      agents: [chief, travel()],
      args: { goal: 'Research the current cheapest nonstop options and return a table' },
    })
    expect(runs[0]?.label).toBe('TravelAgent')
  })

  it('labels Research Alpha from the parent saying that name', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    appendMessage(conv.id, {
      id: 'usr_news',
      threadId: conv.id,
      role: 'user',
      content: 'can you fetch the latest solana news again',
      createdAt: '2026-08-13T12:00:00Z',
    })
    appendMessage(conv.id, {
      id: 'agt_news',
      threadId: conv.id,
      role: 'agent',
      content: 'Research Alpha is pulling the very latest headlines.',
      createdAt: '2026-08-13T12:00:01Z',
    })
    const alpha: Agent = {
      id: 'inst_alpha',
      name: 'Research Alpha',
      status: 'running',
      region: 'local',
      createdAt: '2026-08-13T12:00:00Z',
      summary: '',
      persona: { title: 'Research', description: 'Web research and summarization.' },
    }
    const runs = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_news',
      agents: [alpha],
      args: { goal: 'latest Solana news' },
    })
    expect(runs[0]?.label).toBe('Research Alpha')
  })
})

describe('applySubagentGatewayEvent', () => {
  it('binds child_session_id and completes without a parent continuation prompt', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { subagent_type: 'travel-agent', goal: 'DTW to ORD' },
    })
    const started = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.start',
      payload: {
        subagent_id: 'sa_live',
        child_session_id: 'sess_child',
        goal: 'DTW to ORD',
        task_index: 0,
      },
      agents: [travel()],
    })
    expect(started?.hermesSubagentId).toBe('sa_live')
    expect(started?.hermesSessionId).toBe('sess_child')
    expect(started?.id).toBe(getState().subagentsById[started!.id]?.id)

    const done = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: {
        subagent_id: 'sa_live',
        status: 'completed',
        summary: 'DTW→ORD from $87',
        task_index: 0,
      },
      agents: [travel()],
    })
    expect(done?.status).toBe('completed')
    expect(done?.result?.summary).toMatch(/\$87/)
    const pills = getMessagesForConversation(conv.id).filter((m) => m.role === 'subagent')
    expect(pills).toHaveLength(1)
  })

  it('appends progress into the live digest', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'search flights' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.start',
      payload: { subagent_id: 'sa_1', task_index: 0 },
    })
    const progressed = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.progress',
      payload: { subagent_id: 'sa_1', text: 'checking Google Flights', task_index: 0 },
    })
    expect(progressed?.digests.at(-1)?.text).toMatch(/Google Flights/)
    expect(progressed?.status).toBe('running')
  })

  it('fails an empty complete instead of stamping Specialist finished', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'latest news' },
    })
    const done = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: { status: 'completed', summary: 'Specialist finished.', task_index: 0 },
      agents: [travel()],
    })
    expect(done?.status).toBe('failed')
    expect(done?.error).toMatch(/no summary/i)
  })

  it('does not reopen a completed run on a late subagent.start', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'build the site' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: { summary: 'site is live', task_index: 0 },
      toolCallId: 'tool_1',
      agents: [travel()],
    })
    const late = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.start',
      payload: { task_index: 0 },
      agents: [travel()],
    })
    expect(late?.status).toBe('completed')
    expect(Object.values(getState().subagentsById).filter((r) => r.conversationId === conv.id)).toHaveLength(1)
  })

  it('does not spawn a second pill when a failed slot gets a late start without ids', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const [run] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'build the site' },
    })
    failDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      error: 'Specialist did not report back (parent stream ended).',
    })
    const late = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.start',
      payload: { task_index: 0 },
      agents: [travel()],
    })
    expect(late?.id).toBe(run?.id)
    expect(late?.status).toBe('failed')
    expect(Object.values(getState().subagentsById).filter((r) => r.conversationId === conv.id)).toHaveLength(1)
  })
})

describe('failDelegateRuns', () => {
  it('fails the matching tool call when delegate_task errors', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'nope' },
    })
    const failed = failDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      error: 'Unknown subagent_type',
    })
    expect(failed[0]?.status).toBe('failed')
    expect(failed[0]?.error).toMatch(/Unknown/)
  })

  it('does not re-fail an already completed matching tool call', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const [run] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      agents: [travel()],
      args: { goal: 'flights' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: { summary: 'DTW→ORD from $87', task_index: 0 },
      toolCallId: 'tool_1',
      agents: [travel()],
    })
    const failed = failDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_1',
      error: 'late tool error',
    })
    expect(failed).toHaveLength(0)
    expect(getState().subagentsById[run!.id]?.status).toBe('completed')
    expect(getState().subagentsById[run!.id]?.result?.summary).toMatch(/\$87/)
  })
})

describe('settleOrphanDelegates', () => {
  it('fails unbound running pills and leaves bound children running', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_sse',
      agents: [travel()],
      args: { goal: 'search flights' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.start',
      payload: { subagent_id: 'sa_bound', child_session_id: 'sess_child', task_index: 0 },
    })
    const conv2 = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv2,
      toolCallId: 'tool_orphan',
      agents: [travel()],
      args: { goal: 'hotels' },
    })
    const settled = settleOrphanDelegates({
      conversation: conv2,
      reason: 'parent stream ended',
      status: 'failed',
    })
    expect(settled).toHaveLength(1)
    expect(settled[0]?.status).toBe('failed')
    expect(settled[0]?.error).toMatch(/parent stream/)
    const bound = Object.values(getState().subagentsById).find((r) => r.hermesSessionId === 'sess_child')
    expect(bound?.status).toBe('running')
  })

  it('marks SSE-only running pills completed with a summary and no parent-stream error', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_sse',
      agents: [travel()],
      args: { goal: 'search flights' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.progress',
      payload: { text: 'DTW→ORD from $87', task_index: 0 },
    })
    const settled = settleOrphanDelegates({
      conversation: conv,
      reason: 'Specialist did not report back (parent stream ended).',
      status: 'completed',
    })
    expect(settled).toHaveLength(1)
    expect(settled[0]?.status).toBe('completed')
    expect(settled[0]?.result?.summary).toMatch(/\$87/)
    expect(settled[0]?.error ?? '').not.toMatch(/parent stream/)
  })

  it('does not touch completed, failed, or cancelled runs', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const [done] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_done',
      agents: [travel()],
      args: { goal: 'done' },
    })
    applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: { summary: 'all good', task_index: 0 },
      toolCallId: 'tool_done',
      agents: [travel()],
    })
    const [failed] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_fail',
      agents: [travel()],
      args: { goal: 'fail' },
    })
    failDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_fail',
      error: 'Unknown subagent_type',
    })
    const [cancelled] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_cancel',
      agents: [travel()],
      args: { goal: 'cancel' },
    })
    upsertSubagent({
      ...getState().subagentsById[cancelled!.id]!,
      status: 'cancelled',
      finishedAt: '2026-08-13T12:01:00Z',
      error: 'Cancelled by user',
    })

    const settled = settleOrphanDelegates({
      conversation: conv,
      reason: 'parent stream ended',
      status: 'failed',
    })
    expect(settled).toHaveLength(0)
    expect(getState().subagentsById[done!.id]?.status).toBe('completed')
    expect(getState().subagentsById[done!.id]?.result?.summary).toMatch(/all good/)
    expect(getState().subagentsById[failed!.id]?.status).toBe('failed')
    expect(getState().subagentsById[failed!.id]?.error).toMatch(/Unknown/)
    expect(getState().subagentsById[cancelled!.id]?.status).toBe('cancelled')
    expect(getState().subagentsById[cancelled!.id]?.error).toMatch(/Cancelled/)
  })

  it('does not touch source!==delegate_task spawned side chats', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    upsertSubagent({
      id: 'run_spawn',
      parentAgentId: 'inst_chief',
      kind: 'custom',
      title: 'side chat',
      status: 'running',
      createdAt: '2026-08-13T12:00:00Z',
      startedAt: '2026-08-13T12:00:00Z',
      digests: [],
      conversationId: conv.id,
      source: 'spawn',
    })
    const settled = settleOrphanDelegates({
      conversation: conv,
      reason: 'parent stream ended',
      status: 'failed',
    })
    expect(settled).toHaveLength(0)
    expect(getState().subagentsById.run_spawn?.status).toBe('running')
  })
})

describe('shouldFinishAfterLeavingActive', () => {
  it('waits until the child was seen live and the grace period passed', () => {
    const startedAt = '2026-08-13T12:00:00.000Z'
    const nowMs = Date.parse(startedAt) + 9_000
    expect(
      shouldFinishAfterLeavingActive({
        seenActive: false,
        stillActive: false,
        startedAt,
        nowMs,
      }),
    ).toBe(false)
    expect(
      shouldFinishAfterLeavingActive({
        seenActive: true,
        stillActive: true,
        startedAt,
        nowMs,
      }),
    ).toBe(false)
    expect(
      shouldFinishAfterLeavingActive({
        seenActive: true,
        stillActive: false,
        startedAt,
        nowMs,
      }),
    ).toBe(true)
  })
})

describe('conversationHasLiveDelegates', () => {
  it('is true while a child is queued or running', () => {
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    expect(conversationHasLiveDelegates(conv.id)).toBe(false)
    materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_live',
      agents: [travel()],
      args: { goal: 'news' },
    })
    expect(conversationHasLiveDelegates(conv.id)).toBe(true)
  })
})

describe('delegate timeout', () => {
  it('fails a still-running child after DELEGATE_TIMEOUT_MS', () => {
    vi.useFakeTimers()
    const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
    const [run] = materializeDelegateRuns({
      conversation: conv,
      toolCallId: 'tool_slow',
      agents: [travel()],
      args: { goal: 'news' },
    })
    vi.advanceTimersByTime(DELEGATE_TIMEOUT_MS)
    expect(getState().subagentsById[run!.id]?.status).toBe('failed')
    expect(getState().subagentsById[run!.id]?.error).toMatch(/timed out/i)
    vi.useRealTimers()
  })

  it('measures silence: start and progress events restart the timeout', () => {
    vi.useFakeTimers()
    try {
      const conv = createConversation({ type: 'agent', agentId: 'inst_chief' })
      const [run] = materializeDelegateRuns({
        conversation: conv,
        toolCallId: 'tool_busy',
        agents: [travel()],
        args: { goal: 'news' },
      })
      const event = (type: string, payload: Record<string, unknown> = {}) =>
        applySubagentGatewayEvent({ conversation: conv, type, toolCallId: 'tool_busy', payload: { task_index: 0, ...payload } })
      const almost = DELEGATE_TIMEOUT_MS - 60_000
      vi.advanceTimersByTime(almost)
      event('subagent.start')
      vi.advanceTimersByTime(almost)
      event('subagent.progress', { text: 'Still searching' })
      vi.advanceTimersByTime(almost)
      expect(getState().subagentsById[run!.id]?.status).toBe('running')
      vi.advanceTimersByTime(60_000)
      expect(getState().subagentsById[run!.id]?.status).toBe('failed')
      expect(getState().subagentsById[run!.id]?.error).toMatch(/timed out/i)
    } finally { vi.useRealTimers() }
  })
})
