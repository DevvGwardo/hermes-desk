import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickDevPort } from './dev-port.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:MAIAVM_|VITE_MAIAVM_|MAIA_UPDATE_|ELECTRON_RUN_AS_NODE$)/.test(key)))
let vite
let electron
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  vite?.kill('SIGTERM')
  electron?.kill('SIGTERM')
  process.exitCode = code
}

function busy(port) {
  try {
    return Boolean(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch { return false }
}

async function launch() {
  const pick = pickDevPort({ busy, env })
  if (!pick.ok) throw new Error(pick.error)
  if (pick.port === 8642 || pick.port === 9119) throw new Error('That port is reserved for Hermes')
  const url = `http://127.0.0.1:${pick.port}`
  const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
  vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1',
    '--port', String(pick.port), '--strictPort'], { cwd: root, stdio: 'inherit', env })
  let viteDead = false
  vite.on('error', () => { viteDead = true; shutdown(1) })
  vite.on('exit', (code) => { viteDead = true; shutdown(code ?? 1) })
  let ready = false
  for (let attempt = 0; attempt < 60 && !viteDead && !shuttingDown; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) })
      await response.body?.cancel()
      if (response.ok) { ready = true; break }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready || viteDead || shuttingDown) throw new Error('Vite did not become ready')
  console.log(`[hermes-desk] renderer ${url}`)
  electron = spawn(process.execPath, [require.resolve('electron/cli.js'), '.'], {
    cwd: root, stdio: 'inherit',
    env: { ...env, MAIA_ELECTRON_DEV: '1', VITE_DEV_SERVER_URL: url },
  })
  electron.on('error', () => shutdown(1))
  electron.on('exit', (code) => shutdown(code ?? 0))
}

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())
launch().catch((error) => { console.error(error.message); shutdown(1) })
