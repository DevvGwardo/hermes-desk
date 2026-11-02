import { describe, expect, it } from 'vitest'
import {
  hermesAgentFilePath,
  hermesAgentsDir,
  renderHermesAgentMarkdown,
  shouldSyncAgentToHermes,
  syncDesktopAgentToHermes,
} from '../hermes-agents'
import type { Agent } from '../agents/types'

const travel: Agent = {
  id: 'inst_travel',
  name: 'TravelAgent',
  status: 'running',
  region: 'local',
  createdAt: '2026-08-13T12:00:00Z',
  summary: '',
  persona: { title: 'Travel', description: 'Flights, hotels, and trip planning.' },
}

describe('renderHermesAgentMarkdown', () => {
  it('writes a Claude-style agent file Hermes can load as subagent_type', () => {
    const file = renderHermesAgentMarkdown(travel)
    expect(file.slug).toBe('travel-agent')
    expect(file.filename).toBe('travel-agent.md')
    expect(file.body).toMatch(/^---\nname: travel-agent\n/)
    expect(file.body).toMatch(/description: .*Flights, hotels/)
    expect(file.body).toMatch(/maia_agent_id: inst_travel/)
    expect(file.body).toMatch(/maia_display_name: TravelAgent/)
    expect(file.body).toMatch(/You are TravelAgent/)
    expect(file.body).toMatch(/toolsets: \[web, file, terminal\]/)
  })

  it('writes role, created_at and the avatar color into metadata', () => {
    const file = renderHermesAgentMarkdown({
      ...travel,
      role: 'specialist',
      avatarColor: '#f97316',
    })
    expect(file.body).toMatch(/  maia_role: specialist\n/)
    expect(file.body).toMatch(/  maia_created_at: "2026-08-13T12:00:00\.000Z"\n/)
    expect(file.body).toMatch(/metadata:\n  color: "#f97316"\n/)
    expect(file.body).toMatch(/toolsets: \[web, file, terminal\]/)
  })

  it('falls back to slate and omits maia_role when unset', () => {
    const file = renderHermesAgentMarkdown(travel)
    expect(file.body).toMatch(/metadata:\n  color: slate\n/)
    expect(file.body).not.toMatch(/maia_role/)
  })

  it('leads an orchestrator body with its persona, then the coordinator text', () => {
    const file = renderHermesAgentMarkdown({
      ...travel,
      id: 'inst_ava',
      name: 'Ava',
      role: 'orchestrator',
      persona: { title: 'Chief of Staff', description: 'Coordinates specialists.' },
    })
    expect(file.body).toMatch(
      /\n---\nYou are Ava · Chief of Staff\. Stay in this role\. You coordinate other named specialists via delegate_task/,
    )
  })

  it('skips the persona for the default linked Nub orchestrator', () => {
    const file = renderHermesAgentMarkdown({
      ...travel,
      id: 'inst_nub',
      name: 'Nub',
      role: 'orchestrator',
      summary: 'Your paired Nub agent.',
      persona: { description: 'Your paired Nub agent.' },
    })
    expect(file.body).toMatch(/\n---\nYou coordinate other named specialists/)
    expect(file.body).not.toMatch(/You are Nub/)
  })

  it('writes mcp_servers with urls into the agent file (Grok plugin attach)', () => {
    const file = renderHermesAgentMarkdown({
      ...travel,
      mcpServers: [
        { name: 'github', url: 'https://mcp.github.com' },
        { name: 'brain' },
      ],
    })
    expect(file.body).toMatch(/mcp_servers:\n  - name: github\n    url: "https:\/\/mcp\.github\.com"/)
    expect(file.body).toMatch(/mcp_server_names: "github,brain"/)
    expect(file.body).toMatch(/Prefer tools from these MCP servers: github, brain/)
    expect(file.body).not.toMatch(/name: brain\n    url:/)
  })

  it('skips Hermes profiles and the built-in local agent', () => {
    expect(shouldSyncAgentToHermes({ ...travel, id: 'profile:research' })).toBe(false)
    expect(shouldSyncAgentToHermes({ ...travel, id: 'local-hermes' })).toBe(false)
    expect(shouldSyncAgentToHermes(travel)).toBe(true)
  })

  it('paths under $HERMES_HOME/agents', () => {
    expect(hermesAgentsDir('/Users/dev/.hermes')).toBe('/Users/dev/.hermes/agents')
    expect(hermesAgentFilePath('/Users/dev/.hermes', 'travel-agent')).toBe(
      '/Users/dev/.hermes/agents/travel-agent.md',
    )
  })

  it('writes through the injected writer', async () => {
    const written: Record<string, string> = {}
    const path = await syncDesktopAgentToHermes(travel, {
      home: '/tmp/.hermes',
      write: async (p, content) => {
        written[p] = content
      },
    })
    expect(path).toBe('/tmp/.hermes/agents/travel-agent.md')
    expect(written[path!]).toMatch(/name: travel-agent/)
  })

  it('rejects an obsolete hosted destination before writing', async () => {
    let wrote = false
    await expect(syncDesktopAgentToHermes(travel, {
      nub: { baseUrl: 'https://example.invalid' },
      home: '/fake/hermes',
      write: async () => { wrote = true },
    })).rejects.toThrow('Hosted agents are not supported')
    expect(wrote).toBe(false)
  })
})
