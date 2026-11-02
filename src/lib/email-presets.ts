/**
 * Mail-provider presets for the Hermes email gateway (IMAP in, SMTP out).
 * Hosts/ports mirror the providers' published IMAP/SMTP settings; the user
 * only types an address + app password and the rest is filled in.
 */

export interface EmailPreset {
  id: string
  label: string
  /** Lower-case address domains that auto-select this preset. */
  domains: string[]
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /** Where the user creates an app password (2FA accounts). */
  appPasswordUrl?: string
  /** One-line hint shown under the password field. */
  passwordHint: string
}

export const EMAIL_PRESETS: EmailPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    passwordHint: 'Turn on 2-Step Verification, then create a 16-character app password.',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    passwordHint: 'Use an app password from your Microsoft account security page.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    appPasswordUrl: 'https://account.apple.com/account/manage',
    passwordHint: 'Create an app-specific password under Sign-In and Security.',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 587,
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    passwordHint: 'Generate an app password under Account security.',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 587,
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps',
    passwordHint: 'Create an app password with IMAP + SMTP access.',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 587,
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    passwordHint: 'Enable IMAP in Zoho Mail settings, then create an app password.',
  },
]

export const CUSTOM_PRESET_ID = 'custom'

export function presetById(id: string): EmailPreset | undefined {
  return EMAIL_PRESETS.find((p) => p.id === id)
}

/** Preset for an address's domain; undefined for custom/company domains. */
export function detectEmailPreset(address: string): EmailPreset | undefined {
  const at = address.lastIndexOf('@')
  if (at < 0) return undefined
  const domain = address.slice(at + 1).trim().toLowerCase()
  if (!domain) return undefined
  return EMAIL_PRESETS.find((p) => p.domains.includes(domain))
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * Normalise an allowed-senders field ("a@x.com; b@y.com\nc@z.com") to the
 * comma list Hermes reads from EMAIL_ALLOWED_USERS. Returns the bad entries
 * separately so the form can flag them instead of silently dropping them.
 */
export function parseAllowedSenders(raw: string): { list: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const list: string[] = []
  const invalid: string[] = []
  for (const p of parts) {
    const lower = p.toLowerCase()
    if (!looksLikeEmail(lower)) invalid.push(p)
    else if (!list.includes(lower)) list.push(lower)
  }
  return { list, invalid }
}
