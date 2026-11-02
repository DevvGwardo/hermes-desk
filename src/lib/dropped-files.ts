/**
 * The files in a drop, with folders set apart: a dropped folder arrives as a
 * File that can't be read (the upload used to fail with "Could not read that
 * file"), so it is named back to the reader instead.
 */
export function droppedFiles(dt: DataTransfer): { files: File[]; folders: string[] } {
  const files: File[] = []
  const folders: string[] = []
  const items = Array.from(dt.items ?? [])
  if (items.length > 0 && items.some((it) => typeof it.webkitGetAsEntry === 'function')) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      const file = item.getAsFile()
      if (entry?.isDirectory) folders.push(entry.name || file?.name || 'folder')
      else if (file) files.push(file)
    }
    return { files, folders }
  }
  return { files: Array.from(dt.files ?? []), folders }
}
