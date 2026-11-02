/**
 * Token contrast contract — guards workbench finding `wb-002`
 * ("the --ca-* token contract has no snapshot/guard test").
 *
 * This reads the REAL token values out of src/index.css, resolves `var()`
 * aliases, and asserts the WCAG 1.4.3 AA pairs the design depends on. Because
 * it parses the stylesheet, editing a token to a failing value breaks this test
 * instead of silently shipping.
 *
 * Why it exists: the contrast pass in the working tree fixed the user bubble and
 * the markdown link but missed `.nub-btn-primary` (white on --ca-primary = 4.12:1
 * light / 2.68:1 dark) and dark `--ca-ink-muted` on --ca-primary-soft (4.32:1),
 * because nothing measured the pairs together.
 *
 * Scope: solid-colour tokens plus the two translucent tokens with a static
 * backdrop (--ca-field-border composites over --ca-card; computed in sRGB
 * before luminance). Tokens whose surface is a translucent composite (e.g.
 * --ca-placeholder on the composer glass, or a `/40` Tailwind opacity
 * modifier over the wallpaper) cannot be resolved statically — those still
 * need the in-app canvas measurement described in the design pass notes.
 *
 * Also covers WCAG 1.4.11 non-text contrast (3:1) for the tokens that
 * identify controls (field borders, focus rings) and src/lib/theme.ts, whose
 * THEME_COLORS / PHONE_THEME_COLORS canvases must stay in step with
 * --ca-canvas and carry --ca-ink text at AA.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PHONE_THEME_COLORS, THEME_COLORS } from '../theme'

// vitest's jsdom transform does not give this module a `file:` import.meta.url,
// so resolve the stylesheet against the project root instead.
const css = readFileSync(resolvePath(process.cwd(), 'src/index.css'), 'utf8')
const deskCss = readFileSync(resolvePath(process.cwd(), 'src/styles/desk-tokens.css'), 'utf8')
const messengerCss = readFileSync(resolvePath(process.cwd(), 'src/styles/skin-messenger.css'), 'utf8')

/** Extract `--token: value;` declarations from the first `selector { ... }` block. */
function tokenBlock(selector: string, source = css): Record<string, string> {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const match = re.exec(stripped)
  if (!match) throw new Error(`no CSS block found for selector ${selector}`)
  const out: Record<string, string> = {}
  for (const decl of match[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[decl[1]] = decl[2].trim()
  }
  return out
}

/** Resolve `var(--x)` chains down to a literal colour. */
function resolve(tokens: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle resolving ${name}`)
  const raw = tokens[name]
  if (raw === undefined) throw new Error(`token ${name} is not defined`)
  const varMatch = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/.exec(raw)
  if (!varMatch) return raw
  const [, ref, fallback] = varMatch
  return tokens[ref] !== undefined ? resolve(tokens, ref, depth + 1) : (fallback ?? raw).trim()
}

/** Parse `#rrggbb` or `rgba()/rgb()` into sRGB components + alpha. */
function parseColor(c: string): { rgb: [number, number, number]; a: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(c)
  if (hex) return { rgb: [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number], a: 1 }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { rgb: [parts[0], parts[1], parts[2]], a: parts[3] ?? 1 }
  }
  throw new Error(`unparseable colour: ${c}`)
}

/** Composite a possibly-translucent colour over an opaque backdrop (sRGB). */
function over(fg: string, bg: string): [number, number, number] {
  const f = parseColor(fg)
  const b = parseColor(bg)
  return [0, 1, 2].map((i) => Math.round(f.rgb[i] * f.a + b.rgb[i] * (1 - f.a))) as [number, number, number]
}

function luminance(rgb: [number, number, number]): number {
  const toLin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * toLin(rgb[0]) + 0.7152 * toLin(rgb[1]) + 0.0722 * toLin(rgb[2])
}

function ratio(fg: string, bg: string): number {
  const a = luminance(over(fg, bg))
  const b = luminance(over(bg, '#ffffff'))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const light = tokenBlock(':root')
const dark = tokenBlock("html[data-theme='dark']")

/** Assert every (foreground, background) pair clears the given WCAG ratio
 *  (AA text 4.5:1, or non-text/UI 3:1) and name the offending pair on fail. */
function assertPairs(tokens: Record<string, string>, pairs: Array<[string, string]>, min = 4.5) {
  for (const [fgName, bgName] of pairs) {
    const fg = resolve(tokens, fgName)
    const bg = resolve(tokens, bgName)
    const r = ratio(fg, bg)
    expect(r, `${fgName} (${fg}) on ${bgName} (${bg}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(min)
  }
}

describe('light theme --ca-* token contrast (AA 4.5:1)', () => {
  test('white text on the primary fill tokens', () => {
    assertPairs(light, [
      ['--ca-white', '--ca-primary-fill'],
      ['--ca-white', '--ca-primary-fill-hover'],
      ['--ca-white', '--ca-bubble-user'],
    ])
  })

  test('body/secondary text on the surfaces it renders on', () => {
    assertPairs(light, [
      ['--ca-ink', '--ca-card'],
      ['--ca-ink', '--ca-canvas'],
      ['--ca-ink', '--ca-sidebar'],
      ['--ca-ink', '--ca-primary-soft'],
      ['--ca-ink-soft', '--ca-card'],
      ['--ca-ink-muted', '--ca-card'],
      ['--ca-ink-muted', '--ca-primary-soft'],
      ['--ca-primary-text', '--ca-card'],
      ['--ca-primary-text', '--ca-primary-soft'],
      ['--ca-success-text', '--ca-card'],
      ['--ca-warn-text', '--ca-card'],
      ['--ca-danger', '--ca-card'],
      ['--ca-danger', '--ca-pink-soft'],
      ['--ca-placeholder', '--ca-card'],
    ])
  })

  test('white text on the danger fill (destructive buttons)', () => {
    assertPairs(light, [['--ca-white', '--ca-danger']])
  })

  test('the focus ring routes through the single token on the primary-text step', () => {
    expect(light['--ca-focus-ring']).toBeDefined()
    expect(resolve(light, '--ca-focus-ring')).toBe(resolve(light, '--ca-primary-text'))
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid[^}]*--ca-primary-text[^}]*outline-offset/s)
  })

  test('--ca-bubble-user is wired to the shared fill (not a drifted copy)', () => {
    expect(resolve(light, '--ca-bubble-user')).toBe(resolve(light, '--ca-primary-fill'))
  })
})

describe('dark theme --ca-* token contrast (AA 4.5:1)', () => {
  test('white text on the primary fill tokens', () => {
    assertPairs(dark, [
      ['--ca-white', '--ca-primary-fill'],
      ['--ca-white', '--ca-primary-fill-hover'],
      ['--ca-white', '--ca-bubble-user'],
    ])
  })

  test('body/secondary text on the surfaces it renders on', () => {
    assertPairs(dark, [
      ['--ca-ink', '--ca-card'],
      ['--ca-ink', '--ca-canvas'],
      ['--ca-ink-soft', '--ca-card'],
      ['--ca-ink-muted', '--ca-card'],
      // the case the pass missed: kind badge + sidebar "Search" label
      ['--ca-ink-muted', '--ca-primary-soft'],
      ['--ca-ink-muted', '--ca-canvas'],
      ['--ca-ink-muted', '--ca-sidebar'],
      ['--ca-primary-text', '--ca-card'],
      ['--ca-success-text', '--ca-card'],
      ['--ca-warn-text', '--ca-card'],
      ['--ca-danger', '--ca-card'],
      ['--ca-danger', '--ca-pink-soft'],
      ['--ca-placeholder', '--ca-card'],
    ])
  })

  test('--ca-bubble-user is wired to the shared fill (not a drifted copy)', () => {
    expect(resolve(dark, '--ca-bubble-user')).toBe(resolve(dark, '--ca-primary-fill'))
  })
})

describe('messenger semantic-surface contrast (AA 4.5:1)', () => {
  test.each(['light', 'dark'])('preserves readable error, status and body text over the %s base theme', theme => {
    const tokens = {
      ...light,
      ...(theme === 'dark' ? dark : {}),
      ...tokenBlock(':root', deskCss),
      ...tokenBlock('[data-skin="messenger"]', messengerCss),
    }
    assertPairs(tokens, [
      ['--ca-danger', '--ca-pink-soft'],
      ['--ca-ink', '--ca-pink-soft'],
      ['--ca-ink-muted', '--ca-pink-soft'],
      ['--ca-success-text', '--ca-card'],
      ['--ca-success-text', '--desk-surface-1'],
    ])
  })
})

describe('WCAG 1.4.11 non-text contrast (--ca-* UI tokens, 3:1)', () => {
  test('light: field borders and focus ring identify controls on every surface they sit on', () => {
    assertPairs(
      light,
      [
        ['--ca-field-border', '--ca-card'],
        ['--ca-focus-ring', '--ca-card'],
        ['--ca-focus-ring', '--ca-canvas'],
        ['--ca-focus-ring', '--ca-sidebar'],
      ],
      3,
    )
  })

  test('dark: field borders and focus ring identify controls on every surface they sit on', () => {
    assertPairs(
      dark,
      [
        ['--ca-field-border', '--ca-card'],
        ['--ca-focus-ring', '--ca-card'],
        ['--ca-focus-ring', '--ca-canvas'],
        ['--ca-focus-ring', '--ca-primary-soft'],
      ],
      3,
    )
  })
})

describe('src/lib/theme.ts canvases stay in step with --ca-canvas and carry AA ink', () => {
  test('THEME_COLORS matches the --ca-canvas token in both themes', () => {
    expect(THEME_COLORS.light.toLowerCase()).toBe(resolve(light, '--ca-canvas').toLowerCase())
    expect(THEME_COLORS.dark.toLowerCase()).toBe(resolve(dark, '--ca-canvas').toLowerCase())
  })

  test('THEME_COLORS / PHONE_THEME_COLORS hold --ca-ink text at AA in both themes', () => {
    // Each theme's ink renders on its own theme's canvas only.
    const byTheme = [
      { ink: resolve(light, '--ca-ink'), canvases: [THEME_COLORS.light, PHONE_THEME_COLORS.light] },
      { ink: resolve(dark, '--ca-ink'), canvases: [THEME_COLORS.dark, PHONE_THEME_COLORS.dark] },
    ]
    for (const { ink, canvases } of byTheme) {
      for (const canvas of canvases) {
        const r = ratio(ink, canvas)
        expect(r, `--ca-ink (${ink}) on ${canvas} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
