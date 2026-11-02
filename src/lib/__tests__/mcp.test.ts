import { describe, expect, it } from 'vitest'
import {
  explainMcpControlPlaneError,
  explainVmPluginActionError,
  normalizeMcpServers,
  splitMcpArgs,
} from '../mcp'

describe('mcp server normalize', () => {
  it('reads serve GET /api/mcp/servers summaries', () => {
    const servers = normalizeMcpServers({
      servers: [
        {
          name: 'github',
          transport: 'http',
          url: 'https://mcp.github.com',
          auth: 'oauth',
          enabled: true,
        },
        { name: 'brain', transport: 'stdio', command: 'npx', enabled: false },
      ],
    })
    expect(servers).toHaveLength(2)
    expect(servers[0]).toMatchObject({
      name: 'github',
      url: 'https://mcp.github.com',
      auth: 'oauth',
      enabled: true,
      transport: 'http',
    })
    expect(servers[1]).toMatchObject({ name: 'brain', enabled: false, transport: 'stdio' })
  })

  it('maps cookie-only 401 so the Plugins banner is actionable', () => {
    expect(explainMcpControlPlaneError('Unauthorized')).toMatch(/Re-link from Telegram/)
    expect(explainMcpControlPlaneError('unauthorized')).toMatch(/Re-link from Telegram/)
    expect(explainMcpControlPlaneError('HTTP 401')).toMatch(/Re-link from Telegram/)
    expect(explainMcpControlPlaneError('Instance has no IP yet')).toBe(
      'Instance has no IP yet',
    )
    expect(explainMcpControlPlaneError(undefined)).toBeUndefined()
  })

  it('does not dump the Mac hermes roster when Gmail is a VM plugin', () => {
    const leaked =
      "Server 'gmail' not found in config.\n  Available: agent-chat-room, brain, chrome-data, higgsfield"
    const msg = explainVmPluginActionError(leaked)
    expect(msg).toMatch(/agent VM/)
    expect(msg).not.toMatch(/chrome-data/)
    expect(explainVmPluginActionError('dashboard_unreachable')).toMatch(/agent box is down|unreachable/)
    expect(explainVmPluginActionError('needs_auth')).toMatch(/Tap Auth/)
  })

  it('splits stdio args the way hermes mcp add --args remainder expects', () => {
    expect(splitMcpArgs('mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp')).toEqual([
      'mcp-proxy-for-aws@latest',
      'https://aws-mcp.us-east-1.api.aws/mcp',
    ])
    expect(splitMcpArgs('  ')).toEqual([])
  })
})
