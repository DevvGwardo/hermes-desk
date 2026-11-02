import { describe, expect, it } from 'vitest'
// NOTE: scripts/ is untyped ESM and tsconfig.app.json is strict with
// moduleDetection:force, so in-file ambient declarations are illegal here.
// The classifier is imported dynamically and typed at the boundary — the
// probe script itself stays plain node (no edits to scripts/ or tsconfig).
type ClassifyTurn = (turn: unknown) => 'ok' | 'role-only-no-tokens' | 'headers-only-close'
type SummarizeTurns = (turns: unknown) => Record<string, number>
// @ts-expect-error — probe-orphan-runs.mjs is untyped ESM by design (plain
// node, no tsconfig change); boundary types above keep the test strict.
const probe = (await import('../../../scripts/probe-orphan-runs.mjs')) as unknown as {
  classifyTurn: ClassifyTurn
  summarizeTurns: SummarizeTurns
  SAMPLE_FIXTURE: Array<{ id: string; events: unknown[] }>
}
const { classifyTurn, summarizeTurns, SAMPLE_FIXTURE } = probe

describe('orphan probe classifier', () => {
  it('classifies ok when content tokens arrived', () => {
    expect(classifyTurn(SAMPLE_FIXTURE[0])).toBe('ok')
    expect(
      classifyTurn({
        id: 'x',
        events: [{ kind: 'data', content: 'hi' }],
      }),
    ).toBe('ok')
  })

  it('classifies role-only-no-tokens (429 smell) when frames but no tokens', () => {
    expect(classifyTurn(SAMPLE_FIXTURE[1])).toBe('role-only-no-tokens')
  })

  it('classifies headers-only-close when no frame arrived', () => {
    expect(classifyTurn(SAMPLE_FIXTURE[2])).toBe('headers-only-close')
    expect(classifyTurn({ id: 'y', events: [] })).toBe('headers-only-close')
  })

  it('rejects malformed turns', () => {
    expect(() => classifyTurn({})).toThrow(TypeError)
  })

  it('sample fixture summary counts cover all three classes', () => {
    expect(summarizeTurns(SAMPLE_FIXTURE)).toEqual({
      ok: 1,
      'role-only-no-tokens': 1,
      'headers-only-close': 1,
    })
  })
})
