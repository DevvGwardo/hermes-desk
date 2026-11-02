'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { validateFsPath } = require('../../fs-guard.cjs')
const { PROFILE_RE } = require('./url-policy.cjs')

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const BLOCKED_EXTENSION = /\.(?:app|pkg|dmg|command|sh)[.\s]*$/i

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function safeFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 &&
    !/[\\/\u0000-\u001f\u007f]/.test(name) && !['.', '..'].includes(name) &&
    !BLOCKED_EXTENSION.test(name)
}

/**
 * @param {unknown} home
 * @param {unknown} profile
 * @param {unknown} filename
 * @param {unknown} [configuredRoot]
 * @returns {string}
 */
function downloadPath(home, profile, filename, configuredRoot) {
  if (!PROFILE_RE.test(/** @type {string} */ (profile)) || !safeFilename(filename)) throw new Error('Blocked download')
  const downloads = path.join(/** @type {string} */ (home), 'Downloads')
  const root = /** @type {string} */ (configuredRoot || path.join(downloads, 'Hermes Desk'))
  if (!path.isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)) throw new Error('Unsafe download directory')
  const folder = path.join(root, /** @type {string} */ (profile))
  // Check each component before creating children. No symlink, even one pointing inside
  // the home, may redirect an agent download into another application's files.
  const directories = []
  for (let directory = root; directory !== path.dirname(directory); directory = path.dirname(directory)) directories.unshift(directory)
  directories.push(folder)
  for (const directory of directories) {
    try {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe download directory')
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
      fs.mkdirSync(directory, { mode: 0o700 })
    }
  }
  return validateFsPath(path.join(folder, `${randomUUID()}-${filename}`), 'download', [folder])
}

/**
 * A workspace tab as seen by the download hook.
 * @typedef {object} DownloadTab
 * @property {unknown} [id]
 * @property {unknown} [laneId]
 * @property {unknown} [controller]
 */
/**
 * A will-download listener bound to one session.
 * @typedef {(event: unknown, item: DownloadItem, contents: unknown) => void} DownloadHandler
 */
/**
 * An Electron session the hook is installed on.
 * @typedef {object} DownloadSession
 * @property {(event: string, listener: DownloadHandler) => void} on
 * @property {(event: string, listener: DownloadHandler) => void} removeListener
 */
/**
 * A lane whose downloads are being watched.
 * @typedef {object} DownloadLane
 * @property {unknown} [kind]
 * @property {unknown} [profile]
 * @property {unknown} [id]
 */
/**
 * A single native download item.
 * @typedef {object} DownloadItem
 * @property {(() => unknown) | undefined} [getURL]
 * @property {() => number} getTotalBytes
 * @property {(() => number) | undefined} [getReceivedBytes]
 * @property {() => string} getFilename
 * @property {(path: string) => void} setSavePath
 * @property {() => void} cancel
 * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} on
 * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} removeListener
 */
/**
 * @param {object} deps
 * @param {(contents: unknown) => DownloadTab | null | undefined} deps.getTabForContents
 * @param {{log: (entry: Record<string, unknown>) => unknown}} deps.audit
 * @param {string} [deps.homeDir]
 * @param {() => unknown} [deps.getDownloadsDir]
 */
function createDownloads({ getTabForContents, audit, homeDir = os.homedir(), getDownloadsDir = () => undefined }) {
  /** @type {Map<DownloadSession, DownloadHandler>} */
  const installed = new Map()
  /** @type {Map<DownloadItem, () => void>} */
  const active = new Map()
  /**
   * @param {DownloadSession} ses
   * @param {DownloadLane} lane
   */
  function install(ses, lane) {
    if (installed.has(ses)) return
    /**
     * @param {unknown} event
     * @param {DownloadItem} item
     * @param {unknown} contents
     */
    const handler = (event, item, contents) => {
      const tab = getTabForContents(contents)
      const agent = tab ? tab.controller === 'agent' : lane.kind === 'agent'
      if (!agent) return
      const profile = tab ? /** @type {string} */ (tab.laneId).slice(8) : lane.profile
      const metadata = { agent: profile, lane: tab?.laneId || lane.id, tab: tab?.id,
        action: 'download', origin: item.getURL?.(), byUser: false }
      function blockedSize() {
        const total = item.getTotalBytes()
        const received = item.getReceivedBytes?.() || 0
        return !Number.isFinite(total) || !Number.isFinite(received) ||
          total < 0 || received < 0 || total > MAX_DOWNLOAD_BYTES || received > MAX_DOWNLOAD_BYTES
      }
      function block() {
        /** @type {{preventDefault?: () => void} | null} */ (event)?.preventDefault?.()
        item.cancel()
        audit.log({ ...metadata, result: 'blocked' })
      }
      if (blockedSize() || !safeFilename(item.getFilename())) {
        block()
        return
      }
      try {
        item.setSavePath(downloadPath(homeDir, profile, item.getFilename(), getDownloadsDir()))
      } catch {
        block()
        return
      }
      const updated = () => {
        if (blockedSize()) {
          item.cancel()
          audit.log({ ...metadata, result: 'blocked' })
          cleanup()
        }
      }
      /**
       * @param {unknown} _event
       * @param {unknown} state
       */
      const done = (_event, state) => {
        audit.log({ ...metadata, result: state === 'completed' ? 'ok' : 'cancelled' })
        cleanup()
      }
      function cleanup() {
        item.removeListener('updated', updated)
        item.removeListener('done', done)
        active.delete(item)
      }
      item.on('updated', updated)
      item.on('done', done)
      active.set(item, cleanup)
    }
    ses.on('will-download', handler)
    installed.set(ses, handler)
  }

  function dispose() {
    for (const [ses, handler] of installed) ses.removeListener('will-download', handler)
    for (const [item, cleanup] of active) {
      item.cancel()
      cleanup()
    }
    installed.clear()
  }
  return { install, dispose }
}

module.exports = { createDownloads, downloadPath, safeFilename, MAX_DOWNLOAD_BYTES }
