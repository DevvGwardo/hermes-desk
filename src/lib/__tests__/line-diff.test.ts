import { describe, expect, it } from 'vitest'
import { lineDiff } from '../line-diff'

const changes = (before: string, after: string) => lineDiff(before, after)!
  .filter((line) => line.kind !== 'same' && line.kind !== 'skip')
  .map((line) => line.kind === 'skip' ? '' : `${line.kind === 'add' ? '+' : '-'}${line.text}`)

describe('lineDiff', () => {
  it('reports only the edited lines, numbered against both versions', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc')!
    expect(diff).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'b', oldLine: 2, newLine: null },
      { kind: 'add', text: 'B', oldLine: null, newLine: 2 },
      { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
    ])
  })

  it('keeps moved-around lines minimal', () => {
    expect(changes('one\ntwo\nthree\nfour', 'one\nthree\nfour\nfive')).toEqual(['-two', '+five'])
  })

  it('folds long unchanged runs outside the context window', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 20', 'changed')
    const diff = lineDiff(before, after)!
    expect(diff[0]).toEqual({ kind: 'skip', count: 17 })
    expect(diff.at(-1)).toEqual({ kind: 'skip', count: 16 })
    expect(diff.filter((line) => line.kind === 'same')).toHaveLength(6)
  })

  it('handles identical, added-from-empty and removed-to-empty files', () => {
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'skip', count: 1 }])
    expect(changes('', 'new')).toEqual(['-', '+new'])
    expect(changes('gone\nkept', 'kept')).toEqual(['-gone'])
  })

  it('declines files too large to compare quickly', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    expect(lineDiff(before, after)).toBeNull()
  })
})
