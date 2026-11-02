import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('../../lib/hermes-rest', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/hermes-rest')>(),
  serveGetDetailed: fake.get,
  serveSend: fake.send,
}))

import { RoutineEditor } from '../RoutineEditor'
import type { Routine } from '../../lib/routines'

const a: Routine = {
  id: 'fixture-routine-a', name: 'Synthetic A', prompt: 'Synthetic instruction A.',
  schedule: '0 8 * * *', origin: 'remote', enabled: true,
}
const b: Routine = { ...a, id: 'fixture-routine-b', name: 'Synthetic B', prompt: 'Synthetic instruction B.' }
const targets = { targets: [{ id: 'discord', home_target_set: true }] }
const pendingCleanup: (() => void)[] = []

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}
function editor() {
  const onSave = vi.fn<Parameters<typeof RoutineEditor>[0]['onSave']>().mockResolvedValue(undefined)
  const onDelete = vi.fn<NonNullable<Parameters<typeof RoutineEditor>[0]['onDelete']>>().mockResolvedValue(undefined)
  const onTestRun = vi.fn<NonNullable<Parameters<typeof RoutineEditor>[0]['onTestRun']>>().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const onTemplateCreated = vi.fn()
  const props = { agents: [], onSave, onDelete, onTestRun, onClose, onTemplateCreated }
  const view = render(<RoutineEditor open initial={a} {...props} />)
  const replace = (initial: Routine | null = b) => view.rerender(<RoutineEditor open initial={initial} {...props} />)
  const reopen = (initial = a) => {
    view.rerender(<RoutineEditor open={false} initial={a} {...props} />)
    replace(initial)
  }
  return { ...view, ...props, replace, reopen }
}
const instruction = () => screen.getByLabelText('Instruction') as HTMLTextAreaElement

beforeEach(() => {
  fake.get.mockReset().mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/delivery-targets')
      ? { data: targets, status: 200 }
      : { data: { runs: [] }, status: 200 })
  fake.send.mockReset()
})
afterEach(async () => {
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
  cleanup()
})

describe('RoutineEditor opening lifetime', () => {
  it('loads only the explicitly selected profile when a new routine opens', async () => {
    render(<RoutineEditor open agents={[]} defaultAgentId="profile:beta"
      onClose={() => {}} onSave={vi.fn().mockResolvedValue(undefined)} />)
    await screen.findByLabelText('Send results to')
    const requests = fake.get.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith('/api/cron/delivery-targets'))
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(path => path === '/api/cron/delivery-targets?profile=beta')).toBe(true)
  })
  it.each(['replace', 'reopen', 'unmount'] as const)('does not close a newer opening after an old Save finishes (%s)', async visit => {
    const view = editor()
    const save = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(view.onSave).toHaveBeenCalledOnce()
    if (visit === 'unmount') view.unmount()
    else if (visit === 'reopen') view.reopen()
    else view.replace()
    await act(async () => { save.resolve(a) })
    expect(view.onClose).not.toHaveBeenCalled()
    if (visit !== 'unmount') expect(instruction().value).toBe(visit === 'reopen' ? a.prompt : b.prompt)
  })

  it.each(['resolve', 'reject'] as const)('keeps the new Save busy when an old Save settles with %s', async outcome => {
    const view = editor()
    const old = deferred<Routine | void>(undefined), current = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    view.replace()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => {
      if (outcome === 'reject') old.reject(new Error('Synthetic obsolete save failure'))
      else old.resolve(a)
    })
    expect(screen.queryByText('Synthetic obsolete save failure')).toBeNull()
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.onClose).not.toHaveBeenCalled()
    await act(async () => { current.resolve(b) })
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(view.onSave.mock.calls[1][1]).toBe(b)
  })

  it.each(['resolve', 'reject'] as const)('does not close or show an old Delete result in a different routine (%s)', async outcome => {
    const view = editor()
    const deletion = deferred<void>(undefined)
    view.onDelete.mockReturnValueOnce(deletion.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }))
    expect(view.onDelete).toHaveBeenCalledWith(a)
    view.replace()
    await act(async () => {
      if (outcome === 'reject') deletion.reject(new Error('Synthetic obsolete delete failure'))
      else deletion.resolve()
    })
    expect(view.onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Synthetic obsolete delete failure')).toBeNull()
    expect(instruction().value).toBe(b.prompt)
  })

  it.each(['resolve', 'reject'] as const)('does not switch a different routine to an old Run result (%s)', async outcome => {
    const view = editor()
    const run = deferred<void>(undefined)
    view.onTestRun.mockReturnValueOnce(run.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    view.replace()
    await act(async () => {
      if (outcome === 'reject') run.reject(new Error('Synthetic obsolete run failure'))
      else run.resolve()
    })
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('Synthetic obsolete run failure')).toBeNull()
    expect(instruction().value).toBe(b.prompt)
  })

  it.each(['resolve', 'reject'] as const)('keeps a new Results opening independent of the old Results Run (%s)', async outcome => {
    const view = editor()
    const old = deferred<void>(undefined), current = deferred<void>(undefined)
    view.onTestRun.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    view.replace({ ...b, lastRunAt: '2026-10-07T05:00:00Z' })
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    expect(view.onTestRun).toHaveBeenCalledTimes(2)
    await act(async () => {
      if (outcome === 'reject') old.reject(new Error('Synthetic obsolete Results failure'))
      else old.resolve()
    })
    expect(screen.queryByText('Synthetic obsolete Results failure')).toBeNull()
    expect(screen.queryByText(/Started\. It shows up/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { current.reject(new Error('Synthetic current Results failure')) })
    expect((await screen.findByRole('alert')).textContent).toContain('Synthetic current Results failure')
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each(['replace', 'reopen', 'unmount'] as const)('does not dispatch Run after a saved editor loses its opening (%s)', async visit => {
    const view = editor()
    const save = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    fireEvent.change(instruction(), { target: { value: 'Synthetic revised instruction.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & run now' }))
    expect(view.onSave).toHaveBeenCalledOnce()
    if (visit === 'unmount') view.unmount()
    else if (visit === 'reopen') view.reopen()
    else view.replace()
    await act(async () => { save.resolve(a) })
    expect(view.onTestRun).not.toHaveBeenCalled()
    if (visit !== 'unmount') expect(instruction().value).toBe(visit === 'reopen' ? a.prompt : b.prompt)
  })

  it.each(['Cancel', 'Close', 'Escape'] as const)('invalidates Save & run immediately when dismissed using %s', async method => {
    const view = editor()
    const save = deferred<Routine | void>(undefined)
    view.onSave.mockReturnValueOnce(save.promise)
    fireEvent.change(instruction(), { target: { value: 'Synthetic revised instruction.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & run now' }))
    if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: method }))
    expect(view.onClose).toHaveBeenCalledOnce()
    await act(async () => { save.resolve(a) })
    expect(view.onTestRun).not.toHaveBeenCalled()
    expect(view.onClose).toHaveBeenCalledOnce()
  })

  it('keeps current-opening save failure recoverable and closes only on a successful retry', async () => {
    const view = editor()
    view.onSave.mockRejectedValueOnce(new Error('Synthetic current save failure'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Synthetic current save failure')).toBeTruthy()
    expect(instruction().value).toBe(a.prompt)
    expect(view.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce())
    expect(view.onSave).toHaveBeenCalledTimes(2)
  })

  it('does not replace current delivery options with an older opening response', async () => {
    const response = deferred<{ data: null; status: number }>({ data: null, status: 503 })
    fake.get.mockReturnValueOnce(response.promise)
    const view = editor()
    view.replace()
    const select = await screen.findByLabelText('Send results to') as HTMLSelectElement
    expect([...select.options].some(option => option.value === 'discord')).toBe(true)
    await act(async () => { response.resolve({ data: null, status: 503 }) })
    expect(screen.getByLabelText('Send results to')).toBe(select)
    expect(select.disabled).toBe(false)
  })

  it('refreshes an issued template creation without closing a different routine', async () => {
    fake.get.mockImplementation(async (path: string) =>
      path.startsWith('/api/cron/blueprints')
        ? { data: { blueprints: [{ key: 'synthetic-template', title: 'Synthetic template', description: '', fields: [] }] }, status: 200 }
        : { data: targets, status: 200 })
    const response = deferred({ ok: true, data: { id: 'synthetic-created' } })
    fake.send.mockReturnValueOnce(response.promise)
    const view = editor()
    view.replace(null)
    fireEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic template' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    expect(fake.send).toHaveBeenCalledWith('POST', '/api/cron/blueprints/instantiate?profile=default', {
      blueprint: 'synthetic-template', values: {},
    })
    view.replace(b)
    await act(async () => { response.resolve({ ok: true, data: { id: 'synthetic-created' } }) })
    expect(view.onTemplateCreated).toHaveBeenCalledOnce()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(instruction().value).toBe(b.prompt)
  })

  it.each(['Cancel', 'Escape'] as const)('asks before %s discards unsaved edits', method => {
    const view = editor()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      fireEvent.change(instruction(), { target: { value: 'Synthetic unsaved instruction.' } })
      const dismiss = () => method === 'Escape'
        ? fireEvent.keyDown(window, { key: 'Escape' })
        : fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      dismiss()
      expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?')
      expect(view.onClose).not.toHaveBeenCalled()
      expect(instruction().value).toBe('Synthetic unsaved instruction.')
      confirm.mockReturnValue(true)
      dismiss()
      expect(view.onClose).toHaveBeenCalledOnce()
    } finally {
      confirm.mockRestore()
    }
  })

  it('closes an untouched editor without asking', () => {
    const view = editor()
    const confirm = vi.spyOn(window, 'confirm')
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(confirm).not.toHaveBeenCalled()
      expect(view.onClose).toHaveBeenCalledOnce()
    } finally {
      confirm.mockRestore()
    }
  })
})
