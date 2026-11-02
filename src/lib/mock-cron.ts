/**
 * Offline demo scheduler for mock mode (dev builds in a plain browser tab,
 * `isMockMode()`; never in a shipped build). Answers the hermes dashboard's
 * `/api/cron/jobs` routes from an in-memory list so the Routines page,
 * editor, pause/resume, run now and delete all work end to end with no
 * agent — which is what the blueprint harness (tools/blueprint) drives.
 *
 * Seeded with two demo routines in the browser; unit tests (MODE=test)
 * start empty so their fixtures stay explicit.
 */

type MockJob = {
  id: string
  name: string
  prompt: string
  schedule: { expr: string; display?: string }
  enabled: boolean
  deliver: string
  last_run_at: string | null
  next_run_at: string | null
}

type Result = { ok: boolean; status: number; data?: unknown; error?: string }

const HOUR = 3_600_000

function seed(): MockJob[] {
  if (import.meta.env.PROD || import.meta.env.MODE === 'test') return []
  const now = Date.now()
  return [
    {
      id: 'demo-morning',
      name: 'Morning briefing',
      prompt: 'Summarize overnight deploys, open incidents and anything waiting on me.',
      schedule: { expr: '0 8 * * *' },
      enabled: true,
      deliver: 'local',
      last_run_at: new Date(now - 5 * HOUR).toISOString(),
      next_run_at: new Date(now + 19 * HOUR).toISOString(),
    },
    {
      id: 'demo-weekly',
      name: 'Weekly digest',
      prompt: 'Write a short digest of what the agents shipped this week.',
      schedule: { expr: '0 9 * * 1' },
      enabled: false,
      deliver: 'local',
      last_run_at: null,
      next_run_at: null,
    },
  ]
}

let jobs: MockJob[] | null = null
let nextId = 1

function list(): MockJob[] {
  jobs ??= seed()
  return jobs
}

/** Test seam: back to the seeded state. */
export function resetMockCron(): void {
  jobs = null
  nextId = 1
}

function scheduleOf(raw: unknown): MockJob['schedule'] {
  if (typeof raw === 'string') return { expr: raw }
  if (raw && typeof raw === 'object' && typeof (raw as { expr?: unknown }).expr === 'string') {
    return { expr: (raw as { expr: string }).expr }
  }
  return { expr: '0 9 * * *' }
}

/** Add a demo job (template instantiate) and return it. */
export function addMockJob(job: { name: string; prompt: string; schedule: string; deliver?: string }): MockJob {
  const created: MockJob = {
    id: `mock-job-${nextId++}`,
    name: job.name,
    prompt: job.prompt,
    schedule: { expr: job.schedule },
    enabled: true,
    deliver: job.deliver ?? 'local',
    last_run_at: null,
    next_run_at: null,
  }
  list().unshift(created)
  return created
}

/** `/api/cron/jobs[/<id>[/pause|resume|run|trigger]]` against the demo list. */
export function mockCronRequest(method: string, path: string, body?: Record<string, unknown>): Result {
  // Constant in a production build, so the bundler drops the demo list.
  if (import.meta.env.PROD) return { ok: false, status: 404, error: 'mock: unavailable' }
  const url = new URL(path, 'http://mock.invalid')
  const parts = url.pathname.replace(/^\/api\/cron\/jobs\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [id, action] = parts
  const all = list()

  if (!id) {
    if (method === 'GET') return { ok: true, status: 200, data: { jobs: all } }
    if (method === 'POST') {
      const job: MockJob = {
        id: `mock-job-${nextId++}`,
        name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled routine',
        prompt: typeof body?.prompt === 'string' ? body.prompt : '',
        schedule: scheduleOf(body?.schedule),
        enabled: true,
        deliver: typeof body?.deliver === 'string' ? body.deliver : 'local',
        last_run_at: null,
        next_run_at: null,
      }
      all.unshift(job)
      return { ok: true, status: 200, data: job }
    }
    return { ok: false, status: 405, error: 'method not allowed' }
  }

  const job = all.find((j) => j.id === id)
  if (!job) return { ok: false, status: 404, error: 'job not found' }

  if (!action) {
    if (method === 'GET') return { ok: true, status: 200, data: job }
    if (method === 'DELETE') {
      jobs = all.filter((j) => j.id !== id)
      return { ok: true, status: 200, data: { ok: true } }
    }
    if (method === 'PUT' || method === 'PATCH') {
      const updates = (body?.updates ?? body ?? {}) as Record<string, unknown>
      if (typeof updates.name === 'string') job.name = updates.name
      if (typeof updates.prompt === 'string') job.prompt = updates.prompt
      if (updates.schedule !== undefined) {
        job.schedule = scheduleOf(updates.schedule)
        job.next_run_at = null
      }
      if (typeof updates.deliver === 'string') job.deliver = updates.deliver
      return { ok: true, status: 200, data: { ok: true } }
    }
  }
  if (action === 'pause' && method === 'POST') {
    job.enabled = false
    job.next_run_at = null
    return { ok: true, status: 200, data: { ok: true } }
  }
  if (action === 'resume' && method === 'POST') {
    job.enabled = true
    job.next_run_at = new Date(Date.now() + 24 * HOUR).toISOString()
    return { ok: true, status: 200, data: { ok: true } }
  }
  if ((action === 'run' || action === 'trigger') && method === 'POST') {
    job.last_run_at = new Date().toISOString()
    return { ok: true, status: 200, data: { ok: true } }
  }
  if (action === 'runs' && method === 'GET') {
    const runs = job.last_run_at
      ? [{ id: `${job.id}-run-1`, started_at: Math.floor(Date.parse(job.last_run_at) / 1000), ended_at: Math.floor(Date.parse(job.last_run_at) / 1000) + 42, end_reason: 'cron_complete', is_active: false }]
      : []
    return { ok: true, status: 200, data: { runs } }
  }
  return { ok: true, status: 200, data: { ok: true } }
}
