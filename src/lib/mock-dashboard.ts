/**
 * Offline demo answers for the agent dashboard routes the phone and desktop
 * settings, routine editor, chat history and run history read, so mock mode
 * (dev builds in a plain browser tab; never shipped) shows working screens
 * instead of "your agent needs an update". The blueprint harness
 * (tools/blueprint) screenshots these. Unit tests (MODE=test) get null and
 * keep their own explicit fixtures.
 */
import { addMockJob } from './mock-cron'
import { isMockMode } from './maiavm-api'

/** The offline demo stands in for a linked agent: a dev build in a plain
 *  browser tab (mock mode, no Electron). Never in a shipped build (isMockMode
 *  is false there) and never under unit tests, whose fixtures stay explicit. */
export function demoAgentActive(): boolean {
  // Constant in a production build, so the bundler drops every fixture.
  if (import.meta.env.PROD) return false
  return import.meta.env.MODE !== 'test' && typeof window !== 'undefined' && !window.nubAgent && isMockMode()
}

type Result = { ok: boolean; status: number; data?: unknown; error?: string }

const ok = (data: unknown): Result => ({ ok: true, status: 200, data })

const NOW = Date.now()
const minutesAgo = (m: number) => Math.floor((NOW - m * 60_000) / 1000)

const TARGETS = [
  { id: 'local', name: 'Only in Nub Agent', home_target_set: true },
  { id: 'telegram', name: 'Telegram', home_target_set: true },
  { id: 'email', name: 'Email', home_target_set: false },
]

const BLUEPRINTS = [
  {
    key: 'morning-brief',
    title: 'Morning briefing',
    description: 'A short daily summary of what changed overnight.',
    scheduleHuman: 'Every day',
    fields: [
      { name: 'time', type: 'time', label: 'What time?', default: '08:00', options: [] },
      { name: 'topics', type: 'text', label: 'What should it cover?', default: 'deploys, incidents, inbox', options: [] },
    ],
  },
  {
    key: 'weekly-digest',
    title: 'Weekly digest',
    description: 'What your agents shipped this week, every Monday.',
    scheduleHuman: 'Mondays',
    fields: [{ name: 'time', type: 'time', label: 'What time?', default: '09:00', options: [] }],
  },
]

const SKILLS = [
  { name: 'web-search', description: 'Search the web and read pages', enabled: true, category: 'research' },
  { name: 'browser', description: 'Drive a real browser on the agent computer', enabled: true, category: 'research' },
  { name: 'github', description: 'Issues, pull requests and repos', enabled: false, category: 'code' },
  { name: 'calendar', description: 'Read and add calendar events', enabled: false, category: 'productivity' },
]

const env = (key: string, required: boolean, set: boolean, description: string) => ({
  key,
  required,
  is_set: set,
  redacted_value: set ? '••••' : null,
  description,
  is_password: true,
})

let platforms: Array<Record<string, unknown>> | null = null
function platformList() {
  platforms ??= [
    {
      id: 'telegram',
      name: 'Telegram',
      description: 'Chat with your agent from Telegram.',
      enabled: true,
      configured: true,
      gateway_running: true,
      state: 'connected',
      env_vars: [env('TELEGRAM_BOT_TOKEN', true, true, 'Bot token from BotFather')],
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      description: 'Link a WhatsApp number by scanning a QR code.',
      enabled: false,
      configured: false,
      gateway_running: true,
      state: 'not_configured',
      env_vars: [],
    },
    {
      id: 'email',
      name: 'Email',
      description: 'Let people email your agent.',
      enabled: false,
      configured: false,
      gateway_running: true,
      state: 'not_configured',
      env_vars: [env('EMAIL_ADDRESS', true, false, 'The inbox your agent reads')],
    },
  ]
  return platforms
}

let sessions: Array<Record<string, unknown>> | null = null
function sessionList() {
  sessions ??= [
    { id: 'sess-deploy', title: 'Deploy summary for the week', source: 'desktop', last_active: minutesAgo(40), message_count: 12, preview: 'Landing page is at /opt/data/workspace/landing/index.html' },
    { id: 'sess-telegram', title: 'Book a table for Friday', source: 'telegram', last_active: minutesAgo(300), message_count: 6, preview: 'Done: 7:30pm, table for four.' },
    { id: 'sess-routine', title: 'Morning briefing', source: 'cron', last_active: minutesAgo(310), message_count: 2, preview: 'Two deploys overnight, no incidents.' },
  ]
  return sessions
}

type DemoTask = { id: string; title: string; status: string; assignee: string | null; body: string | null }
let tasks: DemoTask[] | null = null
let taskSeq = 1
function taskList(): DemoTask[] {
  tasks ??= [
    { id: 't-landing', title: 'Ship the landing page', status: 'running', assignee: 'Research Alpha', body: 'Polish copy, then publish.' },
    { id: 't-digest', title: 'Draft the weekly digest', status: 'todo', assignee: null, body: null },
    { id: 't-audit', title: 'Audit last night’s deploys', status: 'done', assignee: 'Ops Runner', body: null },
  ]
  return tasks
}
const COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'done']

/** Demo answer for a dashboard route, or null when this module doesn't own it. */
export function mockDashboardRequest(method: string, path: string, body?: Record<string, unknown>): Result | null {
  if (import.meta.env.PROD || import.meta.env.MODE === 'test') return null
  const url = new URL(path, 'http://mock.invalid')
  const p = url.pathname

  if (p === '/api/cron/delivery-targets' && method === 'GET') return ok({ targets: TARGETS })
  if (p === '/api/cron/blueprints' && method === 'GET') return ok({ blueprints: BLUEPRINTS })
  if (p === '/api/cron/blueprints/instantiate' && method === 'POST') {
    const bp = BLUEPRINTS.find((b) => b.key === body?.blueprint)
    if (!bp) return { ok: false, status: 404, error: 'unknown blueprint' }
    const values = (body?.values ?? {}) as Record<string, string>
    const [hh, mm] = String(values.time || bp.fields[0]?.default || '09:00').split(':')
    const dow = bp.key === 'weekly-digest' ? '1' : '*'
    return ok(addMockJob({ name: bp.title, prompt: bp.description, schedule: `${Number(mm) || 0} ${Number(hh) || 9} * * ${dow}` }))
  }

  if (p === '/api/skills' && method === 'GET') return ok(SKILLS)

  if (p === '/api/messaging/platforms' && method === 'GET') return ok({ platforms: platformList() })
  const plat = p.match(/^\/api\/messaging\/platforms\/([^/]+)$/)
  if (plat && method === 'PUT') {
    const row = platformList().find((x) => x.id === decodeURIComponent(plat[1]!))
    if (!row) return { ok: false, status: 404, error: 'unknown platform' }
    if (typeof body?.enabled === 'boolean') row.enabled = body.enabled
    return ok({ ok: true })
  }

  if (p === '/api/plugins/kanban/board' && method === 'GET') {
    return ok({ columns: COLUMNS.map((name) => ({ name, tasks: taskList().filter((t) => t.status === name) })) })
  }
  if (p === '/api/plugins/kanban/boards' && method === 'GET') {
    return ok({ boards: [{ slug: 'default', name: 'Default', total: taskList().length, is_current: true }], current: 'default' })
  }
  if (p === '/api/plugins/kanban/tasks' && method === 'POST') {
    const task: DemoTask = {
      id: `t-demo-${taskSeq++}`,
      title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled task',
      status: 'todo',
      assignee: typeof body?.assignee === 'string' ? body.assignee : null,
      body: typeof body?.body === 'string' ? body.body : null,
    }
    taskList().unshift(task)
    return ok({ task: { id: task.id } })
  }
  const task = p.match(/^\/api\/plugins\/kanban\/tasks\/([^/]+)$/)
  if (task && method === 'PATCH') {
    const row = taskList().find((t) => t.id === decodeURIComponent(task[1]!))
    if (!row) return { ok: false, status: 404, error: 'task not found' }
    if (typeof body?.status === 'string') row.status = body.status
    if (typeof body?.assignee === 'string' || body?.assignee === null) row.assignee = (body.assignee as string | null) ?? null
    return ok({ ok: true })
  }

  if (p === '/api/sessions' && method === 'GET') {
    const list = sessionList()
    return ok({ sessions: list, total: list.length })
  }
  if (p === '/api/sessions/search' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').toLowerCase()
    const results = sessionList()
      .filter((s) => `${s.title} ${s.preview}`.toLowerCase().includes(q))
      .map((s) => ({ ...s, snippet: s.preview }))
    return ok({ results })
  }
  const sess = p.match(/^\/api\/sessions\/([^/]+)(\/messages|\/export)?$/)
  if (sess) {
    const id = decodeURIComponent(sess[1]!)
    const tail = sess[2]
    if (tail === '/messages' && method === 'GET') {
      return ok({
        messages: [
          { role: 'user', content: 'Morning briefing' },
          { role: 'assistant', content: '**Overnight**\n\n- Two deploys finished, both healthy.\n- No open incidents.\n- One email is waiting on you.' },
        ],
      })
    }
    const row = sessionList().find((s) => s.id === id)
    if (!row) return { ok: false, status: 404, error: 'session not found' }
    if (tail === '/export' && method === 'GET') return ok({ ...row, messages: [] })
    if (!tail && method === 'PATCH') {
      if (typeof body?.title === 'string') row.title = body.title
      return ok({ title: row.title })
    }
    if (!tail && method === 'DELETE') {
      sessions = sessionList().filter((s) => s.id !== id)
      return ok({ ok: true })
    }
  }
  return null
}
