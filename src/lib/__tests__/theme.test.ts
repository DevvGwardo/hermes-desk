import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PHONE_THEME_COLORS,
  THEME_COLORS,
  THEME_DEFAULT,
  THEME_KEY,
  applyTheme,
  initTheme,
  loadTheme,
  parseTheme,
  saveTheme,
} from '../theme'

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.restoreAllMocks()
  })

  it('defaults to light', () => {
    expect(THEME_DEFAULT).toBe('light')
  })

  it('parses valid ids', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
  })

  it('coerces invalid/empty input to light', () => {
    expect(parseTheme('navy')).toBe('light')
    expect(parseTheme('')).toBe('light')
    expect(parseTheme(null)).toBe('light')
    expect(parseTheme(undefined)).toBe('light')
    expect(parseTheme(42)).toBe('light')
    expect(parseTheme('DARK')).toBe('light')
  })

  it('loads light when nothing is stored', () => {
    expect(loadTheme()).toBe('light')
  })

  it('loads the stored value', () => {
    window.localStorage.setItem(THEME_KEY, 'dark')
    expect(loadTheme()).toBe('dark')
  })

  it('falls back to light for garbage', () => {
    window.localStorage.setItem(THEME_KEY, 'navy')
    expect(loadTheme()).toBe('light')
  })

  it('falls back to light when storage throws', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadTheme()).toBe('light')
  })

  it('round-trips through save', () => {
    saveTheme('dark')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(loadTheme()).toBe('dark')
    saveTheme('light')
    expect(loadTheme()).toBe('light')
  })

  it('coerces invalid input on save to the default', () => {
    saveTheme('bogus' as never)
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
    expect(loadTheme()).toBe('light')
  })

  it('does not throw when persistence fails', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => saveTheme('dark')).not.toThrow()
  })

  it('applies dark by setting data-theme', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('applies light by removing data-theme', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    applyTheme('light')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('initTheme applies the stored value', () => {
    window.localStorage.setItem(THEME_KEY, 'dark')
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('initTheme defaults to light with no attribute', () => {
    expect(initTheme()).toBe('light')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('initTheme is idempotent', () => {
    window.localStorage.setItem(THEME_KEY, 'dark')
    expect(initTheme()).toBe('dark')
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(loadTheme()).toBe('dark')
  })

  describe('browser chrome colour (mobile theme-color)', () => {
    function withMeta(): HTMLMetaElement {
      const meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      meta.setAttribute('content', '#000000')
      document.head.appendChild(meta)
      return meta
    }

    it('paints the chrome light for the light theme', () => {
      const meta = withMeta()
      applyTheme('light')
      expect(meta.getAttribute('content')).toBe(THEME_COLORS.light)
      meta.remove()
    })

    it('paints the chrome black for the dark theme', () => {
      const meta = withMeta()
      applyTheme('dark')
      expect(meta.getAttribute('content')).toBe(THEME_COLORS.dark)
      meta.remove()
    })

    it('follows the IN-APP theme, not prefers-color-scheme', () => {
      // A phone in OS-dark running the app in light must not get a black bar:
      // the stored picker is authoritative, so the meta tracks applyTheme.
      const meta = withMeta()
      window.localStorage.setItem(THEME_KEY, 'light')
      initTheme()
      expect(meta.getAttribute('content')).toBe(THEME_COLORS.light)
      meta.remove()
    })

    it('paints the PHONE canvas when the phone shell is active', () => {
      // The phone shell is cream (--gm-canvas); the desktop/web shell is sky
      // (--ca-canvas). Painting sky behind the phone shell would band the
      // wrong colour above a cream app.
      const meta = withMeta()
      const previous = window.matchMedia
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query.includes('pointer: coarse'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      })
      try {
        applyTheme('light')
        expect(meta.getAttribute('content')).toBe(THEME_COLORS.light)
        expect(PHONE_THEME_COLORS.light).not.toBe(THEME_COLORS.light)
      } finally {
        Object.defineProperty(window, 'matchMedia', {
          writable: true,
          configurable: true,
          value: previous,
        })
        meta.remove()
      }
    })

    it('does not throw when index.html has no theme-color meta', () => {
      expect(() => applyTheme('dark')).not.toThrow()
    })
  })
})
