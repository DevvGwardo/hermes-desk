import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  actStatus,
  clickAt,
  movePointerTo,
  normalizePoint,
  JXA_SRC,
  BACKEND_NAMES,
  ACCESS_HINT,
  UNKNOWN_TRUST,
  OSA_PATH,
} = require('./screen-act.cjs')

/** Stands in for child_process.spawnSync. Records every invocation. */
function fakeRunner(handler) {
  const calls = []
  const fn = vi.fn((file, args, opts) => {
    calls.push({ file, args, opts })
    return handler ? handler({ file, args }, calls.length) : { status: 0, stdout: '', stderr: '' }
  })
  fn.calls = calls
  return fn
}

/** D-06: act spawns resolve through trusted paths — inject the mapping tests rely on. */
const TRUSTED_RESOLVE = (name) =>
  name === 'osascript' ? OSA_PATH : name === 'cliclick' ? '/usr/local/bin/cliclick' : null
const DARWIN_TRUSTED = { platform: 'darwin', isTrusted: () => true, hasBin: () => false, resolveActFile: TRUSTED_RESOLVE }
const DARWIN_UNTRUSTED = { platform: 'darwin', isTrusted: () => false, hasBin: () => false }

describe('screen-act normalizePoint', () => {
  it('rounds finite numbers and keeps them as numbers', () => {
    expect(normalizePoint(10.4, 20.6)).toEqual({ x: 10, y: 21 })
  })

  it('accepts NEGATIVE coordinates — a display left of the primary has negative x', () => {
    expect(normalizePoint(-451, 16)).toEqual({ x: -451, y: 16 })
  })

  it('accepts numeric strings (IPC payloads arrive untyped)', () => {
    expect(normalizePoint('512', '64')).toEqual({ x: 512, y: 64 })
  })

  it('rejects NaN / Infinity / undefined / empty', () => {
    for (const [x, y] of [[NaN, 1], [1, Infinity], [undefined, 2], ['', 3], ['abc', 1], [null, null]]) {
      expect(normalizePoint(x, y)).toBeNull()
    }
  })
})

describe('screen-act actStatus', () => {
  it('reports the resolved backend and full chain on darwin', () => {
    const st = actStatus(DARWIN_TRUSTED)
    expect(st.platform).toBe('darwin')
    expect(st.trusted).toBe(true)
    expect(st.backend).toBe('jxa')
    expect(st.backends).toEqual(['jxa', 'systevents'])
    expect(st.available).toBe(true)
  })

  it('prefers cliclick when it is installed', () => {
    const st = actStatus({ platform: 'darwin', isTrusted: () => true, hasBin: (n) => n === 'cliclick', resolveActFile: TRUSTED_RESOLVE })
    expect(st.backend).toBe('cliclick')
    expect(st.backends[0]).toBe('cliclick')
  })

  it('untrusted darwin is unavailable but still names its backend', () => {
    const st = actStatus(DARWIN_UNTRUSTED)
    expect(st.trusted).toBe(false)
    expect(st.available).toBe(false)
    expect(st.backend).toBe('jxa')
  })

  it('an absent trust provider means UNKNOWN, not trusted — but it still attempts', () => {
    const st = actStatus({ platform: 'darwin', hasBin: () => false })
    expect(st.trusted).toBe(UNKNOWN_TRUST)
    expect(st.trusted).not.toBe(true)
    expect(st.available).toBe(true)
  })

  it('unknown trust is never the string "true" or a truthy boolean', () => {
    // A caller doing `if (st.trusted)` must NOT read that as permission
    // granted; only `=== true` means the OS actually said yes.
    expect(UNKNOWN_TRUST).toBe('unknown')
    expect(actStatus({ platform: 'darwin', hasBin: () => false }).trusted).not.toBe(true)
  })

  it('non-darwin with no cliclick has no backend at all', () => {
    const st = actStatus({ platform: 'win32', hasBin: () => false })
    expect(st.backend).toBeNull()
    expect(st.available).toBe(false)
    expect(st.trusted).toBe(true)
  })

  it('non-darwin with cliclick still works', () => {
    const st = actStatus({ platform: 'linux', hasBin: (n) => n === 'cliclick', resolveActFile: TRUSTED_RESOLVE })
    expect(st.backend).toBe('cliclick')
    expect(st.available).toBe(true)
  })

  it('exports the backend names in resolution order', () => {
    expect(BACKEND_NAMES).toEqual(['cliclick', 'jxa', 'systevents'])
  })
})

describe('screen-act clickAt', () => {
  it('refuses to lie when Accessibility is not granted — never spawns', () => {
    const runner = fakeRunner()
    const res = clickAt(500, 400, { ...DARWIN_UNTRUSTED, runner })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('accessibility-not-trusted')
    expect(res.hint).toBe(ACCESS_HINT)
    expect(runner).not.toHaveBeenCalled()
  })

  it('posts move + down + up through osascript JXA with coords as ARGV', () => {
    const runner = fakeRunner()
    const res = clickAt(500, 400, { ...DARWIN_TRUSTED, runner })
    expect(res).toMatchObject({ ok: true, backend: 'jxa', x: 500, y: 400 })
    const call = runner.calls[0]
    expect(call.file).toBe(OSA_PATH)
    // -l JavaScript -e <source> x y mode  →  coordinates never enter the script text
    expect(call.args.slice(0, 4)).toEqual(['-l', 'JavaScript', '-e', JXA_SRC])
    expect(call.args.slice(4)).toEqual(['500', '400', 'click'])
    expect(call.args[3]).toContain('CGEventPost')
    expect(call.args[3]).toContain('kCGEventLeftMouseDown')
    expect(call.args[3]).toContain('kCGEventLeftMouseUp')
  })

  it('uses cliclick c:x,y when cliclick is installed', () => {
    const runner = fakeRunner()
    const res = clickAt(12, 34, {
      platform: 'darwin',
      isTrusted: () => true,
      hasBin: (n) => n === 'cliclick',
      resolveActFile: TRUSTED_RESOLVE,
      runner,
    })
    expect(res).toMatchObject({ ok: true, backend: 'cliclick' })
    // D-06: the spawn goes to the GUARD-RESOLVED path, never a bare name.
    expect(runner.calls[0]).toMatchObject({ file: '/usr/local/bin/cliclick', args: ['c:12,34'] })
  })

  it('falls through to the next backend when the first one fails', () => {
    const runner = fakeRunner(({ file }) =>
      file === '/usr/local/bin/cliclick' ? { status: 1, stderr: 'cliclick: no permission' } : { status: 0, stderr: '' },
    )
    const res = clickAt(9, 9, {
      platform: 'darwin',
      isTrusted: () => true,
      hasBin: (n) => n === 'cliclick',
      resolveActFile: TRUSTED_RESOLVE,
      runner,
    })
    expect(res).toMatchObject({ ok: true, backend: 'jxa' })
    expect(runner.calls.length).toBe(2)
  })

  it('reports every backend error when all of them fail', () => {
    const runner = fakeRunner(() => ({ status: 1, stderr: 'denied' }))
    const res = clickAt(9, 9, { ...DARWIN_TRUSTED, runner })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('act-failed')
    expect(res.errors.map((e) => e.backend)).toEqual(['jxa', 'systevents'])
    expect(res.errors[0].error).toBe('denied')
  })

  it('survives a missing binary (spawnSync ENOENT) and keeps trying', () => {
    const runner = fakeRunner(() => ({ error: new Error('spawnSync osascript ENOENT') }))
    const res = clickAt(1, 2, { ...DARWIN_TRUSTED, runner })
    expect(res.ok).toBe(false)
    expect(res.errors.every((e) => /ENOENT/.test(e.error))).toBe(true)
  })

  it('reports no-backend instead of pretending, on a platform with nothing', () => {
    const runner = fakeRunner()
    const res = clickAt(1, 2, { platform: 'win32', hasBin: () => false, runner })
    expect(res).toMatchObject({ ok: false, error: 'no-backend' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('rejects bad coordinates without spawning anything', () => {
    const runner = fakeRunner()
    expect(clickAt('abc', 4, { ...DARWIN_TRUSTED, runner }).error).toBe('bad-coords')
    expect(clickAt(4, NaN, { ...DARWIN_TRUSTED, runner }).error).toBe('bad-coords')
    expect(runner).not.toHaveBeenCalled()
  })

  it('an unchecked process is reported UNKNOWN, never "ok, trusted" — the live silent-drop bug', () => {
    // Reproduced on a real Mac: osascript exits 0 and the CGEvent is dropped,
    // so `ok:true` alone would have claimed the click landed. The result must
    // carry trusted:'unknown' so a caller can tell "attempted" from "landed".
    const runner = fakeRunner()
    const res = clickAt(500, 400, { platform: 'darwin', hasBin: () => false, resolveActFile: TRUSTED_RESOLVE, runner })
    expect(res.ok).toBe(true) // it did attempt, and exit 0 is all we can know
    expect(res.trusted).toBe(UNKNOWN_TRUST)
    expect(res.trusted).not.toBe(true)
  })

  it('a checked-and-trusted process reports trusted:true (distinguishable from unknown)', () => {
    const runner = fakeRunner()
    const res = clickAt(500, 400, { ...DARWIN_TRUSTED, runner })
    expect(res.trusted).toBe(true)
  })

  it('never routes coordinates through a shell string', () => {
    const runner = fakeRunner()
    clickAt(-451, 16, { ...DARWIN_TRUSTED, runner })
    const flat = runner.calls.flatMap((c) => [c.file, ...c.args])
    // The point must appear only as discrete argv entries, never glued into
    // a `-e` script or a shell one-liner.
    expect(flat).toContain('-451')
    expect(flat.some((s) => typeof s === 'string' && /click at \{-451/.test(s))).toBe(false)
  })
})

describe('screen-act movePointerTo', () => {
  it('moves without pressing (probe-safe: verifies the CGEvent path, clicks nothing)', () => {
    const runner = fakeRunner()
    const res = movePointerTo(421, 233, { ...DARWIN_TRUSTED, runner })
    expect(res).toMatchObject({ ok: true, backend: 'jxa', mode: 'move' })
    expect(runner.calls[0].args.slice(4)).toEqual(['421', '233', 'move'])
  })

  it('never selects the System Events backend (it has no move primitive)', () => {
    const runner = fakeRunner(() => ({ status: 1, stderr: 'no' }))
    const res = movePointerTo(1, 2, { ...DARWIN_TRUSTED, runner })
    expect(res.errors.map((e) => e.backend)).toEqual(['jxa'])
  })
})

describe('D-06 trusted binary resolution', () => {
  const { defaultResolveActFile } = require('./screen-act.cjs')

  it('pins osascript to its fixed macOS system path — never PATH', () => {
    expect(defaultResolveActFile('osascript')).toBe('/usr/bin/osascript')
  })

  it('a guard-refused cliclick yields null, and the cliclick backend is then unavailable', () => {
    // Real bin-guard on a PATH where cliclick does not exist (CI box).
    expect(defaultResolveActFile('cliclick')).toBeNull()
    const st = actStatus({ platform: 'darwin', isTrusted: () => true, hasBin: (n) => n === 'cliclick' })
    expect(st.backends).not.toContain('cliclick')
    expect(st.backends[0]).toBe('jxa')
  })

  it('a cliclick that EXISTS but is untrusted (group-writable) is refused by bin-guard', () => {
    // Simulate the attack: plant a group-writable cliclick early on PATH.
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd06-plant-'))
    const planted = path.join(dir, 'cliclick')
    fs.writeFileSync(planted, '#!/bin/sh\nevil\n')
    fs.chmodSync(planted, 0o775) // group-writable → verifyAndLogBin refuses
    const origPath = process.env.PATH
    process.env.PATH = dir + path.delimiter + (origPath || '')
    try {
      expect(defaultResolveActFile('cliclick')).toBeNull()
    } finally {
      process.env.PATH = origPath
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('act() refuses to spawn when every backend resolves to null', () => {
    const runner = fakeRunner()
    const res = clickAt(1, 2, {
      platform: 'darwin',
      isTrusted: () => true,
      hasBin: () => true,
      resolveActFile: () => null,
      runner,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('act-failed')
    expect(runner).not.toHaveBeenCalled()
  })
})
