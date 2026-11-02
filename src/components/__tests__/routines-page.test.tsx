/**
 * Routines main view: Active / Paused groups, row → editor, the pause
 * switch, Run now, and the template empty state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RoutinesPage } from '../RoutinesPage'
import type { Routine } from '../../lib/routines'

vi.mock('../../lib/hermes-rest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/hermes-rest')>()),
  serveGetDetailed: vi.fn(async (path: string) =>
    path === '/api/cron/blueprints'
      ? { data: { blueprints: [{ key: 'morning-brief', title: 'Morning briefing', fields: [] }] }, status: 200 }
      : { data: null, status: 404 },
  ),
}))

afterEach(() => cleanup())

const news: Routine = {
  id: 'r1',
  name: 'Competitor news watch',
  prompt: 'Check the news',
  schedule: '28 20 * * 1-5',
  enabled: true,
  origin: 'remote',
  deliver: 'local',
  lastRunAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
}
const digest: Routine = {
  id: 'r2',
  name: 'Weekly digest',
  prompt: 'Summarize',
  schedule: '0 9 * * 1',
  enabled: false,
  origin: 'remote',
  deliver: 'telegram',
}

function renderPage(extra: Partial<Parameters<typeof RoutinesPage>[0]> = {}) {
  const props = {
    routines: [news, digest],
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onToggle: vi.fn(async () => {}),
    onRunNow: vi.fn(async () => {}),
    ...extra,
  }
  const view = render(<RoutinesPage {...props} />)
  // Existing callers read the handlers off the result; new ones rerender.
  return Object.assign(props, { props, rerender: view.rerender, unmount: view.unmount })
}

describe('RoutinesPage', () => {
  it('groups rows into Active and Paused with schedule and destination', () => {
    renderPage()
    const active = screen.getByRole('region', { name: 'Active' })
    const paused = screen.getByRole('region', { name: 'Paused' })
    expect(within(active).getByText('Competitor news watch')).toBeTruthy()
    expect(within(active).getByText('Weekdays at 8:28 PM · In Nub Agent')).toBeTruthy()
    expect(within(active).getByText(/Last ran 2 h ago/)).toBeTruthy()
    expect(within(paused).getByText('Weekly digest')).toBeTruthy()
    expect(within(paused).getByText(/· To Telegram/)).toBeTruthy()
  })

  it('opens the editor on row click and creates from the header', () => {
    const props = renderPage()
    fireEvent.click(screen.getByText('Competitor news watch'))
    expect(props.onOpen).toHaveBeenCalledWith(news)
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }))
    expect(props.onCreate).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Back to chat/ }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('keeps keyboard focus on the switch while it pauses and after the row moves', async () => {
    let finish!: () => void
    const pending = new Promise<void>((r) => { finish = r })
    const props = renderPage({ onToggle: vi.fn(() => pending) })
    const sw = screen.getByRole('switch', { name: 'Pause Competitor news watch' })
    sw.focus()
    fireEvent.click(sw)
    // While it's sent: busy, ignores another press, and still holds focus.
    expect(sw.hasAttribute('disabled')).toBe(false)
    expect(sw.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(sw)
    fireEvent.click(sw)
    expect(props.onToggle).toHaveBeenCalledTimes(1)
    // The row moves to Paused (a remount); focus follows it there.
    await act(async () => {
      finish()
      await pending
    })
    props.rerender(<RoutinesPage {...props.props} routines={[{ ...news, enabled: false }, digest]} />)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByRole('region', { name: 'Paused' })).getByRole('switch', { name: 'Resume Competitor news watch' }),
      ),
    )
  })

  it('pauses / resumes with the switch and runs now without opening the editor', async () => {
    const props = renderPage()
    fireEvent.click(screen.getByRole('switch', { name: 'Pause Competitor news watch' }))
    await waitFor(() => expect(props.onToggle).toHaveBeenCalledWith(news, false))
    fireEvent.click(screen.getByRole('switch', { name: 'Resume Weekly digest' }))
    await waitFor(() => expect(props.onToggle).toHaveBeenCalledWith(digest, true))
    fireEvent.click(screen.getByRole('button', { name: 'Run Competitor news watch now' }))
    await waitFor(() => expect(props.onRunNow).toHaveBeenCalledWith(news))
    // Run now shows a live running state right away and blocks a second start.
    expect(await screen.findByText(/^Running… \d+s$/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Competitor news watch is running' })).toHaveProperty('disabled', true)
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('shows a run the agent reports as running, then its outcome', () => {
    const since = new Date(Date.now() - 95_000).toISOString()
    const view = renderPage({ routines: [{ ...news, runningSince: since }] })
    expect(screen.getByText(/^Running… 1m 3\ds$/)).toBeTruthy()
    expect(document.querySelector('[data-routine-status="running"]')).toBeTruthy()

    const justNow = new Date(Date.now() - 20_000).toISOString()
    view.rerender(
      <RoutinesPage {...view.props} routines={[{ ...news, runningSince: null, lastRunAt: justNow, lastStatus: 'ok' }]} />,
    )
    expect(screen.getByText('Finished just now')).toBeTruthy()

    view.rerender(
      <RoutinesPage
        {...view.props}
        routines={[{ ...news, lastRunAt: justNow, lastStatus: 'error', lastError: 'GitHub said 401\ntrace…' }]}
      />,
    )
    expect(screen.getByText('Failed just now · GitHub said 401')).toBeTruthy()

    view.rerender(<RoutinesPage {...view.props} routines={[{ ...news, lastRunAt: justNow, lastStatus: 'delivery_failed' }]} />)
    expect(screen.getByText(/couldn’t deliver the result/)).toBeTruthy()
  })

  it('an older failed run keeps the schedule and flags the failure', () => {
    renderPage({ routines: [{ ...news, lastStatus: 'error', lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }] })
    expect(screen.getByText(/Last run failed 3 h ago/)).toBeTruthy()
  })

  it('re-reads the routines while one is running, and stops after', () => {
    vi.useFakeTimers()
    try {
      const onRefresh = vi.fn()
      const view = renderPage({ onRefresh, routines: [{ ...news, runningSince: new Date().toISOString() }] })
      vi.advanceTimersByTime(8_100)
      expect(onRefresh).toHaveBeenCalledTimes(1)
      view.rerender(<RoutinesPage {...view.props} onRefresh={onRefresh} routines={[{ ...news, runningSince: null }]} />)
      vi.advanceTimersByTime(30_000)
      expect(onRefresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses running-job reads while hidden and refreshes immediately on visibility resume', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const onRefresh = vi.fn()
      const view = renderPage({ onRefresh, routines: [{ ...news, runningSince: new Date().toISOString() }] })
      await act(async () => { await vi.advanceTimersByTimeAsync(16_100) })
      expect(onRefresh).not.toHaveBeenCalled()
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(onRefresh).toHaveBeenCalledOnce()
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(16_100) })
      expect(onRefresh).toHaveBeenCalledOnce()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('shows a toggle failure on the row', async () => {
    renderPage({ onToggle: vi.fn(async () => { throw new Error('Couldn’t pause this routine.') }) })
    fireEvent.click(screen.getByRole('switch', { name: 'Pause Competitor news watch' }))
    expect(await screen.findByText('Couldn’t pause this routine.')).toBeTruthy()
  })

  it('does not invent a next run for a backend interval with no execution anchor', () => {
    renderPage({ routines: [{ ...news, origin: 'hermes', schedule: 'every 2h', nextRunAt: null }] })
    expect(screen.queryByText(/^Next /)).toBeNull()
    expect(screen.getByText(/Last ran/)).toBeTruthy()
  })

  it('shows the authoritative backend next run when it exists', () => {
    renderPage({ routines: [{ ...news, schedule: 'every 2h', nextRunAt: new Date(Date.now() + 3_600_000).toISOString() }] })
    expect(screen.getByText(/^Next /)).toBeTruthy()
  })

  it('without a toggle handler the switch opens the editor; no Run now without a handler', () => {
    const props = renderPage({ onToggle: undefined, onRunNow: undefined })
    expect(screen.queryByRole('button', { name: /now$/ })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Pause Competitor news watch' }))
    expect(props.onOpen).toHaveBeenCalledWith(news)
  })

  it('shows the empty state with templates', async () => {
    const props = renderPage({ routines: [], onTemplateCreated: vi.fn() })
    expect(screen.getByText(/Nothing scheduled yet/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Morning briefing/ })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Active' })).toBeNull()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('shows a loading skeleton before the first list arrives', () => {
    renderPage({ routines: [], loading: true })
    expect(screen.getByLabelText('Loading routines')).toBeTruthy()
    expect(screen.queryByText(/Nothing scheduled yet/)).toBeNull()
  })

  it('says the agent is unreachable instead of "Nothing scheduled yet", with Retry', () => {
    const onRetry = vi.fn()
    renderPage({ routines: [], unreachable: true, onRetry })
    expect(screen.getByText(/Can’t reach your agent right now/)).toBeTruthy()
    expect(screen.queryByText(/Nothing scheduled yet/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps local drafts listed under the unreachable notice', () => {
    const draft: Routine = { ...news, id: 'rt-local', name: 'Local draft', origin: 'local' }
    renderPage({ routines: [draft], unreachable: true, onRetry: vi.fn() })
    expect(screen.getByText(/Can’t reach your agent right now/)).toBeTruthy()
    expect(screen.getByText('Local draft')).toBeTruthy()
  })
})
