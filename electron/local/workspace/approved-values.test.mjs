import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { remember, scrub, valuesFor } from './approved-values.cjs'

describe('main-only approved-value lifetime', () => {
  it('scrubs arbitrary and encoded echoes only within the approving tab', () => {
    const contents = new EventEmitter()
    const other = new EventEmitter()
    const value = 'obviously fake approved marker'
    remember(contents, value)
    expect(scrub(contents, `Echo ${value}`)).toBe('Echo [secret]')
    expect(scrub(contents, `https://fake.invalid/${encodeURIComponent(value)}`)).toBe('https://fake.invalid/[secret]')
    expect(scrub(other, value)).toBe(value)
    const punctuation = 'obviously fake / encoded'
    remember(contents, punctuation)
    expect(scrub(contents, encodeURIComponent(punctuation).replace('%2F', '%2f'))).toBe('[secret]')
    contents.emit('did-navigate')
    expect(scrub(contents, value)).toBe('[secret]')
    contents.emit('destroyed')
    expect(valuesFor(contents)).toEqual([])
  })

  it('bounds memory without evicting earlier values or accepting empty fills', () => {
    const contents = new EventEmitter()
    for (let i = 0; i < 64; i++) remember(contents, `obviously fake value ${i}`)
    expect(() => remember(contents, 'obviously fake overflow')).toThrow('Fill blocked')
    expect(scrub(contents, 'obviously fake value 0')).toBe('[secret]')
    expect(() => remember(contents, '')).toThrow('Fill blocked')
    const large = new EventEmitter()
    remember(large, 'a'.repeat(32768))
    remember(large, 'b'.repeat(32768))
    expect(() => remember(large, 'overflow')).toThrow('Fill blocked')
  })
})
