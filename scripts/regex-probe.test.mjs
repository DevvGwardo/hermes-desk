import { describe, expect, it } from 'vitest'
import { probeInChild, probeRegex, regexLiterals } from './regex-probe.mjs'

describe('regex-probe', () => {
  it('finds regex literals but not division', () => {
    const text = 'const a = b / c / d\nconst re = /\\s+$/g\n// /not a regex/\nexport const x = s.replace(/a|b/, "")\n'
    expect(regexLiterals('x.ts', text)).toEqual([
      { file: 'x.ts', line: 2, source: '/\\s+$/g' },
      { file: 'x.ts', line: 4, source: '/a|b/' },
    ])
  })

  it('passes linear and invalid literals', () => {
    expect(probeRegex('/^[a-z]+:\\/\\//i')).toBeNull()
    expect(probeRegex('/(?<!\\s)\\s+$/')).toBeNull()
    expect(probeRegex('/[/')).toBeNull()
  })

  it('reports a literal whose child probe runs past the timeout', async () => {
    expect(await probeInChild('/\\s*\\s*\\s*!/', 1000)).toEqual({ timedOut: true })
    expect(await probeInChild('/^abc$/', 10_000)).toBeNull()
  }, 20_000)
})
