/**
 * System notifications: the tap on the shoulder when the app is not in
 * front. A reply finished, the agent needs an approval, a routine ran.
 *
 * Desktop posts through the main process (window.nubAgent.notify: native
 * notification, Dock bounce, a click raises the window). The web and phone
 * apps use the browser's Notification API once the reader allows it.
 * Nothing is posted while the app is in front, or when switched off in
 * Settings (this device only).
 */

export type NotifyTarget = { kind: 'conversation'; id: string } | { kind: 'routines'; id?: string }

export interface SystemNotification {
  title: string
  body?: string
  target?: NotifyTarget | null
  /** Collapses repeats: the same tag within a few seconds posts once. */
  tag?: string
  /** Post even with the app in front (Settings → "Send a test"). */
  force?: boolean
}

const NOTIFICATION_PREFS_STORAGE = 'nub.notifications.v1'
const REPEAT_WINDOW_MS = 8_000

export function notificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(NOTIFICATION_PREFS_STORAGE) !== 'off'
  } catch {
    return true
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(NOTIFICATION_PREFS_STORAGE)
    else window.localStorage.setItem(NOTIFICATION_PREFS_STORAGE, 'off')
  } catch {
    /* storage blocked: the setting lasts this session only */
  }
}

/** Posts through the desktop main process when there is one. */
export function hasDesktopNotifications(): boolean {
  return typeof window !== 'undefined' && typeof window.nubAgent?.notify === 'function'
}

export type WebPermission = NotificationPermission | 'unsupported'

export function webNotificationPermission(): WebPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission
}

/** Ask the browser (call from a click: browsers ignore unprompted asks). */
export async function requestWebNotifications(): Promise<WebPermission> {
  if (webNotificationPermission() === 'unsupported') return 'unsupported'
  try {
    return await window.Notification.requestPermission()
  } catch {
    return webNotificationPermission()
  }
}

function appInFront(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

const clickListeners = new Set<(target: NotifyTarget | null) => void>()

/** The reader clicked a notification: open what it was about. */
export function onNotificationClick(cb: (target: NotifyTarget | null) => void): () => void {
  clickListeners.add(cb)
  return () => clickListeners.delete(cb)
}

/** Open what an item was about (the bell's app items use this too). */
export function openNotificationTarget(target: NotifyTarget | null): void {
  emitClick(target)
}

function emitClick(target: NotifyTarget | null): void {
  for (const l of [...clickListeners]) l(target)
}

let desktopClickWired = false
function wireDesktopClicks(): void {
  if (desktopClickWired || typeof window.nubAgent?.onNotifyClick !== 'function') return
  desktopClickWired = true
  window.nubAgent.onNotifyClick((v) => emitClick((v?.target as NotifyTarget | null | undefined) ?? null))
}

const recentTags = new Map<string, number>()

function isRepeat(tag: string | undefined, now: number): boolean {
  if (!tag) return false
  for (const [k, at] of recentTags) if (now - at > REPEAT_WINDOW_MS) recentTags.delete(k)
  if (recentTags.has(tag)) return true
  recentTags.set(tag, now)
  return false
}

/** Post `n` unless the app is in front, notifications are off, or it repeats. */
export async function notify(n: SystemNotification): Promise<boolean> {
  if (typeof window === 'undefined' || !notificationsEnabled()) return false
  if (!n.force && appInFront()) return false
  if (isRepeat(n.tag, Date.now())) return false
  if (hasDesktopNotifications()) {
    wireDesktopClicks()
    try {
      const res = await window.nubAgent!.notify!({ title: n.title, body: n.body, target: n.target ?? null, force: n.force })
      return Boolean(res?.ok && !res.skipped)
    } catch {
      return false
    }
  }
  if (webNotificationPermission() !== 'granted') return false
  try {
    const note = new window.Notification(n.title, { body: n.body, tag: n.tag })
    note.onclick = () => {
      window.focus()
      note.close()
      emitClick(n.target ?? null)
    }
    return true
  } catch {
    return false
  }
}

/** Plain one-line preview of a reply for a notification body. */
export function previewText(markdown: string, max = 140): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Test hook. */
export function resetSystemNotifyForTests(): void {
  recentTags.clear()
  clickListeners.clear()
  desktopClickWired = false
}
