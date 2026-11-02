/**
 * Per-platform "who can talk to your agent" lists — the gateway's
 * `<PLATFORM>_ALLOWED_USERS` env vars (comma-separated). Hints and validation
 * mirror what each gateway adapter / the dashboard's `_ENV_VALUE_RULES`
 * accept, so a bad entry is caught before a save + restart.
 */

import {
  clearAgentEnv,
  isAgentEnvKeyAllowed,
  setAgentEnv,
  updateMessagingPlatform,
  type MessagingPlatform,
} from './messaging'

export interface AllowedUsersSpec {
  /** What one entry is, e.g. "Telegram user ID". */
  noun: string
  placeholder: string
  hint: string
  /** Normalise one raw entry; return null when it's invalid. */
  normalize: (raw: string) => string | null
  invalidMessage: string
}

const phone = (keepPlus: boolean) => (raw: string) => {
  const cleaned = raw.replace(/[\s().-]/g, '')
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null
  const digits = cleaned.replace(/^\+/, '')
  return keepPlus ? `+${digits}` : digits
}

const SPECS: Record<string, AllowedUsersSpec> = {
  telegram: {
    noun: 'Telegram user ID',
    placeholder: '123456789',
    hint: 'Numeric Telegram user IDs. Anyone can get theirs by messaging @userinfobot in Telegram.',
    normalize: (r) => (/^\d+$/.test(r.trim()) ? r.trim() : null),
    invalidMessage: 'Telegram user IDs are numbers only, like 123456789.',
  },
  discord: {
    noun: 'Discord user ID',
    placeholder: '112233445566778899',
    hint: 'Discord user IDs. In Discord, turn on Developer Mode, then right-click a person → Copy User ID.',
    normalize: (r) => (/^\d{15,21}$/.test(r.trim()) ? r.trim() : null),
    invalidMessage: 'Discord user IDs are long numbers, like 112233445566778899.',
  },
  slack: {
    noun: 'Slack member ID',
    placeholder: 'U01ABC2DEF3',
    hint: 'Slack member IDs. Open someone’s profile → ⋯ → Copy member ID.',
    normalize: (r) => {
      const v = r.trim().toUpperCase()
      return /^[UW][A-Z0-9]{2,}$/.test(v) ? v : null
    },
    invalidMessage: 'Slack member IDs look like U01ABC2DEF3.',
  },
  signal: {
    noun: 'phone number',
    placeholder: '+15551234567',
    hint: 'Phone numbers with country code, like +15551234567.',
    normalize: phone(true),
    invalidMessage: 'Enter phone numbers with the country code, like +15551234567.',
  },
  sms: {
    noun: 'phone number',
    placeholder: '+15551234567',
    hint: 'Phone numbers with country code, like +15551234567.',
    normalize: phone(true),
    invalidMessage: 'Enter phone numbers with the country code, like +15551234567.',
  },
  whatsapp: {
    noun: 'phone number',
    placeholder: '+15551234567',
    hint: 'WhatsApp phone numbers with country code, like +15551234567.',
    normalize: phone(false),
    invalidMessage: 'Enter phone numbers with the country code, like +15551234567.',
  },
  bluebubbles: {
    noun: 'phone number or email',
    placeholder: '+15551234567',
    hint: 'iMessage phone numbers (with country code) or Apple ID emails.',
    normalize: (r) => {
      const v = r.trim()
      if (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v)) return v.toLowerCase()
      return phone(true)(v)
    },
    invalidMessage: 'Enter a phone number with country code or an email address.',
  },
  matrix: {
    noun: 'Matrix ID',
    placeholder: '@alex:matrix.org',
    hint: 'Full Matrix IDs, like @alex:matrix.org.',
    normalize: (r) => (/^@[^\s:,]+:[^\s,]+$/.test(r.trim()) ? r.trim() : null),
    invalidMessage: 'Matrix IDs look like @alex:matrix.org.',
  },
  mattermost: {
    noun: 'Mattermost user ID',
    placeholder: 'user ID',
    hint: 'Mattermost user IDs (Profile → Copy ID).',
    normalize: (r) => (/^[a-z0-9]{26}$/i.test(r.trim()) ? r.trim().toLowerCase() : null),
    invalidMessage: 'Mattermost user IDs are 26 letters and numbers.',
  },
}

const GENERIC: AllowedUsersSpec = {
  noun: 'user ID',
  placeholder: 'user ID',
  hint: 'The IDs of people allowed to message your agent.',
  normalize: (r) => {
    const v = r.trim()
    return v && !/[\s,]/.test(v) ? v : null
  },
  invalidMessage: 'IDs can’t contain spaces or commas.',
}

export function allowedUsersSpec(platformId: string): AllowedUsersSpec {
  return SPECS[platformId] ?? GENERIC
}

/** The platform's allowlist env key when its catalog lists one. */
export function allowedUsersKey(p: MessagingPlatform): string | null {
  const v = [...p.env_vars, ...(p.extra_env_vars ?? [])].find((e) => /^[A-Z][A-Z0-9]*_ALLOWED_USERS$/.test(e.key) && !/_GROUP_/.test(e.key))
  return v?.key ?? null
}

/** Split pasted text into entries (commas, semicolons, new lines). */
export function splitEntries(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseAllowedList(csv: string | null | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Validate + normalise raw entries, de-duplicated against `existing`. */
export function normalizeEntries(
  platformId: string,
  raw: string[],
  existing: string[] = [],
): { added: string[]; invalid: string[] } {
  const spec = allowedUsersSpec(platformId)
  const seen = new Set(existing)
  const added: string[] = []
  const invalid: string[] = []
  for (const r of raw) {
    const v = spec.normalize(r)
    if (v === null) invalid.push(r)
    else if (!seen.has(v)) {
      seen.add(v)
      added.push(v)
    }
  }
  return { added, invalid }
}

/**
 * The saved list, from the catalog row's plain `value` (newer agents return it
 * for non-secret allowlist keys). `null` = set but not readable here (older
 * agent) — the UI falls back to "saving replaces the list". Never uses
 * the dashboard env "reveal" route, which is blocked because it can expose platform keys.
 */
export function savedAllowedUsers(row: { is_set?: boolean; value?: string | null } | undefined): string[] | null {
  if (!row?.is_set) return []
  if (typeof row.value === 'string') return parseAllowedList(row.value)
  return null
}

/** Save the list: via the platform endpoint when the key is in its catalog, else the allowlisted env writer. */
export async function saveAllowedUsers(
  p: MessagingPlatform,
  key: string,
  list: string[],
): Promise<{ ok: boolean; error?: string }> {
  const inCatalog = [...p.env_vars, ...(p.extra_env_vars ?? [])].some((v) => v.key === key)
  if (inCatalog) {
    const res = await updateMessagingPlatform(
      p.id,
      list.length ? { env: { [key]: list.join(',') } } : { clear_env: [key] },
    )
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Couldn’t save the list.' }
  }
  if (!isAgentEnvKeyAllowed(key)) return { ok: false, error: 'This list can’t be changed from the app.' }
  const res = list.length ? await setAgentEnv(key, list.join(',')) : await clearAgentEnv(key)
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Couldn’t save the list.' }
}
