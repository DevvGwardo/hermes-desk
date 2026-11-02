import { describe, expect, it } from 'vitest'
import {
  ALLOWED_OP_PATHS,
  OP_TEAM_ID,
  createSecret,
  parseCodesignTeam,
  updateSecretValue,
  verifyOpBinary,
  findVerifiedOp,
  runOp,
  listSecrets,
  resolveSecret,
  resolveForFill,
  copySecretToClipboard,
  CLIPBOARD_CLEAR_MS,
} from './secrets-op.cjs'

/** Fake deps: `op` exists at /opt/homebrew/bin/op signed by the right team. */
function fakeDeps({ team = OP_TEAM_ID, opStatus = 0, opStdout = '', opStderr = '' } = {}) {
  const calls = []
  return {
    existsSync: (p) => p === '/opt/homebrew/bin/op',
    runCodesign: (bin) => ({
      stdout: '',
      stderr: `Executable=/opt/homebrew/bin/op\nTeamIdentifier=${team}\n`,
      [bin]: true,
    }),
    runOp: (bin, args) => {
      calls.push({ bin, args })
      return { status: opStatus, stdout: opStdout, stderr: opStderr }
    },
    calls,
  }
}

describe('secrets-op verified 1Password CLI wrapper', () => {
  it('refuses unknown-path op binaries outright', () => {
    const deps = fakeDeps()
    const verdict = verifyOpBinary('/Users/attacker/tools/op', deps)
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toMatch(/refused unknown op path/)
    expect(deps.calls).toHaveLength(0) // never exec'd
  })

  it('refuses a present binary whose signature is not AgileBits', () => {
    const deps = fakeDeps({ team: 'DEADBEEFXX' })
    const verdict = findVerifiedOp(deps)
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toMatch(new RegExp(OP_TEAM_ID))
    expect(deps.calls).toHaveLength(0)
  })

  it('accepts only allowlisted, correctly-signed binaries', () => {
    const deps = fakeDeps()
    for (const p of ALLOWED_OP_PATHS) {
      if (!deps.existsSync(p)) continue
      expect(verifyOpBinary(p, deps).ok).toBe(true)
    }
    expect(findVerifiedOp(deps).bin).toBe('/opt/homebrew/bin/op')
  })

  it('keeps secret values out of error strings on failure', () => {
    const leaked = 'op://vault/item/very-secret-value'
    const deps = fakeDeps({ opStatus: 1, opStdout: leaked, opStderr: 'authentication required' })
    const res = runOp(['read', leaked], deps)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).not.toContain(leaked)
    expect(res.error).toBe('authentication required')
  })

  it('listSecrets returns metadata-only rows and never values', () => {
    const deps = fakeDeps({
      opStdout: JSON.stringify([
        { id: 'i1', title: 'API Key', vault: { id: 'v1' }, fields: [{ value: 'hunter2' }] },
      ]),
    })
    const res = listSecrets(deps)
    expect(res.ok).toBe(true)
    expect(res.items).toEqual([{ id: 'i1', title: 'API Key', vault: 'v1' }])
    expect(JSON.stringify(res)).not.toContain('hunter2')
  })

  it('resolveSecret requires an op:// reference and returns the value', () => {
    expect(resolveSecret('hunter2', fakeDeps()).ok).toBe(false)
    const deps = fakeDeps({ opStdout: 'hunter2' })
    const res = resolveSecret('op://v/i/password', deps)
    expect(res).toEqual({ ok: true, value: 'hunter2' })
    expect(deps.calls[0].args).toEqual(['read', 'op://v/i/password'])
  })

  it('parseCodesignTeam reads stderr-side codesign output', () => {
    expect(parseCodesignTeam('TeamIdentifier=2BUA8C4S2C\n')).toBe(OP_TEAM_ID)
    expect(parseCodesignTeam('nope')).toBeNull()
  })
})

describe('main-only resolveForFill', () => {
  it('returns a value to the fill caller without clipboard access or IPC', () => {
    const deps = fakeDeps({ opStdout: 'FAKE_BROWSER_FILL_PASSWORD' })
    expect(resolveForFill('op://fake-vault/fake-item/password', deps)).toBe('FAKE_BROWSER_FILL_PASSWORD')
    expect(deps.calls[0].args).toEqual(['read', 'op://fake-vault/fake-item/password', '--no-newline'])
  })

  it('preserves meaningful password whitespace', () => {
    const value = '  FAKE_BROWSER_PASSWORD \n'
    expect(resolveForFill('op://fake-vault/fake-item/password', fakeDeps({ opStdout: value }))).toBe(value)
  })

  it('redacts CLI errors, stderr and exception text on failed fills', () => {
    for (const deps of [
      fakeDeps({ opStatus: 1, opStdout: 'FAKE_SECRET_STDOUT', opStderr: 'FAKE_SECRET_STDERR' }),
      { ...fakeDeps(), runOp: () => { throw new Error('FAKE_SECRET_EXCEPTION') } },
      fakeDeps({ opStdout: '' }),
    ]) {
      let caught
      try { resolveForFill('op://fake-vault/fake-item/password', deps) } catch (error) { caught = error }
      expect(caught.code).toBe('blocked_by_policy')
      expect(caught.message).toBe('Secret fill unavailable')
      expect(caught.message).not.toContain('FAKE_SECRET')
    }
  })

  it('refuses bad references and unverified CLI binaries without execution', () => {
    const deps = fakeDeps({ team: 'FAKETEAMXX' })
    expect(() => resolveForFill('op://fake-vault/fake-item/password', deps)).toThrow('Secret fill unavailable')
    expect(() => resolveForFill('not-an-op-ref', deps)).toThrow('Secret fill unavailable')
    expect(deps.calls).toHaveLength(0)
  })
})

describe('secrets-op write path (create + update-value, no delete)', () => {
  it('createSecret rejects blank/oversize/control-char titles without exec', () => {
    for (const title of ['', '   ', 'x'.repeat(129), 'a\nb', 'a\0b']) {
      const deps = fakeDeps()
      expect(createSecret({ title, value: 'v' }, deps)).toEqual({
        ok: false,
        error: 'invalid secret title',
      })
      expect(deps.calls).toHaveLength(0)
    }
  })

  it('createSecret rejects empty/oversize values and bad vaults without exec', () => {
    const bad = [
      { title: 't', value: '' },
      { title: 't', value: 'x'.repeat(8193) },
      { title: 't', value: 'a\0b' },
      { title: 't', value: 'v', vault: '../escape' },
      { title: 't', value: 'v', vault: '' },
    ]
    for (const input of bad) {
      const deps = fakeDeps()
      const res = createSecret(input, deps)
      expect(res.ok).toBe(false)
      expect(deps.calls).toHaveLength(0)
    }
  })

  it('createSecret builds a login-item argv (no shell) with vault + json flags', () => {
    const deps = fakeDeps({ opStdout: JSON.stringify({ id: 'new-id-1', title: 'API Key' }) })
    const res = createSecret({ title: 'API Key', value: 'hunter2', vault: 'v1' }, deps)
    expect(res).toEqual({ ok: true, id: 'new-id-1' })
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0].args).toEqual([
      'item', 'create', '--category', 'login', '--title', 'API Key', '--format', 'json',
      '--vault', 'v1', 'password=hunter2',
    ])
  })

  it('createSecret tolerates non-JSON success output without echoing stdout', () => {
    const deps = fakeDeps({ opStdout: 'Successfully created item' })
    const res = createSecret({ title: 't', value: 'v' }, deps)
    expect(res).toEqual({ ok: true })
    expect(JSON.stringify(res)).not.toContain('Successfully created')
  })

  it('updateSecretValue rejects bad ids and values without exec', () => {
    for (const input of [
      { id: '', value: 'v' },
      { id: '../../etc', value: 'v' },
      { id: 'abc', value: '' },
      { id: 'abc', value: 'x'.repeat(8193) },
    ]) {
      const deps = fakeDeps()
      const res = updateSecretValue(input, deps)
      expect(res.ok).toBe(false)
      expect(deps.calls).toHaveLength(0)
    }
  })

  it('updateSecretValue edits by id with a password= argv element', () => {
    const deps = fakeDeps()
    expect(updateSecretValue({ id: 'abc123', value: 'n3w' }, deps)).toEqual({ ok: true })
    expect(deps.calls[0].args).toEqual(['item', 'edit', 'abc123', 'password=n3w'])
  })

  it('write-path failures carry stderr only — values never leak into errors', () => {
    const value = 's3cr3t-VALUE-xyz'
    const deps = fakeDeps({ opStatus: 1, opStdout: value, opStderr: 'auth expired' })
    for (const res of [
      createSecret({ title: 't', value }, deps),
      updateSecretValue({ id: 'abc', value }, deps),
    ]) {
      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).not.toContain(value)
      expect(res.error).toBe('auth expired')
    }
  })
})

describe('#161: secret copy stays in the main process', () => {
  function fakeClipboard() {
    let text = 'previous'
    return {
      writeText: (s) => (text = s),
      readText: () => text,
      clear: () => (text = ''),
      get text() {
        return text
      },
    }
  }

  it('writes the value to the clipboard and returns no value', () => {
    const clipboard = fakeClipboard()
    const timers = []
    const res = copySecretToClipboard('op://v/i/password', clipboard, {
      deps: fakeDeps({ opStdout: 'hunter2' }),
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    })
    expect(res).toEqual({ ok: true, clearAfterMs: CLIPBOARD_CLEAR_MS })
    expect(JSON.stringify(res)).not.toContain('hunter2')
    expect(clipboard.text).toBe('hunter2')
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(CLIPBOARD_CLEAR_MS)
    timers[0].fn()
    expect(clipboard.text).toBe('')
  })

  it('does not clobber something the user copied afterwards', () => {
    const clipboard = fakeClipboard()
    let clear
    copySecretToClipboard('op://v/i/password', clipboard, {
      deps: fakeDeps({ opStdout: 'hunter2' }),
      setTimer: (fn) => (clear = fn),
    })
    clipboard.writeText('user copied this')
    clear()
    expect(clipboard.text).toBe('user copied this')
  })

  it('a failed resolve leaves the clipboard alone and leaks nothing', () => {
    const clipboard = fakeClipboard()
    const res = copySecretToClipboard('op://v/i/password', clipboard, {
      deps: fakeDeps({ opStatus: 1, opStderr: 'auth expired' }),
      setTimer: () => {
        throw new Error('no timer on failure')
      },
    })
    expect(res).toEqual({ ok: false, error: 'auth expired' })
    expect(clipboard.text).toBe('previous')
    expect(copySecretToClipboard('hunter2', clipboard).ok).toBe(false)
  })
})
