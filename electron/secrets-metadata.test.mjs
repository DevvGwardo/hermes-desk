import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const op = require('./secrets-op.cjs')

describe('metadata-only 1Password settings', () => {
  it('verifies the CLI and lists only bounded vault identifiers/names, without item get/read or stderr disclosure', () => {
    const deps = { existsSync: () => true, runCodesign: () => ({ stderr: `TeamIdentifier=${op.OP_TEAM_ID}` }),
      runOp: vi.fn(() => ({ status: 0, stdout: JSON.stringify([
        { id: 'fake-vault', name: 'Fake vault', privateValue: 'fixture-only-extra-field' },
        { id: '../invalid', name: 'invalid' },
      ]) })) }
    expect(op.metadata(deps)).toEqual({ state: 'ready', vaults: [{ id: 'fake-vault', name: 'Fake vault' }] })
    expect(deps.runOp).toHaveBeenCalledWith(expect.any(String), ['vault', 'list', '--format', 'json'])
    deps.runOp.mockReturnValue({ status: 1, stderr: 'obviously-fake-secret' })
    expect(op.metadata(deps)).toEqual({ state: 'locked', vaults: [] })
    deps.runCodesign = () => ({ stderr: 'TeamIdentifier=UNTRUSTED' })
    deps.runOp.mockClear()
    expect(op.metadata(deps)).toEqual({ state: 'unavailable', vaults: [] })
    expect(deps.runOp).not.toHaveBeenCalled()
  })
  it('keeps one-time origin metadata separate from credentials and invalidates pending consent generations on revoke', () => {
    const origin = 'https://fake-vault-test.invalid'
    const generation = op.approvalGeneration(origin)
    op.recordOriginApproval(origin)
    const metadata = op.listOriginApprovals().find(entry => entry.origin === origin)
    expect(metadata).toMatchObject({ origin, scope: 'once' })
    expect(Object.keys(metadata).sort()).toEqual(['at', 'origin', 'scope'])
    op.revokeOriginApproval(origin)
    expect(op.approvalGeneration(origin)).toBeGreaterThan(generation)
    expect(op.listOriginApprovals().some(entry => entry.origin === origin)).toBe(false)
    for (const invalid of ['https://fake.invalid/path', 'https://user:fake@fake.invalid', 'file:///fake']) {
      expect(() => op.recordOriginApproval(invalid)).toThrow()
    }
  })
})
