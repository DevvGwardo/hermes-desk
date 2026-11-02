import type { SettingsSection } from './open-settings'

export interface SettingsEntry {
  id: string
  section: SettingsSection
  title: string
  hint: string
  keywords?: string[]
  advanced?: boolean
}

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; lead: string }> = [
  { id: 'general', label: 'General', lead: 'Everyday preferences and connection status.' },
  { id: 'agents', label: 'Agents', lead: 'Arrange and hide profiles without deleting them.' },
  { id: 'workspace', label: 'Workspace', lead: 'Isolated browser lanes on this Mac.' },
  { id: 'privacy', label: 'Privacy & permissions', lead: 'Browser access, computer permissions, and native credential consent.' },
  { id: 'appearance', label: 'Appearance', lead: 'How Hermes Desk looks and which sessions it shows.' },
  { id: 'advanced', label: 'Advanced', lead: 'Local host setup and diagnostics. Nothing is uploaded.' },
]

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { id: 'connection', section: 'general', title: 'Connection status', hint: 'Reconnect local Hermes.', keywords: ['offline', 'retry'] },
  { id: 'home-on-launch', section: 'general', title: 'Home page', hint: 'Open Home instead of resuming work on launch.', keywords: ['start page', 'launch', 'activity'] },
  { id: 'notifications', section: 'general', title: 'Notify me', hint: 'Local reply, approval, and routine alerts.' },
  { id: 'sounds', section: 'general', title: 'Reply sounds', hint: 'A local chime when a reply finishes.' },
  { id: 'hermes-home', section: 'advanced', title: 'Hermes home', hint: 'The local Hermes directory.', keywords: ['path', 'profiles'], advanced: true },
  { id: 'serve', section: 'advanced', title: 'Hermes serve', hint: 'Spawn locally, port, and restart. External attachment is blocked.', keywords: ['offline', 'connect', 'restart'], advanced: true },
  { id: 'gateway', section: 'advanced', title: 'Gateway health and version', hint: 'Read-only gateway health. Messaging is not connected.', advanced: true },
  { id: 'scratch', section: 'agents', title: 'Show scratch profiles', hint: 'Include session-* profiles in the sidebar.' },
  { id: 'agent-order', section: 'agents', title: 'Agent order and visibility', hint: 'Move, hide, or restore profiles.', keywords: ['restore hidden', 'bots'] },
  { id: 'profile-meta', section: 'agents', title: 'Display name, avatar, and model', hint: 'Profile metadata and the read-only default model.' },
  { id: 'approvals', section: 'agents', title: 'Approvals', hint: 'Local Hermes tool approval mode.', keywords: ['ask first', 'smart', 'always allow', 'permissions'] },
  { id: 'timezone', section: 'agents', title: 'Time zone', hint: 'The clock local Hermes routines use.' },
  { id: 'agent-links', section: 'agents', title: 'Memory and skills', hint: 'Open local profile memory or skills.' },
  { id: 'plugins', section: 'agents', title: 'Desktop plugins', hint: 'The local plugin inventory.' },
  { id: 'controller', section: 'workspace', title: 'Agent browsing', hint: 'Let each agent browse and render bounded Generated UI through Hermes Desk MCP. Confirm, back up, then restart its Hermes session.', keywords: ['browser', 'controller', 'mcp', 'enable', 'disable', 'genui', 'generated ui', 'render_ui', 'render ui', 'widgets', 'charts', 'checklist'] },
  { id: 'url-policy', section: 'workspace', title: 'Allowed and blocked websites', hint: 'Per-agent hostname allow and deny lists.', keywords: ['domains', 'policy'] },
  { id: 'tab-limits', section: 'workspace', title: 'Tab limits', hint: 'Agent tabs and total live views.' },
  { id: 'downloads', section: 'workspace', title: 'Downloads folder', hint: 'Agent downloads stay on this Mac.' },
  { id: 'search-engine', section: 'workspace', title: 'Search engine', hint: 'Which engine the browser URL bar uses.' },
  { id: 'clear-lane', section: 'workspace', title: 'Clear agent lane data', hint: 'Clear one agent partition, never another lane.' },
  { id: 'tool-permissions', section: 'privacy', title: 'Tool permissions', hint: 'Approval scope and profile policy.', keywords: ['grant', 'revoke', 'approval'] },
  { id: 'browser-permissions', section: 'privacy', title: 'Browser access', hint: 'Isolated browser lanes and per-agent website policies.' },
  { id: 'onepassword', section: 'privacy', title: '1Password', hint: 'Native credential provider status and default vault.' },
  { id: 'origin-approvals', section: 'privacy', title: 'Per-origin approvals', hint: 'Credential approvals for specific websites.', keywords: ['revoke', 'secret'] },
  { id: 'pip', section: 'privacy', title: 'Computer PiP', hint: 'Completed-capture source, refresh preference, docked or floating.' },
  { id: 'render-capture', section: 'advanced', title: 'Render troubleshooting', hint: 'Opt-in, bounded memory-only render and scroll metadata.', keywords: ['crash', 'react', 'capture'], advanced: true },
  { id: 'serve-stderr', section: 'advanced', title: 'Serve stderr tail', hint: 'Redacted local serve errors.', advanced: true },
  { id: 'connector-log', section: 'advanced', title: 'Connector status', hint: 'Honest gateway, serve, and browser health.', advanced: true },
  { id: 'audit', section: 'advanced', title: 'Audit log', hint: 'Agent actions, origins, results, and duration.', advanced: true },
  { id: 'debug-bundle', section: 'advanced', title: 'Copy debug bundle', hint: 'A redacted local bundle. No upload.', advanced: true },
  { id: 'theme', section: 'appearance', title: 'Theme', hint: 'Light or dark.', keywords: ['dark mode', 'light mode', 'colors'] },
  { id: 'design', section: 'appearance', title: 'Design preset', hint: 'Preview a curated look for the whole app.', keywords: ['preset', 'accent', 'canvas', 'colours', 'design'] },
  { id: 'design-custom', section: 'appearance', title: 'Custom design', hint: 'Accent, canvas, card, text, radius, density, font, motion.', keywords: ['accent', 'canvas', 'radius', 'density', 'font', 'motion'] },
  { id: 'design-preview', section: 'appearance', title: 'Live preview and contrast', hint: 'What the preset looks like, and any WCAG AA pairing that fails.', keywords: ['contrast', 'wcag', 'accessibility', 'readable'] },
  { id: 'design-save', section: 'appearance', title: 'Apply and save a design', hint: 'Apply, revert, reset, and choose every profile or one profile.', keywords: ['apply', 'revert', 'reset', 'scope', 'profile'] },
  { id: 'design-transfer', section: 'appearance', title: 'Export or import a preset', hint: 'Versioned preset JSON, validated on import.', keywords: ['json', 'export', 'import', 'file', 'preset'] },
  { id: 'messenger-skin', section: 'appearance', title: 'Messenger skin', hint: 'Messenger or classic chat appearance.' },
  { id: 'session-sources', section: 'appearance', title: 'Sidebar session sources', hint: 'Desktop, CLI, or cron sessions.' },
]

const norm = (value: string) => value.toLowerCase().replace(/[’'&]/g, ' ').replace(/\s+/g, ' ').trim()
const stopWords = new Set(['the', 'a', 'an', 'my', 'your', 'to', 'of', 'and', 'in', 'on', 'for', 'with', 'how', 'do', 'i'])

export function searchSettings(query: string, index: readonly SettingsEntry[] = SETTINGS_INDEX): SettingsEntry[] {
  const all = norm(query).split(' ').filter(Boolean)
  const meaningful = all.filter((word) => !stopWords.has(word))
  const words = meaningful.length ? meaningful : all
  if (!words.length) return []
  return index.map((entry, at) => {
    const title = norm(entry.title)
    const keys = norm((entry.keywords ?? []).join(' '))
    const hint = norm(`${entry.hint} ${sectionLabel(entry.section)}`)
    let score = 0
    for (const word of words) {
      if (title.includes(word)) score += 3
      else if (keys.includes(word)) score += 2
      else if (hint.includes(word)) score++
      else return { entry, at, score: 0 }
    }
    return { entry, at, score }
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.at - b.at).map((item) => item.entry)
}

export const sectionLabel = (id: SettingsSection): string => SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? id
