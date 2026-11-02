import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_KEY } from '../theme'
import { BOOT_CACHED_MIN_MS, bootSplashWaitMs, hasCachedThreads } from '../boot-splash'

// The boot splash lives in index.html so it paints before any bundle, and
// public/theme-boot.js sets the stored theme before that first paint.

const ROOT = join(__dirname, '..', '..', '..')
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8')
const THEME_BOOT = readFileSync(join(ROOT, 'public', 'theme-boot.js'), 'utf8')

function runThemeBoot() {
  // Same-origin classic script: evaluate it exactly as the browser would.
  new Function(THEME_BOOT)()
}

describe('boot splash (index.html)', () => {
  it('paints the splash inside #root, so React replaces it on first commit', () => {
    expect(HTML).toMatch(/<div id="root"[^>]*><div class="nub-splash"[^>]*>/)
  })

  it('uses the local canonical Pip rig instead of a different boot mascot', () => {
    const document = new DOMParser().parseFromString(HTML, 'text/html')
    const image = document.querySelector('.nub-splash__mark img')
    expect(image?.getAttribute('src')).toBe('./src/lib/mascot/characters/owl/rig.svg')
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading Hermes Desk')
  })

  it('uses local system fonts without cross-origin stylesheet requests', () => {
    expect(HTML).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(HTML).not.toMatch(/<link[^>]+href=["']https?:/i)
  })

  it('loads the theme script in <head>, before the splash styles', () => {
    const script = HTML.indexOf('<script src="./theme-boot.js"></script>')
    expect(script).toBeGreaterThan(-1)
    expect(script).toBeLessThan(HTML.indexOf('<style>'))
    expect(script).toBeLessThan(HTML.indexOf('</head>'))
  })

  it('stops the splash animation under reduced motion', () => {
    expect(HTML).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*{\s*\.nub-splash__mark\s*{\s*animation: none; opacity: 1;/,
    )
  })

  it('reads the same storage key as src/lib/theme.ts', () => {
    expect(THEME_BOOT).toContain(`'${THEME_KEY}'`)
  })
})

describe('theme-boot.js', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('applies a stored dark theme before paint', () => {
    window.localStorage.setItem(THEME_KEY, 'dark')
    runThemeBoot()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('leaves the light default alone', () => {
    window.localStorage.setItem(THEME_KEY, 'light')
    runThemeBoot()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => runThemeBoot()).not.toThrow()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

const base = { minMs: 700, maxMs: 3000 }

describe('boot splash decision', () => {
  it('empty cache keeps the hydrate hold (up to max)', () => {
    expect(bootSplashWaitMs({ ...base, elapsedMs: 100, hydrating: true, cached: false })).toBe(2900)
    expect(bootSplashWaitMs({ ...base, elapsedMs: 3500, hydrating: true, cached: false })).toBe(0)
  })

  it('empty cache, hydrate done: plays the normal minimum', () => {
    expect(bootSplashWaitMs({ ...base, elapsedMs: 200, hydrating: false, cached: false })).toBe(500)
  })

  it('cached threads drop the splash after the short minimum even mid-hydrate', () => {
    expect(bootSplashWaitMs({ ...base, elapsedMs: 0, hydrating: true, cached: true })).toBe(BOOT_CACHED_MIN_MS)
    expect(bootSplashWaitMs({ ...base, elapsedMs: 400, hydrating: true, cached: true })).toBe(0)
    expect(
      bootSplashWaitMs({ ...base, elapsedMs: 100, hydrating: true, cached: true, cachedMinMs: 1200 }),
    ).toBe(1100)
  })

  it('only real visible threads count as cached', () => {
    expect(hasCachedThreads({ conversations: [] })).toBe(false)
    expect(hasCachedThreads({ conversations: [{ placeholder: true }] })).toBe(false)
    expect(hasCachedThreads({ conversations: [{ hiddenFromSidebar: true }] })).toBe(false)
    expect(hasCachedThreads({ conversations: [{ placeholder: true }, {}] })).toBe(true)
  })
})
