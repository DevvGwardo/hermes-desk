/**
 * Files in the chat, the way modern chat apps show them:
 *
 * - Composer tray: one tile per attached file while the message is being
 *   written. Images are a small square thumbnail, other files a compact card
 *   (type badge, name, size). Uploading is a quiet ring over the tile, a
 *   failure a red mark (click to retry) with the reason on hover; × removes
 *   the tile.
 * - In the thread: images are shown as pictures beside the message (several
 *   share a grid), files as the same compact card — never a "Sent … to the
 *   agent computer" line. A picture still loading holds its place with a
 *   shimmer and fades in; clicking one opens the full-screen viewer.
 */
import { useRef } from 'react'
import { knownSize, peekVmImage } from '../lib/chat-images'
import { useNearViewport, useViewerEntry, useLocalImage as useVmImage, ZoomTrigger } from './LocalImage'

export interface TrayAttachment {
  id: string
  name: string
  kind: 'file' | 'image'
  status: 'uploading' | 'ready' | 'failed'
  size?: number
  error?: string
  /** Local object URL for an image thumbnail. */
  thumb?: string
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name)
  return m ? m[1]!.toUpperCase() : 'FILE'
}

/** Badge colour by file family — a glance tells PDF from ZIP. */
function badgeClass(ext: string): string {
  if (ext === 'PDF') return 'bg-[#e5484d] text-white'
  if (['ZIP', 'RAR', '7Z', 'TAR', 'GZ'].includes(ext)) return 'bg-[#e6a23c] text-white'
  if (['PSD', 'AI', 'SVG', 'FIG', 'SKETCH', 'EPS'].includes(ext)) return 'bg-[#8e4ec6] text-white'
  if (['DOC', 'DOCX', 'TXT', 'MD', 'RTF', 'PAGES'].includes(ext)) return 'bg-[#2b73c6] text-white'
  if (['XLS', 'XLSX', 'CSV', 'NUMBERS'].includes(ext)) return 'bg-[#1f9d6a] text-white'
  return 'bg-[var(--ca-ink-muted)] text-white'
}

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 animate-spin motion-reduce:animate-none">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      title={`Remove ${name}`}
      onClick={onRemove}
      // Shows on hover/focus; always visible where there is no hover (touch).
      className="desk-attachment-remove absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/75 text-[11px] leading-none text-white opacity-0 shadow-sm ring-1 ring-white/40 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      ×
    </button>
  )
}

function FileCard({
  name,
  sub,
  subTone = 'muted',
  onUser = false,
}: {
  name: string
  sub?: string
  subTone?: 'muted' | 'danger'
  onUser?: boolean
}) {
  const ext = extOf(name)
  return (
    <div
      className={`desk-attachment-card flex h-14 w-[196px] items-center gap-2.5 rounded-xl border px-2.5 ${
        onUser
          ? 'border-white/25 bg-white/15 text-white'
          : 'border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)]'
      }`}
    >
      <span
        aria-hidden
        className={`desk-attachment-kind grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[9px] font-semibold tracking-wide ${badgeClass(ext)}`}
      >
        {ext.slice(0, 4)}
      </span>
      <span className="min-w-0">
        <span title={name} className="desk-attachment-name block truncate text-[12.5px] font-medium leading-tight">{name}</span>
        {sub ? (
          <span
            className={`block truncate text-[11px] leading-tight ${
              subTone === 'danger' ? 'text-[var(--ca-danger)]' : onUser ? 'text-white/80' : 'text-[var(--ca-ink-muted)]'
            }`}
          >
            {sub}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** A picture waiting in the composer: click to check it full size (←/→
 *  walks the other attached pictures). */
function TrayThumb({ name, src }: { name: string; src: string }) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const open = useViewerEntry(ref, { kind: 'url', url: src, name })
  return (
    <button
      ref={ref}
      type="button"
      onClick={open}
      aria-label={`View ${name}`}
      className="block h-full w-full cursor-zoom-in"
    >
      <img src={src} alt="" aria-hidden className="h-full w-full object-cover" />
    </button>
  )
}

/** Composer tray: the files that will go with the next message. */
export function AttachmentTray({
  items,
  onRemove,
  onRetry,
  retryDisabled = false,
}: {
  items: TrayAttachment[]
  onRemove: (id: string) => void
  /** Upload a failed file again. */
  onRetry?: (id: string) => void
  retryDisabled?: boolean
}) {
  if (items.length === 0) return null
  return (
    <ul data-testid="composer-attachments" data-image-scope aria-label="Attached files" className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
      {items.map((a) => {
        const label =
          a.status === 'uploading' ? `${a.name}, uploading` : a.status === 'failed' ? `${a.name}, ${a.error ?? 'failed'}` : a.name
        return (
          <li
            key={a.id}
            data-status={a.status}
            aria-label={label}
            title={a.status === 'failed' ? a.error : a.name}
            className="group relative"
          >
            {a.kind === 'image' && a.thumb ? (
              <div className="relative h-14 w-14 overflow-hidden rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)]">
                <TrayThumb name={a.name} src={a.thumb} />
                {a.status === 'uploading' ? (
                  <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/35 text-white">
                    <Spinner />
                  </span>
                ) : a.status === 'failed' ? (
                  onRetry ? (
                    <button
                      type="button"
                      aria-label={`Retry ${a.name}`}
                      disabled={retryDisabled}
                      title={`${a.error ?? 'Upload failed'} — click to retry`}
                      onClick={() => onRetry(a.id)}
                      className="absolute inset-0 grid place-items-center bg-[var(--ca-danger)]/70 text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RetryIcon />
                    </button>
                  ) : (
                    <span className="absolute inset-0 grid place-items-center bg-[var(--ca-danger)]/70 text-[15px] font-semibold text-white">
                      !
                    </span>
                  )
                ) : null}
              </div>
            ) : (
              <div className="relative">
                <FileCard
                  name={a.name}
                  sub={a.status === 'uploading' ? 'Uploading…' : a.status === 'failed' ? (a.error ?? 'Failed') : formatBytes(a.size)}
                  subTone={a.status === 'failed' ? 'danger' : 'muted'}
                />
                {a.status === 'uploading' ? (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ca-ink-muted)]">
                    <Spinner />
                  </span>
                ) : a.status === 'failed' && onRetry ? (
                  <button
                    type="button"
                    aria-label={`Retry ${a.name}`}
                    disabled={retryDisabled}
                    title="Retry"
                    onClick={() => onRetry(a.id)}
                    className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-[var(--ca-danger)] hover:bg-[var(--ca-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RetryIcon />
                  </button>
                ) : null}
              </div>
            )}
            <RemoveButton name={a.name} onRemove={() => onRemove(a.id)} />
          </li>
        )
      })}
    </ul>
  )
}

/** One picture sent with a message. `tile` is a square cell of a grid;
 *  otherwise the picture shows at its own shape. */
function SentImage({
  name,
  path,
  tile = false,
  more = 0,
}: {
  name: string
  path?: string
  tile?: boolean
  /** Pictures past the grid: the last tile reads "+N" and opens them. */
  more?: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const warm = Boolean(path && peekVmImage(path))
  const near = useNearViewport(ref, warm)
  const { state, image, fresh, retry, broken } = useVmImage(path, near)
  const open = useViewerEntry(ref, path && state !== 'failed' ? { kind: 'vm', path, name } : null)
  const size = image?.width && image.height ? { width: image.width, height: image.height } : path ? knownSize(path) : undefined

  if (state === 'failed') {
    return (
      <div ref={ref} className="relative">
        <FileCard name={name} sub="Couldn't load the picture" />
        {path ? (
          <button
            type="button"
            aria-label={`Retry loading ${name}`}
            title="Retry"
            onClick={retry}
            className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
          >
            <RetryIcon />
          </button>
        ) : null}
      </div>
    )
  }
  const ready = state === 'ready' && image
  // Single picture: the box it will occupy (max 14rem tall, 18rem wide) is
  // reserved up front when its size is known, so nothing shifts.
  const box =
    tile || !size
      ? undefined
      : { width: `min(${Math.round(Math.min(size.width, 288, (224 * size.width) / size.height))}px, 70vw)`, aspectRatio: `${size.width} / ${size.height}` }
  const frame = tile ? 'aspect-square w-full' : box ? '' : ready ? '' : 'h-40 w-56 max-w-[70vw]'
  return (
    <div
      ref={ref}
      className={`relative overflow-hidden rounded-2xl border border-[var(--ca-border)] shadow-[var(--ca-shadow-soft)] ${
        ready ? 'bg-[var(--ca-card)]' : 'skeleton-shine'
      } ${frame}`}
      style={box}
      role={ready ? undefined : 'status'}
      aria-label={ready ? undefined : `Loading ${name}`}
    >
      {ready ? (
        <ZoomTrigger name={name} onOpen={open ?? (() => {})} className={tile || box ? 'block h-full w-full' : 'block'}>
          <img
            src={image.url}
            alt={name}
            title={name}
            decoding="async"
            width={size?.width}
            height={size?.height}
            onError={broken}
            className={`block ${
              tile ? 'h-full w-full object-cover' : box ? 'h-full w-full object-cover' : 'max-h-56 max-w-[min(18rem,70vw)] object-cover'
            } ${fresh ? 'nub-img-in' : ''}`}
          />
          {more > 0 && (
            <span className="absolute inset-0 grid place-items-center bg-black/45 text-[20px] font-semibold text-white">
              +{more}
            </span>
          )}
        </ZoomTrigger>
      ) : null}
    </div>
  )
}

/** Registers a picture past the grid's last tile with the viewer, so ←/→
 *  reaches it, without reading it until it is opened. */
function HiddenImage({ name, path }: { name: string; path: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useViewerEntry(ref, { kind: 'vm', path, name })
  return <span ref={ref} hidden />
}

/** Pictures sent together: one shows at its own shape; two or more share a
 *  grid of square tiles (at most four, the last reading "+N"). */
function SentImages({ items }: { items: SentAttachment[] }) {
  if (items.length === 1) {
    const a = items[0]!
    return <SentImage name={a.name} path={a.path} />
  }
  const shown = items.slice(0, 4)
  const rest = items.slice(4)
  return (
    <div
      data-testid="sent-image-grid"
      className={`grid w-[min(18rem,70vw)] gap-1 ${shown.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
    >
      {shown.map((a, i) => (
        <SentImage key={a.id} name={a.name} path={a.path} tile more={i === shown.length - 1 ? rest.length : 0} />
      ))}
      {rest.map((a) => (a.path ? <HiddenImage key={a.id} name={a.name} path={a.path} /> : null))}
    </div>
  )
}

export interface SentAttachment {
  id: string
  name: string
  kind: 'file' | 'image'
  path?: string
  size?: number
}

/** Files that went with a message, shown beside it in the thread. */
export function MessageAttachments({
  items,
  align,
  onOpenFile,
}: {
  items: SentAttachment[]
  align: 'end' | 'start'
  /** Opens a sent (non-picture) file in the file preview. */
  onOpenFile?: (path: string) => void
}) {
  if (items.length === 0) return null
  const images = items.filter((a) => a.kind === 'image')
  const files = items.filter((a) => a.kind !== 'image')
  return (
    <div
      data-testid="message-attachments"
      className={`flex max-w-full flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}
    >
      {images.length > 0 && <SentImages items={images} />}
      {files.map((a) => (
        a.path && onOpenFile ? (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpenFile(a.path!)}
            aria-label={`Open ${a.name}`}
            title={`Open ${a.name}`}
            className="rounded-xl text-left transition hover:brightness-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ca-primary)]"
          >
            <FileCard name={a.name} sub={formatBytes(a.size) || extOf(a.name)} />
          </button>
        ) : (
          <FileCard key={a.id} name={a.name} sub={formatBytes(a.size) || extOf(a.name)} />
        )
      ))}
    </div>
  )
}
