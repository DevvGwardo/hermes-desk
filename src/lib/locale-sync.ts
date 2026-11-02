/**
 * Keep the agent's time zone (and UI language) in step with this device.
 *
 * Hosted agent VMs run in UTC, so "every day at 9am" fired at 9am UTC. Once
 * per app session, when the agent is reachable, we read its config and push
 * `timezone` (IANA name) — the device's zone, or the one the user picked in
 * Settings → General. `display.language` is pushed only when the agent is
 * still on its default and hermes ships a catalog for the device language.
 *
 * Several devices share one agent, and a pick is stored per device. So the
 * launch push never replaces a zone some other device (or the user, by hand)
 * set: it fills a default (empty / UTC), moves a zone this device pushed
 * itself, or sends this device's pick that never got through. Anything else
 * is kept, and Settings → Time zone offers "Use this device's time zone".
 */

import { getAgentConfig, patchAgentConfig, readDotted } from './agent-config'

const TZ_OVERRIDE_KEY = 'nub:agent-timezone-override:v1'
/** The zone this device last wrote to the agent (or saw it already had). */
const TZ_LAST_PUSHED_KEY = 'nub:agent-timezone-last-pushed:v1'

/** Locale catalogs hermes ships (`locales/*.yaml` / agent/i18n.py SUPPORTED_LANGUAGES). */
export const HERMES_LANGUAGES: readonly string[] = [
  'en', 'zh', 'zh-hant', 'ja', 'de', 'es', 'fr', 'tr', 'uk',
  'af', 'ko', 'it', 'ga', 'pt', 'ru', 'hu', 'ar',
]

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' ? tz : ''
  } catch {
    return ''
  }
}

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

/** Every IANA zone the runtime knows (falls back to a short list). */
export function timeZoneOptions(): string[] {
  let zones: string[] = []
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    if (typeof intl.supportedValuesOf === 'function') zones = intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  if (!zones.length) zones = [...FALLBACK_ZONES]
  const device = deviceTimeZone()
  const all = new Set(zones)
  all.add('UTC')
  if (device) all.add(device)
  return [...all].sort((a, b) => a.localeCompare(b))
}

/** The zone the user picked by hand, or null for "match this device". */
export function getTimeZoneOverride(): string | null {
  try {
    const v = window.localStorage.getItem(TZ_OVERRIDE_KEY)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

export function setTimeZoneOverride(tz: string | null): void {
  try {
    if (tz && tz.trim()) window.localStorage.setItem(TZ_OVERRIDE_KEY, tz.trim())
    else window.localStorage.removeItem(TZ_OVERRIDE_KEY)
  } catch {
    /* private mode / blocked storage — the setting just won't stick */
  }
}

/** The zone this device last wrote to the agent, or null. */
export function getLastPushedTimeZone(): string | null {
  try {
    const v = window.localStorage.getItem(TZ_LAST_PUSHED_KEY)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** Remember that the agent runs on `tz` because of this device. */
export function rememberPushedTimeZone(tz: string): void {
  try {
    if (tz.trim()) window.localStorage.setItem(TZ_LAST_PUSHED_KEY, tz.trim())
  } catch {
    /* blocked storage — the next launch just won't move this zone */
  }
}

/** The zone the agent should run in right now. */
export function desiredTimeZone(): string {
  return getTimeZoneOverride() ?? deviceTimeZone()
}

/** Map a BCP-47 tag (`navigator.language`) to a hermes locale, or null. */
export function hermesLanguageFor(tag: string | null | undefined): string | null {
  const key = (tag ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!key) return null
  if (key.startsWith('zh')) {
    if (/^zh-(hant|tw|hk|mo)\b/.test(key) || /-hant\b/.test(key)) return 'zh-hant'
    return 'zh'
  }
  if (HERMES_LANGUAGES.includes(key)) return key
  const base = key.split('-')[0]!
  return HERMES_LANGUAGES.includes(base) ? base : null
}

function deviceLanguage(): string {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
  } catch {
    return ''
  }
}

/** A zone the agent has only because nobody set one (hermes default / VM clock). */
function isDefaultZone(tz: string): boolean {
  return tz === '' || tz.toUpperCase() === 'UTC'
}

/**
 * Pure: should a launch push move the agent from `current` to `desired`?
 * Yes for a default zone, for a zone this device pushed itself, and for this
 * device's own pick that hasn't reached the agent yet. No for a zone set
 * elsewhere: another device, or the user in chat or on the website.
 */
export function shouldPushTimeZone(opts: {
  current: string
  desired: string
  lastPushed: string | null
  override: string | null
}): boolean {
  const { current, desired, lastPushed, override } = opts
  if (!desired || current === desired) return false
  if (isDefaultZone(current)) return true
  if (override && override !== lastPushed) return true
  return lastPushed !== null && current === lastPushed
}

/** Pure: which config paths to write given the agent's current config. */
export function localePatch(
  config: unknown,
  opts: { timeZone: string; language: string | null; lastPushed?: string | null; override?: string | null },
): Record<string, string> {
  const patch: Record<string, string> = {}
  const currentTz = readDotted(config, 'timezone')
  const tz = opts.timeZone.trim()
  const currentZone = typeof currentTz === 'string' ? currentTz.trim() : ''
  if (
    shouldPushTimeZone({
      current: currentZone,
      desired: tz,
      lastPushed: opts.lastPushed ?? null,
      override: opts.override ?? null,
    })
  ) {
    patch.timezone = tz
  }

  // Language: only replace hermes' default ('' / 'en') — never a choice made
  // elsewhere (TUI `/language`, config edits).
  const lang = opts.language
  const currentLang = readDotted(config, 'display.language')
  const current = typeof currentLang === 'string' ? currentLang.trim().toLowerCase() : ''
  if (lang && lang !== 'en' && (current === '' || current === 'en') && current !== lang) {
    patch['display.language'] = lang
  }
  return patch
}

export type LocaleSyncResult =
  | { kind: 'unreachable' }
  | { kind: 'in-sync' }
  /** The agent's zone was set elsewhere and left alone (language may still be in step). */
  | { kind: 'kept'; timeZone: string }
  | { kind: 'pushed'; patch: Record<string, string> }
  | { kind: 'failed'; error: string }

/** Read config, push what differs. Does not remember anything. */
export async function syncAgentLocale(): Promise<LocaleSyncResult> {
  const res = await getAgentConfig()
  if (res.kind !== 'ok') return { kind: 'unreachable' }
  const desired = desiredTimeZone()
  const patch = localePatch(res.config, {
    timeZone: desired,
    language: hermesLanguageFor(deviceLanguage()),
    lastPushed: getLastPushedTimeZone(),
    override: getTimeZoneOverride(),
  })
  const raw = readDotted(res.config, 'timezone')
  const current = typeof raw === 'string' ? raw.trim() : ''
  if (current && current === desired) rememberPushedTimeZone(desired)
  const kept = !patch.timezone && current !== desired ? { kind: 'kept' as const, timeZone: current } : null
  if (Object.keys(patch).length === 0) return kept ?? { kind: 'in-sync' }
  const write = await patchAgentConfig(patch)
  if (!write.ok) return { kind: 'failed', error: write.error ?? 'write failed' }
  if (patch.timezone) rememberPushedTimeZone(patch.timezone)
  return { kind: 'pushed', patch }
}

let syncedThisSession = false
let inflight: Promise<LocaleSyncResult> | null = null

/**
 * Once per app session: retried on the next call only while the agent was
 * unreachable. Safe to call from effects on every link change.
 */
export function syncAgentLocaleOnce(): Promise<LocaleSyncResult | null> {
  if (syncedThisSession) return Promise.resolve(null)
  if (inflight) return inflight
  inflight = syncAgentLocale()
    .then((r) => {
      if (r.kind !== 'unreachable') syncedThisSession = true
      return r
    })
    .catch(() => ({ kind: 'unreachable' }) as LocaleSyncResult)
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Test-only. */
export function __resetLocaleSync(): void {
  syncedThisSession = false
  inflight = null
}
