'use strict'

const { randomBytes } = require('node:crypto')
const { promises: fs, constants } = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { validateFsPath, allowedFsRoots } = require('./fs-guard.cjs')
const formats = require('./media-formats.json')
const mimeTypes = new Map(Object.entries({ ...formats.audio, ...formats.video }))
const MAX_GRANTS = 64
const MAX_STREAMS = 16

function mediaMime(file) {
  if (path.basename(file).startsWith('.env')) return null
  return mimeTypes.get(path.extname(file).slice(1).toLowerCase()) ?? null
}

/** Open a regular file, retaining the existing home/symlink boundary. */
async function openMediaFile(raw, roots) {
  const checked = validateFsPath(raw, 'media file', roots)
  const real = validateFsPath(await fs.realpath(checked), 'media file', roots)
  const mime = mediaMime(real)
  if (!mediaMime(checked) || !mime) throw new Error('Unsupported media file')
  const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Not a media file')
    // Catch a parent/leaf replacement across the open, not just leaf symlinks.
    const current = validateFsPath(await fs.realpath(checked), 'media file', roots)
    const now = await fs.stat(current)
    if (current !== real || now.dev !== stat.dev || now.ino !== stat.ino) throw new Error('Media file changed')
    return { handle, stat, real, mime }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** One byte range only. Null means no Range; false means unsatisfiable. */
function byteRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || !size || (!match[1] && !match[2])) return false
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return false
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : false
  if (first >= size || (last !== null && last < first)) return false
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

function tokenOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'hd-media:' && /^[a-f0-9]{48}$/.test(parsed.hostname) &&
      parsed.pathname === '/media' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port
      ? parsed.hostname : null
  } catch { return null }
}

/** Opaque, renderer-issued capabilities. Native browser partitions have no handler. */
function createMediaProtocol({ roots = allowedFsRoots } = {}) {
  const grants = new Map()
  const streams = new Set()
  const pending = new Set()
  function release(url, owner) {
    const token = tokenOf(url)
    const grant = grants.get(token)
    if (!grant || grant.owner !== owner) return
    grants.delete(token)
    for (const stream of grant.streams) stream.destroy()
  }
  function releaseOwner(owner) {
    for (const opening of pending) if (opening.owner === owner) opening.cancelled = true
    for (const [token, grant] of grants) {
      if (grant.owner === owner) release(`hd-media://${token}/media`, owner)
    }
  }
  return {
    async open(file, owner) {
      if (grants.size + pending.size >= MAX_GRANTS) throw new Error('Close another media player first')
      const opening = { owner, cancelled: false }
      pending.add(opening)
      try {
        const opened = await openMediaFile(file, roots())
        await opened.handle.close()
        if (opening.cancelled) throw new Error('Media player closed')
        const token = randomBytes(24).toString('hex')
        grants.set(token, { path: opened.real, owner, streams: new Set() })
        return `hd-media://${token}/media`
      } finally {
        pending.delete(opening)
      }
    },
    release,
    releaseOwner,
    clear() {
      for (const opening of pending) opening.cancelled = true
      for (const grant of [...grants.values()]) releaseOwner(grant.owner)
    },
    async response(request) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
      const token = tokenOf(request.url)
      const grant = grants.get(token)
      if (!grant) return new Response(null, { status: 404 })
      let handle
      try {
        const opened = await openMediaFile(grant.path, roots())
        handle = opened.handle
        if (grants.get(token) !== grant) {
          await handle.close()
          return new Response(null, { status: 404 })
        }
        const size = opened.stat.size
        const range = byteRange(request.headers.get('range'), size)
        const headers = {
          'Content-Type': opened.mime, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        }
        if (range === false) {
          await handle.close()
          return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
        }
        const start = range?.start ?? 0, end = range?.end ?? size - 1
        headers['Content-Length'] = String(Math.max(0, end - start + 1))
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
        if (request.method === 'HEAD' || !size) {
          await handle.close()
          return new Response(null, { status: range ? 206 : 200, headers })
        }
        if (streams.size >= MAX_STREAMS) {
          await handle.close()
          return new Response(null, { status: 503 })
        }
        const stream = handle.createReadStream({ start, end, highWaterMark: 64 * 1024, autoClose: true })
        streams.add(stream)
        grant.streams.add(stream)
        const abort = () => stream.destroy()
        request.signal?.addEventListener('abort', abort, { once: true })
        stream.once('close', () => {
          streams.delete(stream)
          grant.streams.delete(stream)
          request.signal?.removeEventListener('abort', abort)
        })
        if (request.signal?.aborted) stream.destroy()
        return new Response(Readable.toWeb(stream, {
          strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
        }), { status: range ? 206 : 200, headers })
      } catch {
        await handle?.close().catch(() => {})
        return new Response(null, { status: 404 })
      }
    },
  }
}

module.exports = { createMediaProtocol, byteRange }
