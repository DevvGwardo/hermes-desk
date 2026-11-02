/**
 * Plugin keyboard shortcuts. A plugin may only bind ⌘⇧<key> or ⌘⌥<key>, so
 * it can never take over an app shortcut, typing, or the emergency stop.
 */
import type { KeybindContribution } from '../lib/plugins/types'
import { KEYBINDS_AREA } from '../lib/plugins/types'
import { registrySnapshot, subscribeRegistryArea } from './areas'
import { logger } from '../lib/logger'

export interface ParsedKeybind { shift: boolean; alt: boolean; key: string }

/** App and window-menu shortcuts that already use ⌘⇧ or ⌘⌥. */
const RESERVED = new Set(['shift+t', 'shift+h', 'shift+z', 'shift+[', 'shift+]', 'shift+.', 'alt+.'])

/** Null when the binding is malformed or reserved. */
export function parseKeybind(raw: unknown): ParsedKeybind | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const parts = raw.toLowerCase().split('+').map((part) => part.trim())
  const key = parts.pop()
  const mods = new Set(parts)
  if (!key || !/^(?:[a-z0-9]|[[\];',./`=-])$/.test(key)) return null
  if (!(mods.has('mod') || mods.has('cmd') || mods.has('meta') || mods.has('ctrl'))) return null
  if ([...mods].some((mod) => !['mod', 'cmd', 'meta', 'ctrl', 'shift', 'alt', 'option'].includes(mod))) return null
  const shift = mods.has('shift')
  const alt = mods.has('alt') || mods.has('option')
  if (!shift && !alt) return null
  const signature = `${shift ? 'shift+' : ''}${alt ? 'alt+' : ''}${key}`
  return RESERVED.has(signature) ? null : { shift, alt, key }
}

/** Physical key, so ⌥ and ⇧ layouts (¬, Ω, ?) still match the binding. */
function eventKey(event: KeyboardEvent): string {
  const code = event.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const named: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backquote: '`', Equal: '=', Minus: '-' }
  return named[code] ?? event.key.toLowerCase()
}

export function matchesKeybind(event: KeyboardEvent, bind: ParsedKeybind): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey === bind.shift && event.altKey === bind.alt &&
    eventKey(event) === bind.key
}

/** First registered plugin wins a duplicate binding. */
export function handlePluginKeybind(event: KeyboardEvent, binds: readonly KeybindContribution[]): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false
  for (const bind of binds) {
    const parsed = parseKeybind(bind.data?.keys)
    if (!parsed || !matchesKeybind(event, parsed)) continue
    event.preventDefault()
    try { bind.data.run() } catch (error) { logger.warn('[plugins] keybind failed', error) }
    return true
  }
  return false
}

export function installPluginKeybinds(): () => void {
  let binds = registrySnapshot(KEYBINDS_AREA) as readonly KeybindContribution[]
  const stop = subscribeRegistryArea(KEYBINDS_AREA, () => {
    binds = registrySnapshot(KEYBINDS_AREA) as readonly KeybindContribution[]
  })
  // Bubble phase: any app handler that already took the key wins.
  const onKey = (event: KeyboardEvent) => { if (binds.length) handlePluginKeybind(event, binds) }
  window.addEventListener('keydown', onKey)
  return () => { stop(); window.removeEventListener('keydown', onKey) }
}
