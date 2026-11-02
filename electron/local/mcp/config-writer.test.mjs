import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { planEnable, planDisable, apply } = require('./config-writer.cjs')
const { createProfileTokens } = require('./profile-tokens.cjs')
const { load } = require('js-yaml')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture(before, profile = 'default') {
  const hermesHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-mcp-config-')))
  roots.push(hermesHome)
  const file = profile === 'default' ? path.join(hermesHome, 'config.yaml')
    : path.join(hermesHome, 'profiles', profile, 'config.yaml')
  if (before !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, before, { mode: 0o600 })
  }
  const entry = { command: '/Applications/Hermes Desk.app/Contents/MacOS/Hermes Desk',
    args: ['/Applications/Hermes Desk.app/Contents/Resources/app.asar.unpacked/electron/local/mcp/shim/hermes-desk-mcp.cjs',
      '--profile', profile, '--socket', path.join(hermesHome, 'mcp/hermes-desk.sock')],
    env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DESK_MCP_TOKEN: 'a'.repeat(64) }, tools: {} }
  return { hermesHome, profile, entry, file }
}

describe('MCP profile config plans', () => {
  it('makes a pure preview, preserves unrelated bytes and installs the exact accepted entry', () => {
    const before = '# personal comment\nmodel: "obviously-fake-model" # keep quotes\n' +
      'mcp_servers:\n  other:\n    command: /fake/other # keep other MCP\n    tools: {}\n' +
      '# agent notes\nagent:\n  max_iterations: 23 # keep setting\n  disabled_toolsets:\n    - terminal # disabled by owner\n' +
      'prompt: |\n  agent:\n    disabled_toolsets: [browser]\n'
    const options = fixture(before)
    const plan = planEnable(options)
    expect(fs.readFileSync(options.file, 'utf8')).toBe(before)
    expect(plan.before).toBe(before)
    expect(load(plan.after).mcp_servers['hermes-desk']).toEqual(options.entry)
    expect(load(plan.after).agent.disabled_toolsets).toEqual(['terminal', 'browser'])
    for (const line of before.split('\n')) expect(plan.after).toContain(line)
    expect(plan.diff).toContain('+    tools: {}')
    expect(plan.diff).not.toContain('tools: all')
  })

  it.each(['[terminal, "memory"]', 'terminal', '"[\'terminal\', \'memory\']"', 'null', '~', '[]'])(
    'restores an existing scalar or flow list exactly: %s', value => {
      const before = `# keep\nagent:\n  disabled_toolsets: ${value} # private preference\n  max_iterations: 7\n`
      const options = fixture(before)
      const enabled = planEnable(options)
      expect(load(enabled.after).agent.disabled_toolsets).toContain('browser')
      apply(enabled)
      const disabled = planDisable(options)
      expect(disabled.after).toBe(before)
    })

  it('supports indentless block lists, preserving item comments through undo', () => {
    const before = 'agent:\n  disabled_toolsets:\n  - terminal # keep\n  # useful comment\n  - memory\n  max_iterations: 5\n'
    const options = fixture(before)
    const enabled = planEnable(options)
    expect(load(enabled.after).agent.disabled_toolsets).toEqual(['terminal', 'memory', 'browser'])
    apply(enabled)
    expect(planDisable(options).after).toBe(before)
  })

  it('adds siblings at the existing indentation, including quoted parent keys', () => {
    const before = '"agent":\n    max_iterations: 5\nmcp_servers:\n    other:\n        command: /fake/other\n'
    const options = fixture(before)
    const enabled = planEnable(options)
    expect(load(enabled.after).agent.disabled_toolsets).toEqual(['browser'])
    expect(load(enabled.after).mcp_servers.other.command).toBe('/fake/other')
    apply(enabled)
    expect(planDisable(options).after).toBe(before)
  })

  it('does not undo browser disables that predate Hermes Desk', () => {
    const before = 'agent:\n  disabled_toolsets: [browser, terminal] # owner decision\n'
    const options = fixture(before)
    apply(planEnable(options))
    expect(planDisable(options).after).toBe(before)
  })

  it('rotates a reused credential on re-enable and can leave the built-in browser enabled', () => {
    const options = fixture('agent:\n  max_iterations: 8\n')
    const first = planEnable({ ...options, disableBuiltinBrowser: false })
    apply(first)
    const second = planEnable({ ...options, disableBuiltinBrowser: false })
    expect(second.after).not.toBe(first.after)
    expect(second.diff).toContain('[redacted]')
    expect(load(first.after).agent.disabled_toolsets).toBeUndefined()
    expect(apply(second).changed).toBe(true)
  })

  it('replaces only the named server and keeps comments inside the replaced entry', () => {
    const options = fixture('mcp_servers:\n  hermes-desk: # route notes\n    # launcher notes\n' +
      '    command: /fake/old # old executable note\n    tools: all\n  other: {command: /fake/other}\n')
    const enabled = planEnable(options)
    expect(enabled.after).toContain('# launcher notes')
    expect(enabled.after).toContain('# old executable note')
    expect(load(enabled.after).mcp_servers.other).toEqual({ command: '/fake/other' })
    expect(load(enabled.after).mcp_servers['hermes-desk']).toEqual(options.entry)
    apply(enabled)
    expect(load(planDisable(options).after).mcp_servers['hermes-desk']).toBeUndefined()
    expect(planDisable(options).after).toContain('# route notes')
  })

  it('preserves CRLF and the absence of a final newline', () => {
    const before = 'model: "fake"\r\nagent:\r\n  max_iterations: 8'
    const options = fixture(before)
    const enabled = planEnable(options)
    expect(enabled.after.replaceAll('\r\n', '')).not.toContain('\n')
    expect(enabled.after.endsWith('\n')).toBe(false)
    apply(enabled)
    expect(planDisable(options).after).toBe(before)
  })

  it('resolves named profiles and creates missing configs privately, with no default-profile write', () => {
    const options = fixture(null, 'spike-alpha')
    const enabled = planEnable(options)
    expect(enabled.path).toBe(options.file)
    expect(enabled.before).toBeNull()
    const result = apply(enabled)
    expect(result.backupPath).toBeNull()
    expect(fs.statSync(options.file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(options.hermesHome, 'config.yaml'))).toBe(false)
    expect(load(enabled.after).mcp_servers['hermes-desk'].args[2]).toBe('spike-alpha')
  })

  it.each([
    'mcp_servers: {other: {command: /fake}}\n',
    'mcp_servers: *shared\n',
    'agent:\n  <<: *shared\n',
    'agent:\n  disabled_toolsets: *shared\n',
    'mcp_servers: {}\nmcp_servers: {}\n',
    'agent:\n  disabled_toolsets: []\n  disabled_toolsets: []\n',
    '---\nagent: {}\n',
    'agent:\n\tdisabled_toolsets: []\n',
  ])('refuses ambiguous YAML without changing it: %s', before => {
    const options = fixture(before)
    expect(() => planEnable(options)).toThrow()
    expect(fs.readFileSync(options.file, 'utf8')).toBe(before)
  })

  it('refuses to undo a flow list changed since enable', () => {
    const options = fixture('agent:\n  disabled_toolsets: [terminal]\n')
    const enabled = planEnable(options)
    fs.writeFileSync(options.file, enabled.after.replace('["terminal","browser"]', '["memory","browser"]'))
    expect(() => planDisable(options)).toThrow('changed since enable')
  })

  it('keeps newly added user preferences when undoing a block list', () => {
    const options = fixture('agent:\n  max_iterations: 8\n')
    const enabled = planEnable(options)
    fs.writeFileSync(options.file, enabled.after.replace('- browser #', '- terminal\n    - browser #'))
    expect(load(planDisable(options).after).agent.disabled_toolsets).toEqual(['terminal'])
  })

  it('backs up exact bytes, preserves permissions and refuses stale previews', () => {
    const options = fixture('# original\nmodel: fake\n')
    fs.chmodSync(options.file, 0o640)
    const enabled = planEnable(options)
    const result = apply(enabled, { backup: true })
    expect(result.backupPath).toMatch(/config\.yaml\.bak-hermesdesk-/)
    expect(fs.readFileSync(result.backupPath, 'utf8')).toBe(enabled.before)
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(options.file).mode & 0o777).toBe(0o640)
    expect(() => apply(enabled)).toThrow('changed since the preview')
    expect(fs.readdirSync(path.dirname(options.file)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('refuses traversal, entry/profile mismatch, tools: all and symlinked targets', () => {
    const options = fixture('model: fake\n')
    expect(() => planEnable({ ...options, profile: '../real-profile' })).toThrow()
    expect(() => planEnable({ ...options, entry: { ...options.entry, tools: 'all' } })).toThrow()
    expect(() => planEnable({ ...options, entry: { ...options.entry, tools: true } })).toThrow()
    expect(() => planEnable({ ...options, entry: { ...options.entry, args: ['-e', 'fake'] } })).toThrow()
    const link = path.join(options.hermesHome, 'profiles', 'linked')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(options.hermesHome, link)
    expect(() => planDisable({ ...options, profile: 'linked' })).toThrow('symlinked')
  })

  it('does not create a config when disabling a missing installation', () => {
    const options = fixture(null)
    const disabled = planDisable(options)
    expect(disabled.diff).toBe('')
    expect(disabled.after).toBe('')
    expect(apply(disabled).changed).toBe(false)
    expect(fs.existsSync(options.file)).toBe(false)
  })

  it('HD-06 generates a token-bearing legacy plan without persisting preview authority or exposing tokens in its diff', () => {
    const options = fixture('model: fake\n')
    delete options.entry.env.HERMES_DESK_MCP_TOKEN
    const store = createProfileTokens(path.dirname(options.entry.args[4]))
    const plan = planEnable(options)
    const token = load(plan.after).mcp_servers['hermes-desk'].env.HERMES_DESK_MCP_TOKEN
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.diff).not.toContain(token)
    expect(plan.diff).toContain('[redacted]')
    expect(store.verify('default', token)).toBe(false)
    expect(fs.existsSync(store.file)).toBe(false)
    apply(plan)
    expect(store.verify('default', token)).toBe(true)
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700)
    const removal = planDisable(options)
    expect(removal.diff).not.toContain(token)
    expect(store.verify('default', token)).toBe(true)
    apply(removal)
    expect(store.verify('default', token)).toBe(false)
    expect(fs.readFileSync(store.file, 'utf8')).not.toContain(token)
  })

  it('HD-06 rejects malformed tokens without writing a config or authority', () => {
    const options = fixture('model: fake\n')
    for (const token of ['', 'not-a-token', 'f'.repeat(65), 42]) {
      expect(() => planEnable({ ...options, entry: { ...options.entry,
        env: { ...options.entry.env, HERMES_DESK_MCP_TOKEN: token } } })).toThrow()
    }
    expect(fs.readFileSync(options.file, 'utf8')).toBe('model: fake\n')
    expect(fs.existsSync(path.join(options.hermesHome, 'mcp'))).toBe(false)
  })

  it('HD-06 does not revoke existing credentials on rejected or stale previews', () => {
    const options = fixture('model: fake\n')
    apply(planEnable(options))
    const store = createProfileTokens(path.dirname(options.entry.args[4]))
    const original = options.entry.env.HERMES_DESK_MCP_TOKEN
    const rotation = planEnable(options)
    const next = load(rotation.after).mcp_servers['hermes-desk'].env.HERMES_DESK_MCP_TOKEN
    expect(store.verify('default', original)).toBe(true)
    expect(store.verify('default', next)).toBe(false)
    fs.appendFileSync(options.file, '# owner changed config\n')
    expect(() => apply(rotation)).toThrow('changed since the preview')
    expect(store.verify('default', original)).toBe(true)
    expect(store.verify('default', next)).toBe(false)
  })

  it('refuses indentation tabs after blank stretches and plans blank-heavy configs in linear time', () => {
    const tabbed = fixture(`model: x${'\n'.repeat(30_000)}  \tagent: {}\n`)
    expect(() => planEnable(tabbed)).toThrow('Cannot safely edit tabs')
    const before = `model: x\n${' \n'.repeat(60_000)}agent:\n  max_iterations: 1\n`
    const options = fixture(before)
    const started = performance.now()
    const plan = planEnable(options)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(load(plan.after).mcp_servers['hermes-desk']).toEqual(options.entry)
  })
})
