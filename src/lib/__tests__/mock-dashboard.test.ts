import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockDashboardRequest } from '../mock-dashboard'
import { mockCronRequest, resetMockCron } from '../mock-cron'

describe('mock-dashboard (offline demo routes)', () => {
  beforeEach(() => {
    // The fixtures stand down under tests; play a dev build for this file.
    vi.stubEnv('MODE', 'development')
    resetMockCron()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('answers nothing under the test mode, so other suites keep explicit fixtures', () => {
    vi.stubEnv('MODE', 'test')
    expect(mockDashboardRequest('GET', '/api/cron/delivery-targets')).toBeNull()
  })

  it('serves delivery targets and creates a routine from a template', () => {
    const targets = mockDashboardRequest('GET', '/api/cron/delivery-targets')?.data as { targets: Array<{ id: string }> }
    expect(targets.targets.map((t) => t.id)).toContain('telegram')
    const before = (mockCronRequest('GET', '/api/cron/jobs').data as { jobs: unknown[] }).jobs.length
    const made = mockDashboardRequest('POST', '/api/cron/blueprints/instantiate', { blueprint: 'weekly-digest', values: { time: '07:30' } })
    expect(made?.ok).toBe(true)
    const jobs = (mockCronRequest('GET', '/api/cron/jobs').data as { jobs: Array<{ schedule: { expr: string } }> }).jobs
    expect(jobs).toHaveLength(before + 1)
    expect(jobs[0]!.schedule.expr).toBe('30 7 * * 1')
    expect(mockDashboardRequest('POST', '/api/cron/blueprints/instantiate', { blueprint: 'nope' })?.status).toBe(404)
  })

  it('searches chat history by title and preview', () => {
    const res = mockDashboardRequest('GET', '/api/sessions/search?q=table&limit=20')?.data as { results: Array<{ id: string }> }
    expect(res.results.map((r) => r.id)).toEqual(['sess-telegram'])
  })

  it('adds a task to the demo board', () => {
    mockDashboardRequest('POST', '/api/plugins/kanban/tasks', { title: 'Check the phone build' })
    const board = mockDashboardRequest('GET', '/api/plugins/kanban/board')?.data as { columns: Array<{ name: string; tasks: Array<{ title: string }> }> }
    const todo = board.columns.find((c) => c.name === 'todo')!
    expect(todo.tasks.map((t) => t.title)).toContain('Check the phone build')
  })

  it('leaves routes it does not own to the caller', () => {
    expect(mockDashboardRequest('GET', '/api/unknown')).toBeNull()
  })
})
