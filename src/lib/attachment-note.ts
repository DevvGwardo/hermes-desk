/**
 * Files the user attached to a message, as the agent reads them.
 *
 * Attached files are uploaded to the agent computer before the message goes
 * out; the agent learns where they are from a short note appended to the
 * message text. The chat never shows that note — the bubble shows the files
 * as attachment chips instead — so every place that displays or matches a
 * user message strips it (`displayUserPrompt`).
 *
 * The note is line-based on purpose: file names may contain brackets,
 * parentheses and spaces ("image (82).png").
 */

const HEADER = 'Attached files (saved on your computer):'
const BULLET = '• '

export function withAttachmentNote(text: string, paths: string[]): string {
  const clean = paths.map((p) => p.trim()).filter(Boolean)
  if (clean.length === 0) return text
  const note = [HEADER, ...clean.map((p) => `${BULLET}${p}`)].join('\n')
  return text.trim() ? `${text.trimEnd()}\n\n${note}` : note
}

/** Split a message into what the user typed and the files it carried. */
export function splitAttachmentNote(raw: string): { text: string; paths: string[] } {
  const at = raw.lastIndexOf(HEADER)
  if (at < 0) return { text: raw, paths: [] }
  // Only a trailing note, at the start or after a blank line — never a
  // mention of the phrase in the middle of what the user wrote.
  if (at > 0 && !raw.slice(0, at).endsWith('\n\n')) return { text: raw, paths: [] }
  const lines = raw.slice(at + HEADER.length).split('\n').slice(1)
  if (lines.length === 0 || !lines.every((l) => l.startsWith(BULLET))) return { text: raw, paths: [] }
  return {
    text: raw.slice(0, at).trimEnd(),
    paths: lines.map((l) => l.slice(BULLET.length).trim()).filter(Boolean),
  }
}

export function attachmentKind(path: string): 'image' | 'file' {
  return /\.(png|jpe?g|gif|webp|svg|heic|avif)$/i.test(path) ? 'image' : 'file'
}

export function attachmentName(path: string): string {
  return path.split('/').pop() || path
}
