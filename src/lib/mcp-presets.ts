/**
 * Built-in plugin marketplace — Grok Bot Plugins analogue.
 *
 * Names / categories come from Cursor's public ListMarketplacePlugins
 * catalog (the same API Grok Bot calls). Transport URLs are the vendors'
 * public official MCP endpoints (or their public GitHub mcp.json), not
 * Cursor proprietary install payloads. Skills-only / Canvas plugins are
 * omitted — they are not Hermes MCP servers.
 */

import type { McpAddOpts } from './mcp'

export type McpPresetCategory =
  | 'featured'
  | 'agent-orchestration'
  | 'customer-support'
  | 'design'
  | 'productivity'
  | 'infrastructure'

export interface McpPreset {
  /** Hermes server name (`hermes mcp add <name>`). */
  id: string
  displayName: string
  description: string
  category: McpPresetCategory
  homepage?: string
  auth?: 'oauth' | 'none'
  url?: string
  command?: string
  args?: string
}

export const MCP_PRESET_CATEGORY_LABEL: Record<McpPresetCategory, string> = {
  featured: 'Featured',
  'agent-orchestration': 'Agent Orchestration',
  'customer-support': 'Customer Support',
  design: 'Design',
  productivity: 'Productivity',
  infrastructure: 'Infrastructure',
}

export const MCP_PRESET_CATEGORY_ORDER: McpPresetCategory[] = [
  'featured',
  'agent-orchestration',
  'customer-support',
  'design',
  'productivity',
  'infrastructure',
]

/** Grok marketplace collapse: show 4, then "Show N more" (unless ≤5 total). */
export const MCP_PRESET_COLLAPSE_VISIBLE = 4

export const MCP_PRESETS: McpPreset[] = [
  // Featured — public catalog curatedCategoryKeys FEATURED (6).
  {
    id: 'gmail',
    displayName: 'Gmail',
    description: "Connect to Gmail via Google's remote MCP server.",
    category: 'featured',
    homepage: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    auth: 'oauth',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
  },
  {
    id: 'google-calendar',
    displayName: 'Google Calendar',
    description: "Connect to Google Calendar via Google's remote MCP server.",
    category: 'featured',
    homepage: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    auth: 'oauth',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
  },
  {
    id: 'google-drive',
    displayName: 'Google Drive',
    description: "Connect to Google Drive via Google's remote MCP server.",
    category: 'featured',
    homepage: 'https://developers.google.com/workspace/drive/api/guides/configure-mcp-server',
    auth: 'oauth',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
  },
  {
    id: 'granola',
    displayName: 'Granola',
    description: 'Search Granola meeting notes and transcripts.',
    category: 'featured',
    homepage: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
    auth: 'oauth',
    url: 'https://mcp.granola.ai/mcp',
  },
  {
    id: 'slack',
    displayName: 'Slack',
    description: 'Read and post Slack messages, mentions, and channels.',
    category: 'featured',
    homepage: 'https://docs.slack.dev/ai/mcp/',
    auth: 'oauth',
    url: 'https://mcp.slack.com/mcp',
  },
  {
    id: 'notion',
    displayName: 'Notion',
    description: 'Read and write Notion pages and databases.',
    category: 'featured',
    homepage: 'https://developers.notion.com/docs/mcp',
    auth: 'oauth',
    url: 'https://mcp.notion.com/mcp',
  },

  // Agent Orchestration — MCP-capable rows from the public catalog.
  {
    id: 'composio',
    displayName: 'Composio',
    description: 'Connect 1000+ apps through Composio’s hosted MCP.',
    category: 'agent-orchestration',
    homepage: 'https://composio.dev',
    auth: 'oauth',
    url: 'https://connect.composio.dev/mcp',
  },
  {
    id: 'aws-agents',
    displayName: 'AWS Agents',
    description: 'Build, deploy, and operate AI agents on AWS Bedrock AgentCore.',
    category: 'agent-orchestration',
    homepage: 'https://awslabs.github.io/mcp/servers/amazon-bedrock-agentcore-mcp-server',
    auth: 'none',
    command: 'uvx',
    args: 'awslabs.amazon-bedrock-agentcore-mcp-server@latest',
  },
  {
    id: 'atlan',
    displayName: 'Atlan',
    description: 'Search and act on Atlan metadata through Atlan MCP.',
    category: 'agent-orchestration',
    homepage: 'https://docs.atlan.com',
    auth: 'oauth',
    url: 'https://mcp.atlan.com/mcp',
  },
  {
    id: 'opsera',
    displayName: 'Opsera',
    description: 'DevSecOps workflows via Opsera’s hosted MCP.',
    category: 'agent-orchestration',
    homepage: 'https://www.opsera.io',
    auth: 'oauth',
    url: 'https://agent.opsera.ai/mcp',
  },
  {
    id: 'aws-sagemaker',
    displayName: 'AWS SageMaker',
    description: 'Talk to AWS MCP (SageMaker and related AWS APIs) through the AWS MCP proxy.',
    category: 'agent-orchestration',
    homepage: 'https://github.com/awslabs/mcp-proxy-for-aws',
    auth: 'none',
    command: 'uvx',
    args: 'mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp',
  },
  {
    id: 'firetiger',
    displayName: 'Firetiger',
    description: 'Firetiger Cloud MCP for logs, traces, and investigations.',
    category: 'agent-orchestration',
    homepage: 'https://www.firetiger.com',
    auth: 'oauth',
    url: 'https://api.cloud.firetiger.com/mcp/v1',
  },
  {
    id: 'context7',
    displayName: 'Context7',
    description: 'Up-to-date library docs for the packages in your prompt.',
    category: 'agent-orchestration',
    homepage: 'https://context7.com',
    auth: 'none',
    url: 'https://mcp.context7.com/mcp',
  },

  // Customer Support
  {
    id: 'intercom',
    displayName: 'Intercom',
    description: 'Search and update Intercom conversations and customers.',
    category: 'customer-support',
    homepage: 'https://developers.intercom.com',
    auth: 'oauth',
    url: 'https://mcp.intercom.com/mcp',
  },
  {
    id: 'plain',
    displayName: 'Plain',
    description: 'Support inboxes and threads via Plain’s remote MCP.',
    category: 'customer-support',
    homepage: 'https://www.plain.com',
    auth: 'oauth',
    url: 'https://mcp.plain.com/mcp',
  },

  // Design
  {
    id: 'canva',
    displayName: 'Canva',
    description: 'Create and edit Canva designs through Canva MCP.',
    category: 'design',
    homepage: 'https://www.canva.com/developers/docs/mcp-server/',
    auth: 'oauth',
    url: 'https://mcp.canva.com/mcp',
  },

  // Productivity (Grok also lists Linear here; Slack/Notion are Featured.)
  {
    id: 'linear',
    displayName: 'Linear',
    description: 'Find, create, and update Linear issues, projects, and comments.',
    category: 'productivity',
    homepage: 'https://linear.app/docs/mcp',
    auth: 'oauth',
    url: 'https://mcp.linear.app/mcp',
  },

  // Infrastructure
  {
    id: 'github',
    displayName: 'GitHub',
    description: 'Repos, PRs, issues, and Actions via GitHub’s official MCP server.',
    category: 'infrastructure',
    homepage: 'https://github.com/github/github-mcp-server',
    auth: 'oauth',
    url: 'https://api.githubcopilot.com/mcp/',
  },
  {
    id: 'sentry',
    displayName: 'Sentry',
    description: 'Issues, projects, and DSNs via Sentry’s official MCP server.',
    category: 'infrastructure',
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
    auth: 'oauth',
    url: 'https://mcp.sentry.dev/mcp',
  },
  {
    id: 'memory',
    displayName: 'Memory',
    description: 'Persistent knowledge graph the agent grows on the VM (no sign-in).',
    category: 'agent-orchestration',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    auth: 'none',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-memory',
  },
  {
    id: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    description: 'Step-by-step reasoning scaffold. Runs on the agent VM (no sign-in).',
    category: 'agent-orchestration',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    auth: 'none',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sequential-thinking',
  },
]

export function addOptsFromPreset(preset: McpPreset): McpAddOpts | null {
  const auth = preset.auth === 'oauth' ? ('oauth' as const) : undefined
  if (preset.url?.trim()) return { url: preset.url.trim(), ...(auth ? { auth } : {}) }
  if (preset.command?.trim()) {
    return {
      command: preset.command.trim(),
      ...(preset.args?.trim() ? { args: preset.args.trim() } : {}),
      ...(auth ? { auth } : {}),
    }
  }
  return null
}

export function filterPresets(query: string, presets: McpPreset[] = MCP_PRESETS): McpPreset[] {
  const q = query.trim().toLowerCase()
  if (!q) return presets
  return presets.filter((p) => {
    const hay = [p.id, p.displayName, p.description, p.category].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

export function groupPresetsByCategory(
  presets: McpPreset[],
): { category: McpPresetCategory; label: string; items: McpPreset[] }[] {
  return MCP_PRESET_CATEGORY_ORDER.map((category) => ({
    category,
    label: MCP_PRESET_CATEGORY_LABEL[category],
    items: presets.filter((p) => p.category === category),
  })).filter((g) => g.items.length > 0)
}

export function collapsePresetSection<T>(
  items: T[],
  expanded: boolean,
  visibleCount = MCP_PRESET_COLLAPSE_VISIBLE,
): { visible: T[]; hiddenCount: number } {
  if (expanded || items.length <= visibleCount + 1) {
    return { visible: items, hiddenCount: 0 }
  }
  return { visible: items.slice(0, visibleCount), hiddenCount: items.length - visibleCount }
}
