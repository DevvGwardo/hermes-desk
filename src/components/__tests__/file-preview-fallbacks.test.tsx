/**
 * Preview panes that used to break: a spreadsheet's chosen tab carrying over
 * to the next file, and a formula that failed to render stuck on Loading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { loadSheet, renderMathHtml } = vi.hoisted(() => ({ loadSheet: vi.fn(), renderMathHtml: vi.fn() }))
vi.mock('../../lib/files-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/files-source')>()),
  readText: async () => 'a,b\n1,2',
  statPath: async () => ({ size: 10 }),
}))
vi.mock('../../lib/preview/sheet', () => ({ loadSheet, MAX_SHEET_BYTES: 1_000_000 }))
vi.mock('../../lib/preview/markdown-math', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/preview/markdown-math')>()),
  renderMathHtml,
}))

import { FilePanel } from '../FilePanel'
import { RichDocView } from '../FilePreview'

afterEach(() => {
  cleanup()
  loadSheet.mockReset()
  renderMathHtml.mockReset()
})

describe('file preview fallbacks', () => {
  it('a new spreadsheet opens on its own first sheet, not the last one picked', async () => {
    loadSheet.mockImplementation(async (_payload: unknown, active?: string) => ({
      sheetNames: ['Summary', 'Raw'],
      active: active ?? 'Summary',
      rows: [['a', 'b']],
    }))
    const { rerender } = render(<FilePanel filePath="/opt/data/workspace/q3.csv" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Raw' }))
    await waitFor(() => expect(loadSheet).toHaveBeenLastCalledWith(expect.anything(), 'Raw'))
    rerender(<FilePanel filePath="/opt/data/workspace/q4.csv" onClose={() => {}} />)
    await waitFor(() => expect(loadSheet).toHaveBeenLastCalledWith(expect.anything(), undefined))
  })

  it('shows a formula as written when it cannot be drawn', async () => {
    renderMathHtml.mockRejectedValue(new Error('katex failed'))
    render(<RichDocView ext="tex" content={'E = mc^2'} />)
    expect(await screen.findByText('E = mc^2')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})
