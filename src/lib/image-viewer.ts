/**
 * The full-screen image viewer's state. Every picture in the chat that can be
 * opened registers here with its element; opening one collects the others
 * in the same scroll area, in page order, so ←/→ walks the conversation's
 * pictures the way the reader sees them. One viewer (ImageViewerHost) is
 * mounted at the app root.
 */
import { useSyncExternalStore } from 'react'

export type ViewerItem =
  | { kind: 'vm'; path: string; name: string }
  | { kind: 'url'; url: string; name: string }

export interface ViewerState {
  items: ViewerItem[]
  index: number
}

const registry = new Map<string, { el: HTMLElement; item: ViewerItem }>()
let state: ViewerState | null = null
const listeners = new Set<() => void>()

function emit(next: ViewerState | null): void {
  state = next
  for (const l of listeners) l()
}

export function registerViewerImage(id: string, el: HTMLElement, item: ViewerItem): () => void {
  registry.set(id, { el, item })
  return () => {
    if (registry.get(id)?.el === el) registry.delete(id)
  }
}

function scopeOf(el: HTMLElement): Element | null {
  return el.closest('[data-image-scope]') ?? el.closest('.overflow-y-auto')
}

/** Open the picture registered as `id`, with its neighbours. */
export function openViewer(id: string): void {
  const self = registry.get(id)
  if (!self) return
  const scope = scopeOf(self.el)
  const peers = [...registry.entries()]
    .filter(([, r]) => r.el.isConnected && scopeOf(r.el) === scope)
    .sort(([, a], [, b]) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const index = peers.findIndex(([key]) => key === id)
  if (index < 0) {
    emit({ items: [self.item], index: 0 })
    return
  }
  emit({ items: peers.map(([, r]) => r.item), index })
}

/** The viewer is up: Escape belongs to it, not to the panes behind it. */
export function isViewerOpen(): boolean {
  return state != null
}

export function closeViewer(): void {
  if (state) emit(null)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useViewerState(): ViewerState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  )
}

export function viewerItemName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}
