import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const serveGetDetailed = vi.fn()
vi.mock('../../lib/hermes-rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hermes-rest')>()
  return {
    ...actual,
    serveGet: vi.fn(async () => ({ ok: true })),
    serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
    serveSend: vi.fn(async () => ({ ok: true, data: {} })),
  }
})

const loadRoutines = vi.fn()
const removeRoutine = vi.fn()
const setRoutineEnabled = vi.fn()
vi.mock('../../lib/routines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/routines')>()
  return {
    ...actual,
    loadRoutines: (...a: unknown[]) => loadRoutines(...a),
    removeRoutine: (...a: unknown[]) => removeRoutine(...a),
    setRoutineEnabled: (...a: unknown[]) => setRoutineEnabled(...a),
  }
})

import { HermesSurfacesPanel } from '../HermesSurfacesPanel'

beforeEach(() => {
  cleanup()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  serveGetDetailed.mockReset().mockResolvedValue({ data: null, status: 404 })
  loadRoutines.mockReset()
  removeRoutine.mockReset()
  setRoutineEnabled.mockReset()
})

describe('HermesSurfacesPanel cron tab', () => {
  const slug = { id: 'j1', name: 'morning-brief', prompt: '', schedule: '0 8 * * *', enabled: true, origin: 'remote', deliver: 'discord' }

  it('shows readable names and schedules, and a row opens the routine', async () => {
    loadRoutines.mockResolvedValue({ source: 'remote', jobs: [slug] })
    const onOpenRoutine = vi.fn()
    render(<HermesSurfacesPanel open initialTab="cron" onClose={() => {}} onOpenRoutine={onOpenRoutine} />)
    expect(await screen.findByText('Every day at 8:00 AM · On · To Discord')).toBeTruthy()
    fireEvent.click(screen.getByText('Morning brief'))
    expect(onOpenRoutine).toHaveBeenCalledWith(slug)
  })

  it('asks before deleting, and deletes where the routine lives', async () => {
    const local = { ...slug, origin: 'hermes' }
    loadRoutines.mockResolvedValue({ source: 'remote', jobs: [local] })
    removeRoutine.mockResolvedValue(true)
    render(<HermesSurfacesPanel open initialTab="cron" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Morning brief' }))
    expect(removeRoutine).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }))
    await waitFor(() => expect(removeRoutine).toHaveBeenCalledWith(local))
  })

  it('shows why an action failed instead of doing nothing', async () => {
    loadRoutines.mockResolvedValue({ source: 'remote', jobs: [slug] })
    setRoutineEnabled.mockRejectedValue(new Error('Couldn’t pause this routine.'))
    render(<HermesSurfacesPanel open initialTab="cron" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('Couldn’t pause this routine.')).toBeTruthy()
  })

  it('offers templates when there are no routines', async () => {
    loadRoutines.mockResolvedValue({ source: 'remote', jobs: [] })
    serveGetDetailed.mockImplementation(async (path: string) =>
      path === '/api/cron/blueprints'
        ? { data: { blueprints: [{ key: 'k', title: 'Weekly review', fields: [] }] }, status: 200 }
        : { data: null, status: 404 },
    )
    render(<HermesSurfacesPanel open initialTab="cron" onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: /Weekly review/ })).toBeTruthy()
  })
})
