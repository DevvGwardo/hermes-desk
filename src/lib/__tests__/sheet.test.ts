import { describe, it, expect } from 'vitest'
import { loadSheet, parseDelimited, MAX_SHEET_BYTES } from '../preview/sheet'
import { sanitizeRichOutput } from '../preview/markdown-math'

describe('loadSheet hardening', () => {
  it('rejects oversized ArrayBuffer before parse', async () => {
    const oversized = new ArrayBuffer(MAX_SHEET_BYTES + 1)
    await expect(loadSheet(oversized)).rejects.toThrow(/too large/)
  })

  it('rejects oversized string', async () => {
    const oversized = 'x'.repeat(MAX_SHEET_BYTES + 1)
    await expect(loadSheet(oversized)).rejects.toThrow(/too large/)
  })

  it('rejects empty buffer', async () => {
    await expect(loadSheet(new ArrayBuffer(0))).rejects.toThrow(/Empty/)
  })

  it('loads a tiny csv string', async () => {
    const data = await loadSheet('a,b\n1,2\n3,4')
    expect(data.sheetNames.length).toBeGreaterThanOrEqual(1)
    expect(data.rows.length).toBeGreaterThan(0)
    expect(data.rows[0]).toEqual(['a', 'b'])
  })

  it('loads a tiny xlsx buffer (exceljs)', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.addRow(['h1', 'h2'])
    ws.addRow(['a', 'b'])
    const buf = await wb.xlsx.writeBuffer()
    const data = await loadSheet(buf as ArrayBuffer)
    expect(data.sheetNames).toContain('Sheet1')
    expect(data.rows[0]).toEqual(['h1', 'h2'])
  })
})

describe('parseDelimited (M2 CSV path)', () => {
  it('sniffs tab and semicolon delimiters', () => {
    expect(parseDelimited('a\tb\n1\t2')[0]).toEqual(['a', 'b'])
    expect(parseDelimited('a;b\n1;2')[0]).toEqual(['a', 'b'])
  })

  it('handles quoted fields with embedded delimiters, quotes and newlines', () => {
    const rows = parseDelimited('name,note\n"Smith, John","said ""hi"""\n"multi\nline",ok')
    expect(rows[1]).toEqual(['Smith, John', 'said "hi"'])
    expect(rows[2]).toEqual(['multi\nline', 'ok'])
  })

  it('drops fully-empty lines entirely', () => {
    const rows = parseDelimited('a,b\n\n1,2\n')
    expect(rows).toHaveLength(2)
    // All-empty rows are dropped even when they carry delimiters
    // (matches the old SheetJS blankrows:false behavior).
    const withEmptyCells = parseDelimited('a,b\n,\n1,2\n')
    expect(withEmptyCells).toHaveLength(2)
  })
})

describe('L4: sanitizeRichOutput (DOMPurify defense-in-depth)', () => {
  it('katex profile keeps katex markup (spans, classes, styles)', async () => {
    const { renderMathHtml } = await import('../preview/markdown-math')
    const html = await renderMathHtml('\\frac{a}{b}')
    // KaTeX emits spans with class + inline style — must survive sanitization.
    expect(html).toMatch(/class="[^"]*katex/)
    expect(html).toContain('<span')
  })

  it('strips scripts and event handlers even if a renderer regressed (L4)', async () => {
    const evilKatex =
      '<span class="katex">safe</span><script>window.__pwned=1</script><img src=x onerror="alert(1)">'
    const clean = await sanitizeRichOutput(evilKatex, 'katex')
    expect(clean).toContain('<span class="katex">safe</span>')
    expect(clean).not.toContain('<script')
    expect(clean).not.toMatch(/onerror/i)

    const evilSvg =
      '<svg onload="alert(1)"><circle r="1"/></svg><script>x</script><a href="javascript:alert(1)">x</a>'
    const cleanSvg = await sanitizeRichOutput(evilSvg, 'mermaid')
    expect(cleanSvg).not.toMatch(/onload/i)
    expect(cleanSvg).not.toContain('<script')
    expect(cleanSvg).not.toMatch(/javascript:/i)
  })

  it('keeps mermaid SVG structure intact through the SVG profile', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" id="mmd-x" class="mermaid"><g><rect class="node"/><text>hello</text></g></svg>'
    const out = await sanitizeRichOutput(svg, 'mermaid')
    expect(out).toContain('<svg')
    // jsdom serializes self-closing tags expanded — assert the element + class.
    expect(out).toMatch(/<rect class="node"/)
    expect(out).toContain('hello')
  })
})
