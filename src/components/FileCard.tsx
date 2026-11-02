import { useEffect, useRef, useState } from 'react'
import { fileIconFor, fileKindLabel } from '../lib/file-icon'
import { basename, fileLocationLabel, isLikelyFilePath, isVmRootPath, relativeVmPath, type FileRef } from '../lib/file-refs'
import { friendlyFileError } from '../lib/file-errors'
import { hostMachinePhrase } from '../lib/host-label'
import { downloadBlob, downloadLink, listDir, readDataUrl } from '../lib/files-source'
import { isBridgeAvailable, type FsEntry } from '../lib/fs'
import { dataUrlToObjectUrl, peekVmImage } from '../lib/chat-images'
import { isTooLargeError, mediaKindOf, VM_READ_MAX_BYTES } from '../lib/media-kind'
import { LOCAL_DOWNLOAD_MAX_BYTES as VM_DOWNLOAD_MAX_BYTES } from '../lib/local-files'
import { useNearViewport, useViewerEntry, useLocalImage as useVmImage, LocalImage as VmShot } from './LocalImage'
import { LocalMedia as VmMedia } from './LocalMedia'
import { formatBytes } from './Attachments'
import { fileSize } from '../lib/file-size'
import { requestOpenFiles } from '../lib/open-files'

interface FileCardProps {
  file: FileRef
  onOpen: (path: string) => void
  onSaveToMac?: (path: string) => void
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
const FOLDER_PREVIEW_MAX = 12

/** A folder the agent pointed at: a trailing slash, or a name with no
 *  extension that isn't a known extensionless file (README, Makefile…). */
export function isFolderPath(path: string): boolean {
  if (path.endsWith('/')) return true
  const name = basename(path.replace(/\/+$/, ''))
  return name !== '' && !isLikelyFilePath(path)
}


function downloadErrorText(err: unknown, maxBytes: number): string {
  const message = err instanceof Error ? err.message : ''
  return isTooLargeError(message)
    ? `Over ${maxBytes / (1024 * 1024)} MB, too big to download here${isBridgeAvailable() ? '' : ' (the desktop app can save it)'}`
    : 'Could not download — try again'
}

function saveObjectUrl(url: string, path: string, owned: boolean) {
  const a = document.createElement('a')
  a.href = url
  a.download = basename(path)
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (owned) window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Save a native copy, or use a bounded browser download when no bridge exists.
 *  Null on success/cancel, otherwise a user-facing error. */
export async function downloadVmFile(path: string): Promise<string | null> {
  if (window.nubAgent?.localFiles) {
    try {
      await window.nubAgent.localFiles.saveAs(path)
      return null
    } catch {
      return 'Could not save this file. Choose a new filename and a regular file up to 2 GB, then retry.'
    }
  }
  // Web: hand a signed same-origin link to the browser, so its own download
  // bar shows up right away with progress. Else raw bytes streamed by the
  // platform (past read-data-url's ~3 MB cap), buffered here, then saved.
  try {
    const link = await downloadLink(path)
    if (link) {
      saveObjectUrl(link, path, false)
      return null
    }
    const blob = await downloadBlob(path)
    if (blob) {
      saveObjectUrl(URL.createObjectURL(blob), path, true)
      return null
    }
  } catch (err) {
    return downloadErrorText(err, VM_DOWNLOAD_MAX_BYTES)
  }
  let dataUrl: string
  try {
    dataUrl = await readDataUrl(path)
  } catch (err) {
    return downloadErrorText(err, VM_READ_MAX_BYTES)
  }
  const { url, owned } = dataUrlToObjectUrl(dataUrl)
  saveObjectUrl(url, path, owned)
  return null
}

function DownloadIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  )
}

function DownloadButton({
  path,
  onSaveToMac,
  onFailed,
}: {
  path: string
  onSaveToMac?: (path: string) => void
  /** Why the last download failed (null once one works), for a visible note. */
  onFailed?: (why: string | null) => void
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const [why, setWhy] = useState('')
  const name = basename(path)
  if (onSaveToMac) {
    return (
      <button type="button" onClick={() => onSaveToMac(path)} className="nub-chip shrink-0 px-2 py-1 text-[11px] font-medium">
        Save to {hostMachinePhrase()}
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-label={state === 'failed' ? `${why}: ${name}` : `${window.nubAgent?.localFiles ? 'Save a copy of' : 'Download'} ${name}`}
      title={state === 'failed' ? why : `${window.nubAgent?.localFiles ? 'Save a copy of' : 'Download'} ${name}`}
      disabled={state === 'busy'}
      aria-busy={state === 'busy' || undefined}
      onClick={() => {
        setState('busy')
        onFailed?.(null)
        void downloadVmFile(path).then((error) => {
          setWhy(error ?? '')
          setState(error ? 'failed' : 'idle')
          onFailed?.(error)
        })
      }}
      className={`nub-touch-44 grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-[var(--ca-hover)] disabled:opacity-50 ${state === 'busy' ? 'animate-pulse' : ''} ${
        state === 'failed' ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]'
      }`}
    >
      <DownloadIcon />
    </button>
  )
}

/** An image the agent wrote: the picture itself; click opens the viewer. */
function ImageCard({ file, onSaveToMac }: FileCardProps) {
  const name = basename(file.path)
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <div data-file-card={file.path} className="inline-flex max-w-full flex-col gap-1">
      <VmShot path={file.path} alt={name} zoom />
      <span className="flex items-center gap-1 pl-1">
        <span className={`min-w-0 flex-1 truncate text-[12px] ${failed ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-ink-muted)]'}`}>
          {failed ?? name}
        </span>
        <DownloadButton path={file.path} onSaveToMac={onSaveToMac} onFailed={setFailed} />
      </span>
    </div>
  )
}

/** Audio or video the agent wrote: plays in place. */
function MediaCard({ file, onOpen, onSaveToMac }: FileCardProps) {
  return (
    <div data-file-card={file.path} className="flex w-fit max-w-full items-center gap-1">
      <div className="min-w-0 [&>*:first-child]:mt-0">
        <VmMedia path={file.path} onDownload={onSaveToMac} />
      </div>
      <DownloadButton path={file.path} onSaveToMac={onSaveToMac} />
      {onOpen && <button type="button" onClick={() => onOpen(file.path)} aria-label={`View ${basename(file.path)}`}
        className="nub-chip px-2 py-1 text-[11px]">View</button>}
    </div>
  )
}

/** A picture inside a folder card: read once it is near the viewport, and
 *  it opens in the viewer (←/→ walks the folder's pictures). */
function FolderThumb({ entry }: { entry: FsEntry }) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const near = useNearViewport(ref, Boolean(peekVmImage(entry.path)))
  const { state, image } = useVmImage(entry.path, near)
  const open = useViewerEntry(ref, { kind: 'vm', path: entry.path, name: entry.name })
  return (
    <button ref={ref} type="button" onClick={open} title={entry.name} className="flex w-20 shrink-0 cursor-zoom-in flex-col gap-1 text-left">
      <span className={`block h-20 w-20 overflow-hidden rounded-lg border border-[var(--ca-border)] ${state === 'ready' ? '' : 'skeleton-shine'}`}>
        {state === 'ready' && image ? (
          <img src={image.url} alt={entry.name} className="nub-img-in h-full w-full object-cover" />
        ) : state === 'failed' ? (
          <span className="grid h-full w-full place-items-center text-[18px]" aria-hidden>
            🖼
          </span>
        ) : null}
      </span>
      <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{entry.name}</span>
    </button>
  )
}

/** A folder the agent pointed at: opens in place to show what is inside. */
function FolderCard({ file, onOpen, onSaveToMac }: FileCardProps) {
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState(file.path.replace(/\/+$/, ''))
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = file.path.replace(/\/+$/, '')

  useEffect(() => {
    if (!open) return
    let alive = true
    setEntries(null)
    setError(null)
    void listDir(dir)
      .then((list) => {
        if (!alive) return
        // Folders first, then files by name; hidden files are noise here.
        const shown = list
          .filter((e) => !e.name.startsWith('.'))
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        setEntries(shown)
      })
      .catch((err: unknown) => {
        if (alive) setError(friendlyFileError(err))
      })
    return () => {
      alive = false
    }
  }, [open, dir])

  const images = (entries ?? []).filter((e) => !e.isDirectory && IMAGE_RE.test(e.name))
  const others = (entries ?? []).filter((e) => e.isDirectory || !IMAGE_RE.test(e.name))
  const label = relativeVmPath(root) || basename(root)

  return (
    <div data-file-card={file.path} data-folder className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] shadow-[var(--ca-shadow-soft)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        title={root}
      >
        <span className="shrink-0 text-[15px]" aria-hidden>
          {open ? '📂' : '📁'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--ca-ink)]">{basename(root)}</span>
          <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">
            {open ? label : 'Folder · show what’s inside'}
          </span>
        </span>
        <span aria-hidden className={`text-[11px] text-[var(--ca-ink-muted)] transition-transform ${open ? 'rotate-90' : ''}`}>
          ›
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--ca-border)] px-2.5 py-2">
          {dir !== root && (
            <button
              type="button"
              onClick={() => setDir(dir.slice(0, dir.lastIndexOf('/')) || root)}
              className="mb-1.5 text-[11px] text-[var(--ca-primary-text)] hover:underline"
            >
              ‹ Back
            </button>
          )}
          {error ? (
            <p className="text-[12px] text-[var(--ca-danger)]">{error}</p>
          ) : entries === null ? (
            <p className="text-[12px] text-[var(--ca-ink-muted)]">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-[12px] text-[var(--ca-ink-muted)]">This folder is empty.</p>
          ) : (
            <div className="space-y-2">
              {images.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {images.slice(0, FOLDER_PREVIEW_MAX).map((e) => (
                    <FolderThumb key={e.path} entry={e} />
                  ))}
                </div>
              )}
              {others.length > 0 && (
                <ul className="space-y-0.5">
                  {others.slice(0, FOLDER_PREVIEW_MAX).map((e) => (
                    <li key={e.path} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => (e.isDirectory ? setDir(e.path) : onOpen(e.path))}
                        title={e.path}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--ca-hover)]"
                      >
                        <span aria-hidden className="shrink-0 text-[13px]">
                          {e.isDirectory ? '📁' : fileIconFor(e.path).icon}
                        </span>
                        <span className="truncate text-[12.5px] text-[var(--ca-ink)]">{e.name}</span>
                      </button>
                      {!e.isDirectory && <DownloadButton path={e.path} onSaveToMac={onSaveToMac} />}
                    </li>
                  ))}
                </ul>
              )}
              {(images.length > FOLDER_PREVIEW_MAX || others.length > FOLDER_PREVIEW_MAX) && (
                <p className="text-[11px] text-[var(--ca-ink-muted)]" data-folder-more>
                  Showing {Math.min(images.length, FOLDER_PREVIEW_MAX) + Math.min(others.length, FOLDER_PREVIEW_MAX)} of{' '}
                  {images.length + others.length} items.{' '}
                  <button
                    type="button"
                    onClick={() => requestOpenFiles(file.path)}
                    className="font-medium text-[var(--ca-primary-text)] hover:underline"
                  >
                    See them all in Files
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** In-chat chip for a file the agent wrote — opens the existing FilePreview rail. */
export function FileCard({ file, onOpen, onSaveToMac }: FileCardProps) {
  if (isFolderPath(file.path)) return <FolderCard file={file} onOpen={onOpen} onSaveToMac={onSaveToMac} />
  if (IMAGE_RE.test(file.path)) return <ImageCard file={file} onOpen={onOpen} onSaveToMac={onSaveToMac} />
  if (mediaKindOf(file.path)) return <MediaCard file={file} onOpen={onOpen} onSaveToMac={onSaveToMac} />
  return <DocumentCard file={file} onOpen={onOpen} onSaveToMac={onSaveToMac} />
}

/** Byte size once the card is near the viewport; null until known. */
function useFileSize(path: string, enabled: boolean): number | null {
  const [size, setSize] = useState<{ path: string; bytes: number | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void fileSize(path).then((bytes) => {
      if (alive) setSize({ path, bytes })
    })
    return () => {
      alive = false
    }
  }, [path, enabled])
  return size?.path === path ? size.bytes : null
}

/** A document the agent wrote: name, then "Markdown · 12 KB · Workspace". */
function DocumentCard({ file, onOpen, onSaveToMac }: FileCardProps) {
  const { icon } = fileIconFor(file.path)
  const name = basename(file.path)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const bytes = useFileSize(file.path, useNearViewport(rootRef, false))
  const [failed, setFailed] = useState<string | null>(null)
  // What it is, how big, where it lives. The full path is one hover away.
  const meta = [fileKindLabel(file.path), bytes != null ? formatBytes(bytes) : null, fileLocationLabel(file.path)]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      ref={rootRef}
      data-file-card={file.path}
      className="group flex items-center gap-2 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 shadow-[var(--ca-shadow-soft)] transition hover:border-[var(--ca-primary)]/40 hover:bg-[var(--ca-hover)]"
    >
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        title={`View ${name}`}
      >
        <span className="shrink-0 text-[15px]" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-[var(--ca-ink)]">{name}</span>
          <span
            className={`block truncate text-[11px] ${failed ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-ink-muted)]'}`}
            title={failed ?? relativeVmPath(file.path)}
            role={failed ? 'alert' : undefined}
          >
            {failed ?? meta}
          </span>
        </span>
      </button>
      {/* The row itself opens the preview panel; this pill makes that visible. */}
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        aria-label={`View ${name}`}
        className="nub-touch-hit nub-chip inline-flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-medium"
      >
        <PreviewIcon />
        View
      </button>
      <DownloadButton path={file.path} onSaveToMac={onSaveToMac} onFailed={setFailed} />
    </div>
  )
}

function PreviewIcon() {
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  )
}

export function FileCardStack({
  files,
  onOpen,
  onSaveToMac,
}: {
  files: FileRef[]
  onOpen: (path: string) => void
  onSaveToMac?: (path: string) => void
}) {
  const shown = files.filter((f) => !isVmRootPath(f.path))
  if (shown.length === 0) return null
  return (
    <div data-file-cards className="space-y-1.5">
      {shown.map((file) => (
        <FileCard key={file.path} file={file} onOpen={onOpen} onSaveToMac={onSaveToMac} />
      ))}
    </div>
  )
}
