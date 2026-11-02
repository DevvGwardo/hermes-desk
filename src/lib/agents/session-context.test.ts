import { describe, expect, it } from 'vitest'
import { sessionContextSnapshot } from './session-context'
describe('native context projection', () => {
  it('does not turn malformed/unavailable results into an empty successful context', () => {
    expect(() => sessionContextSnapshot(null)).toThrow(/did not return/)
    expect(() => sessionContextSnapshot({ context_used: -1, context_max: 0, categories: [], context_files: [] })).toThrow()
  })
  it('keeps metadata only, skips malformed rows and does not imply readiness or billing', () => {
    const parsed = sessionContextSnapshot({ context_used: 0, context_max: 0, categories: [
      { id: 'memory', label: 'Memory', tokens: 40, content: 'BODY' }, { id: 'bad', tokens: -1 },
    ], context_files: [{ label: 'SOUL.md', path: '/profile/SOUL.md', loaded: false, status: 'blocked', est_tokens: 40, content: 'BODY' }] })
    expect(parsed.categories).toEqual([{ id: 'memory', label: 'Memory', tokens: 40 }])
    expect(parsed.files[0]?.status).toBe('blocked')
    expect(parsed.estimated).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain('BODY')
  })
})
