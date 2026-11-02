import { describe, expect, it } from 'vitest'
import { assertOwnAgentFile } from '../avatar-tool'

const agentFile = (...lines: string[]) => ['---', ...lines, '---', '', 'Body'].join('\n')

describe('assertOwnAgentFile', () => {
  it('reads maia_agent_id from frontmatter, falling back to inst_<slug>', () => {
    expect(assertOwnAgentFile('scout.md', agentFile('name: Scout', '  maia_agent_id:  agent_42  \r'), 'agent_42')).toBeNull()
    expect(assertOwnAgentFile('scout.md', agentFile('maia_agent_id: "agent_42"'), 'agent_42')).toBeNull()
    expect(assertOwnAgentFile('scout.md', agentFile("maia_agent_id: 'agent_42'"), 'agent_42')).toBeNull()
    expect(assertOwnAgentFile('scout.md', agentFile('name: Scout'), 'inst_scout')).toBeNull()
    expect(assertOwnAgentFile('scout.md', agentFile('maia_agent_id: agent_42'), 'inst_scout'))
      .toBe('refused: inst_scout cannot edit scout (owned by agent_42)')
  })

  it('stays linear on long space-padded frontmatter lines', () => {
    const body = agentFile(
      `description: a${' '.repeat(100_000)}b`,
      `${' '.repeat(100_000)}!`,
      'maia_agent_id: agent_42',
    )
    const started = performance.now()
    expect(assertOwnAgentFile('scout.md', body, 'agent_42')).toBeNull()
    expect(performance.now() - started).toBeLessThan(500)
  })
})
