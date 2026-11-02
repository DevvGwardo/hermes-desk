import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename, isExcluded, type FsEntry } from '../lib/fs'
import { isFilesAvailable, listDir, resolveFilesRoot, filesErrorMessage } from '../lib/files-source'
import { Icon } from './ui/icons'
import { LocalPanelTheme } from './settings/local/common'
import { mediaKindOf } from '../lib/media-kind'
import { friendlyFileError } from '../lib/file-errors'
import {
  DATE_GROUP_ORDER,
  FILE_TABS,
  dateGroupOf,
  fileTabOf,
  formatWhen,
  friendlyName,
  hasThumbnail,
  type FileTab,
} from '../lib/file-library'
import { downloadVmFile } from './FileCard'
import { folderWithin } from '../lib/open-files'
import { SideIcon, SidePanel, sidePanelIconButton } from './SidePanel'
import { useNearViewport, useLocalImage as useVmImage } from './LocalImage'

interface FilesPanelProps {
  open: boolean
  /** The workspace root, or the main-process default when absent or "/". */
  cwd?: string
  onClose: () => void
  onOpenFile: (path: string) => void
  /** Files the agent made or you attached in this chat, newest last. */
  recentFiles?: { path: string; label: string }[]
  /** Kept mounted while a file is previewed, so Back lands where you were. */
  hidden?: boolean
  /** Open at this folder (inside `cwd`); `startKey` re-applies the same one. */
  startDir?: string
  startKey?: number
}

/** A root lookup or listing that never answers would leave "Loading…" up forever. */
const LIST_TIMEOUT_MS = 20_000

const KIND_BY_EXT: Record<string, string> = {
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image', svg: 'Image', heic: 'Image',
  pdf: 'PDF',
  md: 'Document', markdown: 'Document', txt: 'Text', doc: 'Document', docx: 'Document', rtf: 'Document',
  csv: 'Spreadsheet', xls: 'Spreadsheet', xlsx: 'Spreadsheet',
  ppt: 'Slides', pptx: 'Slides', key: 'Slides',
  zip: 'Archive', gz: 'Archive', tar: 'Archive', tgz: 'Archive',
  html: 'Web page', htm: 'Web page',
  json: 'Data', yaml: 'Data', yml: 'Data', toml: 'Data', xml: 'Data',
}

/** "Image", "PDF", "Code": what a person would call the file. */
export function fileKindLabel(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const media = mediaKindOf(path)
  if (media === 'audio') return 'Audio'
  if (media === 'video') return 'Video'
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext]
  return ext ? 'Code' : 'File'
}

/** Newest first when the source reports dates (folders by name); by name
 *  otherwise. */
function sortEntries(entries: FsEntry[]): FsEntry[] {
  const byName = (a: FsEntry, b: FsEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    if (a.isDirectory) return byName(a, b)
    return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || byName(a, b)
  })
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(new Error("Your agent's computer is taking too long to answer.")),
      ms,
    )
    p.then(
      (v) => {
        window.clearTimeout(t)
        resolve(v)
      },
      (err: unknown) => {
        window.clearTimeout(t)
        reject(err)
      },
    )
  })
}

/** Folder path → ["Files", "reports", "2026"] relative to the root. */
export function crumbsFor(root: string, dir: string): { label: string; path: string }[] {
  const base = root.replace(/\/+$/, '')
  const crumbs = [{ label: 'Files', path: root }]
  if (dir === root || !dir.startsWith(base + '/')) return crumbs
  let acc = base
  for (const part of dir.slice(base.length + 1).split('/').filter(Boolean)) {
    acc = `${acc}/${part}`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}

function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i > 0 ? trimmed.slice(0, i) : '/'
}

function FolderGlyph({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)] ${large ? 'h-11 w-11 rounded-2xl' : 'h-9 w-9 rounded-xl'}`}
    >
      <Icon name="folder" size={large ? 22 : 18} />
    </span>
  )
}

/** A photo's own picture, or the file's icon until it loads (and for
 *  anything that is not a photo). */
function FileThumb({ path, className }: { path: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const photo = hasThumbnail(path)
  const near = useNearViewport(ref, !photo)
  const { state, image, broken } = useVmImage(photo ? path : undefined, photo && near)
  return (
    <span ref={ref} aria-hidden className={`relative grid shrink-0 place-items-center overflow-hidden bg-[var(--ca-hover)] ${className}`}>
      {photo && state === 'ready' && image ? (
        <img src={image.url} alt="" aria-hidden draggable={false} onError={broken} className="absolute inset-0 h-full w-full object-cover" />
      ) : photo && state === 'loading' ? (
        <span className="absolute inset-0 animate-pulse bg-[var(--ca-hover)]" />
      ) : (
        <Icon name={photo ? 'image' : 'file'} size={20} />
      )}
    </span>
  )
}

/** Saving can take a few seconds on a slow link, so the button shows it is
 *  working (and stays visible) until the download starts or fails. */
function DownloadButton({ path, name, onError, onBusy, className = '' }: { path: string; name: string; onError: (e: string | null) => void; onBusy: (busy: boolean) => void; className?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      aria-label={busy ? `Saving ${name}` : `Save ${name}`}
      aria-busy={busy}
      title={busy ? 'Saving…' : 'Save to this device'}
      disabled={busy}
      onClick={() => {
        onError(null)
        setBusy(true)
        onBusy(true)
        void downloadVmFile(path).then((err) => {
          setBusy(false)
          onBusy(false)
          onError(err)
        })
      }}
      className={`${sidePanelIconButton} ${busy ? 'opacity-100' : 'opacity-0'} focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${className}`}
    >
      {busy ? (
        <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <SideIcon d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" size={14} />
      )}
    </button>
  )
}

interface FileRowProps {
  path: string
  modifiedAt?: number | null
  onOpen: () => void
}

/** One file: picture or icon, a plain name, and what it is + when. */
function FileRow({ path, modifiedAt, onOpen }: FileRowProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const name = friendlyName(path)
  const when = formatWhen(modifiedAt)
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={basename(path)}
        className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-[var(--ca-hover)] active:scale-[0.99]"
      >
        <FileThumb path={path} className="h-11 w-11 rounded-xl" />
        <span className="min-w-0 flex-1 pr-8">
          <span className="block truncate text-[14px] font-medium text-[var(--ca-ink)]">{name}</span>
          <span className={`block truncate text-[12px] ${downloadError ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-ink-muted)]'}`}>
            {downloadError ?? (saving ? 'Saving to this device…' : when ? `${fileKindLabel(path)} · ${when}` : fileKindLabel(path))}
          </span>
        </span>
      </button>
      <DownloadButton path={path} name={name} onError={setDownloadError} onBusy={setSaving} className="absolute right-1.5 top-1/2 -translate-y-1/2" />
      {/* The row text above shows it; this announces it once. */}
      {downloadError && <span className="sr-only" role="alert">{`Couldn't save ${name}: ${downloadError}`}</span>}
    </li>
  )
}

/** Photos tab: a grid of pictures, like a phone's camera roll. */
function PhotoTile({ path, onOpen }: { path: string; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={basename(path)}
        aria-label={friendlyName(path)}
        className="block aspect-square w-full overflow-hidden rounded-lg transition hover:opacity-90 active:scale-[0.98]"
      >
        <FileThumb path={path} className="h-full w-full" />
      </button>
    </li>
  )
}

function FolderRow({ path, name, onOpen }: { path: string; name: string; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={path}
        className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-[var(--ca-hover)]"
      >
        <FolderGlyph large />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--ca-ink)]">{name}</span>
        <span aria-hidden className="pr-1.5 text-[var(--ca-ink-muted)]">
          <SideIcon d="M6 3.5 10.5 8 6 12.5" size={13} />
        </span>
      </button>
    </li>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <h3 className="px-2 pb-1 pt-4 text-[13px] font-semibold text-[var(--ca-ink)]">{children}</h3>
}

function Tabs({ tab, onChange }: { tab: FileTab; onChange: (t: FileTab) => void }) {
  return (
    <div role="tablist" aria-label="Show" className="flex rounded-full bg-[var(--ca-hover)] p-0.5">
      {FILE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={`nub-touch-44 flex-1 rounded-full px-2 py-1 text-[12px] font-medium transition ${
            tab === t.id
              ? 'bg-[var(--ca-card)] text-[var(--ca-ink)] shadow-sm'
              : 'text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Skeleton() {
  return (
    <ul aria-label="Loading files" className="space-y-1 px-2 py-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="flex items-center gap-3 px-2 py-2">
          <span className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-[var(--ca-hover)]" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-3 w-2/3 animate-pulse rounded bg-[var(--ca-hover)]" />
            <span className="block h-2.5 w-1/3 animate-pulse rounded bg-[var(--ca-hover)]" />
          </span>
        </li>
      ))}
    </ul>
  )
}

const EMPTY_TAB: Record<FileTab, string> = {
  all: 'Anything your agent makes or you send it shows up here.',
  photos: 'Pictures you send your agent, and ones it makes, show up here.',
  docs: 'Reports, notes, PDFs and spreadsheets show up here.',
  sites: 'Web pages your agent builds show up here.',
}

/** Files grouped under Today / Yesterday / … (one unlabeled group when the
 *  source has no dates). */
function groupByDate(files: FsEntry[]): { label: string | null; files: FsEntry[] }[] {
  if (!files.some((f) => f.modifiedAt)) return files.length ? [{ label: null, files }] : []
  const now = Date.now()
  const groups = new Map<string, FsEntry[]>()
  for (const f of files) {
    const g = dateGroupOf(f.modifiedAt, now)
    groups.set(g, [...(groups.get(g) ?? []), f])
  }
  return DATE_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({ label: g, files: groups.get(g)! }))
}

/**
 * Files sidebar, laid out like a phone's Files and Photos apps: newest first,
 * grouped by day, plain names (no extensions), photos as pictures, and a
 * short row of tabs (All, Photos, Docs, Sites). Tap a file to preview it in
 * the same sidebar; folders sit at the bottom. Files from this chat stay on
 * top so the thing you just asked for is one tap away.
 */
export default function FilesPanel({
  open,
  cwd,
  onClose,
  onOpenFile,
  recentFiles = [],
  hidden = false,
  startDir,
  startKey,
}: FilesPanelProps) {
  const available = isFilesAvailable()
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const importEpoch = useRef(0)
  useEffect(() => {
    importEpoch.current++
    setImporting(false)
    setImportError(null)
    return () => { importEpoch.current++ }
  }, [cwd, open])
  async function openLocalMedia() {
    const bridge = window.nubAgent?.localFiles
    if (!bridge || importing) return
    const epoch = importEpoch.current
    setImporting(true)
    setImportError(null)
    try {
      const selected = await bridge.pickMedia()
      if (selected) {
        if (epoch === importEpoch.current) onOpenFile(selected)
        else await bridge.releaseImport(selected)
      }
    } catch {
      if (epoch === importEpoch.current) setImportError('Could not open media. Choose a regular video or audio file up to 2 GB and retry.')
    } finally { if (epoch === importEpoch.current) setImporting(false) }
  }
  const [root, setRoot] = useState('')
  const [dir, setDir] = useState(root)
  const [rootRetry, setRootRetry] = useState(0)
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<FileTab>('all')
  const [reloadTick, setReloadTick] = useState(0)
  const cache = useRef(new Map<string, FsEntry[]>())

  // A new workspace (another conversation) starts over at its root.
  useEffect(() => {
    cache.current.clear()
    let alive = true
    setRoot(''); setDir(''); setEntries(null); setError(null)
    if (!open || !available) return
    void withTimeout(resolveFilesRoot(cwd), LIST_TIMEOUT_MS).then(next => {
      if (alive) { setRoot(next); setDir(startKey == null ? next : folderWithin(next, startDir)) }
    }).catch(cause => { if (alive) setError(filesErrorMessage(cause) || friendlyFileError(cause)) })
    return () => { alive = false }
  }, [cwd, open, available, rootRetry])

  // "See them all in Files" from a folder card: land on that folder, all tabs.
  useEffect(() => {
    if (startKey == null || !root) return
    setDir(folderWithin(root, startDir))
    setTab('all')
    // cwd is read, not watched: a workspace change resets above.
  }, [startKey, startDir, root])

  // A reopen or another folder starts with an empty search; Refresh (a
  // reload of the same folder, below) keeps it.
  useEffect(() => {
    if (open) setQuery('')
  }, [open, dir])

  useEffect(() => {
    if (!open || !available || !dir) return
    let alive = true
    setError(null)
    const cached = cache.current.get(dir)
    setEntries(cached ?? null)
    withTimeout(listDir(dir), LIST_TIMEOUT_MS)
      .then((list) => {
        if (!alive) return
        const sorted = sortEntries(list.filter((e) => !isExcluded(e.name)))
        cache.current.set(dir, sorted)
        setEntries(sorted)
      })
      .catch((err: unknown) => {
        if (alive && !cached) setError(filesErrorMessage(err) || friendlyFileError(err))
      })
    return () => {
      alive = false
    }
  }, [open, available, dir, reloadTick])

  const refresh = useCallback(() => {
    if (!root) { setRootRetry(n => n + 1); return }
    cache.current.delete(dir)
    setReloadTick((n) => n + 1)
  }, [dir, root])

  const atRoot = !dir || dir === root
  const crumbs = useMemo(() => crumbsFor(root, dir), [root, dir])
  const q = query.trim().toLowerCase()
  const recent = useMemo(() => {
    if (!atRoot || q || tab !== 'all') return []
    const seen = new Set<string>()
    const out: { path: string; label: string }[] = []
    for (const f of [...recentFiles].reverse()) {
      if (seen.has(f.path)) continue
      seen.add(f.path)
      out.push(f)
      if (out.length === 5) break
    }
    return out
  }, [recentFiles, atRoot, q, tab])
  const { folders, groups, count } = useMemo(() => {
    const matches = (e: FsEntry) =>
      !q || e.name.toLowerCase().includes(q) || (!e.isDirectory && friendlyName(e.path).toLowerCase().includes(q))
    const list = (entries ?? []).filter(matches)
    // A file already under "From this chat" is not listed twice.
    const pinned = new Set(recent.map((f) => f.path))
    const files = list.filter((e) => !e.isDirectory && !pinned.has(e.path) && (tab === 'all' || fileTabOf(e.path) === tab))
    return {
      // Folders stay on every tab: what a tab is after may be inside one.
      folders: list.filter((e) => e.isDirectory),
      // Photos is one grid, newest first, like a camera roll.
      groups: tab === 'photos' ? (files.length ? [{ label: null, files }] : []) : groupByDate(files),
      count: files.length,
    }
  }, [entries, q, tab, recent])
  const modifiedAtOf = useMemo(() => new Map((entries ?? []).map((e) => [e.path, e.modifiedAt])), [entries])

  if (!open) return null

  const nothing = count === 0 && folders.length === 0
  return (
    <SidePanel
      id="files"
      title={atRoot ? 'Files' : basename(dir)}
      subtitle={atRoot ? 'Everything you and your agent saved' : undefined}
      onBack={atRoot ? undefined : () => setDir(parentOf(dir))}
      backLabel="Up one folder"
      onClose={onClose}
      closeLabel="Close files"
      defaultWidth={380}
      hidden={hidden}
      actions={
        <>
        {window.nubAgent?.localFiles?.chooseRoot && <button type="button"
          aria-label="Choose workspace folder" title="Choose workspace folder" className={sidePanelIconButton}
          onClick={() => {
            void window.nubAgent!.localFiles!.chooseRoot!().then(result => {
              if (result.ok && result.data) {
                cache.current.clear()
                setRoot(result.data); setDir(result.data); setEntries(null); setError(null)
                setReloadTick(n => n + 1)
              }
            }).catch(() => setError('Could not open this workspace folder.'))
          }}>
          <Icon name="folder" size={16} />
        </button>}
        <button type="button" onClick={refresh} disabled={!available} aria-label="Refresh files" title="Refresh" className={sidePanelIconButton}>
          <SideIcon d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" />
        </button>
        </>
      }
      toolbar={
        available ? (
          <div className="space-y-2 border-b border-[var(--ca-border)] px-3 py-2">
            <label className="flex items-center gap-2 rounded-full bg-[var(--ca-hover)] px-3 py-1.5 text-[var(--ca-ink-muted)] focus-within:ring-1 focus-within:ring-[var(--ca-border-strong)]">
              <SideIcon d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5" size={13} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={atRoot ? 'Search' : `Search ${basename(dir)}`}
                aria-label="Search files"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-ink-muted)]"
              />
            </label>
            <Tabs tab={tab} onChange={setTab} />
            {window.nubAgent?.localFiles && <div>
              <button type="button" disabled={importing} onClick={() => void openLocalMedia()}
                className="w-full rounded-full border border-[var(--ca-border)] px-3 py-1.5 text-[12px] text-[var(--ca-ink)] disabled:opacity-50">
                {importing ? 'Opening media…' : 'Open local media'}
              </button>
              {importError && <p role="alert" className="mt-1 text-[12px] text-[var(--ca-danger)]">{importError}</p>}
            </div>}
            {!atRoot && (
              <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 text-[11px] text-[var(--ca-ink-muted)]">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="flex shrink-0 items-center gap-1">
                    {i > 0 && <span aria-hidden>›</span>}
                    {i === crumbs.length - 1 ? (
                      <span className="text-[var(--ca-ink)]">{c.label}</span>
                    ) : (
                      <button type="button" onClick={() => setDir(c.path)} className="hover:text-[var(--ca-ink)] hover:underline">
                        {c.label}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
            )}
          </div>
        ) : undefined
      }
    >
      <LocalPanelTheme />
      {!available ? (
        <div className="m-auto max-w-[240px] px-4 text-center">
          <p className="text-[14px] font-medium text-[var(--ca-ink)]">Files aren't available here</p>
          <p className="mt-1 text-[12px] text-[var(--ca-ink-muted)]">Open Hermes Desk on this Mac to browse local files.</p>
        </div>
      ) : error ? (
        <div className="m-auto max-w-[260px] px-4 text-center">
          <p className="text-[14px] font-medium text-[var(--ca-ink)]">{atRoot ? "Couldn't load your files" : "Couldn't open this folder"}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--ca-ink-muted)]">{error}</p>
          <button type="button" onClick={refresh} className="nub-btn-primary mt-3 px-3 py-1.5 text-[12px]">
            Try again
          </button>
        </div>
      ) : entries === null ? (
        <Skeleton />
      ) : (
        <div className="px-1.5 pb-4">
          {recent.length > 0 && (
            <>
              <SectionLabel>From this chat</SectionLabel>
              <ul>
                {recent.map((f) => (
                  <FileRow key={`recent:${f.path}`} path={f.path} modifiedAt={modifiedAtOf.get(f.path)} onOpen={() => onOpenFile(f.path)} />
                ))}
              </ul>
            </>
          )}
          {nothing ? (
            q ? (
              <p className="px-4 py-10 text-center text-[12px] text-[var(--ca-ink-muted)]">
                Nothing here matches &ldquo;{query.trim()}&rdquo;.
                {(entries ?? []).some((e) => e.isDirectory) ? ' Search only looks in this folder, so try opening a folder.' : ''}
              </p>
            ) : recent.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-[14px] font-medium text-[var(--ca-ink)]">
                  {!atRoot && tab === 'all' ? 'This folder is empty' : tab === 'photos' ? 'No photos yet' : tab === 'all' ? 'No files yet' : `No ${tab === 'docs' ? 'documents' : 'sites'} yet`}
                </p>
                <p className="mt-1 text-[12px] text-[var(--ca-ink-muted)]">{EMPTY_TAB[tab]}</p>
              </div>
            ) : null
          ) : count === 0 && tab !== 'all' && !q ? (
            <p className="px-4 pb-1 pt-4 text-center text-[12px] text-[var(--ca-ink-muted)]" data-files-tab-note>
              No {tab === 'photos' ? 'photos' : tab === 'docs' ? 'documents' : 'sites'} right here. Some may be inside the folders below.
            </p>
          ) : null}
          {groups.map((g, i) => (
            <section key={g.label ?? 'files'}>
              {g.label ? <SectionLabel>{g.label}</SectionLabel> : recent.length > 0 && i === 0 ? <SectionLabel>All files</SectionLabel> : null}
              {tab === 'photos' ? (
                <ul className={`grid grid-cols-3 gap-1 px-1 ${g.label ? '' : 'pt-2'}`}>
                  {g.files.map((e) => (
                    <PhotoTile key={e.path} path={e.path} onOpen={() => onOpenFile(e.path)} />
                  ))}
                </ul>
              ) : (
                <ul className={g.label ? '' : 'pt-1.5'}>
                  {g.files.map((e) => (
                    <FileRow key={e.path} path={e.path} modifiedAt={e.modifiedAt} onOpen={() => onOpenFile(e.path)} />
                  ))}
                </ul>
              )}
            </section>
          ))}
          {folders.length > 0 && (
            <section>
              <SectionLabel>Folders</SectionLabel>
              <ul>
                {folders.map((e) => (
                  <FolderRow key={e.path} path={e.path} name={e.name} onOpen={() => setDir(e.path)} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </SidePanel>
  )
}
