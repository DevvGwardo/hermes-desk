/**
 * Plugin themes: colour token overrides only. Values are checked so a theme
 * cannot load URLs or inject rules, and the choice persists per machine.
 */
import type { ThemeContribution } from '../lib/plugins/types'
import { THEMES_AREA } from '../lib/plugins/types'
import { registrySnapshot, subscribeRegistryArea } from './areas'

export const PLUGIN_THEME_KEY = 'maia:plugins:theme'
const STYLE_ID = 'hd-plugin-theme'
const TOKEN = /^--(?:ca|desk)-[a-z0-9-]{1,48}$/
const VALUE = /^[#(),.%\w\s/-]{1,120}$/

function rules(tokens: unknown): string {
  if (!tokens || typeof tokens !== 'object') return ''
  return Object.entries(tokens as Record<string, unknown>)
    .filter(([name, value]) => TOKEN.test(name) && typeof value === 'string' && VALUE.test(value) && !/url|expression|image/i.test(value))
    .slice(0, 64)
    .map(([name, value]) => `${name}:${value};`).join('')
}

/** CSS for one theme, or '' when nothing valid remains. */
export function themeCss(theme: ThemeContribution['data']): string {
  const light = rules(theme.tokens)
  const dark = rules(theme.dark)
  return `${light ? `:root:root{${light}}` : ''}${dark ? `:root:root[data-theme="dark"]{${dark}}` : ''}`
}

export function pluginThemes(): readonly ThemeContribution[] {
  return registrySnapshot(THEMES_AREA) as readonly ThemeContribution[]
}

let chosen: string | null | undefined

export function activePluginThemeId(): string | null {
  if (chosen !== undefined) return chosen
  try { return window.localStorage.getItem(PLUGIN_THEME_KEY) } catch { return null }
}

function apply(): void {
  const id = activePluginThemeId()
  const theme = id ? pluginThemes().find((entry) => entry.data?.id === id) : undefined
  const css = theme ? themeCss(theme.data) : ''
  let style = document.getElementById(STYLE_ID)
  if (!css) { style?.remove(); return }
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
}

/** Null restores the built-in colours. */
export function setPluginTheme(id: string | null): void {
  chosen = id
  try {
    if (id) window.localStorage.setItem(PLUGIN_THEME_KEY, id)
    else window.localStorage.removeItem(PLUGIN_THEME_KEY)
  } catch { /* the choice still applies until reload */ }
  apply()
}

/** Re-applies when a theme plugin loads, changes or unloads. */
export function installPluginThemes(): () => void {
  chosen = undefined
  apply()
  return subscribeRegistryArea(THEMES_AREA, apply)
}
