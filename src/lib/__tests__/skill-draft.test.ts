import { describe, expect, it } from 'vitest'
import { displayUserPrompt } from '../peer-roster'
import { appendSkillRequest, genUiRequest, skillRequest, withGenUiPromptHint } from '../skill-draft'

describe('skill draft preparation', () => {
  it('preserves the task, is idempotent and does not copy skill instructions or credentials', () => {
    const request = skillRequest('imessage')
    expect(appendSkillRequest('My existing task', request)).toBe(`My existing task\n\n${request}`)
    expect(appendSkillRequest(`My existing task\n\n${request}`, request)).toBe(`My existing task\n\n${request}`)
    expect(appendSkillRequest('', request)).toContain('Task: ')
    expect(request).toContain('skill_view')
    expect(request).toContain('ask before installing')
  })

  it('builds a GenUI discovery request, augments bare render_ui prompts idempotently, and keeps the user bubble clean', () => {
    const req = genUiRequest()
    expect(req).toContain('mcp__hermes_desk__render_ui')
    expect(req).toContain('tool_search')
    expect(req).toContain('{"queries":["hermes desk render_ui"]}')
    expect(req).toContain('::preview')

    const ordinary = 'Summarize the deploy logs from today.'
    expect(withGenUiPromptHint(ordinary)).toBe(ordinary)

    const prompt = "Use render_ui to show a stat card for Deploy Status = 99.98% with detail 'All canary checks green'."
    const augmented = withGenUiPromptHint(prompt)
    expect(augmented).toContain(prompt)
    expect(augmented).toContain('mcp__hermes_desk__render_ui')
    expect(augmented).toContain('tool_search')
    expect(withGenUiPromptHint(augmented)).toBe(augmented)
    expect(displayUserPrompt(augmented)).toBe(prompt)
  })
})
