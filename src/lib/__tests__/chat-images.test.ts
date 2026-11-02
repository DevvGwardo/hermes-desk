import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readDataUrl = vi.fn<(path: string) => Promise<string>>()
let filesAvailable = true
vi.mock('../files-source', () => ({
  readDataUrl: (p: string) => readDataUrl(p),
  isFilesAvailable: () => filesAvailable,
}))

import {
  acquireVmImage,
  dataUrlToObjectUrl,
  forgetVmImage,
  knownSize,
  peekVmImage,
  rememberSize,
  resetChatImagesForTests,
} from '../chat-images'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
// Held as a Blob URL (Node has URL.createObjectURL), never the base64 string.
const LOADED = { url: expect.stringMatching(/^blob:/) }

beforeEach(() => {
  filesAvailable = true
})

afterEach(() => {
  vi.useRealTimers()
  readDataUrl.mockReset()
  resetChatImagesForTests()
})

describe('chat image loader', () => {
  it('reads every local path through the guarded filesystem source', async () => {
    readDataUrl.mockResolvedValue(PNG)
    const a = acquireVmImage('/opt/data/workspace/a.png')
    const b = acquireVmImage('/Users/me/b.png')
    expect(await a.promise).toMatchObject(LOADED)
    expect(await b.promise).toMatchObject(LOADED)
    expect(readDataUrl).toHaveBeenCalledWith('/opt/data/workspace/a.png')
    expect(readDataUrl).toHaveBeenCalledWith('/Users/me/b.png')
  })

  it('shares one read between everything showing the same path', async () => {
    readDataUrl.mockResolvedValue(PNG)
    const a = acquireVmImage('/opt/data/x.png')
    const b = acquireVmImage('/opt/data/x.png')
    await Promise.all([a.promise, b.promise])
    expect(readDataUrl).toHaveBeenCalledTimes(1)
    expect(peekVmImage('/opt/data/x.png')?.url).toMatch(/^blob:/)
  })

  it('runs at most three reads at once', async () => {
    const resolvers: Array<(v: string) => void> = []
    readDataUrl.mockImplementation(() => new Promise((r) => resolvers.push(r)))
    const held = [1, 2, 3, 4, 5].map((n) => acquireVmImage(`/opt/data/${n}.png`))
    await Promise.resolve()
    expect(readDataUrl).toHaveBeenCalledTimes(3)
    resolvers[0]!(PNG)
    await held[0]!.promise
    expect(readDataUrl).toHaveBeenCalledTimes(4)
  })

  it('retries a failed read once, then forgets it so the next acquire reads again', async () => {
    vi.useFakeTimers()
    readDataUrl.mockResolvedValue('')
    const first = acquireVmImage('/opt/data/gone.png')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first.promise).toBeNull()
    expect(readDataUrl).toHaveBeenCalledTimes(2)

    readDataUrl.mockResolvedValue(PNG)
    const again = acquireVmImage('/opt/data/gone.png')
    expect(await again.promise).toMatchObject(LOADED)
  })

  it('does not retry when nothing can serve files (not linked)', async () => {
    filesAvailable = false
    readDataUrl.mockResolvedValue('')
    expect(await acquireVmImage('/opt/data/a.png').promise).toBeNull()
    expect(readDataUrl).toHaveBeenCalledTimes(1)
  })

  it('forget drops a loaded picture', async () => {
    readDataUrl.mockResolvedValue(PNG)
    await acquireVmImage('/opt/data/a.png').promise
    forgetVmImage('/opt/data/a.png')
    expect(peekVmImage('/opt/data/a.png')).toBeNull()
  })

  it('remembers sizes by key', () => {
    rememberSize('k', { width: 1280, height: 720 })
    rememberSize('bad', { width: 0, height: 10 })
    expect(knownSize('k')).toEqual({ width: 1280, height: 720 })
    expect(knownSize('bad')).toBeUndefined()
  })
})

describe('dataUrlToObjectUrl', () => {
  it('turns base64 into a Blob URL when the engine can', () => {
    const create = vi.fn<(b: Blob) => string>(() => 'blob:x')
    const orig = URL.createObjectURL
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL
    try {
      expect(dataUrlToObjectUrl(PNG)).toEqual({ url: 'blob:x', owned: true })
      const blob = create.mock.calls[0]![0]
      expect(blob.type).toBe('image/png')
      expect(blob.size).toBe(8)
    } finally {
      URL.createObjectURL = orig
    }
  })

  it('keeps anything else as it is', () => {
    expect(dataUrlToObjectUrl('data:image/svg+xml,<svg/>')).toEqual({ url: 'data:image/svg+xml,<svg/>', owned: false })
  })
})
