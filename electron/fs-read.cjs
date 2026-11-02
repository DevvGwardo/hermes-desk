'use strict'

const { promises: fs, constants } = require('node:fs')

const MAX_FILE_READ_BYTES = 10 * 1024 * 1024

/**
 * Read at most the limit plus one byte, even if the opened file grows.
 * @param {string} file
 * @param {BufferEncoding} [encoding]
 * @param {{fs?: Pick<typeof fs, 'open'>, maxBytes?: number}} [options]
 */
async function readFileBounded(file, encoding, options = {}) {
  const { fs: io = fs, maxBytes = MAX_FILE_READ_BYTES } = options
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0)
  const nonBlocking = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK || 0)
  const handle = await io.open(file, constants.O_RDONLY | noFollow | nonBlocking)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('not-a-file')
    if (stat.size > maxBytes) throw new Error('too-large')
    const chunks = []
    let size = 0
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > maxBytes) throw new Error('too-large')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const data = Buffer.concat(chunks, size)
    return encoding ? data.toString(encoding) : data
  } finally {
    await handle.close()
  }
}

module.exports = { readFileBounded, MAX_FILE_READ_BYTES }
