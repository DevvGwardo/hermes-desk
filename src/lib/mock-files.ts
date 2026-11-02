/**
 * Offline demo workspace for mock mode (dev builds in a plain browser tab,
 * never shipped; off under unit tests): a few files under the agent
 * workspace so the Files browser, file cards and previews have something
 * real to open without a linked agent. Used by files-source.
 */
import type { FsEntry } from './fs'
import { demoAgentActive } from './mock-dashboard'

const ROOT = '/opt/data/workspace'

const files: Record<string, string> = {
  [`${ROOT}/README.md`]: '# Workspace\n\nFiles your agent made live here. Open one to preview it.\n',
  [`${ROOT}/landing/index.html`]:
    '<!doctype html><title>Landing</title><h1>Landing page</h1><p>Built by Research Alpha.</p>\n',
  [`${ROOT}/landing/styles.css`]: 'body { font-family: system-ui; margin: 2rem; }\n',
  [`${ROOT}/notes/deploy-summary.md`]:
    '# Deploy summary\n\n- Two deploys finished overnight, both healthy.\n- No open incidents.\n',
  [`${ROOT}/reports/usage.csv`]: 'day,requests\nMon,124\nTue,98\nWed,141\n',
}

export const mockFilesActive = demoAgentActive

export function mockListDir(dir: string): FsEntry[] {
  if (import.meta.env.PROD) return []
  const base = dir.replace(/\/+$/, '')
  const seen = new Map<string, FsEntry>()
  for (const path of Object.keys(files)) {
    if (!path.startsWith(`${base}/`)) continue
    const rest = path.slice(base.length + 1)
    const [head, ...more] = rest.split('/')
    const full = `${base}/${head}`
    if (!seen.has(full)) seen.set(full, { name: head!, path: full, isDirectory: more.length > 0 })
  }
  return [...seen.values()].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
}

export function mockReadText(path: string): string {
  if (import.meta.env.PROD) throw new Error('File not found')
  const text = files[path]
  if (text === undefined) throw new Error('File not found')
  return text
}

export function mockWriteText(path: string, content: string): void {
  if (import.meta.env.PROD) return
  files[path] = content
}

export function mockStat(path: string): { isDirectory: boolean; size: number; mtimeMs: number; gitStatus: null } {
  if (import.meta.env.PROD) return { isDirectory: false, size: 0, mtimeMs: 0, gitStatus: null }
  const text = files[path]
  return { isDirectory: text === undefined, size: text?.length ?? 0, mtimeMs: Date.now(), gitStatus: null }
}
