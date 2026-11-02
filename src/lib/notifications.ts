/**
 * Notification inbox local cache.
 *
 * Hermes Desk adds routine results, approvals and replies locally. The
 * legacy dashboard bus is unavailable; localStorage keeps the bell's feed
 * available offline without probing that server route.
 */

import type { BusNotification } from './hermes-rest'

export const NOTIFICATIONS_STORAGE_KEY = 'maia:notifications:v1'

const MAX_ITEMS = 100

export function isLocalNotificationsStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

/** Read the locally cached notification list (oldest-first as saved). */
export function readLocalNotifications(): BusNotification[] {
  if (!isLocalNotificationsStorage()) return []
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (n): n is BusNotification =>
        !!n && typeof n === 'object' && typeof (n as BusNotification).id === 'string' &&
        typeof (n as BusNotification).title === 'string',
    )
  } catch {
    return []
  }
}

/** Persist the list locally, capped to the newest MAX_ITEMS by `at`. */
export function writeLocalNotifications(items: BusNotification[]): void {
  if (!isLocalNotificationsStorage()) return
  try {
    const sorted = [...items].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    window.localStorage.setItem(
      NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify(sorted.slice(0, MAX_ITEMS)),
    )
  } catch {
    // Storage full/unavailable — the in-memory list still works this session.
  }
}

/**
 * Merge cached items with fresh server ones, deduped by id (server wins),
 * newest first. Read is sticky: an item read here stays read even when the
 * server copy says unread or leaves it unset. A refresh that left before
 * "Mark all read" reached the server answers with the old state, and must
 * not resurrect read notifications. Read on another device still arrives.
 */
export function mergeNotifications(
  local: BusNotification[],
  server: BusNotification[],
): BusNotification[] {
  const byId = new Map<string, BusNotification>()
  for (const n of [...local, ...server]) {
    const prev = byId.get(n.id)
    byId.set(n.id, prev && (n.read === undefined || prev.read === true) ? { ...n, read: prev.read } : n)
  }
  return [...byId.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

// ---------------------------------------------------------------------------
// #17: kind filter + poll schedule (desktop consume slice)
// ---------------------------------------------------------------------------

/** Base cadence for the bell's background poll (visible tab only). */
export const NOTIFY_POLL_MS = 60_000

/** Backoff never waits longer than this between polls. */
export const NOTIFY_MAX_POLL_DELAY_MS = 600_000

/**
 * Delay before the next poll given consecutive failed refreshes.
 * Exponential (60s, 120s, 240s, …) capped at 10 minutes. A zero/negative
 * streak means healthy — poll at base cadence.
 */
export function nextPollDelayMs(failStreak: number): number {
  if (!Number.isFinite(failStreak) || failStreak <= 0) return NOTIFY_POLL_MS
  const exp = NOTIFY_POLL_MS * 2 ** Math.min(Math.floor(failStreak), 10)
  return Math.min(exp, NOTIFY_MAX_POLL_DELAY_MS)
}

export type NotificationKindFilter = 'all' | 'agent' | 'pr' | 'ci' | 'issue'

export const NOTIFICATION_KIND_FILTERS: ReadonlyArray<{
  id: NotificationKindFilter
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agent' },
  { id: 'pr', label: 'PRs' },
  { id: 'ci', label: 'CI' },
  { id: 'issue', label: 'Issues' },
]

/**
 * Group a bus item for the bell filter. Exact-match on the server `kind`
 * contract (`pr` | `issue` | `ci` — see docs/hermes-capabilities.md §12);
 * anything else (push, comment, future kinds) groups as `other` and shows
 * under All only, never silently dropped.
 */
/** Kinds the app adds itself (lib/use-system-notifications.ts). */
export const APP_NOTIFICATION_KINDS = ['routine', 'approval', 'reply'] as const

export function kindGroup(n: BusNotification): NotificationKindFilter | 'other' {
  if (n.kind === 'pr' || n.kind === 'ci' || n.kind === 'issue') return n.kind
  if ((APP_NOTIFICATION_KINDS as readonly string[]).includes(n.kind ?? '')) return 'agent'
  return 'other'
}

/** Short pill label for a raw server kind (`pr` → `PR`, unknown kinds raw). */
export function kindLabel(kind?: string): string {
  if (kind === 'pr') return 'PR'
  if (kind === 'ci') return 'CI'
  if (kind === 'issue') return 'Issue'
  if (kind === 'routine') return 'Routine'
  if (kind === 'approval') return 'Approval'
  if (kind === 'reply') return 'Reply'
  return (kind ?? '').trim()
}

export function filterNotifications(
  items: BusNotification[],
  filter: NotificationKindFilter,
): BusNotification[] {
  if (filter === 'all') return items
  return items.filter((n) => kindGroup(n) === filter)
}

/** Fired on window when the app adds to the feed, so an open bell updates. */
export const NOTIFICATIONS_CHANGED_EVENT = 'nub:notifications-changed'

/**
 * Add an app item (routine ran, approval waiting, reply while away) to the
 * bell's feed. Newest first, deduped by id; capped like the rest of the feed.
 */
export function addAppNotification(n: BusNotification): void {
  const items = readLocalNotifications().filter((it) => it.id !== n.id)
  writeLocalNotifications([{ ...n, at: n.at ?? new Date().toISOString() }, ...items])
  try {
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT))
  } catch {
    /* no window (tests / SSR) */
  }
}
