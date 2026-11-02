import { describe, expect, it } from 'vitest'
import { probeEnvironment, sandboxPolicy } from './mcp-hermes-load.mjs'

describe('Hermes MCP probe isolation', () => {
  it('builds an allowlisted disposable environment without inheriting provider credentials', () => {
    const env = probeEnvironment('/private/tmp/fake-probe', '/fake/hermes-agent')
    expect(env.HOME).toBe('/private/tmp/fake-probe')
    expect(env.HERMES_HOME).toBe('/private/tmp/fake-probe/.hermes')
    expect(env.HERMES_RUNTIME_DIR).toBe('/private/tmp/fake-probe/runtime')
    expect(env.HERMES_DISABLE_LAZY_INSTALLS).toBe('1')
    expect(Object.keys(env).some(key => /API_KEY|TOKEN|PASSWORD|SECRET/.test(key))).toBe(false)
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1')
  })

  it('denies IP network, binds and non-temp writes while allowing read-only Hermes source', () => {
    const policy = sandboxPolicy('/private/tmp/fake-probe', '/fake/state/hermes-agent')
    expect(policy).toContain('(deny network-outbound (remote ip "*:*"))')
    expect(policy).toContain('(deny network-bind)')
    expect(policy).toContain('(deny file-write*)')
    expect(policy).toContain('(deny file-read-data (subpath "/fake/state"))')
    expect(policy).toContain('(allow file-read-data (subpath "/fake/state/hermes-agent"))')
    expect(() => sandboxPolicy('/tmp/bad"policy', '/fake/source')).toThrow('Unsupported sandbox path')
  })
})
