import { describe, expect, it } from 'vitest'
import {
  HIDDEN_SKILLS,
  filterFeasibleSkills,
  isSkillFeasible,
  platformsAllowLinux,
  skillFeasibility,
} from '../skill-feasibility'

describe('skillFeasibility', () => {
  it('hides every Appendix A "can’t work on a hosted VM" skill', () => {
    for (const name of [
      'apple-notes', 'apple-reminders', 'findmy', 'imessage', 'obsidian', 'openhue', 'touchdesigner-mcp',
      'unreal-mcp', 'neuroskill-bci', 'openclaw-migration', 'spotify', 'xurl', 'computer-use',
    ]) {
      expect(isSkillFeasible({ name }), name).toBe(false)
    }
  })

  it('hides v1 sensitive/niche skills and GPU mlops', () => {
    for (const name of ['godmode', 'stripe-link-cli', 'docker-management', 'pokemon-player', 'flash-attention', 'tensorrt-llm']) {
      expect(isSkillFeasible({ name }), name).toBe(false)
    }
    expect(skillFeasibility({ name: 'peft' })).toMatchObject({ ok: false, reason: 'gpu' })
  })

  it('hides by official identifier category and tail', () => {
    expect(isSkillFeasible({ name: 'Solana', identifier: 'official/blockchain/solana' })).toBe(false)
    expect(isSkillFeasible({ name: 'Anything', identifier: 'official/apple/new-thing' })).toBe(false)
    expect(isSkillFeasible({ name: 'Find My', identifier: 'official/apple/findmy' })).toBe(false)
  })

  it('keeps connect-card and no-setup skills', () => {
    for (const name of ['notion', 'airtable', 'maps', 'youtube-content', 'duckduckgo-search', 'lambda-labs', 'comfyui']) {
      expect(isSkillFeasible({ name }), name).toBe(true)
    }
  })

  it('hides skills whose platforms exclude linux', () => {
    expect(platformsAllowLinux(['macos'])).toBe(false)
    expect(platformsAllowLinux(['linux', 'macos'])).toBe(true)
    expect(platformsAllowLinux(null)).toBe(true)
    expect(skillFeasibility({ name: 'some-mac-tool', platforms: ['macos', 'windows'] })).toMatchObject({ ok: false, reason: 'platform' })
  })

  it('filters lists and keeps the hide table lowercase', () => {
    expect(filterFeasibleSkills([{ name: 'notion' }, { name: 'iMessage' }]).map((s) => s.name)).toEqual(['notion'])
    for (const k of Object.keys(HIDDEN_SKILLS)) expect(k).toBe(k.toLowerCase())
  })
})
