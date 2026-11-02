import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as preview from './build-completion-preview.mjs'

const { test, afterEach } = await import(process.env.VITEST ? 'vitest' : 'node:test')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const config = {
  appId: 'com.devgwardo.hermesdesk', productName: 'Hermes Desk', directories: { output: 'release' },
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!electron/**/*.test.*', '!**/node_modules/**'],
  asarUnpack: ['**/*.node', 'electron/local/mcp/shim/hermes-desk-mcp.cjs'],
  mac: { target: [{ target: 'dir', arch: ['arm64'] }], identity: null, hardenedRuntime: true,
    gatekeeperAssess: false, entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist', notarize: false },
}
const entitlements = '<key>com.apple.security.cs.allow-jit</key><true/>' +
  '<key>com.apple.security.cs.disable-library-validation</key><true/>'

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hd-preview-privacy-test-'))
  roots.push(base)
  const root = path.join(base, 'repo'), workspace = path.join(base, 'hd-completion-preview-fixture')
  const electronDist = path.join(base, 'installed-runtime')
  for (const dir of ['src', 'electron', 'public', 'build', 'release/mac-arm64/Hermes Desk.app/Contents/Resources']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 })
  }
  fs.mkdirSync(workspace, { mode: 0o700 })
  fs.mkdirSync(path.join(electronDist, 'Electron.app'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules'))
  const builderCli = path.join(root, 'node_modules/fake-builder.js'), viteCli = path.join(root, 'node_modules/fake-vite.js')
  fs.writeFileSync(builderCli, '')
  fs.writeFileSync(viteCli, '')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ build: config }))
  fs.writeFileSync(path.join(root, 'index.html'), 'fixture entry')
  fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}')
  fs.writeFileSync(path.join(root, 'electron/main.cjs'), 'fixture main source')
  fs.writeFileSync(path.join(root, 'electron/auth.cjs'), 'fixture auth source')
  fs.writeFileSync(path.join(root, 'src/security.tsx'), 'fixture security source')
  fs.writeFileSync(path.join(root, 'public/mark.svg'), '<svg/>')
  fs.writeFileSync(path.join(root, 'build/entitlements.mac.plist'), entitlements)
  const plan = preview.createPreviewPlan({ root, workspace, buildConfig: config, electronDist,
    electronVersion: '37.10.3', builderCli, viteCli, originalSha256: hash('fixture original'),
    approvedViteConfigSha256: hash('export default {}') })
  fs.writeFileSync(plan.originalArchive, 'fixture original')
  const calls = []
  const run = (command, options) => {
    calls.push({ label: command.label, env: options.env })
    if (command.label === 'renderer') {
      fs.mkdirSync(plan.renderer)
      fs.writeFileSync(path.join(plan.renderer, 'index.html'), 'fixture renderer')
    }
    if (command.label === 'package') {
      fs.mkdirSync(path.join(plan.bundle, 'Contents/Resources'), { recursive: true })
      fs.writeFileSync(path.join(plan.bundle, 'Contents/Resources/app.asar'), 'fixture package')
    }
    if (command.label === 'signature') return 'Signature=adhoc\nflags=0x10000(runtime)'
    if (command.label === 'entitlements') return entitlements
    return ''
  }
  const archive = { extractFile: () => Buffer.from('fixture renderer') }
  return { base, root, plan, run, calls, archive }
}

function recordedReads(action) {
  const original = fs.readFileSync, reads = []
  fs.readFileSync = (...args) => { reads.push(String(args[0])); return original(...args) }
  try { return { result: action(), reads } } finally { fs.readFileSync = original }
}

test('sensitive fake input names block every content read and all command dispatch', () => {
  for (const name of ['electron/auth.json', 'electron/.env', 'electron/.env.production.local',
    'electron/credentials.yaml', 'electron/provider-token.txt', 'electron/id_ed25519',
    'electron/account.sqlite', 'src/private-key.pem', 'build/signing.p12',
    'public/auth.json', 'public/.env.local', 'public/profile.db', 'electron-builder.env',
    'public/nested/secrets.json', 'public/.credentials', 'electron/oauth.json',
    'public/development.env', 'electron/.envrc', 'public/server.crt', 'electron/data.sqlite3-wal',
    'src/.env.example', 'electron/.env.example', 'public/.env.example', 'build/.env.example']) {
    const f = fixture(), file = path.join(f.root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fake fixture data only')
    const { reads } = recordedReads(() => {
      assert.throws(() => preview.executePreview(f.plan, f), /Sensitive build input refused/)
      assert.throws(() => preview.executePreview(f.plan), /Sensitive build input refused/)
      assert.throws(() => preview.preflightPreview(f.plan), /Sensitive build input refused/)
    })
    assert.deepEqual(reads, [], `Blocked ${name} before all content reads`)
    assert.deepEqual(f.calls, [], `Blocked ${name} before tool dispatch`)
    assert.equal(fs.existsSync(f.plan.output), false)
    assert.equal(fs.existsSync(file), true, 'Valuable input is retained, never removed')
  }
})

test('source/public links are refused without reading or following their targets', () => {
  for (const name of ['electron/alias.json', 'public/alias.svg', 'src/linked', 'public']) {
    const f = fixture(), target = path.join(f.base, 'unrelated-private'), link = path.join(f.root, name)
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'auth.json'), 'fake unrelated private data')
    if (name === 'public') fs.renameSync(link, path.join(f.base, 'owned-public'))
    fs.symlinkSync(target, link)
    const { reads } = recordedReads(() => assert.throws(() => preview.executePreview(f.plan, f),
      /symlink|Symlink/))
    assert.deepEqual(reads, [])
    assert.deepEqual(f.calls, [])
  }
})

test('ordinary native auth/security source and public assets are admitted; unrelated trees are not traversed', () => {
  const f = fixture()
  const unrelated = path.join(f.root, 'unrelated-private')
  fs.mkdirSync(unrelated)
  fs.writeFileSync(path.join(unrelated, 'auth.json'), 'fake unrelated private data')
  const original = fs.readdirSync, visited = []
  fs.readdirSync = (directory, ...args) => { visited.push(String(directory)); return original(directory, ...args) }
  try {
    const { reads } = recordedReads(() => preview.inspectPreviewInputs(f.root))
    assert.deepEqual(reads, [])
    assert(!visited.includes(unrelated))
    assert(!visited.some(dir => dir.includes('installed-runtime') || dir.includes('node_modules')))
  } finally { fs.readdirSync = original }
  preview.executePreview(f.plan, f)
  assert.deepEqual(f.calls.map(call => call.label), ['renderer', 'package', 'sign', 'verify', 'signature', 'entitlements'])
  assert.deepEqual(f.plan.config.files.slice(1), config.files.slice(1), 'No silent config/exclusion changes')
})

test('metadata admission is bounded and source identity/sensitive-name changes stop the next tool', () => {
  const bounded = fixture()
  assert.throws(() => preview.inspectPreviewInputs(bounded.root, { maxEntries: 3 }), /traversal bound/)
  fs.mkdirSync(path.join(bounded.root, 'public/nested'))
  fs.writeFileSync(path.join(bounded.root, 'public/nested/mark.svg'), '<svg/>')
  assert.throws(() => preview.inspectPreviewInputs(bounded.root, { maxDepth: 1 }), /traversal bound/)
  fs.mkdirSync(path.join(bounded.root, 'electron/node_modules'))
  assert.throws(() => preview.inspectPreviewInputs(bounded.root), /dependency\/private tree/)
  const swapped = fixture(), publicRoot = path.join(swapped.root, 'public')
  const privateTarget = path.join(swapped.base, 'unrelated-private')
  fs.mkdirSync(privateTarget)
  fs.writeFileSync(path.join(privateTarget, 'auth.json'), 'fake unrelated data')
  const originalReaddir = fs.readdirSync, visited = []
  fs.readdirSync = (directory, ...args) => {
    visited.push(String(directory))
    const names = originalReaddir(directory, ...args)
    if (String(directory) === publicRoot) {
      fs.renameSync(publicRoot, path.join(swapped.base, 'retained-public'))
      fs.symlinkSync(privateTarget, publicRoot)
    }
    return names
  }
  try {
    const { reads } = recordedReads(() => assert.throws(() => preview.inspectPreviewInputs(swapped.root),
      /Build input identity changed/))
    assert.deepEqual(reads, [])
    assert(!visited.includes(privateTarget))
  } finally { fs.readdirSync = originalReaddir }
  for (const kind of ['new-sensitive-file', 'same-byte-source-replacement']) {
    const f = fixture(), sensitive = path.join(f.root, 'public/.env')
    const run = (command, options) => {
      const output = f.run(command, options)
      if (command.label === 'renderer') {
        if (kind === 'new-sensitive-file') fs.writeFileSync(sensitive, 'fake new private input')
        else {
          const source = path.join(f.root, 'electron/main.cjs'), bytes = fs.readFileSync(source)
          fs.renameSync(source, path.join(f.base, 'previous-main'))
          fs.writeFileSync(source, bytes)
        }
      }
      return output
    }
    const { reads } = recordedReads(() => assert.throws(() => preview.executePreview(f.plan,
      { run, archive: f.archive }), /Sensitive build input refused|Build input identity changed/))
    assert(!reads.includes(sensitive), 'Changed sensitive data never gets read')
    assert.deepEqual(f.calls.map(call => call.label), ['renderer'])
  }
})

test('minimal build environment drops fake secrets and hooks without enumerating unknown values', () => {
  const values = { PATH: '/usr/bin:/bin', HOME: '/fixture/home', TMPDIR: '/fixture/tmp',
    LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'UTC', VITE_FAKE_PRIVATE_VALUE: 'fake-secret',
    MAIA_UPDATE_SIGNING_KEY: 'fake-secret', OTHER_PROVIDER_TOKEN: 'fake-secret',
    NODE_OPTIONS: '--require fake-hook', NODE_PATH: '/fake-hook', DYLD_INSERT_LIBRARIES: '/fake-hook',
    CSC_LINK: 'fake-secret', APPLE_ID: 'fake-secret', GH_TOKEN: 'fake-secret' }
  const env = preview.previewEnvironment(values)
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) assert.equal(env[key], values[key])
  for (const key of ['VITE_FAKE_PRIVATE_VALUE', 'MAIA_UPDATE_SIGNING_KEY', 'OTHER_PROVIDER_TOKEN',
    'NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'CSC_LINK', 'APPLE_ID', 'GH_TOKEN']) assert.equal(env[key], undefined)
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(env.CSC_IDENTITY, '')
  assert.equal(env.NO_UPDATE_NOTIFIER, '1')
  const accessed = []
  const proxy = new Proxy(values, {
    ownKeys() { throw new Error('Must not enumerate inherited credential variables') },
    get(target, key) {
      accessed.push(key)
      if (key in target && /VITE_|PROVIDER|SIGNING|NODE_OPTIONS|CSC_LINK|APPLE_ID|GH_TOKEN/.test(key)) {
        throw new Error('Must not read unused fake credential values')
      }
      return target[key]
    },
  })
  assert.deepEqual(preview.previewEnvironment(proxy), env)
  assert(!accessed.includes('OTHER_PROVIDER_TOKEN'))
  const f = fixture()
  preview.executePreview(f.plan, { ...f, environment: values })
  assert(f.calls.every(call => call.env.PATH === values.PATH && call.env.HOME === f.plan.toolHome &&
    call.env.TMPDIR === f.plan.toolTemp))
  assert(f.calls.every(call => call.env.OTHER_PROVIDER_TOKEN === undefined && call.env.VITE_FAKE_PRIVATE_VALUE === undefined))
})
