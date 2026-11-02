'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { decodeJournal, identity, keys, text, validPreparation, validExecution, validValidation, validAuthority, validSeal, validBoundBuild } = require('./self-modification-schema.cjs')

const MAX_BYTES = 4 * 1024 * 1024
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino

function reject(code, message) {
  const error = new Error(message)
  error.changeCode = code
  throw error
}

/** Fixed app-owned storage. Only trusted internal transitions accept preparation
 * metadata; the renderer cannot write it or choose arbitrary lifecycle states. */
function createChangeController(userDataDir, io = fs, {readOnly=false}={}) {
  if (!path.isAbsolute(userDataDir)) throw new Error('Expected absolute app data directory')
  const directory = path.join(userDataDir, 'self-modification')
  const file = path.join(directory, 'changes.json')
  const lock = path.join(directory, 'writer.lock')
  let rootIdentity, directoryIdentity
  let seenJournal = false

  function directoryStat(name) {
    const stat = io.lstatSync(name)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid storage directory')
    return stat
  }
  function checkDirectory(create = false) {
    const root = directoryStat(userDataDir)
    if (rootIdentity && !same(rootIdentity, root)) throw new Error('App directory changed')
    rootIdentity ||= root
    let stat
    try { stat = directoryStat(directory) } catch (error) {
      if (error.code !== 'ENOENT' || directoryIdentity) throw error
      if (!create) return false
      io.mkdirSync(directory, { mode: 0o700 })
      stat = directoryStat(directory)
    }
    if (directoryIdentity && !same(directoryIdentity, stat)) throw new Error('Change directory changed')
    directoryIdentity ||= stat
    if (!same(rootIdentity, directoryStat(userDataDir))) throw new Error('App directory changed')
    return true
  }
  function read(name, max = MAX_BYTES) {
    const fd = io.openSync(name, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
    try {
      const stat = io.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error('Invalid storage file')
      const raw = io.readFileSync(fd, 'utf8')
      if (Buffer.byteLength(raw) > max || !same(stat, io.lstatSync(name))) throw new Error('Storage file changed')
      return { stat, raw }
    } finally { io.closeSync(fd) }
  }
  function current() {
    const empty = { journal: { version: 7, lifecycleVersion: 7, revision: 0, changes: [] }, stat: null }
    if (!checkDirectory()) return empty
    let result
    try { result = read(file) } catch (error) {
      if (error.code === 'ENOENT' && !seenJournal) return empty
      throw error
    }
    const journal = decodeJournal(result.raw)
    seenJournal = true
    checkDirectory()
    return { journal, stat: result.stat }
  }
  function acquire() {
    try { return io.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const previous = read(lock, 1024)
      const owner = JSON.parse(previous.raw)
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !identity(owner.nonce)) throw new Error('Unknown writer')
      let dead = false
      try { process.kill(owner.pid, 0) } catch (probe) { dead = probe.code === 'ESRCH' }
      checkDirectory()
      if (!dead || !same(previous.stat, io.lstatSync(lock))) throw new Error('Writer still owns lock')
      io.unlinkSync(lock)
      return io.openSync(lock, 'wx', 0o600)
    }
  }
  function close(fd) { if (fd !== undefined) { try { io.closeSync(fd) } catch { /* no replay after commit */ } } }
  function response(action) {
    try { return { ok: true, ...action() } } catch (error) {
      return { ok: false, code: error.changeCode || 'storage', error: error.changeCode ? error.message :
        'Change storage could not be read or saved. Existing records were retained. Check the app data directory; then reload.' }
    }
  }
  function mutate(revision, action) {
    return response(() => {
      if(readOnly)reject('unavailable','Passive qualification controller cannot mutate or recover state.')
      if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER)
        reject('invalid', 'Invalid change revision.')
      let lockFd, lockIdentity, tempFd, tempIdentity, temp, renameStarted = false, committed = false
      try {
        checkDirectory(true)
        lockFd = acquire()
        lockIdentity = io.fstatSync(lockFd)
        io.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }))
        io.fsyncSync(lockFd)
        const previous = current()
        if (previous.journal.revision !== revision) reject('stale', 'Changes were updated elsewhere. Reload before trying again.')
        const journal = previous.journal
        action(journal.changes)
        journal.revision++
        const raw = JSON.stringify(journal)
        decodeJournal(raw)
        if (Buffer.byteLength(raw) > MAX_BYTES) reject('limit', 'Change storage is full. No records were removed.')
        temp = path.join(directory, `changes.tmp-${randomUUID()}`)
        tempFd = io.openSync(temp, 'wx', 0o600)
        tempIdentity = io.fstatSync(tempFd)
        io.writeFileSync(tempFd, raw)
        io.fsyncSync(tempFd)
        io.closeSync(tempFd)
        tempFd = undefined
        checkDirectory()
        let target = null
        try { target = io.lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (previous.stat ? !same(previous.stat, target) : target !== null) throw new Error('Journal replaced')
        if (!same(lockIdentity, io.lstatSync(lock))) throw new Error('Writer ownership changed')
        if (!same(tempIdentity, io.lstatSync(temp))) throw new Error('Temporary journal changed')
        renameStarted = true
        io.renameSync(temp, file)
        committed = true
        seenJournal = true
        // Process-crash atomicity, not a promise about all hardware/power loss.
        let dirFd
        try { dirFd = io.openSync(directory, 'r'); io.fsyncSync(dirFd) }
        catch { /* rename committed; do not report failure and replay it */ }
        finally { close(dirFd) }
        return { revision: journal.revision, changes: journal.changes }
      } catch (error) {
        if (renameStarted && !committed)
          reject('uncertain', 'The save outcome is uncertain. Reload and review the journal before submitting again.')
        throw error
      } finally {
        close(tempFd)
        close(lockFd)
        // Never clean files after a detected parent/lock ownership replacement.
        try {
          checkDirectory()
          if (lockIdentity && same(lockIdentity, io.lstatSync(lock))) {
            if (temp && !committed) {
              try { if (same(tempIdentity, io.lstatSync(temp))) io.unlinkSync(temp) }
              catch { /* only this attempt's temporary file */ }
            }
            io.unlinkSync(lock)
          }
        } catch { /* preserve recoverable files; next mutation fails closed */ }
      }
    })
  }
  function selected(changes, id, attemptId, state) {
    if (!identity(id) || !identity(attemptId))
      reject('invalid', 'Invalid change or attempt identity.')
    const change = changes.find(item => item.id === id)
    const attempt = change?.attempts.at(-1)
    if (!attempt || attempt.id !== attemptId || !(Array.isArray(state) ? state : [state]).includes(attempt.state))
      reject('stale', 'This attempt is no longer current. Reload to review its status.')
    return { change, attempt }
  }
  function updateStatus(change, attempt, state) {
    attempt.state = state
    attempt.statusAt = new Date(Math.max(Date.now(), Date.parse(attempt.statusAt))).toISOString()
    change.updatedAt = attempt.statusAt
  }
  const controller = {
    list: () => response(() => {
      const { journal } = current()
      return { revision: journal.revision, changes: journal.changes }
    }),
    create: (revision, input) => mutate(revision, changes => {
      if (!keys(input, ['request', 'acceptanceCriteria']) || !text(input.request, 8000) || !text(input.acceptanceCriteria, 4000))
        reject('invalid', 'Add a request (up to 8,000 characters) and acceptance criteria (up to 4,000 characters).')
      if (changes.length >= 200) reject('limit', 'The 200-request limit was reached. No records were removed.')
      const now = new Date().toISOString()
      changes.push({ id: randomUUID(), request: input.request.trim(), acceptanceCriteria: input.acceptanceCriteria.trim(),
        createdAt: now, updatedAt: now, cancellationEpoch: 0,
        attempts: [{ id: randomUUID(), state: 'requested', epoch: 0, requestedAt: now, cancelledAt: null,
          statusAt: now, preparation: null, execution: null, validation: null }] })
    }),
    cancel: (revision, id, attemptId) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, ['requested', 'preparing', 'prepared', 'implementing', 'implemented', 'checking', 'checked', 'failed'])
      if (attempt.state !== 'failed') change.cancellationEpoch++
      updateStatus(change, attempt, 'cancelled')
      attempt.cancelledAt = attempt.statusAt
    }),
    reopen: (revision, id, attemptId) => mutate(revision, changes => {
      const { change } = selected(changes, id, attemptId, ['cancelled', 'failed'])
      if (change.attempts.length >= 50) reject('limit', 'The 50-attempt limit was reached. Submit a new request instead.')
      change.cancellationEpoch++
      change.updatedAt = new Date(Math.max(Date.now(), Date.parse(change.updatedAt))).toISOString()
      change.attempts.push({ id: randomUUID(), state: 'requested', epoch: change.cancellationEpoch,
        requestedAt: change.updatedAt, cancelledAt: null, statusAt: change.updatedAt, preparation: null, execution: null, validation: null })
    }),
    beginPreparation: (revision, id, attemptId, preparation) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'requested')
      if (!validPreparation(preparation) || preparation.workspace.dev !== null ||
          preparation.manifestDigest !== null || preparation.fileCount !== null || preparation.error !== null)
        reject('invalid', 'Invalid preparation plan.')
      attempt.preparation = preparation
      updateStatus(change, attempt, 'preparing')
    }),
    finishPreparation: (id, attemptId, epoch, operationId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, 'preparing')
        if (attempt.epoch !== epoch || change.cancellationEpoch !== epoch || attempt.preparation.operationId !== operationId)
          reject('stale', 'Preparation no longer owns this attempt.')
        attempt.preparation = { ...attempt.preparation, ...outcome }
        updateStatus(change, attempt, outcome.error ? 'failed' : 'prepared')
        if (outcome.error) change.cancellationEpoch++
      })
    },
    beginExecution: (revision, id, attemptId, execution) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'prepared')
      if (!validExecution(execution) || execution.stage !== 'running' || execution.calls !== 0 ||
          execution.outputDigest !== null || execution.error !== null) reject('invalid', 'Invalid execution intent.')
      attempt.execution = execution
      updateStatus(change, attempt, 'implementing')
    }),
    checkpointExecution: (id, attemptId, epoch, operationId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, 'implementing')
        if (attempt.epoch !== epoch || change.cancellationEpoch !== epoch || attempt.execution.operationId !== operationId)
          reject('stale', 'Execution no longer owns this attempt.')
        attempt.execution = { ...attempt.execution, ...outcome }
        const stage = attempt.execution.stage
        updateStatus(change, attempt, stage === 'failed' ? 'failed' : stage === 'implemented' ? 'implemented' : 'implementing')
        if (stage === 'failed') change.cancellationEpoch++
      })
    },
    beginValidation: (revision, id, attemptId, validation) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'implemented')
      if (!validValidation(validation) || validation.stage !== 'checking' || validation.artifact !== null ||
          validation.preview !== null || validation.checksPassed) reject('invalid', 'Invalid trusted-check intent.')
      attempt.validation = validation
      updateStatus(change, attempt, 'checking')
    }),
    checkpointValidation: (id, attemptId, epoch, operationId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, ['checking', 'checked'])
        if (attempt.epoch !== epoch || change.cancellationEpoch !== epoch || attempt.validation.operationId !== operationId)
          reject('stale', 'Checks no longer own this attempt.')
        attempt.validation = { ...attempt.validation, ...outcome }
        const stage = attempt.validation.stage
        updateStatus(change, attempt, stage === 'failed' ? 'failed' : stage === 'checked' ? 'checked' : 'checking')
        if (stage === 'failed') change.cancellationEpoch++
      })
    },
    checkpointPreview: (revision, id, attemptId, operationId, previousId, preview) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, ['checked', 'failed', 'cancelled'])
      if (attempt.validation.operationId !== operationId || (attempt.validation.preview?.id ?? null) !== previousId)
        reject('stale', 'Preview no longer owns this attempt.')
      attempt.validation.preview = preview
      if (attempt.state === 'checked') updateStatus(change, attempt, 'checked')
    }),
    beginAuthority: (revision, id, attemptId, authority) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'checked')
      if (attempt.validation.authority !== null) reject('limit', 'Authority observations already exist for this attempt.')
      if (!validAuthority(authority) || authority.stage !== 'running') reject('invalid', 'Invalid trusted contract-check intent.')
      attempt.validation.authority = authority
      updateStatus(change, attempt, 'checked')
    }),
    checkpointAuthority: (id, attemptId, epoch, operationId, authorityId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, 'checked')
        if (change.cancellationEpoch !== epoch || attempt.epoch !== epoch || attempt.validation.operationId !== operationId ||
            attempt.validation.authority?.operationId !== authorityId || attempt.validation.authority.stage !== 'running')
          reject('stale', 'Authority checks no longer own this attempt.')
        attempt.validation.authority = { ...attempt.validation.authority, ...outcome }
        if (outcome.stage === 'failed') {
          attempt.validation.stage = 'failed'
          attempt.validation.error = outcome.error
          updateStatus(change, attempt, 'failed')
          change.cancellationEpoch++
        } else updateStatus(change, attempt, 'checked')
      })
    },
    beginSeal: (revision, id, attemptId, seal) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'checked')
      if (attempt.validation.seal !== null) reject('limit', 'Seal intent already exists; unknown work is not replayed.')
      if (!validSeal(seal) || seal.stage !== 'sealing' || attempt.validation.authority?.stage !== 'passed')
        reject('invalid', 'Invalid trusted app-input seal intent.')
      attempt.validation.seal = seal
      updateStatus(change, attempt, 'checked')
    }),
    checkpointSeal: (id, attemptId, epoch, operationId, sealId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, 'checked')
        if (change.cancellationEpoch !== epoch || attempt.epoch !== epoch || attempt.validation.operationId !== operationId ||
            attempt.validation.seal?.operationId !== sealId || attempt.validation.seal.stage !== 'sealing')
          reject('stale', 'Seal no longer owns this attempt.')
        attempt.validation.seal = { ...attempt.validation.seal, ...outcome }
        if (outcome.stage === 'failed') {
          attempt.validation.stage = 'failed'
          attempt.validation.error = outcome.error
          change.cancellationEpoch++
          updateStatus(change, attempt, 'failed')
        } else updateStatus(change, attempt, 'checked')
      })
    },
    beginBoundBuild: (revision, id, attemptId, record) => mutate(revision, changes => {
      const { change, attempt } = selected(changes, id, attemptId, 'checked')
      if (attempt.validation.boundBuild !== null) reject('limit', 'A bound build already exists; unknown work is not replayed.')
      if (!validBoundBuild(record) || record.stage !== 'checking' || attempt.validation.seal?.stage !== 'sealed')
        reject('invalid', 'Invalid trusted sealed-graph build intent.')
      attempt.validation.boundBuild = record
      updateStatus(change, attempt, 'checked')
    }),
    checkpointBoundBuild: (id, attemptId, epoch, operationId, buildId, outcome) => {
      const snapshot = controller.list()
      if (!snapshot.ok) return snapshot
      return mutate(snapshot.revision, changes => {
        const { change, attempt } = selected(changes, id, attemptId, 'checked')
        if (change.cancellationEpoch !== epoch || attempt.epoch !== epoch || attempt.validation.operationId !== operationId ||
            attempt.validation.boundBuild?.operationId !== buildId || attempt.validation.boundBuild.stage !== 'checking')
          reject('stale', 'Sealed-graph build no longer owns this attempt.')
        attempt.validation.boundBuild = { ...attempt.validation.boundBuild, ...outcome }
        if (outcome.stage === 'failed') {
          attempt.validation.stage = 'failed'; attempt.validation.error = outcome.error
          change.cancellationEpoch++; updateStatus(change, attempt, 'failed')
        } else updateStatus(change, attempt, 'checked')
      })
    },
  }
  return controller
}

function registerChangeController({ ipcMain, assertMainSender, getMainWindow, getUserDataDir, dialog, getHermesHome, passiveReadOnly=false }) {
  let controller, workspace, execution, validation, delivery
  const methods = { list: 0, create: 2, cancel: 3, reopen: 3, selectRepository: 0, prepare: 4, review: 2, implement: 4,
    validate: 3, preview: 3, authority: 3, seal: 3, boundBuild: 3, nativeInputs: 3,
    deliveryStatus: 2, qualify: 3, deliveryReview: 3, approve: 5, selectActivationTarget: 4, activate: 4 }
  const deliveryMethods = ['deliveryStatus', 'qualify', 'deliveryReview', 'approve', 'selectActivationTarget', 'activate']
  function manager() {
    workspace ||= require('./self-modification-workspace.cjs').createWorkspaceManager(getUserDataDir(), controller, {
      confirmBaseline: async ({source,workingTree}) => {
        const working = source.kind === 'working-tree'
        const summary = `Source: ${source.root}\nHEAD: ${source.head}\nDecision: ${source.kind}\n` +
          `Status/identity binding: ${source.statusDigest}\nDirty/untracked entries: ${source.dirtyEntries}\n` +
          `Original source, HEAD and index remain unchanged. No model, scripts, checks, install or activation starts.\n` +
          (working ? `Allowlisted files: ${workingTree.fileCount}; bytes: ${workingTree.bytes}\nSnapshot: ${workingTree.digest}\n` +
            'Ignored files, secret paths and tooling are excluded.' : 'All working changes are excluded and retained in the original checkout.')
        if (working && !await require('./self-modification-review.cjs').read({parent:getMainWindow(),
          title:'Independent complete working-tree baseline review',detail:summary+'\n\nExact changes versus HEAD:\n\n'+
            workingTree.changes.map(file=>`${file.path}\n${file.beforeSha256 ?? 'absent'} → ${file.afterSha256 ?? 'absent'}\n${file.binary ? 'Binary baseline change: digest-bound, not a textual diff.' : file.diff}`).join('\n\n')})) return false
        const choice = await dialog.showMessageBox(getMainWindow(), {
          title: 'Independent exact source-baseline review', type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
          buttons: ['Cancel', working ? 'Use this exact reviewed working-tree snapshot' : 'Use committed HEAD only'],
          message: working ? 'Copy this exact allowlisted working-tree baseline into a separate candidate?' :
            'Copy committed HEAD only, excluding all uncommitted and untracked work?',
          detail: summary,
        })
        return choice.response === 1
      },
    })
    return workspace
  }
  function authorize(event) {
    assertMainSender(event)
    const main = getMainWindow()?.webContents
    if (!main || event.sender !== main || event.senderFrame !== main.mainFrame) throw new Error('Rejected change caller')
  }
  function deliveries() {
    delivery ||= require('./self-modification-delivery.cjs').createDeliveryManager(getUserDataDir(), controller, manager(), checks(), {
      chooseTarget: async () => {
        const choice = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Select an idle compatible renderer target (not a running app bundle)', properties: ['openDirectory'],
        })
        return choice.canceled ? null : require('node:fs').realpathSync(choice.filePaths[0])
      },
      confirm: async input => {
        const approval = input.kind === 'approve', activation = input.kind === 'activate'
        const approvalSummary = approval ?
          `Request: ${input.review.changeId}\nAttempt: ${input.review.attemptId}\n${input.review.request}\n` +
          `Acceptance criteria (not independently verified): ${input.review.acceptanceCriteria}\n` +
          `Version: ${input.review.versionId}\nArtifact: ${input.review.artifactDigest}\nReview: ${input.reviewDigest}\n` +
          `Baseline decision: ${input.review.baseline.kind}; HEAD: ${input.review.baseline.head}\n` +
          `Baseline source: ${input.review.baseline.root}\nBaseline status/identity: ${input.review.baseline.statusDigest}\n` +
          `Scope: frontend presentation only. Protected native host, dependencies, build controls and persistence are immutable.\n` +
          `${input.review.healthScope}\n${input.review.storageScope}\n${input.review.catalogScope}\nChecks:\n${input.review.checks.join('\n')}` : ''
        if (approval && !await require('./self-modification-review.cjs').read({parent:getMainWindow(),
          title:'Independent complete exact-artifact review',detail:approvalSummary+'\n\nExact complete changed-file diff:\n\n'+
            input.review.changes.map(file=>`${file.path}\n${file.beforeSha256} → ${file.afterSha256}\n${file.diff}`).join('\n\n')})) return false
        const detail = approval ?
          approvalSummary + '\nComplete exact changed-file content was reviewed in the separate immutable native review window.' :
          activation ? `Exact version: ${input.record.versionId}\nArtifact: ${input.record.qualification.artifactDigest}\n` +
            `Selected target: ${input.record.target.root}\nExternal trusted supervisor stages and swaps only this renderer target, retains known-good bytes, ` +
            `and launches disposable native health with an exact versioned nonce. Failure restores externally. ` +
            `Unknown storage migrations, pending work and in-use targets are refused. This does NOT install, restart or replace your running app.` :
            `Exact checked source: ${input.sourceDigest}\nExecute only an identical copied trusted native host with the bound renderer, copied graph, ` +
            `fresh HOME/userData, no backend/model calls or live profile authority. Independently observe real window/preload/fixed-bridge readiness ` +
            `and kernel denials. A 45-second native watchdog and bounded delivery deadline apply. No hard memory or aggregate disk cap. ` +
            `This is frontend-only qualification, not arbitrary native code, extensions, live provider or full app qualification.`;
        const choice = await dialog.showMessageBox(getMainWindow(), {
          title: approval ? 'Independent exact-artifact native approval' : activation ? 'Explicit renderer staging consent' : 'Disposable native qualification',
          type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
          buttons: ['Cancel', approval ? 'Approve this exact renderer artifact' : activation ? 'Stage this exact renderer target' : 'Run disposable native qualification'],
          message: approval ? 'Review this exact diff and qualified artifact independently of candidate UI.' :
            activation ? 'Stage the selected idle renderer target? Your live app will not be restarted.' : 'Qualify the frontend against the immutable trusted native host?',
          detail,
        })
        return choice.response === 1
      },
    })
    return delivery
  }
  function checks() {
    validation ||= require('./self-modification-validation.cjs').createValidationManager(getUserDataDir(), controller, manager(), {
      hermesHome: getHermesHome, openPreview: require('./self-modification-preview.cjs').openRendererPreview,
      confirm: async input => {
        const isBuild = input.kind === 'validate', isAuthority = input.kind === 'authority', isSeal = input.kind === 'seal',
          isBound = input.kind === 'boundBuild'
        const choice = await dialog.showMessageBox(getMainWindow(), {
          type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
          buttons: ['Cancel', isBuild ? 'Run scoped renderer checks' : isAuthority ? 'Run isolated authority contracts' :
            isSeal ? 'Seal full app inputs' : isBound ? 'Build against sealed dependencies' : 'Open isolated renderer preview'],
          message: isBuild ? 'Run fixed renderer checks and a bounded sandboxed build?' : isAuthority ?
            'Execute candidate main/preload with inert Electron and host fixtures under kernel isolation?' :
            isSeal ? 'Copy checked source, renderer and the provisioned dependency graph into a full app-input identity?' :
            isBound ? 'Run fixed renderer checks and build using only the copied dependency graph?' :
            'Display the sealed renderer in a separate offline window?',
          detail: isBuild ?
            `Fixed TypeScript, syntax and Vite policy. Candidate Vite, Babel and PostCSS configuration and package scripts are not run. ` +
            `No installs, model calls, live profile or network.\n\n` +
            `Provisioned build code can read dependencies and write private scratch space. 240-second watchdog, per-process CPU/file limits ` +
            `and a UID-relative process ceiling. No hard memory or aggregate-disk cap.\n\n` +
            `Renderer-only. Candidate main behavior, an activation build and health are not qualified.\nSource: ${input.sourceDigest}` : isAuthority ?
            `Independent trusted definitions check window preferences, sender/frame fencing, navigation, permissions and bounded preload calls. ` +
            `Candidate code executes in Node with fake Electron/host adapters, not a native candidate app. VM is not the security boundary.\n\n` +
            `Kernel policy denies child processes, network, live data and source writes. Fresh scratch only; 30-second independent deadline, ` +
            `40-second parent watchdog and inherited per-process limits. No hard memory cap.\n\n` +
            `Observations are not native behavior, full app qualification, approval or health. Nothing is activated.\nSource: ${input.sourceDigest}` : isSeal ?
            `Copies checked source, renderer and the complete currently provisioned node_modules tree, including internal relative links. ` +
            `No candidate scripts execute, installs, network or model calls occur. Maximum 1 GiB dependencies, 2 GiB artifact, 60,000 entries; ` +
            `180-second cooperative sealing deadline. Partial/unknown work is retained, never retried automatically.\n\n` +
            `This identity is not a signed installation package, native behavior, dependency qualification, approval or health. ` +
            `External OS/build services remain unqualified. Nothing is installed or activated.\nSource: ${input.sourceDigest}\n` +
            `Renderer: ${input.rendererDigest}\nDependencies: ${input.dependencyDigest} (${input.dependencyBytes} bytes)` : isBound ?
            `Fixed TypeScript, JavaScript syntax and Vite configuration run in the existing macOS sandbox. ` +
            `Only copied dependency code is read; original dependencies, live profiles, journal and activation authority are unavailable. ` +
            `Fresh scratch only; 240-second watchdog and existing independent command/CPU/file/output limits. ` +
            `No installs, model calls or network. Candidate package/configuration hooks are ignored.\n\n` +
            `The resulting identity binds full source, dependency graph, policy and renderer output. Native app behavior, ` +
            `health and activation remain unqualified.\nApp inputs: ${input.inputDigest}\nDependencies: ${input.dependencyDigest}` :
            `No preload, bridge, Node, permissions, external navigation, downloads or network. A fresh ephemeral session closes after two minutes. ` +
            `The window may consume CPU/memory. Pixels do not verify behavior or health. Nothing is installed or activated.\nRenderer: ${input.artifactDigest}`,
        })
        return choice.response === 1
      },
    })
    return validation
  }
  for (const [method, count] of Object.entries(methods)) {
    ipcMain.handle(`hd:changes:${method}`, async (event, ...args) => {
      try {
        authorize(event)
        const frameUrl = event.senderFrame?.url, pageUrl = event.sender?.getURL?.()
        const guard = () => {
          authorize(event)
          if (frameUrl !== undefined && event.senderFrame?.url !== frameUrl ||
            pageUrl !== undefined && event.sender?.getURL?.() !== pageUrl) throw new Error('Change caller navigated')
        }
        if (args.length !== count) throw new Error('Rejected change arguments')
        if(passiveReadOnly&&method!=='list')return {ok:false,code:'unavailable',error:'Passive qualification bridge cannot mutate state.'}
        controller ||= createChangeController(getUserDataDir(),fs,{readOnly:passiveReadOnly})
        if(passiveReadOnly)return controller.list() // no validation/execution/workspace recovery
        if (deliveryMethods.includes(method)) return deliveries()[method](...args, guard)
        if (method === 'selectRepository') {
          const choice = await dialog.showOpenDialog(getMainWindow(), { title: 'Select Hermes Desk source checkout', properties: ['openDirectory'] })
          guard()
          const result = choice.canceled ? { ok: true, selection: null } : await manager().selectRepository(choice.filePaths[0])
          guard()
          return result
        }
        if (method === 'prepare') return manager().prepare(...args, guard)
        if (method === 'review') { const result = await manager().review(...args); guard(); return result }
        if (['validate', 'preview', 'authority', 'seal', 'boundBuild', 'nativeInputs'].includes(method)) return checks()[method](...args, guard)
        if (method === 'list') {
          const initial = controller.list()
          if (initial.ok && initial.changes.some(change => change.attempts.at(-1)?.validation)) checks().recover()
        }
        if (method === 'implement' || method === 'list') {
          const initial = controller.list()
          if (method === 'implement' || initial.ok && initial.changes.some(change => change.attempts.at(-1)?.state === 'implementing')) {
            execution ||= require('./self-modification-execution.cjs').createExecutionManager(getUserDataDir(), controller, manager(), {
              hermesHome: getHermesHome,
              confirm: async plan => {
                const choice = await dialog.showMessageBox(getMainWindow(), {
                  type: 'warning', title: 'Authorize candidate inference only', defaultId: 1, cancelId: 1,
                  buttons: ['Run candidate implementation', 'Do not run'],
                  message: `Send selected source text to model ${plan.model} at 127.0.0.1:${plan.port}?`,
                  detail: `This must be a tool-free OpenAI-compatible model server, not an agent gateway. The endpoint may incur provider charges. No hard billing or memory cap is guaranteed.\n\nUp to 2 physical requests; 120 seconds wall time; 45 CPU seconds; 1 MiB output; no child processes. Up to 12 file proposals, 128 KiB/file and 512 KiB total.\n\nOnly candidate edits are authorized. No scripts, validation, preview, install or activation. Selected text may contain secrets; inspect it before consenting.\n\nFiles:\n${plan.files.join('\n')}\n\nInput digest: ${plan.inputDigest}`,
                })
                return choice.response === 0
              },
            })
          }
          if (method === 'implement') return execution.implement(...args, guard)
          execution?.recover()
        }
        if (method === 'list' && workspace) workspace.recover()
        if (method === 'list' && !workspace) {
          const initial = controller.list()
          if (initial.ok && initial.changes.some(change => change.attempts.at(-1)?.state === 'preparing')) manager().recover()
        }
        if (method === 'cancel') {
          const result = controller.cancel(...args)
          if (result.ok) workspace?.cancel(args[1], args[2])
          if (result.ok) execution?.cancel(args[1], args[2])
          if (result.ok) validation?.cancel(args[1], args[2])
          if (result.ok) delivery?.cancel(args[1], args[2])
          return result
        }
        return controller[method](...args)
      } catch { return { ok: false, code: 'unavailable', error: 'Change requests are available only in the primary Hermes Desk window.' } }
    })
  }
  return () => { for (const method of Object.keys(methods)) ipcMain.removeHandler(`hd:changes:${method}`) }
}

module.exports = { createChangeController, registerChangeController }
