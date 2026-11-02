import { expect, it } from 'vitest'
import { LocalRoomEngine } from './local-rooms'
import { roomUsageSummary } from './room-usage'

const members = [
  { id: 'chief', name: 'Chief', profile: 'default', role: 'orchestrator' as const },
  { id: 'alpha', name: 'Alpha', profile: 'alpha' },
]
function room() {
  const engine = new LocalRoomEngine('room', members, 'Team')
  engine.setBinding('alpha', { profile: 'alpha', storedId: 'stored-alpha', runtimeId: 'alpha', lastSeen: 0, epoch: 'one' })
  return engine
}
const usage = (total: number) => ({ input: total / 2, output: total / 2, total })

it('attributes cumulative session counters to the right turns without replay double charging', () => {
  const r = room()
  r.send('@Alpha first')
  const first = r.takeReady()[0]!
  r.recordUsage('alpha', usage(100))
  r.recordUsage('alpha', usage(100))
  r.complete(first.id, { text: 'First result' })
  r.send('@Alpha second')
  r.takeReady()
  r.recordUsage('alpha', usage(180))
  expect(r.state.turns.map(t => t.usage?.total)).toEqual([100, 80])
  const restored = new LocalRoomEngine('room', members, 'Team', undefined, structuredClone(r.state))
  restored.recordUsage('alpha', usage(180))
  expect(roomUsageSummary(restored.state).total).toBe(180)
  expect(roomUsageSummary(restored.state).members.alpha.total).toBe(180)
})

it('attributes quarantined spend to the submitted turn, not a later cancelled queued turn', () => {
  const r = room()
  r.send('@Alpha submitted')
  const turn = r.takeReady()[0]!
  r.update(turn.id, { submittedText: 'Submitted prompt' })
  r.recordUsage('alpha', usage(20))
  r.send('@Alpha queued before Stop')
  r.cancel()
  r.setBinding('alpha', { ...r.state.bindings.alpha, blocked: true })
  r.recordUsage('alpha', usage(100))
  r.recordUsage('alpha', usage(100))
  expect(r.state.turns.map(t => t.usage?.total)).toEqual([100, undefined])
  expect(r.state.turns.every(t => t.status === 'cancelled')).toBe(true)
})

it('advances idle usage baselines without charging the finished or next turn', () => {
  const r = room()
  r.send('@Alpha first')
  const first = r.takeReady()[0]!
  r.recordUsage('alpha', usage(20))
  r.complete(first.id, { text: 'First result' })
  r.recordUsage('alpha', usage(40))
  r.send('@Alpha second')
  r.takeReady()
  r.recordUsage('alpha', usage(60))
  expect(r.state.turns.map(t => t.usage?.total)).toEqual([20, 20])
})

it('pauses new turns at the durable per-request budget without cancelling active work', () => {
  const r = room()
  r.setTokenBudget(20)
  r.send('A request for the Chief')
  const chief = r.takeReady()[0]!
  r.setBinding('chief', { profile: 'default', storedId: 'stored-chief', runtimeId: 'chief', lastSeen: 0 })
  r.recordUsage('chief', usage(20))
  r.complete(chief.id, { text: '@Alpha inspect the result' })
  expect(r.takeReady()).toEqual([])
  expect(roomUsageSummary(r.state).pausedRoots).toHaveLength(1)
  const restored = new LocalRoomEngine('room', members, 'Team', undefined, structuredClone(r.state))
  expect(restored.takeReady()).toEqual([])
  restored.setTokenBudget(100)
  expect(restored.takeReady().map(t => t.memberId)).toEqual(['alpha'])
})

it.each(['error', 'timeout'] as const)('does not advertise retry for a budget-exhausted %s until the limit is raised', status => {
  const r = room()
  r.setTokenBudget(20)
  const root = r.send('@Alpha failed request')
  const turn = r.takeReady()[0]!
  r.recordUsage('alpha', usage(20))
  r.complete(turn.id, status === 'error' ? { error: 'Model failed' } : { timeout: true })
  expect(r.retry(root.id)).toBe(false)
  expect(r.feed().recent[0]?.retryable).toBe(false)
  expect(roomUsageSummary(r.state)).toMatchObject({ pausedRoots: [], retryPaused: true })

  r.setTokenBudget(100)
  expect(r.feed().recent[0]?.retryable).toBe(true)
  expect(roomUsageSummary(r.state).retryPaused).toBe(false)
  expect(r.state.turns[0]?.status).toBe(status)
  expect(r.retry(root.id)).toBe(true)
})

it('does not keep an older budget-exhausted failure as the current retry blocker', () => {
  const r = room()
  r.setTokenBudget(20)
  r.send('@Alpha old failed request')
  const turn = r.takeReady()[0]!
  r.recordUsage('alpha', usage(20))
  r.complete(turn.id, { error: 'Old model failure' })
  r.send('@Alpha new request')
  expect(roomUsageSummary(r.state).retryPaused).toBe(false)
})

it('retains retry spend and rebases backend counters after an authoritative new-session baseline', () => {
  const r = room()
  const root = r.send('@Alpha first')
  const turn = r.takeReady()[0]!
  r.recordUsage('alpha', usage(20))
  r.complete(turn.id, { error: 'A synthetic failure' })
  expect(r.retry(root.id)).toBe(true)
  r.takeReady()
  r.setUsageBaseline('alpha', usage(0))
  r.recordUsage('alpha', usage(40))
  expect(roomUsageSummary(r.state).total).toBe(60)
})

it('charges the first new-epoch turn even when its counters equal the old epoch counters', () => {
  const r = room()
  r.send('@Alpha before restart')
  const turn = r.takeReady()[0]!
  r.recordUsage('alpha', usage(20))
  r.complete(turn.id, { text: 'Before' })
  r.setBinding('alpha', { ...r.state.bindings.alpha, runtimeId: 'new-runtime', epoch: 'two' })
  r.send('@Alpha after restart')
  r.takeReady()
  r.recordUsage('alpha', usage(20))
  expect(roomUsageSummary(r.state).total).toBe(40)
})
it('labels missing/invalid usage as unknown, not a free turn', () => {
  const r = room()
  r.send('@Alpha first')
  const first = r.takeReady()[0]!
  for (const bad of [{ total: -1 }, { input: '10', output: 10, total: 20 }, { input: NaN, output: 0, total: 0 }, usage(0)])
    r.recordUsage('alpha', bad)
  r.complete(first.id, { text: 'No usable accounting' })
  const summary = roomUsageSummary(r.state)
  expect(summary.unknownTurns).toBe(1)
  expect(summary.members.alpha.unknownTurns).toBe(1)
  expect(r.state.turns[0].usage).toBeUndefined()
})

it.each([0, -1, NaN, 1.5, 10_000_001])('rejects an invalid budget %s without changing it', value => {
  const r = room(), before = r.state.tokenBudget
  expect(() => r.setTokenBudget(value)).toThrow()
  expect(r.state.tokenBudget).toBe(before)
})
