import { beforeEach, describe, expect, it, vi } from 'vitest'

const listDir = vi.fn()
vi.mock('../files-source', () => ({ listDir: (dir: string) => listDir(dir) }))
vi.mock('../fs', () => ({ isBridgeAvailable: () => false, statPath: vi.fn() }))

import { clearFileSizeCache, fileSize } from '../file-size'

beforeEach(() => {
  clearFileSizeCache()
  listDir.mockReset()
})

describe('fileSize (browser)', () => {
  it('lists the folder once for every card in it', async () => {
    listDir.mockResolvedValue([
      { name: 'a.md', path: '/opt/data/workspace/a.md', isDirectory: false, size: 1200 },
      { name: 'b.py', path: '/opt/data/workspace/b.py', isDirectory: false, size: 40 },
    ])
    const [a, b] = await Promise.all([fileSize('/opt/data/workspace/a.md', 0), fileSize('/opt/data/workspace/b.py', 0)])
    expect([a, b]).toEqual([1200, 40])
    expect(listDir).toHaveBeenCalledTimes(1)
    expect(listDir).toHaveBeenCalledWith('/opt/data/workspace')
  })

  it('asks again after a minute', async () => {
    listDir.mockResolvedValue([])
    await fileSize('/opt/data/workspace/a.md', 0)
    await fileSize('/opt/data/workspace/a.md', 59_000)
    await fileSize('/opt/data/workspace/a.md', 61_000)
    expect(listDir).toHaveBeenCalledTimes(2)
  })

  it('is null when the file is gone, has no size, or the listing fails', async () => {
    listDir.mockResolvedValueOnce([{ name: 'a.md', path: '/x', isDirectory: false }])
    expect(await fileSize('/opt/data/workspace/a.md', 0)).toBeNull()
    listDir.mockRejectedValueOnce(new Error('offline'))
    expect(await fileSize('/opt/data/workspace/reports/b.md', 0)).toBeNull()
    listDir.mockResolvedValueOnce([])
    expect(await fileSize('/opt/data/workspace/notes/c.md', 0)).toBeNull()
  })
})
