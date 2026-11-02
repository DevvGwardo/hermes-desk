import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createConsent } = require('./security-consent.cjs')
const { createFsAccess } = require('./fs-access.cjs')
const { cliPlan } = require('./cli-policy.cjs')
const { runBoundedCli } = require('./bounded-cli.cjs')
const { createHudActionConsent } = require('./hud-action-consent.cjs')
const cleanups = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) await cleanups.pop()()
})
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'hd-security-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return home
}
function windowFixture() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() })
  const win = { webContents: sender, isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  return { sender, win, event }
}

describe('native consent is bound to the document', () => {
  it('defaults to cancellation and refuses a foreign frame without opening a dialog', async () => {
    const { sender, win, event } = windowFixture()
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
    const confirm = createConsent({ dialog, getWindow: () => win })
    expect(await confirm(event, { message: 'Synthetic permission' })).toBe(false)
    expect(dialog.showMessageBox.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0 })
    expect(await confirm({ sender, senderFrame: {} }, { message: 'Synthetic' })).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledOnce()
  })
  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])(
    'revokes pending consent on %s and rejects concurrent prompts', async name => {
      const { sender, win, event } = windowFixture()
      let answer
      const confirm = createConsent({ dialog: { showMessageBox: () => new Promise(resolve => { answer = resolve }) }, getWindow: () => win })
      const result = confirm(event, { message: 'Synthetic' })
      expect(await confirm(event, { message: 'Second synthetic' })).toBe(false)
      sender.emit(name)
      answer({ response: 1 })
      expect(await result).toBe(false)
      expect(sender.listenerCount(name)).toBe(0)
    })
})

describe('workspace filesystem capability', () => {
  it('does not grant home, credentials, app state or source from the old home jail', async () => {
    const home = await fixture()
    const appRoot = path.join(home, 'source')
    await mkdir(appRoot)
    const access = createFsAccess({ home, protectedRoots: [appRoot] })
    for (const candidate of [home, path.join(home, '.hermes/serve.token'),
      path.join(home, 'Library/settings.json'), appRoot, path.join(appRoot, 'main.cjs')]) {
      expect(() => access.validate(candidate)).toThrow()
    }
    const root = await access.ensure()
    expect(access.validate(path.join(root, 'report.txt'))).toBe(path.join(root, 'report.txt'))
    expect(() => access.select(home)).toThrow()
    expect(() => access.select(appRoot)).toThrow()
  })
  it('refuses deep missing descendants through an escaping symlink and hidden-file aliases', async () => {
    const home = await fixture()
    const workspace = path.join(home, 'work')
    const secrets = path.join(home, '.hermes')
    await mkdir(workspace); await mkdir(secrets)
    await writeFile(path.join(workspace, '.env'), 'obviously-synthetic')
    await symlink(secrets, path.join(workspace, 'escape'))
    await symlink(path.join(workspace, '.env'), path.join(workspace, 'report.txt'))
    const access = createFsAccess({ home })
    access.select(workspace)
    expect(() => access.validate(path.join(workspace, 'escape/new/deeper/config.yaml'))).toThrow()
    expect(() => access.validate(path.join(workspace, 'report.txt'))).toThrow()
    access.reset()
    expect(() => access.validate(path.join(workspace, 'ordinary.txt'))).toThrow()
  })
})

describe('legacy CLI is typed and bounded', () => {
  it('requires native confirmation for code/config changes and rejects option smuggling', () => {
    expect(cliPlan('mcp', ['add', 'synthetic', '--command', '/bin/echo', '--args', 'synthetic']).confirm).toBe(true)
    expect(cliPlan('task', ['add', '--agent', 'hermes', 'Synthetic goal']).confirm).toBe(true)
    expect(cliPlan('kanban', ['dispatch', '--max', '1']).confirm).toBe(true)
    expect(cliPlan('cron', ['list']).confirm).toBe(false)
    for (const [kind, args] of [
      ['mcp', ['list', '--config', '/synthetic']], ['mcp', ['configure']],
      ['cron', ['create', '--script', '/synthetic.py']],
      ['task', ['add', '--cwd', '/synthetic', 'goal']],
      ['kanban', ['list', '--title', 'synthetic']], ['sessions', ['export', 'synthetic']],
    ]) expect(() => cliPlan(kind, args)).toThrow()
    expect(() => cliPlan('task', ['add', 'x'.repeat(3000)])).toThrow('native review')
  })
  it('kills an overproducing child and returns no captured secret-shaped output', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    const promise = runBoundedCli('/synthetic', [], {}, { spawnImpl: () => child, maxBytes: 8 })
    child.stdout.emit('data', Buffer.from('synthetic-output'))
    expect(await promise).toMatchObject({ ok: false, data: null, error: 'Local command output too large' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('HUD actions require explicit target-bound native consent', () => {
  it('never activates or types on denial, and rejects a switched target', async () => {
    const { event } = windowFixture()
    const run = vi.fn(async () => ({ stdout: '424242, org.synthetic.Editor\n' }))
    const denied = createHudActionConsent({ confirm: async () => false, run })
    expect(await denied(event, 'Synthetic action')).toBeNull()
    expect(run).toHaveBeenCalledOnce()
    const confirm = vi.fn(async () => true)
    const allowed = createHudActionConsent({ confirm, run })
    const grant = await allowed(event, 'Type synthetic text')
    expect(grant).toBeTruthy()
    expect(confirm.mock.calls[0][1].detail).toContain('org.synthetic.Editor')
    run.mockResolvedValueOnce({ stdout: '111111, org.synthetic.Other\n' })
    expect(await grant.revalidate()).toBe(false)
    grant.dispose()
    expect(run).toHaveBeenCalledTimes(5)
  })
  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])('revokes a granted HUD action on %s', async name => {
    const { event, sender } = windowFixture()
    const run = vi.fn(async () => ({ stdout: '424242, org.synthetic.Editor\n' }))
    const grant = await createHudActionConsent({ confirm: async () => true, run })(event, 'Synthetic action')
    sender.emit(name)
    expect(await grant.revalidate()).toBe(false)
    grant.dispose()
    expect(sender.listenerCount(name)).toBe(0)
  })
  it('consumes a HUD grant once without reactivating an application later', async () => {
    const { event } = windowFixture()
    const run = vi.fn(async () => ({ stdout: '424242, org.synthetic.Editor\n' }))
    const grant = await createHudActionConsent({ confirm: async () => true, run })(event, 'Synthetic action')
    expect(await grant.revalidate()).toBe(true)
    expect(await grant.revalidate()).toBe(false)
    expect(run).toHaveBeenCalledTimes(4)
    grant.dispose()
  })
})

async function pluginFixture() {
  const home = await fixture()
  const hermes = path.join(home, 'hermes')
  const dir = path.join(hermes, 'desktop-plugins/synthetic')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'plugin.js')
  await writeFile(file, 'export default { id: "synthetic", register() {} }')
  const { sender, win, event } = windowFixture()
  cleanups.push(() => sender.emit('destroyed'))
  const handlers = new Map()
  const confirm = vi.fn(async () => true)
  const module = { exports: {} }
  runInNewContext(readFileSync(require.resolve('./plugin-host.cjs'), 'utf8'), {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    process: { env: { HERMES_HOME: hermes }, platform: process.platform },
    require: name => name === 'electron' ? { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } : require(name),
  })
  module.exports.registerPluginHostIpc({ assertMainSender: candidate => {
    if (candidate.sender !== sender || candidate.senderFrame !== sender.mainFrame) throw new Error('Rejected')
  }, getMainWindow: () => win, confirm, getUserDataDir: () => home })
  return { home, dir, file, sender, event, handlers, confirm }
}

describe('plugin trust and resource lifecycle', () => {
  it('pins only native-approved exact bytes and detects edits made during confirmation', async () => {
    const { file, event, handlers, confirm } = await pluginFixture()
    const hash = createHash('sha256').update(await readFile(file)).digest('base64')
    expect(handlers.get('maia:plugins:getPin')(event, file)).toBeNull()
    confirm.mockImplementationOnce(async () => { await writeFile(file, 'changed synthetic bytes'); return true })
    expect(await handlers.get('maia:plugins:trust')(event, file, hash)).toEqual({ ok: false })
    expect(handlers.get('maia:plugins:getPin')(event, file)).toBeNull()
    const fresh = createHash('sha256').update(await readFile(file)).digest('base64')
    expect(await handlers.get('maia:plugins:trust')(event, file, fresh)).toMatchObject({ ok: true, hash: fresh })
    expect(handlers.get('maia:plugins:getPin')(event, file)).toBe(fresh)
    handlers.get('maia:plugins:revoke')(event, file)
    expect(handlers.get('maia:plugins:getPin')(event, file)).toBeNull()
  })
  it('archives trusted versions and restores only those, after a native confirm', async () => {
    const { home, file, event, handlers, confirm } = await pluginFixture()
    const sha = (text) => createHash('sha256').update(text).digest('base64')
    const v1 = await readFile(file, 'utf8')
    expect(await handlers.get('maia:plugins:trust')(event, file, sha(v1))).toMatchObject({ ok: true })
    const v2 = 'export default { id: "synthetic", register() { /* v2 */ } }'
    await writeFile(file, v2)
    expect(await handlers.get('maia:plugins:trust')(event, file, sha(v2))).toMatchObject({ ok: true })
    expect(handlers.get('maia:plugins:history')(event, file)).toEqual({ pin: sha(v2), versions: [sha(v2), sha(v1)] })
    expect(await handlers.get('maia:plugins:trustedSource')(event, file, sha(v1))).toEqual({ ok: true, text: v1 })

    const edit = 'export default { id: "synthetic", register() { /* agent edit */ } }'
    await writeFile(file, edit)
    // Unknown hashes and a declined dialog never write.
    expect(await handlers.get('maia:plugins:restore')(event, file, sha('never trusted'))).toEqual({ ok: false })
    confirm.mockImplementationOnce(async () => false)
    expect(await handlers.get('maia:plugins:restore')(event, file, sha(v1))).toEqual({ ok: false })
    expect(await readFile(file, 'utf8')).toBe(edit)
    // A file changed during the dialog is not overwritten.
    confirm.mockImplementationOnce(async () => { await writeFile(file, 'raced'); return true })
    expect(await handlers.get('maia:plugins:restore')(event, file, sha(v1))).toEqual({ ok: false })
    expect(await readFile(file, 'utf8')).toBe('raced')

    confirm.mockClear()
    expect(await handlers.get('maia:plugins:restore')(event, file, sha(v1))).toEqual({ ok: true, hash: sha(v1) })
    expect(confirm.mock.calls[0][1].message).toBe('Restore an earlier trusted version of this plugin?')
    expect(await readFile(file, 'utf8')).toBe(v1)
    expect(handlers.get('maia:plugins:getPin')(event, file)).toBe(sha(v1))
    expect(handlers.get('maia:plugins:history')(event, file).versions).toEqual([sha(v1), sha(v2)])
    const kept = (await readdir(path.join(home, 'plugin-trust-archive'))).filter((name) => name.startsWith('replaced-'))
    expect(kept).toHaveLength(1)
    expect(await readFile(path.join(home, 'plugin-trust-archive', kept[0]), 'utf8')).toBe('raced')

    // A tampered archive copy no longer matches its hash and is refused.
    await writeFile(path.join(home, 'plugin-trust-archive', `${Buffer.from(sha(v2), 'base64').toString('hex')}.js`), 'tampered')
    expect(await handlers.get('maia:plugins:trustedSource')(event, file, sha(v2))).toEqual({ ok: false })
    expect(await handlers.get('maia:plugins:restore')(event, file, sha(v2))).toEqual({ ok: false })
    expect(() => handlers.get('maia:plugins:history')(event, path.join(home, 'hermes/serve.token'))).toThrow()
  })
  it('rejects non-files and oversized files without unbounded reads', async () => {
    const { file, dir, event, handlers } = await pluginFixture()
    expect(await handlers.get('maia:plugins:readFileText')(event, dir)).toMatchObject({ ok: false })
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1))
    expect(await handlers.get('maia:plugins:readFileText')(event, file)).toMatchObject({ ok: false })
  })
  it('cannot use the plugin door to read backend credentials or plugin environment files', async () => {
    const { dir, event, handlers } = await pluginFixture()
    for (const file of [path.join(dir, '.env'), path.join(dir, 'credentials.json'),
      path.join(dir, '../../serve.token')]) {
      await writeFile(file, 'obviously-synthetic')
      expect(await handlers.get('maia:plugins:readFileText')(event, file)).toMatchObject({ ok: false })
      expect(() => handlers.get('maia:plugins:watchFile')(event, file)).toThrow()
    }
    await expect(handlers.get('maia:plugins:readDir')(event, dir)).rejects.toThrow()
  })
  it('caps concurrent reads and owned watchers', async () => {
    const { dir, file, event, handlers, sender } = await pluginFixture()
    const reads = Array.from({ length: 5 }, () => handlers.get('maia:plugins:readFileText')(event, file))
    expect(await reads[4]).toMatchObject({ ok: false, error: 'Plugin read busy' })
    expect((await Promise.all(reads.slice(0, 4))).every(result => result.ok)).toBe(true)
    const files = await Promise.all(Array.from({ length: 129 }, async (_, i) => {
      const folder = path.join(dir, '..', `synthetic-${i}`)
      await mkdir(folder)
      const entry = path.join(folder, 'plugin.js')
      await writeFile(entry, 'export default {}')
      return entry
    }))
    for (const entry of files.slice(0, 128)) expect(handlers.get('maia:plugins:watchFile')(event, entry).error).toBeUndefined()
    expect(() => handlers.get('maia:plugins:watchFile')(event, files[128])).toThrow('limit')
    sender.emit('render-process-gone')
    expect(handlers.get('maia:plugins:watchFile')(event, files[128]).error).toBeUndefined()
  })
  it('deduplicates watches and closes them on top-frame navigation', async () => {
    const { file, sender, event, handlers } = await pluginFixture()
    const watch = handlers.get('maia:plugins:watchFile')
    const first = watch(event, file)
    expect(watch(event, file)).toEqual(first)
    sender.emit('did-start-navigation', {}, 'synthetic', false, true)
    expect(watch(event, file).id).not.toBe(first.id)
    sender.emit('render-process-gone')
    expect(watch(event, file).id).not.toBe(first.id)
  })
})
