interface Watcher { visible: (on: boolean) => void; hidden: (on: boolean) => void }
interface VisibilityHub {
  watchers: Map<Element, Watcher>
  observer?: IntersectionObserver
  change: () => void
}
const hubs = new WeakMap<Document, VisibilityHub>()

export function watchVisibility(el: Element, watcher: Watcher): () => void {
  const doc = el.ownerDocument
  let hub = hubs.get(doc)
  if (!hub) {
    const watchers = new Map<Element, Watcher>()
    const change = () => { for (const w of watchers.values()) w.hidden(doc.hidden) }
    const Observer = doc.defaultView?.IntersectionObserver
    const observer = Observer ? new Observer(entries => {
      for (const entry of entries) watchers.get(entry.target)?.visible(entry.isIntersecting)
    }) : undefined
    hub = { watchers, observer, change }
    hubs.set(doc, hub)
    doc.addEventListener('visibilitychange', change)
  }
  hub.watchers.set(el, watcher)
  hub.observer?.observe(el)
  watcher.hidden(doc.hidden)
  const activeHub = hub
  return () => {
    activeHub.observer?.unobserve(el)
    activeHub.watchers.delete(el)
    if (!activeHub.watchers.size) {
      activeHub.observer?.disconnect()
      doc.removeEventListener('visibilitychange', activeHub.change)
      hubs.delete(doc)
    }
  }
}

type PointerCallback = (x: number, y: number) => void
const pointers = new WeakMap<Document, { callbacks: Set<PointerCallback>; move: (event: PointerEvent) => void }>()
export function watchPointer(doc: Document, callback: PointerCallback): () => void {
  let hub = pointers.get(doc)
  if (!hub) {
    const callbacks = new Set<PointerCallback>()
    const move = (event: PointerEvent) => { for (const cb of callbacks) cb(event.clientX, event.clientY) }
    hub = { callbacks, move }
    pointers.set(doc, hub)
    doc.addEventListener('pointermove', move, { passive: true })
  }
  hub.callbacks.add(callback)
  const activeHub = hub
  return () => {
    activeHub.callbacks.delete(callback)
    if (!activeHub.callbacks.size) {
      doc.removeEventListener('pointermove', activeHub.move)
      pointers.delete(doc)
    }
  }
}

export interface Box { left: number; top: number; right: number; bottom: number }
/** The window area where `el`'s scroll containers show content: the viewport clipped by each scrolling ancestor. */
export function visibleBounds(el: Element): Box | null {
  const view = el.ownerDocument.defaultView
  if (!view) return null
  const box: Box = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight }
  for (let node = el.parentElement; node && node !== el.ownerDocument.body; node = node.parentElement) {
    const style = view.getComputedStyle(node)
    if (!/(auto|scroll)/.test(style.overflowY + style.overflowX)) continue
    const r = node.getBoundingClientRect()
    box.left = Math.max(box.left, r.left)
    box.top = Math.max(box.top, r.top)
    box.right = Math.min(box.right, r.right)
    box.bottom = Math.min(box.bottom, r.bottom)
  }
  return box.right - box.left >= 4 && box.bottom - box.top >= 4 ? box : null
}
