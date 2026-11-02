'use strict'

const path = require('node:path')
const tree = require('./self-modification-artifact.cjs')
const build = require('./self-modification-build.cjs')
const { keys } = require('./self-modification-schema.cjs')

const SCOPE = 'main-preload-test-doubles'
const CHECKS = Object.freeze(['hardened-main-window', 'host-sender-identity', 'change-main-frame',
  'navigation-denial', 'permission-denial', 'bounded-preload'])
const METHODS = Object.freeze({ list: [], create: [0, { request: 'fixture', acceptanceCriteria: 'fixture' }],
  cancel: [0, 'id', 'attempt'], reopen: [0, 'id', 'attempt'], selectRepository: [],
  prepare: [0, 'id', 'attempt', { selectionId: 'id', baseline: 'head' }], review: ['id', 'attempt'],
  implement: [0, 'id', 'attempt', { port: 8080, model: 'fixture', files: ['note.txt'] }],
  validate: [0, 'id', 'attempt'], preview: [0, 'id', 'attempt'], authority: [0, 'id', 'attempt'], seal: [0, 'id', 'attempt'],
  boundBuild: [0, 'id', 'attempt'], nativeInputs: [0, 'id', 'attempt'],
  deliveryStatus: ['id', 'attempt'], qualify: [0, 'id', 'attempt'], deliveryReview: [0, 'id', 'attempt'],
  approve: [0, 'id', 'attempt', 'version', 'digest'], selectActivationTarget: [0, 'id', 'attempt', 'version'],
  activate: [0, 'id', 'attempt', 'version'] })

/** Definitions and verdicts live in trusted main, not in candidate tests. Child
 * observations are still untrusted: these limited adapter contracts cannot
 * certify malicious intent, dependency behavior, native Electron or app health. */
function evaluate(trace) {
  if (!keys(trace, ['preferences', 'host', 'changes', 'navigation', 'permissions', 'preload']))
    throw new Error('Incomplete authority observations')
  const verdicts = [
    trace.preferences?.sandbox === true && trace.preferences?.contextIsolation === true &&
      trace.preferences?.nodeIntegration === false && trace.preferences?.preload === 'preload.cjs',
    trace.host?.main === true && trace.host?.foreign === false,
    trace.changes?.main === true && trace.changes?.foreign === false && trace.changes?.subframe === false,
    trace.navigation?.navigate === true && trace.navigation?.redirect === true && trace.navigation?.popup === true,
    trace.permissions?.request === false && trace.permissions?.check === false,
    keys(trace.preload, Object.keys(METHODS)) && Object.entries(METHODS).every(([name, args]) =>
      keys(trace.preload[name], ['channel', 'args']) && trace.preload[name].channel === `hd:changes:${name}` &&
      JSON.stringify(trace.preload[name].args) === JSON.stringify(args)),
  ]
  return CHECKS.map((name, index) => ({ name, passed: verdicts[index] === true }))
}
function definitionDigest() {
  return tree.sha(Buffer.concat(['self-modification-authority.cjs', 'self-modification-authority-worker.cjs']
    .map(file => tree.readFile(path.join(__dirname, file)).bytes)))
}
async function observe(job, runtime, signal, { seconds = 30 } = {}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Invalid authority deadline')
  let stdout = Buffer.alloc(0), oversized = false
  await build.command(job, runtime, [path.join(__dirname, 'self-modification-authority-worker.cjs'), job.source, job.home],
    signal, { seconds, authority: true, onStdout: bytes => {
      if (stdout.length + bytes.length > 128 * 1024) oversized = true
      else if (!oversized) stdout = Buffer.concat([stdout, bytes])
    } })
  if (oversized) throw new Error('Authority observations exceed their limit')
  return JSON.parse(stdout.toString('utf8'))
}

module.exports = { evaluate, definitionDigest, observe, CHECKS, METHODS, SCOPE }
