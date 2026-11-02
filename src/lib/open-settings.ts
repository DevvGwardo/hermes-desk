/** Local settings sections. Old local deep links still resolve; platform ones do not. */
export type SettingsSection = 'general' | 'agents' | 'workspace' | 'privacy' | 'appearance' | 'advanced'
export type SettingsPaneRequest = SettingsSection | 'hermes' | 'secrets' | 'computer' | 'diagnostics' | 'skills' | 'capabilities' | 'troubleshooting' | 'plugins'
  // CONTRACT: source compatibility until integrate/cleanup remove these call sites.
  // These values are NOT accepted by the router/event allowlist.
  | 'usage' | 'connections' | 'account' | 'billing' | 'keys'
export type SettingsFocus = string | null
export type PlatformPane = never
export const isPlatformPane = (_value: unknown): _value is PlatformPane => false

const panes = new Set<string>([
  'hermes', 'agents', 'workspace', 'secrets', 'computer', 'diagnostics', 'appearance',
  'general', 'skills', 'capabilities', 'privacy', 'troubleshooting', 'plugins', 'advanced',
])
const aliases = {
  hermes: { section: 'advanced', focus: 'hermes-home' },
  diagnostics: { section: 'advanced', focus: 'connector-log' },
  troubleshooting: { section: 'advanced', focus: 'connector-log' },
  secrets: { section: 'privacy', focus: 'onepassword' },
  computer: { section: 'privacy', focus: 'pip' },
  skills: { section: 'agents', focus: 'agent-links' },
  capabilities: { section: 'agents', focus: 'approvals' },
  plugins: { section: 'agents', focus: 'plugins' },
  usage: { section: 'general', focus: null }, connections: { section: 'general', focus: null },
  account: { section: 'general', focus: null }, billing: { section: 'general', focus: null }, keys: { section: 'general', focus: null },
} as const

export function settingsSectionFor(pane: SettingsPaneRequest): { section: SettingsSection; focus: SettingsFocus } {
  return pane in aliases ? aliases[pane as keyof typeof aliases] : { section: pane as SettingsSection, focus: null }
}
export function isSettingsPaneRequest(value: unknown): value is SettingsPaneRequest {
  return typeof value === 'string' && panes.has(value)
}

const EVENT = 'nub:open-settings'
export function requestOpenSettings(pane?: SettingsPaneRequest): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: { pane } }))
}
export function onOpenSettingsRequest(callback: (pane: SettingsPaneRequest | undefined) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event) => {
    const pane = (event as CustomEvent<{ pane?: unknown }>).detail?.pane
    callback(isSettingsPaneRequest(pane) ? pane : undefined)
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
