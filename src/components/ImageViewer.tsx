/**
 * Full-screen picture viewer for the chat. Opened by clicking any picture
 * (see VmShot `zoom`, sent attachments, markdown pictures); walks the other
 * pictures in the same conversation with ←/→ (or a swipe), Esc or a click
 * on the backdrop closes. Click the picture to see it at full size when it
 * is larger than the screen. Save and Copy work on pictures from the agent
 * computer or inlined by the agent; a web picture offers Open instead.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { acquireVmImage, peekVmImage, forgetVmImage, type LoadedImage } from '../lib/chat-images'
import { closeViewer, useViewerState, type ViewerItem } from '../lib/image-viewer'
import { safeLinkUrl } from '../lib/safe-image-url'

type Shown = { state: 'loading' | 'ready' | 'failed'; image: LoadedImage | null }

function useViewerImage(item: ViewerItem, attempt: number): Shown {
  const path = item.kind === 'vm' ? item.path : null
  const url = item.kind === 'url' ? item.url : null
  const [shown, setShown] = useState<Shown>({ state: 'loading', image: null })
  useEffect(() => {
    if (url) {
      setShown({ state: 'ready', image: { url } })
      return
    }
    if (!path) return
    const peek = peekVmImage(path)
    setShown(peek ? { state: 'ready', image: peek } : { state: 'loading', image: null })
    let alive = true
    const held = acquireVmImage(path)
    void held.promise.then((image) => {
      if (alive) setShown(image ? { state: 'ready', image } : { state: 'failed', image: null })
    })
    return () => {
      alive = false
      held.release()
    }
  }, [path, url, attempt])
  return shown
}

/** Keep the pictures either side read, so ←/→ shows them at once. */
function usePrefetch(items: ViewerItem[], index: number): void {
  useEffect(() => {
    const near = [items[index + 1], items[index - 1]].filter((it): it is Extract<ViewerItem, { kind: 'vm' }> => it?.kind === 'vm')
    const held = near.map((it) => acquireVmImage(it.path))
    return () => held.forEach((h) => h.release())
  }, [items, index])
}

function saveName(item: ViewerItem, image: LoadedImage | null): string {
  if (item.kind === 'vm') return item.name
  const mime = /^data:image\/(png|jpeg|gif|webp)/.exec(image?.url ?? '')?.[1]
  const ext = mime === 'jpeg' ? 'jpg' : (mime ?? 'png')
  const base = item.name.replace(/[^\w .-]+/g, '').trim() || 'image'
  return /\.\w{2,4}$/.test(base) ? base : `${base}.${ext}`
}

/** The picture as PNG on the clipboard. Drawn through a canvas: the
 *  clipboard takes image/png only, whatever the source format. */
async function copyImage(url: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('unsupported')
  const png = (async () => {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'),
    )
  })()
  // The promise goes in unresolved so the click's user activation still
  // covers the write (Safari).
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

function Icon({ d, className = 'h-4 w-4' }: { d: string; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const BAR_BTN =
  'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 disabled:opacity-40'

function Viewer({ items, start }: { items: ViewerItem[]; start: number }) {
  const reduce = useReducedMotion()
  const [index, setIndex] = useState(start)
  const [attempt, setAttempt] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const item = items[Math.min(index, items.length - 1)]!
  const { state, image } = useViewerImage(item, attempt)
  usePrefetch(items, index)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const zoomAt = useRef<{ fx: number; fy: number } | null>(null)
  const [canZoom, setCanZoom] = useState(false)
  const count = items.length
  const phone = false
  const webUrl = item.kind === 'url' && /^https:/i.test(item.url) ? safeLinkUrl(item.url) : null

  const go = useCallback(
    (step: number) => {
      if (count < 2) return
      setIndex((i) => (i + step + count) % count)
      setZoomed(false)
      setNote(null)
    },
    [count],
  )

  // Focus moves in on open and back to the picture that opened it on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (zoomed) setZoomed(false)
        else closeViewer()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        go(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go(-1)
      } else if (e.key === 'Tab' && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')
        if (f.length === 0) return
        const first = f[0]!
        const last = f[f.length - 1]!
        if (e.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    // Capture: the chat's own Escape handlers (close a thread, clear a
    // reply) must not also fire under the viewer.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, zoomed])

  // Whether the picture is bigger than the stage (only then can it zoom).
  const measure = useCallback(() => {
    const img = imgRef.current
    const stage = stageRef.current
    if (!img || !stage || !img.naturalWidth) return
    setCanZoom(img.naturalWidth > stage.clientWidth - 32 || img.naturalHeight > stage.clientHeight - 32)
  }, [])
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // Zooming in keeps the clicked point under the pointer's side of the view.
  useLayoutEffect(() => {
    const stage = stageRef.current
    const at = zoomAt.current
    if (!zoomed || !stage || !at) return
    stage.scrollLeft = at.fx * stage.scrollWidth - stage.clientWidth / 2
    stage.scrollTop = at.fy * stage.scrollHeight - stage.clientHeight / 2
    zoomAt.current = null
  }, [zoomed])

  const onImageClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    e.stopPropagation()
    if (swiped.current) return
    if (zoomed) {
      setZoomed(false)
      return
    }
    if (!canZoom) return
    const r = e.currentTarget.getBoundingClientRect()
    zoomAt.current = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }
    setZoomed(true)
  }

  // Swipe between pictures on touch screens (not while zoomed: that pans).
  const swipe = useRef<{ x: number; y: number } | null>(null)
  // The click that ends a swipe must not also close the viewer.
  const swiped = useRef(false)
  const onPointerDown = (e: ReactPointerEvent) => {
    swiped.current = false
    if (e.pointerType !== 'mouse' && !zoomed) swipe.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    const dx = e.clientX - s.x
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) {
      swiped.current = true
      go(dx < 0 ? 1 : -1)
    }
  }

  const flash = (text: string) => {
    setNote(text)
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 1800)
  }

  const onCopy = async () => {
    if (!image) return
    try {
      await copyImage(image.url)
      flash('Copied')
    } catch {
      flash("Couldn't copy")
    }
  }

  const onSave = () => {
    if (!image) return
    const a = document.createElement('a')
    a.href = image.url
    a.download = saveName(item, image)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const label = item.name || 'Image'
  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={count > 1 ? `${label}, ${index + 1} of ${count}` : label}
      tabIndex={-1}
      data-testid="image-viewer"
      className="fixed inset-0 z-[90] flex flex-col bg-black/90 text-white outline-none [padding-top:env(safe-area-inset-top)] [padding-bottom:env(safe-area-inset-bottom)]"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: reduce ? 0 : 0.16 } }}
      exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[13px] font-medium" title={item.kind === 'vm' ? item.path : undefined}>
            {label}
          </p>
          {count > 1 && <p className="text-[11px] text-white/60">{`${index + 1} of ${count}`}</p>}
        </div>
        <span aria-live="polite" className="text-[12px] text-white/70">
          {note}
        </span>
        {webUrl ? (
          <a href={webUrl} target="_blank" rel="noopener noreferrer" className={BAR_BTN}>
            <Icon d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            <span className="max-sm:sr-only">Open</span>
          </a>
        ) : (
          !phone && (
            <>
              <button type="button" className={BAR_BTN} disabled={!image} onClick={() => void onCopy()}>
                <Icon d="M9 9h10v10H9zM5 15V5h10" />
                <span className="max-sm:sr-only">Copy</span>
              </button>
              <button type="button" className={BAR_BTN} disabled={!image} onClick={onSave}>
                <Icon d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" />
                <span className="max-sm:sr-only">Save</span>
              </button>
            </>
          )
        )}
        <button type="button" aria-label="Close" className={`${BAR_BTN} w-9 justify-center px-0`} onClick={closeViewer}>
          <Icon d="M6 6l12 12M18 6 6 18" />
        </button>
      </div>

      <div
        ref={stageRef}
        data-testid="image-viewer-stage"
        className={`relative min-h-0 flex-1 ${zoomed ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden p-4'}`}
        onClick={(e) => {
          if (e.target === e.currentTarget && !swiped.current) closeViewer()
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
      >
        {state === 'loading' && (
          <span role="status" aria-label="Loading image" className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
        )}
        {state === 'failed' && (
          <div className="flex flex-col items-center gap-3 text-center text-[13px] text-white/75">
            <p>Couldn't load this picture.</p>
            <button
              type="button"
              className="rounded-full border border-white/30 px-3 py-1 text-white hover:bg-white/10"
              onClick={() => {
                if (item.kind === 'vm') forgetVmImage(item.path)
                setAttempt((n) => n + 1)
              }}
            >
              Retry
            </button>
          </div>
        )}
        {state === 'ready' && image && (
          <img
            key={image.url}
            ref={imgRef}
            src={image.url}
            alt={label}
            draggable={false}
            onLoad={measure}
            onClick={onImageClick}
            referrerPolicy="no-referrer"
            className={
              zoomed
                ? 'm-auto block max-w-none cursor-zoom-out select-none'
                : `max-h-full max-w-full select-none object-contain shadow-[0_12px_48px_rgba(0,0,0,0.5)] ${canZoom ? 'cursor-zoom-in' : ''}`
            }
          />
        )}
        {count > 1 && !zoomed && (
          <>
            <button
              type="button"
              aria-label="Previous picture"
              onClick={(e) => {
                e.stopPropagation()
                go(-1)
              }}
              className="absolute left-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/85 transition hover:bg-black/70 hover:text-white max-sm:hidden"
            >
              <Icon d="M15 5l-7 7 7 7" className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Next picture"
              onClick={(e) => {
                e.stopPropagation()
                go(1)
              }}
              className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white/85 transition hover:bg-black/70 hover:text-white max-sm:hidden"
            >
              <Icon d="M9 5l7 7-7 7" className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
    </motion.div>
  )
}

/** Mounted once at the app root; renders the viewer while one is open. */
export function ImageViewerHost() {
  const view = useViewerState()
  // Scroll behind the viewer stays put.
  useEffect(() => {
    if (!view) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [view])
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>{view && <Viewer key="image-viewer" items={view.items} start={view.index} />}</AnimatePresence>,
    document.body,
  )
}
