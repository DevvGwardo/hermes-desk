'use strict'

module.exports = function boot(input) {
  const ctx = { ...input, userDataDir: input.userDataDir || input.app.getPath?.('userData') }
  const offRoomJournal = ctx.ipcMain?.on && ctx.userDataDir
    ? require('./room-journal.cjs').registerRoomJournal(ctx) : undefined
  // Closing renderers may still synchronously checkpoint on pagehide.
  ctx.app.once?.('will-quit', () => offRoomJournal?.())
  let config = null
  let mcp = null
  const registrations = new Map()
  const getAgentMeta = (profile) => config?.getAgentMeta?.(profile) || { name: profile, color: '#9ecdff' }
  const protectOrigins = (prompt) => {
    if (!prompt?.requestFill || !ctx.secretsOp?.approvalGeneration) return prompt
    const fill = prompt.requestFill.bind(prompt)
    prompt.requestFill = async (input) => {
      let origin, generation
      try {
        origin = new URL(input.origin).origin
        generation = ctx.secretsOp.approvalGeneration(origin)
      } catch { return { ok: false } }
      const result = await fill(input)
      if (ctx.secretsOp.approvalGeneration(origin) !== generation) return { ok: false }
      if (result?.ok) ctx.secretsOp.recordOriginApproval(origin)
      return result
    }
    return prompt
  }
  const getAppConfig = () => {
    try { return config?.getAppConfig() || require('./host-config.cjs').defaults() } catch {
      return require('./host-config.cjs').defaults()
    }
  }
  const hermesHost = require('./hermes-host.cjs').createHermesHost({ ...ctx, getAppConfig })
  const serveClient = hermesHost.getServeClient()
  const optional = (name, create) => {
    try { return create(require(name)) } catch {
      console.warn(`[hermes-desk] ${name} unavailable; continuing without it`)
      return null
    }
  }
  const promptContext = { ...ctx, secretsOp: ctx.secretsOp ? { ...ctx.secretsOp,
    async listSecrets() {
      const result = await ctx.secretsOp.listSecrets()
      const vault = getAppConfig().secrets?.defaultVault
      return { ...result, items: result.items ? [...result.items].sort((a, b) =>
        Number(b.vault === vault) - Number(a.vault === vault)) : undefined }
    },
  } : undefined }
  const securePrompt = protectOrigins(optional('./workspace/secure-prompt.cjs', (module) => module.createSecurePrompt(promptContext)))
  const offSecure = serveClient.setSecureRequestHandler?.(
    (method, params, context) => securePrompt?.requestServer(method, params, context) || { value: '' })
  config = optional('./host-config.cjs', (module) =>
    module.createHostConfig({ ...ctx, serveClient, getEntry: (profile) => mcp?.configEntryFor(profile), hermesHome:
      (!(ctx.app?.isPackaged ?? ctx.isPackaged ?? true) &&
        (ctx.hostDeps?.env || require('node:process').env).HERMES_DESK_HERMES_HOME) ||
      ctx.hermesHome || require('node:path').join(require('node:os').homedir(), '.hermes') }))
  const ws = optional('./workspace/index.cjs', (module) =>
    module.registerWorkspace({ ...ctx, secretsOp: promptContext.secretsOp, serveClient, hermesHost, getAppConfig, getAgentMeta,
      ipcHandle(channel, handler) {
        ctx.ipcHandle(channel, (event, ...args) => {
          const result = handler(event, ...args)
          const record = () => {
            const registration = args[0]
            if (channel === 'hd:ws:registerSession' && registration?.profile && registration?.storedId) {
              if (ws?.getSessionForProfile && ws.getSessionForProfile(registration.profile) !== registration.runtimeId) return
              registrations.set(registration.profile, { ...registration })
              workspaceChanged()
            }
          }
          if (result?.then) return result.then(value => { record(); return value })
          record()
          return result
        })
      },
    }))
  protectOrigins(ws?.parts?.securePrompt)
  const attachments = optional('./attachments.cjs', (module) => module.registerAttachments({
    ...ctx, serveClient, hermesHost, serveAuth: ctx.serveAuth,
  }))

  let mcpFailed = false
  if (ws?.parts?.redactor && ws.parts.securePrompt) {
    try {
      mcp = require('./mcp/index.cjs').registerMcp({
        userDataDir: ctx.userDataDir, ...ws.parts,
        getConfig: getAppConfig,
        getSessionForProfile: (profile) => ws.getSessionForProfile(profile),
        serveClient, isPackaged: ctx.isPackaged, appPath: ctx.appPath || ctx.app.getAppPath?.(),
        getAgentMeta,
      })
    } catch (error) {
      mcpFailed = error?.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'./mcp/index.cjs'")
      console.warn('[hermes-desk] Workspace MCP unavailable; continuing without it')
    }
  }
  const mirrorMcp = (status) => {
    const state = ['off', 'ready', 'error'].includes(status?.state) ? status.state : 'error'
    hermesHost.setControllerStatus(state, typeof status?.detail === 'string' ? status.detail : '')
    ws?.setControllerStatus?.(state)
  }
  const offMcp = mcp?.onStatus(mirrorMcp)
  mirrorMcp(mcp ? mcp.status() : {
    state: mcpFailed ? 'error' : 'off',
    detail: !ws ? 'Workspace unavailable; agent browsing MCP is off.'
      : mcpFailed ? 'Workspace MCP could not start; agent browsing is unavailable.'
        : 'Workspace MCP is unavailable; agent browsing is off.',
  })

  let computerOpen = false
  const computer = optional('./computer-pip.cjs', (module) => module.registerComputerPip({
    ...ctx, serveClient, hermesHost,
    onState: (state) => { computerOpen = state.open === true; ctx.onTrayChanged?.() },
    computerRequest: (requestPath) => ctx.serveAuth?.computerRequest(requestPath) ||
      Promise.reject(new Error('Computer media reader unavailable')),
    getComputerSession: (profile) => {
      const runtimeId = ws?.getSessionForProfile(profile)
      if (typeof runtimeId !== 'string' || !runtimeId || runtimeId.length > 256 ||
          /[\x00-\x1f\x7f]/.test(runtimeId) || !serveClient.hasSession?.(runtimeId, profile)) return null
      return { runtimeId }
    },
    ipcHandle(channel, handler) {
      ctx.ipcHandle(channel, async (...args) => {
        const result = await handler(...args)
        if (computer?.status) computerOpen = computer.status().open === true
        else if (channel === 'hd:computer:open') computerOpen = true
        else if (channel === 'hd:computer:close') computerOpen = false
        ctx.onTrayChanged?.()
        return result
      })
    },
  }))
  const unsubscribe = hermesHost.onStatus((status) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('hd:host:status-changed', status)
    ctx.onTrayChanged?.()
  })
  function handle(channel, count, handler) {
    ctx.ipcHandle(channel, (event, ...args) => {
      ctx.assertMainSender?.(event)
      if (ctx.assertMainSender && event.sender !== ctx.getMainWindow()?.webContents) throw new Error('IPC sender rejected')
      if (args.length !== count) throw new Error('Invalid host arguments')
      return handler(...args)
    })
  }
  handle('hd:host:status', 0, () => hermesHost.status())
  handle('hd:host:restartServe', 0, () => hermesHost.restartServe())
  handle('hd:host:getConfig', 0, () => config?.getConfig() || null)
  handle('hd:host:sidebarActivity', 0, () => config?.sidebarActivity?.() || {})
  handle('hd:host:secretsMetadata', 0, () => config?.secretsMetadata?.() || { state: 'unavailable', vaults: [], defaultVault: '', approvals: [] })
  handle('hd:host:revokeOrigin', 1, (origin) => {
    if (typeof origin !== 'string' || origin.length > 2048 || !config) throw new Error('Invalid origin')
    return config.revokeOrigin(origin)
  })
  handle('hd:host:setProfileSoul', 2, (profile, content) => {
    if (!config) throw new Error('Profile editing unavailable')
    return config.setProfileSoul(profile, content)
  })
  handle('hd:host:setConfig', 1, (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch')
    if (!config) throw new Error('Local settings are not available yet')
    return config.setConfig(patch)
  })
  handle('hd:host:auditTail', 1, (n) => {
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error('Invalid audit count')
    return config?.auditTail(n) || []
  })
  for (const method of ['enableBrowserControl', 'disableBrowserControl']) handle(`hd:host:${method}`, 1, (profiles) => {
    if (!Array.isArray(profiles) || profiles.length > 100 ||
        profiles.some((p) => typeof p !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p))) {
      throw new Error('Invalid Hermes profiles')
    }
    const unique = [...new Set(profiles)]
    return config ? config[method](unique) : { ok: false, profiles: unique,
      error: 'Browser controller setup is not available yet; no configuration was changed' }
  })

  async function stopAll({ interrupt = true } = {}) {
    for (const lane of ws?.lanes?.allLanes() || []) {
      ws.lanes.pauseLane(lane.id)
      ws.bridge?.cancelLane(lane.id, 'user_took_control')
      // Stop cancels lane work, notifies no takeover, and queues no new steer
      // behind the interrupted turn. Physical user input keeps its own event.
      mcp?.cancelLane(lane.id, 'user_took_control')
    }
    if (!interrupt) return
    const results = await Promise.allSettled((serveClient.getActiveTurns?.() || [])
      .map((params) => serveClient.call('session.interrupt', params)))
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Browsing paused, but an active turn could not be interrupted')
    }
  }
  handle('hd:ws:stopAll', 0, () => stopAll())
  if (!ws) handle('hd:ws:registerSession', 1, () => { throw new Error('Workspace unavailable') })
  function workspaceChanged() {
    const activity = require('../hud-activity-relay.cjs').workspaceActivity(ws?.lanes, (profile) => registrations.get(profile)?.storedId)
    ctx.onWorkspaceActivity?.(activity)
  }
  ws?.lanes?.on('changed', workspaceChanged)
  workspaceChanged()

  const ready = hermesHost.start()
  let quitting = false
  ctx.app.on('before-quit', (event) => {
    event.preventDefault()
    if (quitting) return
    quitting = true
    unsubscribe()
    offMcp?.()
    offSecure?.()
    ws?.lanes?.off('changed', workspaceChanged)
    // Detach controllers while their sockets are still alive.
    Promise.resolve().then(async () => {
      for (const resource of [attachments, mcp, computer, ws]) {
        try { await resource?.dispose() } catch {
          console.warn('[hermes-desk] Local window cleanup failed')
        }
      }
    }).then(() => hermesHost.stop()).finally(() => ctx.app.exit(0))
  })
  return { hermesHost, serveClient, ws, mcp, computer, ready, stopAll,
    isComputerOpen: () => computerOpen,
    async toggleComputer() {
      if (!computer) return
      if (computerOpen) await computer.close()
      else {
        const focused = ws?.lanes.ensureLane(ws.lanes.focusedLaneId)
        await computer.open(focused?.profile || ws?.lanes.allLanes().find((lane) => lane.kind === 'agent')?.profile || 'default')
      }
      if (!computer.status) computerOpen = !computerOpen
      ctx.onTrayChanged?.()
    },
  }
}
