import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createHostConfig, updateMetaBlock, metaBlock, avatarResponse } = require('./host-config.cjs')
const { newToken } = require('./mcp/profile-tokens.cjs')

let root, home, app, dialog, client, host, serveAuth
function profile(name) { return name === 'default' ? home : path.join(home, 'profiles', name) }
function seed(name, text = 'ui_meta:\n  display_name: "Name # preserved"\n  color: "#aabbcc"\n') {
  fs.mkdirSync(profile(name), { recursive: true })
  fs.writeFileSync(path.join(profile(name), 'profile.yaml'), text)
  fs.writeFileSync(path.join(profile(name), 'config.yaml'), 'model: fake-model\n')
}
function build(extra = {}) {
  return createHostConfig({ userDataDir: app, hermesHome: home, serveClient: client, dialog, serveAuth, ...extra })
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-host-metadata-')))
  home = path.join(root, 'hermes'); app = path.join(root, 'app')
  fs.mkdirSync(home); fs.mkdirSync(app)
  seed('default'); seed('alpha'); seed('beta')
  dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }
  client = { call: vi.fn(async (method, params) => {
    if (method === 'profiles.list') return { profiles: ['alpha', 'beta'].map(name => ({ name })) }
    if (method === 'config.get') return { config: { approvals: { mode: 'manual' }, timezone: 'UTC', secret: 'obviously-fake-not-for-renderer' } }
    if (method === 'config.set') return { value: params.value }
  }) }
  serveAuth = { setProfileTimezone: vi.fn(async () => true) }
  host = build()
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('confirmed local profile metadata', () => {
  it('preserves YAML and scoped A→B→A metadata, confirms before writing, and makes private backups', async () => {
    const target = path.join(profile('alpha'), 'profile.yaml')
    const before = fs.readFileSync(target, 'utf8')
    dialog.showMessageBox.mockImplementationOnce(async () => {
      expect(fs.readFileSync(target, 'utf8')).toBe(before)
      return { response: 1 }
    })
    await host.setConfig({ agent: { profile: 'alpha', uiMeta: { display_name: 'Alpha updated' } } })
    expect(host.getAgentMeta('alpha')).toMatchObject({ name: 'Alpha updated', color: '#aabbcc' })
    expect(host.getAgentMeta('beta').name).toBe('Name # preserved')
    expect(host.getAgentMeta('alpha').name).toBe('Alpha updated')
    expect(fs.readFileSync(target, 'utf8')).toContain('  color: "#aabbcc"')
    const backup = fs.readdirSync(profile('alpha')).find(name => name.startsWith('profile.yaml.bak-hermesdesk-'))
    expect(fs.readFileSync(path.join(profile('alpha'), backup), 'utf8')).toBe(before)
    expect(fs.statSync(path.join(profile('alpha'), backup)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await host.getConfig())).not.toContain('obviously-fake-not-for-renderer')
  })
  it('refuses cancellation, changed files, symlinks and ambiguous YAML without a write', async () => {
    const target = path.join(profile('alpha'), 'profile.yaml')
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(host.setConfig({ agent: { profile: 'alpha', uiMeta: { display_name: 'Cancelled' } } })).rejects.toThrow('Cancelled')
    expect(host.getAgentMeta('alpha').name).toBe('Name # preserved')
    dialog.showMessageBox.mockImplementationOnce(async () => {
      fs.writeFileSync(target, 'ui_meta:\n  display_name: "External change"\n')
      return { response: 1 }
    })
    await expect(host.setConfig({ agent: { profile: 'alpha', uiMeta: { display_name: 'Stale' } } })).rejects.toThrow('changed')
    expect(host.getAgentMeta('alpha').name).toBe('External change')
    fs.unlinkSync(target); fs.symlinkSync(path.join(profile('beta'), 'profile.yaml'), target)
    await expect(host.setConfig({ agent: { profile: 'alpha', uiMeta: { display_name: 'Unsafe' } } })).rejects.toThrow()
    for (const text of ['ui_meta: {}\n', 'ui_meta:\n  display_name: *alias\n', 'ui_meta:\nui_meta:\n',
      '"ui_meta": {}\n', '<<: *alias\n', 'ui_meta:\n  display_name: |\n    multiline\n']) {
      expect(() => updateMetaBlock(text, { display_name: 'Refused' })).toThrow()
    }
    expect(metaBlock("ui_meta:\n  display_name: 'One # two' # comment\n").values.display_name).toBe('One # two')
  })
  it('scopes timezone and SOUL changes, validates before confirmation, and backs up both files', async () => {
    await expect(host.setConfig({ agent: { profile: 'alpha', timezone: 'Obviously/Invalid' } })).rejects.toThrow('IANA')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    await host.setConfig({ agent: { profile: 'alpha', timezone: 'Europe/London' } })
    expect(serveAuth.setProfileTimezone).toHaveBeenCalledExactlyOnceWith('alpha', 'Europe/London')
    expect(client.call).not.toHaveBeenCalledWith('config.set', expect.objectContaining({ key: 'timezone' }))
    fs.writeFileSync(path.join(profile('beta'), 'SOUL.md'), 'Original personality')
    await host.setProfileSoul('beta', 'New personality')
    expect(fs.readFileSync(path.join(profile('beta'), 'SOUL.md'), 'utf8')).toBe('New personality')
    expect(fs.existsSync(path.join(profile('alpha'), 'SOUL.md'))).toBe(false)
    expect(fs.readdirSync(profile('alpha')).some(name => name.startsWith('config.yaml.bak-hermesdesk-'))).toBe(true)
    expect(fs.readdirSync(profile('beta')).some(name => name.startsWith('SOUL.md.bak-hermesdesk-'))).toBe(true)
  })
  it('refuses an unavailable scoped time-zone adapter and never guesses the unsupported RPC', async () => {
    host = build({ serveAuth: null })
    await expect(host.setConfig({ agent: { profile: 'alpha', timezone: 'Europe/London' } })).rejects.toThrow('unavailable')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe('MCP migration and honest host summaries', () => {
  it('distinguishes tokenless, healthy and stale entries without comparing fresh proposal tokens or changing files on read', async () => {
    const socketDir = path.join(root, 'socket')
    const getEntry = profile => ({ command: process.execPath,
      args: [path.join(root, 'shim.cjs'), '--profile', profile, '--socket', path.join(socketDir, 'test.sock')],
      env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DESK_MCP_TOKEN: newToken() }, tools: {} })
    host = build({ getEntry })
    const target = path.join(profile('alpha'), 'config.yaml')
    fs.writeFileSync(target, 'mcp_servers:\n  hermes-desk:\n    command: "legacy"\n    env: {}\n')
    expect((await host.getConfig()).profiles.find(p => p.name === 'alpha').browsingSetup).toBe('tokenless')
    expect((await host.enableBrowserControl(['alpha'])).ok).toBe(true)
    const enabled = fs.readFileSync(target, 'utf8')
    const storedTokens = fs.readFileSync(path.join(socketDir, 'profile-tokens.json'), 'utf8')
    expect((await host.getConfig()).profiles.find(p => p.name === 'alpha').browsingSetup).toBe('ready')
    expect((await host.getConfig()).profiles.find(p => p.name === 'alpha').browsingSetup).toBe('ready')
    expect(fs.readFileSync(target, 'utf8')).toBe(enabled)
    expect(fs.readFileSync(path.join(socketDir, 'profile-tokens.json'), 'utf8')).toBe(storedTokens)
    fs.writeFileSync(target, enabled.replace('test.sock', 'stale.sock'))
    expect((await host.getConfig()).profiles.find(p => p.name === 'alpha').browsingSetup).toBe('stale')
  })
  it('reads a block-style legacy entry with a long blank stretch in linear time', async () => {
    host = build({ getEntry: () => ({ command: process.execPath, args: ['a', 'b', 'c', 'd', path.join(root, 'x.sock')] }) })
    const token = 'a'.repeat(64)
    fs.writeFileSync(path.join(profile('alpha'), 'config.yaml'),
      `mcp_servers:\n  hermes-desk:\n    command: "legacy"\n${'   \n'.repeat(40_000)}    env:\n      HERMES_DESK_MCP_TOKEN: ${token}\n`)
    const started = performance.now()
    const setup = (await host.getConfig()).profiles.find(p => p.name === 'alpha').browsingSetup
    expect(performance.now() - started).toBeLessThan(1000)
    expect(setup).toBe('stale')
  })
  it('uses all-source recent-session previews, normalizes timestamps and preserves refusal audit codes', async () => {
    client.call.mockImplementation(async method => method === 'profiles.list' ? { profiles: [
      { name: 'alpha', last_session: { source: 'cli', preview: 'Latest CLI work', last_active: 1700000000 } },
      { name: 'beta', last_session: { source: 'cron', preview: '', last_active: 1700000010 } },
    ] } : { sessions: [] })
    const summaries = await host.sidebarActivity()
    expect(summaries.alpha).toEqual({ preview: 'Latest CLI work', lastActivityAt: new Date(1700000000000).toISOString(), hasSessions: true })
    expect(summaries.beta.hasSessions).toBe(true)
    expect(client.call).toHaveBeenCalledWith('profiles.list', { include_sessions: true })
    expect(client.call).not.toHaveBeenCalledWith('session.list', expect.objectContaining({ source: 'desktop' }))
    fs.writeFileSync(path.join(app, 'audit.jsonl'), ['not_enabled', 'app_unavailable', 'resource_limit'].map(result =>
      JSON.stringify({ ts: '2026-10-06T00:00:00.000Z', action: 'browser_click', result })).join('\n'))
    expect(host.auditTail(5).map(row => row.result)).toEqual(['not_enabled', 'app_unavailable', 'resource_limit'])
  })
  it('reports a still-connecting serve as not ready instead of failing the IPC call', async () => {
    client.call.mockRejectedValueOnce(Object.assign(new Error('Hermes serve offline'), { code: 'disconnected' }))
    await expect(host.sidebarActivity()).resolves.toBeNull()
    client.call.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'internal' }))
    await expect(host.sidebarActivity()).rejects.toThrow('boom')
  })
})

describe('scoped avatar responses', () => {
  it('serves A→B→A images only via a profile identifier, never a renderer path', async () => {
    for (const name of ['alpha', 'beta']) {
      fs.writeFileSync(path.join(profile(name), 'avatar.png'), `fake-image-${name}`)
      fs.writeFileSync(path.join(profile(name), 'profile.yaml'), 'ui_meta:\n  avatar: "avatar.png"\n')
    }
    for (const name of ['alpha', 'beta', 'alpha']) {
      const response = await avatarResponse(home, `hd-avatar://${name}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(await response.text()).toBe(`fake-image-${name}`)
    }
  })
  it('refuses traversal, SVG, symlinks, oversized files and arbitrary protocol paths', async () => {
    const target = path.join(profile('alpha'), 'profile.yaml')
    for (const url of ['hd-avatar://alpha/avatar.png', 'hd-avatar://alpha:123/', 'hd-avatar://alpha/?path=/fake',
      'hd-avatar://user@alpha/', 'file:///fake/avatar.png']) expect((await avatarResponse(home, url)).status).toBe(404)
    fs.writeFileSync(path.join(root, 'outside.png'), 'private fake data')
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(profile('alpha'), 'link.png'))
    for (const avatar of ['../../outside.png', 'link.png', 'avatar.svg', 'big.png']) {
      fs.writeFileSync(target, `ui_meta:\n  avatar: ${JSON.stringify(avatar)}\n`)
      if (avatar === 'avatar.svg') fs.writeFileSync(path.join(profile('alpha'), avatar), '<svg/>')
      if (avatar === 'big.png') fs.writeFileSync(path.join(profile('alpha'), avatar), Buffer.alloc(5 * 1024 * 1024 + 1))
      expect((await avatarResponse(home, 'hd-avatar://alpha/')).status).toBe(404)
    }
  })
})

describe('ui_meta block parsing cost', () => {
  it('keeps the block contract and stays linear on padded or blank-heavy profiles', () => {
    const blank = '\n'.repeat(60_000)
    const padded = ' '.repeat(60_000)
    const text = [
      'name: alpha',
      `notes: a${padded}b`,
      'ui_meta:',
      `  display_name: "Scout"${padded}# trailing comment`,
      `  color: teal${padded}b`,
      `  role: lead ${padded}# role note\r`,
      blank,
    ].join('\n')
    const started = performance.now()
    const block = metaBlock(text)
    const updated = updateMetaBlock(text, { display_name: 'Renamed' })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(block.values.display_name).toBe('Scout')
    expect(block.values.color).toBe(`teal${padded}b`)
    expect(block.values.role).toBe('lead')
    expect(updated.endsWith('\n')).toBe(true)
    expect(updated.endsWith('\n\n')).toBe(false)
    expect(updated).toContain('  display_name: "Renamed"')
    expect(() => metaBlock(`${'\n'.repeat(60_000)}  \tkey: x\n`)).toThrow('Unsupported profile YAML')
  })
})
