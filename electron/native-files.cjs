'use strict'

const { promises: fs, constants } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateFsPath, allowedFsRoots } = require('./fs-guard.cjs')
const formats = require('./media-formats.json')
const extensions = Object.keys({ ...formats.audio, ...formats.video })
const MAX_BYTES = 2 * 1024 * 1024 * 1024

async function sourceFile(raw, roots) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(raw) || path.basename(raw).startsWith('.env')) throw new Error('Invalid file')
  if (roots) validateFsPath(raw, 'file', roots)
  const real = await fs.realpath(raw)
  if (roots) validateFsPath(real, 'file', roots)
  const handle = await fs.open(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    const now = await fs.stat(real)
    if (!stat.isFile() || stat.size > MAX_BYTES || !Number.isSafeInteger(stat.size) ||
        stat.dev !== now.dev || stat.ino !== now.ino || await fs.realpath(raw) !== real) throw new Error('Invalid file')
    return { handle, stat }
  } catch (error) { await handle.close(); throw error }
}

async function copyBytes(source, output, job) {
  const buffer = Buffer.alloc(64 * 1024)
  let position = 0
  while (position < source.stat.size) {
    if (job.cancelled) throw new Error('File operation closed')
    const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.stat.size - position), position)
    if (!bytesRead) throw new Error('File changed')
    let written = 0
    while (written < bytesRead) {
      const result = await output.write(buffer, written, bytesRead - written, position + written)
      if (!result.bytesWritten) throw new Error('Could not write file')
      written += result.bytesWritten
    }
    position += bytesRead
  }
  const now = await source.handle.stat()
  if (job.cancelled || now.size !== source.stat.size || now.mtimeMs !== source.stat.mtimeMs ||
      now.ctimeMs !== source.stat.ctimeMs) throw new Error('File changed')
}

/** Delete only the file inode we created, never a replacement or selected original. */
async function discard(file, identity, folder) {
  try {
    const now = await fs.lstat(file)
    if (now.isFile() && now.dev === identity.dev && now.ino === identity.ino &&
        now.birthtimeMs === identity.birthtimeMs) await fs.unlink(file)
  } catch {}
  if (folder) await fs.rmdir(folder).catch(() => {})
}

function createNativeFiles({ dialog, getMainWindow, roots = allowedFsRoots,
  importRoot = path.join(os.homedir(), '.cache', 'hermes-desk', 'media-imports') }) {
  const imports = new Map()
  const pending = new Set()
  let busy = false
  async function run(owner, action) {
    if (busy) throw new Error('Finish the other file dialog first')
    busy = true
    const job = { owner, cancelled: false }
    pending.add(job)
    try { return await action(job) } finally { pending.delete(job); busy = false }
  }
  async function cacheSize() {
    const entries = await fs.readdir(importRoot, { withFileTypes: true })
    if (entries.length >= 32) throw new Error('Media import cache is full')
    let total = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('media-')) continue
      const dir = validateFsPath(path.join(importRoot, entry.name), 'media cache', roots())
      for (const name of await fs.readdir(dir)) total += (await fs.lstat(path.join(dir, name))).size
    }
    return total
  }
  async function releaseImport(file, owner) {
    const entry = imports.get(file)
    if (!entry || entry.owner !== owner) return
    imports.delete(file)
    await discard(file, entry.identity, entry.folder)
  }
  function releaseOwner(owner) {
    for (const job of pending) if (job.owner === owner) job.cancelled = true
    for (const [file, entry] of imports) if (entry.owner === owner) void releaseImport(file, owner)
  }
  return {
    pickMedia(owner) {
      return run(owner, async job => {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Open local video or audio', properties: ['openFile'],
          filters: [{ name: 'Video and audio', extensions }],
        })
        if (picked.canceled) return null
        if (job.cancelled || picked.filePaths?.length !== 1) throw new Error('File picker closed')
        const selected = picked.filePaths[0]
        if (!extensions.includes(path.extname(selected).slice(1).toLowerCase())) throw new Error('Choose video or audio')
        let source, output, folder, file, identity
        try {
          // The dialog authorizes this exact source, not its containing folder.
          source = await sourceFile(selected)
          validateFsPath(importRoot, 'media cache', roots())
          await fs.mkdir(importRoot, { recursive: true, mode: 0o700 })
          validateFsPath(await fs.realpath(importRoot), 'media cache', roots())
          if (await cacheSize() + source.stat.size > MAX_BYTES) throw new Error('Media import cache is full')
          folder = await fs.mkdtemp(path.join(importRoot, 'media-'))
          validateFsPath(await fs.realpath(folder), 'media cache', roots())
          file = path.join(folder, path.basename(selected))
          output = await fs.open(file, 'wx', 0o600)
          identity = await output.stat()
          await copyBytes(source, output, job)
          imports.set(file, { owner, identity, folder })
          return file
        } catch {
          if (identity) await discard(file, identity, folder)
          else if (folder) await fs.rmdir(folder).catch(() => {})
          throw new Error('Could not open media. Choose a regular file up to 2 GB; close other previews if the import cache is full.')
        } finally { await output?.close(); await source?.handle.close() }
      })
    },
    saveAs(file, owner) {
      return run(owner, async job => {
        let source, output, target, identity
        try {
          source = await sourceFile(file, roots())
          const result = await dialog.showSaveDialog(getMainWindow(), {
            title: 'Save a copy', defaultPath: path.basename(file), buttonLabel: 'Save a copy',
          })
          if (result.canceled) return false
          if (job.cancelled || typeof result.filePath !== 'string' || !path.isAbsolute(result.filePath) ||
              /[\x00-\x1f\x7f]/.test(result.filePath)) throw new Error('File dialog closed')
          const parent = await fs.realpath(path.dirname(result.filePath))
          target = path.join(parent, path.basename(result.filePath))
          // Never overwrite an existing file, including a symlink or the source itself.
          output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
            constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
          identity = await output.stat()
          await copyBytes(source, output, job)
          return true
        } catch {
          if (identity) await discard(target, identity)
          throw new Error('Could not save this file. Choose a new filename and a regular file up to 2 GB, then retry.')
        } finally { await output?.close(); await source?.handle.close() }
      })
    },
    releaseImport,
    releaseOwner,
    clear() {
      for (const job of pending) job.cancelled = true
      for (const entry of imports.values()) releaseOwner(entry.owner)
    },
  }
}

module.exports = { createNativeFiles, MAX_BYTES }
