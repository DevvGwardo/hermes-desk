'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { identity } = require('./self-modification-schema.cjs')
const policy = require('./self-modification-policy.cjs')
const working = require('./self-modification-baseline.cjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
const MAX_FILE = 2 * 1024 * 1024
const MAX_TOTAL = 128 * 1024 * 1024
const MAX_FILES = 5000
const pause = () => new Promise(resolve => setImmediate(resolve))

function fail(code, message) {
  throw Object.assign(new Error(message), { workspaceCode: code })
}
function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || /[\0\\]/.test(name) || path.isAbsolute(name) ||
      name.split('/').length > 32 || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))
    fail('invalid', 'The source contains an unsafe file path.')
  if (policy.sensitivePath(name))
    fail('invalid', 'The baseline contains a sensitive file path. Choose a source revision without that file.')
  return name
}

/** Read-only Git plumbing. No inherited credentials/GIT_* environment, hooks,
 * fsmonitor, pager, external diff, filters, dependency installs or shell. */
function runGit(root, args, { input, signal, maxBuffer = MAX_TOTAL } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-C', root, ...args], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'buffer', timeout: 20000, maxBuffer, signal,
    }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function createWorkspaceManager(userDataDir, controller, { io = fs, git = runGit, confirmBaseline } = {}) {
  const store = path.join(userDataDir, 'self-modification')
  const base = path.join(store, 'workspaces')
  const selections = new Map()
  const active = new Map()
  let confirming = 0
  const rootIdentity = io.lstatSync(userDataDir)
  let storeIdentity, baseIdentity
  function directory(name) {
    const stat = io.lstatSync(name)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ownership', 'A storage or source directory is not an owned regular directory.')
    return stat
  }
  function storage(create = false) {
    if (!same(rootIdentity, directory(userDataDir))) fail('ownership', 'The app data directory changed. Existing work was retained.')
    const current = directory(store)
    if (storeIdentity && !same(storeIdentity, current)) fail('ownership', 'Change storage changed. Existing work was retained.')
    storeIdentity ||= current
    let value
    try { value = directory(base) } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error
      io.mkdirSync(base, { mode: 0o700 })
      value = directory(base)
    }
    if (baseIdentity && !same(baseIdentity, value)) fail('ownership', 'Workspace storage changed. Existing work was retained.')
    baseIdentity ||= value
  }
  function sourceDirectories(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/.test(root)) fail('invalid', 'Select a local Git checkout.')
    const stat = directory(root)
    const gitStat = directory(path.join(root, '.git'))
    return { dev: stat.dev, ino: stat.ino, gitDev: gitStat.dev, gitIno: gitStat.ino }
  }
  async function inspect(root, signal, kind = 'head') {
    const directories = sourceDirectories(root)
    const top = (await git(root, ['rev-parse', '--show-toplevel'], { signal, maxBuffer: 8192 })).toString('utf8').trim()
    if (io.realpathSync(root) !== io.realpathSync(top)) fail('invalid', 'Select the repository root, not a nested folder.')
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal, maxBuffer: 1024 })).toString('utf8').trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) fail('invalid', 'The checkout has no supported committed HEAD.')
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal, maxBuffer: 1024 * 1024 })
    const entries = status.toString('utf8').split('\0').filter(Boolean)
    let dirtyEntries = 0
    for (let i = 0; i < entries.length; i++) {
      dirtyEntries++
      if (/R|C/.test(entries[i].slice(0, 2))) i++ // renamed/copied paths have a second NUL field
    }
    if (JSON.stringify(directories) !== JSON.stringify(sourceDirectories(root))) fail('ownership', 'The selected repository changed.')
    const copy = kind === 'working-tree' ? await working.snapshot(root, git, signal) : null
    return { root, ...directories, head, statusDigest: sha(copy ? Buffer.concat([status, Buffer.from(copy.digest)]) : status), dirtyEntries, kind, dirtyExcluded: kind === 'head' }
  }
  function guardedFile(name, limit = MAX_FILE) {
    const fd = io.openSync(name, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK)
    try {
      const stat = io.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || !same(stat, io.lstatSync(name)))
        fail('ownership', 'A candidate file is oversized or its ownership changed.')
      const bytes = io.readFileSync(fd)
      if (bytes.length > limit || !same(stat, io.lstatSync(name))) fail('ownership', 'A candidate file changed during review.')
      return { bytes, mode: stat.mode & 0o777 }
    } finally { io.closeSync(fd) }
  }
  function writePrivate(name, bytes, mode = 0o600) {
    const fd = io.openSync(name, 'wx', mode)
    try { io.writeFileSync(fd, bytes); io.fsyncSync(fd) } finally { io.closeSync(fd) }
  }
  function paths(preparation) {
    const w = preparation.workspace
    if (!identity(w.id) || !identity(w.token)) fail('ownership', 'Invalid workspace ownership.')
    const root = path.join(base, w.id)
    return { root, source: path.join(root, 'source'), baseline: path.join(root, 'baseline') }
  }
  function owned(preparation, pinned) {
    storage()
    const p = paths(preparation)
    const stat = directory(p.root)
    const expected = pinned || preparation.workspace
    if (expected.dev === null || !same(stat, expected)) fail('ownership', 'Workspace identity changed. Nothing was resumed or removed.')
    const owner = JSON.parse(guardedFile(path.join(p.root, 'owner.json'), 4096).bytes)
    if (owner.version !== 1 || owner.id !== preparation.workspace.id || owner.token !== preparation.workspace.token)
      fail('ownership', 'Workspace ownership could not be verified.')
    directory(p.source)
    directory(p.baseline)
    return p
  }
  function currentAttempt(id, attemptId) {
    const snapshot = controller.list()
    if (!snapshot.ok) fail(snapshot.code, snapshot.error)
    const change = snapshot.changes.find(item => item.id === id)
    const attempt = change?.attempts.at(-1)
    if (!identity(id) || !identity(attemptId) || !attempt || attempt.id !== attemptId)
      fail('stale', 'This attempt is no longer current. Reload before continuing.')
    return { snapshot, change, attempt }
  }
  function stillOwns(id, attemptId, preparation, signal) {
    if (signal.aborted) fail('stale', 'Preparation was cancelled.')
    const { attempt, change } = currentAttempt(id, attemptId)
    if (attempt.state !== 'preparing' || attempt.preparation.operationId !== preparation.operationId ||
        change.cancellationEpoch !== attempt.epoch) fail('stale', 'Preparation was cancelled or superseded.')
    return attempt.epoch
  }
  async function materialize(id, attemptId, preparation, signal) {
    let pinned
    try {
      const epoch = stillOwns(id, attemptId, preparation, signal)
      if (JSON.stringify(await inspect(preparation.source.root, signal, preparation.source.kind)) !== JSON.stringify(preparation.source))
        fail('stale', 'The source baseline changed. Select it again; existing work was retained.')
      const workingCopy = preparation.source.kind === 'working-tree' ? await working.snapshot(preparation.source.root, git, signal) : null
      const tree = workingCopy ? Buffer.alloc(0) : await git(preparation.source.root, ['ls-tree', '-rz', '--full-tree', preparation.source.head], { signal, maxBuffer: 2 * 1024 * 1024 })
      if (!Buffer.from(tree.toString('utf8')).equals(tree)) fail('invalid', 'Source paths must use valid UTF-8.')
      const files = workingCopy ? workingCopy.files : tree.toString('utf8').split('\0').filter(Boolean).map(entry => {
        const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(entry)
        if (!match) fail('invalid', 'This slice supports regular tracked files only, not symlinks or submodules.')
        if (policy.sensitivePath(match[3])) return null
        return { path: safePath(match[3]), oid: match[2], mode: match[1] === '100755' ? 0o700 : 0o600 }
      }).filter(Boolean)
      if (!files.length || files.length > MAX_FILES) fail('limit', 'The source must contain 1–5,000 regular tracked files.')
      const blobs = workingCopy ? null : await git(preparation.source.root, ['cat-file', '--batch'], {
        input: files.map(file => file.oid).join('\n') + '\n', signal, maxBuffer: MAX_TOTAL,
      })
      stillOwns(id, attemptId, preparation, signal)
      storage(true)
      const p = paths(preparation)
      io.mkdirSync(p.root, { mode: 0o700 }) // exclusive generated path; never replace a pre-existing workspace
      pinned = directory(p.root)
      writePrivate(path.join(p.root, 'owner.json'), JSON.stringify({ version: 1, id: preparation.workspace.id, token: preparation.workspace.token }))
      io.mkdirSync(p.source, { mode: 0o700 })
      io.mkdirSync(p.baseline, { mode: 0o700 })
      let offset = 0, total = 0
      const manifest = []
      for (const [index, file] of files.entries()) {
        if (index % 10 === 0) { await pause(); stillOwns(id, attemptId, preparation, signal) }
        owned(preparation, pinned)
        let size, bytes
        if (workingCopy) {
          bytes = file.bytes; size = bytes.length; total += size
        } else {
          const end = blobs.indexOf(10, offset)
          const header = blobs.subarray(offset, end).toString('ascii').split(' ')
          size = Number(header[2])
          if (end < 0 || header[0] !== file.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) ||
              size < 0 || size > MAX_FILE || (total += size) > MAX_TOTAL || end + size + 1 >= blobs.length)
            fail('limit', 'A baseline file exceeds its fixed resource limit.')
          bytes = blobs.subarray(end + 1, end + 1 + size)
          offset = end + size + 2
        }
        for (const root of [p.source, p.baseline]) {
          let parent = root
          for (const part of file.path.split('/').slice(0, -1)) {
            parent = path.join(parent, part)
            if (!io.existsSync(parent)) io.mkdirSync(parent, { mode: 0o700 })
            directory(parent)
          }
          writePrivate(path.join(root, file.path), bytes, file.mode)
        }
        manifest.push({ path: file.path, sha256: sha(bytes), size, mode: file.mode })
      }
      owned(preparation, pinned)
      writePrivate(path.join(p.root, 'manifest.json'), JSON.stringify({ version: 1, files: manifest }))
      if (JSON.stringify(await inspect(preparation.source.root, signal, preparation.source.kind)) !== JSON.stringify(preparation.source))
        fail('stale', 'The source changed during preparation. The workspace was retained, not accepted.')
      stillOwns(id, attemptId, preparation, signal)
      controller.finishPreparation(id, attemptId, epoch, preparation.operationId, {
        workspace: { ...preparation.workspace, dev: pinned.dev, ino: pinned.ino },
        manifestDigest: sha(JSON.stringify(manifest)), fileCount: manifest.length, error: null,
      })
    } catch (error) {
      const message = error.workspaceCode ? error.message : 'Source preparation could not finish. Any workspace was retained; no code was executed.'
      const { attempt } = (() => { try { return currentAttempt(id, attemptId) } catch { return {} } })()
      if (attempt?.state === 'preparing' && attempt.preparation.operationId === preparation.operationId) {
        controller.finishPreparation(id, attemptId, attempt.epoch, preparation.operationId, {
          ...(pinned ? { workspace: { ...preparation.workspace, dev: pinned.dev, ino: pinned.ino } } : {}),
          error: message.slice(0, 500),
        })
      }
    } finally { active.delete(preparation.operationId) }
  }
  async function result(action) {
    try { return await action() } catch (error) {
      return { ok: false, code: error.workspaceCode || 'storage', error: error.workspaceCode ? error.message :
        'Source storage or Git inspection failed. Existing source and candidates were retained.' }
    }
  }
  const manager = {
    candidateRoot: async (id, attemptId) => {
      const review = await manager.review(id, attemptId)
      if (!review.ok) fail(review.code, review.error)
      policy.verifyDiff(review.files)
      const { attempt } = currentAttempt(id, attemptId)
      if (!['implemented', 'checking', 'checked'].includes(attempt.state))
        fail('stale', 'Candidate implementation is not ready for checks.')
      return owned(attempt.preparation).source
    },
    context: async (id, attemptId, names) => {
      if (!Array.isArray(names) || !names.length || names.length > 12 || new Set(names).size !== names.length)
        fail('invalid', 'Select 1–12 candidate text files.')
      const review = await manager.review(id, attemptId)
      if (!review.ok) fail(review.code, review.error)
      policy.verifyDiff(review.files)
      const { change, attempt } = currentAttempt(id, attemptId)
      if (attempt.state !== 'prepared') fail('stale', 'Only a prepared candidate can start implementation.')
      const prep = attempt.preparation, p = owned(prep)
      const root = directory(p.source)
      let total = 0
      const files = names.map(name => {
        safePath(name)
        policy.assertEditable(name)
        let parent = p.source
        for (const part of name.split('/').slice(0, -1)) { parent = path.join(parent, part); directory(parent) }
        const file = guardedFile(path.join(p.source, name), 64 * 1024)
        const content = file.bytes.toString('utf8')
        if (file.bytes.includes(0) || !Buffer.from(content).equals(file.bytes) || (total += file.bytes.length) > 256 * 1024)
          fail('limit', 'Worker context is limited to UTF-8 text, 64 KiB/file and 256 KiB total.')
        return { path: name, content, sha256: sha(file.bytes), mode: file.mode }
      })
      owned(prep)
      if (!same(root, directory(p.source))) fail('ownership', 'Candidate root changed.')
      const context = { request: change.request, acceptanceCriteria: change.acceptanceCriteria, files,
        root: { dev: root.dev, ino: root.ino } }
      if (Buffer.byteLength(JSON.stringify(context)) > 900000)
        fail('limit', 'Encoded worker context exceeds its bounded input budget. Choose smaller text files.')
      return context
    },
    applyProposal: async (id, attemptId, context, proposal, check) => {
      if (!proposal || Object.keys(proposal).join(',') !== 'changes' ||
          !Array.isArray(proposal.changes) || !proposal.changes.length || proposal.changes.length > 12)
        fail('invalid', 'Hermes must propose 1–12 explicit file operations.')
      const prep = currentAttempt(id, attemptId).attempt.preparation
      const selected = new Map(context.files.map(file => [file.path, file]))
      const seen = new Set()
      let bytes = 0
      function target(name, create = false) {
        const p = owned(prep)
        if (!same(context.root, directory(p.source))) fail('ownership', 'Candidate root changed. Proposal was not accepted.')
        let parent = p.source
        for (const part of name.split('/').slice(0, -1)) {
          parent = path.join(parent, part)
          if (create && !io.existsSync(parent)) io.mkdirSync(parent, { mode: 0o700 })
          if (io.existsSync(parent)) directory(parent)
          else {
            if (selected.has(name)) fail('stale', 'A selected target disappeared.')
            return { name: path.join(p.source, name), exists: false }
          }
        }
        const nameOnDisk = path.join(p.source, name)
        let stat
        try { stat = io.lstatSync(nameOnDisk) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (stat) {
          const file = guardedFile(nameOnDisk)
          const before = selected.get(name)
          if (!before || sha(file.bytes) !== before.sha256 || file.mode !== before.mode)
            fail('stale', 'A proposed target changed or was not part of the approved context.')
        } else if (selected.has(name)) fail('stale', 'A selected target disappeared.')
        return { name: nameOnDisk, exists: !!stat, stat }
      }
      // Validate the entire proposal before the first write. No shell/scripts.
      for (const change of proposal.changes) {
        const fields = change?.op === 'write' ? 'content,op,path' : 'op,path'
        if (!change || Object.keys(change).sort().join(',') !== fields || !['write', 'delete'].includes(change.op))
          fail('invalid', 'Invalid file proposal. No operations were applied.')
        safePath(change.path)
        policy.assertEditable(change.path)
        if (seen.has(change.path)) fail('invalid', 'A proposal cannot repeat a path.')
        if ([...seen].some(name => change.path.startsWith(name + '/') || name.startsWith(change.path + '/')))
          fail('invalid', 'Proposed file paths cannot contain one another.')
        seen.add(change.path)
        if (change.op === 'write' && (typeof change.content !== 'string' || change.content.includes('\0') ||
            Buffer.byteLength(change.content) > 128 * 1024 || (bytes += Buffer.byteLength(change.content)) > 512 * 1024))
          fail('limit', 'Proposed text exceeds 128 KiB/file or 512 KiB total.')
        const current = target(change.path)
        if (change.op === 'delete' && !current.exists) fail('invalid', 'Cannot delete a missing target.')
      }
      for (const change of proposal.changes) {
        await pause()
        check() // durable operation/attempt/epoch fence before every side effect
        const current = target(change.path, true)
        if (change.op === 'delete') io.unlinkSync(current.name)
        else {
          const temp = path.join(path.dirname(current.name), `.proposal-${randomUUID()}`)
          writePrivate(temp, change.content, selected.get(change.path)?.mode ?? 0o600)
          check()
          target(change.path)
          io.renameSync(temp, current.name)
        }
      }
      check()
      const review = await manager.review(id, attemptId)
      if (!review.ok) fail(review.code, review.error)
      return sha(JSON.stringify(review.files.map(file => [file.path, file.afterSha256])))
    },
    selectRepository: root => result(async () => {
      const source = await inspect(root)
      const snapshot = await working.snapshot(root, git)
      const changes = await working.review(root, source.head, snapshot, git)
      const workingSource = await inspect(root, undefined, 'working-tree')
      if ((await working.snapshot(root, git)).digest !== snapshot.digest) fail('stale', 'Working source changed during review.')
      const id = randomUUID()
      if (selections.size >= 2) selections.delete(selections.keys().next().value)
      selections.set(id, { head: source, working: workingSource, digest: snapshot.digest,
        review: { digest:snapshot.digest,fileCount:snapshot.files.length,bytes:snapshot.bytes,changes } })
      return { ok: true, selection: { id, root: source.root, head: source.head, dirtyEntries: source.dirtyEntries, workingTree: { digest: snapshot.digest, fileCount: snapshot.files.length, bytes: snapshot.bytes, changes } } }
    }),
    prepare: (revision, id, attemptId, decision, authorize = () => {}) => result(async () => {
      if (!decision || Object.keys(decision).sort().join(',') !== 'baseline,selectionId' ||
          !['head', 'working-tree'].includes(decision.baseline) || !identity(decision.selectionId))
        fail('invalid', 'Explicitly choose reviewed HEAD or the reviewed working-tree snapshot.')
      if (active.size + confirming >= 2) fail('limit', 'Two isolated preparations or baseline confirmations are already outstanding.')
      const selected = selections.get(decision.selectionId)
      const source = selected?.[decision.baseline === 'head' ? 'head' : 'working']
      if (!source) fail('stale', 'Repository selection expired. Select it again.')
      confirming++
      try {
        if (JSON.stringify(await inspect(source.root, undefined, source.kind)) !== JSON.stringify(source))
          fail('stale', 'The selected source changed. Select it again before preparing.')
        authorize()
        // Production supplies a separate native default-deny exact-baseline
        // confirmation. Direct trusted fixture callers deliberately choose the
        // bounded decision without opening the user's native UI.
        const allowed = confirmBaseline ? await confirmBaseline({source,workingTree:selected.review}) : true
        authorize()
        if (!allowed) return controller.list()
        if (JSON.stringify(await inspect(source.root, undefined, source.kind)) !== JSON.stringify(source))
          fail('stale', 'The baseline changed during native review. Select and review it again.')
      } finally { confirming-- }
      authorize()
      if (active.size >= 2) fail('limit', 'Two isolated preparations are already running. Wait or cancel one.')
      const preparation = { operationId: randomUUID(), ownerPid: process.pid, source,
        workspace: { id: randomUUID(), token: randomUUID(), dev: null, ino: null }, manifestDigest: null, fileCount: null, error: null }
      const started = controller.beginPreparation(revision, id, attemptId, preparation)
      if (!started.ok) return started
      selections.delete(decision.selectionId)
      const abort = new AbortController()
      active.set(preparation.operationId, { id, attemptId, abort })
      void materialize(id, attemptId, preparation, abort.signal)
      return started
    }),
    cancel(id, attemptId) {
      for (const work of active.values()) if (work.id === id && work.attemptId === attemptId) work.abort.abort()
    },
    recover() {
      const snapshot = controller.list()
      if (!snapshot.ok) return
      for (const change of snapshot.changes) {
        const attempt = change.attempts.at(-1)
        if (attempt.state !== 'preparing' || active.has(attempt.preparation.operationId)) continue
        let gone = attempt.preparation.ownerPid === process.pid
        try { process.kill(attempt.preparation.ownerPid, 0) } catch (error) { gone = error.code === 'ESRCH' }
        if (gone) controller.finishPreparation(change.id, attempt.id, attempt.epoch, attempt.preparation.operationId, {
          error: 'Preparation was interrupted or its acknowledgment was lost. Any workspace was retained, not resumed or removed.',
        })
      }
    },
    review: (id, attemptId) => result(async () => {
      const { attempt } = currentAttempt(id, attemptId)
      const prep = attempt.preparation
      if (!prep?.manifestDigest) fail('invalid', 'No completely prepared workspace exists for this attempt.')
      const p = owned(prep)
      const manifest = JSON.parse(guardedFile(path.join(p.root, 'manifest.json'), 2 * 1024 * 1024).bytes)
      if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES ||
          sha(JSON.stringify(manifest.files)) !== prep.manifestDigest) fail('ownership', 'The protected baseline manifest changed.')
      const candidate = new Map()
      let count = 0, total = 0, entries = 0
      async function walk(root, prefix = '') {
        directory(root)
        for (const entry of io.readdirSync(root, { withFileTypes: true })) {
          if (++entries > MAX_FILES * 2) fail('limit', 'Candidate has too many files or directories.')
          const name = safePath(prefix + entry.name)
          if (entry.isSymbolicLink()) fail('ownership', 'Candidate symlinks are not allowed.')
          if (entry.isDirectory()) await walk(path.join(root, entry.name), name + '/')
          else {
            if (++count > MAX_FILES) fail('limit', 'Candidate has too many files.')
            const file = guardedFile(path.join(root, entry.name))
            if ((total += file.bytes.length) > MAX_TOTAL) fail('limit', 'Candidate exceeds the workspace review limit.')
            candidate.set(name, file)
          }
          if (count % 10 === 0) { await pause(); owned(prep) }
        }
      }
      await walk(p.source)
      const baseline = new Map(manifest.files.map(file => [safePath(file.path), file]))
      const files = []
      let diffBytes = 0
      for (const name of [...new Set([...baseline.keys(), ...candidate.keys()])].sort()) {
        owned(prep)
        const before = baseline.get(name), after = candidate.get(name)
        let original
        if (before) {
          let parent = p.baseline
          for (const part of name.split('/').slice(0, -1)) { parent = path.join(parent, part); directory(parent) }
          original = guardedFile(path.join(p.baseline, name))
          if (sha(original.bytes) !== before.sha256 || original.bytes.length !== before.size || original.mode !== before.mode)
            fail('ownership', 'Protected baseline bytes changed. No review authority was granted.')
        }
        const afterDigest = after ? sha(after.bytes) : null
        const status = !before ? 'added' : !after ? 'deleted' :
          before.sha256 !== afterDigest || before.mode !== after.mode ? 'modified' : 'unchanged'
        let diff = null, binary = false, truncated = false
        if (status !== 'unchanged') {
          const old = original?.bytes ?? Buffer.alloc(0), next = after?.bytes ?? Buffer.alloc(0)
          binary = old.includes(0) || next.includes(0) ||
            !Buffer.from(old.toString('utf8')).equals(old) || !Buffer.from(next.toString('utf8')).equals(next)
          if (!binary) {
            const oldLines = old.toString('utf8').split('\n'), newLines = next.toString('utf8').split('\n')
            diff = `--- ${before ? 'a/' + name : '/dev/null'}\n+++ ${after ? 'b/' + name : '/dev/null'}\n` +
              `mode ${before?.mode ?? 'absent'} → ${after?.mode ?? 'absent'}\n` +
              `@@ -1,${oldLines.length} +1,${newLines.length} @@\n` +
              oldLines.map(line => '-' + line).join('\n') + '\n' + newLines.map(line => '+' + line).join('\n')
            if (Buffer.byteLength(diff) > 384 * 1024 || diffBytes + Buffer.byteLength(diff) > 2 * 1024 * 1024) {
              diff = diff.slice(0, Math.max(0, Math.min(16000, 2 * 1024 * 1024 - diffBytes)))
              truncated = true
            }
            diffBytes += Buffer.byteLength(diff)
          }
        }
        files.push({ path: name, status, beforeSha256: before?.sha256 ?? null, afterSha256: afterDigest,
          binary, truncated, diff, editable: policy.editable(name) })
      }
      owned(prep)
      const latest = currentAttempt(id, attemptId).attempt
      if (latest.preparation?.operationId !== prep.operationId) fail('stale', 'The reviewed attempt changed.')
      return { ok: true, workspaceId: prep.workspace.id, baselineHead: prep.source.head, files }
    }),
  }
  return manager
}

module.exports = { createWorkspaceManager, runGit, safePath }
