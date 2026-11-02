/**
 * `MEDIA:<path>` tags in agent replies.
 *
 * hermes-agent shares a file by writing `MEDIA:/opt/data/...` into its reply
 * (e.g. after a browser screenshot). The platform relays the text unchanged,
 * so the tag is ours to render: image paths show inline (VmShot), audio and
 * video play inline (VmMedia: the agent's text-to-speech replies this way),
 * and the tag text goes away; any other path stays readable as a bare `code`
 * path, where the file-ref scan can still pick it up.
 *
 * The agent's non-streaming completion paths instead inline the image as
 * `![image](data:image/png;base64,...)`. Those come out as `inline` data URLs
 * so the bubble can show them without a VM read (and without react-markdown,
 * whose URL transform drops `data:` links).
 */

import { mediaKindOf } from './media-kind'

/** Closing wrappers only end an unquoted path when a real terminator follows
 *  them, so `_` inside `browser_screenshot_ab12.png` does not cut it. */
export const MEDIA_TAG_RE =
  /[`"'*_]{0,3}MEDIA:\s*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|(\/[^\s`"'<>]+?))(?=[`"'*_]{0,3}(?:[\s,;)\]}]|\.(?=\s|$)|$))[`"'*_]{0,3}/gi

export const INLINE_IMAGE_RE =
  /!\[[^\]\n]*\]\((data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)\)/g

/** Byte cap for an inline `data:image/...` URL, in characters of the whole
 *  URL. Shared with `safeImageUrl` (the markdown `<img>` path) and the
 *  `InlineShot` render site so all three agree. */
export const MAX_INLINE_IMAGE_DATA_URL_CHARS = 2_000_000

/** The only inline data-image shapes we render: raster, base64. No svg. */
export const INLINE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i

/** True for a raster base64 data URL within the byte cap. */
export function isRenderableInlineDataUrl(dataUrl: string): boolean {
  return dataUrl.length <= MAX_INLINE_IMAGE_DATA_URL_CHARS && INLINE_DATA_IMAGE_RE.test(dataUrl)
}

// No svg: an svg can carry script.
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp)$/i
const VM_ROOT = '/opt/data/'
/** Shared by `images` and `inline`. */
export const MAX_REPLY_MEDIA_IMAGES = 6

/** An /opt/data image VmShot may read. Agent config and secrets never are:
 *  the platform fs route refuses them anyway. */
export function isReplyMediaImage(path: string): boolean {
  if (!path.startsWith(VM_ROOT) || !IMAGE_EXT_RE.test(path)) return false
  return !path.split('/').includes('..') && !isPrivateVmPath(path)
}

/** Agent config / secrets under /opt/data: never shown as an image. */
export function isPrivateVmPath(path: string): boolean {
  if (path.startsWith(`${VM_ROOT}.hermes/`) || path === `${VM_ROOT}config.yaml`) return true
  return path.slice(path.lastIndexOf('/') + 1).startsWith('.env')
}

export interface ReplyInlineImage {
  dataUrl: string
  mime: string
}

export interface ReplyMedia {
  text: string
  images: string[]
  inline: ReplyInlineImage[]
  /** Audio/video paths (a voice reply, a clip): played inline (VmMedia). */
  media: string[]
}

/** Absolute local media paths are checked by the desktop filesystem guard
 *  when the user presses Play. No remote URLs, traversal or secret tags. */
export function isReplyMediaPlayable(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || !mediaKindOf(path) || /[\0\\]/.test(path)) return false
  return !path.split('/').some(part => part === '..' || part === '.') && !isPrivateVmPath(path)
}

/**
 * Standing note on every hosted chat turn's `instructions`: how the agent
 * gets an image or file in front of the user. Without it the agent may save
 * to /tmp and name the path, which the app can neither read nor render (file
 * rows only come from /opt/data paths, see file-refs.ts).
 */
export const IMAGE_SHARE_NOTE =
  '[To show the user an image (screenshot, chart, photo), save it under /opt/data/ (e.g. /opt/data/workspace/screenshot.png, never /tmp) and put `MEDIA:<absolute path>` on its own line in your reply. That tag renders the image inline in chat; a bare path does not. Any other file you make or download for the user (document, skill, code, export) also goes under /opt/data/workspace/, never /tmp, and your reply names its full path: the app shows /opt/data paths as files the user can open and cannot see /tmp.]'

/** Turn instructions with the image-sharing note appended. */
export function withImageShareNote(instructions: string): string {
  return instructions ? `${instructions}\n\n${IMAGE_SHARE_NOTE}` : IMAGE_SHARE_NOTE
}

let lastInput: string | null = null
let lastOutput: ReplyMedia = { text: '', images: [], inline: [], media: [] }

/** Remove `[start, end)` from `text` plus the gap it leaves: no double
 *  space, no trailing space. Appends to `out`; returns the new read offset. */
function dropSpan(text: string, out: { s: string }, end: number): number {
  out.s = out.s.replace(/[ \t]+$/, '')
  const lead = /^[ \t]+/.exec(text.slice(end))
  if (!lead) return end
  const next = text.charAt(end + lead[0].length)
  if (out.s && !out.s.endsWith('\n') && next && next !== '\n') out.s += ' '
  return end + lead[0].length
}

/**
 * Strip `MEDIA:` tags and inlined base64 images from reply text. Pure and
 * safe on partial streaming text (a half-written tag just reads as a bare
 * path until it completes). Text with neither is returned unchanged.
 */
export function extractReplyMedia(text: string): ReplyMedia {
  if (!text || !/media:|data:image\//i.test(text)) return { text, images: [], inline: [], media: [] }
  // Bubbles re-render per streaming tick with the same settled content.
  if (text === lastInput) return lastOutput
  const images: string[] = []
  const inline: ReplyInlineImage[] = []
  const media: string[] = []
  const room = () => images.length + inline.length < MAX_REPLY_MEDIA_IMAGES

  // Inline data images first, so a base64 body is never scanned for tags.
  const pass1 = { s: '' }
  let last = 0
  INLINE_IMAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_IMAGE_RE.exec(text))) {
    pass1.s += text.slice(last, m.index)
    // Past the count cap, or over the byte cap, the image is dropped:
    // megabytes of base64 are not text either. The match itself is linear
    // (one character class, one start per `![`), so the length check after
    // the match costs no more than scanning the text once.
    const fits = m[1].length <= MAX_INLINE_IMAGE_DATA_URL_CHARS
    if (fits && room() && !inline.some((i) => i.dataUrl === m![1])) {
      inline.push({ dataUrl: m[1], mime: `image/${m[2]}` })
    }
    last = dropSpan(text, pass1, m.index + m[0].length)
  }
  pass1.s += text.slice(last)

  const src = pass1.s
  const out = { s: '' }
  last = 0
  MEDIA_TAG_RE.lastIndex = 0
  while ((m = MEDIA_TAG_RE.exec(src))) {
    const path = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()
    out.s += src.slice(last, m.index)
    last = m.index + m[0].length
    if (isReplyMediaPlayable(path) && (media.includes(path) || media.length < MAX_REPLY_MEDIA_IMAGES)) {
      if (!media.includes(path)) media.push(path)
      last = dropSpan(src, out, last)
      continue
    }
    const keep = isReplyMediaImage(path) && (images.includes(path) || room())
    if (!keep) {
      out.s += path ? `\`${path}\`` : m[0]
      continue
    }
    if (!images.includes(path)) images.push(path)
    last = dropSpan(src, out, last)
  }
  out.s += src.slice(last)
  const result = { text: out.s.replace(/\n{3,}/g, '\n\n').trim(), images, inline, media }
  lastInput = text
  lastOutput = result
  return result
}
