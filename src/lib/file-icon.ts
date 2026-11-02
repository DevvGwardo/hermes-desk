/**
 * File-tree icon helpers — maps a filename to a small emoji glyph plus a
 * Tailwind text-color class, seti-theme style. Used for FilesPanel tree rows.
 * Hidden/dot files and lock/env files get a lock glyph; unknown types fall
 * back to a neutral document.
 */

const EXT_ICON: Record<string, string> = {
  ts: '🟦',
  tsx: '🟦',
  js: '🟦',
  jsx: '🟦',
  json: '🧾',
  md: '📝',
  py: '🐍',
  css: '🎨',
  html: '🌐',
  yml: '⚙️',
  yaml: '⚙️',
  sh: '🖥️',
  bash: '🖥️',
  toml: '📦',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  svg: '🖼️',
  lock: '🔒',
  env: '🔒',
}

const EXT_COLOR: Record<string, string> = {
  ts: 'text-[var(--ca-primary)]',
  tsx: 'text-[var(--ca-primary)]',
  js: 'text-[var(--ca-primary)]',
  jsx: 'text-[var(--ca-primary)]',
  json: 'text-[var(--ca-warn)]',
  md: 'text-[var(--ca-ink-muted)]',
  py: 'text-[var(--ca-success)]',
  css: 'text-[var(--ca-primary)]',
  html: 'text-[var(--ca-warn)]',
  yml: 'text-[var(--ca-ink-muted)]',
  yaml: 'text-[var(--ca-ink-muted)]',
  sh: 'text-[var(--ca-ink)]',
  bash: 'text-[var(--ca-ink)]',
  toml: 'text-[var(--ca-warn)]',
  png: 'text-[var(--ca-primary)]',
  jpg: 'text-[var(--ca-primary)]',
  jpeg: 'text-[var(--ca-primary)]',
  gif: 'text-[var(--ca-primary)]',
  webp: 'text-[var(--ca-primary)]',
  svg: 'text-[var(--ca-primary)]',
  lock: 'text-[var(--ca-warn)]',
  env: 'text-[var(--ca-warn)]',
}

/** The default glyph + color for unrecognized file types. */
export function fileIconFallback(): { icon: string; color: string } {
  return { icon: '📄', color: 'text-[var(--ca-ink-muted)]' }
}

/** Return the emoji glyph + text-color class for a file given its path. */
export function fileIconFor(path: string): { icon: string; color: string } {
  const name = basename(path)
  if (name.startsWith('.')) return { icon: '🔒', color: 'text-[var(--ca-warn)]' }
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext in EXT_ICON) return { icon: EXT_ICON[ext], color: EXT_COLOR[ext] }
  return fileIconFallback()
}

/** Plain names for the types agents write most; anything else reads as
 *  "<EXT> file". Shown under a file card's name, so a person sees what the
 *  thing is without opening it. */
const EXT_KIND: Record<string, string> = {
  md: 'Markdown',
  mdx: 'Markdown',
  txt: 'Text',
  pdf: 'PDF',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Spreadsheet',
  xlsx: 'Spreadsheet',
  csv: 'CSV table',
  tsv: 'TSV table',
  json: 'JSON',
  jsonl: 'JSON lines',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  html: 'Web page',
  htm: 'Web page',
  css: 'Stylesheet',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  py: 'Python',
  sh: 'Shell script',
  bash: 'Shell script',
  sql: 'SQL',
  log: 'Log',
  zip: 'Archive',
  gz: 'Archive',
  tar: 'Archive',
  svg: 'SVG image',
  ics: 'Calendar file',
  pptx: 'Slides',
  key: 'Slides',
}

/** "Markdown", "Python", "PDF"… for a file name or path. */
export function fileKindLabel(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'File'
  const ext = name.slice(dot + 1).toLowerCase()
  return EXT_KIND[ext] ?? `${ext.toUpperCase()} file`
}

/** Last path segment of a `/`- or `\`-separated path (trailing-slash safe). */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}
