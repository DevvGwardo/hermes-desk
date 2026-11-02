import type { LocalRoomState } from './local-rooms'

export const DEFAULT_ROOM_TOKEN_BUDGET = 64_000
export interface RoomTokenUsage { input: number; output: number; total: number }
export function parseRoomUsage(raw: unknown): RoomTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const input = value.input ?? value.prompt
  const output = value.output ?? value.completion
  const total = value.total ?? (typeof input === 'number' && typeof output === 'number' ? input + output : undefined)
  if (![input, output, total].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null
  if ((total as number) < (input as number) + (output as number)) return null
  return { input: input as number, output: output as number, total: total as number }
}

export function rootReportedTokens(state: LocalRoomState, rootId: string): number {
  return state.turns.reduce((sum, turn) => sum + (turn.rootId === rootId ? turn.usage?.total ?? 0 : 0), 0)
}
export function isRoomBudgetPaused(state: LocalRoomState, rootId: string): boolean {
  return rootReportedTokens(state, rootId) >= (state.tokenBudget ?? DEFAULT_ROOM_TOKEN_BUDGET)
}

export function roomUsageSummary(state: LocalRoomState) {
  const members: Record<string, RoomTokenUsage & { unknownTurns: number; name?: string }> = Object.create(null)
  let total = 0, unknownTurns = 0
  for (const turn of state.turns) {
    const member = members[turn.memberId] ??= { input: 0, output: 0, total: 0, unknownTurns: 0, name: turn.memberName }
    if (turn.usage) {
      member.input += turn.usage.input
      member.output += turn.usage.output
      member.total += turn.usage.total
      total += turn.usage.total
    } else if (turn.status !== 'queued' && turn.status !== 'running') {
      member.unknownTurns++
      unknownTurns++
    }
  }
  const pausedRoots = [...new Set(state.turns.filter(t => t.status === 'queued' && isRoomBudgetPaused(state, t.rootId)).map(t => t.rootId))]
  const latestRoot = state.messages.findLast(m => m.speakerKind === 'human')?.id
  const retryPaused = !!latestRoot && state.turns.some(t => t.rootId === latestRoot &&
    ['error', 'timeout'].includes(t.status) && t.retryable !== false &&
    !state.bindings[t.memberId]?.blocked && isRoomBudgetPaused(state, t.rootId))
  return { members, total, unknownTurns, pausedRoots, retryPaused, tokenBudget: state.tokenBudget ?? DEFAULT_ROOM_TOKEN_BUDGET }
}
