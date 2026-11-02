/** Local files only. All reads and writes go through the guarded main-process IPC. */
import {
  defaultRoot, resolveFilesRoot, filesErrorMessage, gitDiff, gitStatus, isBridgeAvailable, listDir, readDataUrl, readText, statPath, writeText,
} from './fs'

export { defaultRoot, resolveFilesRoot, filesErrorMessage, gitDiff, gitStatus, listDir, readDataUrl, readText, statPath, writeText }
export const isFilesAvailable = isBridgeAvailable
export function canEditFile(_path: string): boolean { return isBridgeAvailable() }
export async function downloadLink(_path: string): Promise<null> { return null }
export async function downloadBlob(_path: string): Promise<null> { return null }
