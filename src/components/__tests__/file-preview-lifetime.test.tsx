import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

const fake = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), stat: vi.fn(), download: vi.fn() }))
vi.mock('../../lib/files-source', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/files-source')>(),
  readText: fake.read, writeText: fake.write, statPath: fake.stat,
}))
vi.mock('../FileCard', async importOriginal => ({
  ...await importOriginal<typeof import('../FileCard')>(), downloadVmFile: fake.download,
}))

import FilePreview, { type FilePreviewGuard } from '../FilePreview'
import type { statPath } from '../../lib/files-source'

const a = '/synthetic/a.txt', b = '/synthetic/b.txt'
const pendingCleanup: (() => void)[] = []
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}
const button = (name: string) => screen.getByRole('button', { name })
const editor = (name = 'a.txt') => screen.getByLabelText(`Edit ${name}`) as HTMLTextAreaElement
async function edit(name = 'a.txt', value = 'Synthetic revised A') {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(editor(name), { target: { value } })
}
async function settle(work: () => void) {
  await act(async () => { work(); await Promise.resolve() })
}
function preview() {
  const onClose = vi.fn()
  const guardRef: { current: FilePreviewGuard | null } = { current: null }
  const view = render(<FilePreview open filePath={a} onClose={onClose} guardRef={guardRef} />)
  const show = (path: string | null, open = path !== null) =>
    view.rerender(<FilePreview open={open} filePath={path} onClose={onClose} guardRef={guardRef} />)
  return { ...view, show, onClose, guardRef }
}

beforeEach(() => {
  fake.read.mockReset().mockImplementation(async path => path === a ? 'Original A' : 'Original B')
  fake.write.mockReset().mockResolvedValue(undefined)
  fake.stat.mockReset().mockResolvedValue({ isDirectory: false, size: 10, mtimeMs: 0, gitStatus: null })
  fake.download.mockReset().mockResolvedValue(null)
})
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of pendingCleanup.splice(0)) finish() })
  vi.restoreAllMocks()
})

describe('FilePreview opening-owned operations', () => {
  it('previews extensionless regular files using filesystem metadata', async () => {
    fake.read.mockResolvedValueOnce('Synthetic extensionless contents')
    render(<FilePreview open filePath="/synthetic/AGENTS" onClose={vi.fn()} />)
    expect(await screen.findByText('Synthetic extensionless contents')).toBeInTheDocument()
    expect(fake.read).toHaveBeenCalledWith('/synthetic/AGENTS')
    expect(screen.queryByText(/That path is a folder/)).toBeNull()
  })

  it('rejects filesystem directories without attempting a text read', async () => {
    fake.stat.mockResolvedValue({ isDirectory: true, size: 10, mtimeMs: 0, gitStatus: null })
    render(<FilePreview open filePath="/synthetic/folder" onClose={vi.fn()} />)
    expect(await screen.findByText(/That path is a folder/)).toBeInTheDocument()
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('still attempts a text read when optional filesystem metadata is unavailable', async () => {
    fake.stat.mockRejectedValue(new Error('Synthetic metadata unavailable'))
    fake.read.mockResolvedValueOnce('Synthetic readable file')
    render(<FilePreview open filePath="/synthetic/config" onClose={vi.fn()} />)
    expect(await screen.findByText('Synthetic readable file')).toBeInTheDocument()
  })

  it('freezes the submitted draft and Diff while keeping Close available', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    preview(); await edit()
    fireEvent.click(button('Save'))
    expect(editor()).toHaveAttribute('readonly')
    expect(editor()).toHaveAttribute('aria-busy', 'true')
    fireEvent.change(editor(), { target: { value: 'Later unsaved input' } })
    expect(editor()).toHaveValue('Synthetic revised A')
    expect(button('Diff')).toBeDisabled()
    expect(button('Saving…')).toBeDisabled()
    expect(button('Close')).toBeEnabled()
  })

  it('sends one exact Save before busy state paints', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValue(save.promise)
    preview(); await edit()
    const target = button('Save')
    act(() => { fireEvent.click(target); fireEvent.click(target) })
    expect(fake.write).toHaveBeenCalledExactlyOnceWith(a, 'Synthetic revised A')
  })

  it('only reloads a confirmed Save from the current opening', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(b)
    await screen.findByText('Original B')
    await settle(() => save.resolve())
    expect(fake.read.mock.calls.map(([path]) => path)).toEqual([a, b])
    expect(screen.getByText('Original B')).toBeInTheDocument()
    expect(screen.queryByText('Original A')).toBeNull()
    await edit('b.txt', 'Synthetic B draft')
    fireEvent.click(button('Save'))
    await waitFor(() => expect(fake.write).toHaveBeenLastCalledWith(b, 'Synthetic B draft'))
  })

  it.each(['success', 'failure'] as const)('old Save %s cannot replace the next file draft or error', async outcome => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(b)
    await edit('b.txt', 'Synthetic B draft')
    await settle(() => outcome === 'success' ? save.resolve() : save.reject(new Error('fs write failed (403)')))
    expect(editor('b.txt')).toHaveValue('Synthetic B draft')
    expect(screen.queryByText(/Couldn't save your changes/)).toBeNull()
    expect(button('Save')).toBeEnabled()
    expect(fake.read.mock.calls.map(([path]) => path)).toEqual([a, b])
  })

  it('releases old busy state when opening another file', async () => {
    fake.write.mockReturnValueOnce(deferred<void>(undefined).promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(b)
    await edit('b.txt', 'Synthetic B draft')
    expect(button('Save')).toBeEnabled()
    expect(editor('b.txt')).not.toHaveAttribute('readonly')
    fireEvent.click(button('Save'))
    await waitFor(() => expect(fake.write).toHaveBeenLastCalledWith(b, 'Synthetic B draft'))
  })

  it.each(['success', 'failure'] as const)('old Save %s cannot release a newer pending Save', async outcome => {
    const oldSave = deferred<void>(undefined), newSave = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(b)
    await edit('b.txt', 'Synthetic B draft')
    expect(button('Save')).toBeEnabled()
    fireEvent.click(button('Save'))
    await settle(() => outcome === 'success' ? oldSave.resolve() : oldSave.reject(new Error('fs write failed (403)')))
    expect(button('Saving…')).toBeDisabled()
    expect(editor('b.txt')).toHaveValue('Synthetic B draft')
    expect(screen.queryByText(/Couldn't save your changes/)).toBeNull()
    await settle(() => newSave.reject(new Error('fs write failed (502)')))
    expect(await screen.findByText(/Couldn't save your changes/)).toHaveTextContent(/asleep or restarting/)
    expect(button('Save')).toBeEnabled()
  })

  it.each(['null', 'retained-path'] as const)('reopen starts clean after closing with %s', async closure => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(closure === 'null' ? null : a, false)
    expect(view.guardRef.current).toBeNull()
    view.show(a)
    await screen.findByText('Original A')
    await edit('a.txt', 'Fresh opening draft')
    expect(button('Save')).toBeEnabled()
    await settle(() => save.resolve())
    expect(editor()).toHaveValue('Fresh opening draft')
    expect(fake.read).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect a Save after A → B → A', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.show(b)
    await screen.findByText('Original B')
    view.show(a)
    await edit('a.txt', 'Fresh A draft')
    await settle(() => save.resolve())
    expect(editor()).toHaveValue('Fresh A draft')
    expect(fake.read).toHaveBeenCalledTimes(3)
  })

  it('does not issue a follow-up read after unmount', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    view.unmount()
    await settle(() => save.resolve())
    expect(fake.read).toHaveBeenCalledOnce()
    expect(view.guardRef.current).toBeNull()
  })

  it.each(['button', 'external-guard'] as const)('invalidates immediately after %s confirms leaving', async boundary => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    if (boundary === 'button') fireEvent.click(button('Close'))
    else {
      expect(view.guardRef.current?.confirmLeave()).toBe(true)
      view.show(null)
    }
    await settle(() => save.resolve())
    expect(fake.read).toHaveBeenCalledOnce()
    if (boundary === 'button') expect(view.onClose).toHaveBeenCalledOnce()
  })

  it('does not cancel a Save merely by checking the published leave guard', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(view.guardRef.current?.confirmLeave()).toBe(true)
    fake.read.mockResolvedValueOnce('Confirmed revised A')
    await settle(() => save.resolve())
    expect(await screen.findByText('Confirmed revised A')).toBeInTheDocument()
  })

  it('keeps a rejected close and current Save alive', async () => {
    const save = deferred<void>(undefined)
    fake.write.mockReturnValueOnce(save.promise)
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(button('Close'))
    expect(view.onClose).not.toHaveBeenCalled()
    fake.read.mockResolvedValueOnce('Confirmed revised A')
    await settle(() => save.resolve())
    expect(await screen.findByText('Confirmed revised A')).toBeInTheDocument()
    expect(fake.read).toHaveBeenCalledTimes(2)
  })

  it('preserves a failed current draft, unfreezes it and allows an exact retry', async () => {
    fake.write.mockRejectedValueOnce(new Error('fs write failed (403)')).mockResolvedValueOnce(undefined)
    preview(); await edit()
    fireEvent.click(button('Save'))
    expect(await screen.findByText(/Couldn't save your changes/)).toBeInTheDocument()
    expect(editor()).toHaveValue('Synthetic revised A')
    expect(editor()).not.toHaveAttribute('readonly')
    expect(button('Diff')).toBeEnabled()
    expect(fake.read).toHaveBeenCalledOnce()
    fireEvent.change(editor(), { target: { value: 'Synthetic retry' } })
    fake.read.mockResolvedValueOnce('Synthetic retry')
    fireEvent.click(button('Save'))
    await waitFor(() => {
      expect(screen.queryByLabelText('Edit a.txt')).toBeNull()
      expect(screen.getByText('Synthetic retry')).toBeInTheDocument()
    })
    expect(fake.write).toHaveBeenLastCalledWith(a, 'Synthetic retry')
  })

  it('ignores the saved file read-back when another file opens', async () => {
    const readBack = deferred<string>('Saved A')
    fake.read.mockResolvedValueOnce('Original A').mockReturnValueOnce(readBack.promise).mockResolvedValueOnce('Original B')
    const view = preview(); await edit()
    fireEvent.click(button('Save'))
    await waitFor(() => expect(fake.read).toHaveBeenCalledTimes(2))
    view.show(b)
    await screen.findByText('Original B')
    await edit('b.txt', 'Synthetic B draft')
    await settle(() => readBack.resolve('Saved A'))
    expect(editor('b.txt')).toHaveValue('Synthetic B draft')
    expect(button('Save')).toBeEnabled()
  })

  it('does not render a read that completes while closed with its path retained', async () => {
    const read = deferred<string>('Late A')
    fake.read.mockReturnValueOnce(read.promise)
    const view = preview()
    view.show(a, false)
    await settle(() => read.resolve('Late A'))
    view.show(a)
    await screen.findByText('Original A')
    expect(screen.queryByText('Late A')).toBeNull()
    expect(fake.read).toHaveBeenCalledTimes(2)
  })

  it('does not carry a late git badge into a reopened file', async () => {
    const stat = deferred<Awaited<ReturnType<typeof statPath>>>({
      isDirectory: false, size: 10, mtimeMs: 0, gitStatus: null,
    })
    fake.stat.mockReturnValueOnce(stat.promise)
    const view = preview()
    await screen.findByText('Original A')
    view.show(null)
    view.show(a)
    await screen.findByText('Original A')
    await settle(() => stat.resolve({
      isDirectory: false, size: 10, mtimeMs: 0, gitStatus: { kind: 'modified', branch: null },
    }))
    expect(screen.queryByTitle('git modified')).toBeNull()
  })

  it('does not carry a download failure into another opening', async () => {
    const download = deferred<string | null>(null)
    fake.download.mockReturnValueOnce(download.promise)
    const view = preview()
    await screen.findByText('Original A')
    fireEvent.click(button('Download'))
    view.show(b)
    await screen.findByText('Original B')
    await settle(() => download.resolve('Synthetic download failed'))
    expect(button('Download')).not.toHaveAttribute('title', 'Synthetic download failed')
    expect(screen.queryByRole('button', { name: 'Retry download' })).toBeNull()
  })

  it('keeps the newest download error when an earlier download finishes last', async () => {
    const old = deferred<string | null>(null), latest = deferred<string | null>(null)
    fake.download.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    preview()
    await screen.findByText('Original A')
    fireEvent.click(button('Download')); fireEvent.click(button('Download'))
    await settle(() => latest.resolve('Synthetic latest failure'))
    expect(button('Retry download')).toHaveAttribute('title', 'Synthetic latest failure')
    await settle(() => old.resolve('Synthetic obsolete failure'))
    expect(button('Retry download')).toHaveAttribute('title', 'Synthetic latest failure')
  })

  it('contains a rejected download and allows a successful retry', async () => {
    fake.download.mockRejectedValueOnce(new Error('fs read failed (403)')).mockResolvedValueOnce(null)
    preview()
    await screen.findByText('Original A')
    fireEvent.click(button('Download'))
    await waitFor(() => expect(button('Retry download')).toHaveAttribute('title', expect.stringMatching(/access/)))
    fireEvent.click(button('Retry download'))
    await waitFor(() => expect(button('Download')).toHaveAttribute('title', 'Download a.txt'))
    expect(fake.download).toHaveBeenNthCalledWith(2, a)
  })
})
