import { useEffect, useRef, useState } from 'react'
import type { ProjectArtifact } from '../lib/project-artifacts'
import { isOpenablePage, openableHostedUrl } from '../lib/project-artifacts'
import { LocalImage as VmShot } from './LocalImage'

interface ProjectArtifactCardProps {
  artifact: ProjectArtifact
  onPreview?: (artifact: ProjectArtifact) => void
  /** Omitted when this shell has no way to save the zip (the phone has no
   *  desktop VM download dialog) — the button is then not rendered at all
   *  rather than rendered as a control that does nothing. */
  onDownload?: (artifact: ProjectArtifact) => void | Promise<{ ok: boolean; error?: string } | void>
  /** Omitted when this shell cannot open a hosted URL. */
  onHost?: (artifact: ProjectArtifact) => void
}

const KIND_LABEL: Record<ProjectArtifact['kind'], string> = {
  html: 'Web page',
  react: 'Web app',
  vite: 'Web app',
  static: 'Project',
  screenshot: 'Screenshot',
}

/** Shared box for every thumbnail: 16:9, capped so the preview stays a
 *  glance-sized card rather than a page-sized block in the transcript. */
const THUMB_BOX = 'relative block aspect-video max-h-[190px] w-full overflow-hidden'

/** The page the thumbnail frames live, or null for the static mock.
 *  Desktop reads the VM file (it shows unpublished edits too); the browser
 *  shells can only reach the published Nub Site. */
export function thumbnailFrameSrc(_artifact: ProjectArtifact, _desktop: boolean): string | null {
  // Local pages are read into PreviewModal's opaque-origin sandbox, not
  // automatically loaded from the removed VM scheme or a hosted service.
  return null
}

type ArtifactStatus = { tone: 'live' | 'running' | 'draft'; label: string }

/** One word for where the thing is: live on the web, running on the agent's
 *  computer, or only files so far. */
export function artifactStatus(artifact: ProjectArtifact): ArtifactStatus {
  if (artifact.hostedUrl) return { tone: 'live', label: 'Live' }
  if (artifact.port) return { tone: 'running', label: 'Running' }
  return { tone: 'draft', label: 'Not published' }
}

const STATUS_STYLE: Record<ArtifactStatus['tone'], { dot: string; text: string; bg: string }> = {
  live: { dot: 'var(--ca-success)', text: 'var(--ca-success-text)', bg: 'color-mix(in srgb, var(--ca-success) 12%, transparent)' },
  running: { dot: 'var(--ca-primary)', text: 'var(--ca-primary-text)', bg: 'var(--ca-primary-soft)' },
  draft: { dot: 'var(--ca-ink-muted)', text: 'var(--ca-ink-muted)', bg: 'var(--ca-primary-soft)' },
}

function StatusPill({ status }: { status: ArtifactStatus }) {
  const st = STATUS_STYLE[status.tone]
  return (
    <span
      data-artifact-status={status.tone}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ color: st.text, background: st.bg }}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${status.tone === 'live' ? 'animate-pulse' : ''}`}
        style={{ background: st.dot }}
      />
      {status.label}
    </span>
  )
}

/** Host shown in the address bar: the public domain once it's live,
 *  otherwise where the files are. */
function addressFor(artifact: ProjectArtifact): { text: string; secure: boolean } {
  if (artifact.hostedUrl) {
    try {
      return { text: new URL(artifact.hostedUrl).host, secure: artifact.hostedUrl.startsWith('https:') }
    } catch {
      return { text: artifact.hostedUrl, secure: false }
    }
  }
  return { text: `your agent · ${folderName(artifact)}`, secure: false }
}

function folderName(artifact: ProjectArtifact): string {
  return artifact.rootPath.split('/').filter(Boolean).pop() ?? artifact.rootPath
}

/** Mini browser chrome over the thumbnail, so it reads as a web page. */
function AddressBar({ artifact }: { artifact: ProjectArtifact }) {
  const { text, secure } = addressFor(artifact)
  return (
    <span className="flex items-center gap-2 border-b border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-1.5">
      <span aria-hidden className="flex shrink-0 gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--ca-pink)' }} />
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--ca-brand-tint)' }} />
        <span className="h-2 w-2 rounded-full" style={{ background: 'var(--ca-primary-soft)' }} />
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-full bg-[var(--ca-primary-soft)] px-2.5 py-0.5 text-[10.5px] text-[var(--ca-ink-soft)]">
        {secure && (
          <svg aria-hidden viewBox="0 0 16 16" className="h-2.5 w-2.5 shrink-0" fill="currentColor">
            <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
          </svg>
        )}
        <span className="truncate">{text}</span>
      </span>
      <span aria-hidden className="w-[30px] shrink-0" />
    </span>
  )
}

/** Branded page mock — the sky canvas + white cards of a Nub site — shown
 *  while a live thumbnail loads, or when there is nothing to frame. Carries
 *  the page's own title so two drafts in one chat don't look identical. */
function PageMock({ title }: { title: string }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex flex-col items-center gap-2 px-[8%] pt-[7%]"
      style={{
        background:
          'radial-gradient(120% 80% at 10% -10%, var(--ca-brand-tint) 0%, transparent 55%), radial-gradient(90% 60% at 90% 0%, var(--ca-pink-soft) 0%, transparent 50%), linear-gradient(180deg, var(--ca-canvas) 0%, var(--ca-canvas-deep) 100%)',
      }}
    >
      <span className="h-2 w-14 rounded-full" style={{ background: 'var(--ca-pink-soft)' }} />
      <span className="line-clamp-2 max-w-[80%] text-center text-[clamp(13px,3.2vw,20px)] font-semibold leading-tight text-[var(--ca-ink)]">
        {title}
      </span>
      <span className="h-1.5 w-2/5 rounded" style={{ background: 'var(--ca-ink)', opacity: 0.22 }} />
      <span className="mt-2 flex w-full gap-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="flex h-12 flex-1 flex-col gap-1 rounded-lg border border-[var(--ca-border)] p-2"
            style={{ background: 'var(--ca-card)' }}
          >
            <span className="h-1.5 w-3/5 rounded" style={{ background: 'var(--ca-ink)', opacity: 0.35 }} />
            <span className="h-1 w-4/5 rounded" style={{ background: 'var(--ca-ink)', opacity: 0.15 }} />
          </span>
        ))}
      </span>
    </span>
  )
}

/** Width the framed page lays out at; the frame is scaled down to the card.
 *  Desktop layout in a wide chat column; on a phone-width card the page's own
 *  narrow layout, so the thumbnail stays legible instead of a 25% miniature. */
export function frameLayoutWidth(cardWidth: number): number {
  return cardWidth >= 560 ? 1280 : Math.max(480, Math.round(cardWidth * 1.8))
}

/**
 * The real page, scaled into the card. Inert: no pointer events, no focus,
 * sandboxed without same-origin (scripts run so JS-rendered sites don't
 * thumbnail as blank, but the page can't reach this app or navigate it).
 */
function LiveThumb({ src, title }: { src: string; title: string }) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const frameWidth = frameLayoutWidth(box.w)
  const scale = box.w / frameWidth
  return (
    <span ref={boxRef} className={THUMB_BOX}>
      <PageMock title={title} />
      {scale > 0 && (
        <iframe
          title={`${title} preview`}
          src={src}
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          onLoad={() => setLoaded(true)}
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white transition-opacity duration-300"
          style={{
            width: frameWidth,
            // Tall enough to fill the capped box at any card width.
            height: Math.ceil(box.h / scale) + 1,
            transform: `scale(${scale})`,
            opacity: loaded ? 1 : 0,
          }}
        />
      )}
    </span>
  )
}

function Thumbnail({ artifact }: { artifact: ProjectArtifact }) {
  if (artifact.screenshotPath) {
    return (
      <VmShot
        path={artifact.screenshotPath}
        alt={artifact.title}
        className="aspect-video max-h-[190px] w-full object-cover object-top"
      />
    )
  }
  const frame = thumbnailFrameSrc(artifact, true)
  if (frame) return <LiveThumb src={frame} title={artifact.title} />
  return (
    <span className={THUMB_BOX}>
      <PageMock title={artifact.title} />
    </span>
  )
}

const KIND_ICON: Record<ProjectArtifact['kind'], string> = {
  html: '🌐',
  react: '⚛️',
  vite: '⚡',
  static: '📁',
  screenshot: '🖼️',
}

/** In-chat card for a site the agent built on the VM. */
export function ProjectArtifactCard({
  artifact,
  onPreview,
  onDownload,
  onHost,
}: ProjectArtifactCardProps) {
  const canOpen = isOpenablePage(artifact)
  const clickable = canOpen && onPreview
  const status = artifactStatus(artifact)
  // hostedUrl comes from agent text: only an https platform host may be a link.
  const openHref = openableHostedUrl(artifact.hostedUrl)
  const subline = [KIND_LABEL[artifact.kind], folderName(artifact)].join(' · ')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const download = async () => {
    if (!onDownload || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const res = await onDownload(artifact)
      if (res && !res.ok) setSaveError(res.error || 'Couldn’t save this project.')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Couldn’t save this project.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      data-artifact-card={artifact.id}
      className="sand-on-wall relative mt-2 w-full max-w-[24rem] overflow-clip rounded-2xl border border-[var(--ca-border)] shadow-[var(--ca-shadow-soft)]"
    >
      {canOpen && (
        <>
          <AddressBar artifact={artifact} />
          {clickable ? (
            <button
              type="button"
              aria-label={`Preview ${artifact.title}`}
              onClick={() => onPreview?.(artifact)}
              className="group relative block w-full cursor-zoom-in text-left"
            >
              <Thumbnail artifact={artifact} />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-end justify-end bg-[var(--ca-ink)]/0 p-2.5 opacity-0 transition duration-200 group-hover:bg-[var(--ca-ink)]/10 group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                <span className="rounded-full bg-[var(--ca-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ca-ink)] shadow-[var(--ca-shadow-soft)]">
                  Open preview
                </span>
              </span>
            </button>
          ) : (
            <Thumbnail artifact={artifact} />
          )}
        </>
      )}
      <div
        className={`flex items-center gap-3 px-3.5 py-2.5 ${canOpen ? 'border-t border-[var(--ca-border)]' : ''}`}
        title={artifact.rootPath}
      >
        <div
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ca-primary-soft)] text-[16px]"
        >
          {KIND_ICON[artifact.kind]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-[var(--ca-ink)]">{artifact.title}</div>
          <div className="truncate text-[11.5px] text-[var(--ca-ink-muted)]">{subline}</div>
        </div>
        <StatusPill status={status} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3">
        {clickable && (
          <button
            type="button"
            className="nub-chip px-3 py-1 text-[11.5px] font-semibold"
            style={{ background: 'var(--ca-primary-fill)', color: '#fff', borderColor: 'transparent' }}
            onClick={() => onPreview?.(artifact)}
          >
            Preview
          </button>
        )}
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${artifact.hostedUrl}`}
            title={artifact.hostedUrl}
            className="nub-chip inline-flex items-center gap-1 px-3 py-1 text-[11.5px] font-medium no-underline"
          >
            Open site
            <svg aria-hidden viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 3h7v7M13 3 5 11" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        {onHost ? (
          <button
            type="button"
            className="nub-chip px-3 py-1 text-[11.5px] font-medium"
            title={artifact.hostedUrl ? 'Put the latest version online at the same link' : 'Put this site online with its own link'}
            onClick={() => onHost(artifact)}
          >
            {artifact.hostedUrl ? 'Update site' : 'Publish'}
          </button>
        ) : null}
        {onDownload ? (
          <button
            type="button"
            className="nub-chip px-3 py-1 text-[11.5px] font-medium disabled:opacity-60"
            disabled={saving}
            onClick={() => void download()}
          >
            {saving ? 'Saving…' : 'Download'}
          </button>
        ) : null}
      </div>
      {saveError ? (
        <p role="alert" className="px-3 pb-2 text-[11px] text-[var(--ca-danger)]">
          {saveError}
        </p>
      ) : null}
    </div>
  )
}
