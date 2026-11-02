import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isKnownApiPath } from '../dashboard-routes'

/**
 * Every `/api/…` literal in app code must be registered in the route
 * allowlist (electron/dashboard-routes.cjs + src/lib/dashboard-routes.ts), so
 * a new feature cannot quietly start calling a dashboard route the proxy and
 * the app would otherwise forward. Add the route to BOTH files.
 */

const ROOT = resolve(__dirname, '../../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '__tests__') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** `/api/…` literals, with `${…}` placeholders normalized. */
export function extractApiLiterals(src: string): string[] {
  const text = stripComments(src).replace(/\$\{[^{}]*\}/g, '${}')
  const out: string[] = []
  const re = /(?:['"`]|\$\{\})(\/api\/[^'"`\s]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let lit = m[1]
    // `${}` right after '/' is a path segment; anywhere else it is a suffix
    // (query string or optional sub-path) and ends the static part.
    lit = lit.replace(/\/\$\{\}/g, '/:x')
    const cut = lit.indexOf('${}')
    if (cut !== -1) lit = lit.slice(0, cut)
    lit = lit.split('?')[0].replace(/\/+$/, '')
    if (lit === '/api' || lit === '') continue
    out.push(lit)
  }
  return out
}

const EXCLUDE = new Set([
  'src/lib/dashboard-routes.ts',
  'electron/dashboard-routes.cjs',
])

function sources(): string[] {
  const src = walk(join(ROOT, 'src')).filter(
    (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts'),
  )
  const electron = readdirSync(join(ROOT, 'electron'))
    .filter((n) => n.endsWith('.cjs'))
    .map((n) => join(ROOT, 'electron', n))
  return [...src, ...electron].filter((p) => !EXCLUDE.has(relative(ROOT, p)))
}

describe('dashboard route literal scan', () => {
  it('extracts literals and normalizes template segments', () => {
    const got = extractApiLiterals(
      [
        "serveGet('/api/config')",
        'x(`/api/cron/jobs/${encodeURIComponent(id)}/pause`)',
        'x(`/api/notifications${qs}`)',
        'x(`${auth.baseUrl}/api/skills?x=1`)',
        '// serveGet("/api/secret/comment")',
        "const u = 'https://x/api/not-a-literal-start'",
      ].join('\n'),
    )
    expect(got).toEqual(['/api/config', '/api/cron/jobs/:x/pause', '/api/notifications', '/api/skills'])
  })

  it('finds a healthy number of literals (scan is wired up)', () => {
    const all = sources().flatMap((p) => extractApiLiterals(readFileSync(p, 'utf8')))
    expect(all.length).toBeGreaterThan(40)
  })

  it('every /api/ literal in src/ and electron/ is allowlisted', () => {
    const unknown: string[] = []
    for (const file of sources()) {
      for (const lit of extractApiLiterals(readFileSync(file, 'utf8'))) {
        if (!isKnownApiPath(lit)) unknown.push(`${relative(ROOT, file)}: ${lit}`)
      }
    }
    expect(unknown).toEqual([])
  })
})
