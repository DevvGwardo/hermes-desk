import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHostConfig, safeText } = require('./host-config.cjs')
const yaml = require('js-yaml')

let root, home, userData, dialog, client, host, writer, getEntry
const config = '# keep this comment\nmodel: fake-model\nbrowser:\n  allow_private_urls: true # preserve\n  extension_control:\n    enabled: false # enable this\n    developer_mode: true # never allow dev\nmemory:\n  enabled: true\n'

function seed(profile = 'default', text = config) {
  const dir = profile === 'default' ? home : path.join(home, 'profiles', profile)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.yaml')
  fs.writeFileSync(file, text)
  return file
}

function fakeWriter() {
  const plan = (profile, entry) => {
    const file = path.join(profile === 'default' ? home : path.join(home, 'profiles', profile), 'config.yaml')
    const before = fs.readFileSync(file, 'utf8')
    const previous = before.match(/# fake MCP entry start\n[\s\S]*?# fake MCP entry end\n/)?.[0] || ''
    const block = entry ? `# fake MCP entry start\n${yaml.dump({ mcp_servers: { 'hermes-desk': entry } })}# fake MCP entry end\n` : ''
    const after = before.replace(previous, '') + block
    const diff = before === after ? '' : `--- ${file}\n+++ ${file}\n${previous.split('\n').filter(Boolean).map((line) => `-${line}`).join('\n')}\n${block.split('\n').filter(Boolean).map((line) => `+${line}`).join('\n')}`
    return { path: file, before, after, diff }
  }
  return {
    planEnable: vi.fn(({ profile, entry }) => plan(profile, entry)),
    planDisable: vi.fn(({ profile }) => plan(profile)),
    apply: vi.fn((plan, { backup }) => {
      if (fs.readFileSync(plan.path, 'utf8') !== plan.before) throw new Error('Stale plan')
      const backupPath = `${plan.path}.bak-hermesdesk-${Date.now()}-${Math.random()}`
      if (backup) fs.writeFileSync(backupPath, plan.before, { flag: 'wx', mode: 0o600 })
      fs.writeFileSync(plan.path, plan.after)
      return { backupPath }
    }),
  }
}

function buildHost(extra = {}) {
  return createHostConfig({
    userDataDir: userData, hermesHome: home, serveClient: client, dialog, getMainWindow: () => null,
    getEntry, loadConfigWriter: () => writer, ...extra,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermesdesk-settings-test-'))
  home = path.join(root, 'hermes-home')
  userData = path.join(root, 'app-data')
  fs.mkdirSync(home); fs.mkdirSync(userData)
  vi.stubEnv('HERMES_HOME', home)
  dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }
  client = { call: vi.fn(async (method, params) => {
    if (method === 'profiles.list') return { profiles: [{ name: 'default', model: 'fake-model', ui_meta: { display_name: 'Fake Hermes' } }] }
    if (method === 'config.get') return { config: { approvals: { mode: 'manual' }, timezone: 'UTC', token: 'obviously-fake-secret' } }
    if (method === 'config.set') return { key: params.key, value: params.value }
  }) }
  writer = fakeWriter()
  getEntry = vi.fn((profile) => ({
    command: '/tmp/obviously-fake-electron', args: ['/tmp/obviously-fake-shim.cjs', '--profile', profile, '--socket', '/tmp/obviously-fake.sock'],
    env: { ELECTRON_RUN_AS_NODE: '1' }, tools: {},
  }))
  host = buildHost()
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

describe('app settings and scoped local serve config', () => {
  it('persists partial patches in app settings only and returns secret-free profile metadata', async () => {
    const original = seed()
    const result = await host.setConfig({ workspace: { maxTabsPerAgent: 4, profiles: { default: { allow: ['Example.invalid'], deny: ['blocked.invalid'] } } }, computer: { placement: 'floating' } })
    expect(result.hermesHome).toBe(home)
    expect(result.workspace.maxTabsPerAgent).toBe(4)
    expect(result.workspace.maxLiveViews).toBe(20)
    expect(result.workspace.enabledProfiles).toEqual([])
    expect(result.workspace.profiles.default.allow).toEqual(['example.invalid'])
    expect(result.profiles[0]).toMatchObject({ name: 'default', approvalMode: 'manual', timezone: 'UTC' })
    expect(JSON.stringify(result)).not.toContain('obviously-fake-secret')
    expect(fs.readFileSync(original, 'utf8')).toBe(config)
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
    expect(stored).not.toHaveProperty('profiles')
    expect(fs.statSync(path.join(userData, 'settings.json')).mode & 0o777).toBe(0o600)
    const fresh = createHostConfig({ userDataDir: userData, hermesHome: home })
    expect((await fresh.getConfig()).computer.placement).toBe('floating')
  })
  it('rejects unknown keys, unsafe policies and out-of-range settings without persisting', async () => {
    for (const patch of [{ token: 'obviously-fake' }, { serve: { port: 8642 } }, { serve: { port: 9119 } },
      { workspace: { maxLiveViews: 21 } },
      { workspace: { downloadsDir: '../outside' } }, { workspace: { profiles: { '../outside': { deny: [] } } } },
      { workspace: { profiles: { default: { allow: ['https://example.invalid'] } } } },
      JSON.parse('{"workspace":{"profiles":{"__proto__":{"allow":[]}}}}'), { computer: { source: 'live' } }]) {
      await expect(host.setConfig(patch)).rejects.toThrow()
    }
    expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(false)
  })
  it('preserves a corrupt settings file rather than overwriting it', async () => {
    const file = path.join(userData, 'settings.json')
    fs.writeFileSync(file, '{broken')
    await expect(host.setConfig({ serve: { port: 9188 } })).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
  })
  it('writes approvals through the exact profile-scoped RPC, never a restart or app-only preference', async () => {
    seed('spike-alpha'); seed('spike-beta')
    await host.setConfig({ agent: { profile: 'spike-alpha', approvalMode: 'smart' } })
    expect(client.call).toHaveBeenCalledWith('config.set', { profile: 'spike-alpha', key: 'approvals.mode', value: 'smart' })
    expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(false)
    client.call.mockRejectedValueOnce(new Error('offline'))
    await expect(host.setConfig({ agent: { profile: 'spike-beta', approvalMode: 'off' } })).rejects.toThrow('offline')
  })
  it('edits ui_meta display_name beside a nested mapping a plugin wrote, preserving it verbatim', async () => {
    // Regression: the hermes-bots desktop plugin writes a nested `ui_meta.hermes-bots`
    // mapping. The narrow editor must parse the flat keys around it without throwing
    // 'Ambiguous ui_meta; edit manually', and must leave the nested block untouched.
    seed('spike-meta')
    const target = path.join(home, 'profiles', 'spike-meta', 'profile.yaml')
    const before = 'description: hi\nui_meta:\n  hermes-bots:\n    shape: circle\n    color: "#f97316"\n    orchestrator: true\n'
    fs.writeFileSync(target, before)
    await host.setConfig({ agent: { profile: 'spike-meta', uiMeta: { display_name: 'Meta' } } })
    const after = fs.readFileSync(target, 'utf8')
    const parsed = yaml.load(after)
    expect(parsed.ui_meta.display_name).toBe('Meta')
    expect(parsed.ui_meta['hermes-bots']).toEqual({ shape: 'circle', color: '#f97316', orchestrator: true })
    expect(after).toContain('description: hi')
  })
})

describe('explicit native MCP browsing changes', () => {
  it('bounds a large native diff preview without losing the full diff, backups or cancellation', async () => {
    const text = `agent:\n  max_iterations: 30\nmetadata:\n${Array.from({ length: 250 }, (_, i) => `  setting_${i}: unchanged_${i}\n`).join('')}`
    const file = seed('spike-large', text)
    const realWriter = require('./mcp/config-writer.cjs')
    const scopedHost = buildHost({
      hermesHome: fs.realpathSync(home),
      loadConfigWriter: () => realWriter,
      getEntry: profile => ({ ...getEntry(profile),
        args: ['/tmp/obviously-fake-shim.cjs', '--profile', profile, '--socket', path.join(root, 'mcp', 'desk.sock')] }),
    })
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const cancelled = await scopedHost.enableBrowserControl(['spike-large'])
    expect(cancelled).toMatchObject({ ok: false, cancelled: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect((await scopedHost.getConfig()).workspace.enabledProfiles).toEqual([])
    const options = dialog.showMessageBox.mock.calls[0][0]
    expect(options.detail.length).toBeLessThan(2500)
    expect(options.detail.split('\n').length).toBeLessThan(30)
    expect(options.detail).toContain('spike-large')
    expect(options.detail).toContain('abbreviated')
    expect(options.detail).toContain('workspace.enabledProfiles')
    expect(cancelled.diff).toContain('unchanged_249')
    const enabled = await scopedHost.enableBrowserControl(['spike-large'])
    expect(enabled.ok).toBe(true)
    expect(enabled.diff).toContain('unchanged_249')
    expect(fs.readFileSync(enabled.backups[0].backupPath, 'utf8')).toBe(text)
    expect((await scopedHost.getConfig()).workspace.enabledProfiles).toEqual(['spike-large'])
  })
  it('confirms the MCP and app-gate diffs, delegates entry installation/backups and never changes native browser flags', async () => {
    const files = [seed(), seed('spike-alpha')]
    const result = await host.enableBrowserControl(['default', 'spike-alpha'])
    expect(result.ok).toBe(true)
    expect(result.backups).toHaveLength(2)
    const options = dialog.showMessageBox.mock.calls[0][0]
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.detail).toContain('+  hermes-desk:')
    expect(options.detail).toContain('workspace.enabledProfiles')
    expect(options.detail).toContain('Restart each affected agent')
    expect(options.detail).not.toContain('fake-model')
    for (const [i, file] of files.entries()) {
      const next = fs.readFileSync(file, 'utf8')
      expect(yaml.load(next).browser.extension_control).toEqual(yaml.load(config).browser.extension_control)
      expect(yaml.load(next).mcp_servers['hermes-desk']).toEqual(getEntry(result.profiles[i]))
      expect(next).toContain('# keep this comment')
      expect(next).toContain('allow_private_urls: true # preserve')
      expect(next).toContain('memory:\n  enabled: true')
      expect(fs.readFileSync(result.backups[i].backupPath, 'utf8')).toBe(config)
      expect(result.backups[i].backupPath).toContain('config.yaml.bak-hermesdesk-')
    }
    expect(writer.planEnable).toHaveBeenCalledWith({ hermesHome: home, profile: 'spike-alpha', entry: getEntry('spike-alpha'), disableBuiltinBrowser: true })
    expect(writer.apply).toHaveBeenCalledWith(expect.anything(), { backup: true })
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual(['default', 'spike-alpha'])
    const again = await host.enableBrowserControl(['default'])
    expect(again.ok).toBe(true); expect(again.diff).toBe('')
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })
  it('does not change the gate/configs when cancelled, confirmation is missing, or any profile is invalid', async () => {
    const file = seed()
    dialog.showMessageBox.mockResolvedValue({ response: 0 })
    expect(await host.enableBrowserControl(['default'])).toMatchObject({ ok: false, cancelled: true })
    const noDialog = buildHost({ dialog: null })
    expect((await noDialog.enableBrowserControl(['default'])).ok).toBe(false)
    expect((await host.enableBrowserControl(['../outside'])).ok).toBe(false)
    expect((await host.enableBrowserControl(['default', 'missing'])).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(config)
    expect(fs.readdirSync(home)).toEqual(['config.yaml'])
    expect(writer.apply).not.toHaveBeenCalled()
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual([])
  })
  it('refuses symlinks and configs changed while the user reads the confirmation', async () => {
    const file = seed()
    dialog.showMessageBox.mockImplementation(async () => {
      fs.writeFileSync(file, '# changed by user\n' + config)
      return { response: 1 }
    })
    expect((await host.enableBrowserControl(['default'])).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toContain('# changed by user')
    fs.unlinkSync(file)
    const outside = path.join(root, 'outside.yaml')
    fs.writeFileSync(outside, config)
    fs.symlinkSync(outside, file)
    expect((await host.enableBrowserControl(['default'])).ok).toBe(false)
    expect(fs.readFileSync(outside, 'utf8')).toBe(config)
  })
  it('removes MCP configuration and the selected gate membership symmetrically, retaining other enabled agents', async () => {
    const files = [seed(), seed('spike-alpha')]
    await host.enableBrowserControl(['default', 'spike-alpha'])
    const enabled = fs.readFileSync(files[1], 'utf8')
    const result = await host.disableBrowserControl(['spike-alpha'])
    expect(result.ok).toBe(true)
    expect(writer.planDisable).toHaveBeenCalledWith({ hermesHome: home, profile: 'spike-alpha' })
    expect(result.diff).toContain('-  hermes-desk:')
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual(['default'])
    expect(fs.readFileSync(files[1], 'utf8')).toBe(config)
    expect(fs.readFileSync(result.backups[0].backupPath, 'utf8')).toBe(enabled)
    expect(fs.readFileSync(files[0], 'utf8')).toContain('hermes-desk:')
    expect(dialog.showMessageBox.mock.calls[1][0].buttons).toEqual(['Cancel', 'Disable browsing'])
  })
  it('keeps enabled configs and permission when disabling is cancelled', async () => {
    const file = seed()
    await host.enableBrowserControl(['default'])
    const before = fs.readFileSync(file, 'utf8')
    dialog.showMessageBox.mockResolvedValue({ response: 0 })
    expect(await host.disableBrowserControl(['default'])).toMatchObject({ ok: false, cancelled: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual(['default'])
  })
  it('fails clearly without a loaded writer or entry dependency and never falls back to native flag edits', async () => {
    const file = seed()
    const noWriter = buildHost({ loadConfigWriter: () => { throw new Error('missing module') } })
    expect(await noWriter.enableBrowserControl(['default'])).toMatchObject({ ok: false, error: expect.stringContaining('not available') })
    expect(await noWriter.disableBrowserControl(['default'])).toMatchObject({ ok: false, error: expect.stringContaining('not available') })
    const noEntry = buildHost({ getEntry: null })
    expect(await noEntry.enableBrowserControl(['default'])).toMatchObject({ ok: false, error: expect.stringContaining('entry is not available') })
    expect(fs.readFileSync(file, 'utf8')).toBe(config)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual([])
  })
  it('never adds browsing permission after a failed writer, and revokes it before removing a config', async () => {
    seed()
    writer.apply.mockImplementationOnce(() => { throw new Error('failed') })
    expect((await host.enableBrowserControl(['default'])).ok).toBe(false)
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual([])
    await host.enableBrowserControl(['default'])
    writer.apply.mockImplementationOnce(() => {
      const stored = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
      expect(stored.workspace.enabledProfiles).toEqual([])
      throw new Error('failed removal')
    })
    const result = await host.disableBrowserControl(['default'])
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('permission was disabled') })
    expect((await host.getConfig()).workspace.enabledProfiles).toEqual([])
  })
  it('does not trust a writer success response unless the planned config actually landed', async () => {
    const file = seed()
    writer.apply.mockReturnValueOnce({ changed: true })
    expect((await host.enableBrowserControl(['default'])).ok).toBe(false)
    expect(host.getAppConfig().workspace.enabledProfiles).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(config)
  })
  it('preserves unrelated settings changed during native confirmation and rejects ungated enabledProfiles patches', async () => {
    seed()
    dialog.showMessageBox.mockImplementation(async () => {
      await host.setConfig({ computer: { placement: 'floating' } })
      return { response: 1 }
    })
    await host.enableBrowserControl(['default', 'default'])
    const config = await host.getConfig()
    expect(config.computer.placement).toBe('floating')
    expect(config.workspace.enabledProfiles).toEqual(['default'])
    await expect(host.setConfig({ workspace: { enabledProfiles: ['spike-alpha'] } })).rejects.toThrow('confirm profile browsing')
    expect(host.getAppConfig().workspace.enabledProfiles).toEqual(['default'])
    expect(host.getAppConfig()).not.toHaveProperty('then')
  })
  it('serializes competing enable/disable confirmations and does not add permission on stale plans', async () => {
    const file = seed()
    let confirm
    dialog.showMessageBox.mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
    const enabling = host.enableBrowserControl(['default'])
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalled())
    expect(await host.disableBrowserControl(['default'])).toMatchObject({ ok: false, error: expect.stringContaining('already open') })
    fs.writeFileSync(file, config + '# updated during confirmation\n')
    confirm({ response: 1 })
    expect((await enabling).ok).toBe(false)
    expect(host.getAppConfig().workspace.enabledProfiles).toEqual([])
    expect(writer.apply).not.toHaveBeenCalled()
  })
})

describe('bounded metadata-only audit tail', () => {
  const entry = (action) => ({ ts: '2026-10-06T12:00:00.000Z', agent: 'spike-alpha', lane: 'profile:spike-alpha',
    tab: 't_a', action, origin: 'https://example.invalid/path?token=obviously-fake', result: 'ok', durationMs: 4, rawText: 'obviously-fake-secret' })
  it('reads rotations in order and drops malformed lines, query strings, and unexpected payloads', () => {
    fs.writeFileSync(path.join(userData, 'audit.jsonl.1'), JSON.stringify(entry('browser_snapshot')) + '\n')
    fs.writeFileSync(path.join(userData, 'audit.jsonl'), 'broken\n' + JSON.stringify(entry('browser_click')) + '\n')
    const result = host.auditTail(2)
    expect(result.map((item) => item.action)).toEqual(['browser_snapshot', 'browser_click'])
    expect(result[0].origin).toBe('https://example.invalid')
    expect(JSON.stringify(result)).not.toContain('obviously-fake')
    expect(host.auditTail(1)).toHaveLength(1)
    expect(() => host.auditTail(1001)).toThrow()
  })
  it('returns an empty missing log and refuses a symlinked log', () => {
    expect(host.auditTail()).toEqual([])
    const outside = path.join(root, 'outside.log')
    fs.writeFileSync(outside, JSON.stringify(entry('browser_click')))
    fs.symlinkSync(outside, path.join(userData, 'audit.jsonl'))
    expect(() => host.auditTail()).toThrow('Audit log unavailable')
  })
  it('redacts complete PEM blocks without revealing their body', () => {
    const marker = '-'.repeat(5)
    const label = ['FAKE', 'PRIVATE', 'KEY'].join(' ')
    const pem = `${marker}BEGIN ${label}${marker}\nobviously-fake-key\n${marker}END ${label}${marker}`
    expect(safeText(pem)).toBe('[secret]')
  })
  it('redacts key/value credentials in linear time on whitespace after a keyword', () => {
    const key = ['pass', 'word'].join('')
    expect(safeText(`${key} " = FAKE-value`)).toBe(`${key} " = [secret]`)
    const padded = `token${' \n'.repeat(30_000)}!`
    const started = performance.now()
    expect(safeText(padded)).toBe(padded)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
