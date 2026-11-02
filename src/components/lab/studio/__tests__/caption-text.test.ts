import { describe, expect, it } from 'vitest'
import { splitWords } from '../caption-paint'
import { PRESETS } from '../presets'

describe('caption-paint: splitWords', () => {
  it('marks *starred* words as key', () => {
    expect(splitWords('*shipped*')).toEqual([{ clean: 'shipped', key: true }])
  })

  it('leaves plain words as non-key', () => {
    expect(splitWords('no thoughts just shipping')).toEqual([
      { clean: 'no', key: false },
      { clean: 'thoughts', key: false },
      { clean: 'just', key: false },
      { clean: 'shipping', key: false },
    ])
  })

  it('collapses multiple spaces', () => {
    expect(splitWords('a  b   c')).toEqual([
      { clean: 'a', key: false },
      { clean: 'b', key: false },
      { clean: 'c', key: false },
    ])
  })

  it('returns [] for empty string', () => {
    expect(splitWords('')).toEqual([])
  })

  it('keeps an unmatched single * literal', () => {
    expect(splitWords('*')).toEqual([{ clean: '*', key: false }])
  })

  it('marks both words key in *a* *b*', () => {
    expect(splitWords('*a* *b*')).toEqual([
      { clean: 'a', key: true },
      { clean: 'b', key: true },
    ])
  })
})

describe('presets: caption sanity', () => {
  it('every preset cap has non-empty text, valid mode, dur>0, start>=0', () => {
    for (const p of PRESETS) {
      for (const c of p.build().caps) {
        expect(c.text.trim().length, `${p.name} text`).toBeGreaterThan(0)
        expect(['bubble', 'bar', 'pop'], `${p.name} mode`).toContain(c.mode)
        expect(c.dur, `${p.name} dur`).toBeGreaterThan(0)
        expect(c.start, `${p.name} start`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('presets: pop captions readable at a glance', () => {
  it('pop word count is 1..12', () => {
    for (const p of PRESETS) {
      for (const c of p.build().caps) {
        if (c.mode !== 'pop') continue
        const n = splitWords(c.text).length
        expect(n, `${p.name}: "${c.text}"`).toBeGreaterThanOrEqual(1)
        expect(n, `${p.name}: "${c.text}"`).toBeLessThanOrEqual(12)
      }
    }
  })

  it('at most 3 starred keywords per pop caption', () => {
    for (const p of PRESETS) {
      for (const c of p.build().caps) {
        if (c.mode !== 'pop') continue
        const keys = splitWords(c.text).filter((w) => w.key).length
        expect(keys, `${p.name}: "${c.text}"`).toBeLessThanOrEqual(3)
      }
    }
  })
})
