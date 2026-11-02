import { beforeEach, describe, expect, it } from 'vitest'
import { mockCronRequest, resetMockCron } from '../mock-cron'

beforeEach(() => resetMockCron())

describe('mock-cron (offline demo scheduler)', () => {
  it('starts empty under tests so fixtures stay explicit', () => {
    expect(mockCronRequest('GET', '/api/cron/jobs').data).toEqual({ jobs: [] })
  })

  it('creates, pauses, resumes, edits and deletes through the dashboard routes', () => {
    const created = mockCronRequest('POST', '/api/cron/jobs', { name: 'Check-in', prompt: 'Hi', schedule: '0 8 * * *' })
    const id = (created.data as { id: string }).id
    const list = () => (mockCronRequest('GET', '/api/cron/jobs').data as { jobs: Array<{ id: string; enabled: boolean; name: string; next_run_at: string | null }> }).jobs
    expect(list().map((j) => j.name)).toEqual(['Check-in'])

    mockCronRequest('POST', `/api/cron/jobs/${id}/pause`)
    expect(list()[0]).toMatchObject({ enabled: false, next_run_at: null })
    mockCronRequest('POST', `/api/cron/jobs/${id}/resume`)
    expect(list()[0]!.enabled).toBe(true)
    expect(list()[0]!.next_run_at).not.toBeNull()

    mockCronRequest('PUT', `/api/cron/jobs/${id}`, { updates: { name: 'Morning check-in' } })
    expect(list()[0]!.name).toBe('Morning check-in')

    mockCronRequest('DELETE', `/api/cron/jobs/${id}`)
    expect(list()).toEqual([])
  })

  it('answers 404 for a job that does not exist', () => {
    expect(mockCronRequest('POST', '/api/cron/jobs/nope/pause').status).toBe(404)
  })
})
