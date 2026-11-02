/**
 * Skills gallery client — hermes `hermes_cli/web_routers/skills.py` hub routes.
 *
 *   GET  /api/skills/hub/official            optional-skills catalog (+ installed flag)
 *   GET  /api/skills/hub/search?q=&limit=    hub search across sources
 *   GET  /api/skills/hub/preview?identifier= SKILL.md + file list, no install
 *   GET  /api/skills/hub/scan?identifier=    install-time security scan (risk badge)
 *   POST /api/skills/hub/install {identifier}   → background action {ok,pid,name}
 *   POST /api/skills/hub/uninstall {name}        → background action
 *   POST /api/skills/hub/update {}               → background action "skills-update"
 *   GET  /api/actions/{name}/status          {name,running,exit_code,pid,lines}
 *
 * Everything goes through the `serve*` helpers (VM link / web proxy / local
 * serve). A 404 means the agent predates the route → `unsupported`.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { skillFeasibility } from './skill-feasibility'

export interface HubSkill {
  name: string
  description: string
  source: string
  identifier: string
  trust_level: string
  repo?: string | null
  tags: string[]
  category?: string
  installed?: boolean
}

export type HubListResult =
  | { kind: 'ok'; skills: HubSkill[]; hiddenCount: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

const UPDATE_MESSAGE = 'Your agent needs an update for this.'

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function parseHubSkill(raw: unknown): HubSkill | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const identifier = str(o.identifier) || str(o.name)
  const name = str(o.name) || identifier
  if (!name) return null
  return {
    name,
    description: str(o.description),
    source: str(o.source),
    identifier,
    trust_level: str(o.trust_level) || 'community',
    repo: typeof o.repo === 'string' ? o.repo : null,
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    ...(typeof o.category === 'string' ? { category: o.category } : {}),
    ...(typeof o.installed === 'boolean' ? { installed: o.installed } : {}),
  }
}

/** Parse + drop skills that can't work on a hosted Linux VM. */
export function feasibleHubSkills(rows: unknown[]): { skills: HubSkill[]; hiddenCount: number } {
  const parsed = rows.map(parseHubSkill).filter((s): s is HubSkill => s != null)
  const skills = parsed.filter((s) => skillFeasibility(s).ok)
  return { skills, hiddenCount: parsed.length - skills.length }
}

function errorResult(status: number | undefined, message: string | undefined): HubListResult {
  if (status === 404) return { kind: 'unsupported' }
  return { kind: 'error', message: message || 'Couldn’t reach your agent.' }
}

export async function listOfficialSkills(): Promise<HubListResult> {
  const res = await serveGetDetailed<{ skills?: unknown[] }>('/api/skills/hub/official')
  if (res.data && Array.isArray(res.data.skills)) return { kind: 'ok', ...feasibleHubSkills(res.data.skills) }
  return errorResult(res.status ?? res.error?.status, res.error?.message)
}

export interface HubSearchResult {
  kind: 'ok'
  skills: HubSkill[]
  hiddenCount: number
  /** identifier → installed lock entry. */
  installed: Record<string, unknown>
  timedOut: string[]
}

export async function searchHubSkills(
  query: string,
  limit = 20,
): Promise<HubSearchResult | Exclude<HubListResult, { kind: 'ok' }>> {
  const q = query.trim()
  if (!q) return { kind: 'ok', skills: [], hiddenCount: 0, installed: {}, timedOut: [] }
  const params = new URLSearchParams({ q, limit: String(limit) })
  const res = await serveGetDetailed<{ results?: unknown[]; installed?: Record<string, unknown>; timed_out?: unknown[] }>(
    `/api/skills/hub/search?${params.toString()}`,
  )
  if (res.data && Array.isArray(res.data.results)) {
    const installed = res.data.installed && typeof res.data.installed === 'object' ? res.data.installed : {}
    const { skills, hiddenCount } = feasibleHubSkills(res.data.results)
    return {
      kind: 'ok',
      skills: skills.map((s) => ({ ...s, installed: s.installed ?? s.identifier in installed })),
      hiddenCount,
      installed,
      timedOut: Array.isArray(res.data.timed_out) ? res.data.timed_out.filter((t): t is string => typeof t === 'string') : [],
    }
  }
  const err = errorResult(res.status ?? res.error?.status, res.error?.message)
  return err.kind === 'ok' ? { kind: 'error', message: 'unexpected' } : err
}

export interface HubPreview {
  name: string
  description: string
  identifier: string
  trust_level: string
  skill_md: string
  files: string[]
}

export async function previewHubSkill(identifier: string): Promise<HubPreview | null> {
  const res = await serveGetDetailed<Record<string, unknown>>(
    `/api/skills/hub/preview?${new URLSearchParams({ identifier }).toString()}`,
  )
  const d = res.data
  if (!d || typeof d !== 'object') return null
  return {
    name: str(d.name) || identifier,
    description: str(d.description),
    identifier: str(d.identifier) || identifier,
    trust_level: str(d.trust_level) || 'community',
    skill_md: str(d.skill_md),
    files: Array.isArray(d.files) ? d.files.filter((f): f is string => typeof f === 'string') : [],
  }
}

export interface HubScan {
  verdict: 'safe' | 'caution' | 'dangerous' | string
  policy: 'allow' | 'ask' | 'block'
  policy_reason: string
  trust_level: string
  summary: string
  severity_counts: { critical: number; high: number; medium: number; low: number }
  findings: { severity: string; category: string; file: string; line: number | null; description: string }[]
}

export async function scanHubSkill(identifier: string): Promise<HubScan | null> {
  const res = await serveGetDetailed<Record<string, unknown>>(
    `/api/skills/hub/scan?${new URLSearchParams({ identifier }).toString()}`,
  )
  const d = res.data
  if (!d || typeof d !== 'object') return null
  const counts = (d.severity_counts && typeof d.severity_counts === 'object' ? d.severity_counts : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const policy = d.policy === 'allow' || d.policy === 'ask' || d.policy === 'block' ? d.policy : 'ask'
  return {
    verdict: str(d.verdict) || 'caution',
    policy,
    policy_reason: str(d.policy_reason),
    trust_level: str(d.trust_level),
    summary: str(d.summary),
    severity_counts: {
      critical: num(counts.critical),
      high: num(counts.high),
      medium: num(counts.medium),
      low: num(counts.low),
    },
    findings: Array.isArray(d.findings)
      ? d.findings
          .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
          .map((f) => ({
            severity: str(f.severity),
            category: str(f.category),
            file: str(f.file),
            line: typeof f.line === 'number' ? f.line : null,
            description: str(f.description),
          }))
      : [],
  }
}

export type RiskTone = 'ok' | 'warn' | 'error'

export interface RiskBadge {
  label: string
  tone: RiskTone
  /** Install allowed without an extra confirmation. */
  canInstall: boolean
  needsConfirm: boolean
}

/** Scan → plain badge. `block` can't be installed; `ask` needs a confirm. */
export function riskBadge(scan: HubScan): RiskBadge {
  if (scan.policy === 'block' || scan.verdict === 'dangerous') {
    return { label: 'Blocked — failed the safety check', tone: 'error', canInstall: false, needsConfirm: false }
  }
  if (scan.policy === 'ask' || scan.verdict === 'caution' || scan.severity_counts.high > 0 || scan.severity_counts.critical > 0) {
    return { label: 'Review before adding', tone: 'warn', canInstall: true, needsConfirm: true }
  }
  return { label: 'Passed the safety check', tone: 'ok', canInstall: true, needsConfirm: false }
}

// ---------------------------------------------------------------------------
// Background actions (install / uninstall / update)
// ---------------------------------------------------------------------------

export interface ActionStart {
  ok: boolean
  /** Action name to poll at /api/actions/{name}/status. */
  action?: string
  error?: string
  unsupported?: boolean
}

async function startAction(path: string, body: Record<string, unknown>): Promise<ActionStart> {
  const res = await serveSend<{ ok?: boolean; name?: string }>('POST', path, body)
  if (!res.ok) {
    if (res.status === 404) return { ok: false, unsupported: true, error: UPDATE_MESSAGE }
    return { ok: false, error: res.error || 'Your agent couldn’t start that.' }
  }
  const action = res.data && typeof res.data.name === 'string' ? res.data.name : undefined
  return { ok: true, action }
}

export function installHubSkill(identifier: string): Promise<ActionStart> {
  return startAction('/api/skills/hub/install', { identifier })
}

export function uninstallHubSkill(name: string): Promise<ActionStart> {
  return startAction('/api/skills/hub/uninstall', { name })
}

export function updateHubSkills(): Promise<ActionStart> {
  return startAction('/api/skills/hub/update', {})
}

export interface ActionStatus {
  name: string
  running: boolean
  exitCode: number | null
  lines: string[]
}

export async function getActionStatus(name: string): Promise<ActionStatus | null> {
  const res = await serveGetDetailed<Record<string, unknown>>(
    `/api/actions/${encodeURIComponent(name)}/status?lines=40`,
  )
  const d = res.data
  if (!d || typeof d !== 'object') return null
  return {
    name: str(d.name) || name,
    running: d.running === true,
    exitCode: typeof d.exit_code === 'number' ? d.exit_code : null,
    lines: Array.isArray(d.lines) ? d.lines.filter((l): l is string => typeof l === 'string') : [],
  }
}

export interface ActionOutcome {
  ok: boolean
  /** Last log lines (secondary text only). */
  lines: string[]
  timedOut?: boolean
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Poll an action until it stops; ok ⇔ exit code 0. */
export async function waitForAction(name: string, opts: WaitOptions = {}): Promise<ActionOutcome> {
  const interval = opts.intervalMs ?? 1500
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
  const sleep = opts.sleep ?? defaultSleep
  let last: ActionStatus | null = null
  let misses = 0
  while (!opts.signal?.aborted) {
    const status = await getActionStatus(name)
    if (status) {
      last = status
      misses = 0
      if (!status.running && status.exitCode !== null) {
        return { ok: status.exitCode === 0, lines: status.lines }
      }
      // Finished without a recorded exit code (process reaped elsewhere).
      if (!status.running && status.exitCode === null && status.lines.length > 0) {
        return { ok: true, lines: status.lines }
      }
    } else if (++misses >= 5) {
      return { ok: false, lines: last?.lines ?? [] }
    }
    if (Date.now() >= deadline) return { ok: false, lines: last?.lines ?? [], timedOut: true }
    await sleep(interval)
  }
  return { ok: false, lines: last?.lines ?? [] }
}

/** Plain-language trust label for a hub source. */
export function trustLabel(trust: string): string {
  if (trust === 'builtin') return 'Built in'
  if (trust === 'trusted') return 'Official'
  return 'Community'
}
