'use strict'

/**
 * Plugin host main-process door — fs read/watch over the two on-disk plugin
 * roots, guarded by the same validateFsPath confinement as the fs door.
 *
 * Roots: <hermes home>/desktop-plugins/<name>/plugin.js and
 * <hermes home>/plugins/<name>/desktop/plugin.js (both native opt-in).
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const crypto = require('node:crypto')
const { ipcMain } = require('electron')
const { readFileBounded } = require('./fs-read.cjs')

const { validateFsPath, isInsideRoot, canonicalPath } = require('./fs-guard.cjs')

function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
}

function pluginRoots() {
  const home = hermesHome()
  const standalone = path.join(home, 'desktop-plugins')
  const unified = path.join(home, 'plugins')
  return { home, standalone, unified }
}

function validatePluginPath(rawPath, label = 'path') {
  const { home } = pluginRoots()
  return validateFsPath(rawPath, label, [home])
}

/**
 * Red-team pass 2: validateFsPath alone jails to ~/.hermes — which contains
 * secrets (serve.token, cron state). Plugin-door paths must additionally be
 * INSIDE one of the two plugin roots, and re-resolved immediately before
 * use (same TOCTOU discipline as the fs door).
 */
function assertInsidePluginRoots(resolvedPath, label = 'path') {
  const { standalone, unified } = pluginRoots()
  let real = resolvedPath
  try {
    real = fs.realpathSync(resolvedPath)
  } catch {
    /* missing path — keep the lexical form; the actual op will fail with
       ENOENT on its own, but containment below is still enforced */
  }
  if (!isInsideRoot(standalone, real) && !isInsideRoot(unified, real)) {
    throw new Error(`Invalid ${label}: outside plugin roots`)
  }
  return real
}

/**
 * Register all `maia:plugins:*` IPC handlers. `deps` carries the main.cjs
 * capabilities: `assertMainSender(event)` and `getMainWindow()` (the live
 * BrowserWindow, for pushing change events to the renderer).
 */
function registerPluginHostIpc({ assertMainSender, getMainWindow, confirm = async () => false, getUserDataDir }) {
  const roots = pluginRoots()
  const watches = new Map()
  const owners = new WeakSet()
  const pins = new Map()
  const pinFile = getUserDataDir ? path.join(getUserDataDir(), 'plugin-trust.json') : null
  // Trusted bytes are archived by hash so a later edit can be reviewed as a
  // diff and an earlier trusted version restored. Main owns both files.
  const archiveDir = getUserDataDir ? path.join(getUserDataDir(), 'plugin-trust-archive') : null
  const historyFile = getUserDataDir ? path.join(getUserDataDir(), 'plugin-trust-history.json') : null
  const history = new Map()
  const MAX_VERSIONS = 5
  const MAX_WATCHES = 128
  const MAX_PLUGIN_BYTES = 1024 * 1024
  let reads = 0
  let trusting = false
  let watchSeq = 0
  if (pinFile) {
    try {
      const stat = fs.lstatSync(pinFile)
      if (stat.isFile() && stat.size <= 128 * 1024) {
        const stored = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
        for (const [file, hash] of Object.entries(stored)) {
          if (typeof hash === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(hash)) pins.set(file, hash)
        }
      }
    } catch { /* No trust is the default, including malformed legacy stores. */ }
  }
  if (historyFile) {
    try {
      const stat = fs.lstatSync(historyFile)
      if (stat.isFile() && stat.size <= 256 * 1024) {
        for (const [file, hashes] of Object.entries(JSON.parse(fs.readFileSync(historyFile, 'utf8')))) {
          if (Array.isArray(hashes)) history.set(file, hashes.filter((hash) => typeof hash === 'string' &&
            /^[A-Za-z0-9+/]{43}=$/.test(hash)).slice(0, MAX_VERSIONS))
        }
      }
    } catch { /* No history only disables review and rollback. */ }
  }
  function writeAtomic(target, text) {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temp, target)
    } finally {
      try { fs.unlinkSync(temp) } catch {}
    }
  }
  function persistPins() {
    if (!pinFile) return
    writeAtomic(pinFile, JSON.stringify(Object.fromEntries(pins)))
  }
  const archivePath = hash => path.join(archiveDir, `${Buffer.from(hash, 'base64').toString('hex')}.js`)
  function archive(file, hash, text) {
    if (!archiveDir || !historyFile) return
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
    const target = archivePath(hash)
    if (!fs.existsSync(target)) writeAtomic(target, text)
    if (!history.has(file) && history.size >= 256) return
    history.set(file, [hash, ...(history.get(file) || []).filter((entry) => entry !== hash)].slice(0, MAX_VERSIONS))
    writeAtomic(historyFile, JSON.stringify(Object.fromEntries(history)))
  }
  async function archivedText(file, hash) {
    if (!archiveDir || !(history.get(file) || []).includes(hash)) return null
    const target = archivePath(hash)
    const stat = fs.lstatSync(target)
    if (!stat.isFile()) return null
    const text = await readFileBounded(target, 'utf8', { maxBytes: MAX_PLUGIN_BYTES })
    return hashText(text) === hash ? text : null
  }
  const pluginPath = file => {
    const real = assertInsidePluginRoots(validatePluginPath(file, 'file'), 'file')
    const standalone = path.relative(canonicalPath(roots.standalone), real).split(path.sep)
    const unified = path.relative(canonicalPath(roots.unified), real).split(path.sep)
    const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
    if (!(standalone.length === 2 && name.test(standalone[0]) && standalone[1] === 'plugin.js') &&
        !(unified.length === 3 && name.test(unified[0]) && unified[1] === 'desktop' && unified[2] === 'plugin.js')) {
      throw new Error('Only desktop plugin entry files are readable')
    }
    return real
  }
  const rootPath = dir => {
    const real = assertInsidePluginRoots(validatePluginPath(dir, 'dir'), 'dir')
    if (real !== canonicalPath(roots.standalone) && real !== canonicalPath(roots.unified)) {
      throw new Error('Only plugin root directories are listable')
    }
    return real
  }
  async function readPlugin(file) {
    if (reads >= 4) throw new Error('Plugin read busy')
    reads++
    try { return await readFileBounded(pluginPath(file), 'utf8', { maxBytes: MAX_PLUGIN_BYTES }) }
    finally { reads-- }
  }
  const hashText = text => crypto.createHash('sha256').update(text, 'utf8').digest('base64')

  ipcMain.handle('maia:plugins:getPin', (event, file) => {
    assertMainSender(event)
    return pins.get(pluginPath(file)) || null
  })
  ipcMain.handle('maia:plugins:trust', async (event, file, expected) => {
    assertMainSender(event)
    if (trusting || typeof expected !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(expected)) return { ok: false }
    trusting = true
    try {
      const real = pluginPath(file)
      const before = await readPlugin(real)
      if (hashText(before) !== expected) return { ok: false }
      if (!await confirm(event, { message: 'Trust this desktop plugin?',
        detail: `${real}\nSHA-256: ${expected}\nThis version will execute with the full authority of Hermes Desk. Only trust code you have reviewed.` })) return { ok: false }
      if (pluginPath(file) !== real || hashText(await readPlugin(real)) !== expected) return { ok: false }
      if (!pins.has(real) && pins.size >= 256) return { ok: false }
      pins.set(real, expected)
      try { persistPins() } catch { pins.delete(real); return { ok: false } }
      try { archive(real, expected, before) } catch { /* Trust stands; only rollback is unavailable. */ }
      return { ok: true, hash: expected }
    } catch { return { ok: false } } finally { trusting = false }
  })
  ipcMain.handle('maia:plugins:history', (event, file) => {
    assertMainSender(event)
    const real = pluginPath(file)
    return { pin: pins.get(real) || null, versions: history.get(real) || [] }
  })
  ipcMain.handle('maia:plugins:trustedSource', async (event, file, hash) => {
    assertMainSender(event)
    try {
      if (typeof hash !== 'string') return { ok: false }
      const text = await archivedText(pluginPath(file), hash)
      return text === null ? { ok: false } : { ok: true, text }
    } catch { return { ok: false } }
  })
  // Rollback writes only bytes the user already trusted, back to the same
  // entry file, after a native confirm. The replaced bytes are archived too.
  ipcMain.handle('maia:plugins:restore', async (event, file, hash) => {
    assertMainSender(event)
    if (trusting || typeof hash !== 'string') return { ok: false }
    trusting = true
    try {
      const real = pluginPath(file)
      const text = await archivedText(real, hash)
      if (text === null || !fs.lstatSync(real).isFile()) return { ok: false }
      const current = await readPlugin(real)
      const replaced = hashText(current)
      const keep = replaced === hash ? null : path.join(archiveDir, `replaced-${Date.now()}-${Buffer.from(replaced, 'base64').toString('hex').slice(0, 16)}.js`)
      if (!await confirm(event, { message: 'Restore an earlier trusted version of this plugin?',
        detail: `${real}\nRestores SHA-256: ${hash}${keep ? `\nThe current file is kept at ${keep}` : ''}\nThe restored version runs with the full authority of Hermes Desk.` })) return { ok: false }
      if (pluginPath(file) !== real || hashText(await readPlugin(real)) !== replaced) return { ok: false }
      if (keep) writeAtomic(keep, current)
      writeAtomic(real, text)
      pins.set(real, hash)
      persistPins()
      archive(real, hash, text)
      return { ok: true, hash }
    } catch { return { ok: false } } finally { trusting = false }
  })
  ipcMain.handle('maia:plugins:revoke', (event, file) => {
    assertMainSender(event)
    pins.delete(pluginPath(file))
    persistPins()
    return { ok: true }
  })

  function notifyChanged(id) {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('maia:plugins:onChanged', { id })
    }
  }

  function startWatch(target, owner) {
    const existing = [...watches].find(([, value]) => value.owner === owner && value.target === target)
    if (existing) return { id: existing[0] }
    if (watches.size >= MAX_WATCHES) throw new Error('Plugin watch limit reached')
    if (!owners.has(owner)) {
      owners.add(owner)
      const cleanup = () => {
        for (const [id, value] of watches) if (value.owner === owner) stopWatch(id, owner)
      }
      owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) cleanup()
      })
      owner.on('render-process-gone', cleanup)
      owner.once('destroyed', cleanup)
    }
    const id = `pw${++watchSeq}`
    let timer = null
    try {
      const watcher = fs.watch(target, () => {
        // Debounce save bursts to one reload tick.
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          if (watches.has(id)) notifyChanged(id)
        }, 250)
      })
      watcher.on('error', () => {
        stopWatch(id, owner)
      })
      watches.set(id, { watcher, target, owner, clear: () => clearTimeout(timer) })
      return { id }
    } catch {
      return { id, error: 'watch failed' }
    }
  }

  function stopWatch(id, owner) {
    const w = watches.get(id)
    if (w && w.owner === owner) {
      w.clear()
      try {
        w.watcher.close()
      } catch {
        /* already closed */
      }
      watches.delete(id)
    }
    return { ok: true }
  }

  ipcMain.handle('maia:plugins:roots', (event) => {
    assertMainSender(event)
    return {
      standalone: fs.existsSync(roots.standalone) ? roots.standalone : null,
      unified: fs.existsSync(roots.unified) ? roots.unified : null,
    }
  })

  ipcMain.handle('maia:plugins:readDir', async (event, rawDir) => {
    assertMainSender(event)
    const dir = rootPath(rawDir)
    if (reads >= 4) throw new Error('Plugin read busy')
    reads++
    try {
      const entries = []
      let scanned = 0
      const handle = await fs.promises.opendir(dir)
      for await (const entry of handle) {
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.name) && entry.isDirectory()) {
          entries.push({ name: entry.name, path: path.join(dir, entry.name), isDirectory: true })
        }
        if (++scanned >= 512) break
      }
      return { entries }
    } finally {
      reads--
    }
  })

  ipcMain.handle('maia:plugins:readFileText', async (event, rawFile) => {
    assertMainSender(event)
    // Red-team pass 2: containment against the plugin ROOTS (not just home —
    // ~/.hermes holds serve.token and other secrets), re-checked on the
    // realpath immediately before the read.
    // ENOENT (folder has no entry file yet) is a normal probe result — the
    // loader's scan uses it to skip non-plugin folders. Return { ok:false }
    // instead of throwing so Electron doesn't log a rejected handler every
    // poll tick for every folder lacking plugin.js.
    try {
      return { ok: true, text: await readPlugin(rawFile) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'read failed' }
    }
  })

  ipcMain.handle('maia:plugins:watchFile', (event, rawFile) => {
    assertMainSender(event)
    return startWatch(pluginPath(rawFile), event.sender)
  })

  ipcMain.handle('maia:plugins:watchDir', (event, rawDir) => {
    assertMainSender(event)
    return startWatch(rootPath(rawDir), event.sender)
  })

  ipcMain.handle('maia:plugins:stopWatch', (event, id) => {
    assertMainSender(event)
    return stopWatch(String(id), event.sender)
  })

  return { roots }
}

module.exports = { registerPluginHostIpc, pluginRoots }
