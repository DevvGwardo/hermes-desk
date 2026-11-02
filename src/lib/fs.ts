/**
 * Typed renderer-side client for the Electron filesystem bridge.
 *
 * Talks to `window.nubAgent.hermes('fs', [verb, ...args])` (provided by the
 * Electron desktop shell; see `fsHandle` in electron/main.cjs). In a plain
 * browser (vite dev without Electron) the bridge is absent: every call
 * throws a clear desktop-only error instead of returning fake data.
 *
 * Verbs (implemented in main.cjs — do NOT modify main.cjs):
 *   - list <dir>          → { ok, data:{ path, entries:[{name,path,isDirectory}] } }
 *   - read-text <path>    → { ok, data:{ path, content } }
 *   - read-data-url <path> → { ok, data: 'data:mime;base64,...' }
 *   - write-text <path> <content> → { ok, data:{ path } }
 *   - stat <path>         → { ok, data:{ path, isDirectory, size, mtimeMs, gitStatus } }
 *   - git-status [path]   → { ok, data:{ root, files:[{path,kind}] } }
 *   - git-diff <path>     → { ok, data: 'unified diff text' }
 *   - root [path]         → { ok, data:{ cwd, gitRoot, defaultCwd } }
 */

/** Shape returned by the desktop bridge: { ok, code, data, error }. */
export interface FsBridgeResult {
  ok: boolean
  code?: number
  data?: unknown
  error?: string
}

/** A single directory entry as returned by `fs list`. */
export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  /** Bytes, when the source reports it (the hosted platform does, the
   *  desktop bridge does not). */
  size?: number
  /** Last change in epoch ms, when the source reports it. */
  modifiedAt?: number | null
}

/** The `hermes(kind, args)` bridge — implemented by the desktop shell. */
type FsBridge = (kind: string, args: string[]) => Promise<FsBridgeResult>

const BRIDGE_UNAVAILABLE = 'Filesystem bridge unavailable (desktop app required).'

function getBridge(): FsBridge | null {
  const w = window as { nubAgent?: { hermes?: FsBridge } }
  return w.nubAgent?.hermes ?? null
}

/** True when the desktop filesystem bridge is reachable. */
export function isBridgeAvailable(): boolean {
  return getBridge() != null
}
export async function defaultRoot(): Promise<string> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const result = await bridge('fs', ['defaultRoot'])
  if (!result.ok || typeof result.data !== 'string' || !result.data.startsWith('/') || result.data === '/') {
    throw new Error('The local files root is unavailable.')
  }
  return result.data
}
export async function resolveFilesRoot(cwd?: string): Promise<string> {
  return !cwd?.trim() || cwd === '/' ? defaultRoot() : cwd
}
export function filesErrorMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error || '')
  return /outside (?:home|allowed|root)|outside what Hermes|path.*not allowed/i.test(text)
    ? 'This folder is outside what Hermes Desk can open.' : null
}

/** Last path segment of a `/`- or `\`-separated path (trailing-slash safe). */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Directory portion of a `/`- or `\`-separated path (trailing-slash safe). */
export function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx > 0 ? trimmed.slice(0, idx) : idx === 0 ? '/' : '.'
}

/** Common noise directories/files filtered from file-tree listings. */
export const DEFAULT_EXCLUDED: Set<string> = new Set<string>([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
])

/** True when a directory/file name should be hidden from the file tree. */
export function isExcluded(name: string): boolean {
  return DEFAULT_EXCLUDED.has(name)
}

/**
 * List a directory (dirs-first, sorted by the bridge). Throws on bridge
 * failure; returns [] for a valid-but-empty directory (never throws).
 */
export async function listDir(dir?: string): Promise<FsEntry[]> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['list', await resolveFilesRoot(dir)])
  if (!res.ok) throw new Error(res.error ?? `fs list failed (${res.code})`)
  const data = res.data as { entries?: FsEntry[] }
  if (!Array.isArray(data?.entries)) throw new Error('fs list returned no entries')
  return data.entries
}

/** Read a text file as a UTF-8 string. */
export async function readText(path: string): Promise<string> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['read-text', path])
  if (!res.ok) throw new Error(res.error ?? `fs read-text failed (${res.code})`)
  const data = res.data as { content?: string }
  if (typeof data?.content !== 'string') throw new Error('fs read-text returned no content')
  return data.content
}

/** Read a file as a `data:mime;base64,...` URL (binary-safe, for previews). */
export async function readDataUrl(path: string): Promise<string> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['read-data-url', path])
  if (!res.ok) throw new Error(res.error ?? `fs read-data-url failed (${res.code})`)
  if (typeof res.data !== 'string') throw new Error('fs read-data-url returned no data URL')
  return res.data
}

/** Write a UTF-8 text file (creates parent directories). */
export async function writeText(path: string, content: string): Promise<void> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['write-text', path, content])
  if (!res.ok) throw new Error(res.error ?? `fs write-text failed (${res.code})`)
}

/** Stat a path: type, size, mtime, and git status when it's in a repo. */
export async function statPath(
  path: string,
): Promise<{
  isDirectory: boolean
  size: number
  mtimeMs: number
  gitStatus: { kind: 'added' | 'modified' | 'conflicted'; branch: string | null } | null
}> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['stat', path])
  if (!res.ok) throw new Error(res.error ?? `fs stat failed (${res.code})`)
  const data = res.data as {
    isDirectory?: boolean
    size?: number
    mtimeMs?: number
    gitStatus?: { kind: 'added' | 'modified' | 'conflicted'; branch: string | null } | null
  }
  if (typeof data?.isDirectory !== 'boolean') throw new Error('fs stat returned no entry')
  return {
    isDirectory: data.isDirectory,
    size: typeof data.size === 'number' ? data.size : 0,
    mtimeMs: typeof data.mtimeMs === 'number' ? data.mtimeMs : 0,
    gitStatus: data.gitStatus ?? null,
  }
}

/** List modified/added/conflicted files in the repo containing `path`. */
export async function gitStatus(
  path?: string,
): Promise<{ root: string | null; files: { path: string; kind: 'added' | 'modified' | 'conflicted' }[] }> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const args = path ? ['git-status', path] : ['git-status']
  const res = await bridge('fs', args)
  if (!res.ok) throw new Error(res.error ?? `fs git-status failed (${res.code})`)
  const data = res.data as {
    root?: string | null
    files?: { path: string; kind: 'added' | 'modified' | 'conflicted' }[]
  }
  return { root: data?.root ?? null, files: data?.files ?? [] }
}

/** Get the unified diff for a tracked file (throws when not a git repo). */
export async function gitDiff(path: string): Promise<string> {
  const bridge = getBridge()
  if (!bridge) throw new Error(BRIDGE_UNAVAILABLE)
  const res = await bridge('fs', ['git-diff', path])
  if (!res.ok) throw new Error(res.error ?? `fs git-diff failed (${res.code})`)
  return typeof res.data === 'string' ? res.data : ''
}

/** Tailwind-ish badge classes for each git status kind (used on list rows). */
export const GIT_BADGE: Record<string, string> = {
  added: 'bg-[var(--ca-success)]/15 text-[var(--ca-success)]',
  modified: 'bg-[var(--ca-warn)]/15 text-[var(--ca-warn)]',
  conflicted: 'bg-[var(--ca-danger)]/15 text-[var(--ca-danger)]',
}

/** Short single-character labels for git status badges in tree rows. */
export const GIT_BADGE_LABEL: Record<string, string> = {
  added: 'A',
  modified: 'M',
  conflicted: '!',
}
