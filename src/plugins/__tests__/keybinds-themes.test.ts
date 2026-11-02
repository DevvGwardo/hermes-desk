import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePluginKeybind, installPluginKeybinds, parseKeybind } from '../keybinds'
import { installPluginThemes, setPluginTheme, themeCss, PLUGIN_THEME_KEY } from '../themes'
import { registerContribution } from '../areas'
import { KEYBINDS_AREA, THEMES_AREA, type KeybindContribution } from '../../lib/plugins/types'

const key = (init: KeyboardEventInit & { code: string }) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
const bind = (keys: string, run = vi.fn()): KeybindContribution => ({ id: `p:${keys}`, area: KEYBINDS_AREA, data: { keys, run } })
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  window.localStorage.clear()
  document.getElementById('hd-plugin-theme')?.remove()
})

describe('plugin keybinds', () => {
  it('accepts only ⌘⇧ or ⌘⌥ bindings outside the reserved app shortcuts', () => {
    expect(parseKeybind('mod+shift+y')).toEqual({ shift: true, alt: false, key: 'y' })
    expect(parseKeybind('Cmd+Option+9')).toEqual({ shift: false, alt: true, key: '9' })
    for (const raw of ['mod+k', 'y', 'shift+y', 'mod+shift+t', 'mod+shift+h', 'mod+shift+.', 'mod+hyper+y', 'mod+shift+enter', 42]) {
      expect(parseKeybind(raw)).toBeNull()
    }
  })

  it('matches the physical key, runs once, and contains a throwing handler', () => {
    const run = vi.fn(() => { throw new Error('plugin bug') })
    const event = key({ code: 'KeyY', key: 'Ÿ', metaKey: true, shiftKey: true })
    expect(handlePluginKeybind(event, [bind('mod+shift+y', run), bind('mod+shift+y')])).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('never takes a key the app already handled, a plain ⌘ key, or a repeat', () => {
    const run = vi.fn()
    const handled = key({ code: 'KeyY', metaKey: true, shiftKey: true })
    handled.preventDefault()
    expect(handlePluginKeybind(handled, [bind('mod+shift+y', run)])).toBe(false)
    expect(handlePluginKeybind(key({ code: 'KeyY', metaKey: true }), [bind('mod+shift+y', run)])).toBe(false)
    expect(handlePluginKeybind(key({ code: 'KeyY', metaKey: true, shiftKey: true, repeat: true }), [bind('mod+shift+y', run)])).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('follows registrations live once installed', () => {
    cleanups.push(installPluginKeybinds())
    const run = vi.fn()
    const dispose = registerContribution(bind('mod+alt+j', run))
    window.dispatchEvent(key({ code: 'KeyJ', ctrlKey: true, altKey: true }))
    dispose()
    window.dispatchEvent(key({ code: 'KeyJ', ctrlKey: true, altKey: true }))
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('plugin themes', () => {
  it('keeps only colour tokens with plain values', () => {
    expect(themeCss({ id: 't', label: 'T', tokens: {
      '--ca-primary': '#0f6fb8',
      '--desk-accent': 'rgb(1, 2, 3)',
      '--ca-bg': 'url(https://example.invalid/x.png)',
      '--ca-ink': 'red;} body{display:none',
      color: 'red',
    }, dark: { '--ca-primary': '#5fb4f0' } })).toBe(
      ':root:root{--ca-primary:#0f6fb8;--desk-accent:rgb(1, 2, 3);}:root:root[data-theme="dark"]{--ca-primary:#5fb4f0;}')
  })

  it('applies the chosen theme while its plugin is loaded and resets cleanly', () => {
    cleanups.push(installPluginThemes())
    const dispose = registerContribution({ id: 'p:theme', area: THEMES_AREA,
      data: { id: 'ocean', label: 'Ocean', tokens: { '--ca-primary': '#0f6fb8' } } })
    setPluginTheme('ocean')
    expect(window.localStorage.getItem(PLUGIN_THEME_KEY)).toBe('ocean')
    expect(document.getElementById('hd-plugin-theme')?.textContent).toContain('--ca-primary:#0f6fb8')
    dispose()
    expect(document.getElementById('hd-plugin-theme')).toBeNull()
    const again = registerContribution({ id: 'p:theme', area: THEMES_AREA,
      data: { id: 'ocean', label: 'Ocean', tokens: { '--ca-primary': '#0f6fb8' } } })
    cleanups.push(again)
    expect(document.getElementById('hd-plugin-theme')).not.toBeNull()
    setPluginTheme(null)
    expect(document.getElementById('hd-plugin-theme')).toBeNull()
    expect(window.localStorage.getItem(PLUGIN_THEME_KEY)).toBeNull()
  })
})
