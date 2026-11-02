'use strict'

const { EventEmitter } = require('node:events')
const agentInput = require('./agent-input.cjs')

/**
 * @typedef {object} TakeoverTab
 * @property {string} id
 * @property {string} laneId
 * @property {unknown} [controller]
 * @property {unknown} [url]
 * @property {import('electron').WebContents} [webContents]
 */
/**
 * @typedef {import('node:events').EventEmitter & {webContents?: import('electron').WebContents}} TakeoverView
 */
/**
 * @typedef {object} TakeoverLanes
 * @property {(laneId: string) => boolean} isPaused
 * @property {(laneId: string) => void} pauseLane
 * @property {(laneId: string) => void} resumeLane
 * @property {(laneId: string) => {kind: string, profile?: unknown}} ensureLane
 * @property {(event: string, payload: unknown) => void} emit
 */
/**
 * @typedef {object} TakeoverDeps
 * @property {TakeoverLanes} lanes
 * @property {() => {cancelLane: (laneId: string, reason: string) => unknown} | null | undefined} getBridge
 * @property {{call: (method: string, params: unknown) => Promise<unknown>} | null | undefined} serveClient
 * @property {(laneId: string) => unknown} getSessionId
 * @property {{send: (message: unknown) => void}} overlay
 * @property {{log: (entry: Record<string, unknown>) => unknown}} audit
 * @property {() => boolean} [shouldSteer]
 */
/**
 * @param {TakeoverDeps} deps
 */
function createTakeover({ lanes, getBridge, serveClient, getSessionId, overlay, audit, shouldSteer = () => true }) {
  /** @type {Map<string, Array<() => void>>} */
  const listeners = new Map()
  /**
   * @param {string} laneId
   * @param {string} text
   */
  async function steer(laneId, text) {
    const sessionId = getSessionId(laneId)
    // CONTRACT: the wave-1 bridge has no session lookup API. The workspace also
    // tracks registerForSession calls; never guess a session or send a global steer.
    if (!sessionId || !serveClient) return
    try {
      await serveClient.call('session.steer', { session_id: sessionId, text })
    } catch {
      audit.log({ lane: laneId, agent: laneId.slice(8), action: 'session.steer', result: 'error' })
    }
  }

  /**
   * @param {TakeoverTab} tab
   */
  function pause(tab) {
    if (tab.controller !== 'agent' || lanes.isPaused(tab.laneId)) return
    lanes.pauseLane(tab.laneId)
    overlay.send({ type: 'clear', tabId: tab.id })
    lanes.emit('user-input', { laneId: tab.laneId, tabId: tab.id })
    try {
      const result = getBridge()?.cancelLane(tab.laneId, 'user_took_control')
      Promise.resolve(result).catch(() => {})
    } catch {}
    audit.log({ agent: tab.laneId.slice(8), lane: tab.laneId, tab: tab.id,
      action: 'takeover', origin: tab.url, result: 'user_took_control', byUser: true })
    // The MCP dispatcher owns steering on its user-input subscription. Never
    // steer here as well, or a single physical input creates two messages.
    if (shouldSteer()) void steer(tab.laneId, `[Workspace] User took control of tab ${tab.id}; wait for them to hand it back.`)
  }

  /**
   * @param {TakeoverTab} tab
   * @param {TakeoverView} view
   */
  function attach(tab, view) {
    detach(tab.id)
    const contents = tab.webContents || view.webContents
    if (!contents) throw new Error('Takeover attach needs tab or view webContents')
    /** @type {Array<() => void>} */
    const registrations = []
    /**
     * @param {EventEmitter} target
     * @param {string} name
     * @param {(...args: Array<unknown>) => void} handler
     */
    function listen(target, name, handler) {
      target.on(name, handler)
      registrations.push(() => target.removeListener(name, handler))
    }
    listen(contents, 'before-input-event', (_event, input) => {
      const detail = /** @type {{workspaceAgentInput?: unknown, defaultPrevented?: unknown, isDefaultPrevented?: () => unknown}} */ (_event)
      const observed = input ? /** @type {{type?: string}} */ (input) : null
      if (!(detail.workspaceAgentInput || detail.defaultPrevented || detail.isDefaultPrevented?.()) &&
          observed && typeof observed.type === 'string' && ['keyDown', 'keyUp', 'char'].includes(observed.type) &&
          !agentInput.consume(contents, observed)) pause(tab)
    })
    // before-mouse-event is Electron's native-input seam, not a page DOM listener.
    listen(contents, 'before-mouse-event', (_event, input) => {
      const observed = input ? /** @type {{type?: string}} */ (input) : null
      if (observed && typeof observed.type === 'string' && ['mouseDown', 'mouseWheel', 'wheel'].includes(observed.type) &&
          !agentInput.consume(contents, observed)) pause(tab)
    })
    for (const target of [view, contents]) {
      listen(target, 'mouseDown', () => pause(tab))
      listen(target, 'wheel', () => pause(tab))
    }
    listeners.set(tab.id, registrations)
  }

  /**
   * @param {string} id
   */
  function detach(id) {
    for (const remove of listeners.get(id) || []) remove()
    listeners.delete(id)
  }

  /**
   * @param {string} laneId
   */
  async function resume(laneId) {
    const lane = lanes.ensureLane(laneId)
    if (lane.kind !== 'agent') throw new Error('Only agent lanes can resume')
    lanes.resumeLane(laneId)
    audit.log({ lane: laneId, agent: lane.profile, action: 'resume', result: 'ok', byUser: true })
    await steer(laneId, '[Workspace] Control returned.')
  }

  return { attach, detach, pause, resume, dispose: () => {
    for (const id of listeners.keys()) detach(id)
  } }
}

module.exports = { createTakeover }
