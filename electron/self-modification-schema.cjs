'use strict'

const path = require('node:path')
const identity = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const integer = value => Number.isSafeInteger(value) && value >= 0
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function validBoundBuild(value) {
  if (!keys(value, ['operationId', 'ownerPid', 'scope', 'stage', 'inputDigest', 'sourceDigest', 'dependencyDigest',
    'toolchainDigest', 'artifact', 'fullAppQualified', 'error']) || !identity(value.operationId) ||
      !integer(value.ownerPid) || value.ownerPid < 1 || value.scope !== 'sealed-graph-renderer' ||
      !['checking', 'passed', 'failed'].includes(value.stage) || value.fullAppQualified !== false ||
      ![value.inputDigest, value.sourceDigest, value.dependencyDigest, value.toolchainDigest].every(digest) ||
      (value.stage === 'failed' ? !text(value.error, 500) : value.error !== null)) return false
  if (value.stage !== 'passed') return value.artifact === null
  const a = value.artifact
  return keys(a, ['id', 'token', 'dev', 'ino', 'rendererDigest', 'boundDigest', 'fileCount', 'activationEligible']) &&
    identity(a.id) && identity(a.token) && integer(a.dev) && integer(a.ino) &&
    digest(a.rendererDigest) && digest(a.boundDigest) && integer(a.fileCount) && a.fileCount > 0 &&
    a.fileCount <= 5000 && a.activationEligible === false
}

function validSeal(value) {
  if (!keys(value, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'rendererDigest', 'toolchainDigest',
    'dependencyDigest', 'artifact', 'fullAppQualified', 'error']) || !identity(value.operationId) ||
      !integer(value.ownerPid) || value.ownerPid < 1 || value.scope !== 'full-app-inputs' ||
      !['sealing', 'sealed', 'failed'].includes(value.stage) || value.fullAppQualified !== false ||
      ![value.sourceDigest, value.rendererDigest, value.toolchainDigest, value.dependencyDigest].every(digest) ||
      (value.stage === 'failed' ? !text(value.error, 500) : value.error !== null)) return false
  const a = value.artifact
  if (value.stage !== 'sealed') return a === null
  return keys(a, ['id', 'token', 'dev', 'ino', 'digest', 'provenanceDigest', 'entries', 'bytes', 'activationEligible']) &&
    identity(a.id) && identity(a.token) && integer(a.dev) && integer(a.ino) &&
    digest(a.digest) && digest(a.provenanceDigest) && integer(a.entries) && a.entries > 0 && a.entries <= 60001 &&
    integer(a.bytes) && a.bytes <= 2 * 1024 * 1024 * 1024 && a.activationEligible === false
}

function validAuthority(value) {
  return keys(value, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'rendererDigest', 'definitionDigest',
    'observationDigest', 'checks', 'nativeBehaviorVerified', 'fullAppQualified', 'error']) &&
    identity(value.operationId) && integer(value.ownerPid) && value.ownerPid > 0 &&
    value.scope === 'main-preload-test-doubles' && ['running', 'passed', 'failed'].includes(value.stage) &&
    [value.sourceDigest, value.rendererDigest, value.definitionDigest].every(digest) &&
    value.nativeBehaviorVerified === false && value.fullAppQualified === false &&
    (value.stage === 'running' ? value.observationDigest === null && value.checks === null : value.stage === 'passed' ?
      digest(value.observationDigest) && value.checks === 6 : value.observationDigest === null && value.checks === null) &&
    (value.stage === 'failed' ? text(value.error, 500) : value.error === null)
}

function validValidation(value) {
  if (!keys(value, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'toolchainDigest',
    'checksPassed', 'artifact', 'preview', 'authority', 'seal', 'boundBuild', 'error']) || !identity(value.operationId) ||
    !integer(value.ownerPid) || value.ownerPid < 1 || value.scope !== 'renderer-only' ||
    !['checking', 'building', 'checked', 'failed'].includes(value.stage) ||
    !digest(value.sourceDigest) || !digest(value.toolchainDigest) ||
    typeof value.checksPassed !== 'boolean' ||
    (value.stage === 'failed' ? !text(value.error, 500) : value.error !== null)) return false
  const a = value.artifact, p = value.preview
  if (value.boundBuild !== null && (!validBoundBuild(value.boundBuild) || value.seal?.stage !== 'sealed' ||
      value.boundBuild.inputDigest !== value.seal.artifact.digest || value.boundBuild.sourceDigest !== value.sourceDigest ||
      value.boundBuild.dependencyDigest !== value.seal.dependencyDigest)) return false
  if (value.seal !== null && (!a || !validSeal(value.seal) ||
      value.seal.sourceDigest !== value.sourceDigest || value.seal.rendererDigest !== a.digest ||
      value.seal.toolchainDigest !== value.toolchainDigest || value.authority?.stage !== 'passed')) return false
  if (value.authority !== null && (!a || !validAuthority(value.authority) ||
      value.authority.sourceDigest !== value.sourceDigest || value.authority.rendererDigest !== a.digest)) return false
  if (a !== null && (!keys(a, ['id', 'token', 'dev', 'ino', 'digest', 'sourceDigest', 'toolchainDigest', 'fileCount',
    'scope', 'activationEligible']) || !identity(a.id) || !identity(a.token) || !integer(a.dev) || !integer(a.ino) ||
    !digest(a.digest) || a.sourceDigest !== value.sourceDigest || a.toolchainDigest !== value.toolchainDigest ||
    !integer(a.fileCount) || a.fileCount < 1 || a.fileCount > 5000 || a.scope !== 'renderer-only' ||
    a.activationEligible !== false)) return false
  if (p !== null && (!a || !keys(p, ['id', 'ownerPid', 'state', 'artifactDigest', 'rendererReady', 'behaviorVerified', 'error']) ||
    !identity(p.id) || !integer(p.ownerPid) || p.ownerPid < 1 ||
    !['opening', 'open', 'closed', 'interrupted'].includes(p.state) ||
    ![a.digest, value.boundBuild?.artifact?.rendererDigest].includes(p.artifactDigest) ||
    (['opening', 'open'].includes(p.state) && value.boundBuild?.stage === 'passed' &&
      p.artifactDigest !== value.boundBuild.artifact.rendererDigest) ||
    typeof p.rendererReady !== 'boolean' || p.behaviorVerified !== false ||
    (p.error !== null && !text(p.error, 500)))) return false
  if (value.stage === 'checking') return a === null && p === null && value.checksPassed === false
  if (value.stage === 'building') return a === null && p === null && value.checksPassed === true
  if (value.stage === 'checked') return a !== null && value.checksPassed === true
  return a === null || value.checksPassed === true
}

function validExecution(value) {
  return keys(value, ['operationId', 'ownerPid', 'stage', 'port', 'model', 'files', 'inputDigest', 'calls', 'outputDigest', 'error']) &&
    identity(value.operationId) && integer(value.ownerPid) && value.ownerPid > 0 &&
    ['running', 'applying', 'implemented', 'failed'].includes(value.stage) &&
    Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 && text(value.model, 200) &&
    Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= 12 &&
    value.files.every(file => text(file, 1024)) && new Set(value.files).size === value.files.length &&
    digest(value.inputDigest) && integer(value.calls) && value.calls <= 2 &&
    (value.stage === 'implemented' ? digest(value.outputDigest) : value.outputDigest === null) &&
    (value.stage === 'failed' ? text(value.error, 500) : value.error === null)
}

function validPreparation(value) {
  if (!keys(value, ['operationId', 'ownerPid', 'source', 'workspace', 'manifestDigest', 'fileCount', 'error']) ||
      !identity(value.operationId) || !integer(value.ownerPid) || value.ownerPid < 1) return false
  const s = value.source, w = value.workspace
  return keys(s, ['root', 'dev', 'ino', 'gitDev', 'gitIno', 'head', 'statusDigest', 'dirtyEntries', 'kind', 'dirtyExcluded']) &&
    text(s.root, 4096) && path.isAbsolute(s.root) && [s.dev, s.ino, s.gitDev, s.gitIno].every(integer) &&
    typeof s.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.head) &&
    digest(s.statusDigest) && integer(s.dirtyEntries) && ['head', 'working-tree'].includes(s.kind) && s.dirtyExcluded === (s.kind === 'head') &&
    keys(w, ['id', 'token', 'dev', 'ino']) && identity(w.id) && identity(w.token) &&
    (w.dev === null && w.ino === null || integer(w.dev) && integer(w.ino)) &&
    (value.manifestDigest === null || digest(value.manifestDigest)) &&
    (value.fileCount === null || integer(value.fileCount) && value.fileCount <= 5000) &&
    (value.error === null || text(value.error, 500))
}

/** Read-only v1–v6→v7 migration. A subsequent atomic write persists v7; a read
 * never rewrites legacy data, and unknown/malformed schemas never reset it. */
function decodeJournal(raw) {
  const journal = JSON.parse(raw)
  const legacy = journal?.version === 1 && journal?.lifecycleVersion === 1
  const previous = journal?.version === 2 && journal?.lifecycleVersion === 2
  const third = journal?.version === 3 && journal?.lifecycleVersion === 3
  const fourth = journal?.version === 4 && journal?.lifecycleVersion === 4
  const fifth = journal?.version === 5 && journal?.lifecycleVersion === 5
  const sixth = journal?.version === 6 && journal?.lifecycleVersion === 6
  if (!keys(journal, ['version', 'lifecycleVersion', 'revision', 'changes']) ||
      (!legacy && !previous && !third && !fourth && !fifth && !sixth && (journal.version !== 7 || journal.lifecycleVersion !== 7))) throw new Error('Unsupported change journal version')
  if (!integer(journal.revision) || journal.revision < 1 || !Array.isArray(journal.changes) || journal.changes.length > 200)
    throw new Error('Invalid journal')
  const ids = new Set()
  for (const change of journal.changes) {
    if (!keys(change, ['id', 'request', 'acceptanceCriteria', 'createdAt', 'updatedAt', 'cancellationEpoch', 'attempts']) ||
        !identity(change.id) || ids.has(change.id) || !text(change.request, 8000) || !text(change.acceptanceCriteria, 4000) ||
        !timestamp(change.createdAt) || !timestamp(change.updatedAt) || !Array.isArray(change.attempts) ||
        change.attempts.length < 1 || change.attempts.length > 50) throw new Error('Invalid change')
    ids.add(change.id)
    let previousEnd = null
    for (const [index, attempt] of change.attempts.entries()) {
      const fields = ['id', 'state', 'epoch', 'requestedAt', 'cancelledAt', ...legacy ? [] : ['statusAt', 'preparation'],
        ...legacy || previous ? [] : ['execution'], ...legacy || previous || third ? [] : ['validation']]
      const states = legacy ? ['requested', 'cancelled'] : previous ? ['requested', 'preparing', 'prepared', 'failed', 'cancelled'] :
        ['requested', 'preparing', 'prepared', 'implementing', 'implemented', ...third ? [] : ['checking', 'checked'], 'failed', 'cancelled']
      if (!keys(attempt, fields) || !identity(attempt.id) || ids.has(attempt.id) || attempt.epoch !== index * 2 ||
          !timestamp(attempt.requestedAt) || (index === 0 && attempt.requestedAt !== change.createdAt) ||
          (index > 0 && (!previousEnd || attempt.requestedAt < previousEnd)) || !states.includes(attempt.state) ||
          (index < change.attempts.length - 1 && !['cancelled', 'failed'].includes(attempt.state)) ||
          (attempt.state !== 'cancelled' ? attempt.cancelledAt !== null :
            !timestamp(attempt.cancelledAt) || attempt.cancelledAt < attempt.requestedAt)) throw new Error('Invalid attempt')
      ids.add(attempt.id)
      if (legacy) {
        attempt.statusAt = attempt.cancelledAt || attempt.requestedAt
        attempt.preparation = null
      }
      if (legacy || previous) attempt.execution = null
      if (legacy || previous || third) attempt.validation = null
      if (fourth && attempt.validation) {
        if (!keys(attempt.validation, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'toolchainDigest',
          'checksPassed', 'artifact', 'preview', 'error'])) throw new Error('Invalid v4 validation')
        attempt.validation.authority = null
      }
      if ((fourth || fifth) && attempt.validation) {
        if (!keys(attempt.validation, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'toolchainDigest',
          'checksPassed', 'artifact', 'preview', 'authority', 'error'])) throw new Error('Invalid legacy validation')
        attempt.validation.seal = null
      }
      if ((fourth || fifth || sixth) && attempt.validation) {
        if (!keys(attempt.validation, ['operationId', 'ownerPid', 'scope', 'stage', 'sourceDigest', 'toolchainDigest',
          'checksPassed', 'artifact', 'preview', 'authority', 'seal', 'error'])) throw new Error('Invalid legacy seal record')
        attempt.validation.boundBuild = null
      }
      if (!timestamp(attempt.statusAt) || attempt.statusAt < attempt.requestedAt ||
          (attempt.state === 'cancelled' && attempt.statusAt !== attempt.cancelledAt) ||
          (attempt.preparation !== null && !validPreparation(attempt.preparation)) ||
          (attempt.state === 'requested' && attempt.preparation !== null) ||
          (['preparing', 'prepared', 'failed'].includes(attempt.state) && attempt.preparation === null) ||
          (attempt.execution !== null && !validExecution(attempt.execution)) ||
          (['requested', 'preparing', 'prepared'].includes(attempt.state) && attempt.execution !== null) ||
          (['implementing', 'implemented', 'checking', 'checked'].includes(attempt.state) && (!attempt.execution ||
            attempt.preparation?.manifestDigest === null || attempt.preparation?.error !== null)) ||
          (attempt.state === 'implementing' && !['running', 'applying'].includes(attempt.execution.stage)) ||
          (attempt.state === 'implemented' && attempt.execution.stage !== 'implemented') ||
          (attempt.validation !== null && !validValidation(attempt.validation)) ||
          (['requested', 'preparing', 'prepared', 'implementing', 'implemented'].includes(attempt.state) && attempt.validation !== null) ||
          (['checking', 'checked'].includes(attempt.state) && (!attempt.validation || attempt.execution.stage !== 'implemented')) ||
          (attempt.state === 'checking' && !['checking', 'building'].includes(attempt.validation.stage)) ||
          (attempt.state === 'checked' && attempt.validation.stage !== 'checked') ||
          (attempt.state === 'failed' && attempt.preparation.error === null && attempt.execution?.error == null && attempt.validation?.error == null) ||
          ((['prepared', 'implementing', 'implemented', 'checking', 'checked'].includes(attempt.state) || attempt.execution !== null) &&
            (attempt.preparation.workspace.dev === null ||
            attempt.preparation.manifestDigest === null || attempt.preparation.fileCount === null || attempt.preparation.error !== null)))
        throw new Error('Invalid preparation state')
      previousEnd = ['cancelled', 'failed'].includes(attempt.state) ? attempt.statusAt : null
    }
    const last = change.attempts.at(-1)
    if (change.cancellationEpoch !== last.epoch + (['cancelled', 'failed'].includes(last.state) ? 1 : 0) ||
        change.updatedAt !== last.statusAt) throw new Error('Invalid change epoch')
  }
  journal.version = 7
  journal.lifecycleVersion = 7
  return journal
}

module.exports = { decodeJournal, identity, keys, text, validPreparation, validExecution, validValidation, validAuthority, validSeal, validBoundBuild }
