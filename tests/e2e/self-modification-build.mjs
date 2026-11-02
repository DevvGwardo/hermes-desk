// Real provisioned tools, real macOS kernel sandbox, only disposable fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const build = require('../../electron/self-modification-build.cjs')
const tree = require('../../electron/self-modification-artifact.cjs')
const seal = require('../../electron/self-modification-seal.cjs')
const bound = require('../../electron/self-modification-bound-build.cjs')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-build-native-')))
const report = { root, checks: [], failure: null, inferenceRequests: 0 }
const runtime = build.tools('/Users/devgwardo/.hermes')
const runtimeNode = runtime.node
let number = 0
function job() {
  const base = path.join(root, `job-${++number}`)
  fs.mkdirSync(base)
  const j = { root: base, work: path.join(base, 'work'), controls: path.join(base, 'controls'), runtime }
  fs.mkdirSync(j.work); fs.mkdirSync(j.controls)
  j.source = path.join(j.work, 'source'); j.home = path.join(j.work, 'home'); j.output = path.join(j.work, 'output')
  fs.mkdirSync(j.source); fs.mkdirSync(j.home)
  return j
}
async function run(j, args, { seconds = 20, signal = new AbortController().signal } = {}) {
  let output = ''
  try { await build.command(j, runtime, args, signal, { seconds, diagnostic: chunk => { output += chunk } }) }
  catch (error) { throw Object.assign(error, { ownedDiagnostic: output }) }
  return output
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
try {
  const j = job()
  fs.mkdirSync(path.join(j.source, 'src'))
  fs.writeFileSync(path.join(j.source, 'package.json'), JSON.stringify({ name: 'hermes-desk', type: 'module',
    scripts: { build: 'throw Error("npm scripts must not run")' } }))
  fs.writeFileSync(path.join(j.source, 'vite.config.mjs'), 'throw Error("candidate Vite configuration executed")')
  fs.writeFileSync(path.join(j.source, 'postcss.config.cjs'), 'throw Error("candidate PostCSS configuration executed")')
  fs.writeFileSync(path.join(j.source, 'babel.config.cjs'), 'throw Error("candidate Babel configuration executed")')
  fs.writeFileSync(path.join(j.source, 'index.html'), '<h1 id="fixture">Before</h1><script type="module" src="./src/app.ts"></script>')
  fs.writeFileSync(path.join(j.source, 'src/app.ts'), 'document.querySelector("#fixture")!.textContent = "Sealed fixture renderer";')
  const initial = await tree.capture(j.source)
  const config = build.writeConfig(j)
  await run(j, [runtime.typescript, '-p', config])
  await run(j, [runtime.vite, 'build', '--config', j.viteConfig, '--configLoader', 'native'])
  assert.equal((await tree.capture(j.source, { exclude: ['node_modules'] })).digest, initial.digest)
  assert(fs.existsSync(path.join(j.output, 'index.html')))
  report.checks.push('Real fixed TypeScript/Vite build succeeds while candidate Vite/PostCSS/Babel/npm hooks are ignored; source unchanged')

  fs.writeFileSync(path.join(j.source, 'src/app.ts'), 'const broken: number = "wrong type";')
  await assert.rejects(run(j, [runtime.typescript, '-p', config]))
  fs.writeFileSync(path.join(j.source, 'bad.cjs'), 'function broken( {')
  await assert.rejects(run(j, ['--check', path.join(j.source, 'bad.cjs')]))
  report.checks.push('Real independent type and JavaScript syntax errors fail, not simulated green results')

  const protectedRoot = path.join(root, 'protected-profile')
  fs.mkdirSync(protectedRoot)
  const marker = path.join(protectedRoot, 'retained.txt')
  fs.writeFileSync(marker, 'private fixture retained')
  const p = job(), probe = path.join(p.source, 'probe.cjs')
  fs.writeFileSync(probe, `
const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process')
const results = {}
for (const [name, action] of Object.entries({
  read: () => fs.readFileSync(${JSON.stringify(marker)}),
  write: () => fs.writeFileSync(${JSON.stringify(marker)}, 'changed'),
  controls: () => fs.writeFileSync(${JSON.stringify(path.join(p.controls, 'forged.json'))}, '{}'),
  executable: () => cp.execFileSync('/bin/sh', ['-c', 'exit 0']),
  privateWrite: () => fs.writeFileSync(${JSON.stringify(path.join(p.home, 'allowed.txt'))}, 'private only')
})) { try { action(); results[name] = 'allowed' } catch { results[name] = 'denied' } }
const socket = net.connect({ host: '127.0.0.1', port: 1 })
socket.once('connect', () => { results.network = 'allowed'; socket.destroy() })
socket.once('error', e => { results.network = ['EPERM','EACCES'].includes(e.code) ? 'denied' : e.code })
setTimeout(() => { console.log(JSON.stringify(results)); socket.destroy() }, 250)
`)
  const output = await run(p, [probe])
  const results = JSON.parse(output.trim())
  assert.deepEqual(results, { read: 'denied', write: 'denied', controls: 'denied', executable: 'denied',
    privateWrite: 'allowed', network: 'denied' })
  assert.equal(fs.readFileSync(marker, 'utf8'), 'private fixture retained')
  assert(!fs.existsSync(path.join(p.controls, 'forged.json')))
  report.checks.push('Actual kernel denies protected fixture read/write, control forgery, undeclared executable and network; allows scratch writes only')

  const c = job(), cancelProbe = path.join(c.source, 'cancel.cjs'), pidFile = path.join(c.home, 'pid.json')
  fs.writeFileSync(cancelProbe, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));setInterval(()=>{},1000)`)
  const abort = new AbortController()
  const running = run(c, [cancelProbe], { signal: abort.signal })
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await delay(20)
  assert(fs.existsSync(pidFile))
  const pid = JSON.parse(fs.readFileSync(pidFile))
  abort.abort()
  await assert.rejects(running)
  for (let i = 0; i < 50 && alive(pid); i++) await delay(20)
  assert(!alive(pid))
  report.checks.push('Cancellation terminates the owned detached worker, not another app or unrelated process')

  const d = job(), deadlineProbe = path.join(d.source, 'deadline.cjs')
  fs.writeFileSync(deadlineProbe, 'setInterval(()=>{},1000)')
  const began = Date.now()
  await assert.rejects(run(d, [deadlineProbe], { seconds: 1 }))
  assert(Date.now() - began < 5000)
  report.checks.push('Independent Python-to-Node SIGALRM deadline terminates a non-exiting worker before the parent watchdog')

  // Abrupt death of an owned orchestration process, not the user's app.
  const e = job(), parent = path.join(root, 'parent.cjs'), orphanPid = path.join(e.home, 'pid.json')
  fs.writeFileSync(path.join(e.source, 'orphan.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(orphanPid)},JSON.stringify(process.pid));setInterval(()=>{},1000)`)
  fs.writeFileSync(parent, `
require(${JSON.stringify(require.resolve('../../electron/self-modification-build.cjs'))}).command(
 ${JSON.stringify(e)}, ${JSON.stringify(runtime)}, [${JSON.stringify(path.join(e.source, 'orphan.cjs'))}],
 new AbortController().signal, {seconds: 2}).catch(()=>{})
`)
  const orchestrator = spawn(runtimeNode, [parent], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !fs.existsSync(orphanPid); i++) await delay(20)
  assert(fs.existsSync(orphanPid))
  const orphan = JSON.parse(fs.readFileSync(orphanPid))
  orchestrator.kill('SIGKILL')
  await new Promise(resolve => orchestrator.once('close', resolve))
  for (let i = 0; i < 150 && alive(orphan); i++) await delay(20)
  assert(!alive(orphan))
  report.checks.push('Abrupt owned-parent death does not disable the independent worker deadline')

  // Original and sealed provisioning fixtures are both disposable. Never
  // corrupt the checkout's actual dependencies to prove this boundary.
  const graph = await seal.capture(runtime.dependencies, { allowLinks: true, maxFiles: 50000, maxTotal: 1024 * 1024 * 1024 })
  const original = path.join(root, 'original-graph'), inputs = path.join(root, 'sealed-inputs')
  // Fixture provisioning is not the production durable sealing path. Fast
  // APFS clones avoid twice fsyncing 30,000 files; capture independently verifies
  // the exact graph. The UI acceptance test exercises the actual seal copier.
  fs.cpSync(runtime.dependencies, original, { recursive: true, verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE })
  fs.mkdirSync(inputs); fs.mkdirSync(path.join(inputs, 'app'))
  const copied = path.join(inputs, 'app/node_modules')
  fs.cpSync(original, copied, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
  assert.equal((await seal.capture(copied, { allowLinks: true })).digest, graph.digest)
  const frozen = build.tools('/Users/devgwardo/.hermes', copied)
  assert.equal(frozen.dependencies, copied)
  assert([frozen.typescript, frozen.vite, frozen.react, frozen.tailwind, ...frozen.esbuildBinaries]
    .every(file => file.startsWith(copied + path.sep)))
  fs.writeFileSync(path.join(original, 'typescript/lib/tsc.js'), 'throw Error("mutable original graph executed")')
  fs.writeFileSync(path.join(original, 'vite/bin/vite.js'), 'throw Error("mutable original graph executed")')
  const boundRoot = path.join(root, 'bound-renderer')
  fs.mkdirSync(boundRoot)
  const expected = { inputDigest: 'a'.repeat(64), dependencyDigest: graph.digest, sourceDigest: initial.digest,
    toolchainDigest: frozen.digest }
  const compiled = await bound.run(boundRoot, inputs, initial, frozen, expected, new AbortController().signal, () => {},
    (job, tools, args, signal) => build.command(job, tools, args, signal, {
      diagnostic: chunk => fs.appendFileSync(path.join(root, 'owned-bound-build.txt'), chunk),
    }))
  assert.equal(compiled.boundDigest, bound.binding(expected.inputDigest, initial.digest, graph.digest, compiled.digest, frozen.digest))
  assert(compiled.files.some(file => file.path.endsWith('.js') && file.bytes.includes('Sealed fixture renderer')))
  report.checks.push('Real fixed TypeScript/syntax/Vite/repeated-type build uses the exact full copied graph after both disposable original compiler entrypoints are corrupted; exact source/graph/policy/output binding')

  const denied = job()
  denied.runtime = frozen
  const graphFile = path.join(copied, 'typescript/lib/tsc.js'), originalFile = path.join(original, 'typescript/lib/tsc.js')
  const contents = fs.readFileSync(graphFile)
  const graphProbe = path.join(denied.source, 'graph-probe.cjs')
  fs.writeFileSync(graphProbe, `
const fs = require('node:fs'), cp = require('node:child_process')
const results = {}
for (const [name, action] of Object.entries({
  copiedRead: () => fs.readFileSync(${JSON.stringify(graphFile)}),
  copiedWrite: () => fs.appendFileSync(${JSON.stringify(graphFile)}, 'changed'),
  originalRead: () => fs.readFileSync(${JSON.stringify(originalFile)}),
  originalExecute: () => cp.execFileSync(${JSON.stringify(runtime.esbuild)}, ['--version']),
  copiedExecute: () => cp.execFileSync(${JSON.stringify(frozen.esbuild)}, ['--version'])
})) { try { action(); results[name] = 'allowed' } catch { results[name] = 'denied' } }
console.log(JSON.stringify(results))
`)
  let observed = ''
  await build.command(denied, frozen, [graphProbe], new AbortController().signal, {
    diagnostic: chunk => { observed += chunk },
  })
  assert.deepEqual(JSON.parse(observed.trim()), { copiedRead: 'allowed', copiedWrite: 'denied',
    originalRead: 'denied', originalExecute: 'denied', copiedExecute: 'allowed' })
  assert(fs.readFileSync(graphFile).equals(contents))
  report.checks.push('Real kernel permits sealed dependency reads/exact copied native tool, denies copied dependency writes, mutable original graph reads and original native tool execution')
} catch (error) {
  report.failure = error.stack
  if (error.ownedDiagnostic) fs.writeFileSync(path.join(root, 'owned-failure.txt'), error.ownedDiagnostic)
  process.exitCode = 1
} finally {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
