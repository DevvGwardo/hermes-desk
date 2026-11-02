import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const seal = require('./self-modification-seal.cjs')
const tree = require('./self-modification-artifact.cjs')
const roots = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-seal-unit-')))
  roots.push(root)
  const source = path.join(root, 'source'), deps = path.join(root, 'deps'), renderer = path.join(root, 'renderer')
  for (const name of [source, deps, renderer]) fs.mkdirSync(name)
  fs.mkdirSync(path.join(source, 'electron'))
  fs.writeFileSync(path.join(source, 'electron/main.cjs'), 'throw Error("must not execute")')
  fs.writeFileSync(path.join(source, 'electron/preload.cjs'), 'throw Error("must not execute")')
  fs.writeFileSync(path.join(deps, 'package.json'), '{"scripts":{"postinstall":"must-not-execute"}}')
  fs.mkdirSync(path.join(deps, 'package'))
  fs.writeFileSync(path.join(deps, 'package/index.cjs'), 'throw Error("must not execute")')
  fs.symlinkSync('package', path.join(deps, 'internal'))
  fs.writeFileSync(path.join(renderer, 'index.html'), '<h1>sealed</h1>')
  return { root, source, deps, renderer, runtime: { dependencies: deps, digest: 'a'.repeat(64) } }
}
describe('full app input sealing without executing candidate or dependency code', () => {
  it('preserves exact source modes rather than silently applying the process umask', async () => {
    const f = fixture(), output = path.join(f.root, 'mode-copy')
    fs.chmodSync(path.join(f.source, 'electron/main.cjs'), 0o666)
    const initial = await tree.capture(f.source)
    tree.materialize(output, initial.files)
    expect((await tree.capture(output)).digest).toBe(initial.digest)
  })
  it('copies all source, renderer and provisioned graph bytes/modes/relative links into one identity', async () => {
    const f = fixture(), input = await seal.provenance(f.runtime)
    const output = path.join(f.root, 'sealed')
    const result = await seal.create(output, await tree.capture(f.source), await tree.capture(f.renderer), f.runtime, input, () => {})
    expect((await seal.capture(output, { allowLinks: true })).digest).toBe(result.digest)
    expect(fs.readlinkSync(path.join(output, 'app/node_modules/internal'))).toBe('package')
    expect(fs.readFileSync(path.join(output, 'app/electron/main.cjs'), 'utf8')).toContain('must not execute')
    const declared = JSON.parse(fs.readFileSync(path.join(output, 'provenance.json')))
    expect(declared).toMatchObject({ provisionedGraphCopied: true, activationEligible: false,
      fullAppQualified: false, externalSystemAndBuildServicesQualified: false, dependencyDigest: input.dependencies.digest })
    fs.appendFileSync(path.join(f.deps, 'package/index.cjs'), '// later original mutation')
    expect((await seal.capture(output, { allowLinks: true })).digest).toBe(result.digest)
  })
  it.each(['escape', 'absolute', 'dangling', 'hardlink', 'fifo', 'sensitive'])('refuses a %s dependency entry', async kind => {
    const f = fixture(), target = path.join(f.deps, 'unsafe')
    if (kind === 'escape') fs.symlinkSync('../source', target)
    if (kind === 'absolute') fs.symlinkSync(path.join(f.deps, 'package'), target)
    if (kind === 'dangling') fs.symlinkSync('missing', target)
    if (kind === 'hardlink') fs.linkSync(path.join(f.deps, 'package.json'), target)
    if (kind === 'fifo') require('node:child_process').execFileSync('/usr/bin/mkfifo', [target])
    if (kind === 'sensitive') fs.writeFileSync(path.join(f.deps, '.env'), 'fixture secret')
    await expect(seal.provenance(f.runtime)).rejects.toThrow()
  })
  it.each(['bytes', 'file-mode', 'dir-mode', 'link-target', 'added'])('binds %s mutations in the digest', async kind => {
    const f = fixture(), before = await seal.capture(f.deps, { allowLinks: true })
    if (kind === 'bytes') fs.appendFileSync(path.join(f.deps, 'package/index.cjs'), '// mutation')
    if (kind === 'file-mode') fs.chmodSync(path.join(f.deps, 'package/index.cjs'), 0o755)
    if (kind === 'dir-mode') fs.chmodSync(path.join(f.deps, 'package'), 0o711)
    if (kind === 'link-target') { fs.unlinkSync(path.join(f.deps, 'internal')); fs.symlinkSync('package/index.cjs', path.join(f.deps, 'internal')) }
    if (kind === 'added') fs.writeFileSync(path.join(f.deps, 'extra'), 'extra')
    expect((await seal.capture(f.deps, { allowLinks: true })).digest).not.toBe(before.digest)
  })
  it('rejects a source root replacement, retains partial work, and writes nothing through the replacement', async () => {
    const f = fixture(), before = await seal.capture(f.deps, { allowLinks: true }), output = path.join(f.root, 'copy')
    fs.renameSync(f.deps, f.deps + '-old'); fs.mkdirSync(f.deps)
    await expect(seal.copy(f.deps, output, before, () => {})).rejects.toThrow()
    expect(fs.existsSync(output)).toBe(false)
  })
  it('fences cancellation during real streamed copying and retains partial files', async () => {
    const f = fixture(), before = await seal.capture(f.deps, { allowLinks: true }), output = path.join(f.root, 'copy')
    let checks = 0
    await expect(seal.copy(f.deps, output, before, () => { if (++checks > 6) throw Error('cancelled') })).rejects.toThrow('cancelled')
    expect(fs.existsSync(output)).toBe(true)
    expect(fs.readFileSync(path.join(f.deps, 'package.json'), 'utf8')).toContain('must-not-execute')
  })
  it('durably flushes every copied file with a bounded concurrent batch before accepting its exact graph', async () => {
    const f = fixture(), output = path.join(f.root, 'copy')
    for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(f.deps, `file-${i}`), `bounded-${i}`)
    const before = await seal.capture(f.deps, { allowLinks: true })
    const realSync = fs.fsync.bind(fs), opened = []
    let pending = 0, maxPending = 0
    const sync = vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => {
      opened.push(fd); maxPending = Math.max(maxPending, ++pending)
      setTimeout(() => realSync(fd, error => { pending--; callback(error) }), 2)
    })
    const syncBlocking = vi.spyOn(fs, 'fsyncSync')
    const copied = await seal.copy(f.deps, output, before, () => {})
    expect(copied.digest).toBe(before.digest)
    expect(sync).toHaveBeenCalledTimes(before.manifest.filter(entry => entry.type === 'file').length)
    expect(syncBlocking).not.toHaveBeenCalled()
    expect(maxPending).toBeGreaterThan(1)
    expect(maxPending).toBeLessThanOrEqual(8)
    expect(pending).toBe(0)
    for (const fd of opened) expect(() => fs.fstatSync(fd)).toThrow()
  })
  it('applies directory modes through owned no-follow descriptors, never a swappable chmod pathname', async () => {
    const f = fixture(), output = path.join(f.root, 'copy')
    fs.chmodSync(path.join(f.deps, 'package'), 0o700)
    const before = await seal.capture(f.deps, { allowLinks: true }), sourceMode = fs.statSync(f.source).mode
    const realChmod = fs.chmodSync.bind(fs)
    const pathChmod = vi.spyOn(fs, 'chmodSync').mockImplementation((name, mode) => {
      if (name === path.join(output, 'package')) {
        fs.renameSync(name, name + '-old'); fs.symlinkSync(f.source, name)
      }
      realChmod(name, mode)
    })
    expect((await seal.copy(f.deps, output, before, () => {})).digest).toBe(before.digest)
    expect(pathChmod).not.toHaveBeenCalled()
    expect(fs.statSync(f.source).mode).toBe(sourceMode)
  })
  it.each(['EIO', 'sync-throw', 'cancel', 'source-replaced', 'destination-replaced', 'parent-link'])(
    'drains all owned flush descriptors and retains partial work after %s without accepting a graph',
    async kind => {
      const f = fixture(), output = path.join(f.root, 'copy')
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(f.deps, `z-${i}`), 'owned partial work')
      fs.chmodSync(path.join(f.deps, 'package'), 0o700)
      const before = await seal.capture(f.deps, { allowLinks: true })
      const sourceMode = fs.statSync(f.source).mode
      const realSync = fs.fsync.bind(fs), opened = []
      let pending = 0, cancelled = false, first = true
      const sync = vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => {
        opened.push(fd)
        if (kind === 'sync-throw') throw Object.assign(Error('owned flush throw'), { code: 'EIO' })
        pending++
        setTimeout(() => {
          if (first) {
            first = false
            if (kind === 'cancel') cancelled = true
            if (kind === 'source-replaced') { fs.renameSync(f.deps, f.deps + '-old'); fs.mkdirSync(f.deps) }
            if (kind === 'destination-replaced') { fs.renameSync(output, output + '-old'); fs.mkdirSync(output) }
            if (kind === 'parent-link') {
              fs.renameSync(path.join(output, 'package'), path.join(output, 'package-old'))
              fs.symlinkSync(f.source, path.join(output, 'package'))
            }
          }
          realSync(fd, error => {
            pending--
            callback(kind === 'EIO' ? Object.assign(Error('owned flush EIO'), { code: 'EIO' }) : error)
          })
        }, 2)
      })
      await expect(seal.copy(f.deps, output, before, () => {
        if (cancelled) throw Error('cancelled during owned flush')
      })).rejects.toThrow()
      expect(sync).toHaveBeenCalled()
      expect(pending).toBe(0)
      for (const fd of opened) expect(() => fs.fstatSync(fd)).toThrow()
      expect(fs.existsSync(output)).toBe(true)
      expect(fs.statSync(f.source).mode).toBe(sourceMode)
      expect(fs.readFileSync(path.join(f.source, 'electron/main.cjs'), 'utf8')).toContain('must not execute')
    },
  )
})
