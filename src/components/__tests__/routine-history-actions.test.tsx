import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

const fake = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/hermes-rest', () => ({
  serveGetDetailed: (...args: unknown[]) => fake.get(...args),
}))
vi.mock('../MessageBody', () => ({ MessageBody: ({ content }: { content: string }) => <div>{content}</div> }))

import { RoutineRunsReader } from '../RoutineHistory'

const pendingCleanup: (() => void)[] = []
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(resolve)
  return { promise, resolve, reject }
}
function reader() {
  const onRunNow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const view = render(<RoutineRunsReader jobId="synthetic-routine-a" onRunNow={onRunNow} />)
  const replace = (jobId = 'synthetic-routine-b') =>
    view.rerender(<RoutineRunsReader jobId={jobId} onRunNow={onRunNow} />)
  return { ...view, onRunNow, replace }
}
const runButton = () => screen.getByRole('button', { name: 'Run now' })
const start = async () => fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
const reads = (jobId: string) => fake.get.mock.calls.filter(([path]) => String(path).includes(`/jobs/${jobId}/runs`))

beforeEach(() => {
  fake.get.mockReset().mockResolvedValue({ data: { runs: [] }, status: 200 })
})
afterEach(async () => {
  cleanup()
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  vi.restoreAllMocks()
})

describe('RoutineRunsReader Run action lifetime', () => {
  it('sends one request when Run is clicked twice before the pending state paints', async () => {
    const view = reader()
    const run = deferred()
    view.onRunNow.mockReturnValueOnce(run.promise)
    const button = await screen.findByRole('button', { name: 'Run now' })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(view.onRunNow).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })

  it.each(['resolve', 'reject'] as const)('does not block a different routine while an old Run is pending (%s)', async outcome => {
    const view = reader()
    const run = deferred()
    view.onRunNow.mockReturnValueOnce(run.promise)
    await start()
    view.replace()
    await screen.findByText(/hasn’t run yet/)
    expect(runButton()).toBeEnabled()
    await act(async () => {
      if (outcome === 'reject') run.reject(new Error('Synthetic obsolete Run failure'))
      else run.resolve()
    })
    expect(runButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Started\. It shows up/)).toBeNull()
  })

  it.each(['replace', 'return', 'unmount'] as const)('does not read the old routine or show Started after stale Run success (%s)', async visit => {
    const view = reader()
    const run = deferred()
    view.onRunNow.mockReturnValueOnce(run.promise)
    await start()
    const before = reads('synthetic-routine-a').length
    if (visit === 'unmount') view.unmount()
    else {
      view.replace()
      await screen.findByText(/hasn’t run yet/)
      if (visit === 'return') {
        view.replace('synthetic-routine-a')
        await screen.findByText(/hasn’t run yet/)
      }
    }
    const currentReads = reads('synthetic-routine-a').length
    expect(currentReads).toBe(visit === 'return' ? before + 1 : before)
    await act(async () => { run.resolve() })
    expect(reads('synthetic-routine-a')).toHaveLength(currentReads)
    if (visit !== 'unmount') {
      expect(screen.queryByText(/Started\. It shows up/)).toBeNull()
      expect(runButton()).toBeEnabled()
    }
  })

  it.each(['resolve', 'reject'] as const)('does not release a newer pending Run when the old Run settles (%s)', async outcome => {
    const view = reader()
    const old = deferred(), current = deferred()
    view.onRunNow.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await start()
    view.replace()
    await screen.findByText(/hasn’t run yet/)
    await start()
    expect(view.onRunNow).toHaveBeenCalledTimes(2)
    await act(async () => {
      if (outcome === 'reject') old.reject(new Error('Synthetic obsolete Run failure'))
      else old.resolve()
    })
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Started\. It shows up/)).toBeNull()
    await act(async () => { current.reject(new Error('Synthetic current Run failure')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic current Run failure')
    expect(runButton()).toBeEnabled()
  })

  it('clears the previous routine’s Run failure on replacement', async () => {
    const view = reader()
    view.onRunNow.mockRejectedValueOnce(new Error('Synthetic old Run failure'))
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic old Run failure')
    view.replace()
    await screen.findByText(/hasn’t run yet/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(runButton()).toBeEnabled()
  })

  it('does not carry Started status from a successful Run into a different routine', async () => {
    const view = reader()
    await start()
    await screen.findByText(/Started\. It shows up/)
    view.replace()
    await screen.findByText(/hasn’t run yet/)
    expect(screen.queryByText(/Started\. It shows up/)).toBeNull()
    expect(runButton()).toBeEnabled()
  })

  it('retains current failure recovery and confirms a successful explicit retry', async () => {
    const view = reader()
    view.onRunNow.mockRejectedValueOnce(new Error('Synthetic current Run failure'))
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic current Run failure')
    expect(runButton()).toBeEnabled()
    fireEvent.click(runButton())
    await screen.findByText(/Started\. It shows up/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(view.onRunNow).toHaveBeenCalledTimes(2)
  })

  it('keeps the current action owned when only the page limit changes', async () => {
    const view = reader()
    const run = deferred()
    view.onRunNow.mockReturnValueOnce(run.promise)
    await start()
    view.rerender(<RoutineRunsReader jobId="synthetic-routine-a" limit={40} onRunNow={view.onRunNow} />)
    await screen.findByText(/hasn’t run yet/)
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    await act(async () => { run.resolve() })
    expect(await screen.findByText(/Started\. It shows up/)).toBeTruthy()
    expect(String(reads('synthetic-routine-a').at(-1)?.[0])).toContain('limit=40')
    await waitFor(() => expect(view.onRunNow).toHaveBeenCalledOnce())
  })
})
