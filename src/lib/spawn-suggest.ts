/**
 * `/spawn` autocomplete — Hermes profiles/agents first, then typed kinds.
 *
 * `/spawn` and `/spawn <partial>` show the picker. Once a full token is
 * followed by a space (`/spawn bash …`) the user is typing the goal and
 * the menu hides.
 */

import type { Agent, SubagentKind } from './agents/types'

export type SpawnSuggestionSource = 'profile' | 'agent' | 'kind'

export interface SpawnSuggestion {
  token: string
  label: string
  detail: string
  source: SpawnSuggestionSource
}

const KIND_SUGGESTIONS: SpawnSuggestion[] = [
  { token: 'bash', label: 'Shell', detail: 'kind', source: 'kind' },
  { token: 'shell', label: 'Shell', detail: 'kind', source: 'kind' },
  { token: 'executor', label: 'Executor', detail: 'kind', source: 'kind' },
  { token: 'explore', label: 'Explore', detail: 'kind', source: 'kind' },
  { token: 'debug', label: 'Debug', detail: 'kind', source: 'kind' },
  { token: 'browserUse', label: 'Browser', detail: 'kind', source: 'kind' },
  { token: 'computerUse', label: 'Computer', detail: 'kind', source: 'kind' },
  { token: 'cloudCoder', label: 'Cloud coder', detail: 'kind', source: 'kind' },
  { token: 'watcher', label: 'Watcher', detail: 'kind', source: 'kind' },
  { token: 'mediaReview', label: 'Media', detail: 'kind', source: 'kind' },
  { token: 'watchVideo', label: 'Video', detail: 'kind', source: 'kind' },
  { token: 'cursorGuide', label: 'Cursor', detail: 'kind', source: 'kind' },
  { token: 'fileGlobbed', label: 'Files', detail: 'kind', source: 'kind' },
  { token: 'custom', label: 'Custom', detail: 'kind', source: 'kind' },
]

export const SPAWN_KIND_TOKENS: ReadonlySet<string> = new Set(KIND_SUGGESTIONS.map((k) => k.token))

export function slugifyAgentName(name: string): string {
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'agent'
}

export function spawnTokenForAgent(agent: Agent): string | null {
  if (agent.id.startsWith('profile:')) return agent.id.slice('profile:'.length)
  if (agent.id === 'local-hermes') return 'hermes'
  const slug = slugifyAgentName(agent.name)
  return slug || null
}

function agentSuggestions(agents: Agent[]): SpawnSuggestion[] {
  const out: SpawnSuggestion[] = []
  const seen = new Set<string>()
  for (const a of agents) {
    const token = spawnTokenForAgent(a)
    if (!token) continue
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const source: SpawnSuggestionSource = a.id.startsWith('profile:') ? 'profile' : 'agent'
    out.push({
      token,
      label: a.name,
      detail: source,
      source,
    })
  }
  return out
}

export type SpawnDraftPhase = 'idle' | 'pick' | 'goal'

export function parseSpawnDraft(draft: string): { phase: SpawnDraftPhase; partial: string } {
  if (!draft.startsWith('/spawn')) return { phase: 'idle', partial: '' }
  if (draft === '/spawn' || draft === '/spawn ') return { phase: 'pick', partial: '' }
  const onlyPartial = draft.match(/^\/spawn\s+(\S+)$/)
  if (onlyPartial) return { phase: 'pick', partial: onlyPartial[1]! }
  if (/^\/spawn\s+\S+\s/.test(draft)) return { phase: 'goal', partial: '' }
  return { phase: 'idle', partial: '' }
}

export function spawnSuggestions(draft: string, agents: Agent[]): SpawnSuggestion[] {
  const { phase, partial } = parseSpawnDraft(draft)
  if (phase !== 'pick') return []
  const q = partial.toLowerCase()
  const all = [...agentSuggestions(agents), ...KIND_SUGGESTIONS]
  if (!q) return all
  return all.filter(
    (s) => s.token.toLowerCase().startsWith(q) || s.label.toLowerCase().includes(q),
  )
}

export function resolveSpawnToken(
  token: string,
  agents: Agent[],
): { kind: SubagentKind; label: string } | null {
  if (SPAWN_KIND_TOKENS.has(token)) {
    const kind = token as SubagentKind
    const hit = KIND_SUGGESTIONS.find((k) => k.token === token)
    return { kind, label: hit?.label ?? token }
  }
  const lower = token.toLowerCase()
  for (const a of agents) {
    const slug = spawnTokenForAgent(a)
    if (slug && slug.toLowerCase() === lower) return { kind: 'custom', label: a.name }
    if (a.name.toLowerCase() === lower) return { kind: 'custom', label: a.name }
  }
  return null
}
