import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  cachedLinkPreview,
  canEmbedInline,
  embedUrl,
  linkTarget,
  loadLinkPreview,
  prioritizeLinkPreview,
  previewUrlsIn,
  youtubeIdFromUrl,
  type PreviewPriority,
  type LinkPreview,
  type LinkStatKind,
} from '../lib/link-preview'
import { safeLinkUrl } from '../lib/safe-image-url'

// ── Formatting ───────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function formatDuration(total: number): string {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

let compactFmt: Intl.NumberFormat | null = null
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  compactFmt ??= new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
  return compactFmt.format(n)
}

export function formatAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const min = Math.max(0, (now - t) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${Math.floor(min)}m ago`
  const h = min / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24
  if (d < 30) return `${Math.floor(d)}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365.25)}y ago`
}

const STAT_LABEL: Record<LinkStatKind, string> = {
  views: 'views',
  likes: 'likes',
  reposts: 'reposts',
  replies: 'replies',
  stars: 'stars',
  forks: 'forks',
}

function statOf(p: LinkPreview, kind: LinkStatKind): number | null {
  return p.stats?.find((s) => s.kind === kind)?.value ?? null
}

// ── Small parts ──────────────────────────────────────────────────────────

const SHELL =
  'nub-link-card group mt-2.5 block w-full max-w-[24rem] overflow-hidden rounded-xl border border-[var(--ca-border)] bg-[var(--ca-hover)] text-left text-[var(--ca-ink)] no-underline transition hover:border-[var(--ca-primary)]/45'

function Icon({ d, size = 13, fill = false }: { d: string; size?: number; fill?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  play: 'M8 5.5v13l11-6.5z',
  warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  fork: 'M7 4a2 2 0 1 0 0 .01M17 4a2 2 0 1 0 0 .01M12 20a2 2 0 1 0 0 .01M7 6v2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V6M12 11v7',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  repost: 'M4 9V8a3 3 0 0 1 3-3h11l-3-3M20 15v1a3 3 0 0 1-3 3H6l3 3',
  reply: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
}

/** Remote picture that quietly disappears if it can't load. */
function Img({ src, className, round }: { src: string | null | undefined; className: string; round?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${className} ${round ? 'rounded-full' : ''}`}
    />
  )
}

function SiteRow({ p, url, right }: { p: LinkPreview; url: string; right?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">
      <Img src={p.favicon} className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain" />
      <span className="truncate">{p.siteName || hostOf(url)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
        {right ?? <Icon d={ICONS.external} size={12} />}
      </span>
    </span>
  )
}

function PlayButton({ big }: { big?: boolean }) {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
      <span
        className={`flex items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-sm transition group-hover:scale-105 group-hover:bg-black/80 ${
          big ? 'h-12 w-12' : 'h-8 w-8'
        }`}
      >
        <Icon d={ICONS.play} size={big ? 20 : 14} fill />
      </span>
    </span>
  )
}

function Dot() {
  return <span aria-hidden className="opacity-50"> · </span>
}

// ── Cards ────────────────────────────────────────────────────────────────

function UnavailableCard({ p, href }: { p: LinkPreview; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-unavailable="true"
      className={`${SHELL} flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--ca-ink-muted)]`}
    >
      <Icon d={ICONS.warn} size={14} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-[var(--ca-ink)]">{p.siteName || hostOf(p.url)}</span>
        {' · '}
        {p.kind === 'video' ? "This video doesn't exist or was removed" : 'Page not found'}
      </span>
    </a>
  )
}

function VideoCard({ p, href }: { p: LinkPreview; href: string }) {
  const [playing, setPlaying] = useState(false)
  const src = embedUrl(p)
  const inline = Boolean(src) && canEmbedInline()
  const views = statOf(p, 'views')
  const title = p.title || hostOf(p.url)

  const thumb = (
    <span className="relative block aspect-video w-full overflow-hidden bg-black">
      <Img src={p.image} className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]" />
      <PlayButton big />
      {p.durationSeconds ? (
        <span className="absolute bottom-1.5 right-1.5 rounded-[4px] bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          {formatDuration(p.durationSeconds)}
        </span>
      ) : null}
    </span>
  )

  return (
    <div data-testid="link-preview" data-provider={p.provider ?? undefined} className={SHELL}>
      {playing && src ? (
        <span className="relative block aspect-video w-full bg-black">
          <iframe
            src={src}
            title={title}
            className="absolute inset-0 h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            // The app sends no referrer by default; YouTube's player refuses
            // to start without one (error 153).
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </span>
      ) : inline ? (
        <button type="button" className="group block w-full" aria-label={`Play ${title}`} onClick={() => setPlaying(true)}>
          {thumb}
        </button>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="group block" aria-label={`Watch ${title}`}>
          {thumb}
        </a>
      )}
      <a href={href} target="_blank" rel="noopener noreferrer" className="group block px-3 pb-2.5 pt-2 no-underline">
        <span className="line-clamp-2 text-[14px] font-semibold leading-snug text-[var(--ca-ink)]">{title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--ca-ink-muted)]">
          {p.author?.avatar ? (
            <Img src={p.author.avatar} className="h-4 w-4 shrink-0 object-cover" round />
          ) : (
            <Img src={p.favicon} className="h-3.5 w-3.5 shrink-0 object-contain" />
          )}
          <span className="min-w-0 truncate">
            {p.author?.name || p.siteName || hostOf(p.url)}
            {views !== null && (
              <>
                <Dot />
                {formatCount(views)} views
              </>
            )}
            {p.publishedAt && (
              <>
                <Dot />
                {formatAgo(p.publishedAt)}
              </>
            )}
          </span>
        </span>
      </a>
    </div>
  )
}

function SpotifyCard({ p, href }: { p: LinkPreview; href: string }) {
  const [playing, setPlaying] = useState(false)
  const src = embedUrl(p)
  const inline = Boolean(src) && canEmbedInline()
  if (playing && src) {
    return (
      <div data-testid="link-preview" data-provider="spotify" className={`${SHELL} bg-transparent`}>
        <iframe
          src={src}
          title={p.title || 'Spotify'}
          height={152}
          className="block w-full"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        />
      </div>
    )
  }
  const cover = (
    <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-[var(--ca-card)]">
      <Img src={p.image} className="h-full w-full object-cover" />
      <PlayButton />
    </span>
  )
  const text = (
    <span className="min-w-0 flex-1">
      <SiteRow p={p} url={p.url} />
      <span className="mt-0.5 block truncate text-[14px] font-semibold leading-snug">{p.title || hostOf(p.url)}</span>
      {p.description && <span className="block truncate text-[12px] text-[var(--ca-ink-muted)]">{p.description}</span>}
    </span>
  )
  return inline ? (
    <button
      type="button"
      data-testid="link-preview"
      data-provider="spotify"
      onClick={() => setPlaying(true)}
      className={`${SHELL} flex items-center gap-3 p-2.5`}
    >
      {cover}
      {text}
    </button>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-provider="spotify"
      className={`${SHELL} flex items-center gap-3 p-2.5`}
    >
      {cover}
      {text}
    </a>
  )
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="currentColor" className="shrink-0">
      <path d="M17.8 3h3.1l-6.8 7.7 8 10.3h-6.2l-4.9-6.3L5.4 21H2.3l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" />
    </svg>
  )
}

function StatPill({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${value.toLocaleString()} ${label}`}>
      <Icon d={icon} size={12} />
      <span className="tabular-nums">{formatCount(value)}</span>
    </span>
  )
}

function XPostCard({ p, href }: { p: LinkPreview; href: string }) {
  const stats: Array<[string, LinkStatKind]> = [
    [ICONS.reply, 'replies'],
    [ICONS.repost, 'reposts'],
    [ICONS.heart, 'likes'],
    [ICONS.eye, 'views'],
  ]
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-provider="x"
      className={`${SHELL} px-3.5 py-3`}
    >
      <span className="flex items-center gap-2.5">
        <Img src={p.author?.avatar} className="h-9 w-9 shrink-0 object-cover" round />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[14px] font-semibold">{p.author?.name || p.title || 'Post on X'}</span>
          {p.author?.handle && <span className="block truncate text-[12px] text-[var(--ca-ink-muted)]">{p.author.handle}</span>}
        </span>
        <span className="text-[var(--ca-ink-muted)]">
          <XLogo />
        </span>
      </span>
      {p.description && (
        <span className="mt-2 line-clamp-6 whitespace-pre-wrap break-words text-[14px] leading-snug">{p.description}</span>
      )}
      {p.image && (
        <span className="relative mt-2.5 block max-h-64 overflow-hidden rounded-lg border border-[var(--ca-border)] bg-black">
          <Img src={p.image} className="block max-h-64 w-full object-cover" />
          {p.kind === 'video' && <PlayButton />}
        </span>
      )}
      <span className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-[var(--ca-ink-muted)]">
        {stats.map(([icon, kind]) => {
          const v = statOf(p, kind)
          return v === null ? null : <StatPill key={kind} icon={icon} value={v} label={STAT_LABEL[kind]} />
        })}
        {p.publishedAt && <span className="ml-auto">{formatAgo(p.publishedAt)}</span>}
      </span>
    </a>
  )
}

/** GitHub's own language colors for the common ones; anything else is grey. */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  PHP: '#4F5D95',
  Dart: '#00B4AB',
  Zig: '#ec915c',
}

function RepoCard({ p, href }: { p: LinkPreview; href: string }) {
  const [owner, repo] = (p.title || '').split('/')
  const stars = statOf(p, 'stars')
  const forks = statOf(p, 'forks')
  const lang = p.tags?.[0]
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-provider="github"
      className={`${SHELL} px-3.5 py-3`}
    >
      <SiteRow p={p} url={p.url} />
      <span className="mt-1.5 flex min-w-0 items-center gap-2">
        <Img src={p.author?.avatar} className="h-5 w-5 shrink-0 rounded-md object-cover" />
        <span className="min-w-0 truncate text-[14px]">
          {repo ? (
            <>
              <span className="text-[var(--ca-ink-muted)]">{owner}/</span>
              <span className="font-semibold">{repo}</span>
            </>
          ) : (
            <span className="font-semibold">{p.title || hostOf(p.url)}</span>
          )}
        </span>
      </span>
      {p.description && (
        <span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-[var(--ca-ink-muted)]">{p.description}</span>
      )}
      {(lang || stars !== null || forks !== null) && (
        <span className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-[var(--ca-ink-muted)]">
          {lang && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: LANG_COLORS[lang] ?? '#8b949e' }} aria-hidden />
              {lang}
            </span>
          )}
          {stars !== null && <StatPill icon={ICONS.star} value={stars} label="stars" />}
          {forks !== null && <StatPill icon={ICONS.fork} value={forks} label="forks" />}
          {p.publishedAt && <span className="ml-auto">Updated {formatAgo(p.publishedAt)}</span>}
        </span>
      )}
    </a>
  )
}

function PageCard({ p, href }: { p: LinkPreview; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-provider={p.provider ?? undefined}
      className={`${SHELL} flex items-stretch`}
    >
      <span className="min-w-0 flex-1 px-3 py-2.5">
        <SiteRow p={p} url={p.url} />
        <span className="mt-0.5 line-clamp-2 text-[14px] font-semibold leading-snug">{p.title || hostOf(p.url)}</span>
        {p.description && (
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[var(--ca-ink-muted)]">{p.description}</span>
        )}
      </span>
      {p.image && (
        <span className="relative w-[5.5rem] shrink-0 self-stretch overflow-hidden border-l border-[var(--ca-border)] bg-[var(--ca-card)]">
          <Img src={p.image} className="absolute inset-0 h-full w-full object-cover" />
          {p.kind === 'video' && <PlayButton />}
        </span>
      )}
    </a>
  )
}

function ImageLinkCard({ url, href }: { url: string; href: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  if (state === 'failed') return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-kind="image"
      className={`nub-link-card mt-2.5 block w-fit max-w-full overflow-hidden rounded-xl border border-[var(--ca-border)] bg-[var(--ca-hover)] transition hover:border-[var(--ca-primary)]/45 ${state === 'loading' ? 'min-h-24 min-w-40 skeleton-shine' : ''}`}
    >
      <img
        src={url}
        alt={`Image from ${hostOf(url)}`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setState('ready')}
        onError={() => setState('failed')}
        className="block max-h-72 w-auto max-w-full sm:max-w-[24rem] object-contain"
      />
    </a>
  )
}

function PdfCard({ name, url, href }: { name: string; url: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="link-preview"
      data-kind="pdf"
      className={`${SHELL} flex items-center gap-3 px-3 py-2.5`}
    >
      <span className="flex h-10 w-8 shrink-0 flex-col items-center justify-end rounded-[5px] bg-[#e5484d] pb-1 text-[8px] font-bold tracking-wide text-white">
        PDF
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{name}</span>
        <span className="block truncate text-[12px] text-[var(--ca-ink-muted)]">PDF · {hostOf(url)}</span>
      </span>
      <span className="text-[var(--ca-ink-muted)]">
        <Icon d={ICONS.external} size={13} />
      </span>
    </a>
  )
}

// ── Data + dispatch ──────────────────────────────────────────────────────

/** A YouTube card can draw before the platform answers: the thumbnail and
 *  the embed are known from the URL alone. */
function instantPreview(url: string): LinkPreview | null {
  const id = youtubeIdFromUrl(url)
  if (!id) return null
  return {
    url,
    kind: 'video',
    siteName: 'YouTube',
    title: null,
    description: null,
    image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    favicon: 'https://www.youtube.com/s/desktop/favicon.ico',
    provider: 'youtube',
    embed: { provider: 'youtube', id },
  }
}

/**
 * When a message's cards may ask the platform: null until the row is within
 * about a screen of the viewport, then whether it is on screen right now
 * ('visible' requests go first). A thread mounts ~60 rows with up to 3 cards
 * each, against a 30/min per-user limit, so off-screen rows wait. Without
 * IntersectionObserver (tests, old webviews) everything counts as visible.
 */
function useLoadPriority(ref: { current: HTMLElement | null }): PreviewPriority | null {
  const [priority, setPriority] = useState<PreviewPriority | null>(() =>
    typeof IntersectionObserver === 'undefined' ? 'visible' : null,
  )
  useLayoutEffect(() => {
    if (priority === 'visible') return
    const el = ref.current
    if (!el) {
      setPriority('visible')
      return
    }
    const scroller = el.closest('.overflow-y-auto')
    const root = scroller instanceof HTMLElement ? scroller : null
    const target = el.closest('[data-message-id]') ?? el
    const onScreen = (e: IntersectionObserverEntry): boolean => {
      const r = e.boundingClientRect
      if (!r) return true
      const top = root ? root.getBoundingClientRect().top : 0
      const bottom = root ? root.getBoundingClientRect().bottom : window.innerHeight
      return r.bottom >= top && r.top <= bottom
    }
    const io = new IntersectionObserver(
      (list) => {
        const hit = list.find((e) => e.isIntersecting)
        if (!hit) return
        const now = onScreen(hit) ? 'visible' : 'near'
        setPriority(now)
        if (now === 'visible') io.disconnect()
      },
      // Keep watching a 'near' row so it is promoted when it scrolls in.
      { root, rootMargin: '100% 0px 100% 0px', threshold: [0, 0.01, 0.5, 1] },
    )
    io.observe(target)
    return () => io.disconnect()
  }, [priority, ref])
  return priority
}

function usePreview(url: string, priority: PreviewPriority | null): LinkPreview | null {
  const [preview, setPreview] = useState<LinkPreview | null>(() => cachedLinkPreview(url) ?? instantPreview(url))
  const asked = priority !== null
  useEffect(() => {
    if (!asked) return
    let live = true
    void loadLinkPreview(url, priority ?? 'visible').then((p) => {
      if (live) setPreview((prev) => p ?? (prev?.provider === 'youtube' ? prev : null))
    })
    return () => {
      live = false
    }
    // A priority change only re-ranks the queued request (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, asked])
  useEffect(() => {
    if (priority === 'visible') prioritizeLinkPreview(url)
  }, [url, priority])
  return preview
}

function PreviewFor({ url, href, priority }: { url: string; href: string; priority: PreviewPriority | null }) {
  const p = usePreview(url, priority)
  if (!p) return null
  if (p.unavailable) return <UnavailableCard p={p} href={href} />
  if (p.provider === 'x') return <XPostCard p={p} href={href} />
  if (p.provider === 'github' && p.stats?.length) return <RepoCard p={p} href={href} />
  if (p.provider === 'spotify') return <SpotifyCard p={p} href={href} />
  if (p.provider === 'youtube' || (p.kind === 'video' && embedUrl(p))) return <VideoCard p={p} href={href} />
  return <PageCard p={p} href={href} />
}

/** One link's card: pictures and PDFs straight from the URL, everything else
 *  from the platform's preview. */
export const LinkPreviewCard = memo(function LinkPreviewCard({
  url,
  priority = 'visible',
}: {
  url: string
  /** null = not near the viewport yet: draw what's known, don't ask. */
  priority?: PreviewPriority | null
}) {
  const href = safeLinkUrl(url)
  const target = useMemo(() => linkTarget(url), [url])
  if (!href) return null
  if (target.kind === 'image') return <ImageLinkCard url={target.url} href={href} />
  if (target.kind === 'pdf') return <PdfCard name={target.name} url={target.url} href={href} />
  return <PreviewFor url={url} href={href} priority={priority} />
})

/** Cards for the links in a settled agent reply (none while it streams). */
export const LinkPreviews = memo(function LinkPreviews({ text }: { text: string }) {
  const urls = useMemo(() => previewUrlsIn(text), [text])
  if (urls.length === 0) return null
  return <PreviewList urls={urls} />
})

function PreviewList({ urls }: { urls: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const priority = useLoadPriority(ref)
  return (
    <div ref={ref} className="flex flex-col">
      {urls.map((url) => (
        <LinkPreviewCard key={url} url={url} priority={priority} />
      ))}
    </div>
  )
}
