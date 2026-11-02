/**
 * Structured file activity from agent tool events.
 *
 * Grok Bot never regex-guesses a project from prose — BoxRead/BoxWrite carry
 * paths. We do the same: parse tool args/results first, then fall back to
 * path-shaped text so older transcripts still work.
 */

import type { ChatMessage } from './agents/types'
import { extractReplyMedia } from './reply-media'
import { markdownVmImagePaths } from './safe-image-url'

export type FileAction = 'read' | 'write' | 'attach'

export interface FileRef {
  path: string
  action: FileAction
  /** `tool` = JSON/args from a file tool. `heuristic` = path found in prose. */
  source: 'tool' | 'heuristic'
  lineStart?: number
}

export const VM_ROOT = '/opt/data'

const WRITE_TOOLS =
  /^(write_file|write-file|write_text|write-text|boxwrite|str_replace|strreplace|patch|edit_file|edit-file)$/i
const READ_TOOLS = /^(read_file|read-file|read_text|read-text|boxread)$/i
const COMPUTER_TOOLS =
  /^(screenshot|computer|computer_use|computer-use|request_box_help)$/i
const PATH_KEYS = [
  'path',
  'file',
  'file_path',
  'filePath',
  'relative_workspace_path',
  'target',
  'target_file',
  'dest',
  'destination',
]
const LINE_KEYS = ['lineStart', 'line_start', 'start_line', 'start_line_one_indexed']

const VM_PATH_RE = /(\/opt\/data\/[^\s"'`<>]+)/g
const LINE_SUFFIX_RE = /(?::|#L)(\d+)(?:-\d+)?$/

export function isVmWorkspacePath(path: string | undefined | null): path is string {
  if (typeof path !== 'string' || !path) return false
  return path === VM_ROOT || path.startsWith(`${VM_ROOT}/`)
}

export function basename(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i < 0 ? trimmed : trimmed.slice(i + 1)
}

const EXTENSIONLESS_FILES = new Set([
  'makefile',
  'dockerfile',
  'license',
  'licence',
  'readme',
  'procfile',
  'gemfile',
  'rakefile',
  'justfile',
])

/** True when a VM path looks like a file we can preview (not a folder). */
export function isLikelyFilePath(filePath: string): boolean {
  const name = basename(filePath)
  if (!name || name === '.' || name === '..') return false
  if (name.startsWith('.') && name.length > 1) return true
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return true
  return EXTENSIONLESS_FILES.has(name.toLowerCase())
}

export function dirname(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? trimmed : trimmed.slice(0, i)
}

export function cleanVmPath(raw: string): string | null {
  let p = raw.trim().replace(/[.,;:!?'")\]]+$/, '')
  const line = LINE_SUFFIX_RE.exec(p)
  if (line) p = p.slice(0, line.index)
  if (!isVmWorkspacePath(p)) return null
  if (p.includes('..') || p.includes('\0')) return null
  return p
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

function collectVmPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value == null) return
  if (typeof value === 'string') {
    const cleaned = cleanVmPath(value)
    if (cleaned) out.push(cleaned)
    else {
      VM_PATH_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = VM_PATH_RE.exec(value))) {
        const p = cleanVmPath(m[1])
        if (p) out.push(p)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVmPaths(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    for (const key of PATH_KEYS) collectVmPaths(rec[key], out, depth + 1)
    if (out.length === 0) {
      for (const v of Object.values(rec)) collectVmPaths(v, out, depth + 1)
    }
  }
}

function lineFromValue(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rec = value as Record<string, unknown>
  for (const key of LINE_KEYS) {
    const n = Number(rec[key])
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function actionForTool(tool: string): FileAction | null {
  if (WRITE_TOOLS.test(tool)) return 'write'
  if (READ_TOOLS.test(tool)) return 'read'
  return null
}

function pushRef(out: FileRef[], path: string, action: FileAction, source: FileRef['source'], lineStart?: number) {
  const existing = out.find((r) => r.path === path)
  if (existing) {
    if (action === 'write') existing.action = 'write'
    if (source === 'tool') existing.source = 'tool'
    if (lineStart && !existing.lineStart) existing.lineStart = lineStart
    return
  }
  out.push({ path, action, source, lineStart })
}

function refsFromText(text: string, action: FileAction, source: FileRef['source'], out: FileRef[]) {
  VM_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VM_PATH_RE.exec(text))) {
    const p = cleanVmPath(m[1])
    if (p) pushRef(out, p, action, source)
  }
}

// ChatPanel + deriveProjectArtifacts re-derive this per message on every render
// (including each streaming tick), and the scan JSON-parses tool payloads and
// runs global regex passes over the results. Messages are immutable once
// appended (store patches replace the object), so a WeakMap cache skips the
// rescan for unchanged messages. Mirrors screenshotPathsFromMessage in
// project-artifacts.ts.
const fileRefsCache = new WeakMap<ChatMessage, FileRef[]>()

/** File refs on a single message (writes + reads). Attachments with VM paths included. */
export function fileRefsFromMessage(msg: ChatMessage): FileRef[] {
  const cached = fileRefsCache.get(msg)
  if (cached) return cached
  const out: FileRef[] = []
  for (const ev of msg.toolEvents ?? []) {
    const action = actionForTool(ev.tool)
    const parsed = parseJson(ev.args)
    const paths: string[] = []
    collectVmPaths(parsed, paths)
    collectVmPaths(parseJson(ev.result), paths)
    if (paths.length === 0 && ev.args) refsFromText(ev.args, action ?? 'read', 'heuristic', out)
    if (paths.length === 0 && ev.result) refsFromText(ev.result, action ?? 'read', 'heuristic', out)
    const line = lineFromValue(parsed)
    const resolved = action ?? (WRITE_TOOLS.test(ev.tool) ? 'write' : 'read')
    for (const p of paths) {
      pushRef(out, p, action ?? resolved, action ? 'tool' : 'heuristic', line)
    }
  }
  for (const att of msg.attachments ?? []) {
    if (att.name && isVmWorkspacePath(att.name)) {
      pushRef(out, att.name, 'attach', 'tool')
    }
  }
  if (msg.content && msg.role !== 'user') {
    refsFromText(extractReplyMedia(msg.content).text, 'write', 'heuristic', out)
  }
  fileRefsCache.set(msg, out)
  return out
}

export function fileRefsFromMessages(messages: ChatMessage[]): FileRef[] {
  const out: FileRef[] = []
  for (const msg of messages) {
    for (const ref of fileRefsFromMessage(msg)) {
      pushRef(out, ref.path, ref.action, ref.source, ref.lineStart)
    }
  }
  return out
}

export function relativeVmPath(filePath: string): string {
  for (const prefix of [`${VM_ROOT}/workspace/`, `${VM_ROOT}/`]) {
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  }
  return filePath
}

/** The folder a file sits in, for a card's meta line: "Workspace" at the
 *  workspace root, else the folder relative to it ("reports/q3"). Files in
 *  the agent's home outside the workspace keep their home-relative folder. */
export function fileLocationLabel(filePath: string): string {
  const rel = relativeVmPath(filePath)
  const i = rel.lastIndexOf('/')
  if (i < 0) return filePath.startsWith(`${VM_ROOT}/workspace/`) ? 'Workspace' : 'Agent home'
  return rel.slice(0, i)
}

/** Writes (and attaches) to show as in-chat file chips. Caps noise. */
/** The agent's home and workspace roots: everything lives there, so a card
 *  for them says nothing. */
export function isVmRootPath(path: string): boolean {
  const p = path.replace(/\/+$/, '')
  return p === `${VM_ROOT}` || p === `${VM_ROOT}/workspace`
}

export function fileCardsForMessage(msg: ChatMessage): FileRef[] {
  const refs = fileRefsFromMessage(msg).filter((r) => !isVmRootPath(r.path))
  const wanted =
    msg.role === 'user' ? refs.filter((r) => r.action === 'attach') : refs.filter((r) => r.action === 'write' || r.action === 'attach')
  if (msg.role === 'user') return wanted.slice(0, 8)
  // A `MEDIA:` or markdown image (VmShot), or a `MEDIA:` voice note or clip
  // (VmMedia), already renders inline — no second file card.
  const media = extractReplyMedia(msg.content ?? '')
  const images = [...media.images, ...media.media, ...markdownVmImagePaths(media.text)]
  return wanted.filter((r) => !images.includes(r.path)).slice(0, 8)
}

export function isComputerTool(tool: string): boolean {
  return COMPUTER_TOOLS.test(tool)
}

export function computerHandoffIndex(messages: ChatMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.toolEvents?.some((ev) => isComputerTool(ev.tool))) return i
    if (fileRefsFromMessage(msg).some((r) => /\.(png|jpe?g|webp|gif)$/i.test(r.path) && r.action !== 'read')) {
      if (msg.toolEvents?.some((ev) => /screenshot|computer/i.test(ev.tool))) return i
    }
  }
  return -1
}

/** `path.ts` / `path.ts:12` / `/opt/data/foo.ts#L10` citations in markdown. */
const CITE_RE = /(?:^|[\s(`])(\/opt\/data\/[^\s)'"`<>]+)(?=$|[\s),;:'"`])/g

export function fileCitationsIn(text: string): { raw: string; path: string; lineStart?: number }[] {
  const out: { raw: string; path: string; lineStart?: number }[] = []
  CITE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITE_RE.exec(text))) {
    const raw = m[1]
    const line = LINE_SUFFIX_RE.exec(raw)
    const path = cleanVmPath(raw)
    if (!path) continue
    if (out.some((c) => c.raw === raw)) continue
    out.push({
      raw,
      path,
      lineStart: line ? Number(line[1]) : undefined,
    })
  }
  return out
}
