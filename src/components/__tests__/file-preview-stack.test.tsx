import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FilePreview from '../FilePreview'

/**
 * Drives the REAL FilePreview component against a stubbed fs bridge. Only the
 * heavy renderer entry points are partially mocked (mermaid's DOM layout and
 * pdfjs's worker/canvas don't exist in jsdom); sheet parsing uses the real
 * SheetJS module and katex renders for real.
 */

vi.mock('../../lib/preview/markdown-math', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/preview/markdown-math')>()
  return {
    ...actual,
    renderMermaidSvg: vi.fn(async (code: string) => `<svg data-code="${code.length}"></svg>`),
  }
})

// Like pdf.js: a page renders from the loaded document (its getPage), and a
// second render on the same canvas while one is in flight is refused.
const pdfRenders = vi.hoisted(() => ({ pages: [] as number[], active: 0, overlapped: false }))
vi.mock('../../lib/preview/pdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/preview/pdf')>()
  return {
    ...actual,
    loadPdf: vi.fn(async () => ({ numPages: 3, getPage: async (n: number) => ({ n }), loadingTask: { destroy: vi.fn(async () => {}) } })),
    renderPdfPage: vi.fn(async (doc: { getPage?: (n: number) => Promise<unknown> }, n: number) => {
      if (typeof doc.getPage !== 'function') throw new Error('not a PDF document')
      pdfRenders.active++
      if (pdfRenders.active > 1) pdfRenders.overlapped = true
      await doc.getPage(n)
      await new Promise((r) => setTimeout(r, 5))
      pdfRenders.active--
      pdfRenders.pages.push(n)
    }),
  }
})

import { renderMermaidSvg } from '../../lib/preview/markdown-math'
import { loadPdf } from '../../lib/preview/pdf'

const FILES: Record<string, { text?: string; dataUrl?: string }> = {}

function stubBridge(): void {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    hermes: (_kind: string, args: string[]) => {
      const verb = args[0]
      const path = args[1] ?? ''
      if (verb === 'read-text') {
        const f = FILES[path]
        if (!f || f.text === undefined) return Promise.resolve({ ok: false, error: 'ENOENT' })
        return Promise.resolve({ ok: true, data: { content: f.text } })
      }
      if (verb === 'read-data-url') {
        const f = FILES[path]
        if (!f || f.dataUrl === undefined) return Promise.resolve({ ok: false, error: 'ENOENT' })
        return Promise.resolve({ ok: true, data: f.dataUrl })
      }
      if (verb === 'stat') {
        return Promise.resolve({ ok: true, data: { isDirectory: false, size: 10, mtimeMs: 0 } })
      }
      return Promise.resolve({ ok: false, error: `unsupported verb ${verb}` })
    },
  }
}

beforeEach(() => {
  cleanup()
  stubBridge()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

describe('FilePreview stack (A3)', () => {
  it('renders a mermaid fence in .md as an SVG block', async () => {
    FILES['/proj/diagram.md'] = {
      text: '# Plan\n\n```mermaid\ngraph TD; A-->B;\n```\n\ndone.\n',
    }
    render(<FilePreview open filePath="/proj/diagram.md" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-render')).toBeTruthy()
    })
    expect(renderMermaidSvg).toHaveBeenCalledWith('graph TD; A-->B;')
    expect(screen.getByText('done.')).toBeTruthy()
  })

  it('renders $$math$$ in .md through real katex', async () => {
    FILES['/proj/notes.md'] = {
      text: 'Euler: $$e^{i\\pi} + 1 = 0$$\n',
    }
    render(<FilePreview open filePath="/proj/notes.md" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByTestId('katex-render')).toBeTruthy()
    })
    const el = screen.getByTestId('katex-render')
    expect(el.querySelector('.katex')).not.toBeNull()
  })

  it('previews a .pdf with page navigation, one page render at a time', async () => {
    FILES['/proj/report.pdf'] = {
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=',
    }
    pdfRenders.pages = []
    pdfRenders.overlapped = false
    render(<FilePreview open filePath="/proj/report.pdf" onClose={() => {}} />)
    await waitFor(() => {
      expect(loadPdf).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 3/)).toBeTruthy()
    })
    // The page is drawn from the real document, not a page count.
    await waitFor(() => expect(pdfRenders.pages).toContain(1))
    // A fast double-click on Next: renders queue, they never overlap.
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }))
    await waitFor(() => expect(screen.getByText(/Page 3 of 3/)).toBeTruthy())
    await waitFor(() => expect(pdfRenders.pages.at(-1)).toBe(3))
    expect(pdfRenders.overlapped).toBe(false)
    expect(screen.queryByText(/Can.t show this PDF/)).toBeNull()
  })

  it('previews a real .xlsx workbook with sheet tabs via the real sheet module', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const stock = wb.addWorksheet('Stock')
    stock.addRow(['item', 'qty'])
    stock.addRow(['nubs', 3])
    const meta = wb.addWorksheet('Meta')
    meta.addRow(['c'])
    const bytes = await wb.xlsx.writeBuffer()
    let bin = ''
    const view = new Uint8Array(bytes as ArrayBuffer)
    for (let i = 0; i < view.length; i += 1) bin += String.fromCharCode(view[i]!)
    FILES['/proj/inventory.xlsx'] = {
      dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${btoa(bin)}`,
    }
    render(<FilePreview open filePath="/proj/inventory.xlsx" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('nubs')).toBeTruthy()
    })
    // First sheet active; second sheet reachable via its tab.
    expect(screen.getByRole('button', { name: 'Stock' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Meta' }))
    await waitFor(() => {
      expect(screen.getByText('c')).toBeTruthy()
    })
  })

  it('previews a .csv through the same table path', async () => {
    FILES['/proj/expenses.csv'] = { text: 'month,total\naug,42\n' }
    render(<FilePreview open filePath="/proj/expenses.csv" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('aug')).toBeTruthy()
    })
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('says it cannot show the file, with a download, when binary bytes cannot be read', async () => {
    // No file registered → read-data-url fails inside the pane's load chain.
    render(<FilePreview open filePath="/proj/broken.xlsx" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText("Can't show this spreadsheet here")).toBeTruthy()
    })
    expect(screen.getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0)
  })

  it('keeps the code fallback for unknown text files', async () => {
    FILES['/proj/blob.xyz'] = { text: 'plain line one\nplain line two\n' }
    render(<FilePreview open filePath="/proj/blob.xyz" onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('plain line two')).toBeTruthy()
    })
    expect(screen.queryByText(/Can't show this/)).toBeNull()
  })

  it('keeps the editor and draft when a save fails, instead of swapping in an error card', async () => {
    FILES['/proj/notes.md'] = { text: 'original\n' }
    render(<FilePreview open filePath="/proj/notes.md" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.md'), { target: { value: 'my precious edits\n' } })
    // Make the write fail (bridge refuses the verb).
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Couldn't save your changes/)).toBeTruthy()
    // Draft survives and the editor is still on screen.
    expect((screen.getByLabelText('Edit notes.md') as HTMLTextAreaElement).value).toBe('my precious edits\n')
    expect(screen.queryByText('original')).toBeNull()
  })

  it('exposes a guard the app checks before Escape / Back drop unsaved edits', async () => {
    FILES['/proj/notes.md'] = { text: 'original\n' }
    const guardRef: { current: import('../FilePreview').FilePreviewGuard | null } = { current: null }
    render(<FilePreview open filePath="/proj/notes.md" onClose={() => {}} guardRef={guardRef} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    // Nothing edited: leaving is fine, no prompt.
    expect(guardRef.current?.confirmLeave()).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.md'), { target: { value: 'changed\n' } })
    expect(guardRef.current?.confirmLeave()).toBe(false)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    confirmSpy.mockReturnValue(true)
    expect(guardRef.current?.confirmLeave()).toBe(true)
    confirmSpy.mockRestore()
  })

  it('drops the guard once closed, so discarded edits never ask again', async () => {
    FILES['/proj/notes.md'] = { text: 'original\n' }
    const guardRef: { current: import('../FilePreview').FilePreviewGuard | null } = { current: null }
    const { rerender } = render(<FilePreview open filePath="/proj/notes.md" onClose={() => {}} guardRef={guardRef} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.md'), { target: { value: 'changed\n' } })
    expect(guardRef.current).not.toBeNull()
    // The app closes it (user said Discard): the next Back / link must not ask.
    rerender(<FilePreview open={false} filePath={null} onClose={() => {}} guardRef={guardRef} />)
    expect(guardRef.current).toBeNull()
  })

  it('a slow read for the previous file never lands in the next one', async () => {
    FILES['/proj/slow-a.md'] = { text: 'contents of a\n' }
    FILES['/proj/fast-b.md'] = { text: 'contents of b\n' }
    const bridge = (window as unknown as { nubAgent: { hermes: (k: string, a: string[]) => Promise<unknown> } }).nubAgent
    const real = bridge.hermes
    let releaseA!: () => void
    const aHeld = new Promise<void>((r) => { releaseA = r })
    bridge.hermes = async (kind, args) => {
      if (args[0] === 'read-text' && args[1] === '/proj/slow-a.md') await aHeld
      return real(kind, args)
    }
    const { rerender } = render(<FilePreview open filePath="/proj/slow-a.md" onClose={() => {}} />)
    rerender(<FilePreview open filePath="/proj/fast-b.md" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/contents of b/)).toBeTruthy())
    // A's read answers last.
    await act(async () => {
      releaseA()
      await aHeld
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByText(/contents of a/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((screen.getByLabelText('Edit fast-b.md') as HTMLTextAreaElement).value).toBe('contents of b\n')
  })

  it('never offers Edit over a file that failed to load, or carries the last file\'s text into it', async () => {
    FILES['/proj/a.md'] = { text: 'contents of a\n' }
    const { rerender } = render(<FilePreview open filePath="/proj/a.md" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // b.log is not readable (bridge answers ENOENT).
    rerender(<FilePreview open filePath="/proj/b.log" onClose={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByLabelText('Edit b.log')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByText(/contents of a/)).toBeNull()
  })

  it('asks before discarding unsaved edits on close', async () => {
    FILES['/proj/notes.md'] = { text: 'original\n' }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onClose = vi.fn()
    render(<FilePreview open filePath="/proj/notes.md" onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit notes.md'), { target: { value: 'changed\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('closing an image preview does not crash (open → closed → open again)', async () => {
    const { rerender } = render(<FilePreview open filePath="/opt/data/workspace/out/cat.png" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    // Closing renders nothing — the hook order must not change (this crashed the page).
    rerender(<FilePreview open={false} filePath={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    rerender(<FilePreview open filePath="/opt/data/workspace/out/cat.png" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })
})

