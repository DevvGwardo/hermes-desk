// Reusable Electron launcher for the eval smokes: boots the REAL app window
// via playwright-core's _electron API, in 'dev' mode (own vite on a free port,
// mirroring scripts/launch-desktop.mjs env) or 'packaged' mode (a built app
// from release/). Collects renderer pageerrors + console errors for gates.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron } = require('playwright-core')

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(LIB_DIR, '..', '..')

const VITE_PREFERRED_PORT = Number(process.env.NUB_EVAL_VITE_PORT || 5199)
const VITE_PORT_SCAN = 24

/* ── env resolution (mirrors scripts/launch-desktop.mjs) ── */

/** First matching KEY= from .env.local then .env (no dotenv dependency). */
function envFileValue(name) {
  for (const file of ['.env.local', '.env']) {
    try {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        if (!line.startsWith(`${name}=`)) continue
        return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '')
      }
    } catch {
      /* missing file is fine */
    }
  }
  return ''
}

function resolveMaiaApiBase() {
  return (
    process.env.MAIAVM_API_BASE ||
    envFileValue('MAIAVM_API_BASE') ||
    envFileValue('VITE_MAIAVM_API_BASE') ||
    'https://www.maiavm.com'
  ).replace(/\/+$/, '')
}

function resolveMockFlag() {
  const shell = process.env.VITE_MAIAVM_MOCK || process.env.MAIAVM_MOCK || ''
  if (shell === 'true' || shell === '1') return 'true'
  return 'false'
}

/* ── small process/port helpers ── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function pidsOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return [...new Set(out.trim().split(/\s+/).filter(Boolean))]
  } catch {
    return []
  }
}

function cmdLine(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function tcpConnectable(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (result) => {
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function portInUse(port) {
  // Check both stacks: vite may bind IPv6-only when no --host is given.
  return (
    (await tcpConnectable('127.0.0.1', port)) || (await tcpConnectable('::1', port))
  )
}

/**
 * SIGTERM leftover dev vite FROM THIS REPO holding the preferred port so a
 * relaunch cannot attach to a stale HMR server (same policy launch-desktop.mjs
 * applies to port 5173). Foreign processes are left alone.
 */
async function killStaleEvalVite(port) {
  for (const pid of pidsOnPort(port)) {
    const cmd = cmdLine(pid)
    if (!cmd.includes(ROOT) || !cmd.includes('vite')) continue
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 12; i++) {
    if (pidsOnPort(port).length === 0) return true
    await sleep(250)
  }
  return false
}

/** SIGTERM leftover dev Electron from this repo — a second dev instance would lose the single-instance lock and quit silently. */
function killStaleDevElectron() {
  const marker = `${ROOT}/node_modules/electron/dist/Electron.app`
  try {
    execFileSync('pkill', ['-f', marker], { stdio: 'ignore' })
  } catch {
    /* nothing matched */
  }
}

class RingBuffer {
  constructor(maxLines = 80) {
    this.maxLines = maxLines
    this.lines = []
  }
  push(line) {
    this.lines.push(line)
    if (this.lines.length > this.maxLines) this.lines.shift()
  }
  toString() {
    return this.lines.join('\n')
  }
}

/* ── vite management (dev mode only) ── */

async function pickVitePort() {
  let port = VITE_PREFERRED_PORT
  if (!(await portInUse(port))) return port
  // Preferred port busy: clear our own leftovers first, then scan upward.
  if (await killStaleEvalVite(port)) return port
  console.log(`[electron-app] port ${port} is held by another process, scanning upward…`)
  for (let i = 1; i <= VITE_PORT_SCAN; i++) {
    const candidate = VITE_PREFERRED_PORT + i
    if (!(await portInUse(candidate))) return candidate
  }
  throw new Error(
    `No free port found in ${VITE_PREFERRED_PORT}–${VITE_PREFERRED_PORT + VITE_PORT_SCAN} for the eval vite server`,
  )
}

function spawnVite(port) {
  const out = new RingBuffer()
  const proc = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: ROOT,
      detached: true, // own process group so teardown can kill npx AND vite
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAIAVM_API_BASE: apiBase(),
        VITE_MAIAVM_API_BASE: apiBase(),
        VITE_MAIAVM_MOCK: resolveMockFlag(),
      },
    },
  )
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) out.push(line)
      }
    })
  }
  return { proc, out }
}

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) })
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
      if (res.ok || res.status === 404) return
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`vite dev server did not start at ${url}`)
    await sleep(500)
  }
}

/* ── packaged app discovery ── */

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir).filter((e) => !e.startsWith('.'))
  } catch {
    return []
  }
}

/** Newest built app executable under release/, or null. */
export function findPackagedExecutable() {
  const releaseDir = path.join(ROOT, 'release')
  const bundles = []
  for (const entry of listDirSafe(releaseDir)) {
    const p1 = path.join(releaseDir, entry)
    if (entry.endsWith('.app')) {
      bundles.push(p1)
      continue
    }
    if (!fs.statSync(p1).isDirectory()) continue
    for (const e2 of listDirSafe(p1)) {
      if (e2.endsWith('.app')) bundles.push(path.join(p1, e2))
    }
  }
  const exes = []
  for (const bundle of bundles) {
    const macDir = path.join(bundle, 'Contents', 'MacOS')
    for (const bin of listDirSafe(macDir)) {
      exes.push({ path: path.join(macDir, bin), mtime: fs.statSync(bundle).mtimeMs })
    }
  }
  if (process.platform === 'win32') {
    for (const dir of ['win-unpacked', 'win-arm64-unpacked']) {
      for (const f of listDirSafe(path.join(releaseDir, dir))) {
        if (f.endsWith('.exe')) {
          const p = path.join(releaseDir, dir, f)
          exes.push({ path: p, mtime: fs.statSync(p).mtimeMs })
        }
      }
    }
  }
  if (exes.length === 0) return null
  exes.sort((a, b) => b.mtime - a.mtime)
  return exes[0].path
}

/* ── launcher ── */

export function apiBase() {
  return resolveMaiaApiBase()
}

/**
 * Launch the real Nub Agent desktop app.
 *   mode='dev'      boots its own vite (port 5199 unless taken) and points
 *                   electron's VITE_DEV_SERVER_URL at it.
 *   mode='packaged' launches the newest build found under release/.
 * Returns { mode, vitePort, getApp, getPage, waitForAppReady,
 *           collectedErrors, mainLogTail, close }.
 */
export async function launchApp({ mode = 'dev' } = {}) {
  if (mode !== 'dev' && mode !== 'packaged') {
    throw new Error(`launchApp: unknown mode ${JSON.stringify(mode)} (expected 'dev' or 'packaged')`)
  }

  /** @type {{kind:'pageerror'|'console-error', text:string}[]} */
  const errors = []
  const mainLog = new RingBuffer(120)
  /** @type {import('node:child_process').ChildProcess|null} */
  let viteProc = null
  let viteOut = null
  let vitePort = null
  let electronApp = null
  let page = null
  let closed = false

  const record = (kind, text) => {
    errors.push({ kind, text: String(text).slice(0, 4000) })
  }

  const attachPage = (p) => {
    p.on('pageerror', (err) => record('pageerror', err && err.stack ? err.stack : err))
    p.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location() ? ` (${msg.location().url})` : ''
        record('console-error', `${msg.text()}${loc}`)
      }
    })
    p.on('requestfailed', (req) => {
      record(
        'request-failed',
        `${req.method()} ${req.url()} → ${req.failure()?.errorText || 'failed'}`,
      )
    })
  }

  const killViteGroup = () => {
    if (!viteProc || !viteProc.pid) return
    try {
      process.kill(-viteProc.pid, 'SIGTERM')
    } catch {
      /* group already gone */
    }
  }

  if (mode === 'dev') {
    killStaleDevElectron()
    vitePort = await pickVitePort()
    const spawned = spawnVite(vitePort)
    viteProc = spawned.proc
    viteOut = spawned.out
    await waitForServer(`http://127.0.0.1:${vitePort}`)
    console.log(`[electron-app] vite up on http://127.0.0.1:${vitePort}`)

    try {
      electronApp = await _electron.launch({
        args: ['.'],
        cwd: ROOT,
        env: {
          ...process.env,
          MAIA_ELECTRON_DEV: '1',
          MAIAVM_API_BASE: apiBase(),
          VITE_MAIAVM_API_BASE: apiBase(),
          VITE_MAIAVM_MOCK: resolveMockFlag(),
          VITE_DEV_SERVER_URL: `http://127.0.0.1:${vitePort}`,
        },
      })
    } catch (err) {
      killViteGroup()
      throw err
    }
  } else {
    const exe = findPackagedExecutable()
    if (!exe) {
      throw new Error(
        `No packaged Nub Agent build found under ${path.join(ROOT, 'release')} — run "npm run electron:build" first.`,
      )
    }
    console.log(`[electron-app] launching packaged app: ${exe}`)
    electronApp = await _electron.launch({ executablePath: exe })
  }

  const stderrStream = electronApp.process()?.stderr
  stderrStream?.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) mainLog.push(line)
    }
  })

  electronApp.on('window', (win) => attachPage(win))
  for (const win of electronApp.windows()) attachPage(win)

  async function resolveMainPage(timeoutMs = 15000) {
    if (page) return page
    const t0 = Date.now()
    for (;;) {
      const pages = electronApp
        .windows()
        .filter((p) => !p.url().startsWith('devtools://'))
      if (pages.length > 0) {
        page = pages[pages.length - 1]
        page.setDefaultTimeout(8000)
        return page
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `No Electron window appeared within ${timeoutMs}ms${
            mode === 'packaged'
              ? ' — is another instance of Nub Agent already running? The single-instance lock makes a second copy quit immediately.'
              : ''
          }\nelectron stderr tail:\n${mainLog.toString()}`,
        )
      }
      await sleep(100)
    }
  }

  page = await resolveMainPage()

  /**
   * Wait past boot + dismiss any first-run/demo overlay ("Skip for now
   * (demo)" Telegram gate), mirroring scripts/search-palette-smoke.mjs.
   */
  async function waitForAppReady(p = page, timeoutMs = 20000) {
    const target = p ?? page
    // Renderer mounted and sidebar chrome exists.
    await target
      .getByRole('button', { name: 'Settings' })
      .first()
      .waitFor({ state: 'attached', timeout: timeoutMs })

    let dismissedDemo = false
    const skipDemo = target.getByRole('button', { name: 'Skip for now (demo)' })
    if (await skipDemo.count()) {
      await skipDemo.first().click({ force: true, timeout: 3000 }).catch(() => {})
      dismissedDemo = true
      await sleep(400)
    }
    for (const label of ['Skip', 'Not now', 'Close', 'Cancel', 'Maybe later']) {
      const btn = target.getByRole('button', { name: label })
      if (await btn.count()) {
        await btn
          .first()
          .click({ timeout: 800, force: true })
          .catch(() => {})
      }
    }
    await target.keyboard.press('Escape')
    await sleep(250)
    return dismissedDemo
  }

  function collectedErrors() {
    return [...errors]
  }

  async function close() {
    if (closed) return
    closed = true
    // Grab the process handle BEFORE close(): playwright's process() throws on
    // a disposed ElectronApplication.
    let proc = null
    try {
      proc = electronApp?.process?.() ?? null
    } catch {
      /* already disposed */
    }
    try {
      await electronApp?.close()
    } catch {
      /* already gone */
    }
    // Hard-stop the electron process if graceful close hung.
    if (proc && typeof proc.kill === 'function' && proc.exitCode === null) {
      await sleep(1500)
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    if (viteProc && viteProc.pid) {
      killViteGroup()
      await sleep(500)
      try {
        process.kill(-viteProc.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  // If the runner dies, don't leak the detached vite process group.
  process.on('exit', () => {
    if (viteProc && viteProc.pid && !closed) {
      try {
        process.kill(-viteProc.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  })

  return {
    mode,
    vitePort,
    getApp: () => electronApp,
    getPage: () => page,
    waitForAppReady,
    collectedErrors,
    mainLogTail: () => mainLog.toString(),
    close,
  }
}
