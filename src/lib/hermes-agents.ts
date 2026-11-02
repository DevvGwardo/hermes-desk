/**
 * Persist desktop-created agents as markdown personas on the VM
 * (`$HERMES_HOME/agents/<slug>.md`, Claude Code `~/.claude/agents/*.md`
 * format). Hydrate reads them back to rebuild the roster on other devices.
 *
 * hermes-agent does NOT load these for delegation: its delegate_task has no
 * `subagent_type` and there is no `tools/agent_types.py` (checked against
 * the maiavm fork pin, v2026.8.16 and upstream main, 2026-09-28). The
 * Chief carries each persona in the task it writes instead (peer-roster.ts
 * peerRosterBlock).
 */

import type { Agent } from './agents/types'
import { writeText } from './fs'
import { slugifyAgentName, peerToken, isDefaultLinkedAgent } from './peer-roster'

export interface HermesAgentFile {
  slug: string
  filename: string
  body: string
}

function yamlEscape(value: string): string {
  if (value === '') return '""'
  if (/[:#{}[\],&*?!<>=@`'"]/.test(value) || value.includes('\n')) {
    return JSON.stringify(value)
  }
  return value
}

export function shouldSyncAgentToHermes(agent: Agent): boolean {
  if (agent.id.startsWith('profile:')) return false
  if (agent.id === 'local-hermes') return false
  return true
}

/** Hermes agent-file `mcp_servers` only accepts `{name, url}` dicts. */
export function normalizeAgentMcpServers(
  raw: Agent['mcpServers'] | undefined,
): { name: string; url?: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { name: string; url?: string }[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    out.push(url ? { name, url } : { name })
  }
  return out
}

function renderMcpServersYaml(servers: { name: string; url?: string }[]): string[] {
  const withUrl = servers.filter((s) => s.url)
  return withUrl.flatMap((s) => [
    `  - name: ${yamlEscape(s.name)}`,
    `    url: ${yamlEscape(s.url!)}`,
  ])
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export function renderHermesAgentMarkdown(agent: Agent): HermesAgentFile {
  const slug = peerToken(agent) || slugifyAgentName(agent.name)
  const title = agent.persona?.title?.trim()
  const desc =
    agent.persona?.description?.trim() ||
    agent.summary.trim() ||
    `${agent.name} specialist`
  const ident = [agent.name, title].filter(Boolean).join(' · ')
  const personaLine = `You are ${ident}. Stay in this role.`
  const coordinatorLine =
    'You coordinate other named specialists via delegate_task. Summarize their results for the user. Never claim those agents are missing.'
  // A Chief keeps its own persona (custom name/title) ahead of the
  // coordinator text; only the default linked Nub stub skips it.
  const roleLine =
    agent.role === 'orchestrator'
      ? isDefaultLinkedAgent(agent)
        ? coordinatorLine
        : `${personaLine} ${coordinatorLine}`
      : personaLine
  const createdAt = isoOrNull(agent.createdAt)
  const mcp = normalizeAgentMcpServers(agent.mcpServers)
  const mcpYaml = renderMcpServersYaml(mcp)
  const mcpNames = mcp.map((s) => s.name).join(',')
  const body = [
    '---',
    `name: ${yamlEscape(slug)}`,
    `description: ${yamlEscape(desc)}`,
    'toolsets: [web, file, terminal]',
    'speed: standard',
    ...(mcpYaml.length > 0 ? ['mcp_servers:'] : []),
    ...mcpYaml,
    'metadata:',
    `  color: ${agent.avatarColor ? yamlEscape(agent.avatarColor) : 'slate'}`,
    '  category: desktop',
    `  maia_agent_id: ${yamlEscape(agent.id)}`,
    `  maia_display_name: ${yamlEscape(agent.name)}`,
    ...(title ? [`  maia_title: ${yamlEscape(title)}`] : []),
    ...(agent.role ? [`  maia_role: ${agent.role}`] : []),
    ...(createdAt ? [`  maia_created_at: ${yamlEscape(createdAt)}`] : []),
    ...(agent.avatarShape ? [`  maia_avatar_shape: ${yamlEscape(agent.avatarShape)}`] : []),
    ...(agent.avatarColor ? [`  maia_avatar_color: ${yamlEscape(agent.avatarColor)}`] : []),
    ...(agent.avatarEyeColor ? [`  maia_avatar_eye_color: ${agent.avatarEyeColor}`] : []),
    ...(mcpNames ? [`  mcp_server_names: ${yamlEscape(mcpNames)}`] : []),
    'version: 1',
    '---',
    roleLine,
    '',
    desc,
    '',
    ...(mcp.length > 0
      ? [`Prefer tools from these MCP servers: ${mcp.map((s) => s.name).join(', ')}.`, '']
      : []),
    'When finished, return a concise summary of what you found. Do not include intermediate tool output — only the final synthesis.',
    '',
  ].join('\n')
  return { slug, filename: `${slug}.md`, body }
}

export function hermesAgentsDir(hermesHome: string): string {
  return `${hermesHome.replace(/[/\\]+$/, '')}/agents`
}

export function hermesAgentFilePath(hermesHome: string, slug: string): string {
  return `${hermesAgentsDir(hermesHome)}/${slug}.md`
}

export async function resolveHermesHome(): Promise<string | null> {
  const w = window as unknown as {
    nubAgent?: { serveConfig?: () => Promise<{ hermesHome?: string }> }
  }
  try {
    const cfg = await w.nubAgent?.serveConfig?.()
    if (cfg?.hermesHome?.trim()) return cfg.hermesHome.replace(/[/\\]+$/, '')
  } catch {
    /* browser / no bridge */
  }
  return null
}

export type SyncDesktopAgentOpts = {
  home?: string
  write?: (path: string, content: string) => Promise<void>
  /** Legacy caller shape. A non-null hosted connection is explicitly rejected. */
  nub?: { baseUrl: string } | null
  /** When true, missing home / write failure throws instead of returning null. */
  required?: boolean
}

export async function syncDesktopAgentToHermes(
  agent: Agent,
  opts?: SyncDesktopAgentOpts,
): Promise<string | null> {
  if (!shouldSyncAgentToHermes(agent)) return null
  if (opts?.nub) throw new Error('Hosted agents are not supported by Hermes Desk')
  const home = opts?.home ?? await resolveHermesHome()
  const required = opts?.required ?? false
  if (!home) {
    if (required) throw new Error('Cannot sync agent: Hermes home unavailable')
    return null
  }
  const file = renderHermesAgentMarkdown(agent)
  const dest = hermesAgentFilePath(home, file.slug)
  const write = opts?.write ?? writeText
  await write(dest, file.body)
  return dest
}

export async function syncRosterToHermes(
  agents: Agent[],
  opts?: SyncDesktopAgentOpts,
): Promise<string[]> {
  const written: string[] = []
  for (const agent of agents) {
    try {
      const path = await syncDesktopAgentToHermes(agent, opts)
      if (path) written.push(path)
    } catch {
      /* boot hydrate is best-effort — create/update awaits and surfaces errors */
    }
  }
  return written
}
