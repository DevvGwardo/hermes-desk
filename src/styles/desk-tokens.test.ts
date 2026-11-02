import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Read the actual CSS, not a second colour inventory that could drift.
const css = readFileSync(resolve(process.cwd(), 'src/styles/desk-tokens.css'), 'utf8')
const source = css.match(/:root\s*\{([^}]+)\}/)![1]
const tokens = new Map([...source.matchAll(/(--desk-[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
function value(name: string, visited = new Set<string>()): string {
  if (visited.has(name)) throw new Error(`Circular token ${name}`)
  visited.add(name)
  const raw = tokens.get(name)
  if (!raw) throw new Error(`Unknown token ${name}`)
  const reference = raw.match(/^var\((--desk-[\w-]+)\)$/)
  return reference ? value(reference[1], visited) : raw
}
function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Text and surface colours must be opaque hex: ${hex}`)
  const channels = hex.slice(1).match(/../g)!.map(channel => {
    const srgb = parseInt(channel, 16) / 255
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
  })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}
function contrast(foreground: string, background: string): number {
  const a = luminance(value(foreground)), b = luminance(value(background))
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}
const surfaces = Array.from({ length: 5 }, (_, i) => `--desk-surface-${i}`)
const text = ['primary', 'secondary', 'tertiary'].map(name => `--desk-text-${name}`)
const statuses = ['accent', 'agent-accent', 'success', 'warn', 'danger'].map(name => `--desk-${name}`)

describe('Desk colour contrast, WCAG 2.2 AA normal text', () => {
  for (const foreground of [...text, ...statuses]) {
    for (const background of surfaces) {
      it(`${foreground} on ${background} is at least 4.5:1`, () => {
        expect(contrast(foreground, background), `${value(foreground)} on ${value(background)}`).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
  for (const [foreground, background] of [
    ['accent', 'accent-surface'], ['agent-accent', 'agent-surface'], ['success', 'success-surface'],
    ['warn', 'warn-surface'], ['danger', 'danger-surface'], ['accent-ink', 'accent'], ['agent-ink', 'agent-accent'],
    ...['accent-surface', 'agent-surface', 'success-surface', 'warn-surface', 'danger-surface']
      .flatMap(background => text.map(foreground => [foreground.slice('--desk-'.length), background])),
  ]) {
    it(`${foreground} on ${background} is at least 4.5:1`, () => {
      expect(contrast(`--desk-${foreground}`, `--desk-${background}`)).toBeGreaterThanOrEqual(4.5)
    })
  }
  for (const foreground of ['--desk-focus-ring', '--desk-control-border']) {
    for (const background of surfaces) {
      it(`${foreground} on ${background} is at least 3:1`, () => {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3)
      })
    }
  }
})
it('uses a 4px spacing grid and the complete native type scale', () => {
  for (const [name, raw] of tokens) {
    if (name.startsWith('--desk-space-')) expect(parseInt(raw) % 4).toBe(0)
  }
  for (const size of [11, 12, 13, 15, 17, 20, 24]) {
    expect(value(`--desk-type-${size}`)).toBe(`${size}px`)
    expect(parseInt(value(`--desk-leading-${size}`))).toBeGreaterThan(size)
  }
  expect(value('--desk-font')).toContain('-apple-system')
})
it('disables token motion and animated spinners for reduced motion', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('@media (forced-colors: active)'))
  for (const name of ['fast', 'normal', 'slow', 'pulse']) expect(reduced).toContain(`--desk-duration-${name}: 0ms`)
  expect(reduced).toContain('.desk-spinner { animation: none; }')
  expect(reduced).toContain('scroll-behavior: auto')
})
