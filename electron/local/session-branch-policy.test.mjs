import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { rendererRpcAllowed } = createRequire(import.meta.url)('./serve-client.cjs')
const frame = (method, params) => ({ jsonrpc: '2.0', id: 'branch-test', method, params })

describe('native branch renderer policy', () => {
  it('accepts scoped native cutoffs and stored-parent branches, not invented fields or lease overrides', () => {
    expect(rendererRpcAllowed(frame('session.branch', {
      profile: 'alpha', session_id: 'live-parent', count: 2, idempotency_key: 'branch_test-key',
    }))).toBe(true)
    expect(rendererRpcAllowed(frame('session.branch_stored', {
      profile: 'beta', parent_session_id: 'stored-parent', source: 'desktop', idempotency_key: 'branch_test-key',
    }))).toBe(true)
    for (const count of [0, -1, 1.5, '2', null, 2 ** 53])
      expect(rendererRpcAllowed(frame('session.branch', { session_id: 'parent', count }))).toBe(false)
    for (const extra of [{ row_id: 1 }, { title: 'Wrong field' }, { force: true }, { credentials: {} }])
      expect(rendererRpcAllowed(frame('session.branch', { session_id: 'parent', ...extra }))).toBe(false)
    expect(rendererRpcAllowed(frame('session.branch_stored', { profile: '../other', parent_session_id: 'parent' }))).toBe(false)
  })
})
