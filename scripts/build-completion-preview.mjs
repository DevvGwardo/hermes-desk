// Explicit, local-only completion preview. Never call the default desktop builder.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { materializePreviewInputs, verifyPreviewSnapshot, previewBuildSandbox,
  MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_TOTAL_BYTES } from './build-completion-preview-snapshot.mjs'

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const PREVIEW_NAME = 'preview-2026-10-13'
export const PREVIEW_OUTPUT = path.join(REPO, 'release', PREVIEW_NAME)
export const PREVIEW_BUNDLE = path.join(PREVIEW_OUTPUT, 'mac-arm64', 'Hermes Desk.app')
export const ORIGINAL_SHA256 = 'cf9e0879a1da3ff68f63b5b6ff80d77c776187aec20bc2257b9f790f7c65ece8'
export const APPROVED_VITE_CONFIG_SHA256 = '1e6545f0a98fecd9028e8d46326ecd0b2e1ed4f279decd2f6623b4aa2c18f54a'
const require = createRequire(import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`

export function parsePreviewArgs(args) {
  if (args.length === 0) return { dryRun: false }
  if (args.length === 1 && args[0] === '--dry-run') return { dryRun: true }
  throw new Error('Only no arguments or --dry-run are supported; output and bundle cannot be overridden')
}

// lstat, not existsSync: dangling links are collisions too.
function exists(file) {
  try { fs.lstatSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function assertUnaliased(file, { missing = false } = {}) {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    if (missing && !exists(current)) return
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink alias: ${current}`)
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`)
  }
}

export function archiveIdentity(file) {
  assertUnaliased(file)
  const before = fs.statSync(file)
  if (!before.isFile()) throw new Error(`Original archive is not a regular file: ${file}`)
  const hash = sha256(fs.readFileSync(file))
  const after = fs.statSync(file)
  const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
  if (json(identity(before)) !== json(identity(after))) throw new Error('Original archive changed while reading')
  return { path: fs.realpathSync(file), ...identity(after), sha256: hash }
}

export function previewEnvironment(environment) {
  // Read ONLY understood tooling keys; never enumerate inherited credentials.
  // NODE_OPTIONS/NODE_PATH, DYLD_*, VITE_*, provider and signing values are
  // intentionally absent. These builds use absolute installed Node/CLI paths.
  const env = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    '__CF_USER_TEXT_ENCODING']) {
    const value = environment[key]
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, NODE_ENV: 'production', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    CSC_IDENTITY: '', NO_UPDATE_NOTIFIER: '1' }
}

const INPUT_ROOTS = ['src', 'electron', 'public', 'build']
const ROOT_INPUT = /^(?:package(?:-lock)?\.json|index\.html|vite\.config\.ts|tsconfig(?:\.[\w-]+)?\.json|(?:postcss|tailwind)\.config\.[cm]?[jt]s|\.gitignore|\.browserslistrc)$/
const AUTOMATIC_ROOT_DATA = new Set(['electron-builder.env', '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.envrc'])
const PRIVATE_EXTENSION = /\.(?:pem|key|p8|p12|pfx|p7b|p7c|pkcs12|ppk|keystore|jks|cer|crt|der|csr|asc|gpg|kdbx?|keychain|keychain-db|db|db3|sqlite|sqlite3|mdb|ldb|leveldb|realm|rdb)(?:-(?:wal|shm|journal))?$/i
const DATA_EXTENSION = /\.(?:json5?|jsonl|ndjson|ya?ml|toml|ini|conf|cfg|txt|csv|tsv|log|bin|dat|plist|xml|md|sql)$/i
const DATA_NAME = /(?:^|[._-])(?:auth|oauth2?|authentication|authorization|credentials?|secrets?|keys?|tokens?|api[._-]?keys?|private[._-]?keys?|signing[._-]?keys?|passwords?|passwd|cookies?|sessions?|conversations?|messages?|chat[._-]?history|private[._-]?(?:chats?|data|notes)|keychains?|user[._-]?data|accounts?)(?:$|[._-])/i
const PRIVATE_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.aws', '.ssh',
  '.gnupg', '.hermes', '.maia', '.envrc', 'electron-builder.env', 'login data', 'web data',
  'history', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])
const PRIVATE_DIRECTORIES = new Set(['credentials', 'secrets', 'cookies', 'sessions', 'keychains',
  'userdata', 'user-data', 'private-data', 'private-chats', 'chat-history', 'databases',
  'local storage', 'session storage', 'indexeddb'])

function sensitiveInputName(name, directory) {
  const lower = name.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env') || PRIVATE_NAMES.has(lower) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)\.pub$/.test(lower) ||
      PRIVATE_EXTENSION.test(name)) return true
  if (directory) return PRIVATE_DIRECTORIES.has(lower)
  // Auth/security *source* remains part of the genuine graph; only known
  // credential/data naming is rejected. This is not content classification.
  if (/\.[cm]?[jt]sx?$/i.test(name)) return false
  const extension = path.extname(name)
  return (DATA_EXTENSION.test(name) || !extension) &&
    DATA_NAME.test(extension ? name.slice(0, -extension.length) : name)
}

// Metadata only: no file contents, dependency traversal, deletion or exclusion
// edits. Limits can only be tightened by fixture tests, never enlarged.
// This is filename admission, not secret-content detection. Unselected root
// files are neither statted nor read; tools use only a private copy and OS
// read confinement. Source inputs must be quiescent while materializing.
export function inspectPreviewInputs(root, { maxEntries = 25000, maxDepth = 32 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 25000 ||
      !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) throw new Error('Invalid input traversal bound')
  root = path.resolve(root)
  assertUnaliased(root)
  const snapshot = [], identity = stat => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
  let count = 0, totalBytes = 0
  const admit = (file, relative, depth, descend) => {
    if (++count > maxEntries || depth > maxDepth) throw new Error(`Build input traversal bound exceeded: ${file}`)
    const before = fs.lstatSync(file)
    if (sensitiveInputName(path.basename(file), before.isDirectory())) {
      throw new Error(`Sensitive build input refused before content reads (credential-file reads blocked): ${file}; retain it and ask its owner to resolve the input`)
    }
    if (before.isSymbolicLink()) throw new Error(`Refusing symlink build input: ${file}`)
    if (!before.isDirectory() && !before.isFile()) throw new Error(`Unsupported build input type: ${file}`)
    if (before.isFile() && (before.size > MAX_SNAPSHOT_FILE_BYTES ||
        (totalBytes += before.size) > MAX_SNAPSHOT_TOTAL_BYTES)) throw new Error(`Snapshot input byte bound exceeded: ${file}`)
    snapshot.push({ path: relative, identity: identity(before) })
    if (before.isDirectory() && descend) {
      if (['node_modules', '.git', '.venv', 'venv'].includes(path.basename(file))) {
        throw new Error(`Refusing dependency/private tree inside admitted build inputs: ${file}`)
      }
      const names = fs.readdirSync(file).sort()
      if (json(identity(before)) !== json(identity(fs.lstatSync(file)))) {
        throw new Error(`Build input identity changed while inspecting: ${file}`)
      }
      for (const name of names) admit(path.join(file, name), `${relative}/${name}`, depth + 1, true)
    }
    if (json(identity(before)) !== json(identity(fs.lstatSync(file)))) {
      throw new Error(`Build input identity changed while inspecting: ${file}`)
    }
  }
  const before = fs.lstatSync(root)
  const names = fs.readdirSync(root).sort()
  if (json(identity(before)) !== json(identity(fs.lstatSync(root)))) {
    throw new Error(`Build input identity changed while inspecting: ${root}`)
  }
  for (const name of names) {
    if (++count > maxEntries) throw new Error(`Build input traversal bound exceeded: ${root}`)
    const file = path.join(root, name)
    if (AUTOMATIC_ROOT_DATA.has(name.toLowerCase())) {
      throw new Error(`Sensitive build input refused before content reads (credential-file reads blocked): ${file}; retain it and ask its owner to resolve the input`)
    }
    // Select BEFORE inspecting names/metadata. No per-template whitelist.
    // Omitted originals remain outside the child sandbox's read allowlist.
    if (INPUT_ROOTS.includes(name) || ROOT_INPUT.test(name)) admit(file, name, 1, INPUT_ROOTS.includes(name))
  }
  for (const name of INPUT_ROOTS) if (!names.includes(name)) snapshot.push({ path: name, missing: true })
  if (json(identity(before)) !== json(identity(fs.lstatSync(root)))) {
    throw new Error(`Build input identity changed while inspecting: ${root}`)
  }
  return snapshot
}

export function createPreviewPlan({ root = REPO, workspace, buildConfig, electronDist,
  electronVersion, builderCli, viteCli, node = process.execPath, originalSha256 = ORIGINAL_SHA256,
  approvedViteConfigSha256 = APPROVED_VITE_CONFIG_SHA256 }) {
  root = path.resolve(root)
  workspace = path.resolve(workspace)
  const originalBundle = path.join(root, 'release/mac-arm64/Hermes Desk.app')
  const output = path.join(root, 'release', PREVIEW_NAME)
  const bundle = path.join(output, 'mac-arm64/Hermes Desk.app')
  const renderer = path.join(workspace, 'renderer')
  const configFile = path.join(workspace, 'electron-builder-preview.json')
  const viteConfigFile = path.join(workspace, 'vite-preview.config.mjs')
  const envDirectory = path.join(workspace, 'empty-env')
  const snapshotRoot = path.join(workspace, 'source')
  const dependenciesRoot = path.join(root, 'node_modules')
  const sandboxFile = path.join(workspace, 'build.sb')
  const toolHome = path.join(workspace, 'home'), toolTemp = path.join(workspace, 'tmp')
  const sourceEntitlements = path.join(root, 'build/entitlements.mac.plist')
  const entitlements = path.join(snapshotRoot, 'build/entitlements.mac.plist')
  // Bounded to the presently audited build shape. Fail closed on new hooks,
  // external app directories, custom signing or download configuration.
  const allowed = ['appId', 'productName', 'directories', 'files', 'asarUnpack', 'artifactName', 'mac', 'asar']
  const allowedMac = ['target', 'category', 'identity', 'hardenedRuntime', 'gatekeeperAssess',
    'entitlements', 'entitlementsInherit', 'notarize']
  if (!buildConfig || Object.keys(buildConfig).some(key => !allowed.includes(key)) ||
      Object.keys(buildConfig.mac || {}).some(key => !allowedMac.includes(key)) ||
      Object.keys(buildConfig.directories || {}).some(key => key !== 'output')) {
    throw new Error('Unsupported build configuration; review new build fields before preview packaging')
  }
  if (buildConfig.productName !== 'Hermes Desk' || buildConfig.asar === false ||
      buildConfig.mac?.identity !== null || buildConfig.mac?.notarize !== false ||
      buildConfig.mac?.hardenedRuntime !== true || buildConfig.mac?.gatekeeperAssess !== false ||
      buildConfig.mac?.entitlements !== 'build/entitlements.mac.plist' ||
      buildConfig.mac?.entitlementsInherit !== 'build/entitlements.mac.plist' ||
      json(buildConfig.mac?.target) !== json([{ target: 'dir', arch: ['arm64'] }])) {
    throw new Error('Preview requires the trusted arm64 dir / ad-hoc hardened-runtime configuration')
  }
  if (!Array.isArray(buildConfig.files) || buildConfig.files.some(file => typeof file !== 'string') ||
      buildConfig.files.filter(file => file === 'dist/**/*').length !== 1 ||
      buildConfig.files.some(file => !file.startsWith('!') && !['dist/**/*', 'electron/**/*', 'package.json'].includes(file)) ||
      !Array.isArray(buildConfig.asarUnpack)) {
    throw new Error('Unsupported renderer/native input graph or asarUnpack; review new inclusions before preview packaging')
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(electronVersion || '')) throw new Error('Invalid installed Electron version')
  if (workspace === root || workspace.startsWith(`${root}${path.sep}`)) throw new Error('Workspace must be outside the source repository')
  const config = structuredClone(buildConfig)
  config.directories = { ...config.directories, output }
  config.files = config.files.map(file => file === 'dist/**/*' ?
    { from: renderer, to: 'dist', filter: ['**/*'] } : file)
  Object.assign(config, { extends: null, publish: null, electronDist, electronVersion,
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false })
  const command = (label, executable, args, capture = false) => ({ label, executable, args, capture })
  // Preserve the trusted Vite config/plugins, but never read repository .env
  // files or empty an existing output. This wrapper lives only in our workspace.
  const viteConfigSource = `import trusted from ${JSON.stringify(path.join(snapshotRoot, 'vite.config.ts'))}\n` +
    `import { createLogger } from ${JSON.stringify(path.join(dependenciesRoot, 'vite/dist/node/index.js'))}\n` +
    `const logger = createLogger(); const warn = logger.warn.bind(logger)\n` +
    `logger.warn = (message, options) => { if (String(message).includes("didn't resolve at build time")) ` +
    `throw new Error("Unresolved preview asset; no original-root fallback"); warn(message, options) }\n` +
    `export default { ...trusted, customLogger: logger, root: ${JSON.stringify(snapshotRoot)}, ` +
    `cacheDir: ${JSON.stringify(path.join(workspace, 'vite-cache'))}, envDir: ${JSON.stringify(envDirectory)}, ` +
    `build: { ...trusted.build, outDir: ${JSON.stringify(renderer)}, emptyOutDir: false } }\n`
  return { root, workspace, output, bundle, originalBundle, renderer, configFile, config, entitlements,
    viteConfigFile, viteConfigSource, envDirectory, snapshotRoot, dependenciesRoot, sandboxFile,
    toolHome, toolTemp, node, sourceEntitlements, approvedViteConfigSha256,
    originalArchive: path.join(originalBundle, 'Contents/Resources/app.asar'), originalSha256,
    commands: [
      command('renderer', node, [viteCli, 'build', '--config', viteConfigFile, '--outDir', renderer]),
      // Never combine --config <file> with --config.*: electron-builder turns
      // that into extends and can merge the repository's stale dist file set.
      // All output/runtime/no-rebuild overrides are in this complete JSON file.
      command('package', node, [builderCli, '--mac', '--arm64', '--dir', '--config', configFile, '--publish', 'never']),
      command('sign', '/usr/bin/codesign', ['--force', '--deep', '--options', 'runtime',
        '--entitlements', entitlements, '--sign', '-', bundle]),
      command('verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]),
      command('signature', '/usr/bin/codesign', ['-dv', '--verbose=2', bundle], true),
      command('entitlements', '/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', bundle], true),
    ] }
}

export function preflightPreview(plan) {
  inspectPreviewInputs(plan.root)
  assertUnaliased(plan.root)
  assertUnaliased(path.dirname(plan.output))
  assertUnaliased(plan.output, { missing: true })
  if (exists(plan.output)) throw new Error(`Preview output already exists; refusing to overwrite: ${plan.output}`)
  assertUnaliased(plan.originalArchive)
  assertUnaliased(plan.sourceEntitlements)
  assertUnaliased(plan.dependenciesRoot)
  // electron-builder's CLI otherwise loads this file even with --publish never.
  if (exists(path.join(plan.root, 'electron-builder.env'))) {
    throw new Error('Refusing automatic credential-file reads: electron-builder.env exists')
  }
  assertUnaliased(path.join(plan.config.electronDist, 'Electron.app'))
  for (const command of plan.commands.slice(0, 2)) assertUnaliased(command.args[0])
  const identity = archiveIdentity(plan.originalArchive)
  if (identity.sha256 !== plan.originalSha256) throw new Error('Original archive does not match the approved baseline')
  return identity
}

export function assertSignature(info, entitlements) {
  if (!/flags=0x[0-9a-f]+\([^)]*runtime/i.test(info)) throw new Error('Hardened runtime missing')
  if (!/Signature=adhoc\b/.test(info)) throw new Error('Preview is not ad-hoc signed')
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']) {
    const escaped = key.replaceAll('.', '\\.')
    if (!new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`).test(entitlements)) {
      throw new Error(`Signed app is missing enabled ${key}`)
    }
  }
}

export function previewFileIdentity(file) {
  assertUnaliased(file)
  const stat = fs.statSync(file)
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, uid: stat.uid,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

export function rendererSnapshot(directory) {
  const directories = [], files = []
  const walk = (directory, prefix = '') => {
    assertUnaliased(directory)
    directories.push({ directory: prefix.slice(0, -1), identity: previewFileIdentity(directory) })
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(file, `${name}/`); continue }
      if (!entry.isFile()) throw new Error(`Unsupported renderer entry: ${file}`)
      const before = previewFileIdentity(file)
      const hash = sha256(fs.readFileSync(file))
      const after = previewFileIdentity(file)
      if (json(before) !== json(after)) throw new Error(`Renderer changed while reading: ${file}`)
      files.push({ file: name, sha256: hash, identity: after })
    }
  }
  walk(directory)
  return { directories, files }
}

function runCommand(command, { cwd, env, sandboxSource }) {
  // No unsandboxed fallback, including failures to initialize the policy.
  assertUnaliased(command.executable)
  // The retained policy file is audit evidence, never a mutable launch input.
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', sandboxSource, command.executable, ...command.args], { cwd, env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr ||
      `${command.label} failed (status ${result.status}, signal ${result.signal || 'none'})`)
  }
  if (!command.capture) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

// Test doubles execute no tools. Production uses the installed CLIs only.
export function executePreview(plan, { run = runCommand, environment = process.env,
  archive } = {}) {
  const admittedInputs = inspectPreviewInputs(plan.root)
  const before = preflightPreview(plan)
  assertUnaliased(plan.workspace)
  if ([plan.renderer, plan.configFile, plan.viteConfigFile, plan.envDirectory, plan.snapshotRoot,
    plan.sandboxFile, plan.toolHome, plan.toolTemp].some(exists)) {
    throw new Error('Preview workspace is not fresh')
  }
  const workspaceStat = fs.statSync(plan.workspace)
  let outputStat, result, failure, inputGraph, sandboxSource
  const stable = (file, expected) => {
    assertUnaliased(file)
    const actual = fs.statSync(file)
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isDirectory()) {
      throw new Error(`Preview path changed: ${file}`)
    }
  }
  const guard = () => {
    if (json(inspectPreviewInputs(plan.root)) !== json(admittedInputs)) throw new Error('Build input identity changed after metadata admission; refusing the next tool')
    stable(plan.workspace, workspaceStat)
    if (outputStat) stable(plan.output, outputStat)
    assertUnaliased(plan.envDirectory)
    assertUnaliased(plan.renderer, { missing: true })
    assertUnaliased(plan.bundle, { missing: true })
    if (inputGraph) verifyPreviewSnapshot(plan, inputGraph)
    if (exists(path.join(plan.root, 'electron-builder.env'))) {
      throw new Error('Refusing automatic credential-file reads: electron-builder.env exists')
    }
  }
  try {
    fs.writeFileSync(plan.configFile, json(plan.config), { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(plan.viteConfigFile, plan.viteConfigSource, { flag: 'wx', mode: 0o600 })
    fs.mkdirSync(plan.envDirectory, { mode: 0o700 })
    fs.mkdirSync(plan.toolHome, { mode: 0o700 })
    fs.mkdirSync(plan.toolTemp, { mode: 0o700 })
    fs.writeFileSync(path.join(plan.workspace, 'original-before.json'), json(before), { flag: 'wx', mode: 0o600 })
    // Exclusive reservation: never reuse an existing output, including after failure.
    fs.mkdirSync(plan.output, { mode: 0o700 })
    outputStat = fs.statSync(plan.output)
    inputGraph = materializePreviewInputs(plan, admittedInputs)
    sandboxSource = previewBuildSandbox(plan)
    fs.writeFileSync(plan.sandboxFile, sandboxSource, { flag: 'wx', mode: 0o600 })
    const env = { ...previewEnvironment(environment), HOME: plan.toolHome, TMPDIR: plan.toolTemp,
      TMP: plan.toolTemp, TEMP: plan.toolTemp }
    const invoke = command => { guard(); const output = run(command, { cwd: plan.snapshotRoot,
      env, sandboxFile: plan.sandboxFile, sandboxSource }); guard(); return output }
    invoke(plan.commands[0])
    const retainedRenderer = rendererSnapshot(plan.renderer)
    const rendererFiles = retainedRenderer.files.map(({ file, sha256 }) => ({ file, sha256 }))
    if (!rendererFiles.some(file => file.file === 'index.html')) throw new Error('Renderer index.html missing')
    invoke(plan.commands[1])
    const asar = path.join(plan.bundle, 'Contents/Resources/app.asar')
    assertUnaliased(asar)
    const packagedArchive = archive || require('@electron/asar')
    for (const file of rendererFiles) {
      if (sha256(packagedArchive.extractFile(asar, `dist/${file.file}`)) !== file.sha256) {
        throw new Error(`Packaged renderer differs from temporary build: ${file.file}`)
      }
    }
    invoke(plan.commands[2])
    invoke(plan.commands[3])
    const signature = invoke(plan.commands[4])
    const entitlements = invoke(plan.commands[5])
    assertSignature(signature, entitlements)
    if (json(retainedRenderer) !== json(rendererSnapshot(plan.renderer))) throw new Error('Retained renderer changed during packaging')
    result = { bundle: plan.bundle, output: plan.output, rendererDirectory: plan.renderer, rendererFiles,
      provenanceVersion: 1, rendererSnapshot: retainedRenderer,
      rendererManifestSha256: sha256(Buffer.from(JSON.stringify(retainedRenderer))),
      asarSha256: sha256(fs.readFileSync(asar)), asarIdentity: previewFileIdentity(asar),
      inputAdmissionSha256: sha256(Buffer.from(JSON.stringify(admittedInputs))),
      sourceSnapshot: inputGraph, sourceSnapshotSha256: sha256(Buffer.from(JSON.stringify(inputGraph))),
      buildSandboxSha256: sha256(Buffer.from(sandboxSource)),
      electronVersion: plan.config.electronVersion,
      buildConfigSha256: sha256(fs.readFileSync(plan.configFile)),
      entitlementsSha256: sha256(fs.readFileSync(plan.entitlements)),
      originalBefore: before, signature, signedEntitlements: entitlements }
  } catch (error) { failure = error }
  finally {
    try {
      const after = archiveIdentity(plan.originalArchive)
      stable(plan.workspace, workspaceStat)
      fs.writeFileSync(path.join(plan.workspace, 'original-after.json'), json(after), { flag: 'wx', mode: 0o600 })
      if (json(before) !== json(after)) throw new Error('Original archive identity changed during preview build')
      if (result) result.originalAfter = after
    } catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error }
  }
  if (failure) throw failure
  guard()
  const evidence = path.join(plan.output, 'completion-preview.json')
  const evidenceBytes = json(result)
  fs.writeFileSync(evidence, evidenceBytes, { flag: 'wx', mode: 0o600 })
  // Independent local builder receipt, outside the candidate bundle/output.
  // The smoke route pins these exact evidence bytes and filesystem identities.
  const receipt = path.join(plan.workspace, 'completion-preview-receipt.json')
  fs.writeFileSync(receipt, json({ provenanceVersion: 1, evidence, bundle: plan.bundle,
    evidenceSha256: sha256(Buffer.from(evidenceBytes)), evidenceIdentity: previewFileIdentity(evidence),
    rendererManifestSha256: result.rendererManifestSha256, asarSha256: result.asarSha256 }),
  { flag: 'wx', mode: 0o600 })
  return { ...result, evidence, receipt }
}

export function main(args = process.argv.slice(2)) {
  const { dryRun } = parsePreviewArgs(args)
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Preview packaging requires macOS arm64')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (root !== REPO) throw new Error(`Preview script must run from ${REPO}`)
  inspectPreviewInputs(root) // Before reading package/config data or resolving build tools.
  const electronPackagePath = require.resolve('electron/package.json')
  const inputs = { root, buildConfig: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build,
    electronDist: path.join(path.dirname(electronPackagePath), 'dist'),
    electronVersion: JSON.parse(fs.readFileSync(electronPackagePath, 'utf8')).version,
    builderCli: require.resolve('electron-builder/cli.js'),
    viteCli: path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js') }
  const tempRoot = fs.realpathSync('/tmp')
  const dryPlan = createPreviewPlan({ ...inputs, workspace: path.join(tempRoot, 'hd-completion-preview-DRY-RUN') })
  const before = preflightPreview(dryPlan)
  if (dryRun) {
    const after = archiveIdentity(dryPlan.originalArchive)
    if (json(before) !== json(after)) throw new Error('Original archive changed during dry-run')
    console.log(json({ dryRun: true, ...dryPlan, originalBefore: before, originalAfter: after,
      note: 'No commands or writes performed. Workspace is a placeholder; real execution allocates a unique directory.' }))
    return
  }
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'hd-completion-preview-'))
  console.log(`Preview workspace retained for provenance (also on failure): ${workspace}`)
  const result = executePreview(createPreviewPlan({ ...inputs, workspace }))
  console.log(json(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
