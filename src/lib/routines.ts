/**
 * Routines = Grok-named scheduled jobs (Hermes cron).
 *
 * New routines use native REST only. Legacy CLI jobs and local drafts remain
 * readable/editable, but cannot conceal a failed or ambiguously accepted create.
 */

import {
  createServeCron,
  deleteServeCron,
  listServeCronJobs,
  pauseServeCron,
  resumeServeCron,
  triggerServeCron,
  updateServeCron,
  type ServeCronJob,
} from './hermes-rest'
import { isHostedAgent } from './agent-rest'
import { track } from './analytics'
import { LOCAL_DELIVERY, isRunOnce, jobSkills, repeatUpdateValue } from './routine-cron'

const STORAGE_KEY = 'maia:routines:v1'
const SCHEMA_VERSION = 1

export const SCHEDULE_PRESETS = [
  { key: 'hourly', label: 'Every hour', expr: '0 * * * *' },
  { key: 'daily', label: 'Every day', expr: '0 9 * * *' },
  { key: 'weekdays', label: 'Weekdays', expr: '0 9 * * 1-5' },
  { key: 'weekly', label: 'Every week', expr: '0 9 * * 1' },
  { key: 'monthly', label: 'Every month', expr: '0 9 1 * *' },
] as const

export type SchedulePresetKey = (typeof SCHEDULE_PRESETS)[number]['key'] | 'custom'

export type RoutineOrigin = 'remote' | 'hermes' | 'local'

export interface Routine {
  id: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  agentId?: string | null
  origin: RoutineOrigin
  profile?: string
  schedulerHeartbeatAge?: number | null
  lastRunAt?: string | null
  nextRunAt?: string | null
  /** Where results go: `local` (Nub Agent only) or a platform id. Remote jobs only. */
  deliver?: string
  /** Where failure alerts go; null/undefined = same as `deliver`. */
  failureDeliver?: string | null
  /** true = hermes `repeat.times === 1`. */
  runOnce?: boolean
  skills?: string[]
  /** Remote jobs: the agent's last run outcome (`ok` | `error` | `delivery_failed`). */
  lastStatus?: string | null
  lastError?: string | null
  /** Remote jobs: when the run in progress started, else null (see routineRunningSince). */
  runningSince?: string | null
  /** The agent's own wording of the schedule when it differs from `schedule`
   *  ("weekday mornings" over a cron we can't word): shown in its place. */
  scheduleLabel?: string
}

/** Extra fields are optional: undefined ⇒ leave the job's value untouched. */
export interface RoutineDraft {
  id?: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  agentId?: string | null
  deliver?: string
  /** null clears the override (failures follow `deliver`). */
  failureDeliver?: string | null
  runOnce?: boolean
  skills?: string[]
  /** One editor opening's create intent; retains a known receipt across partial saves. */
  creationKey?: string
}

interface PersistEnvelope {
  schemaVersion: number
  savedAt: string
  jobs: Routine[]
}

/** Routine ids are only unique within one origin (agent / host / draft). */
export function sameRoutine(a: Pick<Routine, 'id' | 'origin' | 'profile'>, b: Pick<Routine, 'id' | 'origin' | 'profile'>): boolean {
  return a.id === b.id && a.origin === b.origin && (a.profile ?? 'default') === (b.profile ?? 'default')
}

/** The editable fields of a routine, for test runs and run now. */
export function routineDraftOf(job: Routine): RoutineDraft {
  return { id: job.id, name: job.name, prompt: job.prompt, schedule: job.schedule, enabled: job.enabled, agentId: job.agentId }
}

export function formatCronSchedule(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    const o = value as { display?: unknown; expr?: unknown; kind?: unknown }
    const display = typeof o.display === 'string' ? o.display.trim() : ''
    if (display) return display
    const expr = typeof o.expr === 'string' ? o.expr.trim() : ''
    if (expr) return expr
    const kind = typeof o.kind === 'string' ? o.kind.trim() : ''
    return kind
  }
  return String(value)
}

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clockLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${tail}`
}

const isInt = (s: string, lo: number, hi: number) => /^\d+$/.test(s) && +s >= lo && +s <= hi

/**
 * A schedule in words for lists ("Weekdays at 8:28 PM", "Every 30 minutes").
 * Covers the shapes the editor and templates write: plain 5-field cron with
 * a fixed time, hourly/minute steps, and hermes intervals ("every 2h").
 * Anything else comes back as written, so a row never shows a wrong guess.
 */
/** "Mon, Oct 5, 2:30 PM" in the device's timezone (year when not this year). */
function formatOnceLocal(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** An ISO instant with a zone (what the editor sends for Once) is exact. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

export function describeCronSchedule(value: unknown): string {
  // The agent's own `display` ("every day at 9am") is written its way; when
  // the expression behind it is a shape we can word, word it like the rest.
  if (value && typeof value === 'object') {
    const expr = (value as { expr?: unknown }).expr
    if (typeof expr === 'string' && expr.trim()) {
      const worded = describeCronText(expr.trim())
      if (worded !== expr.trim()) return worded
    }
    // The agent's sentence, started like ours ("Every day at 9am").
    const shown = describeCronText(formatCronSchedule(value))
    return /^[a-z]/.test(shown) && /\s/.test(shown) ? shown[0]!.toUpperCase() + shown.slice(1) : shown
  }
  return describeCronText(formatCronSchedule(value))
}

function describeCronText(raw: string): string {
  if (ISO_INSTANT.test(raw)) {
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return `Once on ${formatOnceLocal(at)}`
  }
  const every = /^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(raw)
  if (every) {
    let n = Number(every[1])
    const unit = every[2]!.toLowerCase()
    let word = unit.startsWith('m') ? 'minute' : unit.startsWith('h') ? 'hour' : 'day'
    // "every 60m" reads as "Every hour", "every 48h" as "Every 2 days".
    if (word === 'minute' && n >= 60 && n % 60 === 0) [n, word] = [n / 60, 'hour']
    if (word === 'hour' && n >= 24 && n % 24 === 0) [n, word] = [n / 24, 'day']
    return n === 1 ? `Every ${word}` : `Every ${n} ${word}s`
  }
  const f = raw.split(/\s+/)
  if (f.length !== 5) return raw
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string]
  if (mon !== '*') return raw
  const step = /^\*\/(\d+)$/.exec(min)
  if (step && hour === '*' && dom === '*' && dow === '*') return describeCronText(`every ${step[1]}m`)
  if (isInt(min, 0, 59) && hour === '*' && dom === '*' && dow === '*') {
    return min === '0' ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`
  }
  if (!isInt(min, 0, 59) || !isInt(hour, 0, 23)) return raw
  const at = clockLabel(Number(hour), Number(min))
  if (dom === '*' && dow === '*') return `Every day at ${at}`
  if (dom === '*') {
    if (dow === '1-5') return `Weekdays at ${at}`
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`
    if (isInt(dow, 0, 7)) return `${DAY_NAMES[Number(dow) % 7]} at ${at}`
    if (/^[0-7](,[0-7])+$/.test(dow)) return `${dow.split(',').map((d) => DAY_SHORT[Number(d) % 7]).join(', ')} at ${at}`
    return raw
  }
  if (dow === '*' && isInt(dom, 1, 31)) return `Monthly on the ${ordinal(Number(dom))} at ${at}`
  return raw
}

export function coerceCronJobs(data: unknown): ServeCronJob[] {
  if (Array.isArray(data)) return data as ServeCronJob[]
  if (data && typeof data === 'object') {
    const o = data as { jobs?: unknown; items?: unknown }
    if (Array.isArray(o.jobs)) return o.jobs as ServeCronJob[]
    if (Array.isArray(o.items)) return o.items as ServeCronJob[]
  }
  if (typeof data === 'string') return parseCronListText(data)
  return []
}

/** Parse `hermes cron list` table output. */
export function parseCronListText(text: string): ServeCronJob[] {
  const jobs: ServeCronJob[] = []
  const re = /^ {2}([0-9a-f]{8,}) \[([^\]]+)\]\s*$/gim
  const matches = [...text.matchAll(re)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    const start = m.index ?? 0
    const end = matches[i + 1]?.index ?? text.length
    const block = text.slice(start, end)
    const field = (label: string): string => {
      const fm = block.match(new RegExp(`^\\s+${label}:\\s*(.+)$`, 'im'))
      return fm?.[1]?.trim() ?? ''
    }
    const timestamp = (label: string): string | null => {
      const value = field(label)
      return value && Number.isFinite(Date.parse(value)) ? value : null
    }
    const status = (m[2] || '').toLowerCase()
    jobs.push({
      id: m[1]!,
      name: field('Name') || m[1],
      schedule: field('Schedule'),
      prompt: field('Prompt') || field('Instruction'),
      enabled: status === 'active' || status === 'scheduled',
      next_run_at: timestamp('Next run'),
      last_run_at: timestamp('Last run'),
    })
  }
  return jobs
}

/** hermes-agent heartbeats a running job's `fire_claim` and lets it lapse
 *  after 300s (cron/constants.py FIRE_CLAIM_TTL_SECONDS); a claim older
 *  than this belongs to a run that died. */
const FIRE_CLAIM_STALE_MS = 6 * 60_000
/** A manual run that never got claimed stops counting as running. */
const MANUAL_RUN_STALE_MS = 30 * 60_000

/**
 * When the job's current run started, or null when nothing is running. The
 * agent stamps a live run with `fire_claim: {by, at}` (heartbeated, cleared
 * when the run records its outcome) and a Run now with `manual_run_at`
 * (cleared with the outcome too), so both scheduled and manual runs show.
 */
export function routineRunningSince(job: ServeCronJob, now = Date.now()): string | null {
  const claim = job.fire_claim as { at?: unknown } | null | undefined
  const claimAt = claim && typeof claim.at === 'string' ? Date.parse(claim.at) : NaN
  if (Number.isFinite(claimAt) && now - claimAt < FIRE_CLAIM_STALE_MS) {
    const manual = typeof job.manual_run_at === 'string' ? Date.parse(job.manual_run_at) : NaN
    // The claim heartbeat moves `at`; a manual start is the truer "since".
    return new Date(Number.isFinite(manual) && manual <= claimAt ? manual : claimAt).toISOString()
  }
  const manual = typeof job.manual_run_at === 'string' ? Date.parse(job.manual_run_at) : NaN
  if (Number.isFinite(manual) && now - manual < MANUAL_RUN_STALE_MS) {
    const last = typeof job.last_run_at === 'string' ? Date.parse(job.last_run_at) : NaN
    if (!Number.isFinite(last) || last < manual) return new Date(manual).toISOString()
  }
  return null
}

/** The schedule as the editor edits it: a cron job's expression, not the
 *  label the agent may have given it ("every day at 9am" over `0 9 * * *`),
 *  which the picker can't read and Save would send back as the schedule. */
function editableSchedule(value: unknown): string {
  if (value && typeof value === 'object') {
    const o = value as { kind?: unknown; expr?: unknown }
    if ((o.kind === undefined || o.kind === 'cron') && typeof o.expr === 'string' && o.expr.trim()) return o.expr.trim()
  }
  return formatCronSchedule(value)
}

export function serveJobToRoutine(job: ServeCronJob, origin: RoutineOrigin): Routine {
  const schedule = editableSchedule(job.schedule) || formatCronSchedule(job.schedule_display)
  const label = formatCronSchedule(job.schedule) || formatCronSchedule(job.schedule_display)
  return {
    id: String(job.id),
    name: (job.name?.trim() || String(job.id)).trim(),
    prompt: typeof job.prompt === 'string' ? job.prompt : '',
    schedule,
    enabled: job.enabled !== false,
    origin,
    ...(typeof job.profile === 'string' ? { profile: job.profile, agentId: `profile:${job.profile}` } : {}),
    schedulerHeartbeatAge: typeof job.scheduler_heartbeat_age_s === 'number' ? job.scheduler_heartbeat_age_s : null,
    lastRunAt: typeof job.last_run_at === 'string' ? job.last_run_at : null,
    nextRunAt: typeof job.next_run_at === 'string' ? job.next_run_at : null,
    ...(origin === 'remote' ? remoteExtras(job) : {}),
    ...(label && label !== schedule ? { scheduleLabel: label } : {}),
  }
}

function remoteExtras(
  job: ServeCronJob,
): Pick<Routine, 'deliver' | 'failureDeliver' | 'runOnce' | 'skills' | 'lastStatus' | 'lastError' | 'runningSince'> {
  const failure = typeof job.failure_deliver === 'string' && job.failure_deliver.trim() ? job.failure_deliver.trim() : null
  return {
    deliver: typeof job.deliver === 'string' && job.deliver.trim() ? job.deliver.trim() : LOCAL_DELIVERY,
    failureDeliver: failure,
    runOnce: isRunOnce(job.repeat),
    skills: jobSkills(job),
    lastStatus: typeof job.last_status === 'string' ? job.last_status : null,
    lastError: typeof job.last_error === 'string' && job.last_error.trim() ? job.last_error.trim() : null,
    runningSince: routineRunningSince(job),
  }
}

/** PUT /api/cron/jobs/{id} `updates` for the draft's extra fields (only the
 *  ones the draft sets). */
export function extraCronUpdates(draft: RoutineDraft): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  if (draft.deliver !== undefined) updates.deliver = draft.deliver || LOCAL_DELIVERY
  if (draft.failureDeliver !== undefined) updates.failure_deliver = draft.failureDeliver || null
  if (draft.runOnce !== undefined) updates.repeat = repeatUpdateValue(draft.runOnce)
  if (draft.skills !== undefined) updates.skills = draft.skills
  return updates
}

function pickExtras(draft: RoutineDraft): Partial<Routine> {
  const out: Partial<Routine> = {}
  if (draft.deliver !== undefined) out.deliver = draft.deliver || LOCAL_DELIVERY
  if (draft.failureDeliver !== undefined) out.failureDeliver = draft.failureDeliver || null
  if (draft.runOnce !== undefined) out.runOnce = draft.runOnce
  if (draft.skills !== undefined) out.skills = draft.skills
  return out
}

/** `pickExtras` minus what `hermesCliExtraArgs` can't send (clearing run-once
 *  or the failure target), so the row reports what the job actually stores. */
function hermesCliExtras(draft: RoutineDraft): Partial<Routine> {
  const out = pickExtras(draft)
  if (out.runOnce === false) delete out.runOnce
  if (out.failureDeliver === null) delete out.failureDeliver
  return out
}

export function presetForSchedule(schedule: string): SchedulePresetKey {
  const trimmed = schedule.trim()
  const hit = SCHEDULE_PRESETS.find((p) => p.expr === trimmed)
  return hit?.key ?? 'custom'
}

// ---------------------------------------------------------------------------
// Schedule picker (the editor's "When" row) ↔ cron
// ---------------------------------------------------------------------------

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'once'

/** Everything the "When" row can hold. Fields a frequency doesn't use are
 *  kept, so switching Daily → Weekly → Daily keeps the chosen time. */
export interface SchedulePicker {
  frequency: ScheduleFrequency
  hour: number
  minute: number
  /** Cron weekday numbers (0 = Sunday). Weekly only. */
  weekdays: number[]
  /** 1–31. Monthly only. */
  dayOfMonth: number
  /** Local `YYYY-MM-DD`. Once only. */
  date: string
}

/** Defaults reproduce the old preset chips exactly (`0 9 * * *`, `0 9 * * 1`, …). */
export const DEFAULT_SCHEDULE_PICKER: SchedulePicker = {
  frequency: 'daily',
  hour: 9,
  minute: 0,
  weekdays: [1],
  dayOfMonth: 1,
  date: '',
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD` for a timestamp. */
export function localDateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function splitDateKey(date: string): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
  return { y, mo, d }
}

/** When a Once picker fires (local ms), or null when the date is unset/invalid. */
export function onceRunAt(p: SchedulePicker): number | null {
  const parts = splitDateKey(p.date)
  if (!parts) return null
  const at = new Date(parts.y, parts.mo - 1, parts.d, p.hour, p.minute, 0, 0)
  // Date normalizes nonexistent local times (e.g. the spring-forward gap).
  if (at.getHours() !== p.hour || at.getMinutes() !== p.minute || localDateKey(at.getTime()) !== p.date) return null
  return at.getTime()
}

/**
 * A routine's name as people read it. Agents often name jobs like files
 * ("repo-watcher-fastlane"): a name with no spaces reads as words
 * ("Repo watcher fastlane"). Names with spaces are the user's own and only
 * get a capital first letter. Display only; the stored name never changes.
 */
export function displayRoutineName(job: { name?: string | null; id?: string }): string {
  const raw = job.name?.trim() || ''
  // A job saved without a name carries its id as the name.
  if (!raw || raw === job.id) return 'Untitled routine'
  const words = /\s/.test(raw) ? raw : raw.replace(/[-_]+/g, ' ').trim() || raw
  return words[0]!.toUpperCase() + words.slice(1)
}

/** A routine's schedule in words. A one-shot job's stored display is the
 *  agent's "once at YYYY-MM-DD HH:MM" in UTC, so it reads from the agent's
 *  authoritative next run in the device's timezone instead. */
export function describeRoutineSchedule(job: {
  schedule: unknown
  nextRunAt?: string | null
  scheduleLabel?: string
}): string {
  const raw = formatCronSchedule(job.schedule)
  const next = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN
  if (/^once (at|in)\b/i.test(raw) && Number.isFinite(next)) return `Once on ${formatOnceLocal(next)}`
  const worded = describeCronSchedule(job.schedule)
  const label = job.scheduleLabel?.trim()
  // Raw cron we can't word: the agent's own sentence reads better.
  if (worded === raw && label) return label[0]!.toUpperCase() + label.slice(1)
  return worded
}

/** Recurrences use cron; Once uses an absolute ISO instant so the selected
 *  year and device-local time survive the agent's timezone setting. */
export function pickerToCron(p: SchedulePicker): string {
  const m = p.minute
  const h = p.hour
  switch (p.frequency) {
    case 'hourly':
      return `${m} * * * *`
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly': {
      const days = [...new Set(p.weekdays.map((d) => d % 7))].sort((a, b) => a - b)
      return `${m} ${h} * * ${days.length ? days.join(',') : '1'}`
    }
    case 'monthly':
      return `${m} ${h} ${p.dayOfMonth} * *`
    case 'once': {
      const at = onceRunAt(p)
      return at == null ? '' : new Date(at).toISOString()
    }
  }
}

/**
 * Reads a schedule back into the picker. Null means it doesn't fit a preset
 * (the editor shows it as a custom cron). A run-once job becomes Once at its
 * next run time, which is when hermes will fire it.
 */
export function pickerFromSchedule(
  schedule: string,
  opts: { runOnce?: boolean; now?: number; nextRunAt?: string | null } = {},
): SchedulePicker | null {
  const s = schedule.trim()
  const now = opts.now ?? Date.now()
  const f = s.split(/\s+/)
  const five = f.length === 5 ? (f as [string, string, string, string, string]) : null

  if (opts.runOnce) {
    const stored = opts.nextRunAt ? Date.parse(opts.nextRunAt) : NaN
    let at: number | null = Number.isFinite(stored) ? stored : null
    if (
      at == null &&
      five &&
      isInt(five[0], 0, 59) &&
      isInt(five[1], 0, 23) &&
      isInt(five[2], 1, 31) &&
      isInt(five[3], 1, 12) &&
      five[4] === '*'
    ) {
      // A fixed date: its next occurrence, this year or next.
      const [min, hour, dom, mon] = five.slice(0, 4).map(Number) as [number, number, number, number]
      const year = new Date(now).getFullYear()
      for (const y of [year, year + 1]) {
        const t = new Date(y, mon - 1, dom, hour, min, 0, 0)
        if (t.getMonth() === mon - 1 && t.getTime() > now) {
          at = t.getTime()
          break
        }
      }
    } else if (at == null && s && parseInterval(s) == null) {
      at = nextRunAt(s, now)
    }
    if (at == null) return null
    const d = new Date(at)
    return { ...DEFAULT_SCHEDULE_PICKER, frequency: 'once', hour: d.getHours(), minute: d.getMinutes(), date: localDateKey(at) }
  }

  if (!five) return null
  const [min, hour, dom, mon, dow] = five
  if (mon !== '*' || !isInt(min, 0, 59)) return null
  const minute = Number(min)
  if (hour === '*') {
    return dom === '*' && dow === '*' ? { ...DEFAULT_SCHEDULE_PICKER, frequency: 'hourly', minute } : null
  }
  if (!isInt(hour, 0, 23)) return null
  const base = { ...DEFAULT_SCHEDULE_PICKER, hour: Number(hour), minute }
  if (dom === '*' && dow === '*') return { ...base, frequency: 'daily' }
  if (dom === '*') {
    if (dow === '1-5') return { ...base, frequency: 'weekdays' }
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))].sort((a, b) => a - b)
      return { ...base, frequency: 'weekly', weekdays: days }
    }
    return null
  }
  if (dow === '*' && isInt(dom, 1, 31)) return { ...base, frequency: 'monthly', dayOfMonth: Number(dom) }
  return null
}

/** One line for the picker ("Weekdays at 8:28 PM", "Once on Oct 5, 2026 at 2:30 PM"). */
export function describePicker(p: SchedulePicker): string {
  if (p.frequency === 'once') {
    const parts = splitDateKey(p.date)
    if (!parts) return 'Once (pick a date)'
    return `Once on ${MONTH_SHORT[parts.mo - 1]} ${parts.d}, ${parts.y} at ${clockLabel(p.hour, p.minute)}`
  }
  return describeCronSchedule(pickerToCron(p))
}

/** Loose shape check for a hand-typed schedule: 5/6-field cron, a hermes
 *  interval (`30m`, `every 2h`) or an ISO date. The agent validates for real. */
export function isPlausibleSchedule(schedule: string): boolean {
  const s = schedule.trim()
  if (!s) return false
  if (/^every\s+\d+\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.test(s)) return true
  if (/^\d+\s*(m|min|h|hr|d)$/i.test(s)) return true
  if (ISO_SCHEDULE.test(s)) return true
  const fields = s.split(/\s+/)
  return (fields.length === 5 || fields.length === 6) && fields.every((x) => /^[\w*/,?#-]+$/.test(x))
}

const ISO_SCHEDULE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Hard horizon for recurring-run prediction; explicit ISO dates are exact. */
export const NEXT_RUN_CAP_MS = 366 * 86_400_000

/** Memo of cron nextRunAt per (schedule, minute-bucket) — the ticker + list
 *  rendering call this for every row on every tick. */
const nextRunCache = new Map<string, number | null>()
const NEXT_RUN_CACHE_MAX = 500

/** Arithmetic fast path for the 5 shipped presets (no minute scan). */
function presetNextRun(expr: string, fromMs: number): number | null {
  if (expr === '0 * * * *') {
    const d = new Date(fromMs)
    d.setSeconds(0, 0)
    d.setMinutes(0)
    let t = d.getTime()
    if (t <= fromMs) t += 3_600_000
    return t
  }
  if (
    expr === '0 9 * * *' ||
    expr === '0 9 * * 1-5' ||
    expr === '0 9 * * 1' ||
    expr === '0 9 1 * *'
  ) {
    const d = new Date(fromMs)
    d.setHours(9, 0, 0, 0)
    for (let i = 0; i < 366; i++) {
      const t = d.getTime()
      if (t > fromMs) {
        const dow = d.getDay()
        const day = d.getDate()
        if (expr === '0 9 * * *') return t
        if (expr === '0 9 * * 1-5' && dow >= 1 && dow <= 5) return t
        if (expr === '0 9 * * 1' && dow === 1) return t
        if (expr === '0 9 1 * *' && day === 1) return t
      }
      d.setDate(d.getDate() + 1)
    }
    return null
  }
  return null
}

export function nextRunAt(schedule: string, fromMs = Date.now()): number | null {
  const s = schedule.trim()
  if (!s) return null
  if (ISO_SCHEDULE.test(s)) {
    const at = Date.parse(s)
    return Number.isFinite(at) && at > fromMs ? at : null
  }
  // Intervals follow the exact anchor; only cron is stable within a minute.
  const interval = parseInterval(s)
  if (interval != null) return interval <= NEXT_RUN_CAP_MS ? fromMs + interval : null
  const key = `${s}|${Math.floor(fromMs / 60_000)}`
  const hit = nextRunCache.get(key)
  if (hit !== undefined) return hit
  const computed = nextRunAtUncached(s, fromMs)
  const capped = computed != null && computed - fromMs > NEXT_RUN_CAP_MS ? null : computed
  if (nextRunCache.size >= NEXT_RUN_CACHE_MAX) {
    const oldest = nextRunCache.keys().next()
    if (!oldest.done) nextRunCache.delete(oldest.value)
  }
  nextRunCache.set(key, capped)
  return capped
}

function nextRunAtUncached(s: string, fromMs: number): number | null {
  const preset = presetNextRun(s, fromMs)
  if (preset != null) return preset
  const cron = parseFiveFieldCron(s)
  if (!cron || !cronCanOccur(cron)) return null
  const t = new Date(fromMs + 60_000)
  t.setSeconds(0, 0)
  const end = t.getTime() + 366 * 86_400_000
  // Skip whole months, days and hours that cannot match instead of testing
  // every minute of the year. Minute steps stay in absolute time, so the
  // repeated hour of a DST fall-back is still visited.
  while (t.getTime() <= end) {
    if (!cron.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
    } else if (!cronDayMatches(cron, t)) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
    } else if (!cron.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
    } else if (!cron.minute.has(t.getMinutes()) || repeatedWallClock(cron, t)) {
      t.setTime(t.getTime() + 60_000)
    } else {
      return t.getTime()
    }
  }
  return null
}

/** A fixed-hour job runs once on a DST fall-back day, not again when the
 *  clock replays that hour (as cron does). */
function repeatedWallClock(fields: CronFields, t: Date): boolean {
  if (fields.hour.size === 24) return false
  const hourEarlier = new Date(t.getTime() - 3_600_000)
  return hourEarlier.getHours() === t.getHours() && hourEarlier.getMinutes() === t.getMinutes()
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** False for dates that never exist (e.g. `0 0 30 2 *`). */
function cronCanOccur(fields: CronFields): boolean {
  if (fields.day.size === 31 || fields.weekday.size !== 7) return true
  return [...fields.month].some((month) => [...fields.day].some((day) => day <= MONTH_DAYS[month - 1]!))
}

function parseInterval(schedule: string): number | null {
  const every = schedule.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)\s*$/i)
  const short = schedule.match(/^(\d+)\s*(m|min|h|hr|d)\s*$/i)
  const m = every || short
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2].toLowerCase()
  if (unit.startsWith('m')) return n * 60_000
  if (unit.startsWith('h')) return n * 3_600_000
  return n * 86_400_000
}

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
}

function parseFiveFieldCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  try {
    return {
      minute: cronField(parts[0]!, 0, 59),
      hour: cronField(parts[1]!, 0, 23),
      day: cronField(parts[2]!, 1, 31),
      month: cronField(parts[3]!, 1, 12, MONTH_NAMES),
      // Cron accepts 7 as Sunday too; `*` still means 0-6.
      weekday: new Set([...cronField(parts[4]!, 0, 7, WEEKDAY_NAMES, 6)].map((d) => d % 7)),
    }
  } catch {
    return null
  }
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function cronField(raw: string, min: number, max: number, names?: string[], starMax = max): Set<number> {
  const out = new Set<number>()
  // Names (MON, jan) stand for their numbers; months count from 1.
  if (names) raw = raw.replace(/[a-z]{3}/gi, (name) => {
    const index = names.indexOf(name.toLowerCase())
    return index < 0 ? name : String(index + min)
  })
  for (const piece of raw.split(',')) {
    const stepParts = piece.split('/')
    const range = stepParts[0]!
    const step = stepParts[1] ? Number(stepParts[1]) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error('bad step')
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = starMax
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = hi = Number(range)
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error('bad range')
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

function cronDayMatches(fields: CronFields, t: Date): boolean {
  const dow = t.getDay()
  const dayOk = fields.day.has(t.getDate())
  const dowOk = fields.weekday.has(dow)
  const dayFieldStar = fields.day.size === 31
  const dowFieldStar = fields.weekday.size === 7
  return dayFieldStar && dowFieldStar ? true : dayFieldStar ? dowOk : dowFieldStar ? dayOk : dayOk || dowOk
}

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

export function loadLocalRoutines(): Routine[] {
  if (!canUseStorage()) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PersistEnvelope
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.jobs)) return []
    return parsed.jobs.filter((j) => j && typeof j.id === 'string')
  } catch {
    return []
  }
}

export function saveLocalRoutines(jobs: Routine[]): void {
  if (!canUseStorage()) return
  const envelope: PersistEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    jobs: jobs.filter((j) => j.origin === 'local'),
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    /* quota / private mode */
  }
}

/** Content identity across origins — a local draft duplicating a synced job
 *  (same name + schedule + prompt, different id) is the same routine. */
function routineContentKey(j: Routine): string {
  const parts = [j.name.trim().toLowerCase(), j.schedule.trim(), j.prompt.trim()]
  return parts.join('|')
}

export function mergeRoutines(remote: Routine[], local: Routine[]): Routine[] {
  const ids = new Set(remote.map((j) => j.id))
  const content = new Set(remote.map(routineContentKey))
  return [
    ...remote,
    ...local.filter((j) => !ids.has(j.id) && !content.has(routineContentKey(j))),
  ]
}

type HermesCliBridge = (kind: string, args: string[]) => Promise<{ ok: boolean; data?: unknown }>

function hermesCliBridge(): HermesCliBridge | null {
  const w = window as unknown as { nubAgent?: { hermes?: HermesCliBridge } }
  return w.nubAgent?.hermes ?? null
}

/** Job id from `hermes cron create` output (`Created job: <id>`). */
export function parseCreatedJobId(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return text.match(/^Created job:\s*([0-9a-f]{8,})\s*$/im)?.[1] ?? null
}

/** Flags for the draft's extra fields — the CLI subset of `extraCronUpdates`.
 *  `--repeat` is int-only, so run-once can be set but not cleared, and a
 *  null failure target (follow `deliver`) has no CLI spelling. */
export function hermesCliExtraArgs(draft: RoutineDraft, mode: 'create' | 'edit'): string[] {
  const args: string[] = []
  if (mode === 'create' || draft.deliver !== undefined) {
    args.push('--deliver', draft.deliver || LOCAL_DELIVERY)
  }
  if (draft.failureDeliver) args.push('--failure-deliver', draft.failureDeliver)
  if (draft.runOnce) args.push('--repeat', '1')
  if (draft.skills !== undefined) {
    if (draft.skills.length) for (const s of draft.skills) args.push('--skill', s)
    else if (mode === 'edit') args.push('--clear-skills')
  }
  return args
}

async function listHermesCliJobs(): Promise<ServeCronJob[] | null> {
  const bridge = hermesCliBridge()
  if (!bridge) return null
  try {
    const res = await bridge('cron', ['list'])
    if (!res.ok) return null
    const jobs = coerceCronJobs(res.data)
    return jobs
  } catch {
    return null
  }
}

async function updateHermesCliJob(id: string, draft: RoutineDraft, existing: Routine): Promise<boolean> {
  const bridge = hermesCliBridge()
  if (!bridge) return false
  try {
    const args = ['edit', id, '--name', draft.name.trim()]
    if (draft.schedule.trim() !== existing.schedule.trim()) args.push('--schedule', draft.schedule.trim())
    if (draft.prompt.trim()) args.push('--prompt', draft.prompt.trim())
    args.push(...hermesCliExtraArgs(draft, 'edit'))
    const res = await bridge('cron', args)
    if (!res.ok) return false
    if (draft.enabled !== existing.enabled) {
      const toggled = await bridge('cron', [draft.enabled ? 'resume' : 'pause', id])
      return toggled.ok
    }
    return true
  } catch {
    return false
  }
}

async function deleteHermesCliJob(id: string): Promise<boolean> {
  const bridge = hermesCliBridge()
  if (!bridge) return false
  try {
    const res = await bridge('cron', ['delete', id])
    if (res.ok) return true
    const fallback = await bridge('cron', ['remove', id])
    return fallback.ok
  } catch {
    return false
  }
}

export async function loadRoutines(): Promise<{
  jobs: Routine[]
  /** `unreachable`: linked to a hosted agent whose scheduler didn't answer. */
  source: 'remote' | 'hermes' | 'local' | 'unreachable'
}> {
  const local = loadLocalRoutines()
  const rest = await listServeCronJobs()
  if (rest) {
    return { jobs: mergeRoutines(rest.map((j) => serveJobToRoutine(j, 'remote')), local), source: 'remote' }
  }
  // A hosted agent that is down must not be papered over with this
  // computer's own `hermes cron` jobs — they'd list as the agent's routines
  // (ROUTINE_ORIGIN_FIX_PLAN). Only local drafts remain, flagged unreachable.
  if (await isHostedAgent()) return { jobs: local, source: 'unreachable' }
  const cli = await listHermesCliJobs()
  if (cli) {
    return { jobs: mergeRoutines(cli.map((j) => serveJobToRoutine(j, 'hermes')), local), source: 'hermes' }
  }
  return { jobs: local, source: 'local' }
}

function newLocalId(): string {
  const bytes = new Uint8Array(6)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return `rt-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export async function upsertRoutine(draft: RoutineDraft, existing?: Routine | null): Promise<Routine> {
  const saved = await saveRoutine(draft, existing)
  if (!existing) track('routine_created', { origin: saved.origin })
  return saved
}

async function saveRoutine(draft: RoutineDraft, existing?: Routine | null): Promise<Routine> {
  const name = draft.name.trim() || 'Untitled routine'
  const schedule = draft.schedule.trim() || '0 9 * * *'
  const prompt = draft.prompt.trim()
  const enabled = draft.enabled !== false
  const next = nextRunAt(schedule)
  const nextIso = next ? new Date(next).toISOString() : null

  if (existing && (existing.origin === 'remote' || existing.origin === 'hermes')) {
    if (existing.origin === 'remote') {
      // Sending an unchanged schedule resets an interval's execution anchor.
      const ok = await updateServeCron(existing.id, {
        name, prompt,
        ...(schedule !== existing.schedule.trim() ? { schedule } : {}),
        ...extraCronUpdates(draft),
      }, ...(existing.profile ? [existing.profile] : []))
      if (!ok) throw new Error('Couldn’t update this routine on the agent.')
      if (enabled !== existing.enabled) {
        const toggled = enabled ? await resumeServeCron(existing.id, existing.profile) : await pauseServeCron(existing.id, existing.profile)
        if (!toggled) throw new Error(`The routine was updated, but couldn’t be ${enabled ? 'resumed' : 'paused'}.`)
      }
    } else {
      // Hermes-origin jobs live behind the Electron `hermes cron` bridge.
      // Fail loudly: returning the new values after a failed edit would show
      // an edit the scheduler never received.
      const ok = await updateHermesCliJob(existing.id, { ...draft, name, prompt, schedule, enabled }, existing)
      if (!ok) throw new Error("Couldn't update this routine on this computer.")
    }
    return {
      ...existing,
      name,
      prompt,
      schedule,
      enabled,
      agentId: existing.origin === 'remote' ? existing.agentId : draft.agentId ?? existing.agentId,
      nextRunAt: schedule === existing.schedule.trim() && enabled === existing.enabled ? existing.nextRunAt ?? null : null,
      ...(existing.origin === 'remote' ? pickExtras(draft) : hermesCliExtras(draft)),
    }
  }

  if (!existing) {
    const profile = draft.agentId?.startsWith('profile:') ? draft.agentId.slice('profile:'.length) : 'default'
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Select a valid local profile.')
    // Stage follow-up-only settings while paused, so a due job cannot race setup.
    const staged = Boolean(draft.failureDeliver)
    const remote = await createServeCron({
      name,
      prompt,
      schedule,
      deliver: draft.deliver || LOCAL_DELIVERY,
      skills: draft.skills,
      profile,
      paused: !enabled || staged,
      ...(draft.runOnce ? { repeat: 1 } : {}),
      ...(draft.creationKey ? { requestId: draft.creationKey } : {}),
    })
    if (remote?.id) {
      if (remote.profile && remote.profile !== profile) throw new Error('Hermes returned a different routine owner. Check Routines before trying again.')
      if ((!enabled || staged) && remote.enabled !== false)
        throw new Error('Hermes did not confirm paused creation. Check Routines and pause this job before trying again.')
      if (draft.runOnce && !isRunOnce(remote.repeat))
        throw new Error('Hermes did not confirm the run-once setting. Check the saved routine before trying again.')
      const followUp: Record<string, unknown> = {}
      if (draft.failureDeliver) followUp.failure_deliver = draft.failureDeliver
      const followUpOk = Object.keys(followUp).length
        ? await updateServeCron(String(remote.id), followUp, profile)
        : true
      if (!followUpOk) throw new Error('The routine was created paused, but its failure target was not confirmed. Check Routines, or retry this save to finish the same job.')
      if (staged && enabled && !(await resumeServeCron(remote.id, profile)))
        throw new Error('The routine was saved paused, but resuming was not confirmed. Check Routines before running it.')
      return { ...serveJobToRoutine(remote, 'remote'), ...pickExtras(draft), profile, agentId: `profile:${profile}`, enabled }
    }
    throw new Error("Hermes did not confirm this routine. Check Routines before creating another copy; no local or CLI fallback was used.")
  }

  const job: Routine = {
    id: existing?.id ?? newLocalId(),
    name,
    prompt,
    schedule,
    enabled,
    agentId: draft.agentId ?? existing?.agentId ?? null,
    origin: 'local',
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: nextIso,
  }
  const locals = loadLocalRoutines()
  const nextLocals = existing ? locals.map((j) => (j.id === job.id ? job : j)) : [...locals, job]
  if (existing && !locals.some((j) => j.id === job.id)) nextLocals.push(job)
  saveLocalRoutines(nextLocals)
  return job
}

export async function removeRoutine(job: Routine): Promise<boolean> {
  if (job.origin === 'remote' && !(await deleteServeCron(job.id, job.profile))) {
    throw new Error('Couldn’t delete this routine on the agent.')
  }
  if (job.origin === 'hermes' && !(await deleteHermesCliJob(job.id))) {
    throw new Error('Couldn’t delete this routine on this computer.')
  }
  const locals = loadLocalRoutines().filter((j) => j.id !== job.id)
  saveLocalRoutines(locals)
  return true
}

/** Toggle a backend job without rewriting its schedule or truncated CLI prompt. */
export async function setRoutineEnabled(job: Routine, enabled: boolean): Promise<Routine> {
  if (job.origin === 'local') {
    return upsertRoutine({ ...job, enabled }, job)
  }
  let ok = false
  if (job.origin === 'remote') {
    ok = enabled ? await resumeServeCron(job.id, job.profile) : await pauseServeCron(job.id, job.profile)
  } else {
    const bridge = hermesCliBridge()
    if (bridge) ok = await bridge('cron', [enabled ? 'resume' : 'pause', job.id]).then((res) => res.ok, () => false)
  }
  if (!ok) throw new Error(enabled ? 'Couldn’t resume this routine.' : 'Couldn’t pause this routine.')
  return { ...job, enabled, nextRunAt: enabled ? null : job.nextRunAt }
}

/** False means a local job needs the chat path. Backend failures must not
 *  fall back to another agent or duplicate an ambiguously accepted run. */
export async function testRunRemote(job: Routine): Promise<boolean> {
  if (job.origin === 'local') return false
  if (job.origin === 'remote') {
    if (await triggerServeCron(job.id, job.profile)) {
      track('routine_run', { origin: job.origin })
      return true
    }
    throw new Error('Couldn’t start this routine on the agent.')
  }
  // The CLI exits successfully without running a paused host job.
  if (!job.enabled) throw new Error('Resume this routine before running it on this computer.')
  const bridge = hermesCliBridge()
  const ok = bridge ? await bridge('cron', ['run', job.id]).then((res) => res.ok, () => false) : false
  if (!ok) throw new Error('Couldn’t start this routine on this computer.')
  track('routine_run', { origin: job.origin })
  return true
}

/** Mark a local job as fired and stamp the next run. */
export function markLocalRun(job: Routine, atMs = Date.now()): Routine {
  const locals = job.origin === 'local' ? loadLocalRoutines() : []
  // An editor save can reach storage before its refreshed list reaches App.
  const current = locals.find(item => sameRoutine(item, job)) ?? job
  const next = nextRunAt(current.schedule, atMs)
  const updated: Routine = {
    ...current,
    lastRunAt: new Date(atMs).toISOString(),
    nextRunAt: next ? new Date(next).toISOString() : null,
  }
  if (job.origin === 'local') {
    saveLocalRoutines(locals.map((j) => (sameRoutine(j, job) ? updated : j)))
  }
  return updated
}

export function takeDueLocalRoutines(jobs: Routine[], atMs = Date.now()): Routine[] {
  return jobs.filter((j) => {
    if (j.origin !== 'local' || !j.enabled) return false
    if (!j.prompt.trim()) return false
    if (!j.nextRunAt) return false
    const due = Date.parse(j.nextRunAt)
    return Number.isFinite(due) && due <= atMs
  })
}
