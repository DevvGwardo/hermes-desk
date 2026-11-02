/**
 * Fill-token usage guard.
 *
 * `--ca-primary` is a *text/tint* colour: as a fill behind white text it only
 * reaches 4.12:1 in light and 2.68:1 in dark (WCAG 1.4.3 AA fail). Any surface
 * that carries white text must use `--ca-primary-fill` (4.80:1 / 4.54:1) and
 * `--ca-primary-fill-hover` on hover.
 *
 * This test fails the build if a new white-on-`--ca-primary` pair is
 * introduced. It caught ~30 pre-existing sites across Settings, Telegram
 * connect, WebConnect, McpPanel, UpdateBanner, AgentInfo, AgentEditor,
 * NotificationsBell, Sidebar and the chat composer.
 *
 * Scope / limitations (documented rather than hidden):
 *  - It matches a fill and `text-white` on the SAME line. A pair split across
 *    lines in a multi-line className will not be detected.
 *  - `__tests__` directories are skipped, since fixtures may legitimately
 *    render both variants and this guard is about shipped UI.
 *  - Decorative non-text uses are intentionally allowed: dots, progress bars,
 *    toggle tracks and resize handles may keep `--ca-primary`.
 */
import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

const SRC = 'src'
const FILL = 'bg-[var(--ca-primary)]'
const WHITE = 'text-white'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.parentPath.includes('__tests__'))
    .map((e) => `${e.parentPath}/${e.name}`)
}

describe('white text never sits on --ca-primary', () => {
  test('no className pairs text-white with the bg-[var(--ca-primary)] fill', () => {
    const violations: string[] = []
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes(FILL) && line.includes(WHITE)) {
          violations.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
        }
      })
    }
    expect(
      violations,
      `use bg-[var(--ca-primary-fill)] instead of bg-[var(--ca-primary)] when the element has white text:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  test('the primary button class uses the fill token', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const rule = /\.nub-btn-primary\s*\{([^}]*)\}/.exec(css)
    expect(rule, '.nub-btn-primary rule not found in index.css').not.toBeNull()
    expect(rule![1]).toContain('var(--ca-primary-fill)')
    expect(rule![1]).not.toMatch(/background:\s*var\(--ca-primary\)/)
  })

  test('the dark solid-navy helper uses the fill token', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const rule = /html\[data-theme='dark'\]\s*\.nub-solid-navy\s*\{([^}]*)\}/.exec(css)
    expect(rule, "dark .nub-solid-navy rule not found in index.css").not.toBeNull()
    expect(rule![1]).toContain('var(--ca-primary-fill)')
  })
})
