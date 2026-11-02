'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const tree = require('./self-modification-artifact.cjs')
const build = require('./self-modification-build.cjs')
const authorityChecks = require('./self-modification-authority.cjs')
const sealInputs = require('./self-modification-seal.cjs')
const boundBuilds = require('./self-modification-bound-build.cjs')
const nativeInputs = require('./self-modification-native-inputs.cjs')
const { identity } = require('./self-modification-schema.cjs')
const fail = (code, message) => { throw Object.assign(new Error(message), { validationCode: code }) }

function createValidationManager(userDataDir, controller, workspace, { hermesHome, confirm,
  getTools = build.tools, command = build.command, openPreview, observeAuthority = authorityChecks.observe,
  createSeal = sealInputs.create, runBoundBuild = boundBuilds.run } = {}) {
  const active = new Map(), previews = new Map()
  const userIdentity = tree.directory(userDataDir)
  const store = path.join(userDataDir, 'self-modification')
  const storeIdentity = tree.directory(store)
  let pending = false
  function storage() {
    if (!tree.same(userIdentity, tree.directory(userDataDir)) || !tree.same(storeIdentity, tree.directory(store)))
      fail('ownership', 'Check storage ownership changed. Existing work was retained.')
  }
  function current(id, attemptId) {
    storage()
    const snapshot = controller.list()
    if (!snapshot.ok) fail(snapshot.code, snapshot.error)
    const change = snapshot.changes.find(item => item.id === id), attempt = change?.attempts.at(-1)
    if (!identity(id) || !identity(attemptId) || attempt?.id !== attemptId) fail('stale', 'The check attempt changed.')
    return { snapshot, change, attempt }
  }
  function fence(id, attemptId, epoch, operationId, signal, states = ['checking']) {
    const { change, attempt } = current(id, attemptId)
    if (signal?.aborted || !states.includes(attempt.state) || attempt.epoch !== epoch ||
        change.cancellationEpoch !== epoch || attempt.validation?.operationId !== operationId)
      fail('stale', 'Checks were cancelled or superseded.')
    return attempt
  }
  function checkpoint(id, attemptId, epoch, operationId, outcome) {
    const result = controller.checkpointValidation(id, attemptId, epoch, operationId, outcome)
    if (!result.ok) fail(result.code, result.error)
  }
  function ownerGone(pid) {
    if (pid === process.pid) return true // No matching owned in-memory job.
    try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }
  const jobRoot = operationId => path.join(store, `check-${operationId}`)
  function owned(validation) {
    storage()
    const root = jobRoot(validation.operationId)
    tree.directory(root)
    const owner = JSON.parse(tree.readFile(path.join(root, 'owner.json'), 4096).bytes)
    if (owner.operationId !== validation.operationId || owner.sourceDigest !== validation.sourceDigest)
      fail('ownership', 'Check ownership could not be verified.')
    return root
  }
  async function artifact(validation) {
    const root = owned(validation), record = validation.artifact
    if (!record) fail('invalid', 'No sealed renderer artifact exists.')
    const folder = path.join(root, 'artifact')
    if (!tree.same(record, tree.directory(folder))) fail('ownership', 'Artifact root changed.')
    const owner = JSON.parse(tree.readFile(path.join(root, 'artifact-owner.json'), 4096).bytes)
    if (owner.id !== record.id || owner.token !== record.token) fail('ownership', 'Artifact ownership changed.')
    const captured = await tree.capture(folder, { maxFile: 16 * 1024 * 1024 })
    if (captured.digest !== record.digest || captured.files.length !== record.fileCount)
      fail('stale', 'The sealed renderer artifact changed. It cannot be previewed.')
    return { folder, manifest: captured.manifest }
  }
  async function sealed(validation, check = () => storage()) {
    const seal = validation.seal, record = seal?.artifact
    if (seal?.stage !== 'sealed' || !record) fail('invalid', 'No acknowledged full app-input seal exists.')
    storage()
    const root = path.join(store, `seal-${seal.operationId}`)
    const pinned = tree.directory(root), ownerFile = path.join(root, 'owner.json')
    const ownerBytes = tree.readFile(ownerFile, 4096).bytes, owner = JSON.parse(ownerBytes)
    if (owner.operationId !== seal.operationId || owner.id !== record.id || owner.token !== record.token ||
        owner.sourceDigest !== seal.sourceDigest) fail('ownership', 'App-input seal ownership changed.')
    const folder = path.join(root, 'artifact')
    if (!tree.same(record, tree.directory(folder))) fail('ownership', 'App-input seal root changed.')
    const guarded = () => {
      check()
      if (!tree.same(pinned, tree.directory(root))) fail('ownership', 'Seal parent ownership changed.')
    }
    const captured = await sealInputs.capture(folder, { allowLinks: true, check: guarded })
    const provenance = tree.readFile(path.join(folder, 'provenance.json'), 4096).bytes
    if (captured.digest !== record.digest || captured.manifest.length !== record.entries || captured.bytes !== record.bytes ||
        tree.sha(provenance) !== record.provenanceDigest) fail('stale', 'Sealed app inputs changed. They cannot be reused.')
    guarded()
    if (!tree.readFile(ownerFile, 4096).bytes.equals(ownerBytes)) fail('ownership', 'Seal owner changed during verification.')
    return folder
  }
  async function boundRenderer(validation, check = () => storage()) {
    const record = validation.boundBuild, a = record?.artifact
    if (record?.stage !== 'passed' || !a) fail('invalid', 'No acknowledged sealed-graph renderer exists.')
    await sealed(validation, check)
    const root = path.join(store, `bound-${record.operationId}`), pinned = tree.directory(root)
    const ownerBytes = tree.readFile(path.join(root, 'owner.json'), 4096).bytes, owner = JSON.parse(ownerBytes)
    if (owner.operationId !== record.operationId || owner.id !== a.id || owner.token !== a.token ||
        owner.inputDigest !== record.inputDigest) fail('ownership', 'Bound renderer ownership changed.')
    const folder = path.join(root, 'artifact')
    if (!tree.same(a, tree.directory(folder))) fail('ownership', 'Bound renderer root changed.')
    const guarded = () => { check(); if (!tree.same(pinned, tree.directory(root))) fail('ownership', 'Bound build parent changed.') }
    const output = await tree.capture(folder, { maxFile: 16 * 1024 * 1024, check: guarded })
    if (output.digest !== a.rendererDigest || output.files.length !== a.fileCount ||
        boundBuilds.binding(record.inputDigest, record.sourceDigest, record.dependencyDigest, output.digest,
          record.toolchainDigest) !== a.boundDigest) fail('stale', 'Bound renderer or build identity changed.')
    guarded()
    if (!tree.readFile(path.join(root, 'owner.json'), 4096).bytes.equals(ownerBytes))
      fail('ownership', 'Bound renderer owner changed.')
    return { folder, manifest: output.manifest, artifact: { ...a, digest: a.rendererDigest } }
  }
  async function candidate(id, attemptId, signal) {
    const root = await workspace.candidateRoot(id, attemptId)
    const result = await tree.capture(root, { check: () => { storage(); if (signal?.aborted) fail('stale', 'Checks cancelled.') } })
    if (result.files.some(file => file.path.split('/')[0] === 'node_modules'))
      fail('invalid', 'Candidate node_modules are not a trusted build toolchain.')
    const pkg = result.files.find(file => file.path === 'package.json')
    if (!pkg || JSON.parse(pkg.bytes).name !== 'hermes-desk' || !result.files.some(file => file.path === 'index.html') ||
        !result.files.some(file => file.path.startsWith('src/') && /\.(tsx?|jsx?)$/.test(file.path)))
      fail('invalid', 'Renderer checks require a Hermes Desk package, index.html and renderer source.')
    // Fixed plugins accept CSS, not candidate JS configuration. Every candidate
    // stylesheet is inspected, and imports cannot evade that inspection by
    // naming arbitrary extensions or shadowing the provisioned Tailwind sheet.
    const names = new Set(result.files.map(file => file.path))
    for (const file of result.files.filter(file => /\.(css|pcss|postcss|scss|sass|less|styl|stylus|sss)$/i.test(file.path))) {
      const text = file.bytes.toString('utf8')
      if (/@(?:config|plugin)\b/i.test(text) || /@[A-Za-z0-9_-]*\\/.test(text))
        fail('invalid', 'Scoped renderer builds do not accept Tailwind JavaScript directives or escaped at-rules.')
      for (const directive of text.matchAll(/@import\b([^;]*)(?:;|$)/gi)) {
        const quoted = /^\s*(["'])([^"']+)\1/.exec(directive[1])
        if (!quoted) fail('invalid', 'Scoped CSS imports require a quoted inspected stylesheet.')
        const target = quoted[2]
        if (target === 'tailwindcss') {
          const shadow = path.posix.join(path.posix.dirname(file.path), target)
          if ([...names].some(name => name === shadow || name.startsWith(shadow + '/')))
            fail('invalid', 'Candidate CSS cannot shadow the provisioned Tailwind stylesheet.')
        } else {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target))
          if (!target.startsWith('.') || !target.endsWith('.css') || !names.has(resolved))
            fail('invalid', 'Scoped CSS imports must name inspected relative .css files or provisioned tailwindcss.')
        }
      }
    }
    return result
  }
  async function execute(id, attemptId, initial, runtime, validation, signal) {
    const { operationId } = validation, epoch = current(id, attemptId).attempt.epoch
    const check = () => fence(id, attemptId, epoch, operationId, signal)
    const root = jobRoot(operationId)
    try {
      check(); storage()
      fs.mkdirSync(root, { mode: 0o700 })
      fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ operationId, sourceDigest: initial.digest }),
        { mode: 0o600, flag: 'wx' })
      const work = path.join(root, 'work'), controls = path.join(root, 'controls')
      fs.mkdirSync(work, { mode: 0o700 }); fs.mkdirSync(controls, { mode: 0o700 })
      const job = { root, work, controls, source: path.join(work, 'source'), home: path.join(work, 'home'),
        output: path.join(work, 'output'), runtime }
      fs.mkdirSync(job.home, { mode: 0o700 })
      tree.materialize(job.source, initial.files)
      const config = build.writeConfig(job)
      // Neither candidate tsconfig nor package scripts select mandatory checks.
      await command(job, runtime, [runtime.typescript, '-p', config], signal)
      check()
      for (const file of initial.files.filter(file => /\.(?:cjs|mjs|js)$/.test(file.path))) {
        check()
        await command(job, runtime, ['--check', path.join(job.source, file.path)], signal)
      }
      check()
      checkpoint(id, attemptId, epoch, operationId, { stage: 'building', checksPassed: true })
      await command(job, runtime, [runtime.vite, 'build', '--config', job.viteConfig, '--configLoader', 'native'], signal)
      check()
      if (fs.realpathSync(path.join(job.source, 'node_modules')) !== runtime.dependencies)
        fail('ownership', 'Build dependency link changed.')
      const after = await tree.capture(job.source, { exclude: ['node_modules'], check })
      if (after.digest !== initial.digest) fail('stale', 'Untrusted build code changed its source snapshot. Checks were not accepted.')
      await command(job, runtime, [runtime.typescript, '-p', config], signal)
      check()
      const latest = await candidate(id, attemptId, signal)
      if (latest.digest !== initial.digest) fail('stale', 'Candidate changed during checks. No artifact was accepted.')
      const output = await tree.capture(job.output, { maxFile: 16 * 1024 * 1024, check })
      if (!output.files.some(file => file.path === 'index.html')) fail('invalid', 'Build did not produce a renderer entry.')
      const folder = path.join(root, 'artifact')
      tree.materialize(folder, output.files)
      const stat = tree.directory(folder)
      const record = { id: randomUUID(), token: randomUUID(), dev: stat.dev, ino: stat.ino,
        digest: output.digest, sourceDigest: initial.digest, toolchainDigest: runtime.digest,
        fileCount: output.files.length, scope: 'renderer-only', activationEligible: false }
      fs.writeFileSync(path.join(root, 'artifact-owner.json'), JSON.stringify({ id: record.id, token: record.token }),
        { mode: 0o600, flag: 'wx' })
      check()
      checkpoint(id, attemptId, epoch, operationId, { stage: 'checked', artifact: record })
    } catch (error) {
      try {
        check()
        checkpoint(id, attemptId, epoch, operationId, { stage: 'failed', error: error.validationCode ? error.message :
          'Scoped renderer checks or sandboxed build failed. Candidate work was retained; no full app was validated or activated.' })
      } catch { /* Unknown final acknowledgment is retained for recovery, never replayed. */ }
    } finally { active.delete(operationId) }
  }
  async function result(action) {
    try { return await action() } catch (error) {
      return { ok: false, code: error.validationCode || 'storage', error: error.validationCode ? error.message :
        'Renderer checks or preview could not proceed. Existing work was retained.' }
    }
  }
  async function executeAuthority(id, attemptId, initial, runtime, validation, authority, epoch, signal) {
    const check = () => {
      const attempt = fence(id, attemptId, epoch, validation.operationId, signal, ['checked'])
      if (attempt.validation.authority?.operationId !== authority.operationId || attempt.validation.authority.stage !== 'running')
        fail('stale', 'Authority observations no longer own this attempt.')
    }
    const save = outcome => {
      const result = controller.checkpointAuthority(id, attemptId, epoch, validation.operationId, authority.operationId, outcome)
      if (!result.ok) fail(result.code, result.error)
    }
    try {
      check(); await artifact(validation); check()
      const root = path.join(store, `authority-${authority.operationId}`)
      fs.mkdirSync(root, { mode: 0o700 })
      const work = path.join(root, 'work'), controls = path.join(root, 'controls')
      fs.mkdirSync(work, { mode: 0o700 }); fs.mkdirSync(controls, { mode: 0o700 })
      const job = { root, work, controls, source: path.join(work, 'source'), home: path.join(work, 'home') }
      fs.mkdirSync(job.home, { mode: 0o700 })
      tree.materialize(job.source, initial.files)
      const trace = await observeAuthority(job, runtime, signal)
      check()
      const verdicts = authorityChecks.evaluate(trace)
      if (verdicts.some(check => !check.passed)) fail('invalid', 'Independent main/preload fixture contracts failed. No native behavior or full app qualification was established.')
      const latest = await candidate(id, attemptId, signal)
      const after = await tree.capture(job.source, { check })
      if (latest.digest !== initial.digest || after.digest !== initial.digest ||
          authorityChecks.definitionDigest() !== authority.definitionDigest)
        fail('stale', 'Source or trusted contract definitions changed. Observations were not accepted.')
      await artifact(validation); check()
      save({ stage: 'passed', observationDigest: tree.sha(JSON.stringify(trace)), checks: verdicts.length })
    } catch (error) {
      try { check(); save({ stage: 'failed', error: error.validationCode ? error.message :
        'Isolated main/preload fixture contracts failed or were interrupted. Work was retained, not qualified for activation.' }) }
      catch { /* Retain unknown acknowledgment; recovery never replays candidate code. */ }
    } finally { active.delete(authority.operationId) }
  }
  async function executeSeal(id, attemptId, initial, renderer, runtime, input, validation, seal, epoch, signal) {
    const deadline = Date.now() + 180000
    let lastFence = 0
    const check = (force = false) => {
      storage()
      if (signal.aborted) fail('stale', 'App-input sealing was interrupted or superseded.')
      if (Date.now() > deadline) fail('limit', 'App-input sealing exceeded its three-minute deadline. Partial work was retained.')
      // Synchronous chunks cannot dispatch main IPC. Reconcile at most every
      // 50ms while copying; force the fence at the intent/commit boundaries.
      if (!force && Date.now() - lastFence < 50) return
      lastFence = Date.now()
      const attempt = fence(id, attemptId, epoch, validation.operationId, signal, ['checked'])
      if (attempt.validation.seal?.operationId !== seal.operationId ||
          attempt.validation.seal.stage !== 'sealing') fail('stale', 'App-input sealing was interrupted or superseded.')
    }
    const save = outcome => {
      const result = controller.checkpointSeal(id, attemptId, epoch, validation.operationId, seal.operationId, outcome)
      if (!result.ok) fail(result.code, result.error)
    }
    try {
      check(true)
      const root = path.join(store, `seal-${seal.operationId}`), artifactId = randomUUID(), token = randomUUID()
      fs.mkdirSync(root, { mode: 0o700 })
      const pinned = tree.directory(root), folder = path.join(root, 'artifact')
      const guarded = () => { check(); if (!tree.same(pinned, tree.directory(root))) fail('ownership', 'Seal storage changed.') }
      fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ operationId: seal.operationId,
        id: artifactId, token, sourceDigest: initial.digest }), { mode: 0o600, flag: 'wx' })
      const output = await createSeal(folder, initial, renderer, runtime, input, guarded)
      guarded()
      if ((await candidate(id, attemptId, signal)).digest !== initial.digest ||
          (await sealInputs.provenance(getTools(hermesHome()), guarded)).dependencies.digest !== seal.dependencyDigest ||
          getTools(hermesHome()).digest !== seal.toolchainDigest) fail('stale', 'Source or provisioned dependencies changed during sealing.')
      await artifact(validation); guarded()
      if (authorityChecks.definitionDigest() !== validation.authority.definitionDigest)
        fail('stale', 'Trusted authority definitions changed during sealing.')
      const record = { id: artifactId, token, ...output.root, digest: output.digest, provenanceDigest: output.provenanceDigest,
        entries: output.manifest.length, bytes: output.bytes, activationEligible: false }
      await sealed({ ...validation, seal: { ...seal, stage: 'sealed', artifact: record } }, guarded)
      guarded(); check(true)
      save({ stage: 'sealed', artifact: record })
    } catch (error) {
      try {
        // The expired work deadline cannot forbid recording its known failure.
        // Cancellation, storage and exact-attempt ownership still fence the write.
        const latest = fence(id, attemptId, epoch, validation.operationId, signal, ['checked'])
        if (latest.validation.seal?.operationId !== seal.operationId || latest.validation.seal.stage !== 'sealing')
          fail('stale', 'App-input sealing was interrupted or superseded.')
        save({ stage: 'failed', error: error.validationCode ? error.message :
          'Full app-input sealing failed or its acknowledgment was lost. Work was retained, never activated.' })
      }
      catch { /* Retain uncertain sealing; no retry, cleanup or acceptance. */ }
    } finally { active.delete(seal.operationId) }
  }
  async function executeBoundBuild(id, attemptId, initial, inputFolder, runtime, validation, record, epoch, signal) {
    let lastFence = 0
    const check = (force = false) => {
      storage()
      if (signal.aborted) fail('stale', 'Bound checks were cancelled.')
      if (!force && Date.now() - lastFence < 50) return
      lastFence = Date.now()
      const attempt = fence(id, attemptId, epoch, validation.operationId, signal, ['checked'])
      if (attempt.validation.boundBuild?.operationId !== record.operationId || attempt.validation.boundBuild.stage !== 'checking')
        fail('stale', 'Bound checks were cancelled or superseded.')
    }
    const save = outcome => {
      const result = controller.checkpointBoundBuild(id, attemptId, epoch, validation.operationId, record.operationId, outcome)
      if (!result.ok) fail(result.code, result.error)
    }
    try {
      check(true)
      const root = path.join(store, `bound-${record.operationId}`), artifactId = randomUUID(), token = randomUUID()
      fs.mkdirSync(root, { mode: 0o700 })
      const pinned = tree.directory(root)
      const guarded = (force = false) => { check(force); if (!tree.same(pinned, tree.directory(root))) fail('ownership', 'Bound job changed.') }
      fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ operationId: record.operationId, id: artifactId, token,
        inputDigest: record.inputDigest }), { flag: 'wx', mode: 0o600 })
      const output = await runBoundBuild(root, inputFolder, initial, runtime, record, signal, guarded, command)
      guarded(true)
      if ((await candidate(id, attemptId, signal)).digest !== initial.digest ||
          getTools(hermesHome(), runtime.dependencies).digest !== record.toolchainDigest)
        fail('stale', 'Source or copied build policy changed.')
      const artifact = { id: artifactId, token, ...output.root, rendererDigest: output.digest, boundDigest: output.boundDigest,
        fileCount: output.files.length, activationEligible: false }
      await boundRenderer({ ...validation, boundBuild: { ...record, stage: 'passed', artifact } }, guarded)
      guarded(true); save({ stage: 'passed', artifact })
    } catch (error) {
      try { check(); save({ stage: 'failed', error: error.validationCode ? error.message :
        'Checks against the sealed graph failed or were interrupted. No native behavior or activation was qualified.' }) }
      catch { /* Unknown outcome is retained, never replayed. */ }
    } finally { active.delete(record.operationId) }
  }
  const manager = {
    // Trusted controller use only; never exposed as a path-valued IPC.
    qualificationInputs: async (revision, id, attemptId, check = () => {}) => {
      const before = current(id, attemptId)
      if (before.snapshot.revision !== revision || before.attempt.state !== 'checked' ||
        before.attempt.validation?.boundBuild?.stage !== 'passed' || active.size || pending || previews.size)
        fail('stale', 'An idle acknowledged bound build at the exact journal revision is required.')
      const initial = await candidate(id, attemptId)
      if (initial.digest !== before.attempt.validation.sourceDigest) fail('stale', 'Checked source mutated.')
      const source = path.join(await sealed(before.attempt.validation, check), 'app')
      const renderer = await boundRenderer(before.attempt.validation, check)
      check()
      if (current(id, attemptId).snapshot.revision !== revision) fail('stale', 'Qualification inputs were superseded.')
      return { source, renderer: renderer.folder, sourceDigest: initial.digest,
        boundDigest: before.attempt.validation.boundBuild.artifact.boundDigest,
        inputDigest: before.attempt.validation.seal.artifact.digest, rendererDigest: renderer.artifact.digest }
    },
    validate: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'One check or renderer preview is already active.')
      pending = true
      try {
        const before = current(id, attemptId)
        if (before.attempt.state !== 'implemented' || before.snapshot.revision !== revision) fail('stale', 'Reload the implemented candidate.')
        const initial = await candidate(id, attemptId), runtime = getTools(hermesHome())
        const approved = await confirm({ kind: 'validate', sourceDigest: initial.digest, toolchainDigest: runtime.digest })
        authorize()
        if (!approved) return before.snapshot
        if ((await candidate(id, attemptId)).digest !== initial.digest) fail('stale', 'Candidate changed during confirmation.')
        const validation = { operationId: randomUUID(), ownerPid: process.pid, scope: 'renderer-only', stage: 'checking',
          sourceDigest: initial.digest, toolchainDigest: runtime.digest, checksPassed: false, artifact: null, preview: null,
          authority: null, seal: null, boundBuild: null, error: null }
        const started = controller.beginValidation(revision, id, attemptId, validation)
        if (!started.ok) return started
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 240000)
        active.set(validation.operationId, { id, attemptId, abort })
        void execute(id, attemptId, initial, runtime, validation, abort.signal).finally(() => clearTimeout(timer))
        return started
      } finally { pending = false }
    }),
    authority: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'One check or renderer preview is already active.')
      pending = true
      try {
        const before = current(id, attemptId), validation = before.attempt.validation
        if (before.snapshot.revision !== revision || before.attempt.state !== 'checked')
          fail('stale', 'Reload the checked candidate before authority contracts.')
        if (validation.authority !== null) fail('limit', 'Authority observations already exist; unknown work is not replayed.')
        if (validation.preview && ['opening', 'open'].includes(validation.preview.state))
          fail('limit', 'Close or recover the renderer display before authority checks.')
        await artifact(validation)
        const initial = await candidate(id, attemptId)
        if (initial.digest !== validation.sourceDigest) fail('stale', 'Candidate no longer matches checked source.')
        if (!['electron/main.cjs', 'electron/preload.cjs'].every(name => initial.files.some(file => file.path === name)))
          fail('invalid', 'Authority contracts require candidate electron/main.cjs and electron/preload.cjs.')
        const runtime = getTools(hermesHome()), definitions = authorityChecks.definitionDigest()
        const approved = await confirm({ kind: 'authority', sourceDigest: initial.digest, definitionDigest: definitions })
        authorize()
        if (!approved) return controller.list()
        if ((await candidate(id, attemptId)).digest !== initial.digest) fail('stale', 'Candidate changed during contract confirmation.')
        await artifact(validation)
        const authority = { operationId: randomUUID(), ownerPid: process.pid, scope: authorityChecks.SCOPE, stage: 'running',
          sourceDigest: initial.digest, rendererDigest: validation.artifact.digest, definitionDigest: definitions,
          observationDigest: null, checks: null, nativeBehaviorVerified: false, fullAppQualified: false, error: null }
        const started = controller.beginAuthority(revision, id, attemptId, authority)
        if (!started.ok) return started
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 40000)
        active.set(authority.operationId, { id, attemptId, abort })
        void executeAuthority(id, attemptId, initial, runtime, validation, authority, before.attempt.epoch, abort.signal)
          .finally(() => clearTimeout(timer))
        return started
      } finally { pending = false }
    }),
    seal: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'One check, seal or display is already active.')
      pending = true
      try {
        const before = current(id, attemptId), validation = before.attempt.validation
        let lastFence = 0
        const deadline = Date.now() + 120000
        const check = (force = false) => {
          storage()
          if (Date.now() > deadline) fail('limit', 'Seal inspection expired. No seal work was authorized.')
          if (!force && Date.now() - lastFence < 50) return
          lastFence = Date.now()
          const now = current(id, attemptId)
          if (now.snapshot.revision !== revision || now.attempt.state !== 'checked')
            fail('stale', 'Reload the checked candidate before sealing.')
        }
        check(true)
        if (validation.seal) {
          if (validation.seal.stage !== 'sealed') fail('limit', 'Unknown or failed seal work is not replayed.')
          await sealed(validation, check)
          if ((await candidate(id, attemptId)).digest !== validation.sourceDigest) fail('stale', 'Candidate changed after sealing.')
          authorize(); check(true)
          return controller.list()
        }
        if (validation.authority?.stage !== 'passed') fail('invalid', 'Run the independent authority fixture contracts before sealing.')
        if (validation.authority.definitionDigest !== authorityChecks.definitionDigest())
          fail('stale', 'Trusted contract definitions changed; old observations cannot qualify a new seal.')
        if (['opening', 'open'].includes(validation.preview?.state ?? ''))
          fail('limit', 'Close or recover the display before sealing.')
        const initial = await candidate(id, attemptId)
        if (initial.digest !== validation.sourceDigest) fail('stale', 'Candidate no longer matches checked source.')
        if (initial.files.some(file => file.path === 'dist' || file.path.startsWith('dist/')) ||
            JSON.parse(initial.files.find(file => file.path === 'package.json').bytes).main !== 'electron/main.cjs')
          fail('invalid', 'Full app inputs require the fixed electron/main.cjs entry and no candidate dist output.')
        const artifactFolder = (await artifact(validation)).folder
        const renderer = await tree.capture(artifactFolder, { maxFile: 16 * 1024 * 1024, check })
        const runtime = getTools(hermesHome())
        if (runtime.digest !== validation.toolchainDigest) fail('stale', 'Provisioned build identity changed; old checks cannot qualify a new seal.')
        const input = await sealInputs.provenance(runtime, check)
        const approved = await confirm({ kind: 'seal', sourceDigest: initial.digest, rendererDigest: renderer.digest,
          dependencyDigest: input.dependencies.digest, dependencyBytes: input.dependencies.bytes })
        authorize(); check(true)
        if (!approved) return controller.list()
        if ((await candidate(id, attemptId)).digest !== initial.digest ||
            (await sealInputs.provenance(runtime, check)).dependencies.digest !== input.dependencies.digest ||
            getTools(hermesHome()).digest !== runtime.digest) fail('stale', 'Source or dependencies changed during seal confirmation.')
        await artifact(validation); check(true)
        const seal = { operationId: randomUUID(), ownerPid: process.pid, scope: 'full-app-inputs', stage: 'sealing',
          sourceDigest: initial.digest, rendererDigest: renderer.digest, toolchainDigest: runtime.digest,
          dependencyDigest: input.dependencies.digest, artifact: null, fullAppQualified: false, error: null }
        const started = controller.beginSeal(revision, id, attemptId, seal)
        if (!started.ok) return started
        const abort = new AbortController()
        active.set(seal.operationId, { id, attemptId, abort })
        void executeSeal(id, attemptId, initial, renderer, runtime, input, validation, seal, before.attempt.epoch, abort.signal)
        return started
      } finally { pending = false }
    }),
    boundBuild: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'One check, seal or display is already active.')
      pending = true
      try {
        const before = current(id, attemptId), validation = before.attempt.validation
        const deadline = Date.now() + 120000
        let lastFence = 0
        const check = (force = false) => {
          storage()
          if (Date.now() > deadline) fail('limit', 'Bound build inspection expired.')
          if (!force && Date.now() - lastFence < 50) return
          lastFence = Date.now()
          const now = current(id, attemptId)
          if (now.snapshot.revision !== revision || now.attempt.state !== 'checked') fail('stale', 'Reload before bound checks.')
        }
        check(true)
        if (validation.boundBuild) {
          if (validation.boundBuild.stage !== 'passed') fail('limit', 'Unknown or failed bound work is not replayed.')
          await boundRenderer(validation, check)
          if ((await candidate(id, attemptId)).digest !== validation.sourceDigest) fail('stale', 'Candidate changed after bound checks.')
          authorize(); check(true)
          return controller.list()
        }
        if (['opening', 'open'].includes(validation.preview?.state ?? '')) fail('limit', 'Close or recover the display before bound checks.')
        const inputFolder = await sealed(validation, check), initial = await candidate(id, attemptId)
        if (initial.digest !== validation.sourceDigest) fail('stale', 'Candidate no longer matches sealed source.')
        const runtime = getTools(hermesHome(), path.join(inputFolder, 'app/node_modules'))
        const approved = await confirm({ kind: 'boundBuild', inputDigest: validation.seal.artifact.digest,
          dependencyDigest: validation.seal.dependencyDigest })
        authorize(); check(true)
        if (!approved) return controller.list()
        await sealed(validation, check)
        if ((await candidate(id, attemptId)).digest !== initial.digest ||
            getTools(hermesHome(), runtime.dependencies).digest !== runtime.digest) fail('stale', 'Bound build inputs changed during confirmation.')
        check(true)
        const record = { operationId: randomUUID(), ownerPid: process.pid, scope: 'sealed-graph-renderer', stage: 'checking',
          inputDigest: validation.seal.artifact.digest, sourceDigest: initial.digest, dependencyDigest: validation.seal.dependencyDigest,
          toolchainDigest: runtime.digest, artifact: null, fullAppQualified: false, error: null }
        const started = controller.beginBoundBuild(revision, id, attemptId, record)
        if (!started.ok) return started
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 240000)
        active.set(record.operationId, { id, attemptId, abort })
        void executeBoundBuild(id, attemptId, initial, inputFolder, runtime, validation, record, before.attempt.epoch, abort.signal)
          .finally(() => clearTimeout(timer))
        return started
      } finally { pending = false }
    }),
    nativeInputs: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'Close active checks or display before inspecting native inputs.')
      pending = true
      try {
        const before = current(id, attemptId), validation = before.attempt.validation
        const deadline = Date.now() + 120000
        let lastFence = 0
        const check = (force = false) => {
          storage()
          if (Date.now() > deadline) fail('limit', 'Native input inspection expired.')
          if (!force && Date.now() - lastFence < 50) return
          lastFence = Date.now()
          const now = current(id, attemptId)
          if (now.snapshot.revision !== revision || now.attempt.state !== 'checked')
            fail('stale', 'Reload before inspecting bound native inputs.')
        }
        check(true)
        await boundRenderer(validation, check)
        const inputFolder = path.join(store, `seal-${validation.seal.operationId}`, 'artifact')
        const source = await tree.capture(path.join(inputFolder, 'app'), { exclude: ['dist', 'node_modules'], check })
        if (source.digest !== validation.sourceDigest ||
            (await candidate(id, attemptId)).digest !== validation.sourceDigest) fail('stale', 'Native source inputs changed.')
        const report = nativeInputs.inspect(source.files)
        await boundRenderer(validation, check)
        authorize(); check(true)
        return { ok: true, nativeInputs: { ...report, inputDigest: validation.seal.artifact.digest,
          sourceDigest: source.digest, boundDigest: validation.boundBuild.artifact.boundDigest } }
      } finally { pending = false }
    }),
    preview: (revision, id, attemptId, authorize = () => {}) => result(async () => {
      if (pending || active.size || previews.size) fail('limit', 'One check or renderer preview is already active.')
      pending = true
      let opened, previewId
      try {
        const before = current(id, attemptId), validation = before.attempt.validation
        if (before.attempt.state !== 'checked' || before.snapshot.revision !== revision) fail('stale', 'Reload the checked renderer artifact.')
        if (validation.authority?.stage === 'running')
          fail('limit', 'Pending authority observations must finish or recover before a display.')
        if (validation.seal?.stage === 'sealing') fail('limit', 'Pending app-input sealing must finish or recover before a display.')
        if (validation.boundBuild?.stage === 'checking') fail('limit', 'Pending bound checks must finish or recover before a display.')
        if (validation.seal?.stage === 'sealed' && validation.boundBuild?.stage !== 'passed') await sealed(validation)
        if (validation.preview && ['opening', 'open'].includes(validation.preview.state))
          fail('limit', 'An existing or uncertain preview must be closed or recovered before another display.')
        const sealedRenderer = validation.boundBuild?.stage === 'passed' ? await boundRenderer(validation) :
          { ...await artifact(validation), artifact: validation.artifact }
        if ((await candidate(id, attemptId)).digest !== validation.sourceDigest) fail('stale', 'Candidate no longer matches checked source.')
        const approved = await confirm({ kind: 'preview', artifactDigest: sealedRenderer.artifact.digest })
        authorize()
        if (!approved) return before.snapshot
        if (validation.boundBuild?.stage === 'passed') await boundRenderer(validation)
        else await artifact(validation)
        if ((await candidate(id, attemptId)).digest !== validation.sourceDigest)
          fail('stale', 'Candidate changed during preview confirmation.')
        const preview = { id: randomUUID(), ownerPid: process.pid, state: 'opening',
          artifactDigest: sealedRenderer.artifact.digest, rendererReady: false, behaviorVerified: false, error: null }
        const saved = controller.checkpointPreview(revision, id, attemptId, validation.operationId,
          validation.preview?.id ?? null, preview)
        if (!saved.ok) return saved
        previewId = preview.id
        const abort = new AbortController()
        previews.set(preview.id, { id, attemptId, close: () => { abort.abort(); opened?.close() } })
        const callback = (state, error = null) => {
          const now = current(id, attemptId)
          if (!['checked', 'failed', 'cancelled'].includes(now.attempt.state) || now.attempt.validation?.preview?.id !== preview.id) return
          controller.checkpointPreview(now.snapshot.revision, id, attemptId, validation.operationId, preview.id,
            { ...now.attempt.validation.preview, state, error })
        }
        opened = await openPreview({ id: preview.id, signal: abort.signal,
          readAsset: name => {
            storage(); owned(validation)
            if (!tree.same(sealedRenderer.artifact, tree.directory(sealedRenderer.folder))) fail('ownership', 'Artifact root changed.')
            return tree.readAsset(sealedRenderer.folder, sealedRenderer.manifest, name)
          },
          onFailure: () => {
            const now = current(id, attemptId)
            if (now.attempt.state === 'checked' && now.attempt.validation.preview?.id === preview.id)
              checkpoint(id, attemptId, now.attempt.epoch, validation.operationId,
                { stage: 'failed', preview: { ...now.attempt.validation.preview, state: 'closed',
                  error: 'Renderer preview was refused or terminated.' },
                  error: 'Renderer preview failed or its artifact changed. No behavior or app health was verified.' })
          },
          onClosed: () => { previews.delete(preview.id); callback('closed') } })
        const now = current(id, attemptId)
        fence(id, attemptId, before.attempt.epoch, validation.operationId, abort.signal, ['checked'])
        const ready = controller.checkpointPreview(now.snapshot.revision, id, attemptId, validation.operationId, preview.id,
          { ...preview, state: 'open', rendererReady: true })
        if (!ready.ok) { opened.close(); return ready }
        return ready
      } catch (error) { opened?.close(); if (previewId) previews.delete(previewId); throw error }
      finally { pending = false }
    }),
    cancel(id, attemptId) {
      for (const work of active.values()) if (work.id === id && work.attemptId === attemptId) work.abort.abort()
      for (const preview of previews.values()) if (preview.id === id && preview.attemptId === attemptId) preview.close()
    },
    recover() {
      const snapshot = controller.list()
      if (!snapshot.ok) return
      for (const change of snapshot.changes) {
        const attempt = change.attempts.at(-1), validation = attempt.validation
        if (!validation) continue
        const gone = ownerGone(validation.ownerPid)
        if (attempt.state === 'checking' && !active.has(validation.operationId) && gone)
          controller.checkpointValidation(change.id, attempt.id, attempt.epoch, validation.operationId,
            { stage: 'failed', error: 'Renderer checks were interrupted or their acknowledgment was lost. Work was retained, not resumed.' })
        const authority = validation.authority
        if (attempt.state === 'checked' && authority?.stage === 'running' &&
            !active.has(authority.operationId) && ownerGone(authority.ownerPid))
          controller.checkpointAuthority(change.id, attempt.id, attempt.epoch, validation.operationId, authority.operationId,
            { stage: 'failed', error: 'Authority fixture checks were interrupted or their acknowledgment was lost. Candidate code was not rerun.' })
        const seal = validation.seal
        if (attempt.state === 'checked' && seal?.stage === 'sealing' &&
            !active.has(seal.operationId) && ownerGone(seal.ownerPid))
          controller.checkpointSeal(change.id, attempt.id, attempt.epoch, validation.operationId, seal.operationId,
            { stage: 'failed', error: 'App-input sealing was interrupted or its acknowledgment was lost. Work was retained, not rebuilt.' })
        const bound = validation.boundBuild
        if (attempt.state === 'checked' && bound?.stage === 'checking' &&
            !active.has(bound.operationId) && ownerGone(bound.ownerPid))
          controller.checkpointBoundBuild(change.id, attempt.id, attempt.epoch, validation.operationId, bound.operationId,
            { stage: 'failed', error: 'Sealed-graph checks were interrupted or their acknowledgment was lost. Work was retained, not rebuilt.' })
        const p = validation.preview
        if (attempt.state === 'checked' && p && ['opening', 'open'].includes(p.state) && !previews.has(p.id) && ownerGone(p.ownerPid)) {
          const now = controller.list()
          if (now.ok) controller.checkpointPreview(now.revision, change.id, attempt.id, validation.operationId, p.id,
            { ...p, state: 'interrupted', error: 'Renderer preview ended with its owning process. It was not reopened or claimed verified.' })
        }
      }
    },
  }
  return manager
}

module.exports = { createValidationManager }
