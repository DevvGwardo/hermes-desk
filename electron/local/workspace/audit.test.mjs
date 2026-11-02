import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createAudit, MAX_BYTES } = require('./audit.cjs')
const roots = []
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-audit-test-'))
  roots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('workspace metadata-only audit', () => {
  it.each(['not_enabled', 'app_unavailable'])('preserves MCP result code %s', (result) => {
    const userDataDir = temporary()
    createAudit({ userDataDir }).log({ action: 'browser_snapshot', result })
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'audit.jsonl'), 'utf8')).result).toBe(result)
  })

  it('writes exact, restrictive metadata without content, query strings, or secrets', () => {
    const userDataDir = temporary()
    const audit = createAudit({ userDataDir, now: () => new Date('2026-10-06T00:00:00Z') })
    expect(audit.log({ agent: 'scout', lane: 'profile:scout', tab: 't_123', action: 'browser_click',
      origin: 'https://example.test/private?token=obviously-fake#obviously-fake',
      result: 'ok', durationMs: 12.7, byUser: false, text: 'obviously-fake', secret: 'obviously-fake',
      snapshot: 'obviously-fake' })).toBe(true)
    const text = fs.readFileSync(path.join(userDataDir, 'audit.jsonl'), 'utf8')
    expect(text).not.toContain('obviously-fake')
    expect(JSON.parse(text)).toEqual({ ts: '2026-10-06T00:00:00.000Z', agent: 'scout',
      lane: 'profile:scout', tab: 't_123', action: 'browser_click', origin: 'https://example.test',
      result: 'ok', durationMs: 13, byUser: false })
    expect(fs.statSync(path.join(userDataDir, 'audit.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('rotates at 5 MB and keeps exactly three files', () => {
    expect(MAX_BYTES).toBe(5 * 1024 * 1024)
    const userDataDir = temporary()
    const file = path.join(userDataDir, 'audit.jsonl')
    const audit = createAudit({ userDataDir })
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(file, Buffer.alloc(MAX_BYTES, ' '))
      expect(audit.log({ action: `rotation.${i}`, result: 'ok' })).toBe(true)
      expect(fs.statSync(file).size).toBeLessThan(MAX_BYTES)
    }
    expect(fs.readdirSync(userDataDir).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2'])
    expect(fs.statSync(`${file}.1`).size).toBe(MAX_BYTES)
    expect(fs.statSync(`${file}.2`).size).toBe(MAX_BYTES)
  })

  it('does not serialize arbitrary error text and rejects symlink log targets', () => {
    const userDataDir = temporary()
    const audit = createAudit({ userDataDir })
    audit.log({ action: 'obviously fake secret', agent: 'not valid', lane: '../outside',
      tab: 'not-valid', origin: 'file:///private', result: 'obviously-fake-secret', durationMs: NaN })
    const text = fs.readFileSync(path.join(userDataDir, 'audit.jsonl'), 'utf8')
    expect(text).not.toMatch(/secret|outside|private/)
    const other = temporary()
    const target = path.join(other, 'untouched')
    fs.writeFileSync(target, 'untouched')
    const linked = temporary()
    fs.symlinkSync(target, path.join(linked, 'audit.jsonl'))
    const onError = vi.fn()
    expect(createAudit({ userDataDir: linked, onError }).log({ action: 'test', result: 'ok' })).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched')
    expect(onError).toHaveBeenCalledWith('Workspace audit unavailable')
  })

  it('does not coerce metadata objects or let a malicious tab ID inflate the log', () => {
    const userDataDir = temporary()
    const audit = createAudit({ userDataDir })
    const agent = { toString: () => 'scout', content: 'obviously-fake-secret' }
    const lane = { toString: () => 'profile:scout', content: 'obviously-fake-secret' }
    audit.log({ agent, lane, tab: `t_${'a'.repeat(MAX_BYTES)}`, action: 'test', result: 'ok' })
    const text = fs.readFileSync(path.join(userDataDir, 'audit.jsonl'), 'utf8')
    expect(text).not.toContain('obviously-fake-secret')
    expect(JSON.parse(text)).toMatchObject({ agent: null, lane: null, tab: null })
    expect(text.length).toBeLessThan(1024)
  })
})
