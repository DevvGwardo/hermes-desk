import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isRenderableInlineDataUrl } from '../lib/reply-media'
import {
  acquireVmImage,
  forgetVmImage,
  inlineImageKey,
  knownSize,
  peekVmImage,
  rememberSize,
  type ImageSize,
  type LoadedImage,
  vmFileError,
} from '../lib/chat-images'
import { friendlyFileError } from '../lib/file-errors'
import { openViewer, registerViewerImage, viewerItemName, type ViewerItem } from '../lib/image-viewer'

/**
 * Pictures in the chat (agent screenshots, `MEDIA:` shares, inlined images).
 *
 * Everything here renders phrasing content only (span, img, button), so a
 * picture can sit inside a markdown paragraph.
 */

/** Chat picture: natural size, never upscaled, capped at 18rem tall and
 *  32rem wide. The placeholder uses the same box (see `boxStyle`). */
export const SHOT_CLASS =
  'block h-auto max-h-72 w-auto max-w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)]'
const SHOT_MAX_H = 288
const SHOT_MAX_W = 512

/** The box a SHOT_CLASS picture of `size` occupies: the placeholder takes it
 *  exactly, so a picture seen before re-appears with no layout shift. Unknown
 *  size: 16:9 at up to 32rem, which is what a browser screenshot fills. */
function boxStyle(size: ImageSize | undefined): CSSProperties {
  if (!size) return { aspectRatio: '16 / 9', width: `min(100%, ${SHOT_MAX_W}px)` }
  const w = Math.min(size.width, SHOT_MAX_W, (SHOT_MAX_H * size.width) / size.height)
  return { aspectRatio: `${size.width} / ${size.height}`, width: `min(100%, ${Math.round(w)}px)` }
}

/**
 * Start reading once the picture's row is within a viewport of the visible
 * area: a long chat opening does not fetch every screenshot in it at once.
 * The row is observed (it keeps a layout box under content-visibility; its
 * skipped children may not).
 */
export function useNearViewport(ref: { current: HTMLElement | null }, skip: boolean): boolean {
  const [near, setNear] = useState(() => skip || typeof IntersectionObserver === 'undefined')
  useLayoutEffect(() => {
    if (near) return
    const el = ref.current
    if (!el) {
      setNear(true)
      return
    }
    const scroller = el.closest('.overflow-y-auto')
    const target = el.closest('[data-message-id]') ?? el
    const io = new IntersectionObserver(
      (list) => {
        if (list.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { root: scroller instanceof HTMLElement ? scroller : null, rootMargin: '100% 0px 100% 0px' },
    )
    io.observe(target)
    return () => io.disconnect()
  }, [near, ref])
  return near || skip
}

type VmLoad = { state: 'idle' | 'loading' | 'ready' | 'failed'; image: LoadedImage | null; fresh: boolean }

/** A picture on the agent computer, held while mounted. */
export function useLocalImage(path: string | undefined, enabled: boolean): VmLoad & { retry: () => void; broken: () => void } {
  const [attempt, setAttempt] = useState(0)
  const cached = path ? peekVmImage(path) : null
  const [load, setLoad] = useState<VmLoad>(() =>
    cached ? { state: 'ready', image: cached, fresh: false } : { state: 'idle', image: null, fresh: false },
  )
  useEffect(() => {
    if (!path || !enabled) return
    const peek = peekVmImage(path)
    setLoad(peek ? { state: 'ready', image: peek, fresh: false } : { state: 'loading', image: null, fresh: false })
    let alive = true
    const held = acquireVmImage(path)
    void held.promise.then((image) => {
      if (!alive) return
      setLoad((prev) =>
        image
          ? { state: 'ready', image, fresh: prev.state !== 'ready' }
          : { state: 'failed', image: null, fresh: false },
      )
    })
    return () => {
      alive = false
      held.release()
    }
  }, [path, enabled, attempt])
  const retry = useCallback(() => {
    if (path) forgetVmImage(path)
    setAttempt((n) => n + 1)
  }, [path])
  const broken = useCallback(() => {
    if (path) forgetVmImage(path)
    setLoad({ state: 'failed', image: null, fresh: false })
  }, [path])
  if (!path) return { state: 'failed', image: null, fresh: false, retry, broken }
  return { ...load, retry, broken }
}

/** Register a picture with the full-screen viewer; returns its opener. */
export function useViewerEntry(ref: { current: HTMLElement | null }, item: ViewerItem | null): (() => void) | undefined {
  const id = useId()
  const kind = item?.kind
  const src = item ? (item.kind === 'vm' ? item.path : item.url) : ''
  const name = item?.name ?? ''
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !kind) return
    return registerViewerImage(
      id,
      el,
      kind === 'vm' ? { kind, path: src, name } : { kind: 'url', url: src, name },
    )
  }, [id, ref, kind, src, name])
  return useCallback(() => openViewer(id), [id]) as (() => void) | undefined
}

/** Wraps a picture in the button that opens it full size. */
export function ZoomTrigger({
  name,
  onOpen,
  className = 'block w-fit max-w-full',
  children,
}: {
  name: string
  onOpen: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      aria-label={`View ${name} full size`}
      title={name}
      className={`group/zoom cursor-zoom-in rounded-lg text-left outline-none ${className}`}
    >
      {children}
    </button>
  )
}

const GONE_RE = /not found|enoent|no such file|\b404\b/i

const RING = 'group-focus-visible/zoom:ring-2 group-focus-visible/zoom:ring-[var(--ca-primary)]'

function Placeholder({ label, className, style }: { label: string; className: string; style?: CSSProperties }) {
  return <span className={`skeleton-shine block ${className}`} style={style} role="status" aria-label={label} />
}

/** An image the agent already inlined as a data URL — no filesystem read. */
export function InlineShot({
  dataUrl,
  alt,
  className = SHOT_CLASS,
  zoom = false,
}: {
  dataUrl: string
  alt: string
  className?: string
  /** Click opens the full-screen viewer. */
  zoom?: boolean
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const ok = isRenderableInlineDataUrl(dataUrl)
  const key = inlineImageKey(dataUrl)
  const size = knownSize(key)
  const [decoded, setDecoded] = useState(Boolean(size))
  const [broken, setBroken] = useState(false)
  const open = useViewerEntry(ref, zoom && ok && !broken ? { kind: 'url', url: dataUrl, name: alt } : null)
  // Defense in depth: extractReplyMedia already drops over-cap and non-raster
  // data URLs, but this is the render site, so it enforces the same rule.
  if (!ok) {
    return <span className="mt-2 block text-[11px] text-[var(--ca-ink-muted)]">Image too large to show</span>
  }
  if (broken) {
    return <span className="mt-2 block text-[11px] text-[var(--ca-ink-muted)]">Couldn't show this image</span>
  }
  const custom = className !== SHOT_CLASS
  const img = (
    <img
      src={dataUrl}
      alt={alt}
      decoding="async"
      width={size?.width}
      height={size?.height}
      onLoad={(e) => {
        const el = e.currentTarget
        rememberSize(key, { width: el.naturalWidth, height: el.naturalHeight })
        setDecoded(true)
      }}
      onError={() => setBroken(true)}
      className={`${className} ${RING} ${decoded ? 'nub-img-in' : 'pointer-events-none absolute inset-0 h-full w-full opacity-0'}`}
    />
  )
  return (
    <span ref={ref} className="relative mt-2 block">
      {!decoded && <Placeholder label="Loading image" className={custom ? className : 'rounded-lg'} style={custom ? undefined : boxStyle(size)} />}
      {zoom && decoded && open ? <ZoomTrigger name={alt} onOpen={open}>{img}</ZoomTrigger> : img}
    </span>
  )
}

/** A local PNG/JPEG, read through the Electron filesystem bridge once it is
 *  near the viewport. */
export function LocalImage({
  path,
  alt,
  className = SHOT_CLASS,
  zoom = false,
  inline = false,
}: {
  path: string
  alt: string
  className?: string
  /** Click opens the full-screen viewer. */
  zoom?: boolean
  /** Sits in a line of text (a small markdown image). */
  inline?: boolean
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const warm = Boolean(peekVmImage(path))
  const near = useNearViewport(ref, warm)
  const { state, image, fresh, retry, broken } = useLocalImage(path, near)
  const open = useViewerEntry(ref, zoom && state !== 'failed' ? { kind: 'vm', path, name: viewerItemName(path) } : null)
  const custom = className !== SHOT_CLASS
  const size = image?.width && image.height ? { width: image.width, height: image.height } : knownSize(path)

  let body: ReactNode
  if (state === 'failed') {
    // Plain words, not the path (that's one hover away); a deleted picture
    // won't come back, so it gets no Retry.
    const reason = vmFileError(path)
    const gone = !!reason && GONE_RE.test(reason)
    body = (
      <span className="flex items-center gap-2 text-[11px] text-[var(--ca-ink-muted)]" title={path} role="status">
        <span className="min-w-0">
          {gone ? "This picture isn't there anymore." : `Couldn't load this picture.${reason ? ` ${friendlyFileError(reason)}` : ''}`}
        </span>
        {gone ? null : (
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-full border border-[var(--ca-border)] px-2 py-0.5 text-[var(--ca-ink)] hover:bg-[var(--ca-hover)]"
          >
            Try again
          </button>
        )}
      </span>
    )
  } else if (state === 'ready' && image) {
    const img = (
      <img
        src={image.url}
        alt={alt}
        decoding="async"
        width={size?.width}
        height={size?.height}
        onError={broken}
        className={`${className} ${RING} ${fresh ? 'nub-img-in' : ''}`}
      />
    )
    body = zoom && open ? <ZoomTrigger name={alt} onOpen={open}>{img}</ZoomTrigger> : img
  } else {
    // Holds the picture's box (exact when its size is known) so it arriving
    // shifts nothing.
    body = (
      <Placeholder
        label="Loading picture"
        className={custom ? className : 'rounded-lg border border-[var(--ca-border)]'}
        style={
          inline
            ? { aspectRatio: '16 / 9', width: '10rem' }
            : custom
              ? /\baspect-/.test(className)
                ? undefined
                : { aspectRatio: '16 / 9' }
              : boxStyle(size)
        }
      />
    )
  }
  return (
    <span ref={ref} className={inline ? 'inline-block align-middle' : `block ${custom ? '' : 'mt-2'}`}>
      {body}
    </span>
  )
}
