import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `--ca-ink` is dark navy in light mode and near-white (#f5f5f5) in dark
 * mode, so a fill of ink with white text reads 1.09:1 in dark mode (the app
 * toast did exactly that). Text on an ink fill takes `--ca-card`, which
 * flips the other way. Scans every class string in src/ so a new one can't
 * slip in.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(p))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

describe('ink fills', () => {
  it('never pair bg-[var(--ca-ink)] with text-white', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(__dirname, '..', '..'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/(['"`])([^'"`\n]*\bbg-\[var\(--ca-ink\)\][^'"`\n]*)\1/g)) {
        if (/\btext-white\b/.test(m[2])) offenders.push(`${file}: ${m[2].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
