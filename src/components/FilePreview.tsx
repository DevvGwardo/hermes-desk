/**
 * FilePreview — a file preview / diff / edit rail for the desktop chat app.
 *
 * Right-side slide-over panel (grok sand-file-viewer style) that shows the
 * contents of a single workspace file. Supports three body modes:
 *   - VIEW  (default): line-numbered read-only code view
 *   - DIFF  (toggle):  unified git diff with per-line +/- coloring
 *   - EDIT  (toggle):  monospace textarea; Save writes back via the fs bridge
 * Image files (png/jpg/jpeg/gif/webp/svg) skip text modes and render the raw
 * binary as a data-URL image.
 *
 * Design parity: matches FilesPanel.tsx / nub design tokens (--ca-* vars,
 * nub-glass, rounded-full pill buttons, absolute right rail).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  basename,
  GIT_BADGE,
  GIT_BADGE_LABEL,
} from '../lib/fs'
import {
  gitDiff,
  readDataUrl,
  readText,
  statPath,
  writeText,
} from '../lib/files-source'
import { splitMarkdownSegments, type MarkdownSegment } from '../lib/preview/markdown-math'
import { dataUrlToArrayBuffer, type PDFDocumentProxy } from '../lib/preview/pdf'
import type { SheetData } from '../lib/preview/sheet'
import { isLikelyFilePath } from '../lib/file-refs'
import { AppModal } from './AppModal'
import { downloadVmFile } from './FileCard'
import { LocalMedia as VmMedia } from './LocalMedia'
import { isBinaryPath, isTooLargeError, mediaKindOf } from '../lib/media-kind'
import { friendlyFileError } from '../lib/file-errors'
import { MessageBody } from './MessageBody'

/** Maximum number of source lines rendered before showing a truncation note. */
const MAX_LINES = 4000

/** Extensions rendered as an inline image preview instead of text. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
])

/** Text that the fs bridge throws when the desktop shell is absent. */
const BRIDGE_UNAVAILABLE = 'Filesystem bridge unavailable (desktop app required).'

type BodyMode = 'view' | 'diff' | 'edit'

/**
 * A3 preview families. `richdoc` = markdown/mermaid/katex; `pdf` and `sheet`
 * are binary-ish panes that fetch their own bytes; everything else keeps the
 * line-numbered code view.
 */
type PreviewKind = 'image' | 'pdf' | 'sheet' | 'richdoc' | 'media' | 'binary' | 'code'

const RICHDOC_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mmd', 'tex'])
const SHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xls', 'csv'])

export function previewKindOf(path: string): PreviewKind {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (SHEET_EXTENSIONS.has(ext)) return 'sheet'
  if (RICHDOC_EXTENSIONS.has(ext)) return 'richdoc'
  // Audio/video play; other binaries get a download card — never their
  // bytes decoded as text (with an Edit that would write the garble back).
  if (mediaKindOf(path)) return 'media'
  if (isBinaryPath(path)) return 'binary'
  return 'code'
}
/** Lets the app ask before it closes or swaps the preview from outside
 *  (global Escape, browser Back), so unsaved edits are never dropped silently. */
export interface FilePreviewGuard {
  /** True when it is fine to leave: no unsaved edits, or the user said discard. */
  confirmLeave: () => boolean
}

interface FilePreviewProps {
  open: boolean
  filePath: string | null
  onClose: () => void
  guardRef?: MutableRefObject<FilePreviewGuard | null>
}

/**
 * Lowercase extension of a path ('' when there is none). Used to decide
 * between image-preview and text modes.
 */
export function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * The file preview/edit/diff rail. Renders nothing when closed or when no
 * file is selected. Fetches content lazily from the fs bridge on file change.
 */
export default function FilePreview({ open, filePath, onClose, guardRef }: FilePreviewProps) {
  const [loadedContent, setLoadedContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gitKind, setGitKind] = useState<string | null>(null)
  const [mode, setMode] = useState<BodyMode>('view')
  const [draft, setDraft] = useState<string>('')
  const [saving, setSaving] = useState(false)
  // Above the early return below: hooks must run on every render (closing the
  // preview with this below the return crashed the page).
  const [downloadError, setDownloadError] = useState<string | null>(null)
  /** Populated when a save fails; keeps the draft alive in the editor. */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Set once the user has edited the draft; drives the close guard. */
  const [edited, setEdited] = useState(false)
  /** Bumped per load and per file change: a read that lands late (file A
   *  answering after B opened) must not fill B's editor, or Save writes A's
   *  text into B. */
  const loadSeq = useRef(0)
  const openingRef = useRef(0)
  const saveAction = useRef<{ opening: number } | null>(null)
  const downloadSeq = useRef(0)
  const importMounted = useRef(false)
  const importOpening = useRef({ open, filePath })
  importOpening.current = { open, filePath }
  useEffect(() => {
    importMounted.current = true
    return () => {
      importMounted.current = false
      if (open && filePath) window.setTimeout(() => {
        // React StrictMode re-runs effects without actually closing the preview.
        if (importMounted.current && importOpening.current.open && importOpening.current.filePath === filePath) return
        void window.nubAgent?.localFiles?.releaseImport(filePath).catch(() => {})
      }, 0)
    }
  }, [open, filePath])
  const invalidateOpening = useCallback(() => {
    openingRef.current++
    loadSeq.current++
    saveAction.current = null
  }, [])

  useLayoutEffect(() => {
    invalidateOpening()
    setLoadedContent(null)
    setLoading(false)
    setError(null)
    setGitKind(null)
    setMode('view')
    setDraft('')
    setSaving(false)
    setSaveError(null)
    setDownloadError(null)
    setEdited(false)
    return invalidateOpening
  }, [open, filePath, invalidateOpening])

  const isImage = useMemo(
    () => (filePath ? IMAGE_EXTENSIONS.has(extensionOf(filePath)) : false),
    [filePath],
  )
  const previewKind = useMemo(
    () => (filePath ? previewKindOf(filePath) : 'code'),
    [filePath],
  )
  /** Binary panes fetch their own bytes; no text load, no edit/diff. */
  const binary = previewKind === 'pdf' || previewKind === 'sheet' || previewKind === 'media' || previewKind === 'binary'

  const loadContent = useCallback(async () => {
    if (!open || !filePath) return
    const opening = openingRef.current
    const seq = ++loadSeq.current
    const current = () => opening === openingRef.current && seq === loadSeq.current
    setLoading(true)
    setError(null)
    setLoadedContent(null)
    setGitKind(null)
    setSaveError(null)
    setEdited(false)
    try {
      // An extensionless name is not proof of a folder. Ask the filesystem;
      // if metadata is unavailable, the guarded reader remains authoritative.
      if (!isLikelyFilePath(filePath)) {
        let directory = false
        try { directory = (await statPath(filePath)).isDirectory } catch { /* fall through to read */ }
        if (!current()) return
        if (directory) {
          setError('That path is a folder, not a file. Open a file inside it (for example index.html).')
          return
        }
      }
      const text = await readText(filePath)
      if (!current()) return
      setLoadedContent(text)
      setDraft(text)
    } catch (err) {
      if (!current()) return
      // Never leave the previous file's text in the editor for this path.
      setDraft('')
      setMode('view')
      const message = err instanceof Error ? err.message : String(err)
      setError(message.includes(BRIDGE_UNAVAILABLE) ? message : friendlyFileError(err))
    } finally {
      if (current()) setLoading(false)
    }
  }, [open, filePath])

  // Reload content whenever the target file changes.
  useEffect(() => {
    if (!open || !filePath) return
    const opening = openingRef.current
    let cancelled = false
    if (!isImage && !binary) {
      void loadContent()
    }
    void (async () => {
      try {
        const stat = await statPath(filePath)
        if (!cancelled && opening === openingRef.current) setGitKind(stat.gitStatus?.kind ?? null)
      } catch {
        if (!cancelled && opening === openingRef.current) setGitKind(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, filePath, isImage, binary, loadContent])

  const retry = useCallback(() => {
    void loadContent()
  }, [loadContent])

  /**
   * Close only through this. A failed save must never drop the editor or the
   * draft, so the guard lives at the close boundary (button, scrim, Escape)
   * rather than on the save path.
   */
  function confirmLeave(): boolean {
    return !(edited && draft !== (loadedContent ?? '')) || window.confirm('Discard unsaved changes?')
  }
  useLayoutEffect(() => {
    if (!guardRef) return
    const guard = open && filePath ? { confirmLeave } : null
    guardRef.current = guard
    return () => {
      if (guardRef.current === guard) guardRef.current = null
    }
  })

  // Guard: close the rail entirely when not open or no file selected.
  if (!open || !filePath) return null

  const gitBadgeClass = gitKind ? GIT_BADGE[gitKind] : undefined
  const gitBadgeLabel = gitKind ? GIT_BADGE_LABEL[gitKind] ?? gitKind : undefined
  const dirty = mode === 'edit' && draft !== (loadedContent ?? '')

  function requestClose() {
    if (!confirmLeave()) return
    // Dismissal cannot revoke the write already sent, but must prevent its
    // follow-up read and obsolete renderer updates immediately.
    invalidateOpening()
    if (guardRef) guardRef.current = null
    onClose()
  }

  /** Persist the edited draft, then return to view mode and re-read. */
  async function handleSave() {
    if (!filePath || !dirty || saveAction.current) return
    const action = { opening: openingRef.current }
    saveAction.current = action
    const current = () => saveAction.current === action && openingRef.current === action.opening
    const submittedDraft = draft
    setSaving(true)
    setSaveError(null)
    try {
      await writeText(filePath, submittedDraft)
      if (!current()) return
      setMode('view')
      setEdited(false)
      await loadContent()
    } catch (err) {
      // Stay in edit mode with the draft intact — the error renders inline
      // above the textarea instead of replacing it.
      if (current()) setSaveError(`Couldn't save your changes. ${friendlyFileError(err)}`)
    } finally {
      if (current()) {
        saveAction.current = null
        setSaving(false)
      }
    }
  }

  function handleDownload() {
    if (!filePath) return
    const opening = openingRef.current, seq = ++downloadSeq.current
    const current = () => opening === openingRef.current && seq === downloadSeq.current
    setDownloadError(null)
    void downloadVmFile(filePath).then(
      message => { if (current()) setDownloadError(message) },
      error => { if (current()) setDownloadError(friendlyFileError(error)) },
    )
  }

  const pillButton =
    'rounded-full border border-[var(--ca-border)] px-3 py-1 text-xs transition ' +
    'disabled:cursor-not-allowed disabled:opacity-40 ' +
    'hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]'

  return (
    <AppModal
      open
      onClose={requestClose}
      title={basename(filePath)}
      size="lg"
      actions={
        <>
          <button
            type="button"
            onClick={handleDownload}
            className={pillButton}
            title={downloadError ?? `${window.nubAgent?.localFiles ? 'Save a copy of' : 'Download'} ${basename(filePath)}`}
          >
            {downloadError ? (window.nubAgent?.localFiles ? 'Retry save' : 'Retry download') : window.nubAgent?.localFiles ? 'Save a copy' : 'Download'}
          </button>
          {gitKind && gitBadgeClass && gitBadgeLabel && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold leading-tight ${gitBadgeClass}`}
              title={`git ${gitKind}`}
            >
              {gitBadgeLabel}
            </span>
          )}
          {!isImage && !binary && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  if (!saveAction.current) setMode(mode === 'diff' ? 'view' : 'diff')
                }}
                className={`${pillButton} ${
                  mode === 'diff'
                    ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'
                    : 'text-[var(--ca-ink-muted)]'
                }`}
              >
                Diff
              </button>
              {mode !== 'edit' && loadedContent !== null && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { if (!saveAction.current) setMode('edit') }}
                  className={`${pillButton} text-[var(--ca-ink-muted)]`}
                >
                  Edit
                </button>
              )}
            </>
          )}
          {mode === 'edit' && !isImage && !binary && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className={`${pillButton} text-[var(--ca-ink-muted)]`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </>
      }
    >
      <div className="flex min-h-[60vh] flex-col">
        {isImage ? (
          <ImageViewer filePath={filePath} />
        ) : previewKind === 'pdf' ? (
          <PdfPane filePath={filePath} />
        ) : previewKind === 'sheet' ? (
          <SheetPane key={filePath} filePath={filePath} />
        ) : previewKind === 'media' ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <VmMedia key={filePath} path={filePath} autoLoad large />
          </div>
        ) : previewKind === 'binary' ? (
          <Centered>
            <span className="flex flex-col items-center gap-2">
              <span>No preview for this kind of file.</span>
              <button
                type="button"
                className={pillButton}
                onClick={handleDownload}
              >
                {window.nubAgent?.localFiles ? 'Save a copy of' : 'Download'} {basename(filePath)}
              </button>
              {downloadError && <span className="text-[12px] text-[var(--ca-danger)]">{downloadError}</span>}
            </span>
          </Centered>
        ) : loading ? (
          <Centered>Loading…</Centered>
        ) : mode === 'edit' && loadedContent !== null ? (
          // Edit mode outranks `error` once the file loaded: a failed save (or
          // a stat hiccup) must never swap the editor out from under the
          // draft. A file that never loaded has nothing safe to edit.
          <div className="flex min-h-0 flex-1 flex-col">
            {saveError && (
              <div role="alert" className="mx-3 mt-3 rounded-lg border border-[var(--ca-danger)]/30 bg-[var(--ca-danger)]/5 px-3 py-2 text-xs leading-relaxed text-[var(--ca-danger)]">
                {saveError} Your edits are still here — try saving again.
              </div>
            )}
            <textarea
              value={draft}
              readOnly={saving}
              aria-busy={saving || undefined}
              onChange={(e) => {
                if (saveAction.current) return
                setDraft(e.target.value)
                setEdited(true)
              }}
              spellCheck={false}
              aria-label={`Edit ${basename(filePath)}`}
              className="h-full w-full flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-5 text-[var(--ca-ink)] outline-none"
            />
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={retry} />
        ) : mode === 'diff' ? (
          <DiffView filePath={filePath} key={filePath} />
        ) : previewKind === 'richdoc' ? (
          <RichDocView ext={extensionOf(filePath)} content={loadedContent ?? ''} />
        ) : (
          <CodeView content={loadedContent ?? ''} />
        )}
      </div>
    </AppModal>
  )
}

/** Centered muted helper text (loading, empty, desktop-required states). */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-[var(--ca-ink-muted)]">
      {children}
    </div>
  )
}

/** Error card with a retry button. */
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const desktopOnly = message.includes(BRIDGE_UNAVAILABLE)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="nub-card flex max-w-sm flex-col items-center gap-2 px-6 py-5">
        <p className="text-xs leading-relaxed text-[var(--ca-ink-muted)]">
          {desktopOnly ? 'Files need the desktop app.' : message}
        </p>
        {!desktopOnly && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-[var(--ca-border)] px-3 py-1 text-xs text-[var(--ca-ink-muted)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Line-numbered read-only source view. One scroll container holds rows of
 * [line-number | content] so the number column and text scroll together.
 * Rows beyond MAX_LINES are dropped and replaced by a muted truncation note.
 * `wrap` folds long lines (plain text and logs) instead of scrolling sideways.
 */
export function CodeView({ content, wrap = false }: { content: string; wrap?: boolean }) {
  const lines = useMemo(() => content.split('\n'), [content])
  const shown = lines.slice(0, MAX_LINES)
  const truncated = lines.length > MAX_LINES

  return (
    <pre className={`flex-1 text-xs leading-5 ${wrap ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto'}`} data-wrap={wrap || undefined}>
      {shown.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-12 shrink-0 select-none pr-3 text-right text-[var(--ca-ink-muted)]/60">
            {i + 1}
          </span>
          <span className={`${wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre'} pr-4 text-[var(--ca-ink)]`}>{line}</span>
        </div>
      ))}
      {truncated && (
        <div className="flex">
          <span className="w-12 shrink-0 select-none pr-3 text-right text-[var(--ca-ink-muted)]/60" />
          <span className="pr-4 text-[var(--ca-ink-muted)]">
            … file truncated (showing first {MAX_LINES} lines)
          </span>
        </div>
      )}
    </pre>
  )
}

/**
 * Unified git diff view with per-line +/- coloring. Fetches lazily and shows
 * a loading row, then 'No changes' when the diff is empty.
 */
function DiffView({ filePath }: { filePath: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDiff(null)
    setFailed(false)
    void (async () => {
      try {
        const text = await gitDiff(filePath)
        if (!cancelled) setDiff(text)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  if (diff === null && !failed) {
    return <Centered>Loading…</Centered>
  }

  if (failed) {
    return <Centered>Unable to load diff</Centered>
  }

  if (!diff || diff.trim().length === 0) {
    return <Centered>No changes</Centered>
  }

  return (
    <pre className="flex-1 overflow-auto text-xs leading-5">
      {diff.split('\n').map((line, i) => {
        let className = 'text-[var(--ca-ink-muted)]'
        if (line.startsWith('+')) className = 'bg-[var(--ca-success)]/5 text-[var(--ca-success)]'
        else if (line.startsWith('-')) className = 'bg-[var(--ca-danger)]/5 text-[var(--ca-danger)]'
        else if (line.startsWith('@@')) className = 'font-medium text-[var(--ca-primary-text)]'
        return (
          <div key={i} className={`whitespace-pre px-2 ${className}`}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

/**
 * Image preview: loads the file as a data URL and centers it, letterboxed to
 * fit the body.
 */
export function ImageViewer({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)
    void (async () => {
      try {
        const url = await readDataUrl(filePath)
        if (!cancelled) setSrc(url)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  if (failed) return <PreviewUnavailable what="picture" filePath={filePath} />

  if (!src) {
    return <Centered>Loading…</Centered>
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto">
      <img src={src} alt={basename(filePath)} className="mx-auto max-h-full max-w-full object-contain p-4" />
    </div>
  )
}

/**
 * A3: graceful state when a preview can't be drawn (the file didn't load, a
 * lazy renderer chunk failed, a corrupt or oversized file). Never a silent
 * blank pane, and always a way to still get the file.
 */
function PreviewUnavailable({ what, filePath, reason }: { what: string; filePath: string; reason?: string }) {
  const [downloadError, setDownloadError] = useState<string | null>(null)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="nub-card flex max-w-sm flex-col items-center gap-2 px-6 py-5">
        <p className="text-sm font-medium text-[var(--ca-ink)]">Can&apos;t show this {what} here</p>
        <p className="text-xs leading-relaxed text-[var(--ca-ink-muted)]">
          {reason ?? 'Download it to open it on your device.'}
        </p>
        <button
          type="button"
          onClick={() => {
            setDownloadError(null)
            void downloadVmFile(filePath).then(setDownloadError)
          }}
          className="rounded-full border border-[var(--ca-border)] px-3 py-1 text-xs text-[var(--ca-ink-muted)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
        >
          Download
        </button>
        {downloadError && <p className="text-[12px] text-[var(--ca-danger)]">{downloadError}</p>}
      </div>
    </div>
  )
}

/** Shared byte loader for binary preview panes (pdf/xlsx). */
async function readBytes(filePath: string): Promise<ArrayBuffer> {
  return dataUrlToArrayBuffer(await readDataUrl(filePath))
}

/** PDF viewer: page canvas + prev/next, all pdfjs code lazily imported. */
export function PdfPane({ filePath }: { filePath: string }) {
  // The loaded document itself: rendering a page needs it, not just its count.
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [failed, setFailed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** pdf.js refuses two renders on one canvas: each page waits for the last. */
  const renderChain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    let document: PDFDocumentProxy | null = null
    const release = (loaded: PDFDocumentProxy) => { void loaded.loadingTask.destroy().catch(() => {}) }
    setDoc(null)
    setFailed(false)
    setPage(1)
    void (async () => {
      try {
        const { loadPdf } = await import('../lib/preview/pdf')
        if (cancelled) return
        const bytes = await readBytes(filePath)
        if (cancelled) return
        const loaded = await loadPdf(bytes, controller.signal)
        if (cancelled) release(loaded)
        else { document = loaded; setDoc(loaded) }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      if (document) release(document)
    }
  }, [filePath])

  useEffect(() => {
    if (!doc || !canvasRef.current) return
    let cancelled = false
    renderChain.current = renderChain.current.then(async () => {
      // A newer page was asked for while this one waited: skip it.
      if (cancelled || !canvasRef.current) return
      try {
        const { renderPdfPage } = await import('../lib/preview/pdf')
        if (cancelled || !canvasRef.current) return
        await renderPdfPage(doc, page, canvasRef.current)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [doc, page])

  if (failed) return <PreviewUnavailable what="PDF" filePath={filePath} />
  if (!doc) return <Centered>Loading…</Centered>

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-center gap-2 border-b border-[var(--ca-border)] px-3 py-1.5 text-[11px] text-[var(--ca-ink-muted)]">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className="rounded-full border border-[var(--ca-border)] px-2 py-0.5 disabled:opacity-40"
        >
          ‹ Prev
        </button>
        <span>
          Page {page} of {doc.numPages}
        </span>
        <button
          type="button"
          disabled={page >= doc.numPages}
          onClick={() => setPage((p) => Math.min(doc.numPages, p + 1))}
          className="rounded-full border border-[var(--ca-border)] px-2 py-0.5 disabled:opacity-40"
        >
          Next ›
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-neutral-100 p-3 dark:bg-neutral-800">
        <canvas ref={canvasRef} className="mx-auto block max-w-full shadow-md" />
      </div>
    </div>
  )
}

/** Spreadsheet viewer: first sheet by default + sheet tabs, sheetjs lazy. */
export function SheetPane({ filePath }: { filePath: string }) {
  const [data, setData] = useState<SheetData | null>(null)
  const [activeSheet, setActiveSheet] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [tooBig, setTooBig] = useState(false)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setFailed(false)
    setTooBig(false)
    void (async () => {
      try {
        const { loadSheet, MAX_SHEET_BYTES } = await import('../lib/preview/sheet')
        if (cancelled) return
        // Pre-check file size before reading bytes into memory — avoids OOM
        // on a crafted multi-GB xlsx even before loadSheet's own guard.
        try {
          const st = await statPath(filePath)
          if (st.size > MAX_SHEET_BYTES) throw new Error(`Spreadsheet too large (${st.size} bytes)`)
        } catch (e) {
          // Only abort on our size guard; stat failures (missing file, no bridge) fall through
          if (e instanceof Error && e.message.includes('too large')) throw e
        }
        if (cancelled) return
        const payload =
          extensionOf(filePath) === 'csv'
            ? await readText(filePath)
            : await readBytes(filePath)
        if (cancelled) return
        const d = await loadSheet(payload, activeSheet)
        if (!cancelled) setData(d)
      } catch (e) {
        if (cancelled) return
        setTooBig(isTooLargeError(e instanceof Error ? e.message : null))
        setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath, activeSheet])

  if (failed) {
    return (
      <PreviewUnavailable
        what="spreadsheet"
        filePath={filePath}
        reason={tooBig ? 'It is too big to show here. Download it to open it on your device.' : undefined}
      />
    )
  }
  if (!data) return <Centered>Loading…</Centered>

  const shown = data.rows.slice(0, MAX_LINES)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data.sheetNames.length > 1 && (
        <div className="flex gap-1 border-b border-[var(--ca-border)] px-2 py-1.5">
          {data.sheetNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setActiveSheet(name)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                name === data.active
                  ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'
                  : 'text-[var(--ca-ink-muted)] hover:bg-black/5'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className={r === 0 ? 'font-semibold' : undefined}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="whitespace-pre border-b border-[var(--ca-border)] px-2 py-1 text-[var(--ca-ink)]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data.rows.length > shown.length && (
          <p className="px-2 py-1 text-[11px] text-[var(--ca-ink-muted)]">
            … {data.rows.length - shown.length} more rows
          </p>
        )}
      </div>
    </div>
  )
}

/** Segment shapes for rich docs: whole-file mermaid (.mmd) / math (.tex). */
function richSegmentsFor(ext: string, content: string): MarkdownSegment[] {
  if (ext === 'mmd') return [{ kind: 'mermaid', content }]
  if (ext === 'tex') return [{ kind: 'math', content }]
  return splitMarkdownSegments(content)
}

/**
 * Rich document view: plain markdown via MessageBody, fenced mermaid diagrams
 * and $$math$$ blocks rendered through the lazy markdown-math module.
 */
export function RichDocView({ ext, content }: { ext: string; content: string }) {
  const segments = useMemo(() => richSegmentsFor(ext, content), [ext, content])
  return (
    <div className="flex-1 space-y-3 overflow-auto p-4">
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <MessageBody key={i} content={seg.content} variant="markdown" />
        ) : seg.kind === 'mermaid' ? (
          <MermaidBlock key={i} code={seg.content} />
        ) : (
          <MathBlock key={i} tex={seg.content} />
        ),
      )}
    </div>
  )
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    void (async () => {
      try {
        const { renderMermaidSvg } = await import('../lib/preview/markdown-math')
        const out = await renderMermaidSvg(code)
        if (!cancelled) setSvg(out)
      } catch {
        // Bad diagram syntax or chunk-load failure — fall back to the source.
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  if (failed) {
    return (
      <pre className="overflow-x-auto rounded-lg bg-black/5 p-2 text-xs text-[var(--ca-ink-muted)]">
        {code}
      </pre>
    )
  }
  if (!svg) return <Centered>Loading diagram…</Centered>
  // Safe: mermaid securityLevel:'strict' + DOMPurify SVG-profile pass (L4)
  return (
    <div
      data-testid="mermaid-render"
      className="flex justify-center overflow-auto rounded-lg p-2 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function MathBlock({ tex }: { tex: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setFailed(false)
    void (async () => {
      try {
        const { renderMathHtml } = await import('../lib/preview/markdown-math')
        const out = await renderMathHtml(tex)
        if (!cancelled) setHtml(out)
      } catch {
        // Show the formula as written rather than "Loading…" forever.
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tex])

  if (failed) {
    return <pre className="overflow-auto whitespace-pre-wrap px-1 font-mono text-xs text-[var(--ca-ink)]">{tex}</pre>
  }
  if (html == null) return <Centered>Loading…</Centered>
  // Safe: katex throwOnError:false + DOMPurify HTML-profile pass (L4)
  return (
    <div
      data-testid="katex-render"
      className="overflow-auto px-1 text-[var(--ca-ink)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
