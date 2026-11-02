import { describe, expect, it } from 'vitest'
import { profileToAgent } from '../hermes-profiles'

describe('profileToAgent', () => {
  it('maps the contract roster row to a local profile agent', () => {
    const agent = profileToAgent({
      name: 'backend-eng', path: '/fake/backend',
      ui_meta: { display_name: 'Backend Teammate', avatar: '/fake/avatar.png' },
      soul: 'Handles local backend work.\nFurther instructions.', orchestrator: true,
    })
    expect(agent).toMatchObject({
      id: 'profile:backend-eng', hermesProfile: 'backend-eng', name: 'Backend Teammate',
      status: 'running', region: 'local', role: 'orchestrator', avatar: '/fake/avatar.png',
      persona: { description: 'Handles local backend work.' },
    })
  })
  it('uses Hermes for default and title case for other profile names', () => {
    expect(profileToAgent({ name: 'default', path: '/fake/default' }).name).toBe('Hermes')
    expect(profileToAgent({ name: 'backend-eng', path: '/fake/backend' }).name).toBe('Backend Eng')
  })
  it('supports REST metadata and stopped gateway status', () => {
    expect(profileToAgent({ name: 'nub', path: '/fake/nub', gateway_running: false, skill_count: 7 }))
      .toMatchObject({ status: 'stopped', summary: 'nub profile.', persona: { description: '7 skills.' } })
  })
})
