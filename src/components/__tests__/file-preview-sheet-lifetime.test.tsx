import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { SheetData } from '../../lib/preview/sheet'

const fake = vi.hoisted(() => ({
  stat: vi.fn(), readText: vi.fn(), readDataUrl: vi.fn(), loadSheet: vi.fn(),
}))
vi.mock('../../lib/files-source', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/files-source')>(),
  statPath: fake.stat, readText: fake.readText, readDataUrl: fake.readDataUrl,
}))
vi.mock('../../lib/preview/sheet', () => ({ loadSheet: fake.loadSheet, MAX_SHEET_BYTES: 12 * 1024 * 1024 }))

import { SheetPane } from '../FilePreview'

const metadata = { isDirectory: false, size: 10, mtimeMs: 0, gitStatus: null }
const data = (text: string): SheetData => ({ sheetNames: ['Sheet1'], active: 'Sheet1', rows: [[text]] })
const pending: (() => void)[] = []
function deferred<T>(value: T) {
  let resolve!: (result: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pending.push(() => resolve(value))
  return { promise, resolve, reject }
}
async function settle(work: () => void = () => {}) {
  await act(async () => { work(); await vi.dynamicImportSettled() })
}

beforeEach(() => {
  fake.stat.mockReset().mockResolvedValue(metadata)
  fake.readText.mockReset().mockResolvedValue('Synthetic CSV contents')
  fake.readDataUrl.mockReset().mockResolvedValue('data:application/octet-stream;base64,AAEC')
  fake.loadSheet.mockReset().mockImplementation(async (input: string | ArrayBuffer) =>
    data(typeof input === 'string' ? input : 'Synthetic workbook'))
})
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of pending.splice(0)) finish() })
  vi.restoreAllMocks()
})

describe('spreadsheet preview lifetime', () => {
  it('does not start filesystem work if closed before the lazy module settles', async () => {
    const view = render(<SheetPane filePath="/synthetic/closed.csv" />)
    view.unmount()
    await settle()
    expect(fake.stat).not.toHaveBeenCalled()
    expect(fake.readText).not.toHaveBeenCalled()
    expect(fake.readDataUrl).not.toHaveBeenCalled()
    expect(fake.loadSheet).not.toHaveBeenCalled()
  })

  it.each([
    ['csv', 'success'], ['csv', 'failure'], ['xlsx', 'success'], ['xlsx', 'failure'],
  ])('does not read %s after a dismissed metadata %s', async (extension, outcome) => {
    const stat = deferred(metadata)
    fake.stat.mockReturnValueOnce(stat.promise)
    const view = render(<SheetPane filePath={`/synthetic/closed.${extension}`} />)
    await waitFor(() => expect(fake.stat).toHaveBeenCalledOnce())
    view.unmount()
    await settle(() => outcome === 'success' ? stat.resolve(metadata)
      : stat.reject(new Error('Synthetic metadata unavailable')))
    expect(fake.readText).not.toHaveBeenCalled()
    expect(fake.readDataUrl).not.toHaveBeenCalled()
    expect(fake.loadSheet).not.toHaveBeenCalled()
  })

  it.each(['csv', 'xlsx'])('does not parse %s bytes returned after close', async extension => {
    const text = deferred('Synthetic obsolete CSV')
    const bytes = deferred('data:application/octet-stream;base64,AAEC')
    fake.readText.mockReturnValueOnce(text.promise)
    fake.readDataUrl.mockReturnValueOnce(bytes.promise)
    const view = render(<SheetPane filePath={`/synthetic/closed.${extension}`} />)
    await waitFor(() => expect(extension === 'csv' ? fake.readText : fake.readDataUrl).toHaveBeenCalledOnce())
    view.unmount()
    await settle(() => {
      text.resolve('Synthetic obsolete CSV')
      bytes.resolve('data:application/octet-stream;base64,AAEC')
    })
    expect(fake.loadSheet).not.toHaveBeenCalled()
  })

  it('only reads and parses the current file after a switch with old metadata pending', async () => {
    const oldStat = deferred(metadata)
    fake.stat.mockReturnValueOnce(oldStat.promise)
    fake.readText.mockImplementation(async path => path === '/synthetic/b.csv' ? 'Synthetic current B' : 'Synthetic obsolete A')
    const view = render(<SheetPane filePath="/synthetic/a.csv" />)
    await waitFor(() => expect(fake.stat).toHaveBeenCalledOnce())
    view.rerender(<SheetPane filePath="/synthetic/b.csv" />)
    await screen.findByText('Synthetic current B')
    await settle(() => oldStat.resolve(metadata))
    expect(fake.readText).toHaveBeenCalledExactlyOnceWith('/synthetic/b.csv')
    expect(fake.loadSheet).toHaveBeenCalledExactlyOnceWith('Synthetic current B', undefined)
    expect(screen.queryByText('Synthetic obsolete A')).toBeNull()
  })

  it('does not replace the current sheet when an already-started parse finishes late', async () => {
    const oldParse = deferred(data('Synthetic obsolete A'))
    fake.loadSheet.mockReturnValueOnce(oldParse.promise).mockResolvedValueOnce(data('Synthetic current B'))
    const view = render(<SheetPane filePath="/synthetic/a.csv" />)
    await waitFor(() => expect(fake.loadSheet).toHaveBeenCalledOnce())
    view.rerender(<SheetPane filePath="/synthetic/b.csv" />)
    await screen.findByText('Synthetic current B')
    await settle(() => oldParse.resolve(data('Synthetic obsolete A')))
    expect(screen.getByText('Synthetic current B')).toBeInTheDocument()
    expect(screen.queryByText('Synthetic obsolete A')).toBeNull()
  })

  it('still previews an active file if optional metadata is unavailable', async () => {
    fake.stat.mockRejectedValueOnce(new Error('Synthetic metadata unavailable'))
    render(<SheetPane filePath="/synthetic/live.csv" />)
    expect(await screen.findByText('Synthetic CSV contents')).toBeInTheDocument()
    expect(fake.readText).toHaveBeenCalledExactlyOnceWith('/synthetic/live.csv')
    expect(fake.loadSheet).toHaveBeenCalledOnce()
  })
})
