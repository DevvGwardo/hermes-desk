import { describe, expect, it } from 'vitest'
import { toDatetimeLocalValue } from '../hermes-rest'

describe('toDatetimeLocalValue', () => {
  it('formats a UTC instant as local YYYY-MM-DDTHH:MM (seconds truncated)', () => {
    const d = new Date('2026-09-04T12:34:56.789Z')
    const pad = (n: number) => String(n).padStart(2, '0')
    const want =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    expect(toDatetimeLocalValue('2026-09-04T12:34:56.789Z')).toBe(want)
  })

  it('returns empty for missing or unparseable input (field stays empty)', () => {
    expect(toDatetimeLocalValue(null)).toBe('')
    expect(toDatetimeLocalValue(undefined)).toBe('')
    expect(toDatetimeLocalValue('')).toBe('')
    expect(toDatetimeLocalValue('not-a-date')).toBe('')
  })

  it('zero-pads single-digit fields', () => {
    const out = toDatetimeLocalValue('2026-01-02T03:04:00Z')
    // Local zone may shift the wall time — assert shape, not the instant.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(out).not.toContain('NaN')
  })
})
