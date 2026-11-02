/**
 * Plain-language helpers for the Files panel: what to call a file, which tab
 * it belongs in, and which date group it sits under. The panel reads like a
 * phone's Photos / Files app, so nothing here shows an extension or a path.
 */
import { basename } from './fs'
import { extOf, mediaKindOf } from './media-kind'

export type FileTab = 'all' | 'photos' | 'docs' | 'sites'

export const FILE_TABS: { id: FileTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'photos', label: 'Photos' },
  { id: 'docs', label: 'Docs' },
  { id: 'sites', label: 'Sites' },
]

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'heif', 'avif', 'bmp'])
/** Images the browser can draw as a thumbnail. */
const THUMBNAIL = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const DOCS = new Set([
  'pdf', 'md', 'markdown', 'txt', 'doc', 'docx', 'rtf', 'odt', 'pages',
  'csv', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'key', 'odp',
])
const SITES = new Set(['html', 'htm'])

export function hasThumbnail(path: string): boolean {
  return THUMBNAIL.has(extOf(path))
}

/** The tab a file shows under besides All. Data and code only show in All. */
export function fileTabOf(path: string): Exclude<FileTab, 'all'> | null {
  const ext = extOf(path)
  if (IMAGE.has(ext) || mediaKindOf(path) === 'video') return 'photos'
  if (DOCS.has(ext) || mediaKindOf(path) === 'audio') return 'docs'
  if (SITES.has(ext)) return 'sites'
  return null
}

const CAMERA = /^(PXL|IMG|DSC|DSCN|DCIM|MVIMG|VID|MOV|PANO)[_-]?\d/i
const SCREENSHOT = /^screen ?shot/i

/**
 * "leon_profile.json" → "Leon profile", "PXL_20260927_215733834.jpg" →
 * "Photo". The real name stays available as a tooltip and in the preview.
 */
export function friendlyName(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  if (CAMERA.test(stem)) return mediaKindOf(path) === 'video' ? 'Video' : 'Photo'
  if (SCREENSHOT.test(stem)) return 'Screenshot'
  const words = stem.replace(/[_]+/g, ' ').replace(/(\D)-+|-+(\D)/g, '$1 $2').replace(/\s+/g, ' ').trim()
  if (!words) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY = 86_400_000

/** "Today", "Yesterday", "This week", "This month", "Earlier". */
export function dateGroupOf(modifiedAt: number | null | undefined, now = Date.now()): string {
  if (!modifiedAt) return 'Earlier'
  const today = startOfDay(now)
  if (modifiedAt >= today) return 'Today'
  if (modifiedAt >= today - DAY) return 'Yesterday'
  if (modifiedAt >= today - 6 * DAY) return 'This week'
  const n = new Date(now)
  const m = new Date(modifiedAt)
  if (m.getFullYear() === n.getFullYear() && m.getMonth() === n.getMonth()) return 'This month'
  return 'Earlier'
}

export const DATE_GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier']

/** "10:12 AM" today, "Yesterday", "Tuesday", "Sep 27", "Sep 27, 2025". */
export function formatWhen(modifiedAt: number | null | undefined, now = Date.now()): string {
  if (!modifiedAt) return ''
  const group = dateGroupOf(modifiedAt, now)
  const d = new Date(modifiedAt)
  if (group === 'Today') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (group === 'Yesterday') return 'Yesterday'
  if (group === 'This week') return d.toLocaleDateString(undefined, { weekday: 'long' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
