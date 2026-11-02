/**
 * Memory surface beyond status: toggles, viewer, reset and external
 * providers. hermes routes (ops.py, memory_providers.py, memory_oauth.py):
 *
 *   POST /api/memory/reset {target: all|memory|user}      → {ok, deleted}
 *   PUT  /api/memory/provider {provider}                   ("" = built-in only)
 *   GET  /api/memory/providers/{name}/config               schema fields
 *   PUT  /api/memory/providers/{name}/config {values}      saves + activates
 *   POST /api/memory/providers/{name}/setup {values}       installs deps
 *   POST /api/memory/providers/honcho/oauth/start          loopback flow
 *   GET  /api/memory/providers/honcho/oauth/status         idle|pending|connected|error
 *
 * Toggles are config writes through the allowlisted `patchAgentConfig`
 * (memory.memory_enabled, memory.user_profile_enabled, memory.write_approval).
 */

import { getAgentConfig, patchAgentConfig, readDotted } from './agent-config'
import { serveGetDetailed, serveSend, type ServeSendResult } from './hermes-rest'
import { isBridgeAvailable, readText } from './fs'
import { resolveHermesHome } from './hermes-agents'

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

export interface MemoryToggles {
  /** Remember facts (MEMORY.md). */
  memoryEnabled: boolean
  /** Learn about me (USER.md). */
  userProfileEnabled: boolean
  /** Ask before remembering. */
  writeApproval: boolean
}

export const MEMORY_TOGGLE_PATHS: Record<keyof MemoryToggles, string> = {
  memoryEnabled: 'memory.memory_enabled',
  userProfileEnabled: 'memory.user_profile_enabled',
  writeApproval: 'memory.write_approval',
}

/** hermes DEFAULT_CONFIG values. */
const TOGGLE_DEFAULTS: MemoryToggles = { memoryEnabled: true, userProfileEnabled: true, writeApproval: false }

export function togglesFromConfig(config: Record<string, unknown>): MemoryToggles {
  const out = { ...TOGGLE_DEFAULTS }
  for (const key of Object.keys(MEMORY_TOGGLE_PATHS) as (keyof MemoryToggles)[]) {
    const v = readDotted(config, MEMORY_TOGGLE_PATHS[key])
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}

export async function getMemoryToggles(): Promise<MemoryToggles | null> {
  const res = await getAgentConfig()
  return res.kind === 'ok' ? togglesFromConfig(res.config) : null
}

export function setMemoryToggle(key: keyof MemoryToggles, value: boolean): Promise<ServeSendResult<unknown>> {
  return patchAgentConfig({ [MEMORY_TOGGLE_PATHS[key]]: value })
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export type MemoryResetTarget = 'all' | 'memory' | 'user'

export async function resetMemory(target: MemoryResetTarget = 'all'): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  const res = await serveSend<{ ok?: boolean; deleted?: unknown }>('POST', '/api/memory/reset', { target })
  if (!res.ok) {
    return {
      ok: false,
      deleted: [],
      error: res.status === 404 ? 'Your agent needs an update for this.' : res.error || 'Couldn’t clear memory.',
    }
  }
  const deleted = Array.isArray(res.data?.deleted) ? res.data!.deleted.filter((d): d is string => typeof d === 'string') : []
  return { ok: true, deleted }
}

// ---------------------------------------------------------------------------
// Viewer (read-only MEMORY.md / USER.md)
// ---------------------------------------------------------------------------

export const MEMORY_FILES = {
  memory: 'memories/MEMORY.md',
  user: 'memories/USER.md',
} as const

export type MemoryFileKey = keyof typeof MEMORY_FILES

/** True when this build can read local agent files through guarded IPC. */
export function canViewMemoryFiles(): boolean {
  return isBridgeAvailable()
}

/** File text; "" when the file doesn't exist; null when it can't be read. */
export async function readMemoryFile(which: MemoryFileKey): Promise<string | null> {
  const home = await resolveHermesHome()
  if (!home || !canViewMemoryFiles()) return null
  try {
    return await readText(`${home}/${MEMORY_FILES[which]}`)
  } catch (error) {
    return /not found|no such file|enoent/i.test(String(error)) ? '' : null
  }
}

const isSpace = (ch: string) => /\s/.test(ch)
const isLineBreak = (ch: string) => /[\n\r\u2028\u2029]/.test(ch)

/** `§` with only whitespace between it and a line break (or the text edge) on both sides. */
function isEntrySeparator(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && isSpace(text[i]) && !isLineBreak(text[i])) i--
  if (i >= 0 && !isLineBreak(text[i])) return false
  let j = at + 1
  while (j < text.length && isSpace(text[j]) && !isLineBreak(text[j])) j++
  return j >= text.length || isLineBreak(text[j])
}

/**
 * MEMORY.md entries are separated by `§` lines; show them as a list. Same
 * result as splitting on /\n?^\s*§\s*$\n?/m and trimming, without that
 * pattern's quadratic rescans of blank-heavy files.
 */
export function splitMemoryEntries(text: string): string[] {
  const entries: string[] = []
  let from = 0
  for (let at = text.indexOf('§'); at >= 0; at = text.indexOf('§', at + 1)) {
    if (!isEntrySeparator(text, at)) continue
    entries.push(text.slice(from, at))
    from = at + 1
  }
  entries.push(text.slice(from))
  return entries.map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// External providers
// ---------------------------------------------------------------------------

/** Providers we show as cards (others — openviking, brain_mcp, byterover — stay hidden). */
export const SUPPORTED_MEMORY_PROVIDERS = ['honcho', 'mem0', 'supermemory', 'retaindb', 'hindsight', 'holographic'] as const
export type SupportedMemoryProvider = (typeof SUPPORTED_MEMORY_PROVIDERS)[number]

export function isSupportedMemoryProvider(name: string): name is SupportedMemoryProvider {
  return (SUPPORTED_MEMORY_PROVIDERS as readonly string[]).includes(name)
}

export const MEMORY_PROVIDER_BLURB: Record<SupportedMemoryProvider, string> = {
  honcho: 'Builds a long-term picture of you across chats.',
  mem0: 'Hosted memory that extracts and recalls facts.',
  supermemory: 'Hosted memory with fast search across everything you save.',
  retaindb: 'Hosted memory database for your agent.',
  hindsight: 'Hindsight Cloud memory banks with recall and reflection.',
  holographic: 'Local fact store on your agent — no account needed.',
}

/**
 * No provider mode is forced by the local desktop app.
 */
export const PROVIDER_FIXED_VALUES: Partial<Record<SupportedMemoryProvider, Record<string, string>>> = {}

export interface MemoryProviderField {
  key: string
  label: string
  kind: 'text' | 'secret' | 'select' | 'boolean' | 'integer' | 'number' | string
  description: string
  placeholder: string
  required: boolean
  value: string | number | boolean
  isSet: boolean
  options: { value: string; label: string }[]
  url: string
  when: Record<string, unknown> | null
}

export interface MemoryProviderConfig {
  name: string
  label: string
  fields: MemoryProviderField[]
}

export function parseProviderConfig(raw: unknown, name: string): MemoryProviderConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fields = Array.isArray(o.fields) ? o.fields : []
  return {
    name: typeof o.name === 'string' ? o.name : name,
    label: typeof o.label === 'string' ? o.label : name,
    fields: fields
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { key?: unknown }).key === 'string')
      .map((f) => ({
        key: String(f.key),
        label: typeof f.label === 'string' && f.label ? f.label : String(f.key),
        kind: typeof f.kind === 'string' ? f.kind : 'text',
        description: typeof f.description === 'string' ? f.description : '',
        placeholder: typeof f.placeholder === 'string' ? f.placeholder : '',
        required: f.required === true,
        value: typeof f.value === 'string' || typeof f.value === 'number' || typeof f.value === 'boolean' ? f.value : '',
        isSet: f.is_set === true,
        options: Array.isArray(f.options)
          ? f.options
              .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
              .map((x) => ({ value: String(x.value ?? ''), label: String(x.label ?? x.value ?? '') }))
          : [],
        url: typeof f.url === 'string' ? f.url : '',
        when: f.when && typeof f.when === 'object' ? (f.when as Record<string, unknown>) : null,
      })),
  }
}

/** `when` conditions against current values (all must match). */
export function fieldVisible(field: MemoryProviderField, values: Record<string, unknown>): boolean {
  if (!field.when) return true
  return Object.entries(field.when).every(([k, v]) => String(values[k] ?? '') === String(v))
}

/**
 * The few fields a non-technical user needs: secrets (API keys) and required
 * fields, after applying fixed values and `when` rules. Everything else keeps
 * the provider's defaults.
 */
export function primaryProviderFields(name: string, config: MemoryProviderConfig): MemoryProviderField[] {
  const fixed: Record<string, string> = isSupportedMemoryProvider(name) ? PROVIDER_FIXED_VALUES[name] ?? {} : {}
  const values: Record<string, unknown> = {}
  for (const f of config.fields) values[f.key] = f.value
  Object.assign(values, fixed)
  const seen = new Set<string>()
  return config.fields.filter((f) => {
    if (f.key in fixed) return false
    if (!fieldVisible(f, values)) return false
    if (seen.has(f.key)) return false
    if (f.kind !== 'secret' && !f.required) return false
    seen.add(f.key)
    return true
  })
}

export type ProviderConfigResult =
  | { kind: 'ok'; config: MemoryProviderConfig }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export async function getMemoryProviderConfig(name: string): Promise<ProviderConfigResult> {
  const res = await serveGetDetailed<unknown>(`/api/memory/providers/${encodeURIComponent(name)}/config`)
  if (res.data) return { kind: 'ok', config: parseProviderConfig(res.data, name) }
  if ((res.status ?? res.error?.status) === 404) return { kind: 'unsupported' }
  return { kind: 'error', message: res.error?.message || 'Couldn’t load this provider.' }
}

function withFixed(name: string, values: Record<string, unknown>): Record<string, unknown> {
  const fixed = isSupportedMemoryProvider(name) ? PROVIDER_FIXED_VALUES[name] ?? {} : {}
  return { ...values, ...fixed }
}

/**
 * Save values and switch the agent to this provider (hermes' PUT config both
 * persists and activates; it 400s with a plain reason when not ready).
 */
export function saveMemoryProviderConfig(name: string, values: Record<string, unknown>): Promise<ServeSendResult<{ ok?: boolean; active?: string }>> {
  return serveSend('PUT', `/api/memory/providers/${encodeURIComponent(name)}/config`, {
    values: withFixed(name, values),
  })
}

export interface ProviderSetupResult {
  ok: boolean
  status?: string
  error?: string
}

/** Install the provider's dependencies on the agent (pip / external tools). */
export async function setupMemoryProvider(name: string, values: Record<string, unknown> = {}): Promise<ProviderSetupResult> {
  const res = await serveSend<{ ok?: boolean; status?: { status?: string } | null }>(
    'POST',
    `/api/memory/providers/${encodeURIComponent(name)}/setup`,
    { values: withFixed(name, values) },
  )
  if (!res.ok) return { ok: false, error: res.error || 'Setup failed on your agent.' }
  const status = res.data?.status && typeof res.data.status === 'object' ? res.data.status.status : undefined
  return { ok: res.data?.ok !== false, ...(status ? { status } : {}) }
}

/** "" switches back to built-in memory only. */
export function selectMemoryProvider(provider: string): Promise<ServeSendResult<{ ok?: boolean; active?: string }>> {
  return serveSend('PUT', '/api/memory/provider', { provider })
}

// ---------------------------------------------------------------------------
// Honcho OAuth (loopback flow on the agent)
// ---------------------------------------------------------------------------

export interface MemoryOAuthStatus {
  state: 'idle' | 'pending' | 'connected' | 'error' | string
  detail: string
  connected: boolean
}

function parseOAuthStatus(raw: unknown): MemoryOAuthStatus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    state: typeof o.state === 'string' ? o.state : 'idle',
    detail: typeof o.detail === 'string' ? o.detail : '',
    connected: o.connected === true,
  }
}

export async function startMemoryOAuth(provider: string): Promise<{ ok: boolean; status?: MemoryOAuthStatus; error?: string }> {
  const res = await serveSend<unknown>('POST', `/api/memory/providers/${encodeURIComponent(provider)}/oauth/start`, {})
  if (!res.ok) return { ok: false, error: res.status === 404 ? 'Your agent needs an update for this.' : res.error || 'Couldn’t start sign-in.' }
  return { ok: true, status: parseOAuthStatus(res.data) }
}

export async function getMemoryOAuthStatus(provider: string): Promise<MemoryOAuthStatus | null> {
  const res = await serveGetDetailed<unknown>(`/api/memory/providers/${encodeURIComponent(provider)}/oauth/status`)
  return res.data ? parseOAuthStatus(res.data) : null
}

/**
 * Honcho's OAuth uses a loopback redirect (127.0.0.1 on the agent) — it only
 * completes when the browser runs on the same machine as the agent, i.e. a
 * local `hermes serve`. Hosted VMs use the API-key field instead.
 */
export function memoryOAuthUsable(vmLinked: boolean): boolean {
  return !vmLinked
}
