import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const { createChangeController, registerChangeController } = require('./self-modification.cjs')
const { createWorkspaceManager, runGit } = require('./self-modification-workspace.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const input = { request: 'Improve fixture search', acceptanceCriteria: 'Show truthful candidate changes.' }

// Ephemeral Git objects use the environment's existing identity, never -c user.*
// or author environment overrides. No live repository index/history is touched.
function git(root, args, input) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
function fixture(options) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-source-unit-')))
  roots.push(root)
  const repo = path.join(root, 'repo'), data = path.join(root, 'data')
  fs.mkdirSync(repo); fs.mkdirSync(data)
  git(repo, ['init', '-q'])
  const blob = git(repo, ['hash-object', '-w', '--stdin'], 'baseline\n')
  const tree = git(repo, ['mktree'], `100644 blob ${blob}\tnote.txt\n`)
  const head = git(repo, ['commit-tree', tree, '-m', 'Disposable test baseline'])
  git(repo, ['update-ref', 'HEAD', head])
  git(repo, ['read-tree', 'HEAD'])
  fs.writeFileSync(path.join(repo, 'note.txt'), 'baseline\n')
  const controller = createChangeController(data, options?.journalIo)
  const saved = controller.create(0, input)
  expect(saved.ok).toBe(true)
  const change = saved.changes[0], attempt = change.attempts[0]
  const manager = createWorkspaceManager(data, controller, options)
  return { root, repo, data, head, controller, manager, id: change.id, attemptId: attempt.id }
}
async function select(f) {
  const result = await f.manager.selectRepository(f.repo)
  expect(result.ok).toBe(true)
  return result.selection
}
async function start(f, selection = undefined) {
  selection ||= await select(f)
  const result = await f.manager.prepare(f.controller.list().revision, f.id, f.attemptId, { selectionId: selection.id, baseline: 'head' })
  expect(result.ok).toBe(true)
  expect(result.changes[0].attempts[0].state).toBe('preparing')
  return result
}
async function settled(f) {
  for (let i = 0; i < 200; i++) {
    const snapshot = f.controller.list()
    if (snapshot.ok && snapshot.changes[0].attempts.at(-1).state !== 'preparing') return snapshot.changes[0].attempts.at(-1)
    await delay(10)
  }
  throw new Error('Preparation did not settle')
}
function workspace(f, attempt) {
  return path.join(f.data, 'self-modification/workspaces', attempt.preparation.workspace.id)
}
function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

describe('isolated committed source preparation', () => {
  it('requires a bounded explicit baseline choice; renderer paths are not accepted', async () => {
    const f = fixture()
    const selection = await select(f)
    for (const decision of [null, {}, { selectionId: selection.id, baseline: 'working-copy' },
      { selectionId: selection.id, baseline: 'head', path: f.repo }, { selectionId: randomUUID(), baseline: 'head' }]) {
      expect((await f.manager.prepare(1, f.id, f.attemptId, decision)).ok).toBe(false)
    }
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
  })

  it('copies only committed bytes, preserves dirty/untracked work, and survives controller restart', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.repo, 'note.txt'), 'dirty live work\n')
    fs.writeFileSync(path.join(f.repo, 'private-untracked.txt'), 'must not copy\n')
    const selection = await select(f)
    expect(selection.dirtyEntries).toBe(2)
    const beforeStatus = git(f.repo, ['status', '--porcelain=v1'])
    await start(f, selection)
    const attempt = await settled(f)
    expect(attempt.state).toBe('prepared')
    const root = workspace(f, attempt)
    expect(fs.readFileSync(path.join(root, 'source/note.txt'), 'utf8')).toBe('baseline\n')
    expect(fs.existsSync(path.join(root, 'source/private-untracked.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(f.repo, 'note.txt'), 'utf8')).toBe('dirty live work\n')
    expect(git(f.repo, ['status', '--porcelain=v1'])).toBe(beforeStatus)
    expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(f.head)
    expect(createChangeController(f.data).list()).toEqual(f.controller.list())
    const newController = createChangeController(f.data)
    const review = await createWorkspaceManager(f.data, newController).review(f.id, f.attemptId)
    expect(review.ok).toBe(true)
    expect(review.files).toHaveLength(1)
    expect(review.files[0].status).toBe('unchanged')
  })

  it('shows actual added, modified, deleted and binary diffs, never touching the baseline', async () => {
    const f = fixture()
    await start(f)
    const attempt = await settled(f), root = workspace(f, attempt)
    fs.writeFileSync(path.join(root, 'source/note.txt'), 'changed proposal\n')
    fs.writeFileSync(path.join(root, 'source/added.txt'), '<script>untrusted</script>\n')
    fs.writeFileSync(path.join(root, 'source/binary.bin'), Buffer.from([0, 1, 2]))
    const review = await f.manager.review(f.id, f.attemptId)
    expect(review.ok).toBe(true)
    expect(review.files.find(file => file.path === 'note.txt')).toMatchObject({ status: 'modified', binary: false })
    expect(review.files.find(file => file.path === 'note.txt').diff).toContain('-baseline')
    expect(review.files.find(file => file.path === 'note.txt').diff).toContain('+changed proposal')
    expect(review.files.find(file => file.path === 'added.txt').diff).toContain('+<script>untrusted</script>')
    expect(review.files.find(file => file.path === 'binary.bin')).toMatchObject({ status: 'added', binary: true, diff: null })
    fs.unlinkSync(path.join(root, 'source/note.txt'))
    expect((await f.manager.review(f.id, f.attemptId)).files.find(file => file.path === 'note.txt').status).toBe('deleted')
    expect(fs.readFileSync(path.join(root, 'baseline/note.txt'), 'utf8')).toBe('baseline\n')
    expect(fs.readFileSync(path.join(f.repo, 'note.txt'), 'utf8')).toBe('baseline\n')
  })

  it('detects source status and HEAD changes after selection without creating a workspace', async () => {
    const f = fixture()
    let selection = await select(f)
    fs.writeFileSync(path.join(f.repo, 'note.txt'), 'new dirty bytes\n')
    expect(await f.manager.prepare(1, f.id, f.attemptId, { selectionId: selection.id, baseline: 'head' }))
      .toMatchObject({ ok: false, code: 'stale' })
    selection = await select(f)
    const tree = git(f.repo, ['rev-parse', 'HEAD^{tree}'])
    const next = git(f.repo, ['commit-tree', tree, '-p', f.head, '-m', 'Disposable changed HEAD'])
    git(f.repo, ['update-ref', 'HEAD', next])
    expect((await f.manager.prepare(1, f.id, f.attemptId, { selectionId: selection.id, baseline: 'head' })).code).toBe('stale')
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
  })

  it('a failed intent write prevents materialization', async () => {
    let fail = false
    const journalIo = { ...fs, writeFileSync: (...args) => {
      if (fail) throw new Error('Synthetic journal failure')
      return fs.writeFileSync(...args)
    } }
    const f = fixture({ journalIo })
    const selection = await select(f)
    fail = true
    expect((await f.manager.prepare(1, f.id, f.attemptId, { selectionId: selection.id, baseline: 'head' })).ok).toBe(false)
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
  })

  it('fences cancellation and a deliberately late Git result before workspace creation', async () => {
    const hold = deferred(), entered = deferred(), returned = deferred()
    const f = fixture({ git: async (root, args, options) => {
      if (args[0] === 'cat-file') {
        entered.resolve()
        await hold.promise
        const result = await runGit(root, args, { ...options, signal: undefined })
        returned.resolve()
        return result
      }
      return runGit(root, args, options)
    } })
    await start(f)
    await entered.promise
    const cancelled = f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    expect(cancelled.ok).toBe(true)
    f.manager.cancel(f.id, f.attemptId)
    hold.resolve()
    await returned.promise
    await delay(30)
    expect(f.controller.list()).toEqual(cancelled)
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
  })

  it('runs two candidates only in separate owned workspaces and refuses a third preparation', async () => {
    const hold = deferred(), entered = deferred()
    let waiting = 0
    const f = fixture({ git: async (root, args, options) => {
      if (args[0] === 'cat-file') { if (++waiting === 2) entered.resolve(); await hold.promise }
      return runGit(root, args, options)
    } })
    await start(f)
    const second = f.controller.create(f.controller.list().revision, input).changes.at(-1)
    const selection = await select(f)
    expect((await f.manager.prepare(f.controller.list().revision, second.id, second.attempts[0].id,
      { selectionId: selection.id, baseline: 'head' })).ok).toBe(true)
    await entered.promise
    const third = f.controller.create(f.controller.list().revision, input).changes.at(-1)
    const thirdSelection = await select(f)
    expect(await f.manager.prepare(f.controller.list().revision, third.id, third.attempts[0].id,
      { selectionId: thirdSelection.id, baseline: 'head' })).toMatchObject({ ok: false, code: 'limit' })
    hold.resolve()
    await settled(f)
    for (let i = 0; i < 200 && f.controller.list().changes[1].attempts[0].state === 'preparing'; i++) await delay(10)
    const changes = f.controller.list().changes
    expect(changes[0].attempts[0].state).toBe('prepared')
    expect(changes[1].attempts[0].state).toBe('prepared')
    expect(changes[0].attempts[0].preparation.workspace.id).not.toBe(changes[1].attempts[0].preparation.workspace.id)
    expect(changes[2].attempts[0].state).toBe('requested')
  })

  it('retains prepared work when cancelled and creates a distinct empty reopened attempt', async () => {
    const f = fixture()
    await start(f)
    const attempt = await settled(f), root = workspace(f, attempt)
    const cancelled = f.controller.cancel(f.controller.list().revision, f.id, f.attemptId)
    expect(cancelled.ok).toBe(true)
    const reopened = f.controller.reopen(cancelled.revision, f.id, f.attemptId)
    expect(reopened.ok).toBe(true)
    expect(reopened.changes[0].attempts[1].preparation).toBeNull()
    expect(fs.readFileSync(path.join(root, 'source/note.txt'), 'utf8')).toBe('baseline\n')
    expect((await f.manager.review(f.id, f.attemptId)).code).toBe('stale')
  })

  it('cancellation during copying retains partial owned files and prevents completion', async () => {
    let controller, id, attemptId, cancelled = false
    const io = { ...fs, fsyncSync: fd => {
      fs.fsyncSync(fd)
      if (!cancelled && fs.fstatSync(fd).size === Buffer.byteLength('baseline\n')) {
        cancelled = true
        expect(controller.cancel(controller.list().revision, id, attemptId).ok).toBe(true)
      }
    } }
    const f = fixture({ io })
    ;({ controller, id, attemptId } = f)
    await start(f)
    await settled(f)
    await delay(50)
    const attempt = f.controller.list().changes[0].attempts[0]
    expect(attempt.state).toBe('cancelled')
    expect(attempt.preparation.manifestDigest).toBeNull()
    expect(fs.existsSync(path.join(workspace(f, attempt), 'source/note.txt'))).toBe(true)
  })

  it('does not claim preparation succeeded after its final journal checkpoint fails', async () => {
    let fail = false
    const rejected = deferred()
    const journalIo = { ...fs, writeFileSync: (...args) => {
      if (fail) { rejected.resolve(); throw new Error('Synthetic final checkpoint failure') }
      return fs.writeFileSync(...args)
    } }
    const io = { ...fs, fsyncSync: fd => {
      fs.fsyncSync(fd)
      if (fs.fstatSync(fd).size === Buffer.byteLength('baseline\n')) fail = true
    } }
    const f = fixture({ io, journalIo })
    await start(f)
    await rejected.promise
    expect(f.controller.list().changes[0].attempts[0].state).toBe('preparing')
    fail = false
    f.manager.recover()
    expect(f.controller.list().changes[0].attempts[0].state).toBe('failed')
    expect(f.controller.list().changes[0].attempts[0].preparation.error).toContain('acknowledgment was lost')
  })

  it('recovers interrupted intent truthfully, without creating, resuming or deleting files', async () => {
    const f = fixture()
    const selection = await select(f)
    const stat = fs.statSync(f.repo), gitStat = fs.statSync(path.join(f.repo, '.git'))
    const planned = { operationId: randomUUID(), ownerPid: 2147483647,
      source: { root: f.repo, dev: stat.dev, ino: stat.ino, gitDev: gitStat.dev, gitIno: gitStat.ino,
        head: selection.head, statusDigest: 'a'.repeat(64), dirtyEntries: 0, kind: 'head', dirtyExcluded: true },
      workspace: { id: randomUUID(), token: randomUUID(), dev: null, ino: null }, manifestDigest: null, fileCount: null, error: null }
    expect(f.controller.beginPreparation(1, f.id, f.attemptId, planned).ok).toBe(true)
    const recovered = createChangeController(f.data)
    createWorkspaceManager(f.data, recovered).recover()
    const attempt = recovered.list().changes[0].attempts[0]
    expect(attempt.state).toBe('failed')
    expect(attempt.preparation.error).toContain('interrupted')
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
    expect(recovered.reopen(recovered.list().revision, f.id, f.attemptId).ok).toBe(true)
  })

  it.each(['owner', 'manifest', 'baseline', 'directory', 'symlink'])('rejects %s ownership mutation and preserves recoverable work', async kind => {
    const f = fixture()
    await start(f)
    const attempt = await settled(f), root = workspace(f, attempt)
    if (kind === 'owner') fs.writeFileSync(path.join(root, 'owner.json'), '{"version":1,"token":"wrong"}')
    if (kind === 'manifest') fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":1,"files":[]}')
    if (kind === 'baseline') fs.writeFileSync(path.join(root, 'baseline/note.txt'), 'baseline tamper')
    if (kind === 'directory') { fs.renameSync(root, `${root}.retained`); fs.mkdirSync(root) }
    if (kind === 'symlink') fs.symlinkSync(path.join(f.repo, 'note.txt'), path.join(root, 'source/link.txt'))
    expect((await f.manager.review(f.id, f.attemptId)).ok).toBe(false)
    expect(fs.readFileSync(path.join(f.repo, 'note.txt'), 'utf8')).toBe('baseline\n')
    expect(fs.existsSync(kind === 'directory' ? `${root}.retained` : root)).toBe(true)
  })

  it('rejects symlinked selected repositories and nested directories', async () => {
    const f = fixture()
    fs.symlinkSync(f.repo, path.join(f.root, 'linked'))
    expect((await f.manager.selectRepository(path.join(f.root, 'linked'))).ok).toBe(false)
    fs.mkdirSync(path.join(f.repo, 'nested'))
    expect((await f.manager.selectRepository(path.join(f.repo, 'nested'))).ok).toBe(false)
  })

  it('rejects symlinked workspace storage before creating any candidate', async () => {
    const f = fixture()
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(f.data, 'self-modification/workspaces'))
    await start(f)
    expect((await settled(f)).state).toBe('failed')
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it.each(['.env', 'linked-file'])('rejects a %s committed baseline without execution or activation', async name => {
    const f = fixture()
    const blob = git(f.repo, ['hash-object', '-w', '--stdin'], 'inert fixture bytes\n')
    const tree = git(f.repo, ['mktree'], `${name === '.env' ? '100644' : '120000'} blob ${blob}\t${name}\n`)
    const head = git(f.repo, ['commit-tree', tree, '-m', 'Disposable unsupported baseline'])
    git(f.repo, ['update-ref', 'HEAD', head])
    await start(f)
    const attempt = await settled(f)
    expect(attempt.state).toBe('failed')
    expect(fs.existsSync(path.join(f.data, 'self-modification/workspaces'))).toBe(false)
  })

  it('supports the committed .env.example template used by the actual app without copying a live .env', async () => {
    const f = fixture()
    const blob = git(f.repo, ['hash-object', '-w', '--stdin'], '# Example only\nPROVIDER_KEY=\n')
    const tree = git(f.repo, ['mktree'], `100644 blob ${blob}\t.env.example\n`)
    const head = git(f.repo, ['commit-tree', tree, '-m', 'Disposable template baseline'])
    git(f.repo, ['update-ref', 'HEAD', head])
    fs.writeFileSync(path.join(f.repo, '.env'), 'must remain outside the candidate')
    await start(f)
    const attempt = await settled(f)
    expect(attempt.state).toBe('prepared')
    const root = workspace(f, attempt)
    expect(fs.readFileSync(path.join(root, 'source/.env.example'), 'utf8')).toBe('# Example only\nPROVIDER_KEY=\n')
    expect(fs.existsSync(path.join(root, 'source/.env'))).toBe(false)
  })

  it('does not run source hooks, fsmonitor, candidate scripts, or candidate Git configuration', async () => {
    const f = fixture()
    const marker = path.join(f.root, 'must-not-run')
    const script = path.join(f.repo, '.git/hooks/post-checkout')
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 })
    git(f.repo, ['config', 'core.fsmonitor', script])
    await start(f)
    const attempt = await settled(f), root = workspace(f, attempt)
    expect(attempt.state).toBe('prepared')
    fs.writeFileSync(path.join(root, 'source/evil.sh'), `touch "${marker}"`)
    fs.mkdirSync(path.join(root, 'source/.git'))
    fs.writeFileSync(path.join(root, 'source/.git/config'), '[diff]\nexternal = sh evil.sh\n')
    expect((await f.manager.review(f.id, f.attemptId)).ok).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('migrates a valid v1 journal explicitly, without writing on read or losing cancelled history', () => {
    const f = fixture()
    const cancelled = f.controller.cancel(1, f.id, f.attemptId)
    const legacy = { version: 1, lifecycleVersion: 1, revision: cancelled.revision, changes: cancelled.changes.map(change => ({
      ...change, attempts: change.attempts.map(({ statusAt, preparation, execution, validation, ...attempt }) => attempt),
    })) }
    const file = path.join(f.data, 'self-modification/changes.json'), bytes = JSON.stringify(legacy)
    fs.writeFileSync(file, bytes)
    const restarted = createChangeController(f.data)
    expect(restarted.list().changes[0].attempts[0].state).toBe('cancelled')
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    expect(restarted.reopen(2, f.id, f.attemptId).ok).toBe(true)
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(migrated.version).toBe(7)
    expect(migrated.lifecycleVersion).toBe(7)
    expect(migrated.changes[0].attempts[0].id).toBe(f.attemptId)
  })
})

describe('native source selection authority', () => {
  it('uses the native picker, rejects navigation while it is open, and never accepts a renderer path', async () => {
    const f = fixture(), handlers = new Map(), hold = deferred()
    const main = { webContents: { mainFrame: {} } }, event = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
    let windows = main
    registerChangeController({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, assertMainSender: () => {},
      getMainWindow: () => windows, getUserDataDir: () => f.data,
      dialog: { showOpenDialog: async () => { await hold.promise; return { canceled: false, filePaths: [f.repo] } } } })
    expect((await handlers.get('hd:changes:selectRepository')(event, f.repo)).ok).toBe(false)
    const pending = handlers.get('hd:changes:selectRepository')(event)
    windows = { webContents: { mainFrame: {} } }
    hold.resolve()
    expect((await pending).ok).toBe(false)
    expect(f.controller.list().changes[0].attempts[0].state).toBe('requested')
  })
})
