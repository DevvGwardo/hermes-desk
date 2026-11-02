'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const binGuard = require('./bin-guard.cjs')
const { discoverRuntime } = require('./self-modification-runner.cjs')
const { sha, readFile } = require('./self-modification-artifact.cjs')

const POLICY = 'renderer-v1-fixed-types-syntax-config-no-network'
function tools(hermesHome, dependencyRoot = path.join(__dirname, '..', 'node_modules')) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Renderer build isolation is verified only on macOS arm64; no fallback was attempted.')
  const resolved = binGuard.resolveTrustedBin('node', { extraDirs: ['/opt/homebrew/bin', '/usr/local/bin'] })
  if (!resolved.ok) throw new Error('A provisioned trusted Node runtime is required; no installation was attempted.')
  const node = fs.realpathSync(resolved.bin)
  const dependencies = fs.realpathSync(dependencyRoot)
  const python = discoverRuntime(hermesHome).python
  const typescript = path.join(dependencies, 'typescript/lib/tsc.js')
  const vite = path.join(dependencies, 'vite/bin/vite.js')
  const esbuild = fs.realpathSync(path.join(dependencies, '@esbuild/darwin-arm64/bin/esbuild'))
  const esbuildBinaries = [...new Set([dependencies, path.join(dependencies, 'vite/node_modules')]
    .map(root => fs.realpathSync(require.resolve('@esbuild/darwin-arm64/bin/esbuild', { paths: [path.dirname(root)] }))))]
  const react = require.resolve('@vitejs/plugin-react', { paths: [path.dirname(dependencies)] })
  const tailwind = require.resolve('@tailwindcss/vite', { paths: [path.dirname(dependencies)] })
  if (![react, tailwind].every(file => file.startsWith(dependencies + path.sep)))
    throw new Error('Renderer plugins escaped provisioned dependencies')
  for (const executable of [node, python, ...esbuildBinaries]) {
    if (!binGuard.inspectBinTrust(executable).ok) throw new Error('Build runtime trust check failed')
  }
  const versions = Object.fromEntries(['typescript', 'vite', 'esbuild'].map(name => [
    name, JSON.parse(readFile(path.join(dependencies, name, 'package.json')).bytes).version,
  ]))
  return { node, python, dependencies, typescript, vite, esbuild, esbuildBinaries, react, tailwind,
    digest: sha(JSON.stringify({ policy: POLICY, versions,
      trustedPolicy: ['self-modification-build.cjs', 'self-modification-build.py', 'self-modification-validation.cjs',
        'self-modification-seal.cjs', 'self-modification-bound-build.cjs']
        .map(name => sha(readFile(path.join(__dirname, name)).bytes)),
      esbuild: esbuildBinaries.map(file => sha(readFile(file, 32 * 1024 * 1024).bytes)),
      node: sha(readFile(node, 128 * 1024 * 1024).bytes),
      typescript: [typescript, path.join(dependencies, 'typescript/lib/_tsc.js')].map(file => sha(readFile(file).bytes)),
      vite: sha(readFile(vite).bytes) })) }
}
function policy(job, runtime, { authority = false } = {}) {
  const q = JSON.stringify
  const libraries = ['/System/Library', '/System/Volumes/Preboot/Cryptexes/OS', '/usr/lib', '/usr/share',
    path.dirname(path.dirname(runtime.node)), path.dirname(path.dirname(runtime.python)), runtime.dependencies]
  const ancestors = new Set()
  for (const target of [...libraries, job.work, job.controls, __dirname]) {
    for (let dir = path.dirname(target); dir !== '/'; dir = path.dirname(dir)) ancestors.add(dir)
  }
  return `(version 1)(deny default)
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
  ${libraries.map(root => `(subpath ${q(root)})`).join(' ')}
  (subpath ${q(job.work)}) (subpath ${q(job.controls)})
  (literal ${q(path.join(__dirname, 'self-modification-build.py'))}))
(allow file-read* file-write* (subpath ${q(job.work)}))
(allow file-read-metadata ${[...ancestors].map(root => `(literal ${q(root)})`).join(' ')})
(deny file-write* (literal ${q(path.join(job.source, 'node_modules'))}))
(allow process-fork)
(allow process-exec (literal ${q(runtime.node)}) (literal ${q(runtime.python)})
  ${(runtime.esbuildBinaries || [runtime.esbuild]).map(file => `(literal ${q(file)})`).join(' ')})
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(deny file-read* (regex ${q('/(\\.git|\\.env(\\.[^/]*)?|auth\\.json|state\\.db|\\.npmrc|\\.netrc|id_rsa|id_ed25519)(/|$)')}))
${authority ? `(deny process-fork)
(deny file-write* (subpath ${q(job.source)}))
(allow file-read* (subpath ${q(__dirname)}))` : ''}
`
}
/** Fixed executable/argv/config only. No candidate configuration or hooks.
 * The independently timed Node leader uses provisioned build code only. */
async function command(job, runtime, args, signal, { seconds = 230, diagnostic, authority = false, onStdout } = {}) {
  if (process.platform !== 'darwin') throw new Error('Verified build isolation is available only on macOS')
  if (signal.aborted) throw new Error('Check operation cancelled')
  const uid = String(process.getuid())
  const count = execFileSync('/bin/ps', ['-axo', 'uid='], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 })
    .split('\n').filter(line => line.trim() === uid).length
  let child, timer, size = 0, stopped = false
  const stop = () => {
    stopped = true
    if (child && child.exitCode === null && child.signalCode === null) {
      // Only this still-live detached leader's process group.
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  try {
    child = spawn('/usr/bin/sandbox-exec', ['-p', policy(job, runtime, { authority }), runtime.python, '-B',
      path.join(__dirname, 'self-modification-build.py')], {
      cwd: job.source, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: job.home, TMPDIR: job.home, PATH: path.dirname(runtime.node) + ':/usr/bin:/bin',
        LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    })
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(stop, (seconds + 10) * 1000)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ node: runtime.node, args, seconds, processLimit: count + 32 }))
    const output = chunk => {
      if ((size += chunk.length) > 1024 * 1024) stop()
      else diagnostic?.(chunk)
    }
    child.stdout.on('data', chunk => { output(chunk); onStdout?.(chunk) }); child.stderr.on('data', output)
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 && !stopped && !signal.aborted ? resolve() :
        reject(Object.assign(new Error('The bounded sandboxed check did not finish successfully.'),
          { exitCode: code, stopped, aborted: signal.aborted })))
    })
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); stop() }
}
function writeConfig(job) {
  const file = path.join(job.controls, 'renderer-types.json')
  fs.writeFileSync(file, JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true,
      noEmit: true, incremental: false, allowImportingTsExtensions: true, resolveJsonModule: true,
      esModuleInterop: true, types: [], typeRoots: [path.join(job.source, 'node_modules/@types')] },
    include: [path.join(job.source, 'src/**/*.ts'), path.join(job.source, 'src/**/*.tsx')],
  }), { flag: 'wx', mode: 0o600 })
  job.viteConfig = path.join(job.controls, 'renderer-vite.mjs')
  fs.writeFileSync(job.viteConfig, `
import react from ${JSON.stringify(job.runtime.react)}
import tailwind from ${JSON.stringify(job.runtime.tailwind)}
import { existsSync, readFileSync } from 'node:fs'
const bootMark = ${JSON.stringify(path.join(job.source, 'src/assets/boot-mark.svg'))}
export default {
  root: ${JSON.stringify(job.source)}, base: './', envDir: ${JSON.stringify(job.controls)},
  plugins: [react({ babel: { babelrc: false, configFile: false } }), tailwind(), {
    name: 'trusted-preview-boot-mark',
    transformIndexHtml(html) {
      return existsSync(bootMark) ? html.replace('<!--boot-mark-->', readFileSync(bootMark, 'utf8')) : html
    }
  }],
  css: { postcss: { plugins: [] } },
  build: { outDir: ${JSON.stringify(job.output)}, emptyOutDir: true, reportCompressedSize: false,
    modulePreload: false, chunkSizeWarningLimit: 10000 }
}
`, { flag: 'wx', mode: 0o600 })
  fs.symlinkSync(job.runtime.dependencies, path.join(job.source, 'node_modules'))
  return file
}

module.exports = { tools, policy, command, writeConfig, POLICY }
