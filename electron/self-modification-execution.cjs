'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { keys, text, identity } = require('./self-modification-schema.cjs')
const runner = require('./self-modification-runner.cjs')
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, message) => { throw Object.assign(new Error(message), { executionCode: code }) }

function createExecutionManager(userDataDir, controller, workspace, { confirm, hermesHome, run = runner.runHermes } = {}) {
  const active = new Map()
  const pending = new Set()
  function current(id, attemptId) {
    const snapshot = controller.list()
    if (!snapshot.ok) fail(snapshot.code, snapshot.error)
    const change = snapshot.changes.find(item => item.id === id), attempt = change?.attempts.at(-1)
    if (!identity(id) || !identity(attemptId) || attempt?.id !== attemptId) fail('stale', 'The execution attempt changed.')
    return { snapshot, change, attempt }
  }
  function fence(id, attemptId, epoch, operationId, signal) {
    const { change, attempt } = current(id, attemptId)
    if (signal.aborted || attempt.state !== 'implementing' || attempt.epoch !== epoch ||
        change.cancellationEpoch !== epoch || attempt.execution?.operationId !== operationId)
      fail('stale', 'Implementation was cancelled or superseded.')
  }
  function checkpoint(id, attemptId, epoch, operationId, outcome) {
    const result = controller.checkpointExecution(id, attemptId, epoch, operationId, outcome)
    if (!result.ok) fail(result.code, result.error)
  }
  async function execute(id, attemptId, context, execution, signal) {
    const { operationId } = execution
    const epoch = current(id, attemptId).attempt.epoch
    const check = () => fence(id, attemptId, epoch, operationId, signal)
    try {
      check()
      // A fresh private runtime HOME is never a live Hermes profile or candidate.
      const home = path.join(userDataDir, 'self-modification', `run-${operationId}`)
      fs.mkdirSync(home, { mode: 0o700 })
      const { proposal, calls } = await run({ home, hermesHome: hermesHome(), context,
        model: execution.model, port: execution.port, signal,
        onCall: async calls => {
          check()
          checkpoint(id, attemptId, epoch, operationId, { calls })
        } })
      check()
      checkpoint(id, attemptId, epoch, operationId, { stage: 'applying', calls })
      const outputDigest = await workspace.applyProposal(id, attemptId, context, proposal, check)
      check()
      checkpoint(id, attemptId, epoch, operationId, { stage: 'implemented', outputDigest })
    } catch (error) {
      try {
        check()
        checkpoint(id, attemptId, epoch, operationId, { stage: 'failed',
          error: error.executionCode || error.workspaceCode ? error.message.slice(0, 500) :
            'Isolated Hermes execution failed or exceeded its limits. Any candidate edits were retained; no validation or activation occurred.' })
      } catch { /* Lost checkpoint remains implementing/unknown until recovery; no replay. */ }
    } finally { active.delete(operationId) }
  }
  return {
    async implement(revision, id, attemptId, input, authorize = () => {}) {
      let ownsPending = false
      try {
        if (!keys(input, ['port', 'model', 'files']) || !Number.isInteger(input.port) ||
            input.port < 1024 || input.port > 65535 || [8642, 9119].includes(input.port) ||
            !text(input.model, 200) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input.model))
          fail('invalid', 'Choose a local, tool-free model server port and model, not an agent gateway.')
        if (active.size || pending.size) fail('limit', 'One bounded implementation or confirmation is already active.')
        pending.add(attemptId)
        ownsPending = true
        const context = await workspace.context(id, attemptId, input.files)
        const before = current(id, attemptId)
        if (before.snapshot.revision !== revision || before.attempt.state !== 'prepared') fail('stale', 'Reload the prepared candidate.')
        const approved = await confirm({ id, attemptId, ...input, inputDigest: sha(context) })
        authorize()
        if (!approved)
          return { ...before.snapshot, ok: true } // decline is not cancellation of the request
        const latest = await workspace.context(id, attemptId, input.files)
        if (sha(latest) !== sha(context)) fail('stale', 'Candidate context changed during confirmation. Nothing was started.')
        const execution = { operationId: randomUUID(), ownerPid: process.pid, stage: 'running',
          port: input.port, model: input.model, files: [...input.files], inputDigest: sha(context),
          calls: 0, outputDigest: null, error: null }
        const started = controller.beginExecution(revision, id, attemptId, execution)
        if (!started.ok) return started
        const abort = new AbortController()
        active.set(execution.operationId, { id, attemptId, abort })
        void execute(id, attemptId, context, execution, abort.signal)
        return started
      } catch (error) {
        return { ok: false, code: error.executionCode || error.workspaceCode || 'storage',
          error: error.executionCode || error.workspaceCode ? error.message :
            'Implementation could not start. Existing records and candidates were retained.' }
      } finally { if (ownsPending) pending.delete(attemptId) }
    },
    cancel(id, attemptId) {
      for (const work of active.values()) if (work.id === id && work.attemptId === attemptId) work.abort.abort()
    },
    recover() {
      const snapshot = controller.list()
      if (!snapshot.ok) return
      for (const change of snapshot.changes) {
        const attempt = change.attempts.at(-1), execution = attempt.execution
        if (attempt.state !== 'implementing' || active.has(execution.operationId)) continue
        let gone = execution.ownerPid === process.pid
        try { process.kill(execution.ownerPid, 0) } catch (error) { gone = error.code === 'ESRCH' }
        if (gone) controller.checkpointExecution(change.id, attempt.id, attempt.epoch, execution.operationId, {
          stage: 'failed', error: 'Implementation was interrupted or its acknowledgment was lost. Candidate work was retained; no execution was resumed.',
        })
      }
    },
  }
}

module.exports = { createExecutionManager }
