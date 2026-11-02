import { describe, expect, it } from 'vitest'
import { isolatedEnvironment } from '../../tests/e2e/harness.mjs'

describe('isolated harness background mode', () => {
  it('requests background by default and permits an explicit visible opt-out without copying shell secrets', () => {
    const hidden = isolatedEnvironment('/tmp/obviously-fake-home', '/tmp/obviously-fake-source', { visible: false })
    const visible = isolatedEnvironment('/tmp/obviously-fake-home', '/tmp/obviously-fake-source', { visible: true })
    expect(hidden.HERMES_DESK_E2E_BACKGROUND).toBe('1')
    expect(visible.HERMES_DESK_E2E_BACKGROUND).toBe('0')
    expect(Object.keys(hidden).some((key) => /KEY|TOKEN|PASSWORD|AUTH_SOCK/.test(key))).toBe(false)
  })
})
