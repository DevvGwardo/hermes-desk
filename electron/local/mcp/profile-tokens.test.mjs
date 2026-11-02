import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfileTokens, newToken } from './profile-tokens.cjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync('/tmp/hd-mcp-tokens-')
  roots.push(root)
  return { root, store: createProfileTokens(path.join(root, 'mcp')) }
}

function write(store, profile, token) {
  const change = store.prepare(profile, token)
  try { change.commit() } finally { change.dispose() }
}

describe('MCP stored profile authority', () => {
  it('HD-06 commits private random credentials and survives an app restart', () => {
    const { store } = fixture()
    const first = newToken(), second = newToken()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toBe(second)
    const staged = store.prepare('alpha', first)
    expect(store.verify('alpha', first)).toBe(false)
    staged.commit()
    staged.dispose()
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700)
    expect(createProfileTokens(path.dirname(store.file)).verify('alpha', first)).toBe(true)
    write(store, 'beta', second)
    expect(store.verify('alpha', first)).toBe(true)
    expect(store.verify('beta', second)).toBe(true)
    expect(store.verify('beta', first)).toBe(false)
    expect(store.verify('alpha', second)).toBe(false)
  })

  it('HD-06 rotates and revokes only the selected profile, never reading authority from the client', () => {
    const { store } = fixture()
    const first = newToken(), second = newToken(), beta = newToken()
    write(store, 'alpha', first)
    write(store, 'beta', beta)
    write(store, 'alpha', second)
    expect(store.verify('alpha', first)).toBe(false)
    expect(store.verify('alpha', second)).toBe(true)
    write(store, 'alpha', null)
    expect(store.verify('alpha', second)).toBe(false)
    expect(store.verify('beta', beta)).toBe(true)
    expect(fs.readFileSync(store.file, 'utf8')).not.toContain(second)
  })

  it('HD-06 fails closed on malformed, public, symlinked or oversized credential files', () => {
    const { root, store } = fixture()
    const token = newToken()
    write(store, 'alpha', token)
    for (const text of ['{broken', '{"version":2,"profiles":{}}', 'x'.repeat(64 * 1024 + 1)]) {
      fs.writeFileSync(store.file, text)
      expect(store.verify('alpha', token)).toBe(false)
      expect(() => store.prepare('alpha', token)).toThrow('credentials unavailable')
    }
    fs.writeFileSync(store.file, JSON.stringify({ version: 1, profiles: { alpha: token } }))
    fs.chmodSync(store.file, 0o644)
    expect(store.verify('alpha', token)).toBe(false)
    fs.chmodSync(store.file, 0o600)
    const other = path.join(root, 'fixture.json')
    fs.renameSync(store.file, other)
    fs.symlinkSync(other, store.file)
    expect(store.verify('alpha', token)).toBe(false)
    expect(() => store.prepare('alpha', token)).toThrow('credentials unavailable')
    expect(fs.readFileSync(other, 'utf8')).toContain(token)
  })

  it('HD-06 refuses a public or symlinked directory without changing its permissions', () => {
    const { root } = fixture()
    const directory = path.join(root, 'public')
    fs.mkdirSync(directory, { mode: 0o755 })
    const store = createProfileTokens(directory)
    expect(() => store.prepare('alpha', newToken())).toThrow('Unsafe')
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755)
    const link = path.join(root, 'link')
    fs.symlinkSync(directory, link)
    expect(() => createProfileTokens(link).prepare('alpha', newToken())).toThrow('Unsafe')
  })

  it('rejects invalid profile/token values and removes discarded staging files', () => {
    const { store } = fixture()
    expect(store.verify('../alpha', newToken())).toBe(false)
    expect(store.verify('alpha', null)).toBe(false)
    expect(() => store.prepare('../alpha', newToken())).toThrow('Invalid')
    const change = store.prepare('alpha', newToken())
    change.dispose()
    expect(fs.readdirSync(path.dirname(store.file))).toEqual([])
    expect(fs.existsSync(store.file)).toBe(false)
  })
})
