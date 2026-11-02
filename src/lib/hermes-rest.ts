/**
 * Shared authenticated REST client for the Hermes-native panels
 * (skills / cron / memory / MCP / usage). Local serve is the only target.
 */

import { BLOCKED_ERROR, isDashboardRouteAllowed } from './dashboard-routes'
import { serveBridgeConnection, serveTokenHeader } from './serve-bridge'
import { serveProfileQuery } from './serve-query'

const failureCategories = ['forbidden', 'busy', 'peer-unverified', 'timeout', 'upstream-unavailable',
  'upstream-http', 'invalid-response', 'request-too-large', 'response-too-large'] as const
export type ServeFailureCategory = typeof failureCategories[number]

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}): Promise<{
  ok: boolean; status: number; data?: unknown; error?: string; json: boolean; failureCategory?: ServeFailureCategory
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const json = /application\/json|\+json/.test(response.headers.get('content-type') ?? '')
    const rawCategory = response.headers.get('X-Hermes-Serve-Failure')
    const failureCategory = !response.ok && failureCategories.includes(rawCategory as ServeFailureCategory)
      ? rawCategory as ServeFailureCategory : undefined
    let data: unknown
    try {
      data = json ? await response.json() : response.status === 204 ? {} : null
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { ok: false, status: response.status, json, error: 'Invalid serve response', failureCategory: 'invalid-response' }
    }
    const error = data && typeof data === 'object' ? data as { error?: string; detail?: string } : {}
    return { ok: response.ok && (json || response.status === 204), status: response.status, data, json,
      ...(failureCategory ? { failureCategory } : !json && response.status !== 204 ? { failureCategory: 'invalid-response' as const } : {}),
      ...(!response.ok ? { error: error.error ?? error.detail ?? `HTTP ${response.status}` } : {}) }
  } catch {
    const timedOut = controller.signal.aborted
    return { ok: false, status: 0, json: false,
      failureCategory: timedOut ? 'timeout' : 'upstream-unavailable',
      error: timedOut ? 'timed out' : 'serve unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

const inflight = new Map<string, Promise<unknown>>()
function singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const pending = operation()
  inflight.set(key, pending)
  const cleanup = () => { if (inflight.get(key) === pending) inflight.delete(key) }
  void pending.then(cleanup, cleanup)
  return pending
}

function withClientRequestId(body?: Record<string, unknown>): Record<string, unknown> {
  return { ...body, client_request_id: body?.client_request_id ?? globalThis.crypto.randomUUID() }
}

export interface ServeAuth {
  baseUrl: string
  token: string
}

/** Skip dashboard REST after an unprovisioned (409) / cron-forbidden (403) reply. */
export const DASHBOARD_NOT_READY_TTL_MS = 30_000

let dashboardNotReadyUntil = 0

/** Reset the not-ready TTL (tests and a user Retry). */
export function resetDashboardNotReady(): void {
  dashboardNotReadyUntil = 0
}

export function isDashboardNotReady(): boolean {
  return Date.now() < dashboardNotReadyUntil
}

function markDashboardNotReady(): void {
  dashboardNotReadyUntil = Date.now() + DASHBOARD_NOT_READY_TTL_MS
}

/**
 * Probe TTL (same timestamp-expiry pattern as DASHBOARD_NOT_READY_TTL):
 * verdicts go stale after 5 minutes so a re-provisioned cube is picked up
 * without an app restart.
 */
export const PROBE_TTL_MS = 5 * 60_000

interface TimedVerdict {
  ok: boolean
  at: number
}

function freshVerdict(v: TimedVerdict | undefined): boolean {
  return !!v && Date.now() - v.at < PROBE_TTL_MS
}

/**
 * Drop every cached probe verdict (pairing/link change, user Retry, or a 401
 * anywhere meaning the link rotated). Lib-side only — callers in components
 * just call this; no component edits needed.
 */
export function resetAllProbes(): void {
  resetDashboardNotReady()
  resetResizeProbe()
  resetBrowserJobsProbe()
  resetTranscriptTailProbe()
  resetNotificationsProbe()
}

/** 401 anywhere means the link rotated — drop cached verdicts so we re-probe. */
function noteAuthFailure(status?: number): void {
  if (status === 401) resetAllProbes()
}

/** Resolve serve auth via the Electron bridge (main attaches the token). */
export async function serveAuth(): Promise<ServeAuth | null> {
  return serveBridgeConnection()
}

/** Local serve presence, without any account or pairing lookup. */
export async function hasAgentTarget(): Promise<boolean> {
  return (await serveBridgeConnection()) !== null
}

/** Typed fetch failure for serve/dashboard GETs (auth kinds drive re-link UX). */
export type ServeGetErrorKind = 'unauthorized' | 'forbidden' | 'not-ready' | 'unavailable' | 'timeout'

export interface ServeGetError {
  kind: ServeGetErrorKind
  status?: number
  message: string
  failureCategory?: ServeFailureCategory
}

export interface ServeGetResult<T> {
  data: T | null
  status?: number
  error?: ServeGetError
}

function serveError(status: number | undefined, message: string | undefined): ServeGetError {
  if (status === 401) {
    return { kind: 'unauthorized', status, message: message || 'serve authorization failed — restart serve' }
  }
  if (status === 403) return { kind: 'forbidden', status, message: message || 'dashboard forbidden' }
  if (status === 409) return { kind: 'not-ready', status, message: message || 'dashboard not ready' }
  if (!status) {
    const timedOut = /timed out/i.test(message ?? '')
    return { kind: timedOut ? 'timeout' : 'unavailable', message: message || 'unavailable' }
  }
  return { kind: 'unavailable', status, message: message || `HTTP ${status}` }
}

async function serveGetResult<T>(path: string): Promise<ServeGetResult<T>> {
  if (!isDashboardRouteAllowed('GET', path)) {
    return { data: null, status: 403, error: serveError(403, BLOCKED_ERROR) }
  }
  const auth = await serveAuth()
  if (!auth) return { data: null, error: serveError(undefined, 'serve unavailable') }
  const res = await fetchJsonWithTimeout(`${auth.baseUrl}${path}`, {
    method: 'GET',
    headers: { ...serveTokenHeader(auth.token) },
    credentials: 'omit',
  })
  if (res.ok) return { data: res.data as T, status: res.status }
  if (res.status === 401) noteAuthFailure(res.status)
  return { data: null, status: res.status || undefined,
    error: { ...serveError(res.status || undefined, res.error), ...(res.failureCategory ? { failureCategory: res.failureCategory } : {}) } }
}

/** Auth'd JSON GET; null when serve is unavailable or the route errors. */
export async function serveGet<T>(path: string): Promise<T | null> {
  const { data } = await serveGetResult<T>(path)
  return data
}

/** Auth'd JSON POST; null when serve is unavailable or the route errors. */
export async function servePost<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  if (!isDashboardRouteAllowed('POST', path)) return null
  const withId = withClientRequestId(body)
  const auth = await serveAuth()
  if (!auth) return null
  const res = await fetchJsonWithTimeout(`${auth.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...serveTokenHeader(auth.token),
    },
    body: JSON.stringify(withId),
    credentials: 'omit',
  })
  if (res.status === 401) noteAuthFailure(res.status)
  if (!res.ok) return null
  return res.data as T
}

/** Auth'd JSON PUT; null when serve is unavailable or the route errors. */
export async function servePut<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  if (!isDashboardRouteAllowed('PUT', path)) return null
  const withId = withClientRequestId(body)
  const auth = await serveAuth()
  if (!auth) return null
  const res = await fetchJsonWithTimeout(`${auth.baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...serveTokenHeader(auth.token),
    },
    body: JSON.stringify(withId),
    credentials: 'omit',
  })
  if (res.status === 401) noteAuthFailure(res.status)
  if (!res.ok) return null
  return res.data as T
}

export interface ServeSendResult<T> {
  ok: boolean
  data: T | null
  status?: number
  /** Dashboard's `detail`/`error` text when present (safe to show). */
  error?: string
  failureCategory?: ServeFailureCategory
}

/**
 * Auth'd JSON write that keeps the failure reason. servePost/servePut collapse
 * errors to null; setup forms need the dashboard's 400 detail ("TELEGRAM_BOT_TOKEN
 * looks invalid") to tell the user what to fix.
 */
export async function serveSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<ServeSendResult<T>> {
  if (!isDashboardRouteAllowed(method, path)) {
    return { ok: false, data: null, status: 403, error: BLOCKED_ERROR }
  }
  const withId = withClientRequestId(body)
  const auth = await serveAuth()
  if (!auth) return { ok: false, data: null, error: 'Agent unavailable' }
  const res = await fetchJsonWithTimeout(`${auth.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...serveTokenHeader(auth.token),
    },
    body: JSON.stringify(withId),
    credentials: 'omit',
  })
  if (res.status === 401) noteAuthFailure(res.status)
  if (!res.ok) return { ok: false, data: null, status: res.status || undefined, error: res.error,
    ...(res.failureCategory ? { failureCategory: res.failureCategory } : {}) }
  return { ok: true, data: res.data as T, status: res.status }
}

/** GET that keeps the status/error (404 ⇒ the agent predates the route). */
export async function serveGetDetailed<T>(path: string): Promise<ServeGetResult<T>> {
  return serveGetResult<T>(path)
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface ServeSkill {
  name: string
  description?: string | null
  enabled?: boolean
  category?: string | null
  [key: string]: unknown
}

export async function listServeSkills(): Promise<ServeSkill[] | null> {
  const data = await serveGet<ServeSkill[] | { skills?: ServeSkill[]; items?: ServeSkill[] }>('/api/skills')
  if (!data) return null
  // hermes returns a bare array; older proxies wrapped it.
  if (Array.isArray(data)) return data
  return (data.skills ?? data.items ?? []) as ServeSkill[]
}

export async function toggleServeSkill(name: string, enabled: boolean): Promise<boolean> {
  const res = await servePut<{ ok?: boolean }>('/api/skills/toggle', { name, enabled })
  return res !== null
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface ServeCronJob {
  id: string
  name?: string | null
  schedule?: string | { display?: string; expr?: string; kind?: string } | null
  schedule_display?: string | null
  enabled?: boolean
  prompt?: string | null
  last_run_at?: string | null
  next_run_at?: string | null
  [key: string]: unknown
}

export function parseServeCronJobs(data: unknown): ServeCronJob[] {
  if (Array.isArray(data)) return data as ServeCronJob[]
  if (data && typeof data === 'object') {
    const o = data as { jobs?: unknown; items?: unknown }
    if (Array.isArray(o.jobs)) return o.jobs as ServeCronJob[]
    if (Array.isArray(o.items)) return o.items as ServeCronJob[]
  }
  return []
}

export async function listServeCronJobs(): Promise<ServeCronJob[] | null> {
  if (isDashboardNotReady()) return null
  const first = await serveGetResult<unknown>('/api/cron/jobs')
  // 409 = dashboard not provisioned; 403 = dashboard REST forbidden. Neither
  // is "try the other profile" — a second GET just repeats the same error.
  if (first.status === 409 || first.status === 403) {
    markDashboardNotReady()
    return null
  }
  if (first.data == null) {
    if (isDashboardNotReady()) return null
    const all = await serveGetResult<unknown>('/api/cron/jobs?profile=all')
    if (all.data == null) return null
    return parseServeCronJobs(all.data)
  }
  return parseServeCronJobs(first.data)
}

const cronCreateReceipts = new Map<string, { input: string; job: ServeCronJob }>()
const uncertainCronCreates = new Set<string>()
export async function createServeCron(job: {
  name: string
  prompt: string
  schedule: string
  deliver?: string
  skills?: string[]
  profile?: string
  paused?: boolean
  repeat?: number
  requestId?: string
}): Promise<ServeCronJob | null> {
  const key = job.requestId ?? JSON.stringify(job)
  const input = JSON.stringify(job)
  if (uncertainCronCreates.has(key))
    throw new Error('The create acknowledgment was lost. Check Routines before creating another copy.')
  const receipt = cronCreateReceipts.get(key)
  if (receipt) {
    if (receipt.input !== input) throw new Error('This create already has a saved receipt. Open the saved routine to edit it instead of creating another copy.')
    return receipt.job
  }
  return singleFlight(`cron:create:${key}`, async () => {
    const res = await serveSend<unknown>('POST', `/api/cron/jobs${serveProfileQuery(job.profile)}`, {
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule,
      deliver: job.deliver ?? 'local',
      ...(job.skills?.length ? { skills: job.skills } : {}),
      paused: job.paused ?? false,
      ...(job.repeat ? { repeat: job.repeat } : {}),
      ...(job.requestId ? { client_request_id: job.requestId } : {}),
    })
    const data = res.data
    if (res.ok && data && typeof data === 'object' && 'id' in data && typeof data.id === 'string' && data.id) {
      const created = data as ServeCronJob
      cronCreateReceipts.set(key, { input, job: created })
      return created
    }
    if (res.failureCategory || (res.status ?? 0) >= 500 || res.status === 424 || res.ok) {
      uncertainCronCreates.add(key)
      throw new Error('Hermes may have saved this routine, but its acknowledgment is unavailable. Check Routines before creating another copy.')
    }
    throw new Error('Couldn’t create this routine in Hermes. Nothing was saved in the CLI or as a local fallback.')
  })
}

export async function updateServeCron(
  id: string,
  updates: Record<string, unknown>,
  profile?: string,
): Promise<boolean> {
  return singleFlight(`cron:update:${profile ?? ''}:${id}:${JSON.stringify(updates)}`, async () => {
    const res = await servePut<{ ok?: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`, { updates })
    return res !== null
  })
}

export async function pauseServeCron(id: string, profile?: string): Promise<boolean> {
  return singleFlight(`cron:pause:${profile ?? ''}:${id}`, async () => {
    const res = await servePost<{ ok?: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}/pause${serveProfileQuery(profile)}`)
    return res !== null
  })
}

export async function resumeServeCron(id: string, profile?: string): Promise<boolean> {
  return singleFlight(`cron:resume:${profile ?? ''}:${id}`, async () => {
    const res = await servePost<{ ok?: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}/resume${serveProfileQuery(profile)}`)
    return res !== null
  })
}

export async function triggerServeCron(id: string, profile?: string): Promise<boolean> {
  return singleFlight(`cron:trigger:${profile ?? ''}:${id}`, async () => {
    const res = await servePost<{ ok?: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger${serveProfileQuery(profile)}`)
    return res !== null
  })
}

export async function deleteServeCron(id: string, profile?: string): Promise<boolean> {
  const auth = await serveAuth()
  if (!auth) return false
  const res = await fetchJsonWithTimeout(`${auth.baseUrl}/api/cron/jobs/${encodeURIComponent(id)}${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`, {
    method: 'DELETE',
    headers: { ...serveTokenHeader(auth.token) },
    credentials: 'omit',
  })
  return res.ok
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface ServeMemoryProvider {
  name: string
  description: string
  available: boolean
  configured: boolean
  /** hermes: ready | needs_config | unavailable | missing */
  status: string
  setup?: Record<string, unknown>
}

/**
 * hermes `GET /api/memory` (ops.py): `{active, providers, builtin_files}`.
 * `active` is "" when only built-in memory (MEMORY.md / USER.md) is in use.
 */
export interface ServeMemoryInfo {
  active: string
  providers: ServeMemoryProvider[]
  /** Built-in file sizes in bytes. */
  builtinFiles: { memory: number; user: number }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

export function parseServeMemory(raw: unknown): ServeMemoryInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  // Older builds answered {provider, enabled}; keep reading them.
  const activeRaw = typeof o.active === 'string' ? o.active : typeof o.provider === 'string' ? o.provider : ''
  const active = /^(built-?in|builtin|none)$/i.test(activeRaw.trim()) ? '' : activeRaw.trim()
  const files = (o.builtin_files && typeof o.builtin_files === 'object' ? o.builtin_files : {}) as Record<string, unknown>
  const providers = Array.isArray(o.providers)
    ? o.providers
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
        .map((p) => ({
          name: String(p.name),
          description: typeof p.description === 'string' ? p.description : '',
          available: p.available === true,
          configured: p.configured === true,
          status: typeof p.status === 'string' ? p.status : 'unavailable',
          ...(p.setup && typeof p.setup === 'object' ? { setup: p.setup as Record<string, unknown> } : {}),
        }))
    : []
  return { active, providers, builtinFiles: { memory: num(files.memory), user: num(files.user) } }
}

export async function getServeMemory(): Promise<ServeMemoryInfo | null> {
  return parseServeMemory(await serveGet<unknown>('/api/memory'))
}

/** 3072 → "3 KB"; 0 → "empty". */
export function formatMemoryBytes(bytes: number): string {
  if (!bytes) return 'empty'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`
  return `${Math.round((kb / 1024) * 10) / 10} MB`
}

/** Friendly provider name ("honcho" → "Honcho"). */
export function memoryProviderLabel(name: string): string {
  const known: Record<string, string> = {
    honcho: 'Honcho',
    mem0: 'Mem0',
    supermemory: 'Supermemory',
    retaindb: 'RetainDB',
    hindsight: 'Hindsight',
    holographic: 'Holographic',
  }
  return known[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : name)
}

/** "Built-in memory · 3 KB facts, 1 KB about you" (or "Honcho · plus …"). */
export function memorySummary(info: ServeMemoryInfo): string {
  const { memory, user } = info.builtinFiles
  const sizes =
    memory || user
      ? `${formatMemoryBytes(memory)} facts, ${formatMemoryBytes(user)} about you`
      : 'nothing saved yet'
  if (!info.active) return `Built-in memory · ${sizes}`
  return `${memoryProviderLabel(info.active)} · plus built-in ${sizes}`
}

export interface ServeMemoryPending {
  id: string
  /** What would be saved (`content`). */
  preview?: string
  /** "memory" (facts) | "user" (about you) */
  target?: string
  createdAt?: string
  /** add | replace | remove (hermes memory tool action). */
  action?: string
  /** Text being replaced/removed. */
  oldText?: string
  /** One-line summary when the agent gives one. */
  summary?: string
}

function parseMemoryPending(data: unknown): ServeMemoryPending[] {
  if (Array.isArray(data)) {
    return data
      .map((row): ServeMemoryPending | null => {
        if (!row || typeof row !== 'object') return null
        const o = row as {
          id?: unknown
          preview?: unknown
          text?: unknown
          content?: unknown
          target?: unknown
          created_at?: unknown
          action?: unknown
          old_text?: unknown
          matched_entries?: unknown
          summary?: unknown
        }
        const id = typeof o.id === 'string' ? o.id : typeof o.id === 'number' ? String(o.id) : ''
        if (!id) return null
        const preview =
          typeof o.content === 'string'
            ? o.content
            : typeof o.preview === 'string'
              ? o.preview
              : typeof o.text === 'string'
                ? o.text
                : undefined
        return {
          id,
          preview,
          ...(typeof o.target === 'string' ? { target: o.target } : {}),
          ...(typeof o.created_at === 'string' ? { createdAt: o.created_at } : {}),
          ...(typeof o.action === 'string' && o.action ? { action: o.action } : {}),
          // Newer agents pin replace/remove to the exact stored entry (`matched_entries`);
          // show that over the looser `old_text` match string.
          ...(() => {
            const matched = Array.isArray(o.matched_entries)
              ? o.matched_entries.filter((e): e is string => typeof e === 'string' && e.length > 0)
              : []
            if (matched.length) return { oldText: matched.join('\n') }
            return typeof o.old_text === 'string' && o.old_text ? { oldText: o.old_text } : {}
          })(),
          ...(typeof o.summary === 'string' && o.summary ? { summary: o.summary } : {}),
        }
      })
      .filter((row): row is ServeMemoryPending => row != null)
  }
  if (data && typeof data === 'object') {
    const o = data as { pending?: unknown; items?: unknown }
    if (Array.isArray(o.pending)) return parseMemoryPending(o.pending)
    if (Array.isArray(o.items)) return parseMemoryPending(o.items)
  }
  return []
}

/**
 * `GET /api/memory/pending` → `{pending:[{id,target,content,created_at}]}`.
 * Null when the agent has no such route (404 / older build) or is
 * unreachable — callers hide the section rather than error.
 */
export async function listServeMemoryPending(): Promise<ServeMemoryPending[] | null> {
  const res = await serveGetDetailed<unknown>('/api/memory/pending')
  if (res.data == null) return null
  return parseMemoryPending(res.data)
}

export interface MemoryPendingResolution {
  ok: boolean
  /** Plain reason when it didn't apply (409 = e.g. memory full; item stays pending). */
  error?: string
}

/**
 * `POST /api/memory/pending/{id}/approve|reject` → `{ok}`. 409 on approve
 * means it couldn't be applied (e.g. the memory is full) and stays pending;
 * 404 means it's already gone.
 */
export async function resolveServeMemoryPending(
  id: string,
  action: 'approve' | 'reject',
): Promise<MemoryPendingResolution> {
  const res = await serveSend<{ ok?: boolean; detail?: string }>(
    'POST',
    action === 'approve'
      ? `/api/memory/pending/${encodeURIComponent(id)}/approve`
      : `/api/memory/pending/${encodeURIComponent(id)}/reject`,
    {},
  )
  if (res.ok && res.data?.ok !== false) return { ok: true }
  if (res.status === 409) {
    // 409: memory is full, or the entry this edit targets changed since it was proposed.
    return { ok: false, error: 'Couldn’t save this — your agent’s memory may be full, or what it would change has since been edited. Reject it and your agent can try again.' }
  }
  if (res.status === 404) return { ok: false, error: 'This was already handled.' }
  return { ok: false, error: res.error || 'Couldn’t update this memory.' }
}

export function memoryFieldRows(info: ServeMemoryInfo): { label: string; value: string }[] {
  return [
    { label: 'Memory', value: info.active ? memoryProviderLabel(info.active) : 'Built-in memory' },
    { label: 'Saved facts', value: formatMemoryBytes(info.builtinFiles.memory) },
    { label: 'About you', value: formatMemoryBytes(info.builtinFiles.user) },
  ]
}

// ---------------------------------------------------------------------------
// Usage / insights
// ---------------------------------------------------------------------------

export interface ServeUsageSummary {
  daily?: unknown[]
  by_model?: unknown[]
  totals?: Record<string, unknown>
  [key: string]: unknown
}

export async function getServeUsage(days = 30): Promise<ServeUsageSummary | null> {
  return serveGet<ServeUsageSummary>(`/api/analytics/usage?days=${days}`)
}

export interface ServeDiskStats {
  total?: number
  used?: number
  free?: number
  percent?: number
}

export interface ServeSystemStats {
  hermes_version?: string
  hostname?: string
  memory?: { total?: number; used?: number; available?: number; percent?: number }
  disk?: ServeDiskStats
  [key: string]: unknown
}

export async function getServeSystemStats(): Promise<ServeSystemStats | null> {
  return serveGet<ServeSystemStats>('/api/system/stats')
}

// ---------------------------------------------------------------------------
// Transcript tail (B1 — cross-session search)
// ---------------------------------------------------------------------------

/** One transcript entry from `GET /api/transcripts/tail` (contract R1). */
export interface TranscriptTailHit {
  sessionId: string
  rowId: number
  role?: string
  text: string
  at?: string
}

let transcriptTailVerdict: TimedVerdict | null = null

/** Reset the cached probe result (used by tests and pairing changes). */
export function resetTranscriptTailProbe(): void {
  transcriptTailVerdict = null
}

/**
 * B1 feature-detect: GET `/api/transcripts/tail` (not OPTIONS). Dashboard
 * proxy OPTIONS is always 204 CORS even when the prefix was missing, so an
 * OPTIONS probe cached true and the following GET 403ed.
 */
export async function probeTranscriptTail(): Promise<boolean> {
  if (transcriptTailVerdict && freshVerdict(transcriptTailVerdict)) return transcriptTailVerdict.ok
  const res = await serveGetResult<unknown>('/api/transcripts/tail')
  const ok = res.data != null && typeof res.data === 'object'
  transcriptTailVerdict = { ok, at: Date.now() }
  return ok
}

/** Paged tail entries across all sessions of an instance. Null when unsupported. */
export async function readTranscriptTails(
  instanceId: string,
  opts?: { after?: string; limit?: number },
): Promise<TranscriptTailHit[] | null> {
  if (!(await probeTranscriptTail())) return null
  const qs = new URLSearchParams({ instanceId })
  if (opts?.after) qs.set('after', opts.after)
  qs.set('limit', String(opts?.limit ?? 300))
  const data = await serveGet<{ entries?: TranscriptTailHit[] }>(
    `/api/transcripts/tail?${qs.toString()}`,
  )
  if (!data || !Array.isArray(data.entries)) return null
  return data.entries.filter(
    (e): e is TranscriptTailHit =>
      !!e && typeof e.sessionId === 'string' && typeof e.text === 'string',
  )
}

// ---------------------------------------------------------------------------
// Computer resize schedule (B2 — route contract R2)
// ---------------------------------------------------------------------------

export interface ResizeScheduleStatus {
  currentPlan?: string
  pending?: {
    plan: string
    scheduleAt: string
    state: 'scheduled' | 'resizing' | 'done' | 'failed'
  } | null
}

/**
 * Server ISO instant → `<input type="datetime-local">` value (`YYYY-MM-DDTHH:MM`,
 * LOCAL wall time — datetime-local carries no zone). Returns `''` when the
 * input is missing or unparseable so the schedule field stays empty instead
 * of showing a shifted/garbage time. Used to prefill the reschedule form
 * from a pending resize.
 */
export function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Reset the cached probe results (tests). */
export function resetResizeProbe(): void {
  // No hosted resize surface in Hermes Desk.
}

/** Compatibility for the old panel, pending its removal in wave 2. */
export async function probeResize(_instanceId: string): Promise<boolean> {
  return false
}

export async function getResizeStatus(_instanceId: string): Promise<ResizeScheduleStatus | null> {
  return null
}

/** Hosted machine resizing is unavailable in Hermes Desk. */
export async function scheduleResize(
  _instanceId: string,
  _plan: string,
  _scheduleAt?: string,
): Promise<boolean> {
  return false
}

export async function cancelResize(_instanceId: string): Promise<boolean> {
  return false
}

// ---------------------------------------------------------------------------
// Browser-use jobs (plan step 2 — route contract per docs/BROWSER_USE_PLAN.md)
// ---------------------------------------------------------------------------

/** Server job state from `GET /api/instances/:id/browser/jobs/:jobId`. */
export type BrowserJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string

export interface BrowserJob {
  jobId: string
  state: BrowserJobState
  url?: string
  screenshotRef?: string
}

export interface BrowserSteerAction {
  action: 'type' | 'click' | 'goto' | 'screenshot' | 'stop'
  selector?: string
  text?: string
  url?: string
}

/** Reset the cached probe results (tests). */
export function resetBrowserJobsProbe(): void {
  // Workspace uses main-process browser.controller.*, not hosted jobs.
}

/** Hosted browser jobs are unavailable. Workspace control stays in main. */
export async function probeBrowserJobs(_instanceId: string): Promise<boolean> {
  return false
}

/** Create a browser job on the cube. Null when unsupported or rejected. */
export async function createBrowserJob(
  _instanceId: string,
  _opts: { goal: string; startUrl?: string },
): Promise<{ jobId: string } | null> {
  return null
}

/** Fetch one job's state. Null when unsupported or unknown. */
export async function getBrowserJob(
  _instanceId: string,
  _jobId: string,
): Promise<BrowserJob | null> {
  return null
}

/** Steer a running job (type/click/goto/screenshot/stop). False when unsupported. */
export async function steerBrowserJob(
  _instanceId: string,
  _jobId: string,
  _action: BrowserSteerAction,
): Promise<boolean> {
  return false
}

/** Destroy a job's browser context. False when unsupported. */
export async function deleteBrowserJob(_instanceId: string, _jobId: string): Promise<boolean> {
  return false
}

// ---------------------------------------------------------------------------
// Notification bus (B3 — route contract R3)
// ---------------------------------------------------------------------------

export interface BusNotification {
  id: string
  source?: string
  kind?: 'pr' | 'issue' | 'push' | 'comment' | string
  title: string
  /** One line of detail (an app item: the routine's result, the approval). */
  body?: string
  url?: string
  repo?: string
  at?: string
  read?: boolean
  /** App items: what a click opens inside the app (instead of `url`). */
  target?: { kind: 'conversation' | 'routines'; id?: string }
  /** Routine items: the run whose result this is (the drawer reads its full output). */
  runId?: string
  /** The agent profile whose store holds `runId` (absent = the main store). */
  runProfile?: string
}

/** Reset the cached probe result (tests). */
export function resetNotificationsProbe(): void {
  // The notification feed is local; there is no server capability to cache.
}

/** Hermes Desk owns its feed locally, not through the legacy dashboard bus. */
export async function probeNotifications(): Promise<boolean> {
  return false
}

export async function readNotifications(_since?: string): Promise<BusNotification[] | null> {
  return null
}

export async function markNotificationsRead(_ids: string[]): Promise<boolean> {
  return false
}
