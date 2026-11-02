import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { REPO, createPreviewPlan, inspectPreviewInputs } from './build-completion-preview.mjs'
import { materializePreviewInputs, verifyPreviewSnapshot, previewBuildSandbox } from './build-completion-preview-snapshot.mjs'

const { test, afterEach } = await import(process.env.VITEST ? 'vitest' : 'node:test')
const require = createRequire(import.meta.url)
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const marker = 'OWNED_FAKE_OMITTED_SAMPLE_BYTES'
const config = { productName: 'Hermes Desk', files: ['dist/**/*', 'electron/**/*', 'package.json'],
  directories: { output: 'release' }, asarUnpack: ['**/*.node'], mac: {
    target: [{ target: 'dir', arch: ['arm64'] }], identity: null, notarize: false,
    hardenedRuntime: true, gatekeeperAssess: false, entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist' } }

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hd-preview-snapshot-test-'))
  roots.push(base)
  const root = path.join(base, 'repo'), workspace = path.join(base, 'workspace')
  for (const directory of [workspace, ...['src', 'public', 'electron', 'build', 'node_modules', 'release']
    .map(name => path.join(root, name))]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const template = path.join(root, '.env.example')
  fs.writeFileSync(template, marker, { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {base:"./"}')
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"owned-fixture","type":"module"}')
  fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/src/main.js"></script>')
  fs.writeFileSync(path.join(root, 'src/main.js'), 'document.body.textContent="owned positive source"')
  fs.writeFileSync(path.join(root, 'electron/auth.cjs'), 'module.exports = "ordinary auth source"')
  fs.chmodSync(path.join(root, 'electron/auth.cjs'), 0o755)
  fs.writeFileSync(path.join(root, 'public/mark.svg'), '<svg/>')
  fs.writeFileSync(path.join(root, 'build/entitlements.mac.plist'), '<plist/>')
  const plan = createPreviewPlan({ root, workspace, buildConfig: config,
    electronDist: path.join(root, 'node_modules/electron/dist'), electronVersion: '37.10.3',
    builderCli: 'unused', viteCli: 'unused', approvedViteConfigSha256: digest('export default {base:"./"}') })
  return { base, root, workspace, template, plan }
}
function copy(f) { return materializePreviewInputs(f.plan, inspectPreviewInputs(f.root)) }

test('unused root inputs are neither statted nor read; copies preserve admitted bytes/modes/native auth source', () => {
  const f = fixture(), privateRoot = path.join(f.root, 'unrelated-private')
  fs.mkdirSync(privateRoot)
  fs.writeFileSync(path.join(privateRoot, 'auth.json'), marker)
  const read = fs.readFileSync, stat = fs.lstatSync
  fs.readFileSync = (file, ...args) => {
    assert.notEqual(String(file), f.template, 'No template content reads')
    return read(file, ...args)
  }
  fs.lstatSync = (file, ...args) => {
    assert(![f.template, privateRoot].includes(String(file)), 'No omitted input metadata reads')
    return stat(file, ...args)
  }
  let graph
  try { graph = copy(f) } finally { fs.readFileSync = read; fs.lstatSync = stat }
  assert(!graph.entries.some(entry => entry.path === '.env.example' || entry.path.startsWith('unrelated-private')))
  const native = graph.entries.find(entry => entry.path === 'electron/auth.cjs')
  assert.equal(native.mode, 0o755)
  assert.equal(native.sha256, digest('module.exports = "ordinary auth source"'))
  assert.equal(fs.lstatSync(f.plan.snapshotRoot).mode & 0o777, 0o700)
  assert.equal(fs.readlinkSync(path.join(f.plan.snapshotRoot, 'node_modules')), f.plan.dependenciesRoot)
  assert.equal(fs.existsSync(path.join(f.plan.snapshotRoot, '.env.example')), false)
  verifyPreviewSnapshot(f.plan, graph)
})

test('source replacement before open cannot follow an omitted template; snapshot changes fail verification', () => {
  const f = fixture(), admitted = inspectPreviewInputs(f.root), source = path.join(f.root, 'src/main.js')
  const open = fs.openSync
  fs.openSync = (file, flags, ...args) => {
    if (String(file) === source) {
      fs.renameSync(source, path.join(f.base, 'retained-main.js'))
      fs.symlinkSync(f.template, source)
    }
    return open(file, flags, ...args)
  }
  try { assert.throws(() => materializePreviewInputs(f.plan, admitted), /ELOOP|identity changed|symlink/) }
  finally { fs.openSync = open }
  const other = fixture(), graph = copy(other)
  fs.writeFileSync(path.join(other.plan.snapshotRoot, 'src/main.js'), 'changed staged bytes')
  assert.throws(() => verifyPreviewSnapshot(other.plan, graph), /identity changed|digest changed/)
  const alias = fixture(), aliasGraph = copy(alias), staged = path.join(alias.plan.snapshotRoot, 'src/main.js')
  fs.renameSync(staged, path.join(alias.workspace, 'retained-staged.js'))
  fs.symlinkSync(alias.template, staged)
  assert.throws(() => verifyPreviewSnapshot(alias.plan, aliasGraph), /identity changed|graph\/mode changed/)
})

test('byte limits, missing or changed config, dependency aliases and file hardlinks have no fallback', () => {
  const large = fixture(), file = path.join(large.root, 'src/main.js')
  fs.truncateSync(file, 64 * 1024 * 1024 + 1)
  assert.throws(() => copy(large), /byte bound/)
  const missing = fixture()
  fs.renameSync(path.join(missing.root, 'vite.config.ts'), path.join(missing.base, 'retained-config.ts'))
  assert.throws(() => copy(missing), /Missing or unreviewed Vite configuration/)
  const changed = fixture()
  fs.writeFileSync(path.join(changed.root, 'vite.config.ts'), 'export default {root:"unknown"}')
  assert.throws(() => copy(changed), /unreviewed Vite configuration/)
  const alias = fixture()
  fs.renameSync(alias.plan.dependenciesRoot, path.join(alias.base, 'retained-dependencies'))
  fs.symlinkSync(path.join(alias.base, 'retained-dependencies'), alias.plan.dependenciesRoot)
  assert.throws(() => copy(alias), /symlink alias/)
  const linked = fixture()
  fs.linkSync(path.join(linked.root, 'src/main.js'), path.join(linked.base, 'source-hardlink.js'))
  assert.throws(() => copy(linked), /aliased\/nonregular source/)
})

test('installed builder matcher excludes root template, includes ordinary auth source, and needs selected-template admission', () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.root, 'electron/.env.example'), marker)
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher.js')
  const platform = { info: { config, projectDir: f.root, buildResourcesDir: 'build',
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } }
  const matchers = getMainFileMatchers(f.root, path.join(f.base, 'destination'), value => value,
    {}, platform, path.join(f.base, 'out'), false)
  const includes = file => matchers.some(matcher => matcher.createFilter()(file, fs.lstatSync(file)))
  assert.equal(includes(f.template), false)
  assert.equal(includes(path.join(f.root, 'electron/auth.cjs')), true)
  assert.equal(includes(path.join(f.root, 'electron/.env.example')), true)
  assert.throws(() => inspectPreviewInputs(f.root), /Sensitive build input refused/)
})

function profileFixture(f) {
  // This OS/Vite fixture explicitly shares only the already installed trusted
  // tool dependencies. It never runs executePreview, a builder, or codesign.
  const dependenciesRoot = path.join(REPO, 'node_modules')
  const profilePlan = { ...f.plan, dependenciesRoot }
  fs.mkdirSync(f.plan.envDirectory)
  fs.mkdirSync(f.plan.toolHome)
  fs.mkdirSync(f.plan.toolTemp)
  fs.writeFileSync(f.plan.sandboxFile, previewBuildSandbox(profilePlan), { mode: 0o600 })
  fs.writeFileSync(f.plan.viteConfigFile, f.plan.viteConfigSource.replace(
    JSON.stringify(path.join(f.plan.dependenciesRoot, 'vite/dist/node/index.js')),
    JSON.stringify(path.join(dependenciesRoot, 'vite/dist/node/index.js'))))
  const invoke = args => spawnSync('/usr/bin/sandbox-exec',
    ['-f', f.plan.sandboxFile, process.execPath, ...args], { cwd: f.plan.snapshotRoot,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: f.plan.toolHome,
        TMPDIR: f.plan.toolTemp, LANG: 'C', TZ: 'UTC', NODE_ENV: 'production' },
      encoding: 'utf8', timeout: 30000 })
  return { invoke, dependenciesRoot }
}

test('OS read boundary denies omitted original bytes, workspace symlink escapes and inherited child readers',
  { skip: process.platform !== 'darwin' }, () => {
  const f = fixture(); copy(f)
  fs.symlinkSync(f.template, path.join(f.workspace, 'escape'))
  const { invoke } = profileFixture(f)
  const files = [f.template, path.join(f.workspace, 'escape')]
  const dataVolumeAlias = `/System/Volumes/Data${f.template}`
  if (fs.existsSync(dataVolumeAlias)) files.push(dataVolumeAlias)
  const code = `const fs=require("node:fs"),cp=require("node:child_process");
    const errors=[];for(const file of ${JSON.stringify(files)}){
      try{fs.readFileSync(file);errors.push("UNSAFE_READ")}catch(e){errors.push(e.code)}}
    const writes=[];for(const file of ${JSON.stringify([f.plan.configFile, f.plan.viteConfigFile, f.plan.sandboxFile])}){
      try{fs.writeFileSync(file,"UNSAFE_MUTATION");writes.push("UNSAFE_WRITE")}catch(e){writes.push(e.code)}}
    const child=cp.spawnSync(process.execPath,["-e",${JSON.stringify(
      `try{require("node:fs").readFileSync(${JSON.stringify(f.template)});process.exit(2)}catch(e){console.log(e.code)}`
    )}],{encoding:"utf8",env:process.env});console.log(JSON.stringify({errors,writes,childStatus:child.status,childOutput:child.stdout}))`
  const result = invoke(['-e', code])
  assert.equal(result.status, 0, result.stderr)
  const proof = JSON.parse(result.stdout)
  assert(proof.errors.every(error => error === 'EPERM' || error === 'EACCES'))
  assert(proof.writes.every(error => error === 'EPERM' || error === 'EACCES'))
  assert.equal(proof.childStatus, 0)
  assert.match(proof.childOutput, /EPERM|EACCES/)
})

test('closed installed Vite fixture builds legitimate raw/CSS/glob/public imports without an omitted template',
  { skip: process.platform !== 'darwin' }, () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.root, 'src/allowed.txt'), 'owned admitted asset')
  fs.writeFileSync(path.join(f.root, 'src/style.css'), 'body{background:url("../public/mark.svg")}')
  fs.writeFileSync(path.join(f.root, 'src/main.js'), `import raw from "./allowed.txt?raw";
    import "./style.css";const glob=import.meta.glob("./*.txt",{query:"?raw",import:"default",eager:true});
    const omitted=import.meta.glob("../.env.example",{query:"?raw",import:"default",eager:true});
    document.body.textContent=JSON.stringify({raw,glob,omitted})`)
  copy(f)
  const { invoke, dependenciesRoot } = profileFixture(f)
  const result = invoke([path.join(dependenciesRoot, 'vite/bin/vite.js'), 'build', '--config',
    f.plan.viteConfigFile, '--outDir', f.plan.renderer])
  assert.equal(result.status, 0, result.stderr)
  const js = fs.readdirSync(path.join(f.plan.renderer, 'assets')).filter(name => name.endsWith('.js'))
    .map(name => fs.readFileSync(path.join(f.plan.renderer, 'assets', name), 'utf8')).join('')
  assert(js.includes('owned admitted asset'))
  assert(!js.includes(marker))
  assert(fs.existsSync(path.join(f.plan.renderer, 'mark.svg')), 'Selected public assets are retained')
})

test('closed installed Vite rejects original relative/absolute raw and CSS edges, never emitting omitted fake bytes',
  { skip: process.platform !== 'darwin' }, () => {
  for (const mode of ['relative-raw', 'absolute-raw', 'relative-css', 'absolute-css']) {
    const f = fixture()
    const reference = mode.startsWith('relative') ?
      path.relative(path.join(f.plan.snapshotRoot, 'src'), f.template) : f.template
    if (mode.endsWith('raw')) fs.writeFileSync(path.join(f.root, 'src/main.js'),
      `import raw from ${JSON.stringify(reference + '?raw')};document.body.textContent=raw`)
    else {
      fs.writeFileSync(path.join(f.root, 'src/main.js'), 'import "./style.css"')
      fs.writeFileSync(path.join(f.root, 'src/style.css'), `body{background:url(${JSON.stringify(reference)})}`)
    }
    copy(f)
    const { invoke, dependenciesRoot } = profileFixture(f)
    const result = invoke([path.join(dependenciesRoot, 'vite/bin/vite.js'), 'build', '--config',
      f.plan.viteConfigFile, '--outDir', f.plan.renderer])
    assert.notEqual(result.status, 0, `${mode}: ${result.stdout} ${result.stderr}`)
    assert.match(result.stderr, /EPERM|EACCES|Unresolved preview asset|Could not resolve/)
    assert.equal(fs.existsSync(path.join(f.plan.renderer, 'index.html')), false)
  }
})

test('closed installed Vite glob cannot enumerate an original private root outside the admitted source',
  { skip: process.platform !== 'darwin' }, () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.root, 'src/main.js'), `const omitted=import.meta.glob(
    ${JSON.stringify(f.template)},{query:"?raw",import:"default",eager:true,exhaustive:true});
    document.body.textContent=JSON.stringify(omitted)`)
  copy(f)
  const { invoke, dependenciesRoot } = profileFixture(f)
  const result = invoke([path.join(dependenciesRoot, 'vite/bin/vite.js'), 'build', '--config',
    f.plan.viteConfigFile, '--outDir', f.plan.renderer])
  // Some glob implementations suppress inaccessible matches; either an error
  // or an empty map is safe. They cannot enumerate/read the original subtree.
  if (result.status === 0) {
    const js = fs.readdirSync(path.join(f.plan.renderer, 'assets')).filter(name => name.endsWith('.js'))
      .map(name => fs.readFileSync(path.join(f.plan.renderer, 'assets', name), 'utf8')).join('')
    assert(!js.includes(marker))
  } else assert.match(result.stderr, /EPERM|EACCES|permission|glob/i)
})
