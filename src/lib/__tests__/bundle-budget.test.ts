import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
let outDir = ''

// Measured local-only production build, 2026-10-06, raw/gzip bytes.
// Ceilings have 10% headroom. Pin the actual App/shared shell as well as the
// tiny boot entry, so moving code into another startup chunk cannot hide growth.
const baselines: Array<[string, RegExp, number, number]> = [
  ['entry', /^index-.*\.js$/, 5_078, 2_360],
  // Re-measured 2026-10-07 after Pip motion v2 (stage cues, live avatars): the
  // 2026-10-06 overnight batches had already used all but 144 B of gzip headroom.
  ['app', /^App-.*\.js$/, 421_295, 134_716],
  ['shared shell', /^hud-activity-.*\.js$/, 287_452, 99_824],
  ['react', /^react-.*\.js$/, 224_353, 69_776],
  ['motion', /^motion-.*\.js$/, 128_959, 42_392],
  ['markdown', /^markdown-.*\.js$/, 157_736, 47_848],
  ['mermaid', /^mermaid-.*\.js$/, 3_413_084, 934_291],
  ['xlsx', /^xlsx-.*\.js$/, 940_194, 271_327],
  ['pdf', /^pdf-.*\.js$/, 483_141, 144_258],
  ['katex', /^katex-.*\.js$/, 261_944, 77_913],
]
const ceiling = (bytes: number) => Math.ceil(bytes * 1.1)

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'hermes-desk-bundle-'))
  // Exercise the actual production script, including TypeScript. A broken
  // app must fail this guard, never silently skip it or build a hosted mode.
  execFileSync('npm', ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir'], {
    cwd: root, timeout: 240_000, stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  })
}, 240_000)
afterAll(() => { if (outDir) rmSync(outDir, { recursive: true, force: true }) })

function entryName(): string {
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  const name = /src="(?:\.\/|\/)?assets\/(index-[^"]+\.js)"/.exec(html)?.[1]
  expect(name, 'production HTML references the local entry').toBeTruthy()
  return name!
}
function source(): string { return readFileSync(join(outDir, 'assets', entryName()), 'utf8') }

describe('Hermes Desk production bundle', () => {
  it.each(baselines)('%s stays within the raw and gzip ceiling', (label, pattern, raw, gzip) => {
    const name = label === 'entry' ? entryName() : readdirSync(join(outDir, 'assets')).find((file) => pattern.test(file))
    expect(name, `${label} chunk exists`).toBeTruthy()
    const bytes = readFileSync(join(outDir, 'assets', name!))
    console.log(`[bundle-budget] ${label}=${bytes.length}B/${gzipSync(bytes).length}Bgz`)
    expect(bytes.length).toBeLessThanOrEqual(ceiling(raw))
    expect(gzipSync(bytes).length).toBeLessThanOrEqual(ceiling(gzip))
  })
  it('all JavaScript stays within the measured total, including new chunks', () => {
    const chunks = readdirSync(join(outDir, 'assets')).filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(outDir, 'assets', file)))
    expect(chunks.reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThanOrEqual(ceiling(6_619_194))
    expect(chunks.reduce((sum, bytes) => sum + gzipSync(bytes).length, 0)).toBeLessThanOrEqual(ceiling(1_924_415))
  })
  it('keeps heavy libraries lazy and does not preload them', () => {
    expect(source()).not.toMatch(/(?:from|import\s*)["'][^"']*(?:mermaid|cytoscape|gifenc|mediabunny|xlsx|pdf|katex)/i)
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).not.toContain('modulepreload')
    expect(readdirSync(join(outDir, 'assets')).some((file) => /^cytoscape-/.test(file))).toBe(false)
  })
  it('loads optional workspace controls only when requested', () => {
    const chunks = readdirSync(join(outDir, 'assets'))
    const app = readFileSync(join(outDir, 'assets', chunks.find(file => /^App-.*\.js$/.test(file))!), 'utf8')
    for (const component of ['AgentTabsPopover', 'GiveToAgentDialog', 'CopySignInDialog', 'ReaderPreview', 'ComputerPip']) {
      const chunk = chunks.find(file => file.startsWith(`${component}-`) && file.endsWith('.js'))
      expect(chunk, `${component} has an on-demand chunk`).toBeTruthy()
      expect(app).toContain(`import("./${chunk}")`)
    }
  })
  it('ships no telemetry or hosted transport chunks', () => {
    const js = readdirSync(join(outDir, 'assets')).filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(outDir, 'assets', file), 'utf8')).join('\n')
    expect(js).not.toMatch(/posthog|HermesDeployTransport|nub_desk_|download\.maiavm\.com/)
    expect(source()).not.toMatch(/UiLab|LoopLab|LoopStudio|MarketingComposer/)
  })
  it('retains a local-only CSP with no remote fonts or services', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    expect(policy).toBeTruthy()
    const csp = new Map(policy!.split(';').filter((part) => part.trim()).map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/)
      return [name, sources]
    }))
    expect(csp.get('connect-src')).toEqual(["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*'])
    expect(csp.get('script-src')).toEqual(["'self'", 'blob:'])
    expect(csp.get('font-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
  })
})
