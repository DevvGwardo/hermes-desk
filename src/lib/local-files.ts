/** Local filesystem limits and nullable read helper for shared panes. */
import { isBridgeAvailable, readText } from './fs'
export const LOCAL_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024
export const canReadLocalFiles = isBridgeAvailable
export async function readLocalText(path: string): Promise<string | null> {
  try { return await readText(path) } catch { return null }
}
