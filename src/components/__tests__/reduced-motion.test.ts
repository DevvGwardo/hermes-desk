/**
 * Reduced-motion consolidation guard.
 *
 * Every CSS animation in index.css must be neutralised by the single
 * consolidated @media (prefers-reduced-motion: reduce) block, and every
 * JS-driven motion source (GrokOrb rAF engine, framer-motion entrances)
 * must gate on the user's motion preference.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { FatCatIcon } from '../FatCatIcon'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// Strip comments first: they mention "animation" and sit between blocks,
// which would otherwise pollute block headers.
const CSS = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

/** Yield `{ header, body }` for every rule block in the sheet. */
function* blocks(css: string): Generator<{ header: string; body: string }> {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) return
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const header = css.slice(i, open).trim()
    const body = css.slice(open + 1, j - 1)
    // The consolidated reduced-motion block stays whole (it is the subject);
    // descend into other conditional at-rules so inner rules surface as
    // leaves; skip keyframe internals (steps, not selectors).
    if (header === '@media (prefers-reduced-motion: reduce)') {
      yield { header, body }
    } else if (/^@(media|supports|container|layer)\b/.test(header)) {
      yield* blocks(body)
    } else if (!/^@keyframes/.test(header)) {
      yield { header, body }
    }
    i = j
  }
}

const allBlocks = [...blocks(CSS)]
const rmBlock = allBlocks.find(
  (b) => b.header === '@media (prefers-reduced-motion: reduce)',
)!

/** Rules that declare an animation (anywhere except inside the block itself). */
function animationSelectors(): string[] {
  const out: string[] = []
  for (const { header, body } of allBlocks) {
    // Keyframe steps (from/to/N%) are bodies, not element selectors; the
    // reduced-motion block's own `animation: none` is the fix, not a gap.
    if (/^@keyframes/.test(header) || /^(from|to|\d+%)/.test(header)) continue
    if (!/(^|[;{\s])animation(-name)?:\s(?!none)/.test(body)) continue
    for (const sel of header.split(',')) out.push(sel.trim())
  }
  return out
}

describe('index.css consolidated reduced-motion block', () => {
  it('exists as a single @media (prefers-reduced-motion: reduce) block', () => {
    expect(CSS.match(/@media \(prefers-reduced-motion: reduce\)/g)?.length).toBe(1)
  })

  it('neutralises every animation declared in the sheet, selector for selector', () => {
    const uncovered = animationSelectors().filter((sel) => !rmBlock.body.includes(sel))
    expect(uncovered).toEqual([])
  })

  it('also stops the Tailwind animate-pulse / animate-spin utilities', () => {
    expect(rmBlock.body).toContain('.animate-pulse')
    expect(rmBlock.body).toContain('.animate-spin')
  })

  it('kills the HUD orb hover transition, keeps the rail snap', () => {
    expect(rmBlock.body).toContain('html[data-hud] .hud-orb')
    expect(rmBlock.body).toMatch(/\.nub-rail\s*{\s*transition-duration: 0ms;/)
  })
})

describe('JS-driven motion honours prefers-reduced-motion', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function stubMatchMedia(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        matches,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    )
  }

  it('the owl honours still and the OS setting via its reduced profile', async () => {
    // Size 120: a running mark reports 'full', so 'reduced' is meaningful.
    stubMatchMedia(false)
    const stillView = render(createElement(FatCatIcon, { expression: 'working', size: 120, still: true }))
    await waitFor(() =>
      expect(stillView.container.querySelector('svg')!.dataset.mascotProfile).toBe('reduced'),
    )
    stillView.unmount()
    cleanup()

    // No pause prop: the OS preference alone pauses the mark.
    stubMatchMedia(true)
    const osView = render(createElement(FatCatIcon, { expression: 'working', size: 120, still: false }))
    await waitFor(() =>
      expect(osView.container.querySelector('svg')!.dataset.mascotProfile).toBe('reduced'),
    )
    osView.unmount()
    cleanup()

    // Control: no preference, no pause prop — the engine runs full.
    stubMatchMedia(false)
    const liveView = render(createElement(FatCatIcon, { expression: 'working', size: 120, still: false }))
    await waitFor(() =>
      expect(liveView.container.querySelector('svg')!.dataset.mascotProfile).toBe('full'),
    )
    liveView.unmount()
  })

  it('every framer-motion call site gates on useReducedMotion', () => {
    const files = ['AppModal.tsx', 'NewChatBar.tsx'].map(
      (f) => join(ROOT, 'src', 'components', f),
    )
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, relative(ROOT, file)).toContain('framer-motion')
      expect(src, relative(ROOT, file)).toMatch(/useReducedMotion|MotionConfig/)
    }
  })
})
