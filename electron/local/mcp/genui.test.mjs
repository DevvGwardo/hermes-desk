import { describe, expect, it } from 'vitest'
import { parseGenUi, genUiFromResult, genUiResultFromResult, GENUI_INPUT_SCHEMA } from './genui.mjs'

const spec = () => ({ version: 1, components: [
  { type: 'stat', title: 'Tasks', value: '12', detail: 'Agent estimate' },
  { type: 'table', title: 'Queue', columns: ['Task', 'Count'], rows: [['Review', 3]] },
  { type: 'bar_chart', title: 'Work', items: [{ label: 'Review', value: 3 }], unit: 'tasks' },
  { type: 'checklist', title: 'Next', items: [{ id: 'review', label: 'Review the draft', checked: false }] },
] })

describe('shared data-only Generated UI contract', () => {
  it('extracts bounded occurrence only alongside the same validated successful spec, without synthesizing legacy identity', () => {
    const genui = spec(), genuiOccurrence = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    for (const raw of [{ genui, genuiOccurrence },
      { result: JSON.stringify({ structuredContent: { genui, genuiOccurrence } }) },
      { content: [{ type: 'text', text: JSON.stringify({ genui, genuiOccurrence }) }] }]) {
      expect(genUiResultFromResult(raw)).toEqual({ genui, genuiOccurrence })
    }
    expect(parseGenUi({ ...genui, genuiOccurrence })).toBeNull()
    expect(genUiResultFromResult({ genui })).toEqual({ genui })
    expect(genUiResultFromResult({ genuiOccurrence, result: { genui } })).toEqual({ genui })
    for (const bad of ['', 'provider-id', 'x'.repeat(1000), 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', {}, null])
      expect(genUiResultFromResult({ genui, genuiOccurrence: bad })).toEqual({ genui })
    expect(genUiResultFromResult({ genui, genuiOccurrence, isError: true })).toBeNull()
    expect(genUiResultFromResult({ genui: { html: 'bad' }, genuiOccurrence })).toBeNull()
  })
  it('accepts all four types and clones canonical data without trusting caller objects', () => {
    const raw = spec(), parsed = parseGenUi(raw)
    expect(parsed).toEqual(raw)
    expect(parsed).not.toBe(raw)
    expect(GENUI_INPUT_SCHEMA.additionalProperties).toBe(false)
    expect(parseGenUi(JSON.stringify(raw))).toEqual(raw)
  })
  it('accepts a handbook page only with paired data columns, a bounded notice level, and no styling keys', () => {
    const page = (extra = {}) => ({ version: 1, components: [{ type: 'handbook', title: 'Pressure loop',
      paragraphs: ['The circuit is sealed.'], ...extra }] })
    expect(parseGenUi(page())).toEqual(page())
    expect(parseGenUi(page({ subtitle: 'SYSTEMS DATA', columns: ['Station', 'Value'], rows: [['S-1', 14.7]],
      notice: { level: 'WARNING', text: 'Vent before opening.' } })))
      .toEqual(page({ subtitle: 'SYSTEMS DATA', columns: ['Station', 'Value'], rows: [['S-1', 14.7]],
        notice: { level: 'WARNING', text: 'Vent before opening.' } }))
    for (const bad of [page({ columns: ['Station'] }), page({ rows: [['S-1']] }),
      page({ columns: ['Station'], rows: [['S-1', 'extra']] }),
      page({ notice: { level: 'danger', text: 'Unbounded.' } }), page({ notice: { level: 'NOTE', text: '' } }),
      page({ style: 'background:#000' }), page({ paragraphs: [] })])
      expect(parseGenUi(bad), JSON.stringify(bad)).toBeNull()
  })
  it('rejects unknown keys, executable markup, URLs, inherited/prototype data, and excessive bounds', () => {
    const bad = [
      { ...spec(), onclick: 'fetch()' },
      { ...spec(), version: 2 },
      { version: 1, components: [{ type: 'html', html: '<script>alert(1)</script>' }] },
      { version: 1, components: [{ type: 'stat', title: 'Unsafe', value: 'https://evil.invalid' }] },
      { version: 1, components: [{ type: 'stat', title: 'Unsafe', value: '<img onerror=alert(1)>' }] },
      { version: 1, components: [{ type: 'stat', title: 'Unsafe', value: 'javascript:alert(1)' }] },
      { version: 1, components: [{ type: 'bar_chart', title: 'NaN', items: [{ label: 'A', value: Infinity }] }] },
      { version: 1, components: [{ type: 'checklist', title: 'Duplicate', items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }] },
      { version: 1, components: [{ type: 'table', title: 'Ragged', columns: ['A'], rows: [['a', 'b']] }] },
      { version: 1, components: Array(5).fill(spec().components[0]) },
      Object.assign(Object.create({ inherited: true }), spec()),
      JSON.parse('{"version":1,"components":[],"__proto__":{"polluted":true}}'),
      { version: 1, components: [{ ...spec().components[0], constructor: {} }] },
    ]
    for (const raw of bad) expect(parseGenUi(raw), JSON.stringify(raw)).toBeNull()
    expect(parseGenUi('x'.repeat(20_000))).toBeNull()
    expect({}.polluted).toBeUndefined()
  })
  it('extracts only successful bounded structured results, never unpaired args or error envelopes', () => {
    const raw = spec()
    expect(genUiFromResult({ genui: raw })).toEqual(raw)
    expect(genUiFromResult(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ genui: raw }) }] }))).toEqual(raw)
    expect(genUiFromResult({ result: JSON.stringify({ structuredContent: { genui: raw } }) })).toEqual(raw)
    expect(genUiFromResult(raw)).toBeNull()
    expect(genUiFromResult({ isError: true, genui: raw })).toBeNull()
    expect(genUiFromResult({ error: 'failed', result: { genui: raw } })).toBeNull()
    for (const status of ['running', 'queued', 'pending', 'timeout', 'FAILED', 'unknown'])
      expect(genUiFromResult({ status, result: { genui: raw } })).toBeNull()
    expect(genUiFromResult({ status: 'COMPLETED', genui: raw })).toEqual(raw)
  })
  it('rejects Unicode control and format characters without misreading ordinary field names as URI schemes', () => {
    for (const character of ['\u0085', '\u009f', '\u061c', '\u180e', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f',
      '\u2028', '\u2029', '\u202a', '\u202e', '\u2060', '\u2066', '\u2069', '\ufeff']) {
      expect(parseGenUi({ version: 1, components: [{ type: 'stat', title: `Unsafe${character}label`, value: '1' }] })).toBeNull()
    }
    for (const title of ['Profile: alpha', 'Metadata: 3']) {
      expect(parseGenUi({ version: 1, components: [{ type: 'stat', title, value: '1' }] })).not.toBeNull()
    }
  })
  it('enforces the exact UTF-8 byte boundary independently of per-field and row bounds', () => {
    const raw = { version: 1, components: [{ type: 'table', title: 'Byte bounds', columns: ['A', 'B', 'C', 'D', 'E', 'F'],
      rows: Array.from({ length: 20 }, () => Array(6).fill('x'.repeat(130))) }] }
    let remaining = 16384 - Buffer.byteLength(JSON.stringify(raw))
    for (const row of raw.components[0].rows) for (let i = 0; i < row.length && remaining > 0; i++) {
      const extra = Math.min(160 - row[i].length, remaining)
      row[i] += 'x'.repeat(extra)
      remaining -= extra
    }
    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(16384)
    expect(parseGenUi(raw)).toEqual(raw)
    raw.components[0].rows[19][5] += 'x'
    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(16385)
    expect(parseGenUi(raw)).toBeNull()
    raw.components[0].rows = Array.from({ length: 20 }, () => Array(6).fill('é'.repeat(80)))
    expect(raw.components[0].rows[0][0].length).toBeLessThan(160)
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(16384)
    expect(parseGenUi(raw)).toBeNull()
  })
})
