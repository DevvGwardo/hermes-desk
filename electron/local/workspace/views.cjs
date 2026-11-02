'use strict'

const path = require('node:path')
const approvedValues = require('./approved-values.cjs')
const agentInput = require('./agent-input.cjs')
const { TAB_RE } = require('./url-policy.cjs')

const TAB_PREFERENCES = Object.freeze({
  sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
  backgroundThrottling: true, navigateOnDragDrop: false,
})

/**
 * Overlay messages from the renderer. Every field is untrusted until validated.
 * @typedef {object} OverlayMessage
 * @property {string} type
 * @property {string} [tabId]
 * @property {Array<{x: number, y: number, width: number, height: number}>} [rects]
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [phase]
 * @property {string} [color]
 * @property {string} [label]
 */
/**
 * @param {unknown} msg
 * @returns {OverlayMessage | null}
 */
function validOverlayMessage(msg) {
  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000
  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  const rect = (value) => {
    if (!value || typeof value !== 'object') return false
    const r = /** @type {Record<string, number>} */ (value)
    return ['x', 'y', 'width', 'height'].every((key) => number(r[key])) && r.width >= 0 && r.height >= 0
  }
  if (!msg || typeof msg !== 'object') return null
  const m = /** @type {Record<string, unknown>} */ (msg)
  const tabId = typeof m.tabId === 'string' && TAB_RE.test(m.tabId) ? m.tabId : null
  if (m.type === 'clear') return m.tabId === undefined ? { type: 'clear' } :
    tabId ? { type: 'clear', tabId } : null
  if (!tabId) return null
  if (m.type === 'masks' && Array.isArray(m.rects) && m.rects.length <= 1000 && m.rects.every(rect)) {
    return { type: 'masks', tabId, rects: m.rects.map(({ x, y, width, height }) => ({ x, y, width, height })) }
  }
  if (m.type === 'cursor' && typeof m.x === 'number' && typeof m.y === 'number' && number(m.x) && number(m.y) &&
    typeof m.phase === 'string' && ['move', 'press', 'release'].includes(m.phase) &&
    typeof m.color === 'string' && /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(m.color) &&
    typeof m.label === 'string' && m.label.length <= 128) {
    return { type: 'cursor', tabId, x: m.x, y: m.y, phase: m.phase, color: m.color, label: m.label }
  }
  return null
}

/**
 * WebContentsView on newer Electron runtimes. Older runtimes lack the native
 * hit-test API; the constructor branch below detects that at runtime.
 * @typedef {import('electron').WebContentsView & {setIgnoreMouseEvents?: (ignore: boolean) => void}} OverlayView
 */
/**
 * @typedef {object} WorkspaceTab
 * @property {string} id
 * @property {string} laneId
 * @property {string} [partition]
 * @property {unknown} [controller]
 * @property {string} [url]
 * @property {string} [title]
 * @property {unknown} [state]
 * @property {unknown} [favicon]
 * @property {unknown} [discarded]
 * @property {unknown} [liveReady]
 * @property {import('electron').WebContents | null} [webContents]
 */
/**
 * @typedef {object} WorkspaceLanes
 * @property {(laneId: string) => unknown} policyContext
 * @property {() => void} changed
 * @property {(tabId: string, state: string) => void} setTabState
 * @property {(laneId: string) => boolean} isPaused
 * @property {(laneId: string, url: string, options: unknown) => Promise<unknown>} openTab
 * @property {(laneId: string) => {kind: string, profile?: unknown}} ensureLane
 */
/**
 * @typedef {object} UrlPolicyCheck
 * @property {(url: unknown, context: unknown) => {ok: boolean, url?: string, reason?: string}} check
 */
/**
 * @param {object} deps
 * @param {new (options: {webPreferences: Record<string, unknown>}) => OverlayView} deps.WebContentsView
 * @param {new (options: Record<string, unknown>) => import('electron').BrowserWindow} [deps.BrowserWindow]
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {UrlPolicyCheck} deps.urlPolicy
 * @param {() => WorkspaceLanes} deps.getLanes
 * @param {(tab: WorkspaceTab, view: import('electron').WebContentsView) => void} [deps.onCreate]
 * @param {(tab: {id: string}) => void} [deps.onDestroy]
 * @param {(shortcut: Record<string, unknown>) => void} [deps.onShortcut]
 * @param {{log: (entry: Record<string, unknown>) => unknown}} deps.audit
 */
function createViews({ WebContentsView, BrowserWindow, getMainWindow, urlPolicy, getLanes,
  onCreate = () => {}, onDestroy = () => {}, onShortcut = () => {}, audit }) {
  /** @type {Map<string, {view: import('electron').WebContentsView, remove: Array<() => void>}>} */
  const records = new Map()
  /** @type {import('electron').Rectangle | null} */
  let bounds = null
  let visible = true
  /** @type {string | null} */
  let activeTabId = null
  /** @type {import('electron').WebContentsView | null} */
  let mounted = null
  let disposed = false
  const main = getMainWindow()
  /** @type {OverlayView | null} */
  let overlayView = null
  /** @type {import('electron').BrowserWindow | null} */
  let overlayWindow = null
  /** @type {import('electron').WebContents | null} */
  let overlayContents = null
  let overlayReady = Promise.resolve(false)
  let overlayQueue = Promise.resolve()
  let overlayGeneration = 0

  // CONTRACT: Electron 37 WebContentsView has no native hit-test/ignore-mouse API.
  // CSS pointer-events alone is NOT click-through. Use a transparent, non-focusable
  // child window on that runtime; it forwards no events and cannot steal keyboard focus.
  if (typeof WebContentsView.prototype.setIgnoreMouseEvents === 'function') {
    overlayView = new WebContentsView({ webPreferences: { ...TAB_PREFERENCES } })
    overlayView.setBackgroundColor('#00000000')
    overlayView.setIgnoreMouseEvents?.(true)
    overlayView.setVisible(false)
    overlayContents = overlayView.webContents
  } else if (BrowserWindow) {
    overlayWindow = new BrowserWindow({ parent: main, frame: false, transparent: true,
      show: false, focusable: false, skipTaskbar: true, hasShadow: false,
      resizable: false, movable: false, webPreferences: { ...TAB_PREFERENCES } })
    overlayWindow.setIgnoreMouseEvents(true)
    overlayContents = overlayWindow.webContents
  }
  if (overlayContents) {
    overlayContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlayContents.on('will-attach-webview', (event) => event.preventDefault())
    overlayContents.on('will-navigate', (event) => event.preventDefault())
    overlayReady = Promise.resolve(overlayContents.loadFile(path.join(__dirname, 'overlay.html')))
      .then(() => true, () => false)
  }

  const overlay = {
    // CONTRACT: CDP capture of a tab never includes a sibling view/child window.
    // The executor must black-fill masks in main before returning screenshots.
    requiresScreenshotComposite: true,
    /**
     * @param {unknown} msg
     */
    send(msg) {
      const safe = validOverlayMessage(msg)
      if (!safe || disposed || (safe.tabId && safe.tabId !== activeTabId)) return
      const generation = overlayGeneration
      overlayQueue = overlayQueue.then(async () => {
        if (!overlayContents || !await overlayReady || disposed || overlayContents.isDestroyed() ||
            generation !== overlayGeneration || (safe.tabId && safe.tabId !== activeTabId)) return
        await overlayContents.executeJavaScript(`window.hermesWorkspaceOverlay.receive(${JSON.stringify(safe)})`)
      }).catch(() => {})
    },
    /**
     * @param {string | null} [tabId]
     */
    async waitFrame(tabId) {
      // Background lanes have no pixels in this overlay. Main bitmap masking
      // remains mandatory; don't wait for a hidden window's animation frame.
      if (tabId && (tabId !== activeTabId || !visible || !bounds?.width || !bounds?.height)) return
      await overlayQueue
      if (!overlayContents || !await overlayReady || disposed || overlayContents.isDestroyed()) throw new Error('Overlay unavailable')
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      try {
        await Promise.race([
          overlayContents.executeJavaScript('window.hermesWorkspaceOverlay.waitFrame()'),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Overlay paint timed out')), 1000) }),
        ])
      } finally { clearTimeout(timer) }
    },
  }

  /**
   * @param {WorkspaceTab} tab
   * @param {unknown} url
   * @returns {{ok: boolean, url?: string, reason?: string}}
   */
  function safeNavigation(tab, url) {
    const lanes = getLanes()
    return urlPolicy.check(url, lanes.policyContext(tab.laneId))
  }

  /**
   * @param {WorkspaceTab} tab
   * @returns {import('electron').WebContents}
   */
  function create(tab) {
    if (disposed) throw new Error('Workspace closed')
    if (records.has(tab.id)) destroy(tab)
    const view = new WebContentsView({ webPreferences: { ...TAB_PREFERENCES, partition: tab.partition } })
    const contents = view.webContents
    // A new WebContentsView has no renderer document until its first load.
    // Await this before attaching CDP, including when reviving a discarded tab.
    /** @type {Promise<unknown>} */
    let ready
    /** @type {Array<() => void>} */
    const remove = []
    /**
     * @param {string} name
     * @param {(...args: Array<unknown>) => void} handler
     */
    function listen(name, handler) {
      const bus = /** @type {import('node:events').EventEmitter} */ (contents)
      bus.on(name, handler)
      remove.push(() => bus.removeListener(name, handler))
    }
    function changed() { getLanes().changed() }
    listen('before-input-event', (event, input) => {
      const detail = /** @type {{workspaceAgentInput?: unknown, preventDefault: () => void}} */ (event)
      const key = /** @type {import('./agent-input.cjs').InputEventParams & {isAutoRepeat?: unknown}} */ (input)
      if (!key || key.type !== 'keyDown' || key.isAutoRepeat || key.alt ||
          !(key.meta || key.control)) return
      const name = String(key.key || '').toLowerCase()
      if (name !== 't' && !(!key.shift && (name === 'l' || /^[1-9]$/.test(name)))) return
      if (agentInput.consume(contents, key)) { detail.workspaceAgentInput = true; return }
      detail.preventDefault()
      onShortcut({ key: name, code: key.code || (name === 't' ? 'KeyT' : name === 'l' ? 'KeyL' : `Digit${name}`),
        metaKey: Boolean(key.meta), ctrlKey: Boolean(key.control), shiftKey: Boolean(key.shift) })
    })
    /**
     * @param {unknown} event
     * @param {unknown} url
     */
    const guard = (event, url) => {
      const stoppable = /** @type {{preventDefault: () => void}} */ (event)
      if (!tab.url && url === 'about:blank') return
      if (!safeNavigation(tab, url).ok) {
        stoppable.preventDefault()
        audit.log({ agent: getLanes().ensureLane(tab.laneId).profile, lane: tab.laneId, tab: tab.id,
          action: 'navigation', origin: url, result: 'blocked', byUser: false })
      }
    }
    contents.setWindowOpenHandler(({ url }) => {
      const decision = safeNavigation(tab, url)
      if (decision.ok && decision.url) void getLanes().openTab(tab.laneId, decision.url, {
        createdBy: tab.controller === 'agent' ? 'agent' : 'user',
      }).catch(() => {})
      return { action: 'deny' }
    })
    listen('will-attach-webview', (event) => {
      const stoppable = /** @type {{preventDefault: () => void}} */ (event)
      stoppable.preventDefault()
    })
    listen('will-navigate', guard)
    listen('will-redirect', guard)
    listen('will-frame-navigate', (details) => {
      const frame = /** @type {{isMainFrame?: unknown, url?: unknown}} */ (details)
      if (frame.isMainFrame) guard(frame, frame.url)
    })
    listen('did-start-loading', () => {
      if (tab.state !== 'agent-acting') getLanes().setTabState(tab.id, 'loading')
    })
    listen('did-stop-loading', () => {
      if (tab.state !== 'agent-acting') getLanes().setTabState(tab.id, 'idle')
      changed()
    })
    /**
     * @param {unknown} _event
     * @param {unknown} url
     */
    const navigated = (_event, url) => {
      if (safeNavigation(tab, url).ok) {
        tab.url = approvedValues.scrub(contents, url)
        changed()
      }
    }
    listen('did-navigate', navigated)
    listen('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) navigated(_event, url)
    })
    listen('page-title-updated', (_event, title) => {
      tab.title = typeof title === 'string' ? approvedValues.scrub(contents, title).slice(0, 512) : ''
      changed()
    })
    listen('page-favicon-updated', (_event, urls) => {
      tab.favicon = Array.isArray(urls) ? urls.find((url) => safeNavigation(tab, url).ok &&
        approvedValues.scrub(contents, url) === url) : undefined
      changed()
    })
    listen('render-process-gone', () => {
      destroy(tab)
      tab.webContents = null
      tab.discarded = true
      tab.state = getLanes().isPaused(tab.laneId) ? 'user-paused' : 'idle'
      changed()
    })
    records.set(tab.id, { view, remove })
    view.setVisible(false)
    onCreate(tab, view)
    const decision = tab.url ? safeNavigation(tab, tab.url) : { ok: true, url: 'about:blank' }
    if (!decision.ok || !decision.url) {
      destroy(tab)
      throw new Error('Navigation blocked')
    }
    ready = Promise.resolve(contents.loadURL(decision.url))
    // Only this main-owned initialization may load about:blank. It is not
    // admitted by public navigation or the agent URL policy.
    ready.catch(() => {
      if (records.get(tab.id)?.view === view) {
        getLanes().setTabState(tab.id, 'idle')
        audit.log({ lane: tab.laneId, tab: tab.id, action: 'navigation', result: 'error' })
      }
    })
    tab.liveReady = ready
    return contents
  }

  function unmount() {
    if (!mounted) return
    mounted.setVisible(false)
    try { main?.contentView.removeChildView(mounted) } catch {}
    mounted = null
  }

  /**
   * @param {string | null} [tabId]
   */
  function compose(tabId = activeTabId) {
    if (tabId !== activeTabId) {
      overlayGeneration++
      const scope = { type: 'activate', tabId }
      overlayQueue = overlayQueue.then(async () => {
        if (!overlayContents || !await overlayReady || disposed || overlayContents.isDestroyed()) return
        await overlayContents.executeJavaScript(`window.hermesWorkspaceOverlay.receive(${JSON.stringify(scope)})`)
      }).catch(() => {})
    }
    activeTabId = tabId
    const view = typeof tabId === 'string' ? records.get(tabId)?.view : undefined
    const show = !disposed && visible && bounds && bounds.width > 0 && bounds.height > 0 &&
      view && main && !main.isDestroyed()
    if (!show || mounted !== view) unmount()
    if (show && view && main && bounds) {
      if (mounted !== view) {
        main.contentView.addChildView(view)
        mounted = view
      }
      view.setBounds(bounds)
      view.setVisible(true)
    }
    if (overlayView) {
      try { main?.contentView.removeChildView(overlayView) } catch {}
      if (show && main && bounds) {
        main.contentView.addChildView(overlayView)
        overlayView.setBounds(bounds)
      }
      overlayView.setVisible(Boolean(show))
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (show && main && bounds && main.isVisible() && !main.isMinimized()) {
        const origin = main.getContentBounds()
        overlayWindow.setBounds({ ...bounds, x: origin.x + bounds.x, y: origin.y + bounds.y })
        overlayWindow.showInactive()
      } else overlayWindow.hide()
    }
  }

  /**
   * @param {{id: string}} tab
   */
  /**
   * @param {{id: string}} tab
   */
  function destroy(tab) {
    const record = records.get(tab.id)
    if (!record) return
    records.delete(tab.id)
    if (mounted === record.view) unmount()
    onDestroy(tab)
    for (const remove of record.remove) remove()
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false })
  }

  const mainBus = /** @type {import('node:events').EventEmitter | null} */ (main)
  const mainListeners = ['move', 'resize', 'show', 'hide', 'minimize', 'restore'].map((name) => {
    const listener = () => compose()
    mainBus?.on(name, listener)
    return () => { mainBus?.removeListener(name, listener) }
  })

  return { create, destroy, overlay, compose,
    /** @param {string} id */
    get: (id) => records.get(id)?.view || null,
    /** @param {string} id */
    isVisibleTab: (id) => visible && Boolean(bounds?.width && bounds?.height) && activeTabId === id,
    /** @param {import('electron').Rectangle} rect */
    setBounds(rect) { bounds = rect; compose() },
    /** @param {boolean} value */
    setVisible(value) { visible = value; compose() },
    dispose() {
      disposed = true
      unmount()
      for (const remove of mainListeners) remove()
      for (const id of [...records.keys()]) destroy({ id })
      if (overlayView) {
        try { main?.contentView.removeChildView(overlayView) } catch {}
        if (overlayContents && !overlayContents.isDestroyed()) overlayContents.close({ waitForBeforeUnload: false })
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy()
    } }
}

module.exports = { createViews, TAB_PREFERENCES, validOverlayMessage }
