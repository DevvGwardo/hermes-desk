/**
 * Routine extras on top of hermes cron: where results go (delivery targets),
 * templates (blueprints), run history, and the skills picker.
 *
 * Everything goes through the `serve*` helpers so it works on desktop, web and
 * mobile. A 404 means the agent predates the route — callers show "Your agent
 * needs an update for this" instead of an error.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { serveProfileQuery } from './serve-query'

export type Loaded<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'outdated' }
  | { kind: 'unavailable'; message: string }

export const AGENT_OUTDATED_COPY = 'Your agent needs an update for this.'

/** `deliver: 'local'` — the run's output stays in Nub Agent only. */
export const LOCAL_DELIVERY = 'local'

// ---------------------------------------------------------------------------
// Delivery targets
// ---------------------------------------------------------------------------

export interface DeliveryTarget {
  id: string
  name: string
  /** False ⇒ the platform is connected but nobody ran /sethome in a chat yet. */
  homeTargetSet: boolean
}

const LOCAL_TARGET: DeliveryTarget = { id: LOCAL_DELIVERY, name: 'Only in Nub Agent', homeTargetSet: true }

const PLATFORM_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  sms: 'Text message',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  imessage: 'iMessage',
  bluebubbles: 'iMessage',
  homeassistant: 'Home Assistant',
}

function titleCase(id: string): string {
  return id
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/** Friendly name for one platform id (`telegram` → `Telegram`). */
export function platformName(id: string, targets?: readonly DeliveryTarget[] | null): string {
  const base = id.split(':')[0]!.trim().toLowerCase()
  if (!base || base === LOCAL_DELIVERY) return LOCAL_TARGET.name
  if (base === 'origin') return 'The chat it was set up from'
  const fromTargets = targets?.find((t) => t.id === base)
  return PLATFORM_NAMES[base] ?? fromTargets?.name ?? titleCase(base)
}

/** Row label for a job's `deliver` value (may be `a,b` or `platform:chat`). */
export function deliveryLabel(deliver: unknown, targets?: readonly DeliveryTarget[] | null): string {
  const raw = typeof deliver === 'string' ? deliver.trim() : ''
  if (!raw || raw === LOCAL_DELIVERY) return LOCAL_TARGET.name
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const names = [...new Set(parts.map((p) => platformName(p, targets)))]
  return names.join(' + ')
}

/** Normalises GET /api/cron/delivery-targets. Always starts with the local
 *  option; drops machine-local "bot chat" profile targets (`x:y` ids). */
export function parseDeliveryTargets(data: unknown): DeliveryTarget[] {
  const rows =
    data && typeof data === 'object' && Array.isArray((data as { targets?: unknown }).targets)
      ? ((data as { targets: unknown[] }).targets as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : []
  const out: DeliveryTarget[] = [LOCAL_TARGET]
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as { id?: unknown; name?: unknown; home_target_set?: unknown }
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    if (!id || id === LOCAL_DELIVERY || id.includes(':')) continue
    if (out.some((t) => t.id === id)) continue
    out.push({
      id,
      name: PLATFORM_NAMES[id] ?? (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : titleCase(id)),
      homeTargetSet: r.home_target_set !== false,
    })
  }
  return out
}

function unavailable(message?: string): { kind: 'unavailable'; message: string } {
  return { kind: 'unavailable', message: message || 'Your agent isn’t reachable right now.' }
}

export async function listDeliveryTargets(profile?: string): Promise<Loaded<DeliveryTarget[]>> {
  const res = await serveGetDetailed<unknown>(`/api/cron/delivery-targets${serveProfileQuery(profile)}`)
  if (res.status === 404) return { kind: 'outdated' }
  if (res.data == null) return unavailable(res.error?.message)
  return { kind: 'ok', value: parseDeliveryTargets(res.data) }
}

/** Guidance when the chosen platform has no home chat yet. */
export function homeChatHint(target: DeliveryTarget | undefined | null): string | null {
  if (!target || target.id === LOCAL_DELIVERY || target.homeTargetSet) return null
  return `Send /sethome in your ${target.name} chat with your agent first, so it knows where to post.`
}

// ---------------------------------------------------------------------------
// Repeat
// ---------------------------------------------------------------------------

/** hermes stores `repeat: { times: number | null, completed }`; times 1 = run once. */
export function isRunOnce(repeat: unknown): boolean {
  if (repeat == null) return false
  if (typeof repeat === 'number') return repeat === 1
  if (typeof repeat === 'object') return (repeat as { times?: unknown }).times === 1
  return false
}

/** Value for `updates.repeat` (hermes' normalize_repeat_value accepts 1 / 'forever'). */
export function repeatUpdateValue(runOnce: boolean): number | string {
  return runOnce ? 1 : 'forever'
}

// ---------------------------------------------------------------------------
// Templates (blueprints)
// ---------------------------------------------------------------------------

export type BlueprintFieldType = 'time' | 'enum' | 'text' | 'weekdays'

export interface BlueprintField {
  name: string
  type: BlueprintFieldType
  label: string
  default: string
  options: string[]
  optional: boolean
  help: string
}

export interface Blueprint {
  key: string
  title: string
  description: string
  category: string
  scheduleHuman: string
  fields: BlueprintField[]
}

const FIELD_TYPES = new Set<BlueprintFieldType>(['time', 'enum', 'text', 'weekdays'])

export function parseBlueprints(data: unknown): Blueprint[] {
  const rows =
    data && typeof data === 'object' && Array.isArray((data as { blueprints?: unknown }).blueprints)
      ? ((data as { blueprints: unknown[] }).blueprints as unknown[])
      : []
  const out: Blueprint[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const key = typeof r.key === 'string' ? r.key : ''
    if (!key) continue
    const fields: BlueprintField[] = []
    for (const f of Array.isArray(r.fields) ? r.fields : []) {
      if (!f || typeof f !== 'object') continue
      const ff = f as Record<string, unknown>
      const name = typeof ff.name === 'string' ? ff.name : ''
      if (!name) continue
      const type = FIELD_TYPES.has(ff.type as BlueprintFieldType) ? (ff.type as BlueprintFieldType) : 'text'
      fields.push({
        name,
        type,
        label: typeof ff.label === 'string' && ff.label ? ff.label : titleCase(name),
        default: ff.default == null ? '' : String(ff.default),
        options: Array.isArray(ff.options) ? ff.options.map((o) => String(o)) : [],
        optional: ff.optional === true,
        help: typeof ff.help === 'string' ? ff.help : '',
      })
    }
    out.push({
      key,
      title: typeof r.title === 'string' && r.title ? r.title : titleCase(key),
      description: typeof r.description === 'string' ? r.description : '',
      category: typeof r.category === 'string' ? r.category : '',
      scheduleHuman: typeof r.scheduleHuman === 'string' ? r.scheduleHuman : '',
      fields,
    })
  }
  return out
}

export async function listBlueprints(profile?: string): Promise<Loaded<Blueprint[]>> {
  const res = await serveGetDetailed<unknown>(`/api/cron/blueprints${serveProfileQuery(profile)}`)
  if (res.status === 404) return { kind: 'outdated' }
  if (res.data == null) return unavailable(res.error?.message)
  return { kind: 'ok', value: parseBlueprints(res.data) }
}

/** The `deliver` slot is rendered as the app's own "Send results to" picker. */
export function isDeliverField(field: BlueprintField): boolean {
  return field.name === 'deliver'
}

/** Initial form values. `origin` has no meaning from the app (there is no
 *  originating chat), so the deliver slot starts at "Only in Nub Agent". */
/** A free-text field (not a time, choice or delivery picker). */
export function isTextField(f: BlueprintField): boolean {
  if (isDeliverField(f) || f.type === 'time') return false
  return !((f.type === 'enum' || f.type === 'weekdays') && f.options.length > 0)
}

/**
 * Starting values for a template's form. Choices and times start on their
 * default; free text starts EMPTY, with the default shown as an example
 * (see RoutineTemplates). Templates' text defaults are often instructions,
 * not values — "Which companies?" defaults to "two or three competitors, by
 * canonical name" — and prefilling them sent that sentence to the agent as
 * the watchlist.
 */
export function blueprintDefaults(bp: Blueprint): Record<string, string> {
  const values: Record<string, string> = {}
  for (const f of bp.fields) {
    if (isDeliverField(f)) {
      values[f.name] = !f.default || f.default === 'origin' ? LOCAL_DELIVERY : f.default
    } else {
      values[f.name] = isTextField(f) ? '' : f.default
    }
  }
  return values
}

/** Human label for enum/weekday options. */
export function optionLabel(field: BlueprintField, value: string): string {
  if (field.type === 'weekdays') {
    if (value === 'everyday') return 'Every day'
    if (value === 'weekdays') return 'Weekdays'
    if (value === 'weekends') return 'Weekends'
  }
  if (field.name === 'interval_min' && /^\d+$/.test(value)) return `Every ${value} minutes`
  return value
}

/** Missing required values — checked client-side before POSTing. */
export function missingBlueprintFields(bp: Blueprint, values: Record<string, string>): string[] {
  return bp.fields.filter((f) => !f.optional && !String(values[f.name] ?? '').trim()).map((f) => f.label)
}

export type InstantiateResult =
  | { ok: true; job: Record<string, unknown> | null }
  | { ok: false; error: string; outdated?: boolean; uncertain?: boolean }

export async function instantiateBlueprint(
  key: string,
  values: Record<string, string>,
  profile?: string,
): Promise<InstantiateResult> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    const s = String(v ?? '').trim()
    if (s) clean[k] = s
  }
  const res = await serveSend<Record<string, unknown>>('POST', `/api/cron/blueprints/instantiate${serveProfileQuery(profile)}`, {
    blueprint: key,
    values: clean,
  })
  if (res.ok && typeof res.data?.id === 'string' && res.data.id) return { ok: true, job: res.data }
  if (res.ok || res.failureCategory || (res.status ?? 0) >= 500 || res.status === 424)
    return { ok: false, uncertain: true, error: 'This routine may have been created. Check Routines before creating another copy.' }
  if (res.status === 404 && !/unknown blueprint/i.test(res.error ?? '')) {
    return { ok: false, error: AGENT_OUTDATED_COPY, outdated: true }
  }
  return { ok: false, error: res.error || 'Couldn’t create this routine.' }
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'ok' | 'failed'

export interface RoutineRun {
  id: string
  startedAt: number | null
  endedAt: number | null
  status: RunStatus
  endReason: string
  /** The hermes profile whose store holds this run (a job made by one of the
   *  app's agents lives in that agent's profile). Its output is read there. */
  profile?: string
}

function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const n = Number(v)
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
    const p = Date.parse(v)
    return Number.isFinite(p) ? p : null
  }
  return null
}

export function runStatus(row: { is_active?: unknown; ended_at?: unknown; end_reason?: unknown }): RunStatus {
  if (row.is_active === true) return 'running'
  const reason = typeof row.end_reason === 'string' ? row.end_reason : ''
  if (reason === 'cron_complete') return 'ok'
  // A run in an agent profile's store: the scheduler's "cron_complete" is
  // written to the main store, so the profile's row is closed by the agent
  // itself when the run ends. That is a normal finish, not a failure.
  if (reason === 'agent_close') return 'ok'
  return 'failed'
}

export function parseRuns(data: unknown): RoutineRun[] {
  const rows =
    data && typeof data === 'object' && Array.isArray((data as { runs?: unknown }).runs)
      ? ((data as { runs: unknown[] }).runs as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : []
  const out: RoutineRun[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    out.push({
      id: r.id,
      startedAt: epochMs(r.started_at),
      endedAt: epochMs(r.ended_at),
      status: runStatus(r),
      endReason: typeof r.end_reason === 'string' ? r.end_reason : '',
      ...(typeof r.profile === 'string' && r.profile ? { profile: r.profile } : {}),
    })
  }
  return out
}

export async function listRoutineRuns(jobId: string, limit = 10, profile?: string): Promise<Loaded<RoutineRun[]>> {
  const res = await serveGetDetailed<unknown>(
    `/api/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${Math.max(1, Math.min(limit, 100))}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`,
  )
  if (res.status === 404) return { kind: 'outdated' }
  if (res.data == null) return unavailable(res.error?.message)
  return { kind: 'ok', value: parseRuns(res.data) }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as { type?: unknown; text?: unknown }
          if (typeof p.text === 'string' && (p.type == null || p.type === 'text')) return p.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

/** What a run that answered `[SILENT]` (nothing to report) reads as. */
export const SILENT_RUN_TEXT = 'Nothing to report this time.'

const SILENT_LINE = /^\[silent\]$/i
const SILENT_WHOLE = /^(\[silent\]|silent|no_reply|no reply)$/i

/**
 * Split hermes' silence marker off a run's output. Mirrors the cron
 * scheduler's rule (gateway.response_filters.is_autonomous_silence_response):
 * the run was not delivered when the whole reply is a silence token, or
 * `[SILENT]` sits on its own first or last line. A token mid-sentence is
 * content. `text` is the reply without the marker line.
 */
export function splitSilence(output: string): { text: string; silent: boolean } {
  const trimmed = output.trim()
  if (SILENT_WHOLE.test(trimmed)) return { text: '', silent: true }
  const lines = trimmed.split('\n')
  if (lines.length > 1 && SILENT_LINE.test(lines[lines.length - 1]!.trim())) {
    return { text: lines.slice(0, -1).join('\n').trim(), silent: true }
  }
  if (lines.length > 1 && SILENT_LINE.test(lines[0]!.trim())) {
    return { text: lines.slice(1).join('\n').trim(), silent: true }
  }
  return { text: trimmed, silent: false }
}

/** Last assistant reply, preserving silence markers until delivery metadata
 *  has been separated from the text shown to the user. */
export function lastAssistantText(data: unknown): string | null {
  const msgs =
    data && typeof data === 'object' && Array.isArray((data as { messages?: unknown }).messages)
      ? ((data as { messages: unknown[] }).messages as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown } | null
    if (!m || m.role !== 'assistant') continue
    const text = messageText(m.content).trim()
    if (!text) continue
    return text
  }
  return null
}

/** A run's messages, from the profile store that holds it (the agent's
 *  default store when the run names none; asking it for a profile's run 404s). */
function runMessagesPath(runId: string, profile?: string): string {
  const qs = new URLSearchParams({ limit: '50', order: 'latest' })
  if (profile) qs.set('profile', profile)
  return `/api/sessions/${encodeURIComponent(runId)}/messages?${qs.toString()}`
}

/** Output of one run (the run is a session). Null when unreadable. */
export async function readRunOutput(runId: string, profile?: string): Promise<string | null> {
  const res = await serveGetDetailed<unknown>(runMessagesPath(runId, profile))
  if (res.data == null) return null
  return lastAssistantText(res.data)
}

/** Unlike an empty saved output, an unavailable response needs a retry. */
export async function readRunOutputDetailed(
  runId: string,
  profile?: string,
): Promise<Loaded<{ text: string; silent: boolean } | null>> {
  const res = await serveGetDetailed<unknown>(runMessagesPath(runId, profile))
  if (res.data == null) return unavailable(res.error?.message)
  const text = lastAssistantText(res.data)
  return { kind: 'ok', value: text ? splitSilence(text) : null }
}

// ---------------------------------------------------------------------------
// Skills picker
// ---------------------------------------------------------------------------

export interface SkillOption {
  name: string
  description: string
}

export function parseSkills(data: unknown): SkillOption[] {
  // hermes returns a bare array; older shims wrap it in { skills } / { items }.
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? ((data as { skills?: unknown; items?: unknown }).skills ?? (data as { items?: unknown }).items)
      : null
  if (!Array.isArray(rows)) return []
  const out: SkillOption[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as { name?: unknown; description?: unknown; enabled?: unknown }
    if (typeof r.name !== 'string' || !r.name || r.enabled === false) continue
    out.push({ name: r.name, description: typeof r.description === 'string' ? r.description : '' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function listSkillOptions(profile?: string): Promise<Loaded<SkillOption[]>> {
  const res = await serveGetDetailed<unknown>(`/api/skills${serveProfileQuery(profile)}`)
  if (res.status === 404) return { kind: 'outdated' }
  if (res.data == null) return unavailable(res.error?.message)
  return { kind: 'ok', value: parseSkills(res.data) }
}

/** `job.skills` (list) or legacy `job.skill` (string) → names. */
export function jobSkills(job: { [key: string]: unknown }): string[] {
  if (Array.isArray(job.skills)) return job.skills.filter((s): s is string => typeof s === 'string' && !!s)
  if (typeof job.skill === 'string' && job.skill) return [job.skill]
  return []
}

/** Short suffix for routine rows: "In Nub Agent" / "To Telegram". */
export function deliveryRowLabel(deliver: unknown): string {
  const raw = typeof deliver === 'string' ? deliver.trim() : ''
  if (!raw || raw === LOCAL_DELIVERY) return 'In Nub Agent'
  const label = deliveryLabel(raw)
  // "To the chat it was set up from", not "To The chat…".
  return `To ${label.startsWith('The ') ? `t${label.slice(1)}` : label}`
}
