'use strict'

/*
 * Verified read-only against local Hermes (2026-10-06):
 * gateway/browser_control_broker.py, tui_gateway/methods_browser_control.py,
 * apps/shared/src/gateway-contract.generated.ts and gateway-contract.openrpc.json.
 *
 * register {session_id, controller_id, browser_profile_id, protocol_version:1,
 * capabilities:['browser_navigate', ...]} -> {scope:{principal_id, profile_id,
 * session_id, controller_id, browser_profile_id, transport_family, capabilities}}.
 * No protocol_version or heartbeat interval is returned. The current broker
 * has NO heartbeat expiry/interval; this client sends an ownership check every
 * 15s (not the broker's 30s command timeout or ticket TTL).
 *
 * Broker command {command_id, action, arguments, controller_id,
 * browser_profile_id, tool_call_id} and cancel {command_id, tool_call_id}
 * arrive inside Gateway notifications:
 * {method:'event', params:{type:'browser.controller.command'|'.cancel',
 * session_id, payload:{...}}}. Preserve session_id when adapting onEvent.
 * result {session_id, command_id, ok, result|error} -> {accepted:boolean}.
 * heartbeat {session_id} -> {ok:true}; detach {session_id} -> {detached:true}.
 * There is no dashboard detach event or client->server cancel RPC.
 *
 * Registration needs an authenticated NON-INTERNAL identity and this exact
 * socket must already be attached to the session. Local serve token identity
 * alone is rejected with 4403 by installed Hermes. Report the upstream blocker;
 * never forge identity or fall back to a global CDP port.
 */

const { createCdpExecutor, commandError, abortable, ACTIONS } = require('./cdp-exec.cjs')
const HEARTBEAT_MS = 15_000
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function createControllerBridge({ serveClient, lanes, overlay, urlPolicy, redactor,
  securePrompt, audit, installId, servePorts = [], nativeImage, commandTimeoutMs = 30_000,
  getAgentMeta, getWorkspaceConfig }) {
  if (typeof installId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(installId)) throw commandError('bad_args')
  const controllerId = `hermesdesk:${installId}`
  const enabled = () => getWorkspaceConfig?.()?.nativeControllerEnabled === true
  const executor = createCdpExecutor({ lanes, overlay, urlPolicy, redactor, securePrompt, servePorts, nativeImage,
    getWorkspaceConfig, canRun: enabled })
  const sessions = new Map()
  const queues = new Map()
  const commands = new Map()
  const listeners = new Set()
  let disposed = false
  let connectionGeneration = 0
  let connected = serveClient.connected
  let state = 'off'
  let detail = ''

  function status(next, message = '') {
    if (!next) return state
    if (next === state && message === detail) return
    state = next
    detail = message
    for (const callback of listeners) callback(state, detail)
  }
  function updateStatus() {
    if (disposed || !sessions.size) return status('off')
    const failed = [...sessions.values()].find((entry) => entry.failure === 'mismatch') ||
      [...sessions.values()].find((entry) => entry.failure === 'error')
    if (failed) return status(failed.failure, failed.detail)
    status(connected && [...sessions.values()].every((entry) => entry.ready) ? 'ready' : 'connecting')
  }
  function errorStatus(error) {
    if (/unsupported.*protocol|protocol.*version|protocol.*mismatch/i.test(error?.message || '')) return 'mismatch'
    return 'error'
  }
  function failureDetail(error) {
    const message = error?.message || ''
    if (/authenticated.*non-internal identity/i.test(message)) {
      return 'Installed Hermes rejects local-token browser controllers (4403: authenticated non-internal identity required). Upstream authentication, session profile metadata, and runtime/stored-id routing must be fixed; Hermes Desk does not forge identity.'
    }
    if (/server session profile.*required/i.test(message)) return 'Installed Hermes is missing the session profile metadata required for native browser control (4403). An upstream fix is required.'
    if (/protocol/i.test(message)) return 'Hermes browser-controller protocol is incompatible with protocol version 1.'
    if (/extension_control.enabled.*not set/i.test(message)) return 'Browser control is disabled: browser.extension_control.enabled is not set. Enabling it does not fix the installed Hermes upstream authentication and session-routing blockers.'
    if (error?.code === 'disconnected') return 'Browser controller registration failed: the chat session is not attached to a connected renderer socket.'
    return 'Hermes rejected browser-controller registration or ownership. Native browser control is blocked until upstream authentication, session profile metadata, and runtime/stored-id routing are fixed.'
  }

  async function registerForSession(sessionId, profile) {
    if (!enabled()) throw commandError('blocked_by_policy')
    if (disposed || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
        typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw commandError('bad_args')
    let entry = sessions.get(sessionId)
    if (entry && entry.profile !== profile) throw commandError('blocked_by_policy')
    if (!entry) {
      lanes.ensureLane(`profile:${profile}`)
      entry = { sessionId, profile, laneId: `profile:${profile}`, browserProfileId: `ws-agent-${profile}`, ready: false }
      sessions.set(sessionId, entry)
    }
    if (entry.ready) return
    if (entry.pending) return entry.pending
    entry.failure = null
    updateStatus()
    if (!connected) {
      entry.failure = 'error'
      entry.detail = failureDetail({ code: 'disconnected' })
      updateStatus()
      throw commandError('blocked_by_policy')
    }
    const generation = connectionGeneration
    entry.pending = (async () => {
      try {
        const result = await serveClient.call('browser.controller.register', {
          protocol_version: 1, controller_id: controllerId, browser_profile_id: entry.browserProfileId,
          session_id: sessionId, capabilities: [...ACTIONS],
        })
        if (generation !== connectionGeneration) return
        if (disposed || sessions.get(sessionId) !== entry) {
          await serveClient.call('browser.controller.detach', { session_id: sessionId })
          return
        }
        if (result?.protocol_version !== undefined && result.protocol_version !== 1) {
          entry.failure = 'mismatch'
          entry.detail = 'Hermes browser-controller protocol is incompatible with protocol version 1.'
          await serveClient.call('browser.controller.detach', { session_id: sessionId })
          return
        }
        const scope = result?.scope
        if (!scope || scope.session_id !== sessionId || scope.profile_id !== profile ||
            scope.controller_id !== controllerId || scope.browser_profile_id !== entry.browserProfileId ||
            !Array.isArray(scope.capabilities) || !ACTIONS.every((action) => scope.capabilities.includes(action))) {
          await serveClient.call('browser.controller.detach', { session_id: sessionId })
          throw commandError('blocked_by_policy')
        }
        entry.ready = true
        entry.heartbeatPending = false
        entry.timer = setInterval(async () => {
          if (!entry.ready || entry.heartbeatPending || disposed) return
          if (!enabled()) {
            entry.ready = false
            clearInterval(entry.timer)
            cancelLane(entry.laneId, 'blocked_by_policy')
            status('off')
            return
          }
          entry.heartbeatPending = true
          try {
            const result = await serveClient.call('browser.controller.heartbeat', { session_id: sessionId })
            if (result?.ok !== true) throw commandError('blocked_by_policy')
          } catch (error) {
            if (generation !== connectionGeneration || sessions.get(sessionId) !== entry) return
            entry.ready = false
            entry.failure = errorStatus(error)
            entry.detail = failureDetail(error)
            clearInterval(entry.timer)
            cancelLane(entry.laneId, 'blocked_by_policy')
            updateStatus()
          } finally {
            entry.heartbeatPending = false
          }
        }, HEARTBEAT_MS)
        entry.timer.unref?.()
      } catch (error) {
        if (generation === connectionGeneration && sessions.get(sessionId) === entry) {
          entry.failure = errorStatus(error)
          entry.detail = failureDetail(error)
        }
        throw commandError('blocked_by_policy')
      } finally {
        if (generation === connectionGeneration) entry.pending = null
        updateStatus()
      }
    })()
    return entry.pending
  }

  async function finish(item, result, error) {
    if (item.settled) return
    item.settled = true
    const code = error?.code || 'ok'
    try {
      audit.log({
        agent: item.entry.profile, lane: item.entry.laneId, tab: item.tab?.id || null,
        action: ACTIONS.includes(item.frame.action) ? item.frame.action : 'unsupported',
        origin: item.origin || '', result: code, durationMs: Date.now() - item.started,
        byUser: code === 'user_took_control',
      })
      if (connected && item.generation === connectionGeneration) {
        await serveClient.call('browser.controller.result', {
          session_id: item.entry.sessionId, command_id: item.frame.command_id, ok: !error,
          ...(error ? { error: { code, message: commandError(code).message } } : { result }),
        })
      }
    } catch {
      if (!disposed && item.generation === connectionGeneration) status('error')
    }
    // Bound the duplicate-command ledger, retaining every unsettled command.
    if (commands.size > 512) {
      for (const [id, command] of commands) {
        if (command.settled) commands.delete(id)
        if (commands.size <= 512) break
      }
    }
  }

  async function pump(queue) {
    if (queue.active || !queue.items.length) return
    const item = queue.items.shift()
    queue.active = item
    const controller = new AbortController()
    item.controller = controller
    const timer = setTimeout(() => controller.abort(commandError('timeout')), commandTimeoutMs)
    try {
      if (!enabled()) throw commandError('blocked_by_policy')
      if (!item.entry.ready || sessions.get(item.entry.sessionId) !== item.entry) throw commandError('blocked_by_policy')
      if (lanes.isPaused(item.entry.laneId)) throw commandError('user_took_control')
      item.tab = lanes.getActiveTab(item.entry.laneId)
      if (!item.tab && item.frame.action === 'browser_tab_activate') {
        const target = lanes.getTab(item.frame.arguments?.id)
        if (target?.laneId === item.entry.laneId) item.tab = target
      }
      if (!item.tab && item.frame.action === 'browser_tabs') {
        await finish(item, { tabs: [] })
        return
      }
      if (!item.tab) item.tab = await abortable(lanes.openTab(item.entry.laneId, undefined, { createdBy: 'agent' }), controller.signal)
      if (item.tab.laneId !== item.entry.laneId) throw commandError('tab_closed')
      try { item.origin = new URL(item.tab.webContents?.getURL() || item.tab.url).origin } catch { item.origin = '' }
      const meta = await getAgentMeta?.(item.entry.profile)
      if (!enabled()) throw commandError('blocked_by_policy')
      const result = await executor.run(item.tab, item.frame.action, item.frame.arguments, {
        signal: controller.signal,
        agent: { profile: item.entry.profile, name: meta?.name || item.entry.profile, color: meta?.color || agentColor(item.entry.profile) },
      })
      await finish(item, result)
    } catch (error) {
      await finish(item, null, commandError(controller.signal.aborted ?
        controller.signal.reason?.code : error?.code))
    } finally {
      clearTimeout(timer)
      queue.active = null
      void pump(queue)
    }
  }

  function cancelLane(laneId, code = 'user_took_control') {
    const queue = queues.get(laneId)
    if (!queue) return
    queue.active?.controller?.abort(commandError(code))
    for (const item of queue.items.splice(0)) void finish(item, null, commandError(code))
  }

  function onEvent(eventName, params) {
    // CONTRACT: onEvent must retain the Gateway envelope's session_id.
    const event = typeof eventName === 'object' ? eventName :
      { type: eventName, ...params, payload: params?.payload || params }
    if (disposed || !enabled() || !['browser.controller.command', 'browser.controller.cancel'].includes(event?.type)) return
    const frame = event.payload
    if (!frame || typeof frame.command_id !== 'string' || !frame.command_id || frame.command_id.length > 256) return
    if (event.type === 'browser.controller.cancel') {
      const item = commands.get(frame.command_id)
      if (item && !item.settled && event.session_id === item.entry.sessionId) cancelLane(item.entry.laneId, 'blocked_by_policy')
      return
    }
    const entry = sessions.get(event.session_id)
    if (!entry || !entry.ready) return
    if (frame.controller_id && frame.controller_id !== controllerId) return
    if (frame.browser_profile_id && frame.browser_profile_id !== entry.browserProfileId) return
    const key = frame.command_id
    if (commands.has(key)) return
    const item = { frame, entry, started: Date.now(), generation: connectionGeneration }
    commands.set(key, item)
    let queue = queues.get(entry.laneId)
    if (!queue) queues.set(entry.laneId, queue = { active: null, items: [] })
    queue.items.push(item)
    void pump(queue)
  }
  const unsubscribeEvent = serveClient.onEvent(onEvent)
  const unsubscribeConnection = serveClient.onConnection((value) => {
    if (!enabled()) return
    if (disposed || value === connected) return
    connected = value
    connectionGeneration++
    for (const entry of sessions.values()) {
      clearInterval(entry.timer)
      entry.ready = false
      entry.pending = null
      cancelLane(entry.laneId, 'blocked_by_policy')
    }
    updateStatus()
    if (connected) for (const entry of sessions.values()) void registerForSession(entry.sessionId, entry.profile).catch(() => {})
  })

  async function detach(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    sessions.delete(sessionId)
    clearInterval(entry.timer)
    cancelLane(entry.laneId, 'blocked_by_policy')
    const wasReady = entry.ready
    entry.ready = false
    updateStatus()
    if (wasReady && connected) {
      try { await serveClient.call('browser.controller.detach', { session_id: sessionId }) }
      catch { if (!disposed) status('error') }
    }
  }

  return {
    registerForSession, detach, cancelLane, status: () => status(), detail: () => detail,
    onStatus(callback) { listeners.add(callback); return () => listeners.delete(callback) },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribeEvent()
      unsubscribeConnection()
      await Promise.all([...sessions.keys()].map(detach))
      executor.dispose()
      updateStatus()
      listeners.clear()
    },
  }
}

function agentColor(profile) {
  const palette = ['#5b9cff', '#af7aff', '#44bd9a', '#e69b50', '#e66e9c', '#62b8ce']
  let hash = 0
  for (const char of profile) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

module.exports = { createControllerBridge, HEARTBEAT_MS }
