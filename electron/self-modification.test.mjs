import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const { createChangeController, registerChangeController } = require('./self-modification.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture(io = fs) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-change-unit-')))
  roots.push(root)
  return { root, file: path.join(root, 'self-modification/changes.json'), controller: createChangeController(root, io) }
}
const input = { request: 'Make chat search clearer', acceptanceCriteria: 'Search finds a saved request by its title.' }
function save(controller, revision = 0) {
  const result = controller.create(revision, input)
  expect(result.ok).toBe(true)
  return result
}
function latest(snapshot) {
  const change = snapshot.changes.at(-1)
  return [change.id, change.attempts.at(-1).id]
}

describe('trusted change request controller', () => {
  it('does not create storage on startup or an empty read', () => {
    const { controller, root } = fixture()
    expect(controller.list()).toEqual({ ok: true, revision: 0, changes: [] })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('persists bounded inert requests, independent of renderer and controller lifetime', () => {
    const { controller, root, file } = fixture()
    const saved = save(controller)
    expect(createChangeController(root).list()).toEqual(saved)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(record.version).toBe(7)
    expect(record.lifecycleVersion).toBe(7)
    expect(record.changes[0].attempts[0]).toMatchObject({ state: 'requested', epoch: 0, cancelledAt: null })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['changes.json'])
  })

  it('cancels durably and reopens with distinct attempt identity and epoch', () => {
    const { controller, root } = fixture()
    const first = save(controller)
    const cancelled = controller.cancel(first.revision, ...latest(first))
    expect(cancelled.ok).toBe(true)
    expect(createChangeController(root).list()).toEqual(cancelled)
    expect(cancelled.changes[0].cancellationEpoch).toBe(1)
    const reopened = controller.reopen(cancelled.revision, ...latest(cancelled))
    expect(reopened.ok).toBe(true)
    const [old, next] = reopened.changes[0].attempts
    expect(old).toEqual(cancelled.changes[0].attempts[0])
    expect(next.id).not.toBe(old.id)
    expect(next).toMatchObject({ state: 'requested', epoch: 2, cancelledAt: null })
    expect(reopened.changes[0].cancellationEpoch).toBe(2)
    expect(createChangeController(root).list()).toEqual(reopened)
  })

  it('fences stale revisions across controllers without dropping records', () => {
    const { controller, root, file } = fixture()
    const other = createChangeController(root)
    save(controller)
    const bytes = fs.readFileSync(file, 'utf8')
    expect(other.create(0, input)).toMatchObject({ ok: false, code: 'stale' })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    save(other, 1)
    expect(controller.list().changes).toHaveLength(2)
  })

  it('fences old attempts and rejects invalid transitions even with a fresh revision', () => {
    const { controller, file } = fixture()
    const first = save(controller)
    expect(controller.reopen(first.revision, ...latest(first))).toMatchObject({ ok: false, code: 'stale' })
    const cancelled = controller.cancel(first.revision, ...latest(first))
    expect(controller.cancel(cancelled.revision, ...latest(cancelled))).toMatchObject({ ok: false, code: 'stale' })
    const reopened = controller.reopen(cancelled.revision, ...latest(cancelled))
    const bytes = fs.readFileSync(file, 'utf8')
    expect(controller.cancel(reopened.revision, ...latest(first))).toMatchObject({ ok: false, code: 'stale' })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
  })

  it.each([
    {}, null, [], { ...input, command: 'npm run install:local' }, { ...input, request: '  ' },
    { ...input, request: 'x'.repeat(8001) }, { ...input, acceptanceCriteria: 'x'.repeat(4001) },
    { ...input, request: 'bad\0input' },
  ])('rejects malformed request %# without writing a journal', bad => {
    const { controller, file } = fixture()
    expect(controller.create(0, bad)).toMatchObject({ ok: false, code: 'invalid' })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('accepts maximum-length text as data, not executable instructions', () => {
    const { controller } = fixture()
    const result = controller.create(0, { request: '<script>throw new Error()</script>'.padEnd(8000, 'x'),
      acceptanceCriteria: 'x'.repeat(4000) })
    expect(result.ok).toBe(true)
  })

  it.each([-1, 0.5, '0', Number.MAX_SAFE_INTEGER, null])('rejects invalid revision %j', revision => {
    const { controller, root } = fixture()
    expect(controller.create(revision, input)).toMatchObject({ ok: false, code: 'invalid' })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it.each([
    raw => 'not json',
    raw => ({ ...raw, version: 99 }),
    raw => ({ ...raw, lifecycleVersion: 99 }),
    raw => ({ ...raw, revision: -1 }),
    raw => ({ ...raw, changes: [{ ...raw.changes[0], id: [raw.changes[0].id] }] }),
    raw => ({ ...raw, changes: [{ ...raw.changes[0], attempts: [{ ...raw.changes[0].attempts[0],
      id: [raw.changes[0].attempts[0].id] }] }] }),
    raw => ({ ...raw, changes: [{ ...raw.changes[0], cancellationEpoch: 999 }] }),
    raw => ({ ...raw, changes: [{ ...raw.changes[0], approval: true }] }),
    raw => ({ ...raw, changes: [{ ...raw.changes[0], attempts: [{ ...raw.changes[0].attempts[0], state: 'approved' }] }] }),
  ])('retains malformed/unsupported records and blocks mutations', corrupt => {
    const { controller, file } = fixture()
    const first = save(controller)
    const value = corrupt(JSON.parse(fs.readFileSync(file, 'utf8')))
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    fs.writeFileSync(file, raw)
    expect(controller.list()).toMatchObject({ ok: false, code: 'storage' })
    expect(controller.cancel(first.revision, ...latest(first))).toMatchObject({ ok: false, code: 'storage' })
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })

  it('refuses journal disappearance after it has been observed', () => {
    const { controller, file } = fixture()
    save(controller)
    fs.unlinkSync(file)
    expect(controller.list()).toMatchObject({ ok: false, code: 'storage' })
    expect(controller.create(1, input)).toMatchObject({ ok: false, code: 'storage' })
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each(['writeFileSync', 'fsyncSync', 'renameSync'])('preserves saved bytes when %s fails', method => {
    let fail = false
    const io = { ...fs, [method]: (...args) => {
      if (fail) throw Object.assign(new Error('Synthetic disk-full'), { code: 'ENOSPC' })
      return fs[method](...args)
    } }
    const { controller, file, root } = fixture(io)
    const first = save(controller)
    const bytes = fs.readFileSync(file, 'utf8')
    fail = true
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    expect(createChangeController(root).list()).toEqual(first)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['changes.json'])
  })

  it('reports uncertain rename outcomes and recovers the actual committed record without replay', () => {
    const io = { ...fs, renameSync: (...args) => { fs.renameSync(...args); throw new Error('Lost acknowledgment') } }
    const { controller, root } = fixture(io)
    expect(controller.create(0, input)).toMatchObject({ ok: false, code: 'uncertain' })
    const recovered = createChangeController(root).list()
    expect(recovered.ok).toBe(true)
    expect(recovered.revision).toBe(1)
    expect(recovered.changes).toHaveLength(1)
  })

  it('does not turn a committed rename into failure if directory sync is unavailable', () => {
    const io = { ...fs, fsyncSync: fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('Directory fsync unavailable')
      fs.fsyncSync(fd)
    } }
    const { controller, root } = fixture(io)
    const saved = save(controller)
    expect(createChangeController(root).list()).toEqual(saved)
  })

  it('does not break a live or unknown writer lock', () => {
    const { controller, file } = fixture()
    const first = save(controller)
    const lock = path.join(path.dirname(file), 'writer.lock')
    for (const raw of ['broken', JSON.stringify({ pid: process.pid, nonce: randomUUID() })]) {
      fs.writeFileSync(lock, raw)
      expect(controller.cancel(first.revision, ...latest(first))).toMatchObject({ ok: false, code: 'storage' })
      expect(fs.readFileSync(lock, 'utf8')).toBe(raw)
      expect(controller.list()).toEqual(first)
    }
  })

  it('recovers an unchanged dead writer lock but never cleans orphan candidate data', () => {
    const { controller, file } = fixture()
    const first = save(controller)
    expect(() => process.kill(2147483647, 0)).toThrow()
    fs.writeFileSync(path.join(path.dirname(file), 'writer.lock'), JSON.stringify({ pid: 2147483647, nonce: randomUUID() }))
    const orphan = path.join(path.dirname(file), 'changes.tmp-unowned')
    fs.writeFileSync(orphan, 'recoverable')
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(true)
    expect(fs.readFileSync(orphan, 'utf8')).toBe('recoverable')
  })

  it('refuses a replaced dead lock during recovery', () => {
    let replace = false
    const io = { ...fs, lstatSync: name => {
      if (replace && name.endsWith('writer.lock')) {
        replace = false
        fs.renameSync(name, `${name}.old`)
        fs.writeFileSync(name, 'replacement')
      }
      return fs.lstatSync(name)
    } }
    const { controller, file } = fixture(io)
    const first = save(controller)
    const lock = path.join(path.dirname(file), 'writer.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, nonce: randomUUID() }))
    replace = true
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(fs.readFileSync(lock, 'utf8')).toBe('replacement')
    expect(controller.list()).toEqual(first)
  })

  it('refuses symlinked journal files without touching the destination', () => {
    const { controller, file, root } = fixture()
    const first = save(controller)
    const target = path.join(root, 'outside.json')
    fs.renameSync(file, target)
    fs.symlinkSync(target, file)
    expect(controller.list().ok).toBe(false)
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(createChangeController(root).list().ok).toBe(false)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).revision).toBe(1)
  })

  it.each(['symlink', 'replacement'])('refuses %s storage directories and preserves old data', kind => {
    const { controller, root, file } = fixture()
    const first = save(controller)
    const dir = path.dirname(file)
    fs.renameSync(dir, `${dir}.old`)
    if (kind === 'symlink') fs.symlinkSync(`${dir}.old`, dir)
    else fs.mkdirSync(dir)
    expect(controller.list().ok).toBe(false)
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(`${dir}.old`, 'changes.json'), 'utf8')).revision).toBe(1)
  })

  it('detects parent replacement during a write and does not clean the moved directory', () => {
    let replace = false, directory
    const io = { ...fs, fsyncSync: fd => {
      fs.fsyncSync(fd)
      if (replace && fs.fstatSync(fd).size > 100) {
        replace = false
        fs.renameSync(directory, `${directory}.old`)
        fs.mkdirSync(directory)
      }
    } }
    const { controller, file } = fixture(io)
    directory = path.dirname(file)
    const first = save(controller)
    replace = true
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(fs.readdirSync(directory)).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(`${directory}.old`, 'changes.json'), 'utf8')).revision).toBe(1)
    expect(fs.readdirSync(`${directory}.old`)).toContain('writer.lock')
  })

  it('refuses a replaced temporary journal and preserves the replacement for review', () => {
    let replace = false, directory
    const io = { ...fs, fsyncSync: fd => {
      fs.fsyncSync(fd)
      if (replace && fs.fstatSync(fd).size > 100) {
        replace = false
        const temp = path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('changes.tmp-')))
        fs.renameSync(temp, `${temp}.old`)
        fs.writeFileSync(temp, 'unowned replacement')
      }
    } }
    const { controller, file } = fixture(io)
    directory = path.dirname(file)
    const first = save(controller)
    expect(first.ok).toBe(true)
    const bytes = fs.readFileSync(file, 'utf8')
    replace = true
    expect(controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    const temp = fs.readdirSync(directory).find(name => name.startsWith('changes.tmp-') && !name.endsWith('.old'))
    expect(fs.readFileSync(path.join(directory, temp), 'utf8')).toBe('unowned replacement')
    expect(fs.readdirSync(directory)).not.toContain('writer.lock')
  })

  it('refuses a journal replacement before rename without deleting either record', () => {
    let replace = false, file
    const io = { ...fs, fsyncSync: fd => {
      fs.fsyncSync(fd)
      if (replace && fs.fstatSync(fd).size > 100) {
        replace = false
        fs.renameSync(file, `${file}.old`)
        fs.writeFileSync(file, 'unowned journal')
      }
    } }
    const fixtureValue = fixture(io)
    file = fixtureValue.file
    const first = save(fixtureValue.controller)
    const bytes = fs.readFileSync(file, 'utf8')
    replace = true
    expect(fixtureValue.controller.cancel(first.revision, ...latest(first)).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('unowned journal')
    expect(fs.readFileSync(`${file}.old`, 'utf8')).toBe(bytes)
  })

  it('bounds total records and retained attempts without discarding history', () => {
    const { controller, file } = fixture()
    const first = save(controller)
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    envelope.changes = Array.from({ length: 200 }, () => ({ ...first.changes[0], id: randomUUID(),
      attempts: [{ ...first.changes[0].attempts[0], id: randomUUID() }] }))
    fs.writeFileSync(file, JSON.stringify(envelope))
    expect(controller.create(1, input)).toMatchObject({ ok: false, code: 'limit' })
    expect(controller.list().changes).toHaveLength(200)
    const change = { ...first.changes[0], cancellationEpoch: 99, attempts: Array.from({ length: 50 }, (_, index) => ({
      ...first.changes[0].attempts[0], id: randomUUID(), epoch: index * 2, state: 'cancelled',
      cancelledAt: first.changes[0].createdAt,
    })) }
    envelope.changes = [change]
    const bytes = JSON.stringify(envelope)
    fs.writeFileSync(file, bytes)
    expect(controller.reopen(1, change.id, change.attempts.at(-1).id)).toMatchObject({ ok: false, code: 'limit' })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('refuses oversized on-disk data without resetting it', () => {
    const { controller, file } = fixture()
    save(controller)
    const bytes = 'x'.repeat(4 * 1024 * 1024 + 1)
    fs.writeFileSync(file, bytes)
    expect(controller.list()).toMatchObject({ ok: false, code: 'storage' })
    expect(controller.create(1, input)).toMatchObject({ ok: false, code: 'storage' })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
  })

  it('has no executable or approval side effects and writes only its local journal', () => {
    const { controller, root } = fixture()
    fs.writeFileSync(path.join(root, 'source.js'), 'source remains untouched')
    fs.writeFileSync(path.join(root, 'installed-app'), 'installed app remains untouched')
    const source = fs.readFileSync(require.resolve('./self-modification.cjs'), 'utf8')
    const imports = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1])
    expect(imports).toEqual(['node:fs', 'node:path', 'node:crypto',
      './self-modification-schema.cjs', './self-modification-workspace.cjs', './self-modification-review.cjs',
      './self-modification-delivery.cjs', 'node:fs', './self-modification-review.cjs',
      './self-modification-validation.cjs', './self-modification-preview.cjs', './self-modification-execution.cjs'])
    const first = save(controller)
    const cancelled = controller.cancel(first.revision, ...latest(first))
    expect(controller.reopen(cancelled.revision, ...latest(cancelled)).ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'source.js'), 'utf8')).toBe('source remains untouched')
    expect(fs.readFileSync(path.join(root, 'installed-app'), 'utf8')).toBe('installed app remains untouched')
    expect(fs.readdirSync(root).sort()).toEqual(['installed-app', 'self-modification', 'source.js'])
  })
})

describe('change IPC authority and preload', () => {
  function ipcFixture() {
    const { root, file } = fixture()
    const handlers = new Map()
    const frame = {}
    const main = { webContents: { mainFrame: frame } }
    const getUserDataDir = vi.fn(() => root)
    const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }
    const off = registerChangeController({ ipcMain, getMainWindow: () => main, getUserDataDir,
      assertMainSender: event => { if (event.sender !== main.webContents) throw new Error('Rejected') } })
    const event = { sender: main.webContents, senderFrame: frame }
    return { handlers, off, event, getUserDataDir, file }
  }

  it('accepts only exact bounded operations from the primary main frame', async () => {
    const { handlers, off, event } = ipcFixture()
    expect([...handlers.keys()]).toEqual(['hd:changes:list', 'hd:changes:create', 'hd:changes:cancel', 'hd:changes:reopen',
      'hd:changes:selectRepository', 'hd:changes:prepare', 'hd:changes:review', 'hd:changes:implement',
      'hd:changes:validate', 'hd:changes:preview', 'hd:changes:authority', 'hd:changes:seal', 'hd:changes:boundBuild', 'hd:changes:nativeInputs', 'hd:changes:deliveryStatus', 'hd:changes:qualify',
      'hd:changes:deliveryReview', 'hd:changes:approve', 'hd:changes:selectActivationTarget', 'hd:changes:activate'])
    const first = await handlers.get('hd:changes:create')(event, 0, input)
    expect(first.ok).toBe(true)
    expect(await handlers.get('hd:changes:list')(event)).toEqual(first)
    off()
    expect(handlers.size).toBe(0)
  })

  it('rejects foreign windows, subframes and extra arguments before storage access', async () => {
    const { handlers, event, getUserDataDir, file } = ipcFixture()
    const handler = handlers.get('hd:changes:create')
    expect((await handler({ sender: {}, senderFrame: {} }, 0, input)).ok).toBe(false)
    expect((await handler({ ...event, senderFrame: {} }, 0, input)).ok).toBe(false)
    expect((await handler(event, 0, input, 'extra')).ok).toBe(false)
    expect((await handler(event, 0)).ok).toBe(false)
    expect(getUserDataDir).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('fences candidate execution callers before reading storage or opening native confirmation', async () => {
    const { handlers, event, getUserDataDir } = ipcFixture()
    const handler = handlers.get('hd:changes:implement')
    const args = [0, 'id', 'attempt', { port: 8080, model: 'fixture-model', files: ['note.txt'] }]
    expect((await handler({ sender: {}, senderFrame: {} }, ...args)).ok).toBe(false)
    expect((await handler({ ...event, senderFrame: {} }, ...args)).ok).toBe(false)
    expect((await handler(event, ...args, 'shell')).ok).toBe(false)
    expect(getUserDataDir).not.toHaveBeenCalled()
  })

  it.each(['validate', 'preview', 'authority', 'seal', 'boundBuild', 'nativeInputs'])('fences %s callers and extra inputs before any storage or native action', async method => {
    const { handlers, event, getUserDataDir } = ipcFixture()
    const handler = handlers.get(`hd:changes:${method}`)
    expect((await handler({ sender: {}, senderFrame: {} }, 0, 'id', 'attempt')).ok).toBe(false)
    expect((await handler({ ...event, senderFrame: {} }, 0, 'id', 'attempt')).ok).toBe(false)
    expect((await handler(event, 0, 'id', 'attempt', { shell: 'anything' })).ok).toBe(false)
    expect(getUserDataDir).not.toHaveBeenCalled()
  })

  it('exposes only the exact bounded request/preparation methods through the real preload', async () => {
    let api
    const invoke = vi.fn(async () => ({ ok: true, revision: 0, changes: [] }))
    runInNewContext(fs.readFileSync(require.resolve('./preload.cjs'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
        ipcRenderer: { invoke } }),
      process: { platform: 'darwin', versions: {} }, URL, Uint8Array, ArrayBuffer,
    })
    expect(Object.keys(api.changes)).toEqual(['list', 'create', 'cancel', 'reopen', 'selectRepository', 'prepare', 'review',
      'implement', 'validate', 'preview', 'authority', 'seal', 'boundBuild', 'nativeInputs',
      'deliveryStatus', 'qualify', 'deliveryReview', 'approve', 'selectActivationTarget', 'activate'])
    for (const [method, args] of [['list', []], ['create', [0, input]], ['cancel', [1, 'id', 'attempt']],
      ['reopen', [2, 'id', 'attempt']], ['selectRepository', []],
      ['prepare', [3, 'id', 'attempt', { selectionId: 'selection', baseline: 'head' }]], ['review', ['id', 'attempt']],
      ['implement', [4, 'id', 'attempt', { port: 8080, model: 'fixture-model', files: ['note.txt'] }]],
      ['validate', [5, 'id', 'attempt']], ['preview', [6, 'id', 'attempt']], ['authority', [7, 'id', 'attempt']], ['seal', [8, 'id', 'attempt']],
      ['boundBuild', [9, 'id', 'attempt']], ['nativeInputs', [10, 'id', 'attempt']],
      ['deliveryStatus', ['id', 'attempt']], ['qualify', [11, 'id', 'attempt']], ['deliveryReview', [11, 'id', 'attempt']],
      ['approve', [11, 'id', 'attempt', 'version', 'digest']], ['selectActivationTarget', [11, 'id', 'attempt', 'version']],
      ['activate', [11, 'id', 'attempt', 'version']]]) {
      await api.changes[method](...args)
      expect(invoke).toHaveBeenLastCalledWith(`hd:changes:${method}`, ...args)
    }
    expect(invoke).toHaveBeenCalledTimes(20)
  })
})
