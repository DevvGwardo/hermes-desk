import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '/synthetic/pdf-worker.mjs' },
  getDocument: fake.getDocument,
}))
import { loadPdf } from '../preview/pdf'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => fake.getDocument.mockReset())

describe('PDF loading task ownership', () => {
  it('does not create a worker for an already-cancelled preview', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadPdf(new ArrayBuffer(0), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.getDocument).not.toHaveBeenCalled()
  })

  it('destroys a failed loading task even before a document exists', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    fake.getDocument.mockReturnValue({ promise: Promise.reject(new Error('Synthetic invalid PDF')), destroy })
    await expect(loadPdf(new ArrayBuffer(0))).rejects.toThrow('Synthetic invalid PDF')
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('destroys an in-flight loading task once on cancellation', async () => {
    const pending = deferred<unknown>(), destroy = vi.fn().mockResolvedValue(undefined)
    fake.getDocument.mockReturnValue({ promise: pending.promise, destroy })
    const controller = new AbortController()
    const load = loadPdf(new ArrayBuffer(0), controller.signal)
    await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalledOnce())
    const rejected = expect(load).rejects.toThrow('Synthetic aborted task')
    controller.abort()
    expect(destroy).toHaveBeenCalledOnce()
    pending.reject(new Error('Synthetic aborted task'))
    await rejected
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('rejects a document that resolves after cancellation', async () => {
    const pending = deferred<unknown>(), destroy = vi.fn().mockResolvedValue(undefined)
    fake.getDocument.mockReturnValue({ promise: pending.promise, destroy })
    const controller = new AbortController()
    const load = loadPdf(new ArrayBuffer(0), controller.signal)
    await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalledOnce())
    controller.abort()
    pending.resolve({ numPages: 1 })
    await expect(load).rejects.toMatchObject({ name: 'AbortError' })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('hands successful document cleanup to the preview owner', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined)
    const doc = { numPages: 1, loadingTask: { destroy } }
    fake.getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy })
    const controller = new AbortController()
    expect(await loadPdf(new ArrayBuffer(0), controller.signal)).toBe(doc)
    controller.abort()
    expect(destroy).not.toHaveBeenCalled()
  })
})
