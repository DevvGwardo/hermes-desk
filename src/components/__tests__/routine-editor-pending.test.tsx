import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

const fake = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('../../lib/hermes-rest', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/hermes-rest')>(),
  serveGetDetailed: fake.get, serveSend: fake.send,
}))

import { RoutineEditor } from '../RoutineEditor'
import type { Routine } from '../../lib/routines'

const job: Routine = {
  id: 'synthetic-pending-routine', name: 'Synthetic routine', prompt: 'Synthetic instruction.',
  schedule: '0 8 * * *', origin: 'remote', enabled: true,
}
const pendingCleanup: (() => void)[] = []
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}
function editor() {
  const onSave = vi.fn<Parameters<typeof RoutineEditor>[0]['onSave']>().mockResolvedValue(job)
  const onDelete = vi.fn<NonNullable<Parameters<typeof RoutineEditor>[0]['onDelete']>>().mockResolvedValue(undefined)
  const onTestRun = vi.fn<NonNullable<Parameters<typeof RoutineEditor>[0]['onTestRun']>>().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const view = render(<RoutineEditor open initial={job} agents={[]} onSave={onSave}
    onDelete={onDelete} onTestRun={onTestRun} onClose={onClose} />)
  return { ...view, onSave, onDelete, onTestRun, onClose }
}
const button = (name: string) => screen.getByRole('button', { name })
const instruction = () => screen.getByLabelText('Instruction') as HTMLTextAreaElement

beforeEach(() => {
  fake.get.mockReset().mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/delivery-targets')
      ? { data: { targets: [{ id: 'discord', home_target_set: true }] }, status: 200 }
      : { data: { runs: [] }, status: 200 })
  fake.send.mockReset()
})
afterEach(async () => {
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  cleanup()
})

describe('RoutineEditor pending action isolation', () => {
  it.each(['Delete', 'Yes, delete it'])('uses the shared contrast-tested danger pair for %s', name => {
    editor()
    if (name === 'Yes, delete it') fireEvent.click(button('Delete'))
    expect(button(name)).toHaveClass('desk-button')
    expect(button(name)).toHaveAttribute('data-variant', 'danger')
    expect(button(name)).toHaveAttribute('data-size', 'sm')
  })

  it.each(['Save', 'Delete'])('blocks %s while a Run is pending', async name => {
    const view = editor()
    const run = deferred<void>(undefined)
    view.onTestRun.mockReturnValueOnce(run.promise)
    fireEvent.click(button('Run now'))
    expect(button(name)).toBeDisabled()
    fireEvent.click(button(name))
    expect(view.onSave).not.toHaveBeenCalled()
    expect(view.onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull()
    expect(button('Cancel')).toBeEnabled()
    expect(button('Close')).toBeEnabled()
  })

  it.each(['save', 'save-run', 'delete'] as const)('freezes draft controls during %s without blocking cancellation', async kind => {
    const view = editor()
    const work = deferred<Routine | void>(undefined)
    await screen.findByLabelText('Send results to')
    if (kind === 'delete') {
      view.onDelete.mockReturnValueOnce(work.promise as Promise<void>)
      fireEvent.click(button('Delete')); fireEvent.click(button('Yes, delete it'))
    } else {
      view.onSave.mockReturnValueOnce(work.promise)
      if (kind === 'save-run') fireEvent.change(instruction(), { target: { value: 'Synthetic revised instruction.' } })
      fireEvent.click(button(kind === 'save-run' ? 'Save & run now' : 'Save'))
    }
    for (const label of ['Name', 'Instruction', 'Frequency', 'Send results to'])
      expect(screen.getByLabelText(label)).toBeDisabled()
    const active = screen.getByRole('switch', { name: 'Active' })
    expect(active).toHaveAttribute('aria-disabled', 'true')
    expect(active).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(active)
    expect(active).toHaveAttribute('aria-checked', 'true')
    expect(button('Cancel')).toBeEnabled()
    expect(button('Close')).toBeEnabled()
  })

  it.each(['Save', 'Run now', 'Yes, delete it'])('sends one %s request before the busy state paints', async name => {
    const view = editor()
    const work = deferred<void>(undefined)
    view.onSave.mockReturnValueOnce(work.promise)
    view.onTestRun.mockReturnValueOnce(work.promise)
    view.onDelete.mockReturnValueOnce(work.promise)
    if (name === 'Yes, delete it') fireEvent.click(button('Delete'))
    const target = button(name)
    act(() => { fireEvent.click(target); fireEvent.click(target) })
    const handler = name === 'Save' ? view.onSave : name === 'Run now' ? view.onTestRun : view.onDelete
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not dispatch Run alongside a Save in the same event batch', () => {
    const view = editor()
    const save = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    const commit = button('Save'), run = button('Run now')
    act(() => { fireEvent.click(commit); fireEvent.click(run) })
    expect(view.onSave).toHaveBeenCalledOnce()
    expect(view.onTestRun).not.toHaveBeenCalled()
  })

  it('keeps Save & run controls locked through both stages and preserves the exact submitted draft', async () => {
    const view = editor()
    const save = deferred<Routine | void>(undefined), run = deferred<void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    view.onTestRun.mockReturnValueOnce(run.promise)
    await screen.findByLabelText('Send results to')
    fireEvent.change(instruction(), { target: { value: 'Synthetic revised instruction.' } })
    fireEvent.change(screen.getByLabelText('Send results to'), { target: { value: 'discord' } })
    fireEvent.click(button('Save & run now'))
    expect(button('Save')).toBeDisabled()
    expect(instruction()).toBeDisabled()
    const draft = view.onSave.mock.calls[0][0]
    await act(async () => { save.resolve({ ...job, ...draft, enabled: true }) })
    expect(view.onTestRun).toHaveBeenCalledWith(draft)
    expect(button('Save')).toBeDisabled()
    expect(button('Delete')).toBeDisabled()
    expect(instruction()).toBeDisabled()
    await act(async () => { run.resolve() })
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(instruction()).toBeEnabled()
    expect(instruction().value).toBe(draft.prompt)
    expect((screen.getByLabelText('Send results to') as HTMLSelectElement).value).toBe('discord')
    expect(button('Save')).toBeEnabled()
  })

  it('releases the action after failure and retains the draft for explicit retry', async () => {
    const view = editor()
    const save = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    fireEvent.change(instruction(), { target: { value: 'Synthetic revised instruction.' } })
    fireEvent.click(button('Save & run now'))
    expect(instruction()).toBeDisabled()
    await act(async () => { save.reject(new Error('Synthetic current save failure')) })
    expect(await screen.findByText('Synthetic current save failure')).toBeTruthy()
    expect(instruction()).toBeEnabled()
    expect(instruction().value).toBe('Synthetic revised instruction.')
    fireEvent.click(button('Save & run now'))
    await waitFor(() => expect(view.onTestRun).toHaveBeenCalledOnce())
    expect(view.onSave).toHaveBeenCalledTimes(2)
  })

  it.each(['Save', 'Run now', 'Yes, delete it'])('allows an explicit retry after %s fails', async name => {
    const view = editor()
    const work = deferred<void>(undefined)
    const handler = name === 'Save' ? view.onSave : name === 'Run now' ? view.onTestRun : view.onDelete
    handler.mockReturnValueOnce(work.promise)
    if (name === 'Yes, delete it') fireEvent.click(button('Delete'))
    fireEvent.click(button(name))
    await act(async () => { work.reject(new Error('Synthetic current action failure')) })
    expect(await screen.findByText('Synthetic current action failure')).toBeTruthy()
    expect(instruction()).toBeEnabled()
    expect(button(name)).toBeEnabled()
    fireEvent.click(button(name))
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
  })

  it('holds the editor action while Run is started from Results', async () => {
    const view = editor()
    const run = deferred<void>(undefined)
    view.onTestRun.mockReturnValueOnce(run.promise)
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeDisabled()
    expect(button('Close')).toBeEnabled()
    await act(async () => { run.resolve() })
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(button('Save')).toBeEnabled()
    expect(view.onTestRun).toHaveBeenCalledOnce()
  })

  it('keeps a Results Run failure visible and recoverable', async () => {
    const view = editor()
    view.onTestRun.mockRejectedValueOnce(new Error('Synthetic current run failure'))
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    expect(await screen.findByText('Synthetic current run failure')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeEnabled()
    expect(button('Run now')).toBeEnabled()
    fireEvent.click(button('Run now'))
    await waitFor(() => expect(view.onTestRun).toHaveBeenCalledTimes(2))
  })
})
