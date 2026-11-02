// Real kernel confinement; candidate main/preload use declared test doubles.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const authority = require('../../electron/self-modification-authority.cjs')
const build = require('../../electron/self-modification-build.cjs')
const tree = require('../../electron/self-modification-artifact.cjs')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-authority-native-')))
const runtime = build.tools('/Users/devgwardo/.hermes')
const repo = path.resolve(import.meta.dirname, '../..')
const report = { root, checks: [], failure: null, nativeCandidateApp: false, inferenceRequests: 0 }
let number = 0
function job(main = fs.readFileSync(path.join(repo, 'electron/main.cjs'), 'utf8')) {
  const base = path.join(root, `job-${++number}`)
  fs.mkdirSync(base)
  const j = { root: base, work: path.join(base, 'work'), controls: path.join(base, 'controls') }
  fs.mkdirSync(j.work); fs.mkdirSync(j.controls)
  j.source = path.join(j.work, 'source'); j.home = path.join(j.work, 'home')
  fs.mkdirSync(j.source); fs.mkdirSync(j.home); fs.mkdirSync(path.join(j.source, 'electron'))
  fs.writeFileSync(path.join(j.source, 'electron/main.cjs'), main)
  fs.copyFileSync(path.join(repo, 'electron/preload.cjs'), path.join(j.source, 'electron/preload.cjs'))
  return j
}
try {
  const j = job(), before = await tree.capture(j.source)
  const trace = await authority.observe(j, runtime, new AbortController().signal)
  const verdicts = authority.evaluate(trace)
  assert(verdicts.every(check => check.passed), JSON.stringify(verdicts))
  assert.equal((await tree.capture(j.source)).digest, before.digest)
  report.checks.push('Actual candidate main/preload fixture observations satisfy six independently evaluated contracts; source bytes/modes unchanged')

  const weak = job(fs.readFileSync(path.join(repo, 'electron/main.cjs'), 'utf8').replaceAll('nodeIntegration: false', 'nodeIntegration: true'))
  const weakTrace = await authority.observe(weak, runtime, new AbortController().signal)
  assert.equal(authority.evaluate(weakTrace)[0].passed, false)
  report.checks.push('Real hardened-window regression is observed red under the same native execution policy')

  const protectedFile = path.join(root, 'protected.txt')
  fs.writeFileSync(protectedFile, 'owned protected fixture')
  const p = job()
  fs.appendFileSync(path.join(p.source, 'electron/main.cjs'), `
const fsProbe = require('node:fs')
const denied = {}
for (const [name, action] of Object.entries({
 read: () => fsProbe.readFileSync(${JSON.stringify(protectedFile)}),
 write: () => fsProbe.writeFileSync(${JSON.stringify(protectedFile)}, 'changed'),
 sourceWrite: () => fsProbe.appendFileSync(__dirname + '/main.cjs', 'changed'),
 fork: () => require('node:child_process').execFileSync('/bin/sh', ['-c','exit 0'])
})) { try { action(); denied[name] = false } catch { denied[name] = true } }
const socket = require('node:net').connect({host:'127.0.0.1',port:1})
socket.once('error', e => {
 denied.network = ['EPERM','EACCES'].includes(e.code)
 fsProbe.writeFileSync(${JSON.stringify(path.join(p.home, 'denials.json'))}, JSON.stringify(denied))
})
`)
  await authority.observe(p, runtime, new AbortController().signal)
  const denials = JSON.parse(fs.readFileSync(path.join(p.home, 'denials.json'), 'utf8'))
  assert.deepEqual(denials, { read: true, write: true, sourceWrite: true, fork: true, network: true })
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'owned protected fixture')
  report.checks.push('Real candidate code cannot read/write a protected fixture, alter its frozen source, fork or connect; private scratch only')

  const invalid = job('throw new Error("candidate boot fault")')
  await assert.rejects(authority.observe(invalid, runtime, new AbortController().signal))
  const hung = job('while (true) {}')
  const began = Date.now()
  await assert.rejects(authority.observe(hung, runtime, new AbortController().signal))
  assert(Date.now() - began < 5000)
  report.checks.push('Missing/throwing boot and an initial infinite loop fail, not fabricated readiness')

  const hold = () => {
    const j = job()
    fs.appendFileSync(path.join(j.source, 'electron/main.cjs'), `
require('node:fs').writeFileSync(${JSON.stringify(path.join(j.home, 'pid.json'))}, JSON.stringify(require('node:process').pid))
require('electron').ipcMain.handle('hd:changes:list', () => new Promise(()=>{}))
require('node:timers').setInterval(()=>{},1000)
`)
    return j
  }
  const d = hold(), beganDeadline = Date.now()
  await assert.rejects(authority.observe(d, runtime, new AbortController().signal, { seconds: 1 }))
  assert(Date.now() - beganDeadline < 5000)
  report.checks.push('A hung asynchronous contract reply expires under the independent Node alarm, not the VM startup timeout')

  const c = hold(), abort = new AbortController()
  const running = authority.observe(c, runtime, abort.signal)
  const pidFile = path.join(c.home, 'pid.json')
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(20)
  assert(fs.existsSync(pidFile))
  const pid = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
  abort.abort()
  await assert.rejects(running)
  const alive = () => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  for (let i = 0; i < 50 && alive(); i++) await delay(20)
  assert.equal(alive(), false)
  report.checks.push('Native cancellation terminates only the owned authority worker and never records hung observations as success')
} catch (error) { report.failure = error.stack; process.exitCode = 1 }
finally {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
