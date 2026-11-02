/**
 * "Needs setup" for installed skills + the narrowly-scoped key writer the
 * Connect drawer uses.
 *
 * Readiness source, in order:
 *   1. `GET /api/skills` rows carrying `setup_needed` / `missing_env` /
 *      `missing_commands` (upstream hermes change, §6.1 of the coverage doc).
 *   2. Fallback: `GET /api/skills/content?name=` → parse SKILL.md frontmatter
 *      for declared keys/commands, and compare keys with `GET /api/env`
 *      (`{KEY: {is_set, url, description, …}}`).
 *
 * Key writes go through `setSkillEnv(skill, key, value)` only: the key must be
 * declared by THAT skill's frontmatter and must not be on the hard denylist
 * (LLM provider keys, `…_BASE_URL`, `HERMES_…`, `TERMINAL_…`, PATH, `LD_…`, `PYTHON…`,
 * and anything that looks like a platform `hermes_pk_…` key).
 */

import { serveGetDetailed, serveSend, type ServeSendResult } from './hermes-rest'
import { humanizeEnvName, parseSkillRequirements, type SkillEnvRequirement, type SkillRequirements } from './skill-frontmatter'

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

const DENIED_EXACT = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_TOKEN',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'NOUS_API_KEY',
  'PATH',
  'HOME',
  'SHELL',
  'NODE_OPTIONS',
])

const DENIED_PATTERNS: readonly RegExp[] = [
  /_BASE_URL$/,
  /^HERMES_/,
  /^TERMINAL_/,
  /^LD_/,
  /^PYTHON/,
  /^DYLD_/,
  /^TOOL_GATEWAY_/,
]

/** True when the app must never write this key, whatever a skill declares. */
export function isSkillEnvKeyDenied(key: string): boolean {
  const k = key.trim().toUpperCase()
  if (!k) return true
  if (DENIED_EXACT.has(k)) return true
  return DENIED_PATTERNS.some((re) => re.test(k))
}

/** Values that look like platform-issued keys are never written through here. */
function isDeniedValue(value: string): boolean {
  return /^hermes_pk_/i.test(value.trim())
}

// ---------------------------------------------------------------------------
// Skill content + env status
// ---------------------------------------------------------------------------

const requirementsCache = new Map<string, { at: number; value: SkillRequirements | null }>()
const REQ_TTL_MS = 60_000

/** Test-only / after install: drop cached frontmatter. */
export function clearSkillRequirementsCache(): void {
  requirementsCache.clear()
}

/** Frontmatter requirements, plus whether the agent couldn't be read at all.
 *  A failed read is never cached: the next open asks again. */
async function readSkillRequirements(name: string): Promise<{ value: SkillRequirements | null; failed: boolean }> {
  const hit = requirementsCache.get(name)
  if (hit && Date.now() - hit.at < REQ_TTL_MS) return { value: hit.value, failed: false }
  const res = await serveGetDetailed<{ content?: string }>(
    `/api/skills/content?${new URLSearchParams({ name }).toString()}`,
  )
  if (res.data == null) return { value: null, failed: true }
  const content = typeof res.data.content === 'string' ? res.data.content : null
  const value = content != null ? parseSkillRequirements(content) : null
  requirementsCache.set(name, { at: Date.now(), value })
  return { value, failed: false }
}

/** Parsed frontmatter requirements for an installed skill (null when unreadable). */
export async function getSkillRequirements(name: string): Promise<SkillRequirements | null> {
  return (await readSkillRequirements(name)).value
}

export interface EnvKeyStatus {
  isSet: boolean
  url?: string
  description?: string
}

export type EnvStatusMap = Record<string, EnvKeyStatus>

/** `GET /api/env` → per-key is_set (+ catalog url). Null when unreachable. */
export async function getEnvStatus(): Promise<EnvStatusMap | null> {
  const res = await serveGetDetailed<Record<string, unknown>>('/api/env')
  if (!res.data || typeof res.data !== 'object') return null
  const out: EnvStatusMap = {}
  for (const [key, row] of Object.entries(res.data)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    out[key] = {
      isSet: r.is_set === true,
      ...(typeof r.url === 'string' && r.url ? { url: r.url } : {}),
      ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** Binaries a stock hosted agent image is expected to have. */
export const BASE_IMAGE_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'curl', 'wget', 'jq', 'git', 'python', 'python3', 'pip', 'pip3', 'uv', 'uvx',
  'node', 'npm', 'npx', 'sed', 'awk', 'grep', 'find', 'tar', 'unzip', 'zip', 'ssh', 'openssl',
])

export interface SkillField extends SkillEnvRequirement {
  isSet: boolean
  /** The app is not allowed to write this key (show as "managed by Nub"). */
  denied: boolean
}

export interface SkillSetupState {
  needsSetup: boolean
  /** Keys the drawer should collect (declared, not denied). */
  fields: SkillField[]
  /** Required keys still missing (writable ones). */
  missingEnv: string[]
  /** Tools the skill needs that the agent doesn't have (or may not). */
  missingCommands: string[]
  /** Credential files (OAuth token files) the skill needs — not settable here. */
  missingFiles: string[]
  /** Where to get a key (first field url, catalog url, or homepage). */
  providerUrl?: string
  help?: string
  /** The agent couldn't be read, so nothing above is known (show Retry, not "no keys"). */
  unreachable?: boolean
}

/**
 * Upstream per-skill fields on `GET /api/skills` (hermes fork):
 * `setup_needed` (missing env / credential files only), `missing_env`,
 * `missing_commands` (agent PATH; does not set setup_needed),
 * `missing_credential_files`, `required_env: [{key, is_set, optional, description?, url?}]`.
 */
export interface ServeSkillReadiness {
  [key: string]: unknown
  setup_needed?: unknown
  missing_env?: unknown
  missing_commands?: unknown
  missing_credential_files?: unknown
  required_env?: unknown
}

interface UpstreamEnvRow {
  key: string
  isSet: boolean
  optional: boolean
  description?: string
  url?: string
}

function upstreamRequiredEnv(v: unknown): UpstreamEnvRow[] | null {
  if (!Array.isArray(v)) return null
  const out: UpstreamEnvRow[] = []
  for (const r of v) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key : typeof o.name === 'string' ? o.name : ''
    if (!key) continue
    out.push({
      key,
      isSet: o.is_set === true,
      optional: o.optional === true,
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      ...(typeof o.url === 'string' && o.url ? { url: o.url } : {}),
    })
  }
  return out
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
}

/** True when the `/api/skills` row already carries upstream readiness fields. */
export function hasUpstreamReadiness(row: ServeSkillReadiness): boolean {
  return typeof row.setup_needed === 'boolean' || Array.isArray(row.missing_env) || Array.isArray(row.required_env) ||
    Array.isArray(row.missing_commands) || Array.isArray(row.missing_credential_files)
}

/**
 * Combine frontmatter requirements, env status and (optional) upstream
 * readiness into one drawer state. Pure — unit-tested.
 */
export function computeSkillSetup(
  req: SkillRequirements | null,
  env: EnvStatusMap | null,
  upstream?: ServeSkillReadiness,
): SkillSetupState {
  const upstreamMissingEnv = upstream ? stringList(upstream.missing_env) : []
  const upstreamKnown = upstream ? hasUpstreamReadiness(upstream) : false
  const upstreamEnv = upstream ? upstreamRequiredEnv(upstream.required_env) : null
  const declared: SkillEnvRequirement[] = req?.env ? [...req.env] : []
  // Upstream names keys (with set state) even when we have no frontmatter.
  for (const row of upstreamEnv ?? []) {
    const existing = declared.find((d) => d.name === row.key)
    if (existing) {
      if (!existing.url && row.url) existing.url = row.url
      continue
    }
    declared.push({
      name: row.key,
      prompt: row.description || humanizeEnvName(row.key),
      ...(row.url ? { url: row.url } : {}),
      ...(row.optional ? { optional: true } : {}),
    })
  }
  for (const name of upstreamMissingEnv) {
    if (!declared.some((d) => d.name === name)) declared.push({ name, prompt: humanizeEnvName(name) })
  }

  const fields: SkillField[] = declared.map((d) => {
    const status = env?.[d.name]
    const up = upstreamEnv?.find((r) => r.key === d.name)
    const isSet = upstreamMissingEnv.includes(d.name)
      ? false
      : up
        ? up.isSet
        : status
          ? status.isSet
          : upstreamKnown
    const url = d.url ?? status?.url
    return { ...d, ...(url ? { url } : {}), isSet, denied: isSkillEnvKeyDenied(d.name) }
  })

  const missingEnv = fields.filter((f) => !f.isSet && !f.optional && !f.denied).map((f) => f.name)

  let missingCommands: string[]
  if (upstream && Array.isArray(upstream.missing_commands)) missingCommands = stringList(upstream.missing_commands)
  else missingCommands = (req?.commands ?? []).filter((c) => !BASE_IMAGE_COMMANDS.has(c.trim().toLowerCase()))

  const missingFiles = upstream && Array.isArray(upstream.missing_credential_files)
    ? stringList(upstream.missing_credential_files)
    : req?.credentialFiles ?? []

  const needsSetup = upstreamKnown
    ? upstream!.setup_needed === true || missingEnv.length > 0 || missingCommands.length > 0 || missingFiles.length > 0
    : missingEnv.length > 0 || missingCommands.length > 0 || missingFiles.length > 0

  const providerUrl = fields.find((f) => f.url)?.url ?? req?.homepage
  return {
    needsSetup,
    fields: fields.filter((f) => !f.denied),
    missingEnv,
    missingCommands,
    missingFiles,
    ...(providerUrl ? { providerUrl } : {}),
    ...(req?.setupHelp ? { help: req.setupHelp } : {}),
  }
}

/** Full readiness for one installed skill (fetches frontmatter when needed). */
export async function loadSkillSetup(
  name: string,
  upstream?: ServeSkillReadiness,
  env?: EnvStatusMap | null,
): Promise<SkillSetupState> {
  const [req, envMap, liveReadiness] = await Promise.all([
    readSkillRequirements(name),
    env !== undefined ? Promise.resolve(env) : getEnvStatus(),
    upstream ? Promise.resolve(upstream) : readLiveReadiness(name),
  ])
  const state = computeSkillSetup(req.value, envMap, liveReadiness)
  // Without the skill's details or the agent's own readiness fields, an empty
  // result means "couldn't ask", not "needs nothing".
  if (req.failed && !(liveReadiness && hasUpstreamReadiness(liveReadiness))) return { ...state, unreachable: true }
  return state
}

async function readLiveReadiness(name: string): Promise<ServeSkillReadiness | undefined> {
  const res = await serveGetDetailed<unknown>('/api/skills')
  const rows = Array.isArray(res.data) ? res.data
    : res.data && typeof res.data === 'object' && 'skills' in res.data ? res.data.skills : null
  if (!Array.isArray(rows)) return undefined
  return rows.find((row): row is ServeSkillReadiness => row && typeof row === 'object' && row.name === name)
}

/** Inert, bounded instructions only. Skill text never becomes a shell command. */
export async function loadSkillSetupInstructions(name: string): Promise<string | null> {
  const res = await serveGetDetailed<{ content?: unknown }>(
    `/api/skills/content?${new URLSearchParams({ name }).toString()}`,
  )
  return typeof res.data?.content === 'string' && res.data.content.trim()
    ? res.data.content.slice(0, 64000) : null
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function refused(message: string): ServeSendResult<unknown> {
  return { ok: false, data: null, error: message }
}

/**
 * Write one key for a skill. Only keys declared by THAT skill's SKILL.md
 * frontmatter are accepted, and never a denylisted key. Values are sent once
 * to `PUT /api/env` and never stored in the app.
 */
export async function setSkillEnv(skill: string, key: string, value: string): Promise<ServeSendResult<unknown>> {
  const k = key.trim()
  const v = value.trim()
  if (!skill.trim()) return refused('Pick a skill first.')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return refused('That setting name isn’t valid.')
  if (isSkillEnvKeyDenied(k)) return refused('Nub Agent manages this setting for you.')
  if (!v) return refused('Enter a value first.')
  if (isDeniedValue(v)) return refused('That looks like a Nub Agent key — it can’t be used here.')
  const req = await getSkillRequirements(skill)
  if (!req) return refused('Couldn’t read this skill’s setup details from your agent.')
  if (!req.env.some((e) => e.name === k)) return refused('This skill doesn’t use that setting.')
  return serveSend('PUT', '/api/env', { key: k, value: v })
}
