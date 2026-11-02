/**
 * Plain-language text for a failed file read or folder listing. The sources
 * throw whatever the platform, the desktop bridge or fetch said ("fs list
 * failed (502)", "Instance has no SSH address", "ENOENT", "timed out"), which
 * means nothing to the person looking at their files.
 */

const MESSAGES = {
  offline: 'You seem to be offline. Check your connection and try again.',
  slow: "Your agent's computer is taking too long to answer. It may be waking up, so try again in a minute.",
  asleep: "Can't reach your agent's computer right now. It may be asleep or restarting. Try again in a minute.",
  relink: "This device isn't connected to your agent anymore. Link it again to see your files.",
  plan: 'Your plan has ended, so your files are paused. Renew to see them again.',
  gone: "This file isn't there anymore. It may have been moved or deleted.",
  folder: "That's a folder, not a file.",
  tooBig: 'This file is too big to show here. Download it to open it.',
  denied: "You don't have access to this file.",
  generic: 'Something went wrong. Try again in a moment.',
} as const

export function friendlyFileError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const m = raw.toLowerCase()
  // Already written for people (the panel's own timeout, the not-linked hint).
  if (/taking too long/.test(m)) return MESSAGES.slow
  if (/link your agent/.test(m)) return MESSAGES.relink
  if (/failed to fetch|networkerror|network request failed|err_internet|load failed/.test(m)) return MESSAGES.offline
  if (/timed out|timeout|\b504\b|aborted/.test(m)) return MESSAGES.slow
  if (/subscription_required|\b402\b/.test(m)) return MESSAGES.plan
  if (/unauthori[sz]ed|\b401\b|re-link/.test(m)) return MESSAGES.relink
  if (/\b413\b|too large/.test(m)) return MESSAGES.tooBig
  if (/is a directory|eisdir/.test(m)) return MESSAGES.folder
  if (/not found|enoent|no such file|\b404\b/.test(m)) return MESSAGES.gone
  if (/forbidden|\b403\b|eacces|eperm|permission denied/.test(m)) return MESSAGES.denied
  if (/ssh|\b50[23]\b|unreachable|econnrefused|econnreset|not running|request failed|offline/.test(m)) return MESSAGES.asleep
  return MESSAGES.generic
}
