/**
 * Capabilities = hermes toolsets, in plain words.
 *
 * hermes routes (hermes_cli/web_routers/tools.py):
 *   GET /api/tools/toolsets                 → [{name,label,description,enabled,configured,…}]
 *   PUT /api/tools/toolsets/{name}          {enabled}
 *   PUT /api/tools/toolsets/{name}/env      {env: {KEY: value}}  (server validates keys)
 *   GET /api/tools/computer-use/status      → {installed, platform_supported, ready, …}
 *
 * Deliberately NOT called: /post-setup, /provider, /model, /config, terminal
 * backend routes — those are platform-managed.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { NEEDS_UPDATE_TEXT, restFailureText } from './agent-rest'

export interface ConnectField {
  key: string
  label: string
  secret: boolean
  placeholder?: string
}

export interface CapabilityCopy {
  title: string
  description: string
  /** Account the user connects themselves (BYO key). */
  connect?: { fields: ConnectField[]; help: string }
  /** Extra note shown under the description. */
  note?: string
  /**
   * Set up in another Settings section (Discord is a chat app). Always shown:
   * hermes reports these toolsets configured whether or not the chat app is
   * connected (no env requirement in tools_config.py), so the row can't know.
   */
  setupIn?: { pane: 'connections'; note: string; button: string }
}

/** Plain-language names for known toolsets. Unknown ones fall back to hermes' label. */
export const CAPABILITY_COPY: Record<string, CapabilityCopy> = {
  web: { title: 'Search the web', description: 'Look things up online and read web pages.' },
  browser: { title: 'Use a web browser', description: 'Open sites, click, fill in forms and scroll like a person would.' },
  terminal: { title: 'Run commands', description: 'Run programs and scripts on its private computer.' },
  file: { title: 'Work with files', description: 'Read, create and edit files in its workspace.' },
  code_execution: { title: 'Run code', description: 'Write and run small programs to calculate or transform data.' },
  vision: { title: 'Understand images', description: 'Look at pictures and screenshots you send and describe them.' },
  video: { title: 'Understand videos', description: 'Watch video clips and answer questions about them.' },
  image_gen: { title: 'Create images', description: 'Make pictures from a description.' },
  video_gen: { title: 'Create videos', description: 'Make short video clips from a description or image.' },
  tts: { title: 'Speak replies', description: 'Turn replies into spoken audio.' },
  stt: { title: 'Understand voice messages', description: 'Transcribe voice notes you send it.' },
  todo: { title: 'Plan with checklists', description: 'Break big jobs into a checklist and tick items off.' },
  clarify: { title: 'Ask before guessing', description: 'Ask you a quick question when a request is unclear.' },
  delegation: { title: 'Use helper agents', description: 'Hand parts of a job to helpers that work in parallel.' },
  memory: { title: 'Remember things', description: 'Keep useful facts about you and your work between chats.' },
  session_search: { title: 'Search past chats', description: 'Look back through earlier conversations for context.' },
  skills: { title: 'Use skills', description: 'Follow saved step-by-step playbooks for common tasks.' },
  cronjob: { title: 'Schedule routines', description: 'Set up jobs that run on a schedule, like a daily summary.' },
  context_engine: { title: 'Extra context tools', description: 'Tools provided by the active context engine.' },
  homeassistant: {
    title: 'Control your smart home',
    description: 'Turn lights and devices on or off through Home Assistant.',
    connect: {
      help: 'Paste your Home Assistant address and a long-lived access token (Profile → Security in Home Assistant).',
      fields: [
        { key: 'HASS_URL', label: 'Home Assistant address', secret: false, placeholder: 'https://home.example.com' },
        { key: 'HASS_TOKEN', label: 'Access token', secret: true },
      ],
    },
  },
  x_search: {
    title: 'Search X (Twitter)',
    description: 'Search posts on X for news and opinions.',
    connect: {
      help: 'Paste an xAI API key from console.x.ai to let your agent search X.',
      fields: [{ key: 'XAI_API_KEY', label: 'xAI API key', secret: true }],
    },
  },
  spotify: { title: 'Control Spotify', description: 'Play music, search and manage playlists.' },
  discord: {
    title: 'Read and post in Discord',
    description: 'Read messages, search members and start threads in your Discord server.',
    setupIn: { pane: 'connections', note: 'Works once Discord is connected in Chat apps.', button: 'Open Chat apps' },
  },
  discord_admin: {
    title: 'Manage your Discord server',
    description: 'List channels and roles, pin messages and assign roles.',
    setupIn: { pane: 'connections', note: 'Works once Discord is connected in Chat apps.', button: 'Open Chat apps' },
  },
  computer_use: { title: 'Use a desktop computer', description: 'Control a desktop with the mouse and keyboard in the background.' },
}

/**
 * Toolsets the app never shows: platform-managed, developer-only, or for
 * platforms Nub does not offer. `computer_use` is shown only when the agent
 * reports it installed.
 */
const HIDDEN = new Set([
  'kanban',
  'langfuse',
  'rl',
  'rl_training',
  'feishu',
  'feishu_doc',
  'feishu_drive',
  'yuanbao',
  'wecom',
  'dingtalk',
  'context_engine',
  'spotify', // loopback-only sign-in; cannot work on a hosted VM
])
const HIDDEN_PATTERNS = [/^terminal[_-]?backend/, /^rl[_-]/, /^feishu/, /^wecom/, /^yuanbao/, /langfuse/]

export function isHiddenToolset(name: string, opts: { computerUseAvailable?: boolean } = {}): boolean {
  const n = name.toLowerCase()
  if (n === 'computer_use') return !opts.computerUseAvailable
  if (HIDDEN.has(n)) return true
  return HIDDEN_PATTERNS.some((re) => re.test(n))
}

/** Env keys each toolset's Connect form may write (and nothing else). */
export const CONNECT_KEYS: Record<string, readonly string[]> = {
  homeassistant: ['HASS_URL', 'HASS_TOKEN'],
  x_search: ['XAI_API_KEY'],
}

export interface Capability {
  name: string
  title: string
  description: string
  note?: string
  setupIn?: CapabilityCopy['setupIn']
  enabled: boolean
  /** hermes says the required keys are present. */
  configured: boolean
  connect?: CapabilityCopy['connect']
}

function stripEmoji(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

export function toCapability(raw: unknown): Capability | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name : ''
  if (!name) return null
  const copy = CAPABILITY_COPY[name]
  const label = typeof r.label === 'string' ? stripEmoji(r.label) : ''
  return {
    name,
    title: copy?.title ?? (label || name),
    description: copy?.description ?? (typeof r.description === 'string' ? r.description : ''),
    ...(copy?.note ? { note: copy.note } : {}),
    ...(copy?.setupIn ? { setupIn: copy.setupIn } : {}),
    enabled: r.enabled === true,
    configured: r.configured !== false,
    ...(copy?.connect ? { connect: copy.connect } : {}),
  }
}

export interface CapabilitiesResult {
  ok: boolean
  capabilities: Capability[]
  error?: string
  needsUpdate?: boolean
}

async function computerUseAvailable(): Promise<boolean> {
  const res = await serveGetDetailed<{ installed?: boolean; platform_supported?: boolean; ready?: boolean }>(
    '/api/tools/computer-use/status',
  )
  const d = res.data
  return Boolean(d && (d.ready === true || (d.installed === true && d.platform_supported === true)))
}

export async function listCapabilities(): Promise<CapabilitiesResult> {
  const res = await serveGetDetailed<unknown>('/api/tools/toolsets')
  if (res.data === null || res.data === undefined) {
    const status = res.status ?? res.error?.status
    return {
      ok: false,
      capabilities: [],
      error: status === 404 ? NEEDS_UPDATE_TEXT : restFailureText({ status, error: res.error?.message }, 'Could not load skills.'),
      ...(status === 404 ? { needsUpdate: true } : {}),
    }
  }
  const rows = Array.isArray(res.data)
    ? res.data
    : Array.isArray((res.data as { toolsets?: unknown[] }).toolsets)
      ? (res.data as { toolsets: unknown[] }).toolsets
      : []
  const hasComputerUse = rows.some((r) => (r as { name?: unknown })?.name === 'computer_use')
  const cuAvailable = hasComputerUse ? await computerUseAvailable() : false
  const capabilities = rows
    .map(toCapability)
    .filter((c): c is Capability => c !== null && !isHiddenToolset(c.name, { computerUseAvailable: cuAvailable }))
  return { ok: true, capabilities }
}

export async function setCapabilityEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const res = await serveSend('PUT', `/api/tools/toolsets/${encodeURIComponent(name)}`, { enabled })
  if (!res.ok) return { ok: false, error: restFailureText(res, 'Could not change this skill.') }
  return { ok: true }
}

/**
 * Save a Connect form. Only the keys in CONNECT_KEYS for that toolset are
 * sent; blank values are dropped (hermes treats blank as "leave unchanged").
 */
export async function saveCapabilityConnection(
  name: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const allowed = CONNECT_KEYS[name]
  if (!allowed) return { ok: false, error: 'This skill has nothing to connect.' }
  const env: Record<string, string> = {}
  for (const key of allowed) {
    const v = values[key]
    if (typeof v === 'string' && v.trim()) env[key] = v.trim()
  }
  if (Object.keys(env).length === 0) return { ok: false, error: 'Fill in at least one field.' }
  const res = await serveSend('PUT', `/api/tools/toolsets/${encodeURIComponent(name)}/env`, { env })
  if (!res.ok) return { ok: false, error: restFailureText(res, 'Could not save the connection.') }
  return { ok: true }
}
