import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { rendererRpcAllowed } = createRequire(import.meta.url)('./serve-client.cjs')

describe('renderer profile-following policy', () => {
  for (const method of ['session.create', 'session.resume']) {
    it(`${method} allows only a boolean policy, never a supplied route`, () => {
      const frame = (policy, extra = {}) => ({
        jsonrpc: '2.0', id: 1, method,
        params: { profile: 'runner', follow_profile_config: policy, ...extra },
      })
      expect(rendererRpcAllowed(frame(true))).toBe(true)
      expect(rendererRpcAllowed(frame(false))).toBe(true)
      for (const invalid of ['true', 1, null, {}]) expect(rendererRpcAllowed(frame(invalid))).toBe(false)
      expect(rendererRpcAllowed(frame(true, { provider: 'nous' }))).toBe(false)
      expect(rendererRpcAllowed(frame(true, { model: 'old-model' }))).toBe(false)
    })
  }
})
