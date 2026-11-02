import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

describe('bounded main-process file reads', () => {
  it('reads text and bytes, including the exact size limit, and rejects a larger file', async () => {
    const { readFileBounded } = require('./fs-read.cjs')
    const root = await mkdtemp(path.join(os.tmpdir(), 'hd-fs-read-'))
    const file = path.join(root, 'fixture.txt')
    try {
      await writeFile(file, 'a'.repeat(16))
      expect(await readFileBounded(file, 'utf8', { maxBytes: 16 })).toBe('a'.repeat(16))
      expect(await readFileBounded(file, undefined, { maxBytes: 16 })).toEqual(Buffer.from('a'.repeat(16)))
      await writeFile(file, 'a'.repeat(17))
      await expect(readFileBounded(file, 'utf8', { maxBytes: 16 })).rejects.toThrow('too-large')
      await expect(readFileBounded(root)).rejects.toThrow('not-a-file')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('caps the actual bytes read even when the file grows after its stat, and always closes the handle', async () => {
    const { readFileBounded } = require('./fs-read.cjs')
    const close = vi.fn(async () => {})
    const read = vi.fn(async buffer => {
      buffer.fill(97)
      return { bytesRead: buffer.length }
    })
    const fs = { open: vi.fn(async () => ({
      stat: async () => ({ size: 1, isFile: () => true }), read, close,
    })) }
    await expect(readFileBounded('/obviously-fake-file', 'utf8', { fs, maxBytes: 16 })).rejects.toThrow('too-large')
    if (process.platform !== 'win32') expect(fs.open.mock.calls[0][1] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(read.mock.calls.reduce((total, [buffer]) => total + buffer.length, 0)).toBe(17)
    expect(close).toHaveBeenCalledOnce()
  })
})
