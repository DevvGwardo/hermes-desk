/**
 * Pictures on the agent computer, as the chat shows them: agent screenshots,
 * `MEDIA:` shares, files sent with a message, markdown images that point at
 * /opt/data. One loader for all of them.
 *
 * - One read per path, shared by every place it shows (transcript, thread
 *   pane, the full-screen viewer).
 * - The bytes are held as a Blob object URL, not the base64 string the read
 *   returns (a data URL costs ~2.7× the file in JS heap, per copy).
 * - Each picture is decoded before it is handed out, so it paints whole and
 *   at its final size in one frame; its natural size is remembered (past
 *   eviction too) so a remount reserves the exact box.
 * - At most MAX_READS reads run at once. A failed read retries once, then is
 *   dropped so Retry (or the next mount) reads again.
 * - Pictures nothing shows any more stay cached for scroll-back, up to
 *   MAX_IDLE; older ones are released.
 */
import { attachmentPreview } from './attachment-previews'
import { isFilesAvailable, readDataUrl } from './files-source'
import { isTooLargeError, mediaMimeOf } from './media-kind'

export interface ImageSize {
  width: number
  height: number
}

export interface LoadedImage extends Partial<ImageSize> {
  url: string
}

interface Entry {
  promise: Promise<LoadedImage | null>
  value: LoadedImage | null
  refs: number
  usedAt: number
  /** The object URL is ours to revoke. */
  owned: boolean
}

const MAX_READS = 3
const MAX_IDLE = 40
const MAX_SIZES = 600
const RETRY_MS = 800
const DECODE_WAIT_MS = 1500

const entries = new Map<string, Entry>()
const sizes = new Map<string, ImageSize>()

let reading = 0
const queued: Array<() => void> = []

/** Run `task` once fewer than MAX_READS are in flight. */
function readSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      reading++
      task()
        .then(resolve, reject)
        .finally(() => {
          reading--
          queued.shift()?.()
        })
    }
    if (reading < MAX_READS) run()
    else queued.push(run)
  })
}

async function readFileDataUrl(path: string): Promise<{ dataUrl: string | null; error?: string }> {
  try {
    return { dataUrl: (await readDataUrl(path)) || null }
  } catch (err) {
    return { dataUrl: null, error: err instanceof Error ? err.message : String(err) }
  }
}

const failures = new Map<string, string>()

/** Why the last read of `path` failed, if it said. */
export function vmFileError(path: string): string | undefined {
  return failures.get(path)
}

/** A base64 data URL as a Blob object URL; the data URL itself where object
 *  URLs are unavailable (tests) or the payload is not base64. */
export function dataUrlToObjectUrl(dataUrl: string, typeOverride?: string | null): { url: string; owned: boolean } {
  const comma = dataUrl.indexOf(',')
  const head = comma > 5 ? dataUrl.slice(5, comma) : ''
  if (typeof URL.createObjectURL !== 'function' || !head.endsWith(';base64')) {
    return { url: dataUrl, owned: false }
  }
  try {
    const bin = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const type = typeOverride || head.slice(0, -';base64'.length)
    return { url: URL.createObjectURL(new Blob([bytes], { type })), owned: true }
  } catch {
    return { url: dataUrl, owned: false }
  }
}

/** Decode `url` off-screen and report its natural size. Undefined when the
 *  engine cannot decode ahead (the <img> then reports errors itself). */
async function decodeSize(url: string): Promise<ImageSize | undefined> {
  if (typeof Image === 'undefined') return undefined
  const img = new Image()
  if (typeof img.decode !== 'function') return undefined
  img.decoding = 'async'
  img.src = url
  try {
    // Chrome holds decode() while the page is hidden: never let that hold
    // the picture back — past the cap the <img> just decodes it itself.
    const done = await Promise.race([
      img.decode().then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), DECODE_WAIT_MS)),
    ])
    if (!done) return undefined
  } catch {
    return undefined
  }
  return img.naturalWidth > 0 && img.naturalHeight > 0
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : undefined
}

export function rememberSize(key: string, size: ImageSize): void {
  if (!(size.width > 0 && size.height > 0)) return
  sizes.delete(key)
  sizes.set(key, size)
  if (sizes.size > MAX_SIZES) sizes.delete(sizes.keys().next().value as string)
}

/** The natural size of a picture shown before, if known. */
export function knownSize(key: string): ImageSize | undefined {
  return sizes.get(key)
}

/** Size-memory key for an inline data URL, without hashing megabytes. */
export function inlineImageKey(dataUrl: string): string {
  return `inline:${dataUrl.length}:${dataUrl.slice(-48)}`
}

function sweep(): void {
  const idle = [...entries].filter(([, e]) => e.refs <= 0 && e.value)
  if (idle.length <= MAX_IDLE) return
  idle.sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [key, e] of idle.slice(0, idle.length - MAX_IDLE)) {
    entries.delete(key)
    if (e.owned && e.value) URL.revokeObjectURL(e.value.url)
  }
}

function start(path: string): Entry {
  const entry: Entry = { promise: Promise.resolve(null), value: null, refs: 0, usedAt: Date.now(), owned: false }
  entry.promise = (async () => {
    // A picture this device just sent is already here as an object URL.
    const media = mediaMimeOf(path)
    let url = media ? undefined : attachmentPreview(path)
    if (!url) {
      let read = await readSlot(() => readFileDataUrl(path))
      // Nothing to read from (not linked), or refused for size: a retry
      // would fail the same way.
      if (!read.dataUrl && isFilesAvailable() && !isTooLargeError(read.error)) {
        await new Promise((r) => setTimeout(r, RETRY_MS))
        read = await readSlot(() => readFileDataUrl(path))
      }
      if (!read.dataUrl) {
        if (read.error) failures.set(path, read.error)
        if (entries.get(path) === entry) entries.delete(path)
        return null
      }
      failures.delete(path)
      const obj = dataUrlToObjectUrl(read.dataUrl, media)
      url = obj.url
      entry.owned = obj.owned
    }
    // Audio/video: nothing to decode ahead; the player reads its own size.
    const size = media ? undefined : await decodeSize(url)
    if (size) rememberSize(path, size)
    entry.value = { url, ...size }
    return entry.value
  })()
  return entry
}

/**
 * Hold a picture (or audio/video file) on the agent computer while it is on
 * screen. `release` when
 * it unmounts; an entry nothing holds may be evicted later.
 */
export function acquireVmImage(path: string): { promise: Promise<LoadedImage | null>; release: () => void } {
  let entry = entries.get(path)
  if (!entry) {
    entry = start(path)
    entries.set(path, entry)
  }
  const held = entry
  held.refs++
  held.usedAt = Date.now()
  let released = false
  return {
    promise: held.promise,
    release: () => {
      if (released) return
      released = true
      held.refs--
      held.usedAt = Date.now()
      sweep()
    },
  }
}

/** The picture, synchronously, if it is already loaded (a remount paints it
 *  in the first frame instead of flashing the placeholder). */
export function peekVmImage(path: string): LoadedImage | null {
  return entries.get(path)?.value ?? null
}

/** Drop a picture that failed (or whose bytes turned out unreadable) so the
 *  next acquire reads it again. */
export function forgetVmImage(path: string): void {
  const entry = entries.get(path)
  if (!entry) return
  entries.delete(path)
  if (entry.owned && entry.value && entry.refs <= 0) URL.revokeObjectURL(entry.value.url)
}

/** Test hook: empty the cache and the read queue. */
export function resetChatImagesForTests(): void {
  entries.clear()
  failures.clear()
  sizes.clear()
  queued.length = 0
  reading = 0
}
