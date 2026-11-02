/** URL-only link helpers. No preview service, persistence, or hosted requests. */

export type LinkProvider = 'youtube' | 'x' | 'github' | 'spotify'
export type LinkStatKind = 'views' | 'likes' | 'reposts' | 'replies' | 'stars' | 'forks'
export type SpotifyType = 'track' | 'album' | 'playlist' | 'episode' | 'show' | 'artist'

export type LinkPreview = {
  url: string
  kind: 'video' | 'link'
  siteName: string | null
  title: string | null
  description: string | null
  image: string | null
  /** The page/video doesn't exist (404). */
  unavailable?: boolean
  favicon?: string | null
  provider?: LinkProvider | null
  author?: { name: string; handle: string | null; avatar: string | null } | null
  durationSeconds?: number | null
  stats?: Array<{ kind: LinkStatKind; value: number }>
  publishedAt?: string | null
  tags?: string[]
  embed?: { provider: 'youtube'; id: string } | { provider: 'spotify'; type: SpotifyType; id: string } | null
}

/** What a link points at, decided from the URL alone (no request). */
export type LinkTarget = { kind: 'image'; url: string } | { kind: 'pdf'; url: string; name: string } | { kind: 'page'; url: string }

/** Cards per reply. A link dump gets its first few. */
export const MAX_PREVIEWS_PER_MESSAGE = 3

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i

function cleanCandidate(raw: string): string | null {
  // Trailing prose punctuation isn't part of a bare URL; a closing paren is
  // only kept when the URL opened one (wiki-style links).
  let s = raw.replace(/[.,;:!?'"]+$/, '')
  while (s.endsWith(')') && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) {
    s = s.slice(0, -1).replace(/[.,;:!?'"]+$/, '')
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  u.hash = ''
  return u.toString()
}

/** Image and PDF links render straight from the URL; pages remain plain links. */
export function linkTarget(url: string): LinkTarget {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    return { kind: 'page', url }
  }
  if (IMAGE_EXT.test(path)) return { kind: 'image', url }
  if (/\.pdf$/i.test(path)) {
    let name = path.split('/').pop() || 'document.pdf'
    try {
      name = decodeURIComponent(name)
    } catch {
      /* keep the raw segment */
    }
    return { kind: 'pdf', url, name }
  }
  return { kind: 'page', url }
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/

/** YouTube video id from a watch / youtu.be / shorts / embed link (same rule
 *  as the platform's youtubeVideoId). */
export function youtubeIdFromUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  const ok = (id: string | null | undefined) => (id && YT_ID.test(id) ? id : null)
  if (host === 'youtu.be') return ok(u.pathname.split('/')[1])
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  if (u.pathname === '/watch') return ok(u.searchParams.get('v'))
  return ok(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1])
}

/**
 * Readable label for a link whose text is just its own URL: host plus the
 * start of the path, e.g. `youtube.com/watch…`. Null when the URL is short
 * enough to show as is.
 */
export function shortLinkLabel(url: string, max = 36): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')
  const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
  const full = `${host}${rest}`
  if (full.length <= max && !u.search) return full === url ? null : full
  const room = Math.max(0, max - host.length - 1)
  const path = u.pathname === '/' ? '' : u.pathname
  return path && room > 4 ? `${host}${path.slice(0, room)}…` : `${host}${path || u.search ? '/…' : ''}`
}
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/
const SPOTIFY_TYPES = new Set<SpotifyType>(['track', 'album', 'playlist', 'episode', 'show', 'artist'])

/** Embed URL for a preview, built here from validated ids (never a
 *  server-sent URL), or null. */
export function embedUrl(p: LinkPreview): string | null {
  const e = p.embed
  if (!e) return null
  if (e.provider === 'youtube' && YT_ID.test(e.id)) {
    return `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`
  }
  if (e.provider === 'spotify' && SPOTIFY_TYPES.has(e.type) && SPOTIFY_ID.test(e.id)) {
    return `https://open.spotify.com/embed/${e.type}/${e.id}?utm_source=nub`
  }
  return null
}

/** Inline players need a real web origin: YouTube refuses to play for a
 *  file:// page (no referrer), which is how the packaged Electron app loads. */
export function canEmbedInline(): boolean {
  return false
}

/**
 * https links in a markdown reply worth a card, in order, deduped: markdown
 * links, <autolinks> and bare URLs. Images (`![](…)`) and anything inside
 * code (fenced or inline) are skipped.
 */
export function previewUrlsIn(text: string, max = MAX_PREVIEWS_PER_MESSAGE): string[] {
  if (!text || !text.includes('https://')) return []
  const prose = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  const out: string[] = []
  const seen = new Set<string>()
  // [label](url "title") | <url> | bare url
  const re = /\]\(\s*<?(https:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https:\/\/[^>\s]+)>|(https:\/\/[^\s<>"'`\]]+)/g
  for (const m of prose.matchAll(re)) {
    const url = cleanCandidate(m[1] ?? m[2] ?? m[3] ?? '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= max) break
  }
  return out
}

export type PreviewPriority = 'visible' | 'near'
export function prioritizeLinkPreview(_url: string): void {}
export function cachedLinkPreview(_url: string): LinkPreview | null | undefined { return undefined }
export async function loadLinkPreview(_url: string, _priority?: PreviewPriority): Promise<LinkPreview | null> { return null }
export function flushLinkPreviewStoreForTest(): void {}
export function resetLinkPreviewCacheForTest(): void {}
