import { createRequire } from 'node:module'
import { mkdtempSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const mod = require('./bin-guard.cjs')
const { inspectBinTrust, verifyAndLogBin } = mod

function makeTempBin(mode) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bin-guard-'))
  const bin = path.join(dir, 'tool')
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, mode)
  return { dir, bin }
}

describe('M5: inspectBinTrust', () => {
  it('accepts a normal owner-only executable (0755)', () => {
    const { dir, bin } = makeTempBin(0o755)
    try {
      expect(inspectBinTrust(bin).ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a group-writable binary (tamper vector)', () => {
    if (process.platform === 'win32') return
    const { dir, bin } = makeTempBin(0o775)
    try {
      const verdict = inspectBinTrust(bin)
      expect(verdict.ok).toBe(false)
      expect(verdict.error).toMatch(/writable/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a world-writable binary', () => {
    if (process.platform === 'win32') return
    const { dir, bin } = makeTempBin(0o757)
    try {
      expect(inspectBinTrust(bin).ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses directories and missing paths', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bin-guard-dir-'))
    try {
      expect(inspectBinTrust(dir).ok).toBe(false)
      expect(inspectBinTrust(path.join(dir, 'nope')).ok).toBe(false)
      expect(inspectBinTrust('').ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the reason for empty, missing and unstattable paths', () => {
    for (const value of ['', null, undefined, 42]) {
      expect(inspectBinTrust(value)).toEqual({ ok: false, error: 'empty binary path' })
    }
    expect(inspectBinTrust('/opt/tool', { existsSync: () => false, statSync: () => { throw new Error('unreachable') } }))
      .toEqual({ ok: false, error: 'not found: /opt/tool' })
    const res = inspectBinTrust('/opt/tool', { existsSync: () => true, statSync: () => { throw new Error('EACCES') } })
    expect(res).toEqual({ ok: false, error: 'stat failed for /opt/tool: EACCES' })
  })
})

describe('M5: verifyAndLogBin', () => {
  it('logs the resolved path on success and the refusal reason on failure', () => {
    const lines = []
    const deps = { log: (l) => lines.push(l) }
    const { dir, bin } = makeTempBin(0o755)
    try {
      mkdirSync(path.join(dir, 'sub'), { recursive: true })
      const okVerdict = verifyAndLogBin(bin, 'whisper-cli', deps)
      expect(okVerdict.ok).toBe(true)
      const badVerdict = verifyAndLogBin(path.join(dir, 'missing'), 'ffmpeg', deps)
      expect(badVerdict.ok).toBe(false)
      const joined = lines.join('\n')
      expect(joined).toContain('[bin-guard] whisper-cli')
      expect(joined).toContain(bin)
      expect(joined).toMatch(/REFUSED/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pass 3: resolveTrustedBin', () => {
  it('resolves a trusted binary from an extra dir appended after PATH', () => {
    const { dir, bin } = makeTempBin(0o755)
    try {
      const res = mod.resolveTrustedBin('tool', {
        extraDirs: [dir],
        deps: { log: () => {} },
      })
      expect(res.ok).toBe(true)
      expect(res.bin).toBe(bin)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips untrusted candidates and keeps searching (or reports refusal)', () => {
    const safeDir = mkdtempSync(path.join(os.tmpdir(), 'bin-guard-safe-'))
    const evilDir = mkdtempSync(path.join(os.tmpdir(), 'bin-guard-evil-'))
    try {
      // Evil (group-writable) binary earlier in PATH; good one in fallbacks.
      const evil = path.join(evilDir, 'tool')
      writeFileSync(evil, '#!/bin/sh\n')
      chmodSync(evil, 0o775)
      const good = path.join(safeDir, 'tool')
      writeFileSync(good, '#!/bin/sh\n')
      chmodSync(good, 0o755)

      const savedPath = process.env.PATH
      process.env.PATH = `${evilDir}:${safeDir}`
      try {
        const lines = []
        const res = mod.resolveTrustedBin('tool', { deps: { log: (l) => lines.push(l) } })
        if (res.ok) {
          // If PATH search found both, the trusted one must have won.
          expect(res.bin).not.toBe(evil)
        } else {
          expect(res.error).toMatch(/refused|not found/)
        }
        expect(lines.join('\n')).toMatch(/REFUSED/)
      } finally {
        process.env.PATH = savedPath
      }
    } finally {
      rmSync(safeDir, { recursive: true, force: true })
      rmSync(evilDir, { recursive: true, force: true })
    }
  })

  it('rejects bare-name violations', () => {
    expect(mod.resolveTrustedBin('/bin/ls').ok).toBe(false)
    expect(mod.resolveTrustedBin('').ok).toBe(false)
    expect(mod.resolveTrustedBin(null).ok).toBe(false)
  })

  it('rejects path-shaped names even when the target exists and is trusted', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bin-guard-nested-'))
    try {
      mkdirSync(path.join(dir, 'sub'))
      writeFileSync(path.join(dir, 'sub', 'tool'), '#!/bin/sh\n')
      chmodSync(path.join(dir, 'sub', 'tool'), 0o755)
      const opts = { extraDirs: [dir], deps: { log: () => {} } }
      for (const name of ['sub/tool', `..${path.sep}${path.basename(dir)}/sub/tool`, 'sub\\tool']) {
        expect(mod.resolveTrustedBin(name, opts)).toEqual({ ok: false, error: 'binary name must be a bare name' })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a candidate without the execute bit', () => {
    const { dir } = makeTempBin(0o644)
    try {
      const res = mod.resolveTrustedBin('tool', { extraDirs: [dir], deps: { log: () => {} } })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/not found on PATH \(\+ fallbacks\)/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('searches PATH before extra dirs', () => {
    const first = makeTempBin(0o755)
    const fallback = makeTempBin(0o755)
    const savedPath = process.env.PATH
    process.env.PATH = first.dir
    try {
      const res = mod.resolveTrustedBin('tool', { extraDirs: [fallback.dir], deps: { log: () => {} } })
      expect(res).toEqual({ ok: true, bin: first.bin })
    } finally {
      process.env.PATH = savedPath
      rmSync(first.dir, { recursive: true, force: true })
      rmSync(fallback.dir, { recursive: true, force: true })
    }
  })

  it('logs each distinct resolution only once per process (no git-status spam)', () => {
    const { dir, bin } = makeTempBin(0o755)
    try {
      const lines = []
      const deps = { log: (l) => lines.push(l) }
      mod.resolveTrustedBin('tool', { extraDirs: [dir], deps })
      mod.resolveTrustedBin('tool', { extraDirs: [dir], deps })
      mod.resolveTrustedBin('tool', { extraDirs: [dir], deps })
      const hits = lines.filter((l) => l.includes(bin)).length
      expect(hits).toBeLessThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
