import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeBridge, ChangeRecord, ChangeResult } from '../lib/self-modification'
import { ImproveHermesDesk } from './ImproveHermesDesk'

const record: ChangeRecord = {
  id: 'change-one', request: 'Make search clearer', acceptanceCriteria: 'Find saved chats.',
  createdAt: '2026-10-12T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z',
  cancellationEpoch: 0,
  attempts: [{ id: 'attempt-one', state: 'requested', epoch: 0,
    requestedAt: '2026-10-12T12:00:00.000Z', cancelledAt: null, statusAt: '2026-10-12T12:00:00.000Z',
    preparation: null, execution: null, validation: null }],
}
const success = (changes: ChangeRecord[], revision: number): ChangeResult => ({ ok: true, changes, revision })
let bridge: ChangeBridge
beforeEach(() => {
  bridge = {
    list: vi.fn(async () => success([], 0)),
    create: vi.fn(async () => success([record], 1)),
    cancel: vi.fn(async () => success([{ ...record, cancellationEpoch: 1,
      attempts: [{ ...record.attempts[0], state: 'cancelled', cancelledAt: '2026-10-12T12:01:00.000Z' }] }], 2)),
    reopen: vi.fn(async () => success([{ ...record, cancellationEpoch: 2,
      attempts: [{ ...record.attempts[0], state: 'cancelled', cancelledAt: '2026-10-12T12:01:00.000Z' },
        { ...record.attempts[0], id: 'attempt-two', epoch: 2 }] }], 3)),
    selectRepository: vi.fn(async () => ({ ok: true, selection: null } as const)),
    prepare: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture selection.' } as const)),
    review: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture workspace.' } as const)),
    implement: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture worker.' } as const)),
    validate: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture checks.' } as const)),
    preview: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture preview.' } as const)),
    authority: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture authority check.' } as const)),
    seal: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture seal.' } as const)),
    boundBuild: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture bound build.' } as const)),
    nativeInputs: vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'No fixture native inputs.' } as const)),
  }
  Object.assign(window, { nubAgent: { changes: bridge } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.nubAgent })

async function fill() {
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('0 saved requests'))
  fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: record.request } })
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: record.acceptanceCriteria } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function controlledPollInterval() {
  const schedule = window.setInterval.bind(window)
  // These tests drive ticks explicitly; wall-clock ticks must not also run.
  return vi.spyOn(window, 'setInterval').mockImplementation((handler, delay, ...args) => {
    const timer = schedule(delay === 500 ? () => {} : handler, delay, ...args)
    if (delay === 500) window.clearInterval(timer)
    // JSDOM returns a number; the ambient Node overload names it Timeout.
    return timer as unknown as ReturnType<typeof window.setInterval>
  })
}

describe('Improve Hermes Desk request and review shell', () => {
  it('saves a request only after acknowledgment and shows truthful evidence', async () => {
    const pending = deferred<ChangeResult>()
    vi.mocked(bridge.create).mockReturnValue(pending.promise)
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith(0, {
      request: record.request, acceptanceCriteria: record.acceptanceCriteria,
    })
    expect(screen.queryByRole('heading', { name: 'Request recorded' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(screen.getByLabelText('Requested change')).toBeDisabled()
    await act(async () => pending.resolve(success([record], 1)))
    expect(await screen.findByRole('heading', { name: 'Request recorded' })).toBeInTheDocument()
    const detail = screen.getByRole('region', { name: 'Change detail' })
    expect(within(detail).getByText('Not started. This is a saved request, not an executing job.')).toBeInTheDocument()
    expect(within(detail).getByText(/No changed files, candidate artifact, validation results, approval or activation exists/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve|install|activate|run agent|preview/i })).not.toBeInTheDocument()
    expect(bridge.cancel).not.toHaveBeenCalled()
    expect(bridge.reopen).not.toHaveBeenCalled()
  })

  it('cancels explicitly and reopens a new attempt with preserved history', async () => {
    vi.mocked(bridge.list).mockResolvedValue(success([record], 1))
    render(<ImproveHermesDesk open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }))
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(1, record.id, record.attempts[0].id)
    expect(await screen.findByRole('heading', { name: 'Cancelled request' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen request' }))
    expect(bridge.reopen).toHaveBeenCalledExactlyOnceWith(2, record.id, record.attempts[0].id)
    expect(await screen.findByText('Attempt 2')).toBeInTheDocument()
    expect(screen.getByText('Attempt 1: cancelled')).toBeInTheDocument()
    expect(screen.getByText('Attempt 2: requested')).toBeInTheDocument()
  })

  it('closing keeps requests, drafts and cancellation state; opening reloads from native storage', async () => {
    const onClose = vi.fn()
    const view = render(<ImproveHermesDesk open onClose={onClose} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<ImproveHermesDesk open={false} onClose={onClose} />)
    view.rerender(<ImproveHermesDesk open onClose={onClose} />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText('Requested change')).toHaveValue(record.request)
    expect(bridge.cancel).not.toHaveBeenCalled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('a fresh view recovers saved detail without a create or reopen operation', async () => {
    vi.mocked(bridge.list).mockResolvedValue(success([record], 7))
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    view.unmount()
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.reopen).not.toHaveBeenCalled()
  })

  it('ignores a stale load response after closing and reopening', async () => {
    const old = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockReturnValueOnce(old.promise).mockResolvedValue(success([record], 2))
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    await act(async () => old.resolve(success([], 0)))
    expect(screen.getByRole('heading', { name: 'Request recorded' })).toBeInTheDocument()
  })

  it('fences a save acknowledgment from a closed view and requires explicit reload', async () => {
    const old = deferred<ChangeResult>()
    vi.mocked(bridge.create).mockReturnValue(old.promise)
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
    await act(async () => old.resolve(success([record], 1)))
    expect(screen.getByRole('alert')).toHaveTextContent('Reload to review its saved outcome')
    expect(screen.queryByRole('heading', { name: 'Request recorded' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(screen.getByLabelText('Requested change')).toHaveValue(record.request)
    vi.mocked(bridge.list).mockResolvedValue(success([record], 1))
    fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }))
    await screen.findByRole('heading', { name: 'Request recorded' })
    expect(bridge.create).toHaveBeenCalledOnce()
  })

  it.each(['storage', 'stale', 'uncertain'] as const)('retains draft and blocks replay after %s failure', async code => {
    vi.mocked(bridge.create).mockResolvedValue({ ok: false, code, error: 'Reload required; existing records retained.' })
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload required')
    expect(screen.getByLabelText('Requested change')).toHaveValue(record.request)
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(screen.queryByRole('heading', { name: 'Request recorded' })).not.toBeInTheDocument()
    expect(bridge.create).toHaveBeenCalledOnce()
  })

  it('lost IPC acknowledgment never becomes success or automatic resubmission', async () => {
    vi.mocked(bridge.create).mockRejectedValue(new Error('IPC closed'))
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('save acknowledgment was lost')
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(bridge.create).toHaveBeenCalledOnce()
  })

  it('malformed storage is visible and never resets or enables actions', async () => {
    vi.mocked(bridge.list).mockResolvedValue({ ok: false, code: 'storage', error: 'Existing records retained. Storage is malformed.' })
    render(<ImproveHermesDesk open onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage is malformed')
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(screen.queryByText('No requests yet.')).not.toBeInTheDocument()
  })

  it('absence of the native bridge never falls back to browser persistence', async () => {
    delete window.nubAgent
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    render(<ImproveHermesDesk open onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not provide local change storage')
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('renders stored model-like markup as inert text', async () => {
    vi.mocked(bridge.list).mockResolvedValue(success([{ ...record, request: '<script>window.unapproved = true</script>' }], 1))
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    expect(screen.getByRole('region', { name: 'Change detail' }).querySelector('script')).toBeNull()
    expect(screen.getAllByText('<script>window.unapproved = true</script>')).toHaveLength(2)
  })

  it('uses required bounded fields and offers no state-editing or execution interface', async () => {
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    expect(screen.getByLabelText('Requested change')).toHaveAttribute('maxlength', '8000')
    expect(screen.getByLabelText('Acceptance criteria')).toHaveAttribute('maxlength', '4000')
    expect(screen.getByLabelText('Acceptance criteria')).toBeRequired()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('keeps an explicitly chosen draft through record navigation, manual reload and reopening', async () => {
    const other = { ...record, id: 'change-two', request: 'Keep keyboard focus' }
    vi.mocked(bridge.list).mockResolvedValue(success([record, other], 2))
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    const nav = screen.getByRole('navigation', { name: 'Saved change requests' })
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: 'Retain my unsaved draft' } })
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'No unintended navigation.' } })
    fireEvent.click(within(nav).getByRole('button', { name: /Make search clearer/ }))
    expect(screen.getByRole('region', { name: 'Change detail' })).toHaveTextContent(record.request)
    fireEvent.click(within(nav).getByRole('button', { name: /Keep keyboard focus/ }))
    expect(screen.getByRole('region', { name: 'Change detail' })).toHaveTextContent(other.request)
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Retain my unsaved draft')

    const reading = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockReturnValueOnce(reading.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Retain my unsaved draft')
    await act(async () => reading.resolve(success([record, other], 3)))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Retain my unsaved draft')
    expect(screen.getByLabelText('Acceptance criteria')).toHaveValue('No unintended navigation.')
    view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(3))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Retain my unsaved draft')
    expect(screen.getByRole('button', { name: 'Save request' })).toBeEnabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.cancel).not.toHaveBeenCalled()
    expect(bridge.reopen).not.toHaveBeenCalled()
  })

  it('does not replace a new draft when the initial storage reply arrives late', async () => {
    const reading = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockReturnValue(reading.promise)
    render(<ImproveHermesDesk open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: 'Draft before storage responds' } })
    await act(async () => reading.resolve(success([record], 1)))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Draft before storage responds')
    expect(screen.queryByRole('region', { name: 'Change detail' })).not.toBeInTheDocument()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'uncertain'] as const)('requires explicit reconciliation after reopening a %s save', async failure => {
    if (failure === 'rejected') vi.mocked(bridge.create).mockRejectedValue(new Error('IPC closed'))
    else vi.mocked(bridge.create).mockResolvedValue({ ok: false, code: 'uncertain', error: 'Save outcome unknown. Reload required.' })
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    const message = (await screen.findByRole('alert')).textContent
    // The reopen read cannot acknowledge whether this particular save completed.
    vi.mocked(bridge.list).mockResolvedValue(success([], 0))
    view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload requests' })).toBeEnabled())
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: 'Edited retained draft' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save request' }).closest('form')!)
    expect(bridge.create).toHaveBeenCalledOnce()

    vi.mocked(bridge.list).mockResolvedValue(success([record], 1))
    fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }))
    await screen.findByRole('heading', { name: 'Request recorded' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Edited retained draft')
    expect(screen.getByLabelText('Acceptance criteria')).toHaveValue(record.acceptanceCriteria)
    expect(bridge.create).toHaveBeenCalledOnce()
    expect(bridge.cancel).not.toHaveBeenCalled()
  })

  it('does not let a late reopen read clear an acknowledgment failure', async () => {
    const saving = deferred<ChangeResult>(), reading = deferred<ChangeResult>()
    vi.mocked(bridge.create).mockReturnValue(saving.promise)
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await fill()
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    vi.mocked(bridge.list).mockReturnValue(reading.promise)
    view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
    view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
    await act(async () => saving.reject(new Error('IPC closed')))
    await act(async () => reading.resolve(success([], 0)))
    expect(screen.getByRole('alert')).toHaveTextContent('save acknowledgment was lost')
    expect(screen.getByRole('button', { name: 'Save request' })).toBeDisabled()
    expect(screen.getByLabelText('Requested change')).toHaveValue(record.request)
    fireEvent.submit(screen.getByRole('button', { name: 'Save request' }).closest('form')!)
    expect(bridge.create).toHaveBeenCalledOnce()
  })

  it('keeps the selected record when a save finishes after navigation', async () => {
    const other = { ...record, id: 'change-two', request: 'Keep keyboard focus' }
    vi.mocked(bridge.list).mockResolvedValue(success([other], 1))
    const saving = deferred<ChangeResult>()
    vi.mocked(bridge.create).mockReturnValue(saving.promise)
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Request recorded' })
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: record.request } })
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: record.acceptanceCriteria } })
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: /Keep keyboard focus/ }))
    await act(async () => saving.resolve(success([other, record], 2)))
    expect(screen.getByRole('region', { name: 'Change detail' })).toHaveTextContent(other.request)
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: /Keep keyboard focus/ })).toHaveAttribute('aria-current', 'true')
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: /Make search clearer/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    expect(screen.getByLabelText('Requested change')).toHaveValue('')
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith(1, { request: record.request, acceptanceCriteria: record.acceptanceCriteria })
  })

  it('refreshes running status without disabling controls or replacing a newly selected draft', async () => {
    const interval = controlledPollInterval()
    const active = { ...record, attempts: [{ ...record.attempts[0], state: 'preparing' as const }] }
    vi.mocked(bridge.list).mockResolvedValueOnce(success([active], 1))
    const reading = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockReturnValueOnce(reading.promise)
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Preparing isolated source' })
    await waitFor(() => expect(typeof interval.mock.calls.find(([, delay]) => delay === 500)?.[0]).toBe('function'))
    const poll = interval.mock.calls.find(([, delay]) => delay === 500)?.[0]
    expect(typeof poll).toBe('function')
    act(() => { (poll as () => void)() })
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('1 saved request')
    // An outstanding poll is a read, not a reason to discard user navigation.
    fireEvent.click(screen.getByRole('button', { name: 'New request' }))
    fireEvent.change(screen.getByLabelText('Requested change'), { target: { value: 'Draft during background read' } })
    await act(async () => reading.resolve(success([record], 2)))
    expect(screen.getByLabelText('Requested change')).toHaveValue('Draft during background read')
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.cancel).not.toHaveBeenCalled()
  })

  it('fences a deferred poll behind an explicit mutation and prevents overlapping polls', async () => {
    const interval = controlledPollInterval()
    const active = { ...record, attempts: [{ ...record.attempts[0], state: 'preparing' as const }] }
    vi.mocked(bridge.list).mockResolvedValueOnce(success([active], 1))
    const reading = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockReturnValueOnce(reading.promise)
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Preparing isolated source' })
    await waitFor(() => expect(typeof interval.mock.calls.find(([, delay]) => delay === 500)?.[0]).toBe('function'))
    const poll = interval.mock.calls.find(([, delay]) => delay === 500)?.[0] as () => void
    act(() => { poll(); poll() })
    expect(bridge.list).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    await screen.findByRole('heading', { name: 'Cancelled request' })
    await act(async () => reading.resolve(success([active], 1)))
    expect(screen.getByRole('heading', { name: 'Cancelled request' })).toBeInTheDocument()
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith(1, record.id, record.attempts[0].id)
  })

  it('blocks journal actions after a poll failure until an explicit successful reload', async () => {
    const interval = controlledPollInterval()
    const active = { ...record, attempts: [{ ...record.attempts[0], state: 'preparing' as const }] }
    vi.mocked(bridge.list).mockResolvedValueOnce(success([active], 1))
    vi.mocked(bridge.list).mockRejectedValueOnce(new Error('IPC closed'))
    render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Preparing isolated source' })
    await waitFor(() => expect(typeof interval.mock.calls.find(([, delay]) => delay === 500)?.[0]).toBe('function'))
    const poll = interval.mock.calls.find(([, delay]) => delay === 500)?.[0] as () => void
    await act(async () => { poll() })
    expect(screen.getByRole('alert')).toHaveTextContent('storage could not be reached')
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Last loaded records shown. Reload required.')
    vi.mocked(bridge.list).mockResolvedValue(success([record], 2))
    fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }))
    await screen.findByRole('heading', { name: 'Request recorded' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled()
    expect(bridge.cancel).not.toHaveBeenCalled()
  })

  it.each([
    ['manual reload', 'resolved'],
    ['manual reload', 'rejected'],
    ['close/reopen', 'resolved'],
    ['close/reopen', 'rejected'],
  ] as const)('retains outstanding poll ownership through %s until its promise is %s', async (supersession, settlement) => {
    const interval = controlledPollInterval()
    const active = { ...record, attempts: [{ ...record.attempts[0], state: 'preparing' as const }] }
    const original = deferred<ChangeResult>(), next = deferred<ChangeResult>()
    vi.mocked(bridge.list).mockResolvedValueOnce(success([active], 1))
      .mockReturnValueOnce(original.promise).mockResolvedValue(success([active], 3))
    const view = render(<ImproveHermesDesk open onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Preparing isolated source' })
    const poll = async () => {
      await waitFor(() => expect(typeof interval.mock.calls.filter(([, delay]) => delay === 500).at(-1)?.[0]).toBe('function'))
      const callback = interval.mock.calls.filter(([, delay]) => delay === 500).at(-1)?.[0]
      expect(typeof callback).toBe('function')
      act(() => { (callback as () => void)(); (callback as () => void)() })
    }
    const supersede = async () => {
      if (supersession === 'manual reload') fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }))
      else {
        view.rerender(<ImproveHermesDesk open={false} onClose={() => {}} />)
        view.rerender(<ImproveHermesDesk open onClose={() => {}} />)
      }
      await waitFor(() => expect(screen.getByRole('button', { name: 'Reload requests' })).toBeEnabled())
    }
    await poll()
    expect(bridge.list).toHaveBeenCalledTimes(2)
    await supersede()
    expect(bridge.list).toHaveBeenCalledTimes(3)
    await poll()
    // Superseding the stale response does not settle its outstanding read.
    expect(bridge.list).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled()
    await supersede()
    await poll()
    expect(bridge.list).toHaveBeenCalledTimes(4)

    await act(async () => {
      if (settlement === 'resolved') original.resolve(success([], 0))
      else original.reject(new Error('Stale poll failed'))
    })
    expect(screen.getByRole('heading', { name: 'Preparing isolated source' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 saved request')
    vi.mocked(bridge.list).mockReturnValueOnce(next.promise)
    await poll()
    expect(bridge.list).toHaveBeenCalledTimes(5)
    await poll()
    expect(bridge.list).toHaveBeenCalledTimes(5)
    await act(async () => next.resolve(success([record], 4)))
    expect(screen.getByRole('heading', { name: 'Request recorded' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.cancel).not.toHaveBeenCalled()
  })
})
