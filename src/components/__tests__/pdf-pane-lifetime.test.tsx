import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn(), render: vi.fn() }))
vi.mock('../../lib/files-source', async original => ({
  ...await original<typeof import('../../lib/files-source')>(), readDataUrl: fake.read,
}))
vi.mock('../../lib/preview/pdf', async original => ({
  ...await original<typeof import('../../lib/preview/pdf')>(), loadPdf: fake.load, renderPdfPage: fake.render,
}))
import { PdfPane } from '../FilePreview'

const document = () => ({ numPages: 2, loadingTask: { destroy: vi.fn().mockResolvedValue(undefined) } })
const pendingCleanup: (() => void)[] = []
function deferred<T>(value: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  pendingCleanup.push(() => resolve(value))
  return { promise, resolve }
}

beforeEach(() => {
  fake.read.mockReset().mockResolvedValue('data:application/pdf;base64,JVBERi0=')
  fake.load.mockReset()
  fake.render.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  cleanup()
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish() })
})

describe('PDF preview resource lifetime', () => {
  it('destroys the loaded document when its preview closes', async () => {
    const doc = document()
    fake.load.mockResolvedValue(doc)
    const view = render(<PdfPane filePath="/synthetic/a.pdf" />)
    await screen.findByText('Page 1 of 2')
    view.unmount()
    expect(doc.loadingTask.destroy).toHaveBeenCalledOnce()
  })

  it('destroys a document that finishes loading after dismissal', async () => {
    const doc = document(), pending = deferred(doc)
    fake.load.mockReturnValue(pending.promise)
    const view = render(<PdfPane filePath="/synthetic/a.pdf" />)
    await waitFor(() => expect(fake.load).toHaveBeenCalledOnce())
    const signal = fake.load.mock.calls[0]![1] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(doc))
    expect(doc.loadingTask.destroy).toHaveBeenCalledOnce()
  })

  it('does not start PDF parsing when file bytes arrive after dismissal', async () => {
    const pending = deferred('data:application/pdf;base64,JVBERi0=')
    fake.read.mockReturnValue(pending.promise)
    const view = render(<PdfPane filePath="/synthetic/a.pdf" />)
    await waitFor(() => expect(fake.read).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => pending.resolve('data:application/pdf;base64,JVBERi0='))
    expect(fake.load).not.toHaveBeenCalled()
  })

  it('releases the old document without destroying the next file document', async () => {
    const a = document(), b = document()
    fake.load.mockResolvedValueOnce(a).mockResolvedValueOnce(b)
    const view = render(<PdfPane filePath="/synthetic/a.pdf" />)
    await screen.findByText('Page 1 of 2')
    view.rerender(<PdfPane filePath="/synthetic/b.pdf" />)
    await waitFor(() => expect(fake.load).toHaveBeenCalledTimes(2))
    await screen.findByText('Page 1 of 2')
    expect(a.loadingTask.destroy).toHaveBeenCalledOnce()
    expect(b.loadingTask.destroy).not.toHaveBeenCalled()
    view.unmount()
    expect(b.loadingTask.destroy).toHaveBeenCalledOnce()
  })
})
