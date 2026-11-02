import { useCallback, useSyncExternalStore } from 'react'

export const CHAT_WALLPAPER_KEY = 'maia:chatWallpaper'
export const CHAT_WALLPAPER_IDS = ['sky', 'haze', 'blush', 'linen'] as const
export type ChatWallpaperId = (typeof CHAT_WALLPAPER_IDS)[number]
export const CHAT_WALLPAPER_DEFAULT: ChatWallpaperId = 'sky'

export const CHAT_WALLPAPERS: { id: ChatWallpaperId; label: string }[] = [
  { id: 'sky', label: 'Sky' },
  { id: 'haze', label: 'Haze' },
  { id: 'blush', label: 'Blush' },
  { id: 'linen', label: 'Linen' },
]

const ID_SET: ReadonlySet<string> = new Set(CHAT_WALLPAPER_IDS)

export function parseChatWallpaper(raw: unknown): ChatWallpaperId {
  return typeof raw === 'string' && ID_SET.has(raw) ? (raw as ChatWallpaperId) : CHAT_WALLPAPER_DEFAULT
}

export function chatWallpaperClass(id: ChatWallpaperId): string {
  return `chat-wall--${id}`
}

export function loadChatWallpaper(): ChatWallpaperId {
  try {
    return parseChatWallpaper(window.localStorage.getItem(CHAT_WALLPAPER_KEY))
  } catch {
    return CHAT_WALLPAPER_DEFAULT
  }
}

const listeners = new Set<() => void>()
let snapshot: ChatWallpaperId | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function getSnapshot(): ChatWallpaperId {
  if (snapshot == null) snapshot = loadChatWallpaper()
  return snapshot
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function saveChatWallpaper(id: ChatWallpaperId): void {
  const next = parseChatWallpaper(id)
  try {
    window.localStorage.setItem(CHAT_WALLPAPER_KEY, next)
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
  snapshot = next
  emit()
}

/** Settings + ChatPanel share this so the picker does not lift state through App. */
export function useChatWallpaper(): [ChatWallpaperId, (id: ChatWallpaperId) => void] {
  const id = useSyncExternalStore(subscribe, getSnapshot, () => CHAT_WALLPAPER_DEFAULT)
  const setWallpaper = useCallback((next: ChatWallpaperId) => {
    saveChatWallpaper(next)
  }, [])
  return [id, setWallpaper]
}
