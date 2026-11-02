/**
 * Chat image URLs. Agents emit markdown `![]()` and raw `<img>`.
 * Only schemes the CSP can load, and never javascript:/file:/http.
 */

import { isRenderableInlineDataUrl, isReplyMediaImage } from './reply-media'

/** `nub-vm://file/<path>` reads a VM file. Only the same image paths a
 *  `MEDIA:` tag may show (under /opt/data/, no `..`, raster ext, never agent
 *  config/secrets); anything else would be an existence oracle. Other nub-vm
 *  hosts (shot, computer, live ports) are unchanged. */
function safeNubVmUrl(value: string): string | null {
  // Parsed by hand, not `new URL`: whether `nub-vm:` counts as a standard
  // scheme differs between Electron (registered) and other runtimes, so
  // `nub-vm:///file/...` or `nub-vm:FILE/...` must not slip past as a
  // non-file host here while the main process still reads it as a file.
  if (value.includes('\\')) return null
  const rest = value.slice('nub-vm:'.length).replace(/^\/+/, '')
  const cut = rest.search(/[/?#]/)
  let host: string
  try {
    host = decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut))
      .toLowerCase()
      .replace(/^.*@/, '') // userinfo
      .replace(/:\d*$/, '') // port
  } catch {
    return null
  }
  if (host !== 'file') return value
  const pathPart = cut === -1 ? '' : rest.slice(cut).split(/[?#]/)[0]
  let path: string
  try {
    path = decodeURIComponent(pathPart)
  } catch {
    return null
  }
  return isReplyMediaImage(path) ? value : null
}

/**
 * The agent-computer path a markdown/HTML image points at, if it points at
 * one: `/opt/data/…`, `file:///opt/data/…` or `nub-vm://file/opt/data/…`.
 * Those are read through the VM file bridge (like a `MEDIA:` tag) — as an
 * app URL they would load from the app's own origin (or not at all on the
 * web). Same rule as `MEDIA:`: image extensions only, never config/secrets.
 */
export function vmImagePath(raw?: string | null): string | null {
  const value = (raw ?? '').trim()
  let path: string
  if (value.startsWith('/opt/data/')) {
    path = value
  } else if (/^file:\/\/\/opt\/data\//i.test(value)) {
    path = value.slice('file://'.length)
  } else if (/^nub-vm:\/\/file\/opt\/data\//i.test(value)) {
    path = value.slice('nub-vm://file'.length)
  } else {
    return null
  }
  if (value.includes('\\')) return null
  try {
    path = decodeURIComponent(path.split(/[?#]/)[0] ?? '')
  } catch {
    return null
  }
  return isReplyMediaImage(path) ? path : null
}

export function safeImageUrl(raw?: string | null): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null

  if (value.startsWith('data:')) {
    // Same rule as inline reply images: raster only (no svg), same byte cap
    // (MAX_INLINE_IMAGE_DATA_URL_CHARS).
    if (!isRenderableInlineDataUrl(value)) return null
    return value
  }

  if (value.startsWith('nub-vm:')) return safeNubVmUrl(value)
  if (value.startsWith('blob:')) return value

  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('://') || value.includes('\\')) return null
    return value
  }

  try {
    const u = new URL(value)
    if (u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

/** Links. Only https: navigates (plus a conservative mailto:); everything an
 *  agent could use for exfil or script execution — javascript:, data:, file:,
 *  blob:, nub-vm: — renders as inert text. Unknown/relative URLs fail closed.
 */
const BLOCKED_LINK_SCHEME = /^(javascript|data|file|blob|nub-vm):/i

export function safeLinkUrl(raw?: string | null): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  if (BLOCKED_LINK_SCHEME.test(value)) return null

  if (value.startsWith('mailto:')) {
    const addr = value.slice('mailto:'.length).split('?')[0] ?? ''
    if (!addr || /\s/.test(addr) || !addr.includes('@')) return null
    return value
  }

  try {
    const u = new URL(value)
    if (u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}
const IMG_TAG = /<img\b[^>]*>/gi
const ATTR = /\b(src|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** Turn safe HTML <img> into markdown so we never enable rehype-raw. */
export function liftHtmlImages(markdown: string): string {
  return markdown.replace(IMG_TAG, (tag) => {
    let src = ''
    let alt = ''
    ATTR.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ATTR.exec(tag))) {
      const key = m[1].toLowerCase()
      const val = m[2] ?? m[3] ?? ''
      if (key === 'src') src = val
      if (key === 'alt') alt = val
    }
    const href = vmImagePath(src) ?? safeImageUrl(src)
    if (!href) return ''
    const label = alt.replace(/[[\]]/g, '').trim()
    return `![${label}](${href})`
  })
}

const MD_IMAGE_SRC = /!\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g
const HTML_IMAGE_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** Agent-computer pictures a reply shows through markdown/HTML images: they
 *  render in place, so nothing else (screenshot strip, file cards) should
 *  show them a second time. */
export function markdownVmImagePaths(text: string): string[] {
  if (!text || !text.includes('/opt/data/')) return []
  const out: string[] = []
  for (const re of [MD_IMAGE_SRC, HTML_IMAGE_SRC]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const path = vmImagePath(m[1] ?? m[2])
      if (path && !out.includes(path)) out.push(path)
    }
  }
  return out
}
