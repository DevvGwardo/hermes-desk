import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { BusNotification } from '../lib/hermes-rest'
import {
  NOTIFICATION_KIND_FILTERS,
  filterNotifications,
  kindLabel,
  readLocalNotifications,
  writeLocalNotifications,
  NOTIFICATIONS_CHANGED_EVENT,
  NOTIFICATIONS_STORAGE_KEY,
  type NotificationKindFilter,
} from '../lib/notifications'
import { openNotificationTarget } from '../lib/system-notify'
import { NotificationDetail } from './NotificationDetail'
import { formatFriendlyWhen } from '../lib/friendly-time'

/**
 * TopBar bell → local inbox popover. Hermes Desk adds routine, approval and
 * reply items locally. Feed and storage events update it without a heartbeat
 * or legacy server probes. Filters still support previously cached items.
 */
const EMPTY_FOR_FILTER: Record<Exclude<NotificationKindFilter, 'all'>, string> = {
  agent: 'Routine results, approvals and replies you missed show here.',
  pr: 'No PR notifications yet.',
  ci: 'No CI notifications yet.',
  issue: 'No issue notifications yet.',
}

/** `phone`: the phone shell's 48px round header button, with the list as a
 *  full-width card under the header instead of a 320px popover that would
 *  run off a 390px screen. */
export const NotificationsBell = memo(function NotificationsBell({ phone = false }: { phone?: boolean } = {}) {
  const [items, setItems] = useState<BusNotification[]>(readLocalNotifications)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<NotificationKindFilter>('all')
  /** A routine result read in full in the side drawer. */
  const [detail, setDetail] = useState<BusNotification | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const refresh = useCallback(() => setItems(readLocalNotifications()), [])

  // The app's own items (routine ran, approval waiting, reply while away)
  // land in the local feed; an open bell shows them at once.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === NOTIFICATIONS_STORAGE_KEY || event.key === null) refresh()
    }
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', onStorage)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    // Esc closes the list and hands focus back to the bell (the detail
    // drawer handles its own Esc). Stopped here so a chat-level Esc (find
    // bar, draft) doesn't also fire.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || detail) return
      e.stopPropagation()
      setOpen(false)
      bellRef.current?.focus()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, detail])

  const unread = items.filter((n) => !n.read)
  // PRs / CI / Issues only mean something once GitHub items arrive.
  const hasDevItems = items.some((n) => n.kind === 'pr' || n.kind === 'ci' || n.kind === 'issue')
  const filters = NOTIFICATION_KIND_FILTERS.filter(
    (f) => f.id === 'all' || f.id === 'agent' || f.id === filter || hasDevItems,
  )
  const visible = filterNotifications(items, filter)

  const markAllRead = useCallback(() => {
    const next = items.map((n) => ({ ...n, read: true }))
    setItems(next)
    writeLocalNotifications(next)
  }, [items])

  /** Jump to what the item points at: the routine, the chat, or the link. */
  const openTarget = useCallback((n: BusNotification) => {
    if (n.target) {
      openNotificationTarget(
        n.target.kind === 'conversation' && n.target.id
          ? { kind: 'conversation', id: n.target.id }
          : { kind: 'routines', id: n.target.id },
      )
    } else if (n.url) window.open(n.url, '_blank', 'noopener,noreferrer')
  }, [])

  const openItem = useCallback(
    (n: BusNotification) => {
      const next = items.map((it) => (it.id === n.id ? { ...it, read: true } : it))
      setItems(next)
      writeLocalNotifications(next)
      // A routine's result is a report: read it in the drawer. Approvals,
      // replies and GitHub items go straight to where they point.
      if (n.kind === 'routine' && n.target?.kind === 'routines') setDetail(n)
      else openTarget(n)
      setOpen(false)
    },
    [items, openTarget],
  )

  const closeDetail = useCallback(() => setDetail(null), [])

  return (
    <div className="relative" ref={wrapRef} onKeyDown={event => {
      if (event.key !== 'Escape' || !open || detail) return
      // Consume the inner dismissal before a parent menu's React handler.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      bellRef.current?.focus()
    }}>
      <button
        ref={bellRef}
        type="button"
        data-testid="notifications-bell"
        // The label replaces the badge's text, so it carries the count.
        aria-label={unread.length > 0 ? `Notifications, ${unread.length} unread` : 'Notifications'}
        title="Notifications"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          if (!open) refresh()
        }}
        className={
          phone
            ? 'nub-mobile-round relative'
            : `relative flex h-8 w-8 items-center justify-center rounded-full border transition ${tab(false)}`
        }
      >
        <svg width={phone ? 18 : 15} height={phone ? 18 : 15} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 2a4 4 0 0 0-4 4v2.5L3 11h10l-1-2.5V6a4 4 0 0 0-4-4ZM6.5 13a1.5 1.5 0 0 0 3 0"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread.length > 0 && (
          <span
            data-testid="notifications-unread-dot"
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--ca-primary-fill)] px-1 text-[9px] font-semibold text-white"
          >
            {unread.length}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="notifications-popover"
          data-esc-layer
          className={`${
            phone ? 'fixed inset-x-3 top-[76px]' : 'absolute right-0 top-10 w-80'
          } z-50 overflow-hidden rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] shadow-lg`}
        >
          <div className="flex items-center justify-between border-b border-[var(--ca-border)] px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ca-ink-muted)]">
              Notifications
            </span>
            {unread.length > 0 && (
              <button
                type="button"
                data-testid="notifications-mark-read"
                onClick={() => void markAllRead()}
                className="text-[11px] font-medium text-[var(--ca-primary-text)] hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
          <div
            role="group"
            aria-label="Filter notifications"
            className="flex gap-1 border-b border-[var(--ca-border)] px-2 py-1.5"
          >
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                data-testid={`notifications-filter-${f.id}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  filter === f.id
                    ? 'bg-[var(--ca-ink)] text-[var(--ca-card)]'
                    : 'text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--ca-ink-muted)]">
              {items.length === 0 || filter === 'all'
                ? 'No notifications yet.'
                : EMPTY_FOR_FILTER[filter]}
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {visible.map((n) => {
                const pill = kindLabel(n.kind)
                return (
                <li key={n.id}>
                  <button
                    type="button"
                    data-testid={`notification-item-${n.id}`}
                    onClick={() => openItem(n)}
                    className={`flex w-full flex-col gap-0.5 border-b border-[var(--ca-border)] px-3 py-2 text-left transition hover:bg-[var(--ca-primary-soft)] ${
                      n.read ? '' : 'bg-[var(--ca-primary)]/5'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {!n.read && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ca-primary)]" />
                      )}
                      {pill ? (
                        <span
                          data-testid="notification-kind-pill"
                          className="shrink-0 rounded-md bg-[var(--ca-card)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]"
                        >
                          {pill}
                        </span>
                      ) : null}
                      <span
                        className={`truncate text-xs ${n.read ? 'text-[var(--ca-ink-muted)]' : 'font-medium text-[var(--ca-ink)]'}`}
                      >
                        {n.title}
                      </span>
                    </span>
                    {n.body ? (
                      <span className="line-clamp-2 text-[11px] leading-snug text-[var(--ca-ink)]/80">{n.body}</span>
                    ) : null}
                    <span className="truncate text-[10px] text-[var(--ca-ink-muted)]">
                      {[n.repo, n.target ? null : kindLabel(n.kind), fmtTime(n.at)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {detail && (
        <NotificationDetail
          notification={detail}
          onClose={closeDetail}
          onOpenTarget={(n) => {
            setDetail(null)
            openTarget(n)
          }}
        />
      )}
    </div>
  )
})

function fmtTime(at?: string): string {
  if (!at || !Number.isFinite(Date.parse(at))) return ''
  return formatFriendlyWhen(at)
}

const tab = (active: boolean) =>
  active
    ? 'border-[var(--ca-primary)]/40 bg-[var(--ca-primary)]/10 text-[var(--ca-primary-text)]'
    : 'border-[var(--ca-border)] text-[var(--ca-ink-muted)] hover:border-[var(--ca-primary)]/30 hover:text-[var(--ca-ink)]'
