import { describe, expect, it } from 'vitest'
import { assertOwnAgentFile, applyUpdateAvatarToMarkdown } from '../src/lib/avatar-tool'
import { renderHermesAgentMarkdown } from '../src/lib/hermes-agents'
import { AVATAR_BODY_COLORS, AVATAR_EYE_COLORS } from '../src/lib/avatar-spec'
import type { Agent } from '../src/lib/agents/types'

const agent: Agent = { id: 'inst_fixture', name: 'Fixture', region: 'local', status: 'running', createdAt: '', summary: '', persona: { description: '' } }
describe('local avatar metadata and peer-write isolation', () => {
  it('retains body and eye color when rendering a local persona file', () => {
    const { body } = renderHermesAgentMarkdown({ ...agent, avatarColor: AVATAR_BODY_COLORS[0], avatarEyeColor: AVATAR_EYE_COLORS[1] })
    expect(body).toContain(`maia_avatar_color: "${AVATAR_BODY_COLORS[0]}"`)
    expect(body).toContain(`maia_avatar_eye_color: ${AVATAR_EYE_COLORS[1]}`)
  })
  it('accepts the owner and rejects a peer without changing the file', () => {
    const { filename, body } = renderHermesAgentMarkdown(agent)
    expect(assertOwnAgentFile(filename, body, agent.id)).toBeNull()
    expect(assertOwnAgentFile(filename, body, 'inst_other')).toMatch(/^refused:/)
    const result = applyUpdateAvatarToMarkdown(filename, body, 'inst_other', { bodyColor: AVATAR_BODY_COLORS[1] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/^refused:/)
  })
})
