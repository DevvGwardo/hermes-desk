import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const { createChangeController } = require('./self-modification.cjs')
const { createWorkspaceManager } = require('./self-modification-workspace.cjs')
const { createExecutionManager } = require('./self-modification-execution.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const input = { port: 8080, model: 'fixture-model', files: ['src/components/Note.tsx'] }
const proposal = { changes: [{ op: 'write', path: 'src/components/Note.tsx', content: 'candidate only\n' }] }
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-execution-unit-')))
  roots.push(root)
  const repo = path.join(root, 'repo'), data = path.join(root, 'data')
  fs.mkdirSync(repo); fs.mkdirSync(data)
  const git = (args, input) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    { input, encoding: 'utf8' }).trim()
  git(['init', '-q'])
  const blob = git(['hash-object', '-w', '--stdin'], 'baseline\n')
  const components = git(['mktree'], `100644 blob ${blob}\tNote.tsx\n`)
  const srcTree = git(['mktree'], `040000 tree ${components}\tcomponents\n`)
  const tree = git(['mktree'], `040000 tree ${srcTree}\tsrc\n`)
  const head = git(['commit-tree', tree, '-m', 'Disposable execution baseline'])
  git(['update-ref', 'HEAD', head]); git(['read-tree', 'HEAD'])
  fs.mkdirSync(path.join(repo, 'src/components'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src/components/Note.tsx'), 'dirty source remains\n')
  const controller = createChangeController(data, options.io)
  const saved = controller.create(0, { request: 'Change fixture note', acceptanceCriteria: 'Only candidate text changes.' })
  const id = saved.changes[0].id, attemptId = saved.changes[0].attempts[0].id
  const workspace = createWorkspaceManager(data, controller)
  const selection = await workspace.selectRepository(repo)
  await workspace.prepare(1, id, attemptId, { selectionId: selection.selection.id, baseline: 'head' })
  while (controller.list().changes[0].attempts[0].state === 'preparing') await delay(5)
  expect(controller.list().changes[0].attempts[0].state).toBe('prepared')
  const state = () => controller.list().changes[0].attempts.at(-1)
  const source = path.join(data, 'self-modification/workspaces', state().preparation.workspace.id, 'source')
  const run = options.run || vi.fn(async ({ context, onCall }) => {
    expect(context.acceptanceCriteria).toBe('Only candidate text changes.')
    expect(context.files[0].content).toBe('baseline\n')
    await onCall(1)
    return { proposal, calls: 1 }
  })
  const confirm = options.confirm || vi.fn(async () => true)
  const manager = createExecutionManager(data, controller, workspace, { run, confirm, hermesHome: () => path.join(root, 'fake-runtime') })
  const start = (value = input) => manager.implement(controller.list().revision, id, attemptId, value)
  const settle = async () => {
    for (let i = 0; i < 100; i++) { if (state().state !== 'implementing') return state(); await delay(5) }
    throw new Error('Execution did not settle')
  }
  return { root, repo, data, controller, workspace, state, source, run, confirm, manager, start, settle, id, attemptId }
}

describe('bounded candidate-only implementation', () => {
  it('requires native consent, supplies criteria, applies real edits and persists truthful evidence', async () => {
    const f = await fixture()
    const before = f.state().preparation.manifestDigest
    expect((await f.start()).ok).toBe(true)
    const state = await f.settle()
    expect(state.state).toBe('implemented')
    expect(state.execution.calls).toBe(1)
    expect(state.execution.outputDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('candidate only\n')
    expect(fs.readFileSync(path.join(f.repo, 'src/components/Note.tsx'), 'utf8')).toBe('dirty source remains\n')
    expect(state.preparation.manifestDigest).toBe(before)
    expect(createChangeController(f.data).list()).toEqual(f.controller.list())
    expect((await f.workspace.review(f.id, f.attemptId)).files[0].status).toBe('modified')
    expect(await f.start()).toMatchObject({ ok: false, code: 'stale' })
  })

  it('a declined native confirmation leaves the candidate and journal unchanged', async () => {
    const f = await fixture({ confirm: async () => false })
    const before = f.controller.list()
    expect((await f.start()).ok).toBe(true)
    expect(f.controller.list()).toEqual(before)
    expect(f.run).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
  })

  it('does not release another confirmation slot when a concurrent call is refused', async () => {
    const hold = deferred()
    const f = await fixture({ confirm: () => hold.promise })
    const first = f.start()
    await delay(10)
    expect(await f.start()).toMatchObject({ ok: false, code: 'limit' })
    expect(await f.start()).toMatchObject({ ok: false, code: 'limit' })
    hold.resolve(false)
    await first
  })

  it.each([null, {}, { ...input, port: 8642 }, { ...input, port: 9119 }, { ...input, port: '8080' },
    { ...input, model: '--command' }, { ...input, shell: 'anything' }, { ...input, files: [] },
    { ...input, files: ['../src/components/Note.tsx'] }, { ...input, files: ['src/components/Note.tsx', 'src/components/Note.tsx'] }])('refuses unbounded or unsafe input %j', async value => {
    const f = await fixture()
    expect((await f.start(value)).ok).toBe(false)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('detects file mutation and caller navigation during native confirmation before starting work', async () => {
    const f = await fixture({ confirm: async () => {
      fs.writeFileSync(path.join(f.source, 'src/components/Note.tsx'), 'changed during consent\n')
      return true
    } })
    expect(await f.start()).toMatchObject({ ok: false, code: 'stale' })
    expect(f.run).not.toHaveBeenCalled()
    const g = await fixture()
    expect((await g.manager.implement(g.controller.list().revision, g.id, g.attemptId, input,
      () => { throw new Error('caller navigated') })).ok).toBe(false)
    expect(g.run).not.toHaveBeenCalled()
  })

  it('a failed atomic intent prevents the worker from starting', async () => {
    const io = Object.create(fs)
    const f = await fixture({ io })
    io.writeFileSync = () => { throw new Error('disk full') }
    expect((await f.start()).ok).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.state().state).toBe('prepared')
  })

  it('a failed inference checkpoint prevents physical dispatch and application', async () => {
    let physical = 0
    const io = Object.create(fs)
    const f = await fixture({ io, run: async ({ onCall }) => {
      io.writeFileSync = () => { throw new Error('disk full') }
      await onCall(1)
      physical++
      return { proposal, calls: 1 }
    } })
    await f.start(); await delay(20)
    expect(physical).toBe(0)
    expect(f.state().state).toBe('implementing')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
    delete io.writeFileSync
    f.manager.recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().execution.error).toMatch(/acknowledgment was lost/)
  })

  it('cancellation aborts the worker and fences a deliberately late proposal and new attempt', async () => {
    const hold = deferred()
    let signal
    const f = await fixture({ run: async options => { signal = options.signal; await hold.promise; return { proposal, calls: 0 } } })
    await f.start()
    const cancelled = f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    f.manager.cancel(f.id, f.attemptId)
    expect(signal.aborted).toBe(true)
    expect(f.controller.reopen(cancelled.revision, f.id, f.attemptId).ok).toBe(true)
    const newer = f.controller.list()
    hold.resolve(); await delay(20)
    expect(f.controller.list()).toEqual(newer)
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
  })

  it.each([
    { changes: [{ op: 'write', path: '../owner.json', content: 'escape' }] },
    { changes: [{ op: 'write', path: '.env', content: 'secret' }] },
    { changes: [{ op: 'write', path: 'src/components/Note.tsx', content: 'valid' }, { op: 'execute', path: 'bad' }] },
    { changes: [{ op: 'write', path: 'src/components/Note.tsx', content: 'x'.repeat(128 * 1024 + 1) }] },
    { changes: [{ op: 'delete', path: 'src/components/Note.tsx' }, { op: 'write', path: 'src/components/Note.tsx', content: 'duplicate' }] },
  ])('rejects the entire unsafe proposal before any content writes', async bad => {
    const f = await fixture({ run: async () => ({ proposal: bad, calls: 0 }) })
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
  })

  it('rejects a symlink replacement and retains the outside target unchanged', async () => {
    let f
    f = await fixture({ run: async () => {
      fs.unlinkSync(path.join(f.source, 'src/components/Note.tsx'))
      fs.symlinkSync(path.join(f.repo, 'src/components/Note.tsx'), path.join(f.source, 'src/components/Note.tsx'))
      return { proposal, calls: 0 }
    } })
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.readFileSync(path.join(f.repo, 'src/components/Note.tsx'), 'utf8')).toBe('dirty source remains\n')
  })

  it('supports new text paths and deletion of a selected existing file without running scripts', async () => {
    const f = await fixture({ run: async () => ({ calls: 0, proposal: { changes: [
      { op: 'delete', path: 'src/components/Note.tsx' }, { op: 'write', path: 'src/components/New.tsx', content: 'new candidate text\n' },
      { op: 'write', path: 'src/components/ScriptText.tsx', content: 'echo must-not-run > ../outside\n' },
    ] } }) })
    await f.start()
    expect((await f.settle()).state).toBe('implemented')
    expect(fs.existsSync(path.join(f.source, 'src/components/Note.tsx'))).toBe(false)
    expect(fs.readFileSync(path.join(f.source, 'src/components/New.tsx'), 'utf8')).toBe('new candidate text\n')
    expect(fs.existsSync(path.join(f.source, '../outside'))).toBe(false)
  })

  it('rejects ancestor/descendant output collisions before any content writes', async () => {
    const f = await fixture({ run: async () => ({ calls: 0, proposal: { changes: [
      { op: 'write', path: 'new-path', content: 'not a directory' },
      { op: 'write', path: 'new-path/nested.txt', content: 'nested' },
    ] } }) })
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.existsSync(path.join(f.source, 'new-path'))).toBe(false)
  })

  it('rejects changes to an existing file outside the explicit context', async () => {
    const f = await fixture({ run: async () => ({ calls: 0,
      proposal: { changes: [{ op: 'write', path: 'src/components/Unselected.tsx', content: 'unauthorized replacement' }] } }) })
    fs.writeFileSync(path.join(f.source, 'src/components/Unselected.tsx'), 'manual candidate work')
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Unselected.tsx'), 'utf8')).toBe('manual candidate work')
  })

  it.each(['root', 'owner', 'parent'])('rejects %s replacement during execution without writing outside the candidate', async kind => {
    let f
    f = await fixture({ run: async () => {
      if (kind === 'root') {
        fs.renameSync(f.source, f.source + '-retained')
        fs.mkdirSync(f.source)
      } else if (kind === 'owner') {
        fs.writeFileSync(path.join(f.source, '../owner.json'), '{}')
      } else {
        fs.symlinkSync(f.repo, path.join(f.source, 'src/components/escaped'))
      }
      return { calls: 0, proposal: kind === 'parent'
        ? { changes: [{ op: 'write', path: 'src/components/escaped/Foreign.tsx', content: 'escape' }] } : proposal }
    } })
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.existsSync(path.join(f.repo, 'foreign.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(f.repo, 'src/components/Note.tsx'), 'utf8')).toBe('dirty source remains\n')
  })

  it('cancellation during application retains partial edits but never finalizes the attempt', async () => {
    const f = await fixture({ run: async () => ({ calls: 0, proposal: { changes: [
      ...proposal.changes, { op: 'write', path: 'src/components/Second.tsx', content: 'must not be applied' },
    ] } }) })
    const apply = f.workspace.applyProposal
    let checks = 0
    f.workspace.applyProposal = (id, attemptId, context, value, check) => apply(id, attemptId, context, value, () => {
      if (++checks === 3) {
        f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
        f.manager.cancel(f.id, f.attemptId)
      }
      check()
    })
    await f.start()
    expect((await f.settle()).state).toBe('cancelled')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('candidate only\n')
    expect(fs.existsSync(path.join(f.source, 'src/components/Second.tsx'))).toBe(false)
    expect(f.state().execution.outputDigest).toBeNull()
  })

  it('a failed applying checkpoint prevents candidate writes', async () => {
    const f = await fixture()
    const checkpoint = f.controller.checkpointExecution
    f.controller.checkpointExecution = (...args) => args.at(-1).stage === 'applying'
      ? { ok: false, code: 'storage', error: 'Fixture journal unavailable' } : checkpoint(...args)
    await f.start()
    expect((await f.settle()).state).toBe('failed')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
  })

  it('a failed final journal write retains edits as unknown, then recovers without rerunning', async () => {
    const io = Object.create(fs), f = await fixture({ io })
    const checkpoint = f.controller.checkpointExecution
    f.controller.checkpointExecution = (...args) => {
      if (args.at(-1).stage === 'implemented') io.writeFileSync = () => { throw new Error('disk full after edits') }
      return checkpoint(...args)
    }
    await f.start()
    for (let i = 0; i < 200 && fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8') !== 'candidate only\n'; i++) await delay(5)
    expect(f.state().state).toBe('implementing')
    expect(f.state().execution.stage).toBe('applying')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('candidate only\n')
    delete io.writeFileSync
    f.manager.recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().execution.outputDigest).toBeNull()
    expect(f.run).toHaveBeenCalledOnce()
  })

  it('records interrupted execution without resuming or removing candidate work', async () => {
    const f = await fixture()
    const context = await f.workspace.context(f.id, f.attemptId, input.files)
    expect(f.controller.beginExecution(f.controller.list().revision, f.id, f.attemptId, {
      operationId: randomUUID(), ownerPid: process.pid, stage: 'running', ...input,
      inputDigest: 'a'.repeat(64), calls: 0, outputDigest: null, error: null,
    }).ok).toBe(true)
    const restarted = createExecutionManager(f.data, f.controller, f.workspace)
    restarted.recover()
    expect(f.state().state).toBe('failed')
    expect(f.state().execution.error).toMatch(/interrupted/)
    expect(context.files[0].content).toBe('baseline\n')
    expect(fs.readFileSync(path.join(f.source, 'src/components/Note.tsx'), 'utf8')).toBe('baseline\n')
  })

  it('migrates v2 on read without changing bytes, then persists v7 on a successful write', async () => {
    const f = await fixture(), before = f.controller.list()
    const v2 = { version: 2, lifecycleVersion: 2, revision: before.revision, changes: before.changes.map(change => ({
      ...change, attempts: change.attempts.map(({ execution, validation, ...attempt }) => attempt),
    })) }
    const file = path.join(f.data, 'self-modification/changes.json'), raw = JSON.stringify(v2)
    fs.writeFileSync(file, raw)
    const fresh = createChangeController(f.data)
    expect(fresh.list().changes[0].attempts[0].execution).toBeNull()
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    expect(fresh.cancel(before.revision, f.id, f.attemptId).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(7)
  })

  it('retains contradictory or malformed v3 execution bytes instead of accepting success', async () => {
    const f = await fixture()
    await f.start(); await f.settle()
    const file = path.join(f.data, 'self-modification/changes.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const corrupt of [
      attempt => { attempt.execution.calls = 3 },
      attempt => { attempt.execution.outputDigest = null },
      attempt => { attempt.execution.error = 'not compatible with implemented' },
      attempt => { attempt.execution.inputDigest = ['a'.repeat(64)] },
      attempt => { attempt.preparation.fileCount = null },
      attempt => { attempt.preparation.workspace.dev = null; attempt.preparation.workspace.ino = null },
    ]) {
      const raw = structuredClone(saved)
      corrupt(raw.changes[0].attempts[0])
      const bytes = JSON.stringify(raw)
      fs.writeFileSync(file, bytes)
      expect(createChangeController(f.data).list()).toMatchObject({ ok: false, code: 'storage' })
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    }
  })
})
