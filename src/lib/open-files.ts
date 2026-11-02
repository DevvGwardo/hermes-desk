/**
 * Ask the app shell to open the Files sidebar at a folder from anywhere
 * (e.g. a folder card in the chat) without threading a callback through
 * every message component. App.tsx listens; the panel never goes above its
 * workspace root, so a folder outside it opens at the root.
 */

const EVENT = 'nub:open-files'

export function requestOpenFiles(folder?: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { folder } }))
}

export function onOpenFilesRequest(cb: (folder: string | undefined) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => {
    const folder = (e as CustomEvent<{ folder?: unknown }>).detail?.folder
    cb(typeof folder === 'string' && folder.trim() ? folder.trim() : undefined)
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

/** `folder` when it sits inside `root` (or is it), else `root`. */
export function folderWithin(root: string, folder: string | undefined): string {
  const base = root.replace(/\/+$/, '')
  const f = (folder ?? '').replace(/\/+$/, '')
  if (!f || !base) return root
  return f === base || f.startsWith(`${base}/`) ? f : root
}
