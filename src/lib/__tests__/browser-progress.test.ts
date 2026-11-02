import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBrowserProgressEvent } from '../delegate-apply'
import { streamChatCompletion } from '../hermes-stream'
import {
  createConversation,
  getState,
  resetStore,
  upsertSubagent,
} from '../agents/store'
import type { Conversation, SubagentRun } from '../agents/types'

afterEach(() => {
  resetStore()
  vi.unstubAllGlobals()
})

function conv(): Conversation {
  return createConversation({ type: 'agent', agentId: 'qa' })
}

function browserRun(conversationId: string, extra?: Partial<SubagentRun>): SubagentRun {
  const run: SubagentRun = {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    parentAgentId: 'qa',
    kind: 'browserUse',
    title: 'check the dashboard',
    status: 'queued',
    createdAt: new Date().toISOString(),
    digests: [],
    conversationId,
    source: 'spawn',
    ...extra,
  }
  upsertSubagent(run)
  return run
}

describe('applyBrowserProgressEvent', () => {
  it('binds by job id and writes a Browsing digest with url', () => {
    const c = conv()
    const run = browserRun(c.id, { browserJobId: 'j1', status: 'running' })
    const next = applyBrowserProgressEvent({
      conversation: c,
      payload: { jobId: 'j1', status: 'running', url: 'https://example.com/y' },
    })
    expect(next?.id).toBe(run.id)
    expect(next?.status).toBe('running')
    expect(next?.digests.at(-1)?.text).toBe('Browsing https://example.com/y…')
  })

  it('claims the oldest unbound browserUse run and pins the job id', () => {
    const c = conv()
    const run = browserRun(c.id)
    const next = applyBrowserProgressEvent({
      conversation: c,
      payload: {
        jobId: 'j9',
        status: 'running',
        screenshotRef: '/opt/data/browser/jobs/j9/shot-1.png',
      },
    })
    expect(next?.id).toBe(run.id)
    expect(next?.browserJobId).toBe('j9')
    // No url → bare Browsing; the shot ref rides along for the VmShot path.
    expect(next?.digests.at(-1)?.text).toBe(
      'Browsing…\nscreenshot: /opt/data/browser/jobs/j9/shot-1.png',
    )
    // Second event for the same job rebinds the same run, not a sibling.
    const other = browserRun(c.id)
    const again = applyBrowserProgressEvent({
      conversation: c,
      payload: { jobId: 'j9', status: 'running' },
    })
    expect(again?.id).toBe(run.id)
    expect(again?.id).not.toBe(other.id)
  })

  it('completes terminal jobs with finishedAt and never touches terminal runs', () => {
    const c = conv()
    const run = browserRun(c.id, { browserJobId: 'j1', status: 'running' })
    const done = applyBrowserProgressEvent({
      conversation: c,
      payload: { jobId: 'j1', status: 'done' },
    })
    expect(done?.status).toBe('completed')
    expect(done?.finishedAt).toBeTruthy()
    const failed = applyBrowserProgressEvent({
      conversation: c,
      payload: { jobId: 'j1', status: 'failed' },
    })
    // Run already terminal → untouched (null), not resurrected.
    expect(failed).toBeNull()
    expect(getState().subagentsById[run.id]?.status).toBe('completed')
  })

  it('ignores malformed payloads without touching the store', () => {
    const c = conv()
    browserRun(c.id, { browserJobId: 'j1' })
    const before = JSON.stringify(getState().subagentsById)
    expect(applyBrowserProgressEvent({ conversation: c, payload: null })).toBeNull()
    expect(applyBrowserProgressEvent({ conversation: c, payload: {} })).toBeNull()
    expect(
      applyBrowserProgressEvent({ conversation: c, payload: { status: 'running' } }),
    ).toBeNull()
    expect(
      applyBrowserProgressEvent({ conversation: c, payload: { jobId: '  ', status: 'x' } }),
    ).toBeNull()
    expect(JSON.stringify(getState().subagentsById)).toBe(before)
  })

  it('creates no phantom pill when no browserUse run is active', () => {
    const c = conv()
    browserRun(c.id, { browserJobId: 'j1', status: 'completed', finishedAt: '2026-09-05T00:01:00Z' })
    const count = Object.keys(getState().subagentsById).length
    expect(
      applyBrowserProgressEvent({
        conversation: c,
        payload: { jobId: 'ghost', status: 'running' },
      }),
    ).toBeNull()
    expect(Object.keys(getState().subagentsById)).toHaveLength(count)
  })
})

describe('streamChatCompletion browser frames', () => {
  function stubSse(body: string): void {
    const bytes = new TextEncoder().encode(body)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    )
  }

  it('forwards browser.progress frames to onBrowser', async () => {
    stubSse(
      'event: browser.progress\n' +
        'data: {"jobId":"j1","status":"running","url":"https://example.com/y"}\n' +
        '\n' +
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
    )
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = []
    const res = await streamChatCompletion(
      'http://127.0.0.1:9119',
      { message: 'hi' },
      { onDelta: () => {}, onBrowser: (ev) => seen.push(ev) },
    )
    expect(res.ok).toBe(true)
    expect(seen).toEqual([
      {
        type: 'browser.progress',
        payload: { jobId: 'j1', status: 'running', url: 'https://example.com/y' },
      },
    ])
  })

  it('drops malformed browser frames without failing the turn', async () => {
    stubSse(
      'event: browser.progress\ndata: not-json\n\n' +
        'event: browser.progress\ndata: [1,2]\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
    )
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = []
    const res = await streamChatCompletion(
      'http://127.0.0.1:9119',
      { message: 'hi' },
      { onDelta: () => {}, onBrowser: (ev) => seen.push(ev) },
    )
    expect(res.ok).toBe(true)
    // Non-JSON is dropped; arrays normalize to {} (same contract as the
    // deploy stream) — downstream shape validation nulls them, no crash.
    expect(seen).toEqual([{ type: 'browser.progress', payload: {} }])
  })
})
