import { describe, expect, it } from 'vitest'
import type { Agent } from '../agents/types'
import {
  parseSpawnDraft,
  resolveSpawnToken,
  spawnSuggestions,
  spawnTokenForAgent,
} from '../spawn-suggest'

function agent(partial: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    status: 'running',
    region: 'local',
    createdAt: '2026-08-12T12:00:00Z',
    summary: '',
    ...partial,
  }
}

const roster: Agent[] = [
  agent({ id: 'profile:default', name: 'Hermes' }),
  agent({ id: 'profile:research', name: 'research' }),
  agent({ id: 'local-hermes', name: 'Local Hermes' }),
  agent({ id: 'inst_alpha', name: 'Research Alpha' }),
]

describe('parseSpawnDraft', () => {
  it('is idle until the command is /spawn', () => {
    expect(parseSpawnDraft('/sp').phase).toBe('idle')
    expect(parseSpawnDraft('/spawn').phase).toBe('pick')
    expect(parseSpawnDraft('/spawn ').phase).toBe('pick')
  })

  it('treats a trailing name as a filter, then goal after a space', () => {
    expect(parseSpawnDraft('/spawn re')).toEqual({ phase: 'pick', partial: 're' })
    expect(parseSpawnDraft('/spawn research do it').phase).toBe('goal')
  })
})

describe('spawnTokenForAgent', () => {
  it('uses the profile slug, hermes, or a name slug for created agents', () => {
    expect(spawnTokenForAgent(roster[0]!)).toBe('default')
    expect(spawnTokenForAgent(roster[2]!)).toBe('hermes')
    expect(spawnTokenForAgent(roster[3]!)).toBe('research-alpha')
  })
})

describe('spawnSuggestions', () => {
  it('lists profiles before kinds when the picker opens', () => {
    const items = spawnSuggestions('/spawn ', roster)
    expect(items[0]?.token).toBe('default')
    expect(items[0]?.source).toBe('profile')
    expect(items.some((s) => s.token === 'research' && s.source === 'profile')).toBe(true)
    expect(items.some((s) => s.token === 'hermes' && s.source === 'agent')).toBe(true)
    expect(items.some((s) => s.token === 'research-alpha' && s.source === 'agent')).toBe(true)
    expect(items.some((s) => s.token === 'bash' && s.source === 'kind')).toBe(true)
    expect(items.some((s) => s.token === 'Research Alpha')).toBe(false)
  })

  it('filters by token or label', () => {
    const byToken = spawnSuggestions('/spawn re', roster)
    expect(byToken.map((s) => s.token)).toContain('research')
    const byLabel = spawnSuggestions('/spawn herm', roster)
    expect(byLabel.some((s) => s.token === 'default' || s.token === 'hermes')).toBe(true)
  })

  it('hides once the goal is being typed', () => {
    expect(spawnSuggestions('/spawn research write a summary', roster)).toEqual([])
  })
})

describe('resolveSpawnToken', () => {
  it('maps kinds and profile slugs', () => {
    expect(resolveSpawnToken('bash', roster)?.kind).toBe('bash')
    expect(resolveSpawnToken('research', roster)).toEqual({ kind: 'custom', label: 'research' })
    expect(resolveSpawnToken('default', roster)).toEqual({ kind: 'custom', label: 'Hermes' })
    expect(resolveSpawnToken('research-alpha', roster)).toEqual({
      kind: 'custom',
      label: 'Research Alpha',
    })
    expect(resolveSpawnToken('nope', roster)).toBeNull()
  })
})
