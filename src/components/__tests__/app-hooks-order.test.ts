import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Rules of hooks for App (no ESLint in this repo to enforce them).
 *
 * App has full-screen early returns (web sign-in gate, waitlist, invite,
 * labs). A hook declared below one of them runs only once that return stops
 * applying — the web shell signing in place (handleWebLinked) then rendered
 * more hooks than the render before and crashed with React #310 on
 * agent.nub.lol. Every hook must sit above the first early return.
 */
const APP = `${process.cwd()}/src/App.tsx`

export function hooksAfterFirstEarlyReturn(src: string): Array<{ line: number; text: string }> {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^(export default )?function App\b|^export function App\b/.test(l))
  if (start < 0) throw new Error('App component not found')
  const end = lines.findIndex((l, i) => i > start && l.startsWith('}'))
  let firstReturn = -1
  for (let i = start + 1; i < end && firstReturn < 0; i++) {
    if (!/^ {2}if \(/.test(lines[i]!)) continue
    for (let j = i; j < end; j++) {
      if (/^ {4}return[ (]/.test(lines[j]!)) {
        firstReturn = j
        break
      }
      if (/^ {2}\}/.test(lines[j]!)) break
    }
  }
  if (firstReturn < 0) return []
  const out: Array<{ line: number; text: string }> = []
  for (let i = firstReturn + 1; i < end; i++) {
    const l = lines[i]!
    if (/^ {2}(const|let)\b.*\buse[A-Z]\w*\(/.test(l) || /^ {2}use[A-Z]\w*\(/.test(l)) {
      out.push({ line: i + 1, text: l.trim() })
    }
  }
  return out
}

describe('App rules of hooks', () => {
  it('declares every hook above its first early return', () => {
    expect(hooksAfterFirstEarlyReturn(readFileSync(APP, 'utf8'))).toEqual([])
  })

  it('the checker catches a hook below an early return', () => {
    const bad = [
      'export default function App() {',
      '  const [a] = useState(0)',
      '  if (gate) {',
      '    return <Gate />',
      '  }',
      '  const [b] = useState(1)',
      '  useEffect(() => {}, [])',
      '  return <Shell />',
      '}',
    ].join('\n')
    expect(hooksAfterFirstEarlyReturn(bad).map((h) => h.line)).toEqual([6, 7])
  })
})
