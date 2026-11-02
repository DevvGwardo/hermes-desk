/**
 * Settings → Help: health check, security check, recent errors,
 * and the "update available" badge. Backup / restore was removed (desktop red
 * team sweep 3, M-1): the zip carries every secret on the VM and restore runs
 * `hermes import --force` past the config key allowlist.
 *
 * hermes runs doctor / security audit as background
 * actions: POST starts one, GET /api/actions/{name}/status tails its log
 * ({name, running, exit_code, pid, lines}). Log lines can carry secrets, so
 * everything shown to the user goes through redactSecrets first.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { restFailureText } from './agent-rest'

export type ActionName = 'doctor' | 'security-audit'

export interface ActionStatus {
  name: string
  running: boolean
  exitCode: number | null
  lines: string[]
}

export type ActionRun =
  | { kind: 'done'; status: ActionStatus; data?: Record<string, unknown> }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

const OLD_AGENT = 'Your agent needs an update for this.'

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  // Provider-style prefixed keys
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bhermes_pk_[A-Za-z0-9_-]+/g,
  /\bnub_desk_[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  // Telegram bot token
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Long opaque tokens (hex / base64-ish, 32+ chars)
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+_-]{40,}={0,2}/g,
]

/**
 * `Authorization: Bearer x`, `api_key=x`, `"password": "x"` → value masked.
 * The lookbehind starts the key-name prefix only at the beginning of a name, so
 * long token-like runs are scanned once instead of once per character.
 */
const KEY_VALUE =
  /((?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:authorization|key|token|secret|password|passwd|pwd|credential)["']?\s*[:=]\s*(?:bearer\s+)?["']?)([^\s"',;}&]+)/gi

export function redactSecrets(line: string): string {
  let out = line.replace(KEY_VALUE, (_m, k: string) => `${k}[hidden]`)
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [hidden]')
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[hidden]')
  return out
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export function cleanLine(line: string): string {
  return redactSecrets(line.replace(ANSI, '').trimEnd())
}

// ---------------------------------------------------------------------------
// Background actions
// ---------------------------------------------------------------------------

export function parseActionStatus(raw: unknown): ActionStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const lines = Array.isArray(r.lines) ? r.lines.filter((l): l is string => typeof l === 'string') : []
  return {
    name: typeof r.name === 'string' ? r.name : '',
    running: r.running === true,
    exitCode: typeof r.exit_code === 'number' ? r.exit_code : null,
    lines,
  }
}

/**
 * Lines of the most recent run only — the action log is appended across runs
 * and each run starts with `=== <name> started … ===`.
 */
export function latestRunLines(name: string, lines: readonly string[]): string[] {
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(`=== ${name} started`)) {
      start = i
      break
    }
  }
  return lines
    .slice(start + 1)
    .filter((l) => !/^=== .* (started|completed|finished) .*===$/.test(l.trim()))
    .map(cleanLine)
}

const START_PATH: Record<ActionName, string> = {
  doctor: '/api/ops/doctor',
  'security-audit': '/api/ops/security-audit',
}

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  signal?: { cancelled: boolean }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Poll GET /api/actions/{name}/status until the action stops running. */
export async function waitForAction(name: ActionName, opts: PollOptions = {}): Promise<ActionRun> {
  const interval = opts.intervalMs ?? 1500
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const sleep = opts.sleep ?? defaultSleep
  for (;;) {
    if (opts.signal?.cancelled) return { kind: 'error', message: 'cancelled' }
    const res = await serveGetDetailed<unknown>(`/api/actions/${encodeURIComponent(name)}/status?lines=400`)
    if (res.status === 404) return { kind: 'unsupported' }
    const status = parseActionStatus(res.data)
    if (!status && res.error) return { kind: 'error', message: res.error.message }
    if (status && !status.running) {
      return { kind: 'done', status: { ...status, lines: latestRunLines(name, status.lines) } }
    }
    if (Date.now() > deadline) return { kind: 'error', message: 'This is taking too long. Try again later.' }
    await sleep(interval)
  }
}

/** POST the start route, then wait for the action to finish. */
export async function runAction(
  name: Exclude<ActionName, 'import'>,
  body: Record<string, unknown> = {},
  opts: PollOptions = {},
): Promise<ActionRun> {
  const started = await serveSend<Record<string, unknown>>('POST', START_PATH[name], body)
  if (!started.ok) {
    if (started.status === 404) return { kind: 'unsupported' }
    return { kind: 'error', message: restFailureText(started, 'Your agent isn’t reachable right now.') }
  }
  const done = await waitForAction(name, opts)
  if (done.kind === 'done') return { ...done, data: started.data ?? undefined }
  return done
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type CheckTone = 'ok' | 'warn' | 'error'

export interface CheckSummary {
  tone: CheckTone
  headline: string
  problems: string[]
  warnings: string[]
  passed: number
  /** Doctor warnings left out of the list as not for the customer (still in the full report). */
  notes?: number
}

/**
 * `hermes doctor` warnings that aren't for a customer on a hosted agent, in
 * doctor.py's own wording: sign-ins for providers the platform doesn't use,
 * optional or platform-managed tools, skills that need an account (Settings →
 * Skills says so), and developer hints. They stay in the full report. ✗
 * failures are never left out.
 */
const DOCTOR_NOT_FOR_YOU: readonly RegExp[] = [
  /\(not logged in\)/i,
  /\(not configured\)/i,
  /\(optional\b/i,
  /\(system dependency not met\)/i,
  /\(missing [A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*\)/,
  /will be created on first use/i,
  /^No GITHUB_TOKEN\b/,
  /^Skills Hub directory not initialized/i,
  /^Not in virtual environment/i,
  /\blinger\b/i,
  /SOUL\.md not found/i,
  /^Honcho config not found/i,
  /recommended for RL Training/i,
]

export function isDoctorNoteForDevelopers(text: string): boolean {
  return DOCTOR_NOT_FOR_YOU.some((re) => re.test(text))
}

/** Drop CLI advice ("run `hermes update`", "run: hermes skills list"): nobody can type it in the app. */
// `(?<!\s)` starts each match at the head of a whitespace run (where the
// leftmost match begins anyway) and the separator owns its trailing spaces,
// so long space runs are scanned once instead of cubically.
export function plainDoctorLine(text: string): string {
  return text
    .replace(/(?<!\s)\s*\((?:[^()]*?\b)?run:?\s*`?hermes\b[^)]*\)/gi, '')
    .replace(/(?<!\s)\s*(?:(?:—|-|;)\s*)?run:?\s*`?hermes\b[^`]*`?\s*$/i, '')
    .replace(/`hermes [^`]*`/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** hermes doctor prints `✓ ok`, `⚠ warn`, `✗ fail` lines. */
export function summarizeDoctor(status: ActionStatus): CheckSummary {
  const problems: string[] = []
  const warnings: string[] = []
  let passed = 0
  let notes = 0
  for (const raw of status.lines) {
    const line = raw.trim()
    if (line.startsWith('✓')) passed++
    else if (line.startsWith('✗')) problems.push(plainDoctorLine(line.slice(1).trim()))
    else if (line.startsWith('⚠')) {
      const text = line.slice(1).trim()
      if (isDoctorNoteForDevelopers(text)) notes++
      else warnings.push(plainDoctorLine(text))
    }
  }
  const failedRun = status.exitCode != null && status.exitCode !== 0
  if (problems.length > 0 || (failedRun && passed === 0)) {
    return {
      tone: 'error',
      headline:
        problems.length > 0
          ? `Found ${problems.length} problem${problems.length === 1 ? '' : 's'}.`
          : 'The check could not finish.',
      problems,
      warnings,
      passed,
      notes,
    }
  }
  if (warnings.length > 0) {
    return {
      tone: 'warn',
      headline: `Working, with ${warnings.length} thing${warnings.length === 1 ? '' : 's'} worth a look.`,
      problems,
      warnings,
      passed,
      notes,
    }
  }
  return { tone: 'ok', headline: 'Everything looks good.', problems, warnings, passed, notes }
}

/** hermes security audit: "No known vulnerabilities…" or "Found N … finding(s)". */
export function summarizeAudit(status: ActionStatus): CheckSummary {
  const text = status.lines.join('\n')
  const found = text.match(/Found (\d+) known vulnerability finding/)
  const findings = status.lines
    .map((l) => l.trim())
    .filter((l) => /^(CRITICAL|HIGH|MODERATE|MEDIUM|LOW|UNKNOWN)\b/i.test(l))
  if (found) {
    const n = Number(found[1])
    const serious = findings.some((l) => /^(CRITICAL|HIGH)\b/i.test(l))
    return {
      tone: serious ? 'error' : 'warn',
      headline: `Found ${n} known security issue${n === 1 ? '' : 's'} in installed software. Updating your agent usually fixes these.`,
      problems: serious ? findings : [],
      warnings: serious ? [] : findings,
      passed: 0,
    }
  }
  if (/No known vulnerabilities/i.test(text)) {
    return { tone: 'ok', headline: 'No known security issues.', problems: [], warnings: [], passed: 1 }
  }
  if (status.exitCode != null && status.exitCode !== 0) {
    return { tone: 'error', headline: 'The security check could not finish.', problems: [], warnings: [], passed: 0 }
  }
  return { tone: 'ok', headline: 'Security check finished.', problems: [], warnings: [], passed: 0 }
}

// ---------------------------------------------------------------------------
// Recent errors
// ---------------------------------------------------------------------------

export type LogsResult =
  | { kind: 'ok'; lines: string[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

const LEVEL_RE = /\b(WARNING|WARN|ERROR|CRITICAL|FATAL|Traceback|Exception)\b/

/** Last 200 warning/error lines from the agent's error log, secrets hidden. */
export async function fetchRecentErrors(): Promise<LogsResult> {
  const res = await serveGetDetailed<{ lines?: unknown }>('/api/logs?file=errors&lines=200&level=WARNING')
  if (res.status === 404) return { kind: 'unsupported' }
  if (!res.data) {
    return { kind: 'error', message: restFailureText({ status: res.status, error: res.error?.message }, 'Your agent isn’t reachable right now.') }
  }
  const raw = Array.isArray(res.data.lines) ? res.data.lines.filter((l): l is string => typeof l === 'string') : []
  const lines = raw
    .filter((l) => LEVEL_RE.test(l) || /^\s+/.test(l))
    .slice(-200)
    .map(cleanLine)
  return { kind: 'ok', lines }
}

// ---------------------------------------------------------------------------
// Update badge
// ---------------------------------------------------------------------------

export interface AgentUpdateCheck {
  available: boolean
  currentVersion?: string
  behind?: number
}

/** GET /api/hermes/update/check — read-only; never applies an update. */
export async function checkAgentUpdate(): Promise<AgentUpdateCheck | null> {
  const res = await serveGetDetailed<Record<string, unknown>>('/api/hermes/update/check')
  const d = res.data
  if (!d || typeof d !== 'object') return null
  return {
    available: d.update_available === true,
    currentVersion: typeof d.current_version === 'string' ? d.current_version : undefined,
    behind: typeof d.behind === 'number' && d.behind > 0 ? d.behind : undefined,
  }
}

export const OLD_AGENT_MESSAGE = OLD_AGENT
