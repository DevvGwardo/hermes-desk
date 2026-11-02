'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')

// The main JSON-RPC broker has a 4 MiB frame cap; leave room for base64 and the envelope.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 10
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Main-side services handed to the attachments broker. All shapes are
 * validated per call; the types only name the consumed protocol.
 * @typedef {object} AttachmentsCtx
 * @property {(channel: string, listener: (...args: Array<unknown>) => void) => void} ipcHandle
 * @property {((event: unknown) => void) | undefined} [assertMainSender]
 * @property {() => import('electron').BrowserWindow | null} getMainWindow
 * @property {{showOpenDialog: (win: unknown, options: unknown) => Promise<unknown>}} dialog
 * @property {{hasSession: (id: unknown, profile: unknown) => unknown, call: (method: string, params: unknown) => Promise<unknown>} | undefined} [serveClient]
 */
/**
 * @param {AttachmentsCtx} ctx
 */
function registerAttachments(ctx) {
  let picking = false
  ctx.ipcHandle('hd:attachments:pickAndUpload', async (event, request, ...extra) => {
    ctx.assertMainSender?.(event)
    const req = /** @type {Record<string, unknown>} */ (request && typeof request === 'object' ? request : null)
    const serve = ctx.serveClient
    const evt = /** @type {{sender?: unknown}} */ (event)
    if (evt.sender !== ctx.getMainWindow()?.webContents || extra.length || !req || Array.isArray(req) ||
        Object.keys(req).some(key => !['profile', 'sessionId'].includes(key)) ||
        typeof req.profile !== 'string' || !PROFILE.test(req.profile) ||
        typeof req.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(req.sessionId) ||
        !serve?.hasSession?.(req.sessionId, req.profile)) {
      throw new Error('Invalid attachment request')
    }
    if (picking) throw new Error('Attachment picker already open')
    picking = true
    try {
      const result = /** @type {Record<string, unknown>} */ (await ctx.dialog.showOpenDialog(ctx.getMainWindow(), {
        title: 'Attach files to this Hermes chat', properties: ['openFile', 'multiSelections'],
      }))
      if (result.canceled) return { files: [] }
      if (!Array.isArray(result.filePaths) || result.filePaths.length > MAX_FILES) return { files: [], error: 'Choose at most 10 files.' }
      const files = []
      for (const selected of result.filePaths) {
        /** @type {import('node:fs/promises').FileHandle | undefined} */
        let handle
        try {
          // Only native-selected regular files. No renderer paths, symlinks, directories or devices.
          handle = await fs.open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('File is not a bounded regular file')
          const buffer = Buffer.alloc(MAX_BYTES + 1)
          let size = 0
          while (size < buffer.length) {
            const read = await handle.read(buffer, size, buffer.length - size, null)
            if (!read.bytesRead) break
            size += read.bytesRead
          }
          if (size > MAX_BYTES) throw new Error('File grew beyond the upload limit')
          if (!serve.hasSession(req.sessionId, req.profile)) throw new Error('Session is no longer attached')
          const name = path.basename(selected)
          // The session-scoped serve upload stages bytes in the owning workspace.
          // File attach does not queue an image behind a draft that the user might remove.
          const uploaded = await serve.call('file.attach', {
            session_id: req.sessionId, profile: req.profile, name,
            data_url: `data:application/octet-stream;base64,${buffer.subarray(0, size).toString('base64')}`,
          })
          const up = /** @type {Record<string, unknown> | null} */ (uploaded && typeof uploaded === 'object' ? uploaded : null)
          if (!up || up.attached !== true || typeof up.path !== 'string' ||
            !path.isAbsolute(up.path) || /[\x00-\x1f\x7f]/.test(up.path)) throw new Error('Invalid upload result')
          files.push({ name, path: up.path, kind: /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : 'file', size })
        } catch {
          // Never return paths from a failed selection or raw filesystem/RPC errors.
          return { files, error: 'Could not upload a file. Choose regular files up to 2 MB and retry.' }
        } finally { await handle?.close() }
      }
      return { files }
    } finally { picking = false }
  })
  return { dispose() {} }
}

module.exports = { registerAttachments, MAX_BYTES }
