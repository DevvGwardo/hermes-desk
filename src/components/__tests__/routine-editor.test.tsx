import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../../lib/hermes-rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hermes-rest')>()
  return {
    ...actual,
    serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
    serveSend: (...a: unknown[]) => serveSend(...a),
  }
})

import { RoutineEditor } from '../RoutineEditor'
import type { Routine, RoutineDraft } from '../../lib/routines'

type Route = { data: unknown; status?: number }

let routes: Record<string, Route>

function setRoutes(r: Record<string, Route>) {
  routes = r
  serveGetDetailed.mockImplementation(async (path: string) => {
    const key = Object.keys(routes).find((k) => path.startsWith(k))
    if (!key) return { data: null, status: 404 }
    const hit = routes[key]!
    return { data: hit.data, status: hit.status ?? (hit.data == null ? 500 : 200) }
  })
}

const TARGETS = {
  targets: [
    { id: 'local', name: 'Local (save only)', home_target_set: true },
    { id: 'telegram', name: 'Telegram', home_target_set: false },
    { id: 'discord', name: 'Discord', home_target_set: true },
  ],
}

const BLUEPRINTS = {
  blueprints: [
    {
      key: 'morning-brief',
      title: 'Morning briefing',
      description: 'A short daily briefing.',
      fields: [
        { name: 'time', type: 'time', label: 'What time?', default: '08:00', options: [] },
        { name: 'deliver', type: 'enum', label: 'Where to deliver?', default: 'origin', options: ['origin', 'local'] },
      ],
    },
  ],
}

const remoteJob: Routine = {
  id: 'j1',
  name: 'Brief',
  prompt: 'Brief me',
  schedule: '0 8 * * *',
  enabled: true,
  origin: 'remote',
  deliver: 'local',
  failureDeliver: null,
  runOnce: false,
  skills: [],
}

function renderEditor(props: Partial<Parameters<typeof RoutineEditor>[0]> = {}) {
  const onSave = vi.fn(async (_d: RoutineDraft) => {})
  const onClose = vi.fn()
  const onTemplateCreated = vi.fn()
  render(
    <RoutineEditor
      open
      agents={[]}
      onClose={onClose}
      onSave={onSave}
      onTemplateCreated={onTemplateCreated}
      {...props}
    />,
  )
  return { onSave, onClose, onTemplateCreated }
}

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  setRoutes({ '/api/cron/delivery-targets': { data: TARGETS } })
})

afterEach(() => cleanup())

describe('RoutineEditor — send results to', () => {
  it('offers Nub Agent + connected chats and saves the choice on create', async () => {
    const { onSave } = renderEditor()
    const select = (await screen.findByLabelText('Send results to')) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))
    expect([...select.options].map((o) => o.textContent)).toEqual(['Only in Nub Agent', 'Telegram', 'Discord'])

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Brief' } })
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Brief me' } })
    fireEvent.change(select, { target: { value: 'discord' } })
    expect(screen.getByText(/you’ll hear about it there too/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ deliver: 'discord' })
    expect(onSave.mock.calls[0]![0].runOnce).toBeUndefined()
    expect(onSave.mock.calls[0]![0].failureDeliver).toBeUndefined()
  })

  it('tells the user to /sethome when the platform has no home chat, and re-checks', async () => {
    renderEditor()
    const select = (await screen.findByLabelText('Send results to')) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))
    fireEvent.change(select, { target: { value: 'telegram' } })
    expect(screen.getByText(/Send \/sethome in your Telegram chat/)).toBeTruthy()

    setRoutes({
      '/api/cron/delivery-targets': {
        data: { targets: [{ id: 'telegram', name: 'Telegram', home_target_set: true }] },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByText(/Send \/sethome/)).toBeNull())
  })

  it('failure alerts: only offered for Nub-only routines, saved as failureDeliver', async () => {
    const { onSave } = renderEditor({ initial: remoteJob })
    await screen.findByLabelText('Send results to')
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    const box = (await screen.findByLabelText('Also alert me if it fails')) as HTMLInputElement
    fireEvent.click(box)
    const alertOn = screen.getByLabelText('Alert me on') as HTMLSelectElement
    fireEvent.change(alertOn, { target: { value: 'discord' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ deliver: 'local', failureDeliver: 'discord', runOnce: false, skills: [] })
  })

  it('hides the extras when the agent is unreachable (local drafts)', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: null, status: undefined } })
    serveGetDetailed.mockResolvedValue({ data: null, error: { message: 'down' } })
    const { onSave } = renderEditor()
    await waitFor(() => expect(serveGetDetailed).toHaveBeenCalled())
    expect(screen.queryByLabelText('Send results to')).toBeNull()
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].deliver).toBeUndefined()
  })

  it('shows "needs an update" on older agents', async () => {
    setRoutes({})
    renderEditor()
    expect(await screen.findByText('Your agent needs an update for this.')).toBeTruthy()
  })

  it('does not overwrite fields it never read on a placeholder routine', async () => {
    const { onSave } = renderEditor({
      initial: { id: 'j2', name: 'j2', prompt: '', schedule: '0 9 * * *', enabled: true, origin: 'remote' },
    })
    await screen.findByLabelText('Send results to')
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Do the thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0]![0]
    expect(draft.deliver).toBeUndefined()
    expect(draft.runOnce).toBeUndefined()
    expect(draft.skills).toBeUndefined()
  })
})

describe('RoutineEditor — run once, skills, history', () => {
  it('does not save an edited Once picker after its date is cleared', async () => {
    const { onSave } = renderEditor({ initial: remoteJob })
    await screen.findByLabelText('Send results to')
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'once' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not save an edited weekly picker with no selected days', async () => {
    const { onSave } = renderEditor({ initial: { ...remoteJob, schedule: '0 8 * * 1' } })
    await screen.findByLabelText('Send results to')
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }))
    expect(screen.getByText('Pick at least one day.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('uses the stored instant when reopening a one-shot interval', () => {
    const next = new Date()
    next.setHours(next.getHours() + 1, 15, 0, 0)
    renderEditor({ initial: { ...remoteJob, schedule: 'every 2h', runOnce: true, nextRunAt: next.toISOString() } })
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe(
      `${String(next.getHours()).padStart(2, '0')}:15`,
    )
  })

  it('Once frequency preserves the selected year and local time as an absolute instant', async () => {
    const { onSave } = renderEditor({ initial: remoteJob })
    await screen.findByLabelText('Send results to')
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'once' } })
    const next = new Date()
    next.setFullYear(next.getFullYear() + 1, 4, 6)
    const date = `${next.getFullYear()}-05-06`
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:30' } })
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe(
      `Once on May 6, ${next.getFullYear()} at 2:30 PM`,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      runOnce: true,
      schedule: new Date(next.getFullYear(), 4, 6, 14, 30).toISOString(),
    })
    expect(screen.getByText('This date and time use your device’s timezone.')).toBeTruthy()
  })

  it('a past Once time blocks Save', async () => {
    renderEditor({ initial: remoteJob })
    await screen.findByLabelText('Send results to')
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'once' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2020-01-01' } })
    expect(screen.getByText('Pick a time in the future.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a run-once routine opens as Once and leaving it there keeps runOnce', async () => {
    const { onSave } = renderEditor({ initial: { ...remoteJob, runOnce: true, schedule: '0 8 * * *' } })
    await screen.findByLabelText('Send results to')
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('once')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ runOnce: true, schedule: '0 8 * * *' })
  })

  it('Advanced lets you pick skills', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/skills': { data: [{ name: 'google-workspace', description: 'Gmail + Calendar' }, { name: 'off', enabled: false }] },
    })
    const { onSave } = renderEditor({ initial: remoteJob })
    fireEvent.click(await screen.findByRole('button', { name: /Advanced/ }))
    const skill = await screen.findByLabelText(/google-workspace/)
    expect(screen.queryByLabelText(/^off$/)).toBeNull()
    fireEvent.click(skill)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].skills).toEqual(['google-workspace'])
    // Never exposes model / provider pickers.
    expect(screen.queryByLabelText(/model/i)).toBeNull()
  })

  it('the History tab retries a run whose output failed to load, and marks a silent run Not sent', async () => {
    const runsRoute = {
      data: { runs: [{ id: 'cron_j1_2', started_at: 1_700_000_000, ended_at: 1_700_000_030, end_reason: 'cron_complete' }] },
    }
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': runsRoute,
      '/api/sessions/cron_j1_2/messages': { data: null, status: 503 },
    })
    renderEditor({ initial: remoteJob })
    fireEvent.click(await screen.findByRole('tab', { name: 'Results' }))
    const output = await screen.findByTestId('routine-run-output')
    expect(await within(output).findByText(/Couldn’t load this run’s output/)).toBeTruthy()
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': runsRoute,
      '/api/sessions/cron_j1_2/messages': { data: { messages: [{ role: 'assistant', content: '[SILENT]' }] } },
    })
    fireEvent.click(within(output).getByRole('button', { name: 'Retry' }))
    expect(await within(output).findByText('Nothing to report this time.')).toBeTruthy()
    expect(screen.getByText('Not sent')).toBeTruthy()
  })

  it('the History tab lists runs and opens the newest one in full', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': {
        data: {
          runs: [
            { id: 'cron_j1_2', started_at: 1_700_000_000, ended_at: 1_700_000_030, end_reason: 'cron_complete' },
            { id: 'cron_j1_1', started_at: 1_699_900_000, ended_at: 1_699_900_010, end_reason: 'cron_incomplete_no_output' },
          ],
        },
      },
      '/api/sessions/cron_j1_2/messages': { data: { messages: [{ role: 'assistant', content: 'Good morning! 3 meetings.' }] } },
      '/api/sessions/cron_j1_1/messages': { data: { messages: [] } },
    })
    renderEditor({ initial: remoteJob })
    // The form's Save lives on the Settings tab only.
    fireEvent.click(await screen.findByRole('tab', { name: 'Results' }))
    const list = await screen.findByRole('list', { name: 'Runs' })
    expect(within(list).getByText('Done')).toBeTruthy()
    expect(within(list).getByText('Didn’t finish')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    const output = screen.getByTestId('routine-run-output')
    expect(await within(output).findByText('Good morning! 3 meetings.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Older run' }))
    expect(await within(output).findByText('It didn’t finish, and no output was saved.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})

describe('RoutineEditor — simpler for everyone', () => {
  const ranJob: Routine = { ...remoteJob, name: 'repo-watcher-fastlane', lastRunAt: new Date(Date.now() - 3_600_000).toISOString() }
  const runsRoute = {
    data: { runs: [{ id: 'cron_j1_2', started_at: 1_700_000_000, ended_at: 1_700_000_030, end_reason: 'cron_complete' }] },
  }

  it('a routine that has run opens on Results, titled with its readable name', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': runsRoute,
      '/api/sessions/cron_j1_2/messages': { data: { messages: [{ role: 'assistant', content: 'Two new releases.' }] } },
    })
    renderEditor({ initial: ranJob })
    expect(screen.getByRole('dialog', { name: 'Repo watcher fastlane' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected')).toBe('true')
    expect(await within(await screen.findByTestId('routine-run-output')).findByText('Two new releases.')).toBeTruthy()
    // The stored name is untouched.
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('repo-watcher-fastlane')
  })

  it('a routine that never ran opens on Settings', () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS } })
    renderEditor({ initial: remoteJob })
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true')
  })

  it('Delete asks once before deleting', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS } })
    const onDelete = vi.fn(async () => {})
    const { onClose } = renderEditor({ initial: remoteJob, onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(remoteJob))
    expect(onClose).toHaveBeenCalled()
  })

  it('Run now on a saved routine switches to Results and shows it starting', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': { data: { runs: [] } },
    })
    const onTestRun = vi.fn(async () => {})
    renderEditor({ initial: remoteJob, onTestRun })
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(onTestRun).toHaveBeenCalled())
    expect(await screen.findByText(/^Started\./)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected')).toBe('true')
  })

  it('Run now with unsaved edits saves them first', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS }, '/api/cron/jobs/j1/runs': { data: { runs: [] } } })
    const onTestRun = vi.fn(async () => {})
    const { onSave } = renderEditor({ initial: remoteJob, onTestRun })
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Brief me with weather' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & run now' }))
    await waitFor(() => expect(onTestRun).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].prompt).toBe('Brief me with weather')
    expect(onSave.mock.invocationCallOrder[0]!).toBeLessThan(onTestRun.mock.invocationCallOrder[0]!)
  })

  it('after "Save & run now", the next Save compares against what was just saved', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS }, '/api/cron/jobs/j1/runs': { data: { runs: [] } } })
    const onTestRun = vi.fn(async () => {})
    const onSave = vi.fn(async (d: RoutineDraft, _existing: Routine | null) => ({ ...remoteJob, ...d, enabled: d.enabled !== false }) as Routine)
    const onClose = vi.fn()
    render(<RoutineEditor open agents={[]} initial={remoteJob} onClose={onClose} onSave={onSave} onTestRun={onTestRun} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Active' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & run now' }))
    await waitFor(() => expect(onTestRun).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![1]).toBe(remoteJob)

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    // Nothing unsaved now: Run now runs, it doesn't save again.
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Active' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // The resume is judged against the paused copy just saved, not the one opened.
    expect(onSave.mock.calls[1]![1]?.enabled).toBe(false)
    expect(onSave.mock.calls[1]![0].enabled).toBe(true)
  })

  it('Run now on a new routine says where it went', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS } })
    const onTestRun = vi.fn(async () => {})
    renderEditor({ onTestRun })
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Say hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(await screen.findByText(/Sent to your agent’s chat to try it/)).toBeTruthy()
  })

  it('a notification can ask for Results even before the first run is recorded', () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS }, '/api/cron/jobs/j1/runs': { data: { runs: [] } } })
    renderEditor({ initial: remoteJob, initialTab: 'results' })
    expect(screen.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected')).toBe('true')
  })

  it('a running run says so instead of loading output', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': { data: { runs: [{ id: 'cron_j1_9', started_at: Date.now() / 1000, is_active: true }] } },
    })
    renderEditor({ initial: ranJob })
    expect(await screen.findByText(/Working on it/)).toBeTruthy()
    expect(serveGetDetailed.mock.calls.some(([p]) => String(p).startsWith('/api/sessions/'))).toBe(false)
  })

  it('shows the next run as a date', () => {
    setRoutes({ '/api/cron/delivery-targets': { data: TARGETS } })
    renderEditor({ initial: { ...remoteJob, nextRunAt: '2030-01-07T08:00:00Z' } })
    expect(screen.getByTestId('routine-next-run').textContent).toMatch(/next run .*Jan.*2030/)
  })
})

describe('RoutineEditor — run output', () => {
  it('renders output as markdown and shows a [SILENT] run as not sent', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/jobs/j1/runs': {
        data: { runs: [{ id: 'cron_j1_3', started_at: 1_700_000_000, ended_at: 1_700_000_300, end_reason: 'cron_complete' }] },
      },
      '/api/sessions/cron_j1_3/messages': {
        data: { messages: [{ role: 'assistant', content: '**Watch tick**\n\n- No new funding\n\n[SILENT]' }] },
      },
    })
    renderEditor({ initial: remoteJob })
    fireEvent.click(await screen.findByRole('tab', { name: 'Results' }))
    expect(await screen.findByText('Not sent')).toBeTruthy()
    const output = screen.getByTestId('routine-run-output')
    await waitFor(() => expect(within(output).getByText('Watch tick').tagName).toBe('STRONG'))
    expect(within(output).queryByText(/\[SILENT\]/)).toBeNull()
  })
})

describe('RoutineEditor — templates', () => {
  it('creates a routine from a template with the chosen target', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/blueprints': { data: BLUEPRINTS },
    })
    serveSend.mockResolvedValue({ ok: true, data: { id: 'bp1' } })
    const { onTemplateCreated, onClose } = renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    fireEvent.click(await screen.findByRole('button', { name: /Morning briefing/ }))
    fireEvent.change(screen.getByLabelText('What time?'), { target: { value: '07:15' } })
    const deliver = screen.getByLabelText('Send results to') as HTMLSelectElement
    await waitFor(() => expect(deliver.disabled).toBe(false))
    expect(deliver.value).toBe('local')
    fireEvent.change(deliver, { target: { value: 'discord' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    await waitFor(() => expect(onTemplateCreated).toHaveBeenCalled())
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/cron/blueprints/instantiate?profile=default', {
      blueprint: 'morning-brief',
      values: { time: '07:15', deliver: 'discord' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the field error from the agent', async () => {
    setRoutes({
      '/api/cron/delivery-targets': { data: TARGETS },
      '/api/cron/blueprints': { data: BLUEPRINTS },
    })
    serveSend.mockResolvedValue({ ok: false, data: null, status: 422, error: "invalid time '99:00' — use HH:MM (24h)" })
    renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    fireEvent.click(await screen.findByRole('button', { name: /Morning briefing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    expect(await screen.findByText(/invalid time/)).toBeTruthy()
  })
})

describe('RoutineEditor — Marketplace recipe seed', () => {
  const seed = { name: 'Weekly wrap-up', prompt: 'Sum up the week.', schedule: '0 17 * * 5' }

  it('opens a new routine filled from the recipe, saved only on Create', async () => {
    setRoutes({ '/api/cron/targets': { data: TARGETS } })
    const { onSave } = renderEditor({ seed })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly wrap-up')
    expect((screen.getByLabelText('Instruction') as HTMLTextAreaElement).value).toBe('Sum up the week.')
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('weekly')
    expect(screen.getByRole('button', { name: 'Friday' }).getAttribute('aria-pressed')).toBe('true')
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Routine' }).at(-1)!)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: 'Weekly wrap-up', schedule: '0 17 * * 5' })
    expect(onSave.mock.calls[0]![0].id).toBeUndefined()
  })

  it('an existing routine wins over a seed', () => {
    setRoutes({ '/api/cron/targets': { data: TARGETS } })
    renderEditor({ seed, initial: remoteJob })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Brief')
  })
})

describe('RoutineEditor — simplified layout', () => {
  const agentA = { id: 'a1', name: 'Nub' } as Parameters<typeof RoutineEditor>[0]['agents'][number]
  const agentB = { id: 'a2', name: 'Helper' } as Parameters<typeof RoutineEditor>[0]['agents'][number]

  it('name is an optional field, Active is a switch, Save waits for an instruction', async () => {
    const { onSave } = renderEditor()
    expect((screen.getByLabelText('Name') as HTMLInputElement).placeholder).toBe('e.g. Morning briefing (optional)')
    expect(screen.getByRole('dialog', { name: 'New routine' })).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Create Routine' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const active = screen.getByRole('switch', { name: 'Active' })
    expect(active.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(active)
    expect(active.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Check the news' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0]).toMatchObject({ enabled: false, schedule: '0 9 * * *', name: '' })
  })

  it('Cancel closes without saving', () => {
    const { onSave, onClose } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps the selected profile explicit even when the native scheduler is unreachable', async () => {
    setRoutes({ '/api/cron/delivery-targets': { data: null, status: undefined } })
    renderEditor({ agents: [agentA] })
    expect(screen.getByLabelText('Agent profile')).toBeTruthy()
    cleanup()
    renderEditor({ agents: [agentA, agentB] })
    await waitFor(() => expect(serveGetDetailed).toHaveBeenCalled())
    expect(screen.getByLabelText('Agent profile')).toBeTruthy()
  })

  it('retains a real profile choice when the native scheduler owns new routines', async () => {
    renderEditor({ agents: [agentA, agentB] })
    await screen.findByLabelText('Send results to')
    expect(screen.getByLabelText('Agent profile')).toBeTruthy()
  })

  it('asks before deleting, and Keep backs out', async () => {
    const onDelete = vi.fn(async () => {})
    const { onClose } = renderEditor({ initial: remoteJob, onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).not.toHaveBeenCalled()
    const group = screen.getByRole('group', { name: 'Confirm delete' })
    fireEvent.click(within(group).getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm delete' })).getByRole('button', { name: 'Yes, delete it' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(remoteJob))
    expect(onClose).toHaveBeenCalled()
  })

  it('a delete question left open is gone when the editor reopens on another routine', () => {
    // Desktop keeps the editor mounted between opens; the confirm must not
    // carry over and arm a one-tap delete of the next routine.
    const onDelete = vi.fn(async () => {})
    const other: Routine = { ...remoteJob, id: 'j2', name: 'Digest' }
    const props = { agents: [], onClose: vi.fn(), onSave: vi.fn(async () => {}), onDelete }
    const { rerender } = render(<RoutineEditor open initial={remoteJob} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('group', { name: 'Confirm delete' })).toBeTruthy()
    rerender(<RoutineEditor open={false} initial={remoteJob} {...props} />)
    rerender(<RoutineEditor open initial={other} {...props} />)
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it.each([
    ['hourly', '0 * * * *', 'Every hour'],
    ['daily', '0 9 * * *', 'Every day at 9:00 AM'],
    ['weekdays', '0 9 * * 1-5', 'Weekdays at 9:00 AM'],
    ['weekly', '0 9 * * 1', 'Mondays at 9:00 AM'],
    ['monthly', '0 9 1 * *', 'Monthly on the 1st at 9:00 AM'],
  ])('%s produces the old preset cron %s', async (freq, cron, words) => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: freq } })
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe(words)
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'go' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].schedule).toBe(cron)
  })

  it('an existing preset cron opens in the picker with its time, Advanced closed', () => {
    renderEditor({ initial: { ...remoteJob, schedule: '28 20 * * 1-5' } })
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('weekdays')
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('20:28')
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe('Weekdays at 8:28 PM')
    expect(screen.getByRole('button', { name: /Advanced/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('weekly: picks days and time', async () => {
    const { onSave } = renderEditor()
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:15' } })
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe('Mon, Wed at 7:15 AM')
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }))
    expect(screen.getByText('Pick at least one day.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }))
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'go' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].schedule).toBe('15 7 * * 5')
  })

  it('hourly minute and monthly day', () => {
    renderEditor()
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'hourly' } })
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '30' } })
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe('Every hour at :30')
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'monthly' } })
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } })
    // The hourly minute carries over to the time of day.
    expect(screen.getByTestId('routine-schedule-words').textContent).toBe('Monthly on the 15th at 9:30 AM')
  })

  it('a non-preset cron opens with Advanced expanded showing it, and saves untouched', async () => {
    const { onSave } = renderEditor({ initial: { ...remoteJob, schedule: '*/15 9-17 * * 1-5' } })
    expect(screen.getByRole('button', { name: /Advanced/ }).getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByLabelText('Custom schedule') as HTMLInputElement).value).toBe('*/15 9-17 * * 1-5')
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('custom')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]![0].schedule).toBe('*/15 9-17 * * 1-5')
  })

  it('typing a preset-shaped cron under Advanced moves the picker to it', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    const input = screen.getByLabelText('Custom schedule')
    fireEvent.change(input, { target: { value: '0 7 15 * *' } })
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('monthly')
    fireEvent.change(input, { target: { value: 'nonsense' } })
    expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('custom')
    expect(screen.getByText(/Enter a schedule like/)).toBeTruthy()
  })
})
