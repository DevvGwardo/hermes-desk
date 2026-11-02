/**
 * FilePanel — the docked right-hand preview for a file the agent shared.
 * Sits beside the chat (the chat shrinks to fit) and goes full-screen on
 * narrow widths. Every open reads the file again (the agent may have
 * rewritten it), and Refresh re-reads it in place. A text file can be
 * edited right here (Edit → Save / Cancel); leaving with unsaved changes asks
 * first. Both chat cards and the Files list open this panel; the FilePreview
 * modal (diff, git badge) is reached only from a `?preview=` link.
 */
import { useEffect, useRef, useState } from 'react'
import { friendlyFileError } from '../lib/file-errors'
import { fileIconFor } from '../lib/file-icon'
import { basename, fileLocationLabel, VM_ROOT } from '../lib/file-refs'
import { friendlyName } from '../lib/file-library'
import { loadFileText } from '../lib/file-text-cache'
import { canEditFile, writeText } from '../lib/files-source'
import { downloadVmFile } from './FileCard'
import { CodeView, extensionOf, ImageViewer, PdfPane, previewKindOf, RichDocView, SheetPane } from './FilePreview'
import { LocalMedia as VmMedia } from './LocalMedia'
import { SideIcon, SidePanel, sidePanelIconButton } from './SidePanel'

interface FilePanelProps {
  filePath: string | null
  onClose: () => void
  /** Opened from the Files sidebar: a back arrow returns to the list. */
  onBack?: () => void
}

const iconButton = sidePanelIconButton
const Svg = SideIcon

export function FilePanel({ filePath, onClose, onBack }: FilePanelProps) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const kind = filePath ? previewKindOf(filePath) : 'code'
  const isText = kind === 'richdoc' || kind === 'code'
  const isHtml = filePath ? HTML_EXTENSIONS.has(extensionOf(filePath)) : false
  // HTML opens as the page; Code shows the source.
  const [htmlView, setHtmlView] = useState<'page' | 'code'>('page')
  const [retryTick, setRetryTick] = useState(0)
  const [reading, setReading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // Editing: the draft, a save in flight, and "Discard your changes?" when
  // something tries to leave with unsaved work.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  const editing = draft !== null
  const dirty = editing && draft !== text

  // A different file starts clean; Refresh / Try again keep what's shown.
  useEffect(() => {
    setText(null)
    setError(null)
    setCopied(false)
    setActionError(null)
    setHtmlView('page')
    setDraft(null)
    setSaveError(null)
    setLeaving(null)
  }, [filePath])

  useEffect(() => {
    if (!filePath || !isText) return
    let alive = true
    setReading(true)
    loadFileText(filePath)
      .then((t) => {
        if (!alive) return
        setText(t)
        setError(null)
      })
      .catch((err: unknown) => alive && setError(friendlyFileError(err)))
      .finally(() => alive && setReading(false))
    return () => {
      alive = false
    }
  }, [filePath, isText, retryTick])

  /** Run `leave` now, or after "Discard" when there are unsaved changes. */
  const guard = (leave: () => void) => {
    if (dirty) setLeaving(() => leave)
    else leave()
  }
  const guardRef = useRef(guard)
  guardRef.current = guard

  useEffect(() => {
    if (!filePath) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) guardRef.current(onClose)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filePath, onClose])

  if (!filePath) return null
  const name = basename(filePath)
  const { icon } = fileIconFor(filePath)

  const download = () => {
    if (downloading) return
    setActionError(null)
    setDownloading(true)
    void downloadVmFile(filePath)
      .then(setActionError)
      .finally(() => setDownloading(false))
  }
  const copy = () => {
    if (text === null) return
    setActionError(null)
    const write = navigator.clipboard?.writeText(text)
    if (!write) {
      setActionError("Couldn't copy here. Select the text and copy it instead.")
      return
    }
    void write.then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => setActionError("Couldn't copy here. Select the text and copy it instead."),
    )
  }
  const startEdit = () => {
    if (text === null) return
    setSaveError(null)
    setDraft(text)
  }
  const cancelEdit = () => guard(() => setDraft(null))
  const save = async () => {
    if (draft === null || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await writeText(filePath, draft)
      setText(draft)
      setDraft(null)
    } catch (err) {
      setSaveError(friendlyFileError(err))
    } finally {
      setSaving(false)
    }
  }
  const editable = isText && text !== null && !error && canEditFile(filePath)
  // A new tab has no route to the VM file, so it shows the loaded text as a blob.
  const openInTab = () => {
    if (text === null) return
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    window.open(url, '_blank', 'noopener')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <SidePanel
      id="file"
      // The same plain name the Files list shows; the real file name under it.
      title={friendlyName(filePath)}
      subtitle={filePath.startsWith(`${VM_ROOT}/`) ? `${name} · in ${fileLocationLabel(filePath)}` : name}
      icon={icon}
      onBack={onBack ? () => guard(onBack) : undefined}
      backLabel="Back to files"
      onClose={() => guard(onClose)}
      closeLabel="Close preview"
      defaultWidth={520}
      actions={
        editing ? (
          <>
            <button type="button" onClick={cancelEdit} disabled={saving} className="nub-chip px-2.5 py-1 text-[12px] font-medium">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="nub-btn-primary px-3 py-1 text-[12px] disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
        <>
        {editable && (
          <button type="button" aria-label="Edit" title="Edit this file" onClick={startEdit} className={iconButton}>
            <Svg d="M10.5 3.5l2 2L6 12H4v-2l6.5-6.5zM9.5 4.5l2 2" />
          </button>
        )}
        {isHtml && (
          <span role="group" aria-label="HTML view" className="mr-1 inline-flex rounded-md border border-[var(--ca-border)] p-0.5 text-[11px]">
            {(['page', 'code'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={htmlView === v}
                onClick={() => setHtmlView(v)}
                className={`rounded px-2 py-0.5 font-medium transition ${
                  htmlView === v ? 'bg-[var(--ca-hover)] text-[var(--ca-ink)]' : 'text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]'
                }`}
              >
                {v === 'page' ? 'Page' : 'Code'}
              </button>
            ))}
          </span>
        )}
        {isText && (
          <>
            <button
              type="button"
              aria-label="Refresh"
              title={reading ? 'Reading…' : 'Refresh: show the latest version'}
              disabled={reading}
              onClick={() => setRetryTick((n) => n + 1)}
              className={iconButton}
            >
              <Svg d="M13 3.5v3h-3M12.6 6.5A5 5 0 1 0 13 9" />
            </button>
            <button type="button" aria-label="Copy content" title={copied ? 'Copied' : 'Copy content'} disabled={text === null} onClick={copy} className={iconButton}>
              <Svg d={copied ? 'M3.5 8.5l3 3 6-7' : 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7'} />
            </button>
            {/* The Page view is a sandboxed render; a new tab only ever gets plain text. */}
            {!(isHtml && htmlView === 'page') && (
              <button type="button" aria-label="Open in new tab" title="Open as text in a new tab" disabled={text === null} onClick={openInTab} className={iconButton}>
                <Svg d="M9 3h4v4M13 3L7.5 8.5M11 9.5v3h-8v-8h3" />
              </button>
            )}
          </>
        )}
        <button
          type="button"
          aria-label={`Download ${name}`}
          title={downloading ? 'Downloading…' : `Download ${name}`}
          aria-busy={downloading || undefined}
          disabled={downloading}
          onClick={download}
          className={`${iconButton} ${downloading ? 'animate-pulse' : ''}`}
        >
          <Svg d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
        </button>
        </>
        )
      }
    >
      {actionError && <p className="px-3 py-1 text-[12px] text-[var(--ca-danger)]">{actionError}</p>}
      {leaving && (
        <div role="alertdialog" aria-label="Discard your changes?" className="flex flex-wrap items-center gap-2 bg-[var(--ca-primary-soft)] px-3 py-2 text-[12px] text-[var(--ca-ink)]">
          <span className="flex-1">You have unsaved changes. Discard them?</span>
          <button type="button" onClick={() => setLeaving(null)} className="nub-chip px-2.5 py-1 font-medium">
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              const leave = leaving
              setLeaving(null)
              setDraft(null)
              leave()
            }}
            className="rounded-full bg-[var(--ca-danger)] px-2.5 py-1 font-medium text-white"
          >
            Discard
          </button>
        </div>
      )}
      {saveError && (
        <p role="alert" className="px-3 py-1 text-[12px] text-[var(--ca-danger)]">
          Couldn’t save: {saveError}
        </p>
      )}
      <div data-file-panel={filePath} className="flex min-h-0 flex-1 flex-col">
        {kind === 'image' ? (
          <ImageViewer key={filePath} filePath={filePath} />
        ) : kind === 'pdf' ? (
          <PdfPane key={filePath} filePath={filePath} />
        ) : kind === 'sheet' ? (
          <SheetPane key={filePath} filePath={filePath} />
        ) : kind === 'media' ? (
          <div className="flex flex-1 items-center justify-center p-4">
            <VmMedia key={filePath} path={filePath} autoLoad large />
          </div>
        ) : !isText ? (
          <PanelNotice title="Can't show this file here" body="Download it to open it on your device." onDownload={download} />
        ) : error ? (
          <PanelNotice title="Couldn't open this file" body={error} onRetry={() => setRetryTick((n) => n + 1)} onDownload={download} />
        ) : text === null ? (
          <p className="m-auto text-[13px] text-[var(--ca-ink-muted)]">Loading…</p>
        ) : editing ? (
          <textarea
            aria-label={`Edit ${name}`}
            value={draft ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={kind === 'richdoc' || PROSE_EXTENSIONS.has(extensionOf(filePath))}
            autoFocus
            className={`min-h-0 w-full flex-1 resize-none border-0 bg-[var(--ca-card)] px-4 py-3 text-[13px] leading-relaxed text-[var(--ca-ink)] outline-none ${
              kind === 'richdoc' || PROSE_EXTENSIONS.has(extensionOf(filePath)) ? '' : 'font-mono'
            }`}
          />
        ) : isHtml && htmlView === 'page' ? (
          <HtmlPage title={name} html={text} />
        ) : kind === 'richdoc' ? (
          <div className="nub-file-doc flex min-h-0 flex-1 flex-col px-2 py-1">
            <RichDocView ext={extensionOf(filePath)} content={text} />
          </div>
        ) : (
          <CodeView content={text} wrap={PROSE_EXTENSIONS.has(extensionOf(filePath))} />
        )}
      </div>
    </SidePanel>
  )
}

const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
/** Plain writing and logs: wrap long lines instead of scrolling sideways. */
const PROSE_EXTENSIONS = new Set(['txt', 'text', 'log', 'out', 'rst'])

/** A file that can't be shown: say why in plain words and offer the next step
 *  (try again, or save it and open it on this device). */
function PanelNotice({ title, body, onRetry, onDownload }: { title: string; body: string; onRetry?: () => void; onDownload: () => void }) {
  return (
    <div className="m-auto max-w-[280px] px-6 text-center">
      <p className="text-[14px] font-medium text-[var(--ca-ink)]">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--ca-ink-muted)]">{body}</p>
      <div className="mt-3 flex justify-center gap-2">
        {onRetry && (
          <button type="button" onClick={onRetry} className="nub-btn-primary px-3 py-1.5 text-[12px]">
            Try again
          </button>
        )}
        <button type="button" onClick={onDownload} className="nub-chip px-3 py-1.5 text-[12px] font-medium">
          Download
        </button>
      </div>
    </div>
  )
}

/**
 * An HTML file drawn as a page: `srcDoc` in an empty sandbox (no scripts, no
 * same-origin, no forms or popups), so an agent-written page can't reach the
 * app's storage, cookies or DOM. This is a static view of the file, not a live
 * site. Files it links by relative path (a sibling style.css) aren't on this
 * origin, so they don't load; the Code view shows the source.
 */
function HtmlPage({ title, html }: { title: string; html: string }) {
  return (
    <iframe
      title={title}
      srcDoc={html}
      sandbox=""
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  )
}

export default FilePanel
