'use strict'

const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { createUrlPolicy, LANE_RE, TAB_RE, PROFILE_RE, parseHttp } = require('./url-policy.cjs')
const { createLanes, workspaceError } = require('./lanes.cjs')
const { createViews } = require('./views.cjs')
const { createPermissions } = require('./permissions.cjs')
const { createDownloads } = require('./downloads.cjs')
const { createTakeover } = require('./takeover.cjs')
const { createAudit } = require('./audit.cjs')
const { createPersistence, persistableUrl } = require('./persist.cjs')
const { createLaneData } = require('./lane-data.cjs')
const { createReader } = require('./cdp-exec.cjs')
const { createEgressProxy } = require('./egress-proxy.cjs')

function registerWorkspace(ctx) {
  if (!ctx || typeof ctx.userDataDir !== 'string' || !path.isAbsolute(ctx.userDataDir) ||
      typeof ctx.getMainWindow !== 'function' || typeof ctx.WebContentsView !== 'function' ||
      typeof ctx.session?.fromPartition !== 'function' || typeof ctx.ipcHandle !== 'function' ||
      typeof ctx.assertMainSender !== 'function' || typeof ctx.ipcMain?.removeHandler !== 'function') {
    console.warn('[hermes-desk] Workspace is not installed or its context is incomplete; continuing without it')
    return null
  }
  const { getMainWindow, serveClient, session } = ctx
  const audit = createAudit({ userDataDir: ctx.userDataDir })
  const persistence = createPersistence({ userDataDir: ctx.userDataDir })
  const restored = persistence.load()
  const workspaceConfig = () => {
    const appConfig = ctx.getAppConfig?.()
    if (appConfig && typeof appConfig.then === 'function') throw new Error('Synchronous workspace settings required')
    const config = appConfig?.workspace
    return { ...(ctx.workspaceConfig || {}), ...(config || {}),
      agents: config?.profiles || ctx.workspaceConfig?.agents }
  }
  const servePorts = () => {
    const status = ctx.hermesHost?.status()
    return [...(ctx.servePorts || []), ...(status?.serve?.port ? [status.serve.port] : [])]
  }
  const urlPolicy = createUrlPolicy({ ...(ctx.workspaceConfig || {}), servePorts: servePorts(),
    getWorkspaceConfig: workspaceConfig,
    getAppOrigins: () => {
      const appUrl = getMainWindow()?.webContents.getURL()
      return [...(ctx.workspaceConfig?.appOrigins || []), ...(appUrl ? [appUrl] : [])]
    } })
  const policy = { ...urlPolicy, check: (url, context) => urlPolicy.check(url, { ...context, servePorts: servePorts() }),
    resolve: (input, context) => urlPolicy.resolve(input, { ...context, servePorts: servePorts() }) }
  let lanes
  let takeover
  let bridge = null
  let redactor = null
  let securePrompt = null
  let primaryController = false
  let controllerState = 'off'
  let disposed = false
  let stateTimer = null
  let lastActiveTabId = null
  const channels = []
  const laneSessions = new Map()
  const networkSessions = new Map()
  let egress = null
  const getTabForContents = (contents) => lanes?.allLanes().flatMap((lane) => lanes.listTabs(lane.id))
    .find((tab) => tab.webContents === contents) || null
  const getAgentMeta = (profile) => ctx.getAgentMeta?.(profile) || null
  const permissions = createPermissions({ dialog: ctx.dialog, getMainWindow, getTabForContents,
    getConfig: ctx.getAppConfig, setConfig: ctx.setAppConfig, audit, isDisposed: () => disposed })
  const downloads = createDownloads({
    getTabForContents: (contents) => lanes?.allLanes().flatMap((lane) => lanes.listTabs(lane.id))
      .find((tab) => tab.webContents === contents) || null,
    audit, getDownloadsDir: () => workspaceConfig().downloadsDir,
    ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
  })
  const views = createViews({ ...ctx, urlPolicy: policy, getLanes: () => lanes, audit,
    onShortcut: (shortcut) => {
      const main = getMainWindow()
      if (!disposed && main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
        if (shortcut.key === 'l') main.webContents.focus()
        main.webContents.send('hd:ws:shortcut', shortcut)
      }
    },
    onCreate: (tab, view) => {
      if (tab.controller === 'agent') {
        // WebRTC must not open a separate direct UDP path around HTTP proxying.
        view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      }
      takeover?.attach(tab, view)
    },
    onDestroy: (tab) => takeover?.detach(tab.id) })

  function installSession(lane) {
    const ses = session.fromPartition(lane.partition)
    permissions.install(ses)
    downloads.install(ses, lane)
    if (networkSessions.has(ses)) return
    const record = { kind: lane.kind, status: lane.kind === 'agent' ? 'pending' : 'ready',
      pending: new Set(), ready: Promise.resolve(true) }
    networkSessions.set(ses, record)
    // Also guard redirects, CDP navigations, and subresource requests at the network
    // boundary. will-navigate alone does not cover programmatic Page.navigate.
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allTabs = lanes?.allLanes().flatMap((entry) => lanes.listTabs(entry.id)) || []
      const tab = allTabs.find((entry) => entry.webContents?.id === details.webContentsId)
      const contexts = tab ? [lanes.policyContext(tab.laneId)] :
        allTabs.filter((entry) => entry.partition === lane.partition && entry.controller === 'agent')
          .map((entry) => lanes.policyContext(entry.laneId))
      if (!contexts.length) contexts.push({ laneKind: lane.kind, profile: lane.profile })
      const isNavigation = details.resourceType === 'mainFrame'
      const checked = isNavigation || /^(?:https?|wss?):/i.test(details.url)
      const resourceUrl = details.url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
      const initialBlank = tab && !tab.url && details.url === 'about:blank' && isNavigation
      const decide = () => {
        try {
          return { cancel: disposed || (lane.kind === 'agent' && record.status !== 'ready') ||
            (lane.kind === 'agent' && !initialBlank &&
              !/^(?:https?:|wss?:|data:|blob:)/i.test(details.url)) ||
            // A user partition cannot be proxied per WebContents. Old shared
            // login tabs must not retain a direct-network agent escape hatch.
            (lane.kind === 'user' && contexts.some((context) => context.laneKind === 'agent')) ||
            (checked && !initialBlank && [...contexts,
              ...(lane.kind === 'agent' ? [{ laneKind: 'agent', profile: lane.profile }] : [])]
              .some((context) => context.laneKind === 'agent' && !policy.check(resourceUrl, context).ok)) }
        } catch { return { cancel: true } }
      }
      if (record.status !== 'pending') { callback(decide()); return }
      // Install this gate synchronously, before any WebContents can be made.
      // No navigation, redirect, subresource or service worker can race setProxy.
      if (record.pending.size >= 128) { callback({ cancel: true }); return }
      const done = () => { record.pending.delete(done); callback(decide()) }
      record.pending.add(done)
      void record.ready.then(() => { if (record.pending.has(done)) done() })
    })
    if (lane.kind !== 'agent') return
    let timer
    const setup = Promise.resolve().then(async () => {
      if (disposed) throw new Error('Workspace closed')
      if (!egress) egress = (ctx.workspaceModules?.egressProxy?.createEgressProxy || createEgressProxy)()
      // Close old/direct pools before even waiting for the listener to bind.
      await ses.closeAllConnections()
      if (disposed || record.status !== 'pending') throw new Error('Workspace closed')
      const config = await egress.ready()
      if (disposed || record.status !== 'pending') throw new Error('Workspace closed')
      // Never include DIRECT, PAC, system or implicit loopback
      // bypass in this session's proxy configuration.
      await ses.setProxy(config)
      await ses.closeAllConnections()
      if (disposed || record.status !== 'pending') throw new Error('Workspace closed')
      return true
    })
    record.ready = Promise.race([setup, new Promise((resolve) => {
      record.cancelSetup = () => resolve(false)
      timer = setTimeout(() => resolve(false), 10000)
      timer.unref?.()
    })]).catch(() => false).then((ok) => {
      clearTimeout(timer)
      record.status = ok && !disposed ? 'ready' : 'failed'
      return record.status === 'ready'
    })
  }

  function createNetworkView(tab) {
    const lane = lanes.ensureLane(tab.laneId)
    if (lane.kind === 'agent' && tab.partition !== lane.partition) {
      throw workspaceError('blocked_by_policy', 'Shared-login tabs require an isolated agent network partition')
    }
    const record = networkSessions.get(session.fromPartition(tab.partition))
    if (lane.kind === 'agent' && record?.status === 'failed') {
      throw workspaceError('blocked_by_policy', 'Agent network proxy unavailable')
    }
    let contents
    try {
      contents = views.create(tab)
      if (lane.kind === 'agent') {
        const documentReady = tab.liveReady
        tab.liveReady = Promise.all([documentReady, record.ready]).then(([, ok]) => {
          if (!ok || disposed) throw workspaceError('blocked_by_policy', 'Agent network proxy unavailable')
        })
      }
      return contents
    } catch (error) {
      views.destroy(tab)
      throw error
    }
  }

  lanes = createLanes({ urlPolicy: policy, createView: createNetworkView, destroyView: views.destroy,
    isVisibleTab: views.isVisibleTab, restore: restored, onEnsureLane: installSession,
    getLimits: workspaceConfig, getAgentMeta })
  const moveTab = lanes.moveTab
  lanes.moveTab = (id, destination) => {
    const entry = lanes.getTab(id)
    const lane = lanes.ensureLane(destination)
    if (lane.kind === 'agent' && entry?.partition !== lane.partition) {
      throw workspaceError('blocked_by_policy',
        'Sign-in sharing is unavailable: agents require their isolated network partition')
    }
    return moveTab(id, destination)
  }
  lanes.installId = restored?.installId || ctx.installId || randomUUID()

  function getSessionId(laneId) {
    if (laneSessions.has(laneId)) return laneSessions.get(laneId)
    let fromBridge
    try { fromBridge = bridge?.getSessionForLane?.(laneId) || bridge?.getSessionId?.(laneId) } catch {}
    const sessionId = (typeof fromBridge === 'string' ? fromBridge : fromBridge?.sessionId || fromBridge?.session_id) ||
      laneSessions.get(laneId) || lanes.getActiveTab(laneId)?.sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(sessionId) ? sessionId : null
  }

  function getSessionForProfile(profile) {
    if (disposed || typeof profile !== 'string' || !PROFILE_RE.test(profile)) return null
    return laneSessions.get(`profile:${profile}`) || null
  }

  function state() {
    const summaries = lanes.allLanes().map((lane) => ({
      id: lane.id, kind: lane.kind, ...(lane.profile ? { profile: lane.profile } : {}),
      label: lane.label, ...(lane.color ? { color: lane.color } : {}),
      state: lane.paused ? 'paused' : lanes.listTabs(lane.id).some((tab) => tab.state === 'agent-acting') ? 'acting' : 'idle',
      tabs: lanes.listTabs(lane.id).map((tab) => ({
        id: tab.id, laneId: tab.laneId, url: tab.url, title: tab.title,
        ...(tab.favicon ? { favicon: tab.favicon } : {}),
        state: tab.state, controller: tab.controller, createdBy: tab.createdBy,
        sharedLogin: tab.sharedLogin, discarded: tab.discarded, active: tab.id === lane.activeTabId,
        canGoBack: Boolean(tab.webContents && !tab.webContents.isDestroyed() &&
          tab.webContents.navigationHistory.canGoBack()),
        canGoForward: Boolean(tab.webContents && !tab.webContents.isDestroyed() &&
          tab.webContents.navigationHistory.canGoForward()),
      })),
    }))
    const active = lanes.getActiveTab(lanes.focusedLaneId)
    const lane = lanes.allLanes().find((entry) => entry.id === lanes.focusedLaneId)
    return { lanes: summaries, focusedLaneId: lanes.focusedLaneId, activeTabId: active?.id || null,
      control: { laneId: active ? lane.id : null, owner: active && active.controller === 'agent' && !lane.paused ? 'agent' : 'user',
        paused: Boolean(active && lane.paused),
        ...(active?.controller === 'agent' ? { agentName: lane.label, ...(lane.color ? { agentColor: lane.color } : {}) } : {}) },
      controller: controllerState }
  }

  function changed() {
    if (disposed) return
    const activeTabId = lanes.getActiveTab(lanes.focusedLaneId)?.id || null
    if (lastActiveTabId !== activeTabId) views.overlay.send({ type: 'clear' })
    lastActiveTabId = activeTabId
    views.compose(activeTabId)
    persistence.save(lanes)
    if (stateTimer) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      const main = getMainWindow()
      if (!disposed && main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
        main.webContents.send('hd:ws:state', state())
      }
    }, 17)
    stateTimer.unref?.()
  }
  lanes.on('changed', changed)

  try {
    // These modules are owned by parallel workers. Missing/failed modules leave
    // browsing available but agent control off; never substitute an unsafe redactor.
    const modules = ctx.workspaceModules
    redactor = modules?.redactor || require('./redactor.cjs')
    securePrompt = (modules?.securePrompt || require('./secure-prompt.cjs')).createSecurePrompt({
      dialog: ctx.dialog, secretsOp: ctx.secretsOp, getMainWindow,
    })
    // CONTRACT: nativeControllerEnabled is the sole opt-in for the legacy
    // route. MCP claims controller ownership synchronously and permanently
    // disables this route, even if the MCP listener is off or fails.
    if (workspaceConfig().nativeControllerEnabled === true) bridge = (modules?.controllerBridge || require('./controller-bridge.cjs')).createControllerBridge({
      serveClient, lanes, overlay: views.overlay, urlPolicy: policy, redactor, securePrompt, audit,
      installId: lanes.installId, servePorts: servePorts(),
      getAgentMeta, getWorkspaceConfig: workspaceConfig,
    })
    if (bridge) {
      const register = bridge.registerForSession.bind(bridge)
      bridge.registerForSession = async (sessionId, profile) => {
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(sessionId) || typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
          throw workspaceError('bad_args', 'Invalid controller session')
        }
        if (primaryController || workspaceConfig().nativeControllerEnabled !== true) {
          throw workspaceError('blocked_by_policy', 'Native browser control disabled')
        }
        laneSessions.set(`profile:${profile}`, sessionId)
        return register(sessionId, profile)
      }
      const detach = bridge.detach.bind(bridge)
      bridge.detach = (sessionId) => {
        if (!primaryController) {
          for (const [laneId, id] of laneSessions) if (id === sessionId) laneSessions.delete(laneId)
        }
        return detach(sessionId)
      }
      const initialStatus = bridge.status()
      controllerState = ['off', 'connecting', 'ready', 'error', 'mismatch'].includes(initialStatus) ? initialStatus : 'error'
    }
  } catch {
    try { bridge?.dispose() } catch {}
    bridge = null
    controllerState = 'off'
  }
  const unsubscribeStatus = bridge?.onStatus((value) => {
    if (primaryController) return
    controllerState = ['off', 'connecting', 'ready', 'error', 'mismatch'].includes(value) ? value : 'error'
    changed()
  })

  takeover = createTakeover({ lanes, getBridge: () => bridge, serveClient, getSessionId, overlay: views.overlay, audit,
    shouldSteer: () => !primaryController })
  // CONTRACT: additive main-only seams, so boot/transport can lazily register sessions.
  lanes.registerForSession = (sessionId, profile) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(sessionId) || typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
      return Promise.reject(workspaceError('bad_args', 'Invalid controller session'))
    }
    laneSessions.set(`profile:${profile}`, sessionId)
    return bridge && !primaryController ? bridge.registerForSession(sessionId, profile) : Promise.resolve()
  }
  const reader = createReader({ lanes, redactor })
  const laneData = createLaneData({ lanes, session, dialog: ctx.dialog, getMainWindow,
    urlPolicy: policy, audit, isDisposed: () => disposed })
  lanes.on('tab-closing', (tab) => {
    if (tab.controller === 'agent') {
      try { Promise.resolve(bridge?.cancelLane(tab.laneId, 'tab_closed')).catch(() => {}) } catch {}
    }
  })

  function validateId(value, regex, name) {
    if (typeof value !== 'string' || value.length > 80 || !regex.test(value)) {
      throw workspaceError('bad_args', `Invalid ${name}`)
    }
    return value
  }
  const laneId = (value) => validateId(value, LANE_RE, 'laneId')
  const tabId = (value) => validateId(value, TAB_RE, 'tabId')
  function tab(value) {
    const found = lanes.getTab(tabId(value))
    if (!found) throw workspaceError('tab_closed', 'Tab not found')
    return found
  }
  function urlInput(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 16384 ||
      /[\u0000-\u001f\u007f]/.test(value)) throw workspaceError('bad_args', 'Invalid URL or search query')
    return value
  }
  function handle(name, minArgs, maxArgs, handler, withEvent = false) {
    const channel = `hd:ws:${name}`
    ctx.ipcHandle(channel, (event, ...args) => {
      ctx.assertMainSender(event)
      if (event.sender !== getMainWindow()?.webContents) throw new Error('IPC sender rejected')
      if (disposed || args.length < minArgs || args.length > maxArgs) throw workspaceError('bad_args', 'Invalid workspace arguments')
      return withEvent ? handler(event, ...args) : handler(...args)
    })
    channels.push(channel)
  }
  function actionLog(entry, action, result = 'ok') {
    audit.log({ agent: lanes.ensureLane(entry.laneId).profile, lane: entry.laneId, tab: entry.id,
      action, origin: entry.url, result, byUser: true })
  }

  handle('list', 0, 0, state)
  handle('registerSession', 1, 1, (event, registration) => {
    const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(id)
    if (!registration || typeof registration !== 'object' || Array.isArray(registration) ||
        Object.keys(registration).some((key) => !['profile', 'storedId', 'runtimeId'].includes(key)) ||
        typeof registration.profile !== 'string' || !PROFILE_RE.test(registration.profile) ||
        !validId(registration.storedId) || !validId(registration.runtimeId)) {
      throw workspaceError('bad_args', 'Invalid session registration')
    }
    serveClient?.assertRendererSession?.(registration, event.sender)
    const id = `profile:${registration.profile}`
    lanes.ensureLane(id)
    laneSessions.set(id, registration.runtimeId)
    if (primaryController || !bridge) return
    return lanes.registerForSession(registration.runtimeId, registration.profile)
  }, true)
  handle('setBounds', 1, 1, (rect) => {
    if (rect !== null && (!rect || typeof rect !== 'object' || Array.isArray(rect) ||
      !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]) &&
        rect[key] >= 0 && rect[key] <= 100000))) throw workspaceError('bad_args', 'Invalid workspace bounds')
    views.setBounds(rect === null ? null : Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key) => [key, Math.round(rect[key])])))
  })
  handle('setVisible', 1, 1, (visible) => {
    if (typeof visible !== 'boolean') throw workspaceError('bad_args', 'Invalid visibility')
    views.setVisible(visible)
  })
  handle('openTab', 1, 2, async (id, url) => {
    const result = await lanes.openTab(laneId(id), url === undefined ? undefined : urlInput(url))
    actionLog(result, 'open')
    return result.id
  })
  handle('closeTab', 1, 1, (id) => {
    const entry = tab(id)
    actionLog(entry, 'close')
    lanes.closeTab(entry.id)
  })
  handle('activate', 1, 1, (id) => lanes.activateTab(tab(id).id))
  handle('focusLane', 1, 1, (id) => lanes.focusLane(laneId(id)))
  handle('navigate', 2, 2, async (id, input) => {
    const entry = tab(id)
    const decision = policy.resolve(urlInput(input), lanes.policyContext(entry.laneId))
    if (!decision.ok) throw workspaceError('blocked_by_policy', decision.reason)
    takeover.pause(entry)
    entry.url = decision.url
    const wasDiscarded = entry.discarded
    const contents = await entry.ensureLive()
    if (!wasDiscarded) await contents.loadURL(decision.url)
    actionLog(entry, 'navigate')
    changed()
  })
  for (const action of ['back', 'forward', 'reload']) {
    handle(action, 1, 1, async (id) => {
      const entry = tab(id)
      takeover.pause(entry)
      const contents = await entry.ensureLive()
      const history = contents.navigationHistory
      if (action === 'back' && history.canGoBack()) history.goBack()
      if (action === 'forward' && history.canGoForward()) history.goForward()
      if (action === 'reload') contents.reload()
      actionLog(entry, action)
      changed()
    })
  }
  handle('giveToAgent', 2, 3, async (id, profile, instruction) => {
    const entry = tab(id)
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw workspaceError('bad_args', 'Invalid profile')
    if (instruction !== undefined && (typeof instruction !== 'string' || instruction.length > 8192 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instruction))) {
      throw workspaceError('bad_args', 'Invalid instruction')
    }
    if (entry.laneId !== 'you' || entry.partition !== 'persist:ws-user') {
      throw workspaceError('bad_args', 'Only your own tabs can be given to an agent')
    }
    lanes.moveTab(entry.id, `profile:${profile}`)
    const sessionId = getSessionId(entry.laneId)
    if (sessionId && (primaryController || bridge) && serveClient) {
      try {
        if (!primaryController) await bridge.registerForSession(sessionId, profile)
        await serveClient.call('prompt.submit', { session_id: sessionId,
          text: `[Workspace] You now control tab ${entry.id} (${persistableUrl(entry.url) || 'new tab'}).${instruction ? ` ${instruction}` : ''}` })
        actionLog(entry, 'give', 'ok')
      } catch {
        actionLog(entry, 'give', 'error')
        throw workspaceError('controller_unavailable', 'Tab shared, but the agent could not be notified')
      }
    } else {
      // A profile without a registered desktop session cannot receive a prompt.
      actionLog(entry, 'give', 'pending')
    }
  })
  handle('returnToUser', 1, 1, (id) => {
    const entry = tab(id)
    if (entry.controller !== 'agent' || !entry.sharedLogin) {
      throw workspaceError('bad_args', 'Only a shared-login tab can be returned')
    }
    takeover.pause(entry)
    lanes.moveTab(entry.id, 'you')
    actionLog(entry, 'return')
  })
  handle('resumeAgent', 1, 1, (id) => takeover.resume(laneId(id)))
  handle('takeControl', 1, 1, (id) => {
    const entry = tab(id)
    if (entry.controller !== 'agent') throw workspaceError('bad_args', 'Only agent-controlled tabs need takeover')
    takeover.pause(entry)
  })
  handle('readerPreview', 1, 1, (id) => reader.preview(tab(id)))
  handle('clearLaneData', 1, 1, (id) => laneData.clearLaneData(laneId(id)))
  handle('copySignIn', 3, 3, (origin, from, to) => {
    const parsed = parseHttp(urlInput(origin))
    if (!parsed || parsed.href !== `${parsed.origin}/`) throw workspaceError('bad_args', 'Expected an HTTP(S) origin')
    return laneData.copySignIn(parsed.origin, laneId(from), laneId(to))
  })

  changed()
  return { lanes, views, get bridge() { return bridge },
    // CONTRACT: main-only dependencies and lookup for the W3-3 MCP route.
    parts: { lanes, overlay: views.overlay, urlPolicy: policy, redactor, securePrompt, audit, getAgentMeta },
    getSessionForProfile,
    setControllerStatus(value) {
      if (disposed) return
      primaryController = true
      if (bridge) {
        unsubscribeStatus?.()
        try { Promise.resolve(bridge.dispose()).catch(() => {}) } catch {}
        bridge = null
      }
      controllerState = ['off', 'ready', 'error'].includes(value) ? value : 'error'
      changed()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(stateTimer)
      lanes.off('changed', changed)
      unsubscribeStatus?.()
      laneSessions.clear()
      let detached
      try { detached = Promise.resolve(bridge?.dispose()).catch(() => {}) } catch {}
      takeover.dispose()
      reader.dispose()
      permissions.dispose()
      downloads.dispose()
      persistence.save(lanes)
      persistence.flush()
      lanes.dispose()
      views.dispose()
      const networkClosed = []
      for (const [ses, record] of networkSessions) {
        record.status = 'failed'
        record.cancelSetup?.()
        for (const done of [...record.pending]) done()
        if (record.kind === 'agent') {
          // Persistent agent sessions keep a deny gate and the dead proxy, not
          // a fresh direct path for background workers after workspace shutdown.
          ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] },
            (_details, callback) => callback({ cancel: true }))
          try { networkClosed.push(Promise.resolve(ses.closeAllConnections()).catch(() => {})) } catch {}
        } else ses.webRequest.onBeforeRequest(null)
      }
      if (egress) networkClosed.push(egress.dispose())
      for (const channel of channels) ctx.ipcMain.removeHandler(channel)
      return Promise.all([detached, ...networkClosed])
    },
  }
}

module.exports = { registerWorkspace }
