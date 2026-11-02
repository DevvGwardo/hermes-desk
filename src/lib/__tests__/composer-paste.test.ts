import { describe, expect, it } from 'vitest'
import { tidyPastedText } from '../composer-paste'

describe('tidyPastedText', () => {
  it('drops trailing newlines and whitespace', () => {
    expect(tidyPastedText('what was done latest here\n\n\n')).toBe('what was done latest here')
    expect(tidyPastedText('hello  \t\n ')).toBe('hello')
  })

  it('drops leading blank lines but keeps first-line indentation', () => {
    expect(tidyPastedText('\n  \n    const x = 1\n')).toBe('    const x = 1')
  })

  it('keeps inner newlines and normalizes CRLF', () => {
    expect(tidyPastedText('a\r\n\r\nb\rc\r\n')).toBe('a\n\nb\nc')
  })

  it('returns plain text unchanged', () => {
    const s = 'one line, no edges'
    expect(tidyPastedText(s)).toBe(s)
  })

  it('reduces whitespace-only clipboard to empty', () => {
    expect(tidyPastedText('\n\n  \n')).toBe('')
  })

  it('keeps one break where the paste splits a line', () => {
    expect(tidyPastedText('\nline 0\nline 1\n\n', 'the repo', ' tail')).toBe('\nline 0\nline 1\n')
    expect(tidyPastedText('\nline 0\n', 'first\n', '\nnext')).toBe('line 0')
    expect(tidyPastedText('word ', 'a ', 'b')).toBe('word ')
    expect(tidyPastedText('word ', 'a ', '')).toBe('word')
    expect(tidyPastedText('\nNub\n', 'ask ', ' now')).toBe('Nub')
  })

  it('stays linear on large pastes with long inner whitespace runs', () => {
    const raw = `${' '.repeat(60_000)}x\n${'\t'.repeat(60_000)}y \n\n`
    const started = performance.now()
    expect(tidyPastedText(raw, 'a', 'b')).toBe(raw.trimEnd() + '\n')
    expect(performance.now() - started).toBeLessThan(500)
  })
})
