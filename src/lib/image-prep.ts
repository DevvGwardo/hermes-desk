/**
 * Shrink pictures before they leave the device.
 *
 * - `inlineImageDataUrl`: the copy that travels with the message so the agent
 *   can see it. Phone photos and retina screenshots are far over the inline
 *   cap, so they are scaled to a model-friendly size instead of being left out.
 * - `shrinkImageToFit`: a smaller copy for uploads with a hard size cap (web
 *   and phone), so a 9 MB photo still goes instead of being refused.
 *
 * Both decode in the renderer (createImageBitmap + canvas). Where decoding is
 * unavailable or fails they return null and callers keep the original.
 */

/** Images up to this size go inline with the message (the request cap is 4.5 MB). */
export const INLINE_IMAGE_MAX_BYTES = 700 * 1024
/** Long edge of the inline copy — larger adds bytes, not detail the model uses. */
export const INLINE_IMAGE_MAX_EDGE = 1568

/** Formats the canvas can re-encode without losing anything the user expects
 *  (GIF would lose its animation, SVG is not a bitmap). */
export function isShrinkableImage(type: string): boolean {
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/webp'
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(blob)
  })
}

/** Data-URL length → the byte count it encodes. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length
  return Math.floor((b64 * 3) / 4)
}

/** Scale (w, h) so the long edge is at most `maxEdge`; never upscales. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h)
  if (long <= maxEdge || long === 0) return { width: w, height: h }
  const s = maxEdge / long
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

async function decode(file: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    // Honour EXIF rotation so phone photos are not sent sideways.
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }
}

function draw(
  bitmap: ImageBitmap,
  maxEdge: number,
  opaque: boolean,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (opaque) {
    // JPEG has no alpha: transparent pixels would otherwise turn black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality)
    } catch {
      resolve(null)
    }
  })
}

interface Attempt {
  maxEdge: number
  type: 'image/png' | 'image/jpeg'
  quality?: number
}

/** Encode `file` through the attempts in order; first result under `maxBytes` wins. */
async function encodeUnder(file: Blob, attempts: Attempt[], maxBytes: number): Promise<Blob | null> {
  const bitmap = await decode(file)
  if (!bitmap) return null
  try {
    for (const a of attempts) {
      const canvas = draw(bitmap, a.maxEdge, a.type === 'image/jpeg')
      if (!canvas) return null
      const blob = await toBlob(canvas, a.type, a.quality)
      if (blob && blob.size > 0 && blob.size <= maxBytes) return blob
    }
    return null
  } finally {
    bitmap.close?.()
  }
}

/** PNG keeps sharp text and transparency, so it is tried first for PNG sources;
 *  everything falls back to JPEG, which is what gets big photos under a cap. */
function attemptsFor(type: string, edges: number[]): Attempt[] {
  const out: Attempt[] = []
  for (const maxEdge of edges) {
    if (type === 'image/png') out.push({ maxEdge, type: 'image/png' })
    out.push({ maxEdge, type: 'image/jpeg', quality: 0.86 })
    out.push({ maxEdge, type: 'image/jpeg', quality: 0.72 })
  }
  return out
}

/**
 * The data URL to send with the message so the agent can see the picture,
 * or null when it cannot be made small enough (or is not a picture).
 */
export async function inlineImageDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return null
  if (file.size <= INLINE_IMAGE_MAX_BYTES) {
    try {
      const url = await readAsDataUrl(file)
      return url.startsWith('data:image/') ? url : null
    } catch {
      return null
    }
  }
  if (!isShrinkableImage(file.type)) return null
  const blob = await encodeUnder(
    file,
    attemptsFor(file.type, [INLINE_IMAGE_MAX_EDGE, 1024]),
    INLINE_IMAGE_MAX_BYTES,
  )
  if (!blob) return null
  try {
    const url = await readAsDataUrl(blob)
    return url.startsWith('data:image/') ? url : null
  } catch {
    return null
  }
}

function withExtension(name: string, type: string): string {
  const ext = type === 'image/png' ? 'png' : 'jpg'
  if (type === 'image/jpeg' && /\.jpe?g$/i.test(name)) return name
  if (type === 'image/png' && /\.png$/i.test(name)) return name
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'image'
  return `${stem}.${ext}`
}

/**
 * A copy of `file` at most `maxBytes`, as large as will fit, or null when it
 * is not a picture we can shrink. The name's extension follows the format.
 */
export async function shrinkImageToFit(file: File, maxBytes: number): Promise<File | null> {
  if (file.size <= maxBytes) return file
  if (!isShrinkableImage(file.type)) return null
  const blob = await encodeUnder(file, attemptsFor(file.type, [4096, 3072, 2048]), maxBytes)
  if (!blob) return null
  return new File([blob], withExtension(file.name || 'image', blob.type), { type: blob.type })
}
