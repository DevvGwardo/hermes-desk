import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import FilesPanel from '../FilesPanel'
import type { FsBridgeResult } from '../../lib/fs'

const root = '/tmp/synthetic-files-root'
const otherRoot = '/tmp/synthetic-other-root'
const finishes: (() => void)[] = []
function deferred() {
  let resolve!: (value: FsBridgeResult) => void, reject!: (reason: unknown) => void
  const promise = new Promise<FsBridgeResult>((yes, no) => { resolve = yes; reject = no })
  finishes.push(() => resolve({ ok: false, error: 'Synthetic abandoned read' }))
  return { promise, resolve, reject }
}
const folder = (dir: string) => ({ ok: true, data: { entries: [
  { path: `${dir}/synthetic-note.txt`, name: 'synthetic-note.txt', isDirectory: false },
] } })
async function settle(work = () => {}) {
  await act(async () => { work(); await Promise.resolve() })
}
function fixture() {
  const bridge = vi.fn<(kind: string, args: string[]) => Promise<FsBridgeResult>>()
    .mockImplementation(async (_kind, args) => args[0] === 'defaultRoot'
      ? { ok: true, data: root } : args[0] === 'list' ? folder(args[1]!) : { ok: false, error: 'Unexpected synthetic operation' })
  window.nubAgent = { hermes: bridge } as unknown as Window['nubAgent']
  const props = { open: true, onClose: vi.fn(), onOpenFile: vi.fn() }
  return { bridge, props, mount: () => render(<FilesPanel {...props} />) }
}
async function expire() {
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
}
beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear() })
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of finishes.splice(0)) finish() })
  vi.useRealTimers()
  delete window.nubAgent
  vi.restoreAllMocks()
})

describe('FilesPanel default-root deadline and ownership', () => {
  it('opens a native-selected media preview without reading or uploading its bytes', async () => {
    const test = fixture()
    const selected = '/tmp/synthetic-import/clip.mp4'
    window.nubAgent!.localFiles = { pickMedia: vi.fn(async () => selected), saveAs: vi.fn(), releaseImport: vi.fn() }
    test.mount(); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Open local media' })); await settle()
    expect(test.props.onOpenFile).toHaveBeenCalledWith(selected)
    expect(test.bridge.mock.calls.every(([, args]) => ['defaultRoot', 'list'].includes(args[0]!))).toBe(true)
  })

  it('releases a late native selection after the panel changes workspace', async () => {
    const test = fixture()
    let resolve!: (value: string) => void
    const picked = new Promise<string>(yes => { resolve = yes })
    const releaseImport = vi.fn(async () => {})
    window.nubAgent!.localFiles = { pickMedia: vi.fn(() => picked), saveAs: vi.fn(), releaseImport }
    const view = test.mount(); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Open local media' }))
    view.rerender(<FilesPanel {...test.props} cwd={otherRoot} />)
    await settle(() => resolve('/tmp/synthetic-import/late.mp4'))
    expect(test.props.onOpenFile).not.toHaveBeenCalled()
    expect(releaseImport).toHaveBeenCalledWith('/tmp/synthetic-import/late.mp4')
    expect(screen.getByRole('button', { name: 'Open local media' })).toBeEnabled()
  })
  it('shows a retry instead of loading forever when the default root never answers', async () => {
    const test = fixture(), held = deferred()
    test.bridge.mockReturnValueOnce(held.promise)
    test.mount(); await settle()
    expect(screen.getByRole('list', { name: 'Loading files' })).toBeVisible()
    await expire()
    expect(screen.getByText("Couldn't load your files")).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.queryByRole('list', { name: 'Loading files' })).toBeNull()
    expect(test.bridge).toHaveBeenCalledOnce()
  })

  it('retries a timed-out root and never lists a late result from the earlier lookup', async () => {
    const test = fixture(), old = deferred()
    test.bridge.mockReturnValueOnce(old.promise)
    test.mount(); await settle(); await expire()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await settle()
    expect(screen.getByText('Synthetic note')).toBeVisible()
    expect(test.bridge).toHaveBeenCalledWith('fs', ['list', root])
    await settle(() => old.resolve({ ok: true, data: otherRoot }))
    expect(test.bridge).not.toHaveBeenCalledWith('fs', ['list', otherRoot])
    expect(screen.getByText('Synthetic note')).toBeVisible()
  })

  it.each(['success', 'failure'] as const)('keeps the root timeout retry when its abandoned lookup finishes with %s', async outcome => {
    const test = fixture(), held = deferred()
    test.bridge.mockReturnValueOnce(held.promise)
    test.mount(); await settle(); await expire()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    await settle(() => outcome === 'success' ? held.resolve({ ok: true, data: root }) : held.reject(new Error('Synthetic late root failure')))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(test.bridge).toHaveBeenCalledOnce()
    expect(screen.queryByText('Synthetic note')).toBeNull()
  })

  it.each(['close', 'workspace'] as const)('does not start a listing after a pending root loses ownership on %s', async kind => {
    const test = fixture(), held = deferred()
    test.bridge.mockReturnValueOnce(held.promise)
    const view = test.mount(); await settle()
    view.rerender(<FilesPanel {...test.props} open={kind !== 'close'} cwd={kind === 'workspace' ? otherRoot : undefined} />)
    await settle(() => held.resolve({ ok: true, data: root }))
    expect(test.bridge).not.toHaveBeenCalledWith('fs', ['list', root])
    if (kind === 'workspace') {
      expect(test.bridge).toHaveBeenCalledWith('fs', ['list', otherRoot])
      expect(screen.getByText('Synthetic note')).toBeVisible()
    } else expect(screen.queryByText('Synthetic note')).toBeNull()
  })

  it('still rejects an invalid root and allows a successful supported retry', async () => {
    const test = fixture()
    test.bridge.mockResolvedValueOnce({ ok: true, data: '/' })
    test.mount(); await settle()
    expect(screen.getByText("Couldn't load your files")).toBeVisible()
    expect(test.bridge).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await settle()
    expect(screen.getByText('Synthetic note')).toBeVisible()
    expect(test.bridge).toHaveBeenCalledWith('fs', ['list', root])
    expect(vi.getTimerCount()).toBe(0)
  })
})
