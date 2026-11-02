/**
 * Byte size of a file on the agent computer, for the meta line under a chat
 * file card ("Markdown · 12 KB · Workspace").
 *
 * Desktop asks the bridge for one stat. The browser has no stat route, so it
 * lists the parent folder once and every card in that folder reads from the
 * same answer. Answers are kept for a minute (the agent may rewrite a file),
 * concurrent asks share one request, and any failure is just "no size": the
 * card still shows the type and folder.
 */
import { dirname, basename } from './file-refs'
import { isBridgeAvailable, statPath as ipcStatPath, type FsEntry } from './fs'
import { listDir } from './files-source'

const TTL_MS = 60_000

type Cached<T> = { at: number; value: Promise<T> }

const sizeByPath = new Map<string, Cached<number | null>>()
const listingByDir = new Map<string, Cached<FsEntry[] | null>>()

function fresh<T>(map: Map<string, Cached<T>>, key: string, load: () => Promise<T>, now: number): Promise<T> {
  const hit = map.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.value
  const value = load()
  map.set(key, { at: now, value })
  return value
}

/** Size in bytes, or null when the source can't tell (or the file is gone). */
export function fileSize(path: string, now = Date.now()): Promise<number | null> {
  if (isBridgeAvailable()) {
    return fresh(
      sizeByPath,
      path,
      () =>
        Promise.resolve()
          .then(() => ipcStatPath(path))
          .then((s) => (s.isDirectory ? null : s.size))
          .catch(() => null),
      now,
    )
  }
  const dir = dirname(path)
  const name = basename(path)
  const list = () =>
    Promise.resolve()
      .then(() => listDir(dir))
      .catch(() => null)
  return fresh(listingByDir, dir, list, now).then((entries) => {
    const entry = (Array.isArray(entries) ? entries : null)?.find((e) => e.name === name && !e.isDirectory)
    return typeof entry?.size === 'number' ? entry.size : null
  })
}

/** Tests only. */
export function clearFileSizeCache(): void {
  sizeByPath.clear()
  listingByDir.clear()
}
