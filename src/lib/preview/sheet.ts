/**
 * Spreadsheet loader for FilePreview (A3) — lazily imported.
 * Handles .xlsx (binary bytes, via exceljs) and .csv/.tsv (text, via a small
 * RFC-4180-style parser) through one shape.
 *
 * M2 (red team): replaces SheetJS xlsx 0.18.5 (prototype pollution + ReDoS
 * advisories during parse). exceljs is actively maintained; CSV never needed
 * the heavyweight parser at all.
 */

export interface SheetData {
  sheetNames: string[]
  /** The sheet the rows come from (first sheet unless requested). */
  active: string
  /** Grid of cell strings; row 0 is typically the header. */
  rows: string[][]
}

export const MAX_SHEET_BYTES = 12 * 1024 * 1024

export async function loadSheet(
  input: ArrayBuffer | string,
  sheetName?: string,
): Promise<SheetData> {
  if (typeof input !== 'string') {
    const bytes = input.byteLength
    if (bytes > MAX_SHEET_BYTES) {
      throw new Error(`Spreadsheet too large (${bytes} bytes > ${MAX_SHEET_BYTES} limit)`)
    }
    if (bytes === 0) throw new Error('Empty spreadsheet')
    return loadXlsx(input, sheetName)
  }
  if (input.length > MAX_SHEET_BYTES) {
    throw new Error(`Spreadsheet too large (${input.length} chars > ${MAX_SHEET_BYTES} limit)`)
  }
  return loadDelimited(input, sheetName)
}

async function loadXlsx(input: ArrayBuffer, sheetName?: string): Promise<SheetData> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  // exceljs's own typings pin a specific Buffer interface; satisfy them via
  // the load signature itself rather than importing a second Buffer type.
  const loadArg = input as unknown as Parameters<typeof wb.xlsx.load>[0]
  await wb.xlsx.load(loadArg)
  const sheetNames = wb.worksheets.map((ws) => ws.name)
  const active =
    sheetName && sheetNames.includes(sheetName) ? sheetName : (sheetNames[0] ?? '')
  const ws = active ? wb.worksheets.find((w) => w.name === active) : undefined
  const rows: string[][] = []
  if (ws) {
    ws.eachRow((row) => {
      const cells: string[] = []
      for (let c = 1; c <= row.cellCount; c++) {
        // `.text` resolves rich text and formula results to display strings.
        const text = row.getCell(c).text
        cells.push(text == null ? '' : String(text))
      }
      rows.push(cells)
    })
  }
  return { sheetNames, active, rows }
}

/**
 * Minimal delimited-text reader (comma / semicolon / tab sniffed from line
 * one). Quote rules follow RFC 4180: a quoted field may contain delimiters,
 * newlines and doubled ("") quotes. Blank lines are dropped (matches the old
 * `blankrows:false` behavior).
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts: Array<[string, number]> = [
    [',', countChar(firstLine, ',')],
    ['\t', countChar(firstLine, '\t')],
    [';', countChar(firstLine, ';')],
  ]
  counts.sort((a, b) => b[1] - a[1])
  const delim =
    delimiter ?? (counts[0][1] > 0 ? counts[0][0] : ',')

  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (row.some((cell) => cell.trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (ch === delim) {
      pushField()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      pushRow()
      continue
    }
    field += ch
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

function loadDelimited(text: string, _sheetName?: string): SheetData {
  const rows = parseDelimited(text)
  return { sheetNames: ['Sheet1'], active: 'Sheet1', rows }
}
