'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { LANE_RE, TAB_RE, parseHttp } = require('./url-policy.cjs')

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function persistableUrl(raw) {
  if (!raw) return ''
  const url = parseHttp(raw)
  if (!url) return null
  // CONTRACT: drop queries/fragments rather than persist session tokens or OAuth
  // credentials. Navigation in the live tab is unchanged; restore is a clean URL.
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * A saved tab row: ids are validated on load, the URL is re-scrubbed.
 * @typedef {object} PersistTab
 * @property {string} id
 * @property {unknown} url
 * @property {string} title
 * @property {unknown} sharedLogin
 * @property {unknown} createdBy
 */
/**
 * @typedef {object} PersistLanes
 * @property {unknown} [installId]
 * @property {unknown} [focusedLaneId]
 * @property {() => Array<{id: string, activeTabId: unknown}>} allLanes
 * @property {(laneId: string) => Array<PersistTab>} listTabs
 */
/**
 * @param {object} options
 * @param {string} options.userDataDir
 * @param {(message: string) => void} [options.onError]
 */
function createPersistence({ userDataDir, onError = () => {} }) {
  const file = path.join(userDataDir, 'workspace.json')
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  /** @type {{version: number, installId: unknown, focusedLaneId: unknown, lanes: Array<Record<string, unknown>>} | null} */
  let pending = null
  function load() {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.lanes) || data.lanes.length > 256) return null
      const ids = new Set()
      const laneIds = new Set()
      const lanes = []
      for (const lane of data.lanes) {
        if (!lane || !LANE_RE.test(lane.id) || laneIds.has(lane.id) || !Array.isArray(lane.tabs)) continue
        laneIds.add(lane.id)
        const tabs = []
        for (const tab of lane.tabs.slice(0, lane.id === 'you' ? 512 : 8)) {
          if (!tab || !TAB_RE.test(tab.id) || ids.has(tab.id)) continue
          const url = persistableUrl(tab.url)
          if (url === null) continue
          ids.add(tab.id)
          tabs.push({ id: tab.id, url, title: typeof tab.title === 'string' ? tab.title.slice(0, 512) : '',
            sharedLogin: lane.id !== 'you' && tab.sharedLogin === true,
            createdBy: tab.createdBy === 'agent' ? 'agent' : 'user' })
        }
        lanes.push({ id: lane.id, activeTabId: tabs.some((tab) => tab.id === lane.activeTabId) ?
          lane.activeTabId : (tabs[0]?.id || null), tabs })
      }
      return { lanes, focusedLaneId: laneIds.has(data.focusedLaneId) ? data.focusedLaneId : 'you',
        installId: typeof data.installId === 'string' && /^[a-f0-9-]{36}$/.test(data.installId) ? data.installId : undefined }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') onError('Workspace restore unavailable')
      return null
    }
  }

  function flush() {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const data = pending
    pending = null
    /** @type {string | undefined} */
    let temporary
    try {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
      temporary = path.join(userDataDir, `.workspace-${randomUUID()}.tmp`)
      fs.writeFileSync(temporary, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } catch {
      onError('Workspace save unavailable')
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary) } catch {}
      }
    }
  }

  /**
   * @param {PersistLanes} lanes
   */
  function save(lanes) {
    pending = { version: 1, installId: lanes.installId, focusedLaneId: lanes.focusedLaneId,
      lanes: lanes.allLanes().map((lane) => ({
        id: lane.id, activeTabId: lane.activeTabId,
        tabs: lanes.listTabs(lane.id).map((tab) => ({
          id: tab.id, url: persistableUrl(tab.url) || '', title: tab.title.slice(0, 512),
          sharedLogin: tab.sharedLogin, createdBy: tab.createdBy,
        })),
      })) }
    if (!timer) {
      timer = setTimeout(flush, 100)
      timer.unref?.()
    }
  }
  return { load, save, flush }
}

module.exports = { createPersistence, persistableUrl }
