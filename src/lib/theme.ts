import { useCallback, useSyncExternalStore } from 'react'

export const THEME_KEY = 'maia:theme'
export const THEME_IDS = ['light', 'dark'] as const
export type ThemeId = (typeof THEME_IDS)[number]
export const THEME_DEFAULT: ThemeId = 'light'

/** Desktop/web canvas per theme — kept in step with `--ca-canvas` in index.css. */
export const THEME_COLORS: Record<ThemeId, string> = {
  light: '#9ecdff',
  dark: '#000000',
}

/** Phone-shell canvas per theme — `--gm-canvas` in mobile.css. The phone
 *  chrome is CREAM, not the desktop sky: painting sky blue behind the phone
 *  shell would put a band of the wrong colour above a cream app. */
export const PHONE_THEME_COLORS: Record<ThemeId, string> = {
  light: '#f7f6f3',
  dark: '#000000',
}

const ID_SET: ReadonlySet<string> = new Set(THEME_IDS)

export function parseTheme(raw: unknown): ThemeId {
  return typeof raw === 'string' && ID_SET.has(raw) ? (raw as ThemeId) : THEME_DEFAULT
}

export function loadTheme(): ThemeId {
  try {
    return parseTheme(window.localStorage.getItem(THEME_KEY))
  } catch {
    return THEME_DEFAULT
  }
}

const listeners = new Set<() => void>()
let snapshot: ThemeId | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function getSnapshot(): ThemeId {
  if (snapshot == null) snapshot = loadTheme()
  return snapshot
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

/** Paint the browser/OS chrome (mobile address bar, task switcher, PWA title
 *  bar) in the app's own canvas colour. Driven by the STORED theme rather
 *  than `prefers-color-scheme` — the in-app picker is authoritative, so a
 *  phone in OS-dark running the app in light must not get a black bar. */
function syncThemeColor(id: ThemeId): void {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  meta.setAttribute('content', THEME_COLORS[id])
}

/** Apply the selection to <html data-theme>. Light = attribute absent. No-op without a DOM. */
export function applyTheme(id: ThemeId): void {
  const next = parseTheme(id)
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (next === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  syncThemeColor(next)
}

export function saveTheme(id: ThemeId): void {
  const next = parseTheme(id)
  try {
    window.localStorage.setItem(THEME_KEY, next)
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
  snapshot = next
  applyTheme(next)
  emit()
}

/** Load the stored theme and apply it. Safe to call twice. */
export function initTheme(): ThemeId {
  const next = loadTheme()
  snapshot = next
  applyTheme(next)
  return next
}

/** Settings reads this so the picker does not lift state through App. */
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const id = useSyncExternalStore(subscribe, getSnapshot, () => THEME_DEFAULT)
  const setTheme = useCallback((next: ThemeId) => {
    saveTheme(next)
  }, [])
  return [id, setTheme]
}
