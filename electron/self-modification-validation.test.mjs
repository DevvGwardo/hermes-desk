import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const { createChangeController } = require('./self-modification.cjs')
const { createValidationManager } = require('./self-modification-validation.cjs')
const { decodeJournal } = require('./self-modification-schema.cjs')
const tree = require('./self-modification-artifact.cjs')
const authority = require('./self-modification-authority.cjs')
const sealInputs = require('./self-modification-seal.cjs')
const boundBuilds = require('./self-modification-bound-build.cjs')
const nativeInputs = require('./self-modification-native-inputs.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const hash = 'a'.repeat(64)
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-check-unit-')))
  roots.push(root)
  const data = path.join(root, 'data'), source = path.join(root, 'source'), deps = path.join(root, 'deps')
  for (const dir of [data, source, deps, path.join(source, 'src')]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'hermes-desk', main: 'electron/main.cjs', scripts: { build: 'not run' } }))
  fs.writeFileSync(path.join(source, 'index.html'), '<h1>fixture</h1>')
  fs.writeFileSync(path.join(source, 'src/app.ts'), 'export const value = 1\n')
  fs.writeFileSync(path.join(source, 'vite.config.mjs'), 'throw new Error("candidate config must not run")')
  const controller = createChangeController(data, options.io)
  const saved = controller.create(0, { request: 'Fixture renderer change', acceptanceCriteria: 'A separate display, not health.' })
  const id = saved.changes[0].id, attemptId = saved.changes[0].attempts[0].id
  const prep = { operationId: randomUUID(), ownerPid: process.pid, source: { root: source, dev: 0, ino: 1, gitDev: 0, gitIno: 2,
    head: 'b'.repeat(40), statusDigest: hash, dirtyEntries: 0, kind: 'head', dirtyExcluded: true },
    workspace: { id: randomUUID(), token: randomUUID(), dev: null, ino: null }, manifestDigest: null, fileCount: null, error: null }
  expect(controller.beginPreparation(1, id, attemptId, prep).ok).toBe(true)
  expect(controller.finishPreparation(id, attemptId, 0, prep.operationId, {
    workspace: { ...prep.workspace, dev: 0, ino: 3 }, manifestDigest: hash, fileCount: 4, error: null,
  }).ok).toBe(true)
  const execution = { operationId: randomUUID(), ownerPid: process.pid, stage: 'running', port: 8080,
    model: 'fake-only', files: ['src/app.ts'], inputDigest: hash, calls: 0, outputDigest: null, error: null }
  expect(controller.beginExecution(3, id, attemptId, execution).ok).toBe(true)
  expect(controller.checkpointExecution(id, attemptId, 0, execution.operationId,
    { stage: 'implemented', outputDigest: hash }).ok).toBe(true)
  const runtime = { dependencies: deps, typescript: 'trusted-typescript', vite: 'trusted-vite', digest: hash,
    react: path.join(deps, 'react.js'), tailwind: path.join(deps, 'tailwind.js') }
  const command = options.command || vi.fn(async job => {
    if (!fs.existsSync(job.output)) fs.mkdirSync(job.output)
    fs.writeFileSync(path.join(job.output, 'index.html'), '<h1>sealed</h1>')
  })
  let previewOptions
  const close = vi.fn(() => previewOptions?.onClosed())
  const openPreview = options.openPreview || vi.fn(async input => { previewOptions = input; return { close } })
  const config = { hermesHome: () => root, getTools: (_, copied) => ({ ...runtime, dependencies: copied || deps }), command,
    confirm: options.confirm || vi.fn(async () => true), openPreview, ...options.observeAuthority ? { observeAuthority: options.observeAuthority } : {},
    ...options.createSeal ? { createSeal: options.createSeal } : {},
    ...options.runBoundBuild ? { runBoundBuild: options.runBoundBuild } : {} }
  const workspace = { candidateRoot: async () => source }
  const manager = createValidationManager(data, controller, workspace, config)
  const state = () => controller.list().changes[0].attempts.at(-1)
  const start = () => manager.validate(controller.list().revision, id, attemptId)
  const preview = () => manager.preview(controller.list().revision, id, attemptId)
  const settle = async () => {
    for (let i = 0; i < 100; i++) { if (state().state !== 'checking') return state(); await delay(5) }
    throw new Error('Checks did not settle')
  }
  return { root, data, source, deps, controller, manager, config, workspace, state, start, preview, settle,
    id, attemptId, command, openPreview, close, previewOptions: () => previewOptions }
}

describe('renderer-scoped checks, sealed identity and disposable preview', () => {
  it('runs fixed commands, seals bytes/modes and records display without approval or health', async () => {
    const f = fixture()
    expect((await f.start()).ok).toBe(true)
    const state = await f.settle()
    expect(state.state).toBe('checked')
    expect(state.validation).toMatchObject({ scope: 'renderer-only', checksPassed: true,
      artifact: { activationEligible: false }, preview: null })
    const calls = f.command.mock.calls
    expect(calls.map(call => call[2][0])).toEqual(['trusted-typescript', '--check', 'trusted-vite', 'trusted-typescript'])
    expect(calls[2][2]).toContain(path.join(calls[2][0].controls, 'renderer-vite.mjs'))
    expect((await f.preview()).ok).toBe(true)
    expect(f.previewOptions().readAsset('index.html').toString()).toBe('<h1>sealed</h1>')
    expect(f.state().validation.preview).toMatchObject({ state: 'open', rendererReady: true, behaviorVerified: false })
    f.close()
    expect(f.state().validation.preview.state).toBe('closed')
    expect(f.state().state).toBe('checked')
    expect(fs.readFileSync(path.join(f.source, 'src/app.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it('native refusals do not write intent, execute checks or launch a display', async () => {
    const f = fixture({ confirm: async () => false })
    const before = f.controller.list()
    expect(await f.start()).toEqual(before)
    expect(f.controller.list()).toEqual(before)
    expect(f.command).not.toHaveBeenCalled()
  })

  it('holds its single confirmation slot against concurrent requests', async () => {
    const hold = deferred(), f = fixture({ confirm: () => hold.promise })
    const first = f.start()
    await delay(5)
    expect(await f.start()).toMatchObject({ ok: false, code: 'limit' })
    expect(await f.start()).toMatchObject({ ok: false, code: 'limit' })
    hold.resolve(false); await first
    expect(f.state().state).toBe('implemented')
  })

  it('refuses source mutation during native confirmation', async () => {
    const f = fixture({ confirm: async () => {
      fs.appendFileSync(path.join(f.source, 'src/app.ts'), '// changed')
      return true
    } })
    expect(await f.start()).toMatchObject({ ok: false, code: 'stale' })
    expect(f.command).not.toHaveBeenCalled()
    expect(f.state().state).toBe('implemented')
  })

  it('records a failed fixed check without a build or artifact', async () => {
    const command = vi.fn(async () => { throw new Error('untrusted diagnostics are not journal authority') })
    const f = fixture({ command })
    await f.start(); const state = await f.settle()
    expect(state.state).toBe('failed')
    expect(state.validation).toMatchObject({ checksPassed: false, artifact: null, stage: 'failed' })
    expect(command).toHaveBeenCalledOnce()
    expect(state.validation.error).not.toContain('untrusted diagnostics')
  })

  it.each(['candidate', 'snapshot'])('rejects %s mutation during the build', async target => {
    const f = fixture({ command: async (job, runtime, args) => {
      if (args[0] === runtime.vite) {
        fs.mkdirSync(job.output); fs.writeFileSync(path.join(job.output, 'index.html'), 'output')
        fs.appendFileSync(path.join(target === 'candidate' ? f.source : job.source, 'src/app.ts'), '// changed')
      }
    } })
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(f.state().validation.artifact).toBe(null)
  })

  it('cancelled build callbacks cannot record or preview an artifact', async () => {
    const hold = deferred(), f = fixture({ command: async () => hold.promise })
    await f.start(); await delay(5)
    expect(f.controller.cancel(f.controller.list().revision, f.id, f.attemptId).ok).toBe(true)
    f.manager.cancel(f.id, f.attemptId); hold.resolve()
    await delay(15)
    expect(f.state().state).toBe('cancelled')
    expect(f.state().validation.artifact).toBe(null)
    expect(await f.preview()).toMatchObject({ ok: false, code: 'stale' })
  })

  it.each(['bytes', 'mode', 'owner', 'root'])('refuses sealed artifact %s tampering before creating a window', async target => {
    const f = fixture()
    await f.start(); await f.settle()
    const root = path.join(f.data, 'self-modification', `check-${f.state().validation.operationId}`)
    const artifact = path.join(root, 'artifact')
    if (target === 'bytes') fs.appendFileSync(path.join(artifact, 'index.html'), 'changed')
    if (target === 'mode') fs.chmodSync(path.join(artifact, 'index.html'), 0o700)
    if (target === 'owner') fs.writeFileSync(path.join(root, 'artifact-owner.json'), '{}')
    if (target === 'root') { fs.renameSync(artifact, artifact + '-retained'); fs.mkdirSync(artifact) }
    expect((await f.preview()).ok).toBe(false)
    expect(f.openPreview).not.toHaveBeenCalled()
  })

  it('refuses changed candidate source, including mode-only changes, before a preview', async () => {
    const f = fixture()
    await f.start(); await f.settle()
    fs.chmodSync(path.join(f.source, 'src/app.ts'), 0o700)
    expect(await f.preview()).toMatchObject({ ok: false, code: 'stale' })
    expect(f.openPreview).not.toHaveBeenCalled()
  })

  it('asset requests never serve changed bytes or traversal paths', async () => {
    const f = fixture()
    await f.start(); await f.settle(); await f.preview()
    expect(() => f.previewOptions().readAsset('../owner.json')).toThrow()
    const root = path.join(f.data, 'self-modification', `check-${f.state().validation.operationId}`, 'artifact')
    fs.appendFileSync(path.join(root, 'index.html'), 'changed')
    expect(() => f.previewOptions().readAsset('index.html')).toThrow(/sealed/)
    f.previewOptions().onFailure(); f.close()
    expect(f.state().state).toBe('failed')
    expect(f.state().validation.preview.state).toBe('closed')
  })

  it('cancellation closes only the owned preview and does not resurrect the attempt', async () => {
    const f = fixture()
    await f.start(); await f.settle(); await f.preview()
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    f.manager.cancel(f.id, f.attemptId)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.state().state).toBe('cancelled')
    expect(f.state().validation.preview.state).toBe('closed')
  })

  it('late old-window callbacks cannot close a newer preview', async () => {
    const f = fixture()
    await f.start(); await f.settle(); await f.preview()
    const old = f.previewOptions()
    f.close()
    await f.preview()
    const before = f.controller.list()
    old.onClosed(); old.onFailure()
    expect(f.controller.list()).toEqual(before)
    f.close()
  })

  it('lost preview-start acknowledgment forbids creating a window', async () => {
    const f = fixture()
    await f.start(); await f.settle()
    vi.spyOn(f.controller, 'checkpointPreview').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    expect(await f.preview()).toMatchObject({ ok: false, code: 'uncertain' })
    expect(f.openPreview).not.toHaveBeenCalled()
  })

  it('lost ready acknowledgment closes the disposable window', async () => {
    const f = fixture()
    await f.start(); await f.settle()
    const original = f.controller.checkpointPreview
    vi.spyOn(f.controller, 'checkpointPreview').mockImplementation((...args) =>
      args.at(-1).state === 'open' ? { ok: false, code: 'uncertain', error: 'lost' } : original(...args))
    expect(await f.preview()).toMatchObject({ ok: false, code: 'uncertain' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.state().validation.preview.rendererReady).toBe(false)
  })

  it('lost check acknowledgment stops subsequent effects and is retained for recovery', async () => {
    const f = fixture()
    vi.spyOn(f.controller, 'checkpointValidation').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    await f.start(); await delay(20)
    expect(f.command.mock.calls.some(call => call[2][0] === 'trusted-vite')).toBe(false)
    expect(f.state().state).toBe('checking')
    expect(f.state().validation.artifact).toBe(null)
  })

  it('restart marks interrupted checking and never reruns a command', async () => {
    const hold = deferred(), f = fixture({ command: vi.fn(async () => hold.promise) })
    await f.start(); await delay(5)
    const recovery = createValidationManager(f.data, f.controller, f.workspace, f.config)
    recovery.recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().validation.error).toMatch(/interrupted/)
    expect(f.command).toHaveBeenCalledOnce()
    hold.resolve(); await delay(15)
    expect(f.state().state).toBe('failed')
  })

  it('restart preserves a checked artifact but marks the old preview interrupted, never reopened', async () => {
    const f = fixture()
    await f.start(); await f.settle(); await f.preview()
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().state).toBe('checked')
    expect(f.state().validation.preview.state).toBe('interrupted')
    expect(f.state().validation.preview.behaviorVerified).toBe(false)
    expect(f.openPreview).toHaveBeenCalledOnce()
    f.close()
  })

  it('does not claim another live owner preview ended or launch a duplicate', async () => {
    const f = fixture()
    await f.start(); await f.settle(); await f.preview()
    const current = f.state().validation
    f.controller.checkpointPreview(f.controller.list().revision, f.id, f.attemptId, current.operationId,
      current.preview.id, { ...current.preview, ownerPid: process.ppid })
    const recovery = createValidationManager(f.data, f.controller, f.workspace, f.config)
    recovery.recover()
    expect(f.state().validation.preview.state).toBe('open')
    expect(await recovery.preview(f.controller.list().revision, f.id, f.attemptId)).toMatchObject({ ok: false, code: 'limit' })
    f.close()
  })

  it('a cancelled pending preview cannot record readiness even if its late factory ignores abort', async () => {
    const hold = deferred(), close = vi.fn(), f = fixture({ openPreview: async () => hold.promise })
    await f.start(); await f.settle()
    const opening = f.preview()
    for (let i = 0; i < 50 && !f.state().validation.preview; i++) await delay(5)
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    f.manager.cancel(f.id, f.attemptId)
    hold.resolve({ close })
    expect((await opening).ok).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(f.state().state).toBe('cancelled')
    expect(f.state().validation.preview.rendererReady).toBe(false)
  })

  it('refuses a replaced storage parent before reading source or starting checks', async () => {
    const f = fixture()
    fs.renameSync(path.join(f.data, 'self-modification'), path.join(f.data, 'retained'))
    fs.mkdirSync(path.join(f.data, 'self-modification'))
    expect((await f.start()).ok).toBe(false)
    expect(f.command).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(f.data, 'retained/changes.json'))).toBe(true)
  })

  it.each(['@plugin "./code.js";', '@config "./code.js";', '@con\\66ig "./code.js";',
    '@plugin/**/"./code.js";', Buffer.from([0xff, ...Buffer.from('@plugin "./code.js";')])])('refuses CSS JavaScript loaders %s', async text => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'src/style.css'), text)
    expect(await f.start()).toMatchObject({ ok: false, code: 'invalid' })
    expect(f.command).not.toHaveBeenCalled()
  })

  it.each(['@import "./code.txt";', '@import/**/"./code.css";', '@import url("./code.css");',
    '@import "#candidate";'])('rejects CSS import inspection bypass %s', async text => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'src/style.css'), text)
    fs.writeFileSync(path.join(f.source, 'src/code.txt'), '@plugin "./code.js";')
    expect(await f.start()).toMatchObject({ ok: false, code: 'invalid' })
    expect(f.command).not.toHaveBeenCalled()
  })

  it('allows prose/tests mentioning CSS directives without making them stylesheet inputs', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'README.md'), 'Document why @plugin is not supported in scoped CSS.')
    fs.writeFileSync(path.join(f.source, 'src/style.css'), '@import "tailwindcss";')
    expect((await f.start()).ok).toBe(true)
    expect((await f.settle()).state).toBe('checked')
  })

  it('rejects local shadowing of the provisioned Tailwind stylesheet', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.source, 'src/style.css'), '@import "tailwindcss";')
    fs.writeFileSync(path.join(f.source, 'src/tailwindcss'), '@plugin "./code.js";')
    expect(await f.start()).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('migrates v3 read-only and rejects invented activation or health authority in v4', async () => {
    const f = fixture()
    const file = path.join(f.data, 'self-modification/changes.json')
    const old = JSON.parse(fs.readFileSync(file, 'utf8'))
    old.version = old.lifecycleVersion = 3
    delete old.changes[0].attempts[0].validation
    fs.writeFileSync(file, JSON.stringify(old))
    expect(f.controller.list().ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(old))
    await f.start(); await f.settle()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(raw.version).toBe(7)
    raw.changes[0].attempts[0].validation.artifact.activationEligible = true
    expect(() => decodeJournal(JSON.stringify(raw))).toThrow()
    expect(fs.readFileSync(path.join(f.source, 'src/app.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it.each(['symlink', 'hardlink'])('fails closed on %s input without touching the target', async kind => {
    const f = fixture(), target = path.join(f.root, 'outside.txt')
    fs.writeFileSync(target, 'retained')
    if (kind === 'symlink') fs.symlinkSync(target, path.join(f.source, 'src/outside.ts'))
    else fs.linkSync(target, path.join(f.source, 'src/outside.ts'))
    expect((await f.start()).ok).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('retained')
    expect(f.command).not.toHaveBeenCalled()
  })

  it('tree identities include modes and never silently omit hidden files', async () => {
    const f = fixture(), before = await tree.capture(f.source)
    fs.writeFileSync(path.join(f.source, '.hidden'), 'tracked-or-proposed')
    expect((await tree.capture(f.source)).digest).not.toBe(before.digest)
  })
})

async function sealFixture(options = {}) {
  const f = await authorityFixture(options)
  await f.startAuthority(); await f.settleAuthority()
  fs.writeFileSync(path.join(f.deps, 'provisioned.cjs'), 'throw Error("do not execute dependency")')
  const startSeal = () => f.manager.seal(f.controller.list().revision, f.id, f.attemptId)
  const settleSeal = async () => {
    for (let i = 0; i < 100; i++) { if (f.state().validation.seal?.stage !== 'sealing') return f.state(); await delay(5) }
    throw new Error('Seal did not settle')
  }
  const folder = () => path.join(f.data, 'self-modification', `seal-${f.state().validation.seal.operationId}`, 'artifact')
  return { ...f, startSeal, settleSeal, folder }
}
describe('durable full app-input seal, not qualification or activation', () => {
  it('acknowledges one exact full identity and reuses it after restart without rebuilding or original dependencies', async () => {
    const createSeal = vi.fn(sealInputs.create), f = await sealFixture({ createSeal })
    expect((await f.startSeal()).ok).toBe(true)
    const state = await f.settleSeal()
    expect(state.validation.seal).toMatchObject({ stage: 'sealed', fullAppQualified: false,
      artifact: { activationEligible: false } })
    expect(fs.readFileSync(path.join(f.folder(), 'app/electron/main.cjs'), 'utf8')).toBe('module.exports = {}')
    const before = f.controller.list()
    fs.appendFileSync(path.join(f.deps, 'provisioned.cjs'), '// mutable original must not affect copied graph')
    const controller = createChangeController(f.data)
    const restarted = createValidationManager(f.data, controller, f.workspace, f.config)
    restarted.recover()
    expect(await restarted.seal(before.revision, f.id, f.attemptId)).toEqual(before)
    expect(createSeal).toHaveBeenCalledOnce()
    expect(f.command).toHaveBeenCalledTimes(6) // Types + three JS syntax + build + repeated types.
    expect(f.observeAuthority).toHaveBeenCalledOnce()
    expect((await f.preview()).ok).toBe(true)
    expect(f.state().validation.preview.rendererReady).toBe(true)
    f.close()
  })
  it('refused consent, stale revision and failed intent never start copying', async () => {
    const createSeal = vi.fn(sealInputs.create), f = await sealFixture({ createSeal })
    f.config.confirm.mockResolvedValue(false)
    const before = f.controller.list()
    expect(await f.startSeal()).toEqual(before)
    expect(await f.manager.seal(before.revision - 1, f.id, f.attemptId)).toMatchObject({ ok: false, code: 'stale' })
    f.config.confirm.mockResolvedValue(true)
    vi.spyOn(f.controller, 'beginSeal').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    expect(await f.startSeal()).toMatchObject({ ok: false, code: 'uncertain' })
    expect(createSeal).not.toHaveBeenCalled()
    expect(f.state().validation.seal).toBe(null)
  })
  it('requires passed independent contracts, not renderer-only evidence', async () => {
    const f = fixture(); await f.start(); await f.settle()
    expect(await f.manager.seal(f.controller.list().revision, f.id, f.attemptId)).toMatchObject({ ok: false, code: 'invalid' })
  })
  it('actual ENOSPC during the atomic seal intent blocks all copying and preserves journal bytes', async () => {
    let armed = false
    const io = { ...fs, writeFileSync(name, ...args) {
      if (armed && typeof name === 'number') {
        // Journal descriptors, never candidate data.
        throw Object.assign(Error('owned disk-full fixture'), { code: 'ENOSPC' })
      }
      return fs.writeFileSync(name, ...args)
    } }
    const createSeal = vi.fn(sealInputs.create), f = await sealFixture({ io, createSeal })
    const file = path.join(f.data, 'self-modification/changes.json'), before = fs.readFileSync(file, 'utf8')
    armed = true
    expect((await f.startSeal()).ok).toBe(false)
    expect(createSeal).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(f.state().validation.seal).toBe(null)
  })
  it('an owned copy failure retains work, records failure and never permits automatic retry', async () => {
    const createSeal = vi.fn(async folder => {
      fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'partial'), 'recoverable')
      throw Object.assign(Error('owned ENOSPC fixture'), { code: 'ENOSPC' })
    })
    const f = await sealFixture({ createSeal })
    await f.startSeal()
    expect((await f.settleSeal()).state).toBe('failed')
    expect(f.state().validation.seal.artifact).toBe(null)
    expect(fs.readFileSync(path.join(f.folder(), 'partial'), 'utf8')).toBe('recoverable')
    expect((await f.startSeal()).ok).toBe(false)
    expect(createSeal).toHaveBeenCalledOnce()
  })
  it('records an owned sealing deadline as terminal failure instead of leaving an immortal running intent', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const createSeal = vi.fn(async (folder, _initial, _renderer, _runtime, _input, check) => {
      fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'partial'), 'recoverable deadline work')
      now += 180001
      check()
      throw Error('Expired sealing must not continue')
    })
    try {
      const f = await sealFixture({ createSeal })
      expect((await f.startSeal()).ok).toBe(true)
      const state = await f.settleSeal()
      expect(state.state).toBe('failed')
      expect(state.validation.seal).toMatchObject({ stage: 'failed', artifact: null, fullAppQualified: false })
      expect(fs.readFileSync(path.join(f.folder(), 'partial'), 'utf8')).toBe('recoverable deadline work')
      expect((await f.startSeal()).ok).toBe(false)
      expect(createSeal).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })
  it.each(['candidate', 'dependencies', 'toolchain'])('refuses %s mutation during seal confirmation', async target => {
    const createSeal = vi.fn(sealInputs.create), f = await sealFixture({ createSeal })
    f.config.confirm.mockImplementation(async () => {
      if (target === 'toolchain') f.config.getTools = () => ({ dependencies: f.deps, digest: 'b'.repeat(64) })
      else fs.appendFileSync(path.join(target === 'candidate' ? f.source : f.deps,
        target === 'candidate' ? 'electron/main.cjs' : 'provisioned.cjs'), '// changed')
      // getTools was closed over by manager; mutate the same returned runtime.
      if (target === 'toolchain') f.manager = createValidationManager(f.data, f.controller, f.workspace, f.config)
      return true
    })
    if (target === 'toolchain') {
      const getTools = f.config.getTools
      let calls = 0
      f.config.getTools = () => ({ ...getTools(), digest: ++calls > 1 ? 'b'.repeat(64) : hash })
      f.manager = createValidationManager(f.data, f.controller, f.workspace, f.config)
    }
    expect((await f.manager.seal(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
    expect(createSeal).not.toHaveBeenCalled()
  })
  it.each(['candidate', 'dependencies'])('rejects %s mutation while copying', async target => {
    const f = await sealFixture({ createSeal: async (...args) => {
      const output = await sealInputs.create(...args)
      fs.appendFileSync(path.join(target === 'candidate' ? f.source : f.deps,
        target === 'candidate' ? 'electron/main.cjs' : 'provisioned.cjs'), '// changed')
      return output
    } })
    await f.startSeal()
    expect((await f.settleSeal()).state).toBe('failed')
    expect(f.state().validation.seal.artifact).toBe(null)
  })
  it('cancellation fences a deliberately late completed seal and does not overwrite a new attempt', async () => {
    const hold = deferred(), f = await sealFixture({ createSeal: async (...args) => {
      const output = await sealInputs.create(...args)
      await hold.promise; return output
    } })
    await f.startSeal(); await delay(20)
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    f.manager.cancel(f.id, f.attemptId)
    const reopened = f.controller.reopen(f.controller.list().revision, f.id, f.attemptId)
    expect(reopened.ok).toBe(true)
    hold.resolve(); await delay(20)
    expect(f.state().state).toBe('requested')
    expect(f.state().validation).toBe(null)
    expect(f.controller.list().changes[0].attempts[0].validation.seal.stage).toBe('sealing')
    expect(fs.existsSync(path.join(f.data, 'self-modification'))).toBe(true)
  })
  it('lost final acknowledgment stays unknown and restart records interruption without copying again', async () => {
    const createSeal = vi.fn(sealInputs.create), f = await sealFixture({ createSeal })
    const original = f.controller.checkpointSeal
    vi.spyOn(f.controller, 'checkpointSeal').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    await f.startSeal(); await delay(40)
    expect(f.state().validation.seal.stage).toBe('sealing')
    f.controller.checkpointSeal = original
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().validation.seal.error).toMatch(/interrupted/)
    expect(createSeal).toHaveBeenCalledOnce()
    expect((await f.startSeal()).ok).toBe(false)
  })
  it.each(['source', 'renderer', 'dependency', 'mode', 'owner', 'root', 'symlink', 'parent-symlink', 'directory-mode'])('refuses sealed %s mutation before reuse or preview', async target => {
    const f = await sealFixture()
    await f.startSeal(); await f.settleSeal()
    const folder = f.folder()
    if (target === 'source') fs.appendFileSync(path.join(folder, 'app/electron/main.cjs'), '// changed')
    if (target === 'renderer') fs.appendFileSync(path.join(folder, 'app/dist/index.html'), 'changed')
    if (target === 'dependency') fs.appendFileSync(path.join(folder, 'app/node_modules/provisioned.cjs'), '// changed')
    if (target === 'mode') fs.chmodSync(path.join(folder, 'app/electron/main.cjs'), 0o755)
    if (target === 'directory-mode') fs.chmodSync(path.join(folder, 'app/electron'), 0o711)
    if (target === 'owner') fs.writeFileSync(path.join(path.dirname(folder), 'owner.json'), '{}')
    if (target === 'root') { fs.renameSync(folder, folder + '-retained'); fs.mkdirSync(folder) }
    if (target === 'symlink') { fs.renameSync(folder, folder + '-retained'); fs.symlinkSync(folder + '-retained', folder) }
    if (target === 'parent-symlink') {
      const parent = path.dirname(folder)
      fs.renameSync(parent, parent + '-retained'); fs.symlinkSync(parent + '-retained', parent)
    }
    expect((await f.startSeal()).ok).toBe(false)
    expect((await f.preview()).ok).toBe(false)
    expect(f.openPreview).not.toHaveBeenCalled()
  })
  it('a live other seal owner is not marked dead or duplicated after manager restart', async () => {
    const f = await sealFixture()
    const value = { operationId: randomUUID(), ownerPid: process.ppid, scope: 'full-app-inputs', stage: 'sealing',
      sourceDigest: f.state().validation.sourceDigest, rendererDigest: f.state().validation.artifact.digest,
      toolchainDigest: hash, dependencyDigest: hash, artifact: null, fullAppQualified: false, error: null }
    expect(f.controller.beginSeal(f.controller.list().revision, f.id, f.attemptId, value).ok).toBe(true)
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().validation.seal.stage).toBe('sealing')
    expect(await f.startSeal()).toMatchObject({ ok: false, code: 'limit' })
  })
  it('v5 migration is read-only; any claimed activation eligibility or native qualification is rejected', async () => {
    const f = await sealFixture(), file = path.join(f.data, 'self-modification/changes.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.version = raw.lifecycleVersion = 5
    delete raw.changes[0].attempts[0].validation.seal
    delete raw.changes[0].attempts[0].validation.boundBuild
    fs.writeFileSync(file, JSON.stringify(raw))
    expect(f.controller.list().ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(raw))
    await f.startSeal(); await f.settleSeal()
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(latest.version).toBe(7)
    latest.changes[0].attempts[0].validation.seal.artifact.activationEligible = true
    expect(() => decodeJournal(JSON.stringify(latest))).toThrow()
    latest.changes[0].attempts[0].validation.seal.artifact.activationEligible = false
    latest.changes[0].attempts[0].validation.seal.fullAppQualified = true
    expect(() => decodeJournal(JSON.stringify(latest))).toThrow()
  })
})

async function boundFixture(options = {}) {
  const f = await sealFixture(options)
  await f.startSeal(); await f.settleSeal()
  const startBound = () => f.manager.boundBuild(f.controller.list().revision, f.id, f.attemptId)
  const settleBound = async () => {
    for (let i = 0; i < 150; i++) {
      if (f.state().validation.boundBuild?.stage !== 'checking') return f.state()
      await delay(5)
    }
    throw new Error('Bound checks did not settle')
  }
  const boundFolder = () => path.join(f.data, 'self-modification', `bound-${f.state().validation.boundBuild.operationId}`, 'artifact')
  return { ...f, startBound, settleBound, boundFolder }
}

describe('sealed dependency graph renderer build and bound display', () => {
  it('inspects only verified bound source without journal writes, compilers, native launch or qualification', async () => {
    const f = await boundFixture()
    await f.startBound(); await f.settleBound()
    const before = f.controller.list(), commands = f.command.mock.calls.length
    const response = await f.manager.nativeInputs(before.revision, f.id, f.attemptId)
    expect(response).toMatchObject({ ok: true, nativeInputs: { scope: 'lexical-native-inputs',
      boundDigest: f.state().validation.boundBuild.artifact.boundDigest, inspectionComplete: false,
      nativeExecuted: false, fullAppQualified: false, activationEligible: false } })
    expect(f.controller.list()).toEqual(before)
    expect(f.command.mock.calls.length).toBe(commands)
    expect(f.openPreview).not.toHaveBeenCalled()
    const restarted = createValidationManager(f.data, createChangeController(f.data), f.workspace, f.config)
    expect(await restarted.nativeInputs(before.revision, f.id, f.attemptId)).toEqual(response)
    expect(f.controller.list()).toEqual(before)
    expect((await f.manager.nativeInputs(before.revision - 1, f.id, f.attemptId)).ok).toBe(false)
    fs.appendFileSync(path.join(f.source, 'electron/main.cjs'), '// changed')
    expect((await f.manager.nativeInputs(before.revision, f.id, f.attemptId)).ok).toBe(false)
  })
  it('input inspection rejects cancelled, unbound and mutated graph states', async () => {
    const f = await boundFixture()
    expect((await f.manager.nativeInputs(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
    await f.startBound(); await f.settleBound()
    fs.appendFileSync(path.join(f.folder(), 'app/node_modules/provisioned.cjs'), '// changed')
    expect((await f.manager.nativeInputs(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    expect((await f.manager.nativeInputs(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
  })
  it('cancellation during diagnostics and caller navigation fence the returned report without journal effects', async () => {
    const f = await boundFixture()
    await f.startBound(); await f.settleBound()
    const before = f.controller.list()
    expect((await f.manager.nativeInputs(before.revision, f.id, f.attemptId, () => { throw Error('caller navigated') })).ok).toBe(false)
    expect(f.controller.list()).toEqual(before)
    const original = nativeInputs.inspect
    const spy = vi.spyOn(nativeInputs, 'inspect').mockImplementation(files => {
      f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
      return original(files)
    })
    try {
      expect((await f.manager.nativeInputs(before.revision, f.id, f.attemptId)).ok).toBe(false)
      expect(f.state().state).toBe('cancelled')
    } finally { spy.mockRestore() }
  })
  it('uses only copied dependencies, binds policy/source/graph/output, displays the new output and reuses after restart', async () => {
    const f = await boundFixture()
    const beforeCalls = f.command.mock.calls.length
    fs.appendFileSync(path.join(f.deps, 'provisioned.cjs'), '// original changed before the real bound operation')
    f.command.mockImplementation(async job => {
      expect(job.runtime.dependencies).toBe(path.join(f.folder(), 'app/node_modules'))
      expect(fs.readFileSync(path.join(job.runtime.dependencies, 'provisioned.cjs'), 'utf8')).not.toContain('original changed')
      if (!fs.existsSync(job.output)) fs.mkdirSync(job.output)
      fs.writeFileSync(path.join(job.output, 'index.html'), '<h1>bound graph</h1>')
    })
    expect((await f.startBound()).ok).toBe(true)
    const state = await f.settleBound(), record = state.validation.boundBuild
    expect(state.state).toBe('checked')
    expect(record).toMatchObject({ stage: 'passed', scope: 'sealed-graph-renderer', fullAppQualified: false,
      inputDigest: state.validation.seal.artifact.digest, dependencyDigest: state.validation.seal.dependencyDigest,
      artifact: { activationEligible: false } })
    expect(record.artifact.boundDigest).toBe(boundBuilds.binding(record.inputDigest, record.sourceDigest,
      record.dependencyDigest, record.artifact.rendererDigest, record.toolchainDigest))
    expect(f.command.mock.calls.length).toBe(beforeCalls + 6)
    expect(record.artifact.rendererDigest).not.toBe(state.validation.artifact.digest)
    const restarted = createValidationManager(f.data, createChangeController(f.data), f.workspace, f.config)
    const saved = f.controller.list()
    expect(await restarted.boundBuild(saved.revision, f.id, f.attemptId)).toEqual(saved)
    expect(f.command.mock.calls.length).toBe(beforeCalls + 6)
    expect((await f.preview()).ok).toBe(true)
    expect(f.previewOptions().readAsset('index.html').toString()).toBe('<h1>bound graph</h1>')
    expect(f.state().validation.preview.artifactDigest).toBe(record.artifact.rendererDigest)
    f.close()
  })
  it('refused consent, stale revision and unacknowledged intent do not run copied code', async () => {
    const runBoundBuild = vi.fn(boundBuilds.run), f = await boundFixture({ runBoundBuild })
    const saved = f.controller.list()
    f.config.confirm.mockResolvedValue(false)
    expect(await f.startBound()).toEqual(saved)
    expect(await f.manager.boundBuild(saved.revision - 1, f.id, f.attemptId)).toMatchObject({ ok: false, code: 'stale' })
    f.config.confirm.mockResolvedValue(true)
    vi.spyOn(f.controller, 'beginBoundBuild').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    expect(await f.startBound()).toMatchObject({ ok: false, code: 'uncertain' })
    expect(runBoundBuild).not.toHaveBeenCalled()
  })
  it('requires an acknowledged complete input seal', async () => {
    const f = await sealFixture()
    expect((await f.manager.boundBuild(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
    expect(f.state().validation.boundBuild).toBe(null)
  })
  it('an actual disk-full intent preserves bytes and cannot start the copied compiler', async () => {
    let armed = false
    const io = { ...fs, writeFileSync(name, ...args) {
      if (armed && typeof name === 'number') throw Object.assign(Error('owned ENOSPC fixture'), { code: 'ENOSPC' })
      return fs.writeFileSync(name, ...args)
    } }
    const runBoundBuild = vi.fn(boundBuilds.run), f = await boundFixture({ io, runBoundBuild })
    const file = path.join(f.data, 'self-modification/changes.json'), before = fs.readFileSync(file, 'utf8')
    armed = true
    expect((await f.startBound()).ok).toBe(false)
    expect(runBoundBuild).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(f.state().validation.boundBuild).toBe(null)
  })
  it.each(['source', 'graph'])('refuses %s mutation during native consent before dispatch', async target => {
    const runBoundBuild = vi.fn(boundBuilds.run), f = await boundFixture({ runBoundBuild })
    f.config.confirm.mockImplementation(async () => {
      fs.appendFileSync(target === 'source' ? path.join(f.source, 'src/app.ts') :
        path.join(f.folder(), 'app/node_modules/provisioned.cjs'), '// changed')
      return true
    })
    expect((await f.startBound()).ok).toBe(false)
    expect(runBoundBuild).not.toHaveBeenCalled()
  })
  it.each(['candidate', 'scratch', 'graph'])('rejects %s mutation during actual fixed command flow', async target => {
    const f = await boundFixture()
    f.command.mockImplementation(async (job, runtime, args) => {
      if (args[0] === runtime.vite) {
        fs.mkdirSync(job.output); fs.writeFileSync(path.join(job.output, 'index.html'), '<h1>late</h1>')
        fs.appendFileSync(target === 'graph' ? path.join(runtime.dependencies, 'provisioned.cjs') :
          path.join(target === 'candidate' ? f.source : job.source, 'src/app.ts'), '// changed')
      }
    })
    await f.startBound()
    expect((await f.settleBound()).state).toBe('failed')
    expect(f.state().validation.boundBuild.artifact).toBe(null)
    expect((await f.preview()).ok).toBe(false)
  })
  it('kernel worker errors retain failed evidence without a fallback or automatic rerun', async () => {
    const f = await boundFixture()
    f.command.mockRejectedValue(Error('untrusted output is not authority'))
    await f.startBound(); await f.settleBound()
    expect(f.state().validation.boundBuild).toMatchObject({ stage: 'failed', artifact: null })
    expect(f.state().validation.boundBuild.error).not.toContain('untrusted output')
    expect((await f.startBound()).ok).toBe(false)
  })
  it('cancellation fences a deliberately late completion and a newly reopened attempt', async () => {
    const hold = deferred(), f = await boundFixture({ runBoundBuild: async (...args) => {
      const output = await boundBuilds.run(...args); await hold.promise; return output
    } })
    await f.startBound(); await delay(30)
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId); f.manager.cancel(f.id, f.attemptId)
    expect(f.controller.reopen(f.controller.list().revision, f.id, f.attemptId).ok).toBe(true)
    hold.resolve(); await delay(30)
    expect(f.state()).toMatchObject({ state: 'requested', validation: null })
    expect(f.controller.list().changes[0].attempts[0].validation.boundBuild).toMatchObject({ stage: 'checking', artifact: null })
  })
  it('single pending confirmation and worker slots block concurrent build/display requests', async () => {
    const hold = deferred(), f = await boundFixture()
    f.config.confirm.mockImplementation(() => hold.promise)
    const started = f.startBound(); await delay(15)
    expect(await f.startBound()).toMatchObject({ ok: false, code: 'limit' })
    expect(await f.preview()).toMatchObject({ ok: false, code: 'limit' })
    hold.resolve(false); await started
  })
  it('unknown final acknowledgment recovers as interrupted after restart without running copied code again', async () => {
    const runBoundBuild = vi.fn(boundBuilds.run), f = await boundFixture({ runBoundBuild })
    const original = f.controller.checkpointBoundBuild
    vi.spyOn(f.controller, 'checkpointBoundBuild').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    await f.startBound(); await delay(60)
    expect(f.state().validation.boundBuild.stage).toBe('checking')
    f.controller.checkpointBoundBuild = original
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().validation.boundBuild).toMatchObject({ stage: 'failed', artifact: null })
    expect(runBoundBuild).toHaveBeenCalledOnce()
    expect((await f.startBound()).ok).toBe(false)
  })
  it('a live external operation owner is not guessed dead, replayed or displayed after restart', async () => {
    const f = await boundFixture(), validation = f.state().validation
    const record = { operationId: randomUUID(), ownerPid: process.ppid, scope: 'sealed-graph-renderer', stage: 'checking',
      inputDigest: validation.seal.artifact.digest, sourceDigest: validation.sourceDigest,
      dependencyDigest: validation.seal.dependencyDigest, toolchainDigest: hash,
      artifact: null, fullAppQualified: false, error: null }
    expect(f.controller.beginBoundBuild(f.controller.list().revision, f.id, f.attemptId, record).ok).toBe(true)
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().validation.boundBuild.stage).toBe('checking')
    expect((await f.startBound()).ok).toBe(false)
    expect((await f.preview()).ok).toBe(false)
  })
  it.each(['output', 'mode', 'owner', 'parent-symlink', 'graph'])('refuses %s mutation before restart reuse or bound display', async target => {
    const f = await boundFixture()
    await f.startBound(); await f.settleBound()
    const folder = f.boundFolder()
    if (target === 'output') fs.appendFileSync(path.join(folder, 'index.html'), 'changed')
    if (target === 'mode') fs.chmodSync(path.join(folder, 'index.html'), 0o755)
    if (target === 'owner') fs.writeFileSync(path.join(path.dirname(folder), 'owner.json'), '{}')
    if (target === 'graph') fs.appendFileSync(path.join(f.folder(), 'app/node_modules/provisioned.cjs'), '// changed')
    if (target === 'parent-symlink') {
      fs.renameSync(path.dirname(folder), path.dirname(folder) + '-retained')
      fs.symlinkSync(path.dirname(folder) + '-retained', path.dirname(folder))
    }
    expect((await f.startBound()).ok).toBe(false)
    expect((await f.preview()).ok).toBe(false)
    expect((await f.manager.nativeInputs(f.controller.list().revision, f.id, f.attemptId)).ok).toBe(false)
    expect(f.openPreview).not.toHaveBeenCalled()
  })
  it('v6 migration is read-only and rejects invented health/activation and inconsistent input bindings', async () => {
    const f = await boundFixture(), file = path.join(f.data, 'self-modification/changes.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.version = raw.lifecycleVersion = 6; delete raw.changes[0].attempts[0].validation.boundBuild
    fs.writeFileSync(file, JSON.stringify(raw))
    expect(f.controller.list().changes[0].attempts[0].validation.boundBuild).toBe(null)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(raw))
    await f.startBound(); await f.settleBound()
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(latest.version).toBe(7)
    for (const [field, value] of [['inputDigest', 'b'.repeat(64)], ['dependencyDigest', 'b'.repeat(64)], ['fullAppQualified', true]]) {
      const changed = structuredClone(latest)
      changed.changes[0].attempts[0].validation.boundBuild[field] = value
      expect(() => decodeJournal(JSON.stringify(changed))).toThrow()
    }
    latest.changes[0].attempts[0].validation.boundBuild.artifact.activationEligible = true
    expect(() => decodeJournal(JSON.stringify(latest))).toThrow()
  })
})

function passingTrace() {
  return { preferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: 'preload.cjs' },
    host: { main: true, foreign: false }, changes: { main: true, foreign: false, subframe: false },
    navigation: { navigate: true, redirect: true, popup: true }, permissions: { request: false, check: false },
    preload: Object.fromEntries(Object.entries(authority.METHODS).map(([name, args]) => [name, { channel: `hd:changes:${name}`,
      args: JSON.parse(JSON.stringify(args)) }])) }
}
async function authorityFixture(options = {}) {
  const observeAuthority = options.observeAuthority || vi.fn(async () => passingTrace())
  const f = fixture({ ...options, observeAuthority })
  fs.mkdirSync(path.join(f.source, 'electron'))
  for (const file of ['main.cjs', 'preload.cjs']) fs.writeFileSync(path.join(f.source, 'electron', file), 'module.exports = {}')
  await f.start(); await f.settle()
  const start = () => f.manager.authority(f.controller.list().revision, f.id, f.attemptId)
  const settle = async () => {
    for (let i = 0; i < 100; i++) { if (f.state().validation.authority?.stage !== 'running') return f.state(); await delay(5) }
    throw new Error('Authority checks did not settle')
  }
  return { ...f, observeAuthority, startAuthority: start, settleAuthority: settle }
}

describe('independent main/preload fixture contracts', () => {
  it('records independently evaluated observations bound to exact source/renderer/definitions, never app health', async () => {
    const f = await authorityFixture()
    expect((await f.startAuthority()).ok).toBe(true)
    const state = await f.settleAuthority()
    expect(state.validation.authority).toMatchObject({ stage: 'passed', checks: 6, scope: 'main-preload-test-doubles',
      sourceDigest: state.validation.sourceDigest, rendererDigest: state.validation.artifact.digest,
      definitionDigest: authority.definitionDigest(), nativeBehaviorVerified: false, fullAppQualified: false })
    expect(state.validation.artifact.activationEligible).toBe(false)
    expect(state.validation.authority.observationDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(createChangeController(f.data).list()).toEqual(f.controller.list())
    expect(await f.startAuthority()).toMatchObject({ ok: false, code: 'limit' })
  })

  it.each(['preferences', 'host', 'changes', 'navigation', 'permissions', 'preload'])('fails actual parent evaluation of broken %s observations', async field => {
    const trace = passingTrace()
    trace[field] = {}
    const f = await authorityFixture({ observeAuthority: async () => trace })
    await f.startAuthority()
    expect((await f.settleAuthority()).state).toBe('failed')
    expect(f.state().validation.authority.stage).toBe('failed')
    expect(f.state().validation.artifact.activationEligible).toBe(false)
  })

  it('candidate-returned passed/qualification flags are not authoritative trace fields', async () => {
    const f = await authorityFixture({ observeAuthority: async () => ({ ...passingTrace(), passed: true, fullAppQualified: true }) })
    await f.startAuthority()
    expect((await f.settleAuthority()).state).toBe('failed')
  })

  it('rejects extra preload commands and wrong payloads even alongside valid observations', () => {
    const trace = passingTrace()
    trace.preload.executeShell = { channel: 'shell', args: [] }
    expect(authority.evaluate(trace).at(-1).passed).toBe(false)
    delete trace.preload.executeShell
    trace.preload.authority.args.push({ command: 'anything' })
    expect(authority.evaluate(trace).at(-1).passed).toBe(false)
  })

  it('native refusal leaves the check journal and source untouched', async () => {
    const f = await authorityFixture()
    f.config.confirm.mockResolvedValue(false)
    const before = f.controller.list()
    expect(await f.startAuthority()).toEqual(before)
    expect(f.observeAuthority).not.toHaveBeenCalled()
    expect(f.controller.list()).toEqual(before)
  })

  it('requires actual candidate main/preload files rather than accepting renderer-only evidence', async () => {
    const f = fixture()
    await f.start(); await f.settle()
    expect(await f.manager.authority(f.controller.list().revision, f.id, f.attemptId)).toMatchObject({ ok: false, code: 'invalid' })
    expect(f.state().validation.authority).toBe(null)
  })

  it('failed start acknowledgment blocks candidate code execution', async () => {
    const f = await authorityFixture()
    vi.spyOn(f.controller, 'beginAuthority').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    expect(await f.startAuthority()).toMatchObject({ ok: false, code: 'uncertain' })
    expect(f.observeAuthority).not.toHaveBeenCalled()
  })

  it('cancellation fences a late observation and preserves the cancelled attempt', async () => {
    const hold = deferred(), f = await authorityFixture({ observeAuthority: async () => hold.promise })
    await f.startAuthority(); await delay(5)
    f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    f.manager.cancel(f.id, f.attemptId)
    hold.resolve(passingTrace()); await delay(15)
    expect(f.state().state).toBe('cancelled')
    expect(f.state().validation.authority.stage).toBe('running') // Unknown, not fabricated completion.
    expect(f.state().validation.authority.observationDigest).toBe(null)
  })

  it('blocks overlapping checks/displays while observations are running', async () => {
    const hold = deferred(), f = await authorityFixture({ observeAuthority: async () => hold.promise })
    await f.startAuthority(); await delay(5)
    expect(await f.startAuthority()).toMatchObject({ ok: false, code: 'limit' })
    expect(await f.preview()).toMatchObject({ ok: false, code: 'limit' })
    hold.resolve(passingTrace()); await f.settleAuthority()
  })

  it('source mutation during observations invalidates their completion', async () => {
    const f = await authorityFixture({ observeAuthority: async () => {
      fs.appendFileSync(path.join(f.source, 'electron/main.cjs'), '// changed')
      return passingTrace()
    } })
    await f.startAuthority()
    expect((await f.settleAuthority()).state).toBe('failed')
    expect(f.state().validation.authority.observationDigest).toBe(null)
  })

  it('retains a lost final acknowledgment as unknown and recovers without replay', async () => {
    const f = await authorityFixture()
    const saved = f.controller.checkpointAuthority
    vi.spyOn(f.controller, 'checkpointAuthority').mockReturnValue({ ok: false, code: 'uncertain', error: 'lost' })
    await f.startAuthority(); await delay(20)
    expect(f.state().validation.authority.stage).toBe('running')
    f.controller.checkpointAuthority = saved
    createValidationManager(f.data, f.controller, f.workspace, f.config).recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().validation.authority.error).toMatch(/interrupted/)
    expect(f.observeAuthority).toHaveBeenCalledOnce()
  })

  it('v4 reads migrate without changing bytes, and invented native health authority is rejected', async () => {
    const f = await authorityFixture(), file = path.join(f.data, 'self-modification/changes.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.version = raw.lifecycleVersion = 4
    delete raw.changes[0].attempts[0].validation.authority
    delete raw.changes[0].attempts[0].validation.seal
    delete raw.changes[0].attempts[0].validation.boundBuild
    fs.writeFileSync(file, JSON.stringify(raw))
    expect(f.controller.list().ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(raw))
    await f.startAuthority(); await f.settleAuthority()
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(latest.version).toBe(7)
    latest.changes[0].attempts[0].validation.authority.nativeBehaviorVerified = true
    expect(() => decodeJournal(JSON.stringify(latest))).toThrow()
  })
})
