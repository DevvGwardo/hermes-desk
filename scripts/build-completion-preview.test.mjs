import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { REPO, PREVIEW_OUTPUT, PREVIEW_BUNDLE, parsePreviewArgs, createPreviewPlan,
  preflightPreview, executePreview, archiveIdentity, assertSignature, previewEnvironment } from './build-completion-preview.mjs'
import { loadCompletionPreviewEvidence, verifyCompletionPreviewRenderer } from '../tests/e2e/completion-preview-provenance.mjs'
import { inspectPreviewInputs } from './build-completion-preview.mjs'
import { materializePreviewInputs } from './build-completion-preview-snapshot.mjs'

// Also compatible with the repository's existing scripts/**/*.test.mjs project.
const { afterEach, test } = await import(process.env.VITEST ? 'vitest' : 'node:test')
const require = createRequire(import.meta.url)
const roots = []
afterEach(() => {
  // Only our own uniquely allocated test fixtures, never release outputs.
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const signature = 'Signature=adhoc\nflags=0x10000(runtime)\n'
const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/>' +
  '<key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>'
const config = {
  appId: 'com.devgwardo.hermesdesk', productName: 'Hermes Desk', directories: { output: 'release' },
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!electron/**/*.test.*',
    '!**/node_modules/**', '!**/node_modules/@capacitor/**', '!**/{android,ios,.transforms}/**'],
  asarUnpack: ['**/*.node', 'electron/local/mcp/shim/hermes-desk-mcp.cjs'],
  artifactName: 'Hermes-Desk-${version}-${os}-${arch}.${ext}',
  mac: { target: [{ target: 'dir', arch: ['arm64'] }], category: 'public.app-category.developer-tools',
    identity: null, hardenedRuntime: true, gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist', notarize: false },
}

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hd-preview-test-'))
  roots.push(base)
  const root = path.join(base, 'repo'), workspace = path.join(base, 'hd-completion-preview-fixture')
  const electronDist = path.join(base, 'installed-electron')
  for (const directory of [root, workspace, path.join(root, 'release/mac-arm64/Hermes Desk.app/Contents/Resources'),
    path.join(root, 'build'), path.join(root, 'dist'), path.join(electronDist, 'Electron.app')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(path.join(root, 'dist/index.html'), 'untouched existing renderer')
  fs.writeFileSync(path.join(root, 'build/entitlements.mac.plist'), entitlements)
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}')
  fs.writeFileSync(path.join(root, 'index.html'), 'fixture entry')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test-app', build: config }))
  const builderCli = path.join(root, 'node_modules/electron-builder.js'), viteCli = path.join(root, 'node_modules/vite.js')
  fs.writeFileSync(builderCli, 'inert test fixture')
  fs.writeFileSync(viteCli, 'inert test fixture')
  const plan = createPreviewPlan({ root, workspace, buildConfig: config, electronDist,
    electronVersion: '37.2.6', builderCli, viteCli, originalSha256: hash('approved original archive'),
    approvedViteConfigSha256: hash('export default {}') })
  fs.writeFileSync(plan.originalArchive, 'approved original archive')
  const calls = []
  const run = (command, options) => {
    calls.push({ ...command, options })
    if (command.label === 'renderer') {
      fs.mkdirSync(plan.renderer)
      fs.mkdirSync(path.join(plan.renderer, 'assets'))
      fs.writeFileSync(path.join(plan.renderer, 'index.html'), 'new temporary renderer')
      fs.writeFileSync(path.join(plan.renderer, 'assets/entry.js'), 'new temporary script')
    }
    if (command.label === 'package') {
      fs.mkdirSync(path.join(plan.bundle, 'Contents/Resources'), { recursive: true })
      fs.writeFileSync(path.join(plan.bundle, 'Contents/Resources/app.asar'), 'fake preview archive')
    }
    if (command.label === 'signature') return signature
    if (command.label === 'entitlements') return entitlements
    return ''
  }
  const archive = { extractFile: (_asar, file) => fs.readFileSync(path.join(plan.renderer, file.slice('dist/'.length))),
    listPackage: () => ['/dist', '/dist/assets', '/dist/index.html', '/dist/assets/entry.js'],
    statFile: () => ({}) }
  return { base, plan, calls, run, archive }
}

test('CLI is fixed-output and fail-closed; no install/update/publish flags', () => {
  assert.deepEqual(parsePreviewArgs([]), { dryRun: false })
  assert.deepEqual(parsePreviewArgs(['--dry-run']), { dryRun: true })
  for (const args of [['--output=release'], ['--bundle', PREVIEW_BUNDLE], ['--dry-run', '--dry-run'], ['--publish'], ['--']]) {
    assert.throws(() => parsePreviewArgs(args), /Only no arguments or --dry-run/)
  }
  assert.equal(PREVIEW_OUTPUT, `${REPO}/release/preview-2026-10-13`)
  assert.equal(PREVIEW_BUNDLE, `${PREVIEW_OUTPUT}/mac-arm64/Hermes Desk.app`)
  const script = fileURLToPath(new URL('./build-completion-preview.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--output=release'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Only no arguments/)
})

test('plan preserves trusted config/exclusions/unpack, maps only the owned temporary renderer', () => {
  const { plan } = fixture()
  const serialized = JSON.stringify(config)
  assert.deepEqual(plan.config.files[0], { from: plan.renderer, to: 'dist', filter: ['**/*'] })
  assert.deepEqual(plan.config.files.slice(1), config.files.slice(1))
  assert.deepEqual(plan.config.asarUnpack, config.asarUnpack)
  assert.deepEqual(plan.config.mac, config.mac)
  assert.equal(JSON.stringify(config), serialized)
  assert.equal(plan.config.directories.output, plan.output)
  assert(!JSON.stringify(plan.commands).includes(plan.originalBundle))
  assert(!JSON.stringify(plan.commands).includes('build-desktop'))
  assert(plan.commands.every(command => !['npm', 'npx'].includes(path.basename(command.executable))))
  assert.equal(plan.commands[0].args.at(-1), plan.renderer)
  assert(plan.commands[0].args.includes(plan.viteConfigFile))
  assert(plan.viteConfigSource.includes(`envDir: ${JSON.stringify(plan.envDirectory)}`))
  assert(plan.viteConfigSource.includes('emptyOutDir: false'))
  assert(plan.viteConfigSource.includes(JSON.stringify(path.join(plan.snapshotRoot, 'vite.config.ts'))))
  const args = plan.commands[1].args
  assert(args.includes(plan.configFile))
  assert(!args.some(arg => arg.startsWith('--config.')))
  assert.equal(plan.config.electronVersion, '37.2.6')
  assert.equal(plan.config.npmRebuild, false)
  assert.deepEqual(args.slice(-2), ['--publish', 'never'])
  assert.equal(plan.config.nodeGypRebuild, false)
  assert.equal(plan.config.buildDependenciesFromSource, false)
  assert.equal(plan.config.extends, null)
  assert.equal(plan.config.publish, null)
})

test('installed builder parser/config loader uses only the preview file, never merging repo dist', async () => {
  const { plan } = fixture()
  fs.writeFileSync(path.join(plan.root, 'package.json'), JSON.stringify({ name: 'test-app', build: config }))
  fs.writeFileSync(plan.configFile, JSON.stringify(plan.config))
  const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js')
  const parsed = configureBuildCommand(createYargs()).exitProcess(false).parse(plan.commands[1].args.slice(1))
  const normalized = normalizeOptions(parsed)
  assert.equal(normalized.config, plan.configFile)
  assert.equal(normalized.publish, 'never')
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  const loaded = await getConfig(plan.root, normalized.config, null)
  await validateConfiguration(loaded)
  assert.equal(loaded.directories.output, plan.output)
  assert.equal(loaded.electronDist, plan.config.electronDist)
  assert.equal(loaded.electronVersion, '37.2.6')
  assert.equal(loaded.npmRebuild, false)
  assert.deepEqual(loaded.asarUnpack, config.asarUnpack)
  const rootFiles = loaded.files.find(set => set.from == null)
  assert(rootFiles)
  assert(!rootFiles.filter.includes('dist/**/*'))
  assert(rootFiles.filter.includes('electron/**/*'))
  assert(rootFiles.filter.includes('!electron/**/*.test.*'))
  const rendererFiles = loaded.files.find(set => set.from === plan.renderer)
  assert.deepEqual(rendererFiles, { from: plan.renderer, to: 'dist', filter: ['**/*'] })
})

test('installed Vite resolves the wrapper, retains trusted plugins, and ignores fixture repo .env', async () => {
  const { plan } = fixture()
  fs.writeFileSync(path.join(plan.root, 'vite.config.ts'),
    'export default { base: "./", plugins: [{name: "trusted-fixture-plugin"}], build: {sourcemap: true} }')
  plan.approvedViteConfigSha256 = hash(fs.readFileSync(path.join(plan.root, 'vite.config.ts')))
  materializePreviewInputs(plan, inspectPreviewInputs(plan.root))
  // This pure configuration-loader test does not dispatch production commands.
  // Its fake dependency directory supplies only the explicit installed Vite.
  fs.mkdirSync(path.join(plan.dependenciesRoot, 'vite'))
  fs.mkdirSync(path.join(plan.dependenciesRoot, 'vite/dist'))
  fs.mkdirSync(path.join(plan.dependenciesRoot, 'vite/dist/node'))
  fs.writeFileSync(path.join(plan.dependenciesRoot, 'vite/dist/node/index.js'),
    `export { createLogger } from ${JSON.stringify(require.resolve('vite'))}`)
  fs.writeFileSync(path.join(plan.root, '.env'), 'VITE_PREVIEW_FIXTURE_SENTINEL=not-a-real-secret\n')
  fs.writeFileSync(plan.viteConfigFile, plan.viteConfigSource)
  fs.mkdirSync(plan.envDirectory)
  const { resolveConfig } = await import('vite')
  const resolved = await resolveConfig({ root: plan.root, configFile: plan.viteConfigFile,
    cacheDir: path.join(plan.workspace, 'vite-cache') }, 'build')
  assert.equal(resolved.build.outDir, plan.renderer)
  assert.equal(resolved.build.emptyOutDir, false)
  assert.equal(resolved.build.sourcemap, true)
  assert.equal(resolved.base, './')
  assert.equal(resolved.envDir, plan.envDirectory)
  assert.equal(resolved.env.VITE_PREVIEW_FIXTURE_SENTINEL, undefined)
  assert(resolved.plugins.some(plugin => plugin.name === 'trusted-fixture-plugin'))
  assert.equal(fs.existsSync(plan.output), false)
  assert.equal(fs.existsSync(plan.renderer), false)
})

test('new hooks, alternative runtime config and untrusted signing shape require review', () => {
  const { plan } = fixture()
  const inputs = { root: plan.root, workspace: plan.workspace, buildConfig: config,
    electronDist: plan.config.electronDist, electronVersion: '37.2.6', builderCli: 'builder', viteCli: 'vite' }
  for (const change of [{ afterSign: 'hook' }, { electronDownload: {} },
    { directories: { output: 'release', app: '.' } }, { mac: { ...config.mac, identity: 'Some identity' } },
    { mac: { ...config.mac, notarize: true } }, { asar: false }, { files: ['**/*'] }]) {
    assert.throws(() => createPreviewPlan({ ...inputs, buildConfig: { ...config, ...change } }), /Unsupported|trusted/)
  }
  assert.throws(() => createPreviewPlan({ ...inputs, workspace: path.join(plan.root, 'dist') }), /outside/)
})

test('existing output and dangling, original-bundle or ancestor aliases are refused before commands', () => {
  for (const kind of ['directory', 'file', 'dangling', 'original', 'ancestor', 'root']) {
    const f = fixture()
    if (kind === 'directory') fs.mkdirSync(f.plan.output)
    if (kind === 'file') fs.writeFileSync(f.plan.output, 'unrelated')
    if (kind === 'dangling') fs.symlinkSync(path.join(f.base, 'missing'), f.plan.output)
    if (kind === 'original') fs.symlinkSync(f.plan.originalBundle, f.plan.output)
    if (kind === 'ancestor') {
      const release = path.dirname(f.plan.output)
      fs.renameSync(release, `${release}-real`)
      fs.symlinkSync(`${release}-real`, release)
    }
    if (kind === 'root') {
      fs.renameSync(f.plan.root, `${f.plan.root}-real`)
      fs.symlinkSync(`${f.plan.root}-real`, f.plan.root)
    }
    assert.throws(() => executePreview(f.plan, f), /already exists|symlink alias/)
    assert.equal(f.calls.length, 0)
  }
})

test('missing runtime or mismatched original baseline fails before any commands', () => {
  const f = fixture()
  fs.renameSync(path.join(f.plan.config.electronDist, 'Electron.app'), path.join(f.base, 'runtime-disabled'))
  assert.throws(() => executePreview(f.plan, f), /ENOENT/)
  assert.equal(f.calls.length, 0)
  const other = fixture()
  fs.writeFileSync(other.plan.originalArchive, 'unapproved original')
  assert.throws(() => executePreview(other.plan, other), /approved baseline/)
  assert.equal(other.calls.length, 0)
})

test('preflight is read-only; test-double build leaves repo dist and original exactly intact', () => {
  const f = fixture(), before = archiveIdentity(f.plan.originalArchive)
  preflightPreview(f.plan)
  assert.deepEqual(fs.readdirSync(f.plan.workspace), [])
  assert.equal(fs.existsSync(f.plan.output), false)
  const result = executePreview(f.plan, { ...f, environment: { CSC_LINK: 'obviously-fake-csc-link', CSC_KEY_PASSWORD: 'obviously-fake-csc-password',
    CSC_NAME: 'identity', APPLE_ID: 'id', GH_TOKEN: 'token', PATH: '/usr/bin:/bin', SAFE: 'unknown' } })
  assert.deepEqual(archiveIdentity(f.plan.originalArchive), before)
  assert.equal(fs.readFileSync(path.join(f.plan.root, 'dist/index.html'), 'utf8'), 'untouched existing renderer')
  assert.equal(result.rendererDirectory, f.plan.renderer)
  assert.equal(result.rendererFiles.length, 2)
  assert.equal(result.provenanceVersion, 1)
  assert.equal(result.rendererSnapshot.files.length, 2)
  assert.equal(result.rendererManifestSha256, hash(JSON.stringify(result.rendererSnapshot)))
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'))
  assert.equal(receipt.evidenceSha256, hash(fs.readFileSync(result.evidence)))
  assert.equal(receipt.asarSha256, result.asarSha256)
  const token = loadCompletionPreviewEvidence({ root: f.plan.root, tempRoot: f.base, originalSha256: before.sha256 })
  assert.equal(verifyCompletionPreviewRenderer(token, { bundle: f.plan.bundle,
    asar: path.join(f.plan.bundle, 'Contents/Resources/app.asar'), archive: f.archive }).toString(), 'new temporary renderer')
  assert.deepEqual(result.originalAfter, before)
  assert.deepEqual(f.calls.map(call => call.label), ['renderer', 'package', 'sign', 'verify', 'signature', 'entitlements'])
  assert.equal(f.calls[2].args.at(-1), f.plan.bundle)
  assert(f.calls[2].args.includes('runtime'))
  assert.deepEqual(f.calls[2].args.slice(-3), ['--sign', '-', f.plan.bundle])
  assert.equal(f.calls[0].options.env.PATH, '/usr/bin:/bin')
  assert.equal(f.calls[0].options.env.SAFE, undefined)
  assert.equal(f.calls[0].options.env.CSC_LINK, undefined)
  assert.equal(f.calls[0].options.env.CSC_KEY_PASSWORD, undefined)
  assert.equal(f.calls[0].options.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(f.calls[0].options.env.NO_UPDATE_NOTIFIER, '1')
  assert.deepEqual(fs.readdirSync(f.plan.envDirectory), [])
  assert(fs.existsSync(result.evidence))
  assert.throws(() => executePreview(f.plan, f), /already exists/)
})

test('electron-builder credential-file autoload is refused without reading its contents', () => {
  const f = fixture()
  fs.symlinkSync(path.join(f.base, 'nonexistent-credentials'), path.join(f.plan.root, 'electron-builder.env'))
  assert.throws(() => executePreview(f.plan, f), /credential-file reads/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(fs.readdirSync(f.plan.workspace), [])
})

test('each failed tool stops later commands and records original-after without deleting failed output', () => {
  for (const label of ['renderer', 'package', 'sign', 'verify', 'signature', 'entitlements']) {
    const f = fixture()
    const run = (command, options) => {
      if (command.label === label) { f.calls.push(command); throw new Error(`fake ${label} failed`) }
      return f.run(command, options)
    }
    assert.throws(() => executePreview(f.plan, { run, archive: f.archive }), new RegExp(`fake ${label} failed`))
    assert.equal(f.calls.at(-1).label, label)
    assert(fs.existsSync(path.join(f.plan.workspace, 'original-after.json')))
    assert(fs.existsSync(f.plan.output))
    assert.equal(fs.existsSync(path.join(f.plan.output, 'completion-preview.json')), false)
  }
})

test('real child runner propagates nonzero status, termination and spawn errors without running builder',
  { skip: process.platform !== 'darwin' }, () => {
  for (const mode of ['status', 'signal', 'missing-executable']) {
    const f = fixture()
    fs.writeFileSync(f.plan.commands[0].args[0], mode === 'signal' ?
      'process.kill(process.pid, "SIGTERM")' : 'process.exit(7)')
    if (mode === 'missing-executable') f.plan.commands[0].executable = path.join(f.base, 'missing-node')
    const expected = mode === 'status' ? /renderer failed \(status 7/ :
      mode === 'signal' ? /signal SIGTERM/ : /ENOENT/
    assert.throws(() => executePreview(f.plan, { archive: f.archive }), expected)
    assert.equal(fs.existsSync(f.plan.bundle), false)
    assert(fs.existsSync(path.join(f.plan.workspace, 'original-after.json')))
  }
})

test('renderer provenance mismatch and alias introduced during build refuse signing', () => {
  const f = fixture()
  assert.throws(() => executePreview(f.plan, { ...f, archive: { extractFile: () => Buffer.from('stale renderer') } }), /Packaged renderer differs/)
  assert.deepEqual(f.calls.map(call => call.label), ['renderer', 'package'])
  const other = fixture()
  const run = (command, options) => {
    const result = other.run(command, options)
    if (command.label === 'renderer') {
      fs.renameSync(other.plan.output, `${other.plan.output}-owned`)
      fs.symlinkSync(other.plan.originalBundle, other.plan.output)
    }
    return result
  }
  assert.throws(() => executePreview(other.plan, { run, archive: other.archive }), /symlink alias/)
  assert.deepEqual(other.calls.map(call => call.label), ['renderer'])
})

test('original change is detected after success and after command failure', () => {
  for (const fail of [false, true]) {
    const f = fixture()
    const run = (command, options) => {
      if (command.label === 'renderer') {
        fs.writeFileSync(f.plan.originalArchive, 'test-only changed archive')
        if (fail) throw new Error('test-only renderer failure')
      }
      return f.run(command, options)
    }
    assert.throws(() => executePreview(f.plan, { run, archive: f.archive }), /Original archive identity changed/)
    assert.equal(fs.existsSync(path.join(f.plan.output, 'completion-preview.json')), false)
  }
})

test('signature and entitlement assertions reject missing runtime, non-ad-hoc or disabled entitlements', () => {
  assertSignature(signature, entitlements)
  assert.throws(() => assertSignature('Signature=adhoc', entitlements), /runtime missing/)
  assert.throws(() => assertSignature('Signature=Developer ID\nflags=0x10000(runtime)', entitlements), /not ad-hoc/)
  assert.throws(() => assertSignature(signature, entitlements.replace('disable-library-validation', 'wrong-key')), /disable-library-validation/)
  assert.throws(() => assertSignature(signature, entitlements.replaceAll('<true/>', '<false/>')), /missing enabled/)
  const f = fixture()
  const run = (command, options) => command.label === 'signature' ? 'Signature=adhoc' : f.run(command, options)
  assert.throws(() => executePreview(f.plan, { run, archive: f.archive }), /runtime missing/)
  assert.equal(fs.existsSync(path.join(f.plan.output, 'completion-preview.json')), false)
  assert.equal(previewEnvironment({ GH_TOKEN: 'secret' }).GH_TOKEN, undefined)
})
