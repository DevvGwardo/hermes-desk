import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/hermes-rest', () => ({
  serveGetDetailed: (...args: unknown[]) => mocks.get(...args),
}))
vi.mock('../MessageBody', () => ({ MessageBody: ({ content }: { content: string }) => <div>{content}</div> }))
import { RoutineRunsReader, RESULTS_POLL_MS, RUN_STALE_MS, shownStatus } from '../RoutineHistory'

const done = { id: 'run-a', started_at: 1790987280, ended_at: 1790987340, end_reason: 'cron_complete', is_active: false }
const messages = (text: string) => ({ data: { messages: [{ role: 'assistant', content: text }] }, status: 200 })
function route(runs: unknown[], output: (id: string) => unknown) {
  mocks.get.mockImplementation(async (path: string) =>
    String(path).includes('/runs') ? { data: { runs }, status: 200 } : output(String(path).split('/')[3]!),
  )
}
beforeEach(() => { mocks.get.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('RoutineRunsReader', () => {
  it('keeps a report with a SILENT suffix but marks it Not sent', async () => {
    route([done], () => messages('Report\n[SILENT]'))
    render(<RoutineRunsReader jobId="j1" />)
    expect(await screen.findByText('Report')).toBeTruthy()
    expect(screen.getByText('Not sent')).toBeTruthy()
  })

  it('does not treat a marker inside a sentence as silence', async () => {
    route([done], () => messages('Use [SILENT] when idle'))
    render(<RoutineRunsReader jobId="j1" />)
    expect(await screen.findByText('Use [SILENT] when idle')).toBeTruthy()
    expect(screen.queryByText('Not sent')).toBeNull()
  })

  it('offers Retry when the results request throws, then recovers', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline'))
    render(<RoutineRunsReader jobId="j1" />)
    expect(await screen.findByText(/Couldn’t load results/)).toBeTruthy()
    route([done], () => messages('Back again'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Back again')).toBeTruthy()
  })

  it('ignores a previous routine’s slow results', async () => {
    let release!: () => void
    mocks.get.mockImplementation(async (path: string) => {
      if (String(path).includes('/jobs/old/')) {
        await new Promise<void>((r) => (release = r))
        return { data: { runs: [{ ...done, id: 'old-run' }] }, status: 200 }
      }
      return String(path).includes('/runs') ? { data: { runs: [] }, status: 200 } : messages('')
    })
    const view = render(<RoutineRunsReader jobId="old" />)
    view.rerender(<RoutineRunsReader jobId="new" />)
    expect(await screen.findByText(/hasn’t run yet/)).toBeTruthy()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('routine-run-old-run')).toBeNull()
  })

  it.each(['rows', 'error'] as const)('ignores stale %s after switching away and back to a routine', async (result) => {
    let release!: (value: unknown) => void
    let reads = 0
    mocks.get.mockImplementation((path: string) => {
      if (path.includes('/jobs/old/')) {
        if (++reads === 1) return new Promise(resolve => { release = resolve })
        return Promise.resolve({ data: { runs: [{ ...done, id: 'fresh-run' }] }, status: 200 })
      }
      return Promise.resolve(path.includes('/runs') ? { data: { runs: [] }, status: 200 } : messages('Fresh report'))
    })
    const view = render(<RoutineRunsReader jobId="old" />)
    view.rerender(<RoutineRunsReader jobId="new" />)
    await screen.findByText(/hasn’t run yet/)
    view.rerender(<RoutineRunsReader jobId="old" />)
    await screen.findByText('Fresh report')
    await act(async () => {
      release(result === 'rows'
        ? { data: { runs: [{ ...done, id: 'stale-run' }] }, status: 200 }
        : { data: null, status: 503 })
    })
    expect(screen.queryByTestId('routine-run-fresh-run')).not.toBeNull()
    expect(screen.queryByTestId('routine-run-stale-run')).toBeNull()
    expect(screen.queryByText(/Couldn’t load results/)).toBeNull()
  })

  it('a run in an agent profile reads as done and loads its output from that profile', async () => {
    const profileRun = { id: 'cron_j9_1', started_at: 1790987280, ended_at: 1790987280, end_reason: 'agent_close', profile: 'coderbob' }
    mocks.get.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.includes('/runs')) return { data: { runs: [profileRun] }, status: 200 }
      return p.includes('profile=coderbob') ? messages('Two new PRs.') : { data: null, status: 404 }
    })
    render(<RoutineRunsReader jobId="j9" />)
    expect(await screen.findByText('Two new PRs.')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Runs' })
    expect(within(list).getByText('Done')).toBeTruthy()
    // A row closed as it was written has no real length: no "0s".
    expect(within(list).queryByText('0s')).toBeNull()
  })

  it('an orphaned run reads as not finished and does not lock Run now', async () => {
    const startedAt = (Date.now() - RUN_STALE_MS - 60_000) / 1000
    route([{ id: 'stuck', started_at: startedAt, is_active: true }], () => messages(''))
    render(<RoutineRunsReader jobId="j1" onRunNow={async () => {}} />)
    const list = await screen.findByRole('list', { name: 'Runs' })
    expect(within(list).getByText('Didn’t finish')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(false))
    expect(shownStatus({ id: 'x', startedAt: Date.now(), endedAt: null, status: 'running', endReason: '' })).toBe('running')
  })
})

describe('routine history paging', () => {
  const page = (n: number) => ({
    runs: Array.from({ length: n }, (_, i) => ({
      id: `run-${i}`,
      started_at: 1790987280 - i * 3600,
      ended_at: 1790987340 - i * 3600,
      end_reason: 'cron_complete',
      is_active: false,
    })),
  })

  it('offers older runs only when the page came back full, and reads a bigger page', async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.includes('/runs')
        ? { data: page(path.includes('limit=2') ? 2 : 3), status: 200 }
        : messages('Synthetic paging report'))
    render(<RoutineRunsReader jobId="job-a" limit={2} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show older runs' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem')).toHaveLength(3))
    const reads = mocks.get.mock.calls.filter(([path]) => String(path).includes('/runs'))
    expect(String(reads[1]?.[0])).toContain('limit=4')
    // 3 < 4: the end of the history, no more button.
    expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull()
  })

  it('has no button when the first page is short', async () => {
    route([done], () => messages('Report'))
    render(<RoutineRunsReader jobId="job-a" />)
    await screen.findByRole('list', { name: 'Runs' })
    expect(screen.queryByRole('button', { name: 'Show older runs' })).toBeNull()
  })

  it('does not let a slow background poll discard a newer page or its selected output', async () => {
    vi.useFakeTimers()
    const recent = {
      ...page(2).runs[0], started_at: Date.now() / 1000,
      ended_at: null, end_reason: '', is_active: true,
    }
    const first = { runs: [recent, page(2).runs[1]] }
    const expanded = { runs: [recent, ...page(4).runs.slice(1)] }
    let release!: (value: unknown) => void
    let reads = 0
    mocks.get.mockImplementation((path: string) => {
      if (!path.includes('/runs')) return Promise.resolve(messages(`Output ${path.split('/')[3]}`))
      if (++reads === 2) return new Promise(resolve => { release = resolve })
      return Promise.resolve({ data: reads === 1 ? first : expanded, status: 200 })
    })
    render(<RoutineRunsReader jobId="job-a" limit={2} />)
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(RESULTS_POLL_MS) })
    expect(reads).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Show older runs' }))
    await act(async () => {})
    fireEvent.click(screen.getByTestId('routine-run-run-3'))
    await act(async () => {})
    expect(screen.getByText('Output run-3')).toBeTruthy()
    await act(async () => release({ data: first, status: 200 }))
    expect(screen.queryByTestId('routine-run-run-3')).not.toBeNull()
    expect(screen.queryByText('Output run-3')).not.toBeNull()
  })

  it('accepts a completed poll while a later poll is still pending', async () => {
    vi.useFakeTimers()
    const running = { ...done, started_at: Date.now() / 1000, ended_at: null, is_active: true }
    let release!: (value: unknown) => void
    let reads = 0
    mocks.get.mockImplementation((path: string) => {
      if (!path.includes('/runs')) return Promise.resolve(messages('Completed report'))
      if (++reads === 1) return Promise.resolve({ data: { runs: [running] }, status: 200 })
      return new Promise(resolve => { if (reads === 2) release = resolve })
    })
    render(<RoutineRunsReader jobId="job-a" />)
    await act(async () => {})
    await act(async () => { vi.advanceTimersByTime(2 * RESULTS_POLL_MS) })
    expect(reads).toBe(3)
    await act(async () => release({ data: { runs: [{ ...done, started_at: running.started_at }] }, status: 200 }))
    expect(screen.queryByText('Completed report')).not.toBeNull()
  })
})
