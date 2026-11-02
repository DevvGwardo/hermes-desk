/**
 * What a file is, by extension, for the places that must not treat bytes as
 * text: the file preview (no garbled text, no Edit/Save on a binary) and
 * chat replies (a voice note or clip plays inline).
 */

import formats from '../../electron/media-formats.json'
const AUDIO: Record<string, string> = formats.audio
const VIDEO: Record<string, string> = formats.video

/** Files with no useful text form. Opening one shows a download card
 *  instead of its bytes decoded as text (and never offers Edit). */
const BINARY = new Set([
  // archives / packages
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'aab', 'ipa', 'jar', 'whl',
  // office / design documents
  'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp', 'ods', 'pages', 'key', 'numbers', 'psd', 'ai', 'sketch', 'fig', 'indd',
  // other media
  'avi', 'mkv', 'wmv', 'flv', 'mid', 'midi', 'aiff', 'aif',
  // images we don't preview
  'heic', 'heif', 'tif', 'tiff', 'bmp', 'ico', 'icns', 'raw', 'cr2', 'nef', 'dng', 'avif',
  // fonts, binaries, data
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'wasm',
  'sqlite', 'sqlite3', 'db', 'parquet', 'pickle', 'pkl', 'npy', 'npz', 'pt', 'pth', 'onnx', 'safetensors', 'gguf',
])

export type MediaKind = 'audio' | 'video'

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function mediaKindOf(path: string): MediaKind | null {
  const ext = extOf(path)
  if (Object.hasOwn(AUDIO, ext)) return 'audio'
  if (Object.hasOwn(VIDEO, ext)) return 'video'
  return null
}

/** The MIME type to play a media file as (the read may report it as
 *  application/octet-stream). */
export function mediaMimeOf(path: string): string | null {
  const ext = extOf(path)
  return Object.hasOwn(AUDIO, ext) ? AUDIO[ext] : Object.hasOwn(VIDEO, ext) ? VIDEO[ext] : null
}

export function isBinaryPath(path: string): boolean {
  return BINARY.has(extOf(path))
}

/** A read refused for size (HTTP 413, or the bridge's "too large"). */
export function isTooLargeError(message: string | null | undefined): boolean {
  return Boolean(message && /\b413\b|too[- ]large/i.test(message))
}

/** Biggest file the agent computer hands back in one read (the dashboard's
 *  read-data-url cap). Bigger files download through Save on desktop. */
export const VM_READ_MAX_BYTES = 10 * 1024 * 1024
