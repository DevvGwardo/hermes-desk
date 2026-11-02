/**
 * Alt-text tripwire.
 *
 * Every <img> in components must carry an alt attribute; every
 * decorative one (alt="") must be aria-hidden so screen readers skip it.
 * Source-scan style (mirrors mobile-typography.test.ts): fails with
 * `file:line — <tag>` so the offending site is named, not just counted.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const DIRS = ['src/components']

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    // Malicious HTML strings in sanitizer fixtures are not rendered JSX.
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .map((f) => join(dir, f))
}

/** Quote-aware extraction of complete `<img …>` tags (src may contain `>`).
 *  Strips comments first so prose mentioning `<img>` isn't scanned. */
function imgTags(src: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = []
  const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  for (let i = cleaned.indexOf('<img'); i !== -1; i = cleaned.indexOf('<img', i + 1)) {
    let quote: string | null = null
    let j = i + 4
    while (j < cleaned.length) {
      const ch = cleaned[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    if (j >= cleaned.length) break
    const tag = cleaned.slice(i, j + 1)
    out.push({ tag, line: cleaned.slice(0, i).split('\n').length })
  }
  return out
}

describe('alt text on every <img>', () => {
  const violations: string[] = []

  for (const dir of DIRS) {
    for (const file of tsxFiles(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8')
      for (const { tag, line } of imgTags(src)) {
        const where = `${file.slice(ROOT.length + 1)}:${line}`
        if (!/\balt=/.test(tag)) {
          violations.push(`${where} — missing alt: ${tag.slice(0, 120)}`)
        } else if (/alt=["']{2}/.test(tag) && !/\baria-hidden\b/.test(tag)) {
          violations.push(`${where} — decorative (alt="") without aria-hidden: ${tag.slice(0, 120)}`)
        }
      }
    }
  }

  it('every meaningful image has alt; every decorative one is aria-hidden', () => {
    expect(violations).toEqual([])
  })
})
