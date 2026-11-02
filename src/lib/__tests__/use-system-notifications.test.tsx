import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const notify = vi.fn(async (_n: unknown) => true)
vi.mock('../system-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../system-notify')>()),
  notify: (n: unknown) => notify(n),
}))
const listServeCronJobs = vi.fn()
vi.mock('../hermes-rest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes-rest')>()),
  listServeCronJobs: () => listServeCronJobs(),
}))
const listRoutineRuns = vi.fn()
const readRunOutput = vi.fn()
vi.mock('../routine-cron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routine-cron')>()),
  listRoutineRuns: (id: string) => listRoutineRuns(id),
  readRunOutput: (id: string) => readRunOutput(id),
}))

import { routinesThatRan, useSystemNotifications } from '../use-system-notifications'
import { appendMessage, flushMessagePatches, patchMessage, setState } from '../agents/store'
import { setPendingToolPermission } from '../agents/tool-permission'
import { readLocalNotifications } from '../notifications'

beforeEach(() => {
  notify.mockClear()
  window.localStorage.clear()
  setState(() => ({
    conversations: [{ id: 't1', title: 'Launch plan', target: { kind: 'agent', id: 'a1' } } as never],
    agents: [{ id: 'a1', name: 'Phoenix' } as never],
    messagesByThreadId: {},
  }))
})
afterEach(() => {
  cleanup()
  setPendingToolPermission(null)
  vi.useRealTimers()
})

describe('routinesThatRan', () => {
  it('records on the first look, then reports in-app routines whose last run moved', () => {
    const jobs = [
      { id: 'a', name: 'News', last_run_at: '2026-10-01T00:00:00Z', deliver: 'local' },
      { id: 'b', name: 'Tg', last_run_at: '2026-10-01T00:00:00Z', deliver: 'telegram' },
    ]
    const first = routinesThatRan(jobs, null)
    expect(first.ran).toEqual([])
    const later = jobs.map((j) => ({ ...j, last_run_at: '2026-10-02T00:00:00Z' }))
    expect(routinesThatRan(later, first.next).ran.map((j) => j.id)).toEqual(['a'])
  })
})

describe('useSystemNotifications', () => {
  it('notifies when a live reply settles, not for history', () => {
    listServeCronJobs.mockResolvedValue(null)
    renderHook(() => useSystemNotifications({ linked: false, onOpenConversation: () => {} }))
    appendMessage('t1', { id: 'old', threadId: 't1', role: 'agent', content: 'history', createdAt: '' })
    expect(notify).not.toHaveBeenCalled()
    appendMessage('t1', { id: 'm1', threadId: 't1', role: 'agent', content: '', createdAt: '', streaming: true, fromAgentId: 'a1' })
    patchMessage('t1', 'm1', { content: 'All **done** here' })
    patchMessage('t1', 'm1', { streaming: false })
    flushMessagePatches()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Phoenix', body: 'All done here', target: { kind: 'conversation', id: 't1' } }),
    )
  })

  it('notifies once per new approval request', () => {
    renderHook(() => useSystemNotifications({ linked: false, onOpenConversation: () => {} }))
    act(() => setPendingToolPermission({ id: 'p1', conversationId: 't1', sessionId: 's', description: 'Run npm install', choices: ['once', 'deny'], status: 'pending' }))
    act(() => setPendingToolPermission({ id: 'p1', conversationId: 't1', sessionId: 's', description: 'Run npm install', choices: ['once', 'deny'], status: 'pending' }))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Launch plan needs your OK', body: 'Run npm install' }))
    expect(readLocalNotifications()[0]).toMatchObject({ kind: 'approval', body: 'Run npm install' })
  })

  async function routineRun(output: string | null) {
    vi.useFakeTimers()
    listServeCronJobs
      .mockResolvedValueOnce([{ id: 'j1', name: 'Competitor news watch', last_run_at: null, deliver: 'local' }])
      .mockResolvedValueOnce([{ id: 'j1', name: 'Competitor news watch', last_run_at: '2026-10-02T00:28:00Z', deliver: 'local' }])
    listRoutineRuns.mockResolvedValue({ kind: 'ok', value: [{ id: 'run1', status: 'ok' }] })
    readRunOutput.mockResolvedValue(output)
    renderHook(() => useSystemNotifications({ linked: true, onOpenConversation: () => {} }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(notify).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000 + 10)
    })
  }

  it('a routine notification carries what it found, and lands in the bell', async () => {
    await routineRun('## Digest\n- **Zapier** cut Team pricing 20% ([source](https://x.y))')
    expect(readRunOutput).toHaveBeenCalledWith('run1')
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Routine: Competitor news watch',
        body: 'Digest - Zapier cut Team pricing 20% (source)',
        target: { kind: 'routines', id: 'j1' },
      }),
    )
    expect(readLocalNotifications()[0]).toMatchObject({ kind: 'routine', title: 'Routine: Competitor news watch', target: { kind: 'routines', id: 'j1' } })
  })

  it.each(['Nothing to report this time.', '[SILENT]', 'silent', 'no_reply', 'no reply', '[silent]', 'Saved report\n[SILENT]'])('a run with nothing to report stays quiet: %s', async (output) => {
    await routineRun(output)
    expect(notify).not.toHaveBeenCalled()
    expect(readLocalNotifications()).toEqual([])
  })
})
