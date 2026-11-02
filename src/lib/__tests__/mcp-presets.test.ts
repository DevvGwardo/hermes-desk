import { describe, expect, it } from 'vitest'
import {
  MCP_PRESETS,
  addOptsFromPreset,
  collapsePresetSection,
  filterPresets,
  groupPresetsByCategory,
} from '../mcp-presets'

describe('mcp presets', () => {
  it('has unique ids and an install transport on every row', () => {
    const ids = MCP_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of MCP_PRESETS) {
      expect(addOptsFromPreset(p)).not.toBeNull()
    }
  })

  it('keeps Grok featured plugins on official vendor MCP URLs', () => {
    const featured = MCP_PRESETS.filter((p) => p.category === 'featured').map((p) => p.id)
    expect(featured).toEqual([
      'gmail',
      'google-calendar',
      'google-drive',
      'granola',
      'slack',
      'notion',
    ])
    const byId = Object.fromEntries(MCP_PRESETS.map((p) => [p.id, p]))
    expect(byId.gmail?.url).toBe('https://gmailmcp.googleapis.com/mcp/v1')
    expect(byId['google-calendar']?.url).toBe('https://calendarmcp.googleapis.com/mcp/v1')
    expect(byId['google-drive']?.url).toBe('https://drivemcp.googleapis.com/mcp/v1')
    expect(byId.granola?.url).toBe('https://mcp.granola.ai/mcp')
    expect(byId.slack?.url).toBe('https://mcp.slack.com/mcp')
    expect(byId.notion?.url).toBe('https://mcp.notion.com/mcp')
  })

  it('wires Agent Orchestration / Customer Support public MCP endpoints', () => {
    const byId = Object.fromEntries(MCP_PRESETS.map((p) => [p.id, p]))
    expect(byId.composio?.url).toBe('https://connect.composio.dev/mcp')
    expect(byId.atlan?.url).toBe('https://mcp.atlan.com/mcp')
    expect(byId.intercom?.url).toBe('https://mcp.intercom.com/mcp')
    expect(byId.plain?.url).toBe('https://mcp.plain.com/mcp')
    expect(byId['aws-sagemaker']?.command).toBe('uvx')
    expect(byId['aws-sagemaker']?.args).toContain('mcp-proxy-for-aws@latest')
    expect(addOptsFromPreset(byId.gmail!)?.auth).toBe('oauth')
    expect(addOptsFromPreset(byId['aws-agents']!)?.command).toBe('uvx')
  })

  it('filters and groups like the Grok marketplace sections', () => {
    const gmail = filterPresets('gmail')
    expect(gmail.map((p) => p.id)).toEqual(['gmail'])
    const groups = groupPresetsByCategory(MCP_PRESETS)
    expect(groups.map((g) => g.label)).toEqual([
      'Featured',
      'Agent Orchestration',
      'Customer Support',
      'Design',
      'Productivity',
      'Infrastructure',
    ])
  })

  it('collapses long sections the way Grok does (4 visible unless ≤5)', () => {
    const six = [1, 2, 3, 4, 5, 6]
    expect(collapsePresetSection(six, false)).toEqual({ visible: [1, 2, 3, 4], hiddenCount: 2 })
    expect(collapsePresetSection(six, true).hiddenCount).toBe(0)
    expect(collapsePresetSection([1, 2, 3, 4, 5], false).hiddenCount).toBe(0)
  })
})
