'use strict'
const { randomUUID } = require('node:crypto')

const { listTools, validateArguments, PROFILE_RE } = require('./tools.cjs')
const { parseGenUi } = require('./genui.mjs')
const MESSAGES = {
  user_took_control: 'User took control of the lane; wait for them to resume the agent',
  blocked_by_policy: 'Action blocked by browser policy',
  timeout: 'Browser command timed out',
  no_such_ref: 'Snapshot ref is no longer available; refresh the snapshot',
  tab_closed: 'Lane tab is no longer available',
  bad_args: 'Invalid browser tool arguments',
  not_enabled: 'Browser control is not enabled for this profile',
  app_unavailable: 'Hermes Desk is not running',
  resource_limit: 'MCP work limit reached; retry after pending work finishes',
}

function callError(code) {
  code = Object.hasOwn(MESSAGES, code) ? code : 'blocked_by_policy'
  return Object.assign(new Error(MESSAGES[code]), { code })
}

function errorContent(code) {
  const error = callError(code)
  return { content: [{ type: 'text', text: `${error.code}: ${error.message}` }], isError: true }
}

function agentColor(profile) {
  const palette = ['#5b9cff', '#af7aff', '#44bd9a', '#e69b50', '#e66e9c', '#62b8ce']
  let hash = 0
  for (const char of profile) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

function createDispatch({ lanes, overlay, urlPolicy, redactor, securePrompt, audit, getConfig,
  getAgentMeta, getSessionForProfile, serveClient, servePorts = [], nativeImage,
  commandTimeoutMs = 30_000, abortGraceMs = 2000,
  maxQueuedCalls = 128, maxQueuedCallsPerLane = 32, maxArgumentBytes = 64 * 1024,
  createExecutor = require('../workspace/cdp-exec.cjs').createCdpExecutor }) {
  // Audit at the queue boundary so rejected, queued, and cancelled calls are
  // recorded exactly once, without executor duplication or command content.
  const executor = createExecutor({ lanes, overlay, urlPolicy, redactor, securePrompt, servePorts, nativeImage })
  const toolNames = new Set(listTools().map((tool) => tool.name))
  const queues = new Map()
  const calls = new Set()
  const quarantined = new Set()
  let disposed = false

  function gate(profile) {
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw callError('bad_args')
    if (disposed) throw callError('app_unavailable')
    const enabled = getConfig()?.workspace?.enabledProfiles
    if (!Array.isArray(enabled) || !enabled.includes(profile)) throw callError('not_enabled')
    if (quarantined.has(`profile:${profile}`)) throw callError('blocked_by_policy')
  }

  function finish(item, result) {
    if (item.settled) return
    item.settled = true
    clearTimeout(item.timer)
    const code = result.isError ? result.content[0].text.split(':', 1)[0] : 'ok'
    audit?.log({
      agent: typeof item.profile === 'string' && PROFILE_RE.test(item.profile) ? item.profile : null,
      lane: item.laneId || null, tab: item.tab?.id || null,
      action: toolNames.has(item.name) ? item.name : 'unsupported',
      origin: item.origin || '', result: code, durationMs: Date.now() - item.started,
      byUser: code === 'user_took_control',
    })
    item.resolve(result)
  }

  function release(item) {
    clearTimeout(item.timer)
    clearTimeout(item.watchdog)
    calls.delete(item)
    item.drained()
  }

  function rejectCall(params, code) {
    const result = errorContent(code)
    const profile = params?.profile
    finish({ profile, name: params?.name, started: Date.now(),
      laneId: typeof profile === 'string' && PROFILE_RE.test(profile) ? `profile:${profile}` : null,
      resolve: () => {} }, result)
    return result
  }

  function check(item) {
    if (item.controller.signal.aborted) throw item.controller.signal.reason
    gate(item.profile)
    if (lanes.isPaused(item.laneId)) throw callError('user_took_control')
  }

  function contentFor(item, result) {
    if (item.name === 'browser_screenshot') {
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(result?.screenshot || '')
      if (!match) throw callError('blocked_by_policy')
      return { content: [{ type: 'image', data: match[1], mimeType: 'image/jpeg' }] }
    }
    if (item.name === 'browser_snapshot') {
      if (typeof result?.snapshot !== 'string') throw callError('blocked_by_policy')
      return { content: [{ type: 'text', text: result.snapshot }] }
    }
    if (item.name === 'browser_tabs') {
      if (!Array.isArray(result?.tabs)) throw callError('blocked_by_policy')
      return { content: [{ type: 'text', text: JSON.stringify(result.tabs) }] }
    }
    // A fill can make the page echo a credential into its title/URL. Preserve
    // the executor's metadata-free response rather than reading the tab again.
    const tab = item.name === 'browser_tab_activate' ? lanes.getTab(item.args.id) : item.tab
    const text = item.name === 'browser_type' ? result?.text || 'typed' :
      [result?.text || item.name.replace('browser_', ''), result?.tab_id,
        result?.url ?? tab?.webContents?.getURL() ?? tab?.url,
        result?.title ?? tab?.webContents?.getTitle() ?? tab?.title].filter(Boolean).join('\n')
    return { content: [{ type: 'text', text: redactor.scrubText(text) }] }
  }

  async function execute(item) {
    check(item)
    if (item.name === 'render_ui') {
      const spec = parseGenUi(item.args)
      if (!spec) throw callError('bad_args')
      check(item)
      const structuredContent = { genui: spec, genuiOccurrence: randomUUID() }
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false }
    }
    lanes.ensureLane(item.laneId)
    let tab = lanes.getActiveTab(item.laneId)
    if (item.name === 'browser_tab_activate') {
      const target = lanes.getTab(item.args.id)
      if (!target || target.laneId !== item.laneId) throw callError('bad_args')
      tab = target
    }
    if (!tab && item.name === 'browser_tabs') return { content: [{ type: 'text', text: '[]' }] }
    if (!tab) {
      const opening = lanes.openTab(item.laneId, undefined, { createdBy: 'agent' })
      // openTab registers its tab before awaiting renderer initialization.
      // Retain it so an initialization hang also has a teardown target.
      item.tab = lanes.getActiveTab(item.laneId)
      tab = await opening
      if (item.forced) {
        if (lanes.getTab(tab.id) === tab) lanes.closeTab(tab.id)
        throw callError('timeout')
      }
    }
    item.tab = tab
    check(item)
    if (tab.laneId !== item.laneId || lanes.getTab(tab.id) !== tab) throw callError('tab_closed')
    try { item.origin = new URL(tab.webContents?.getURL() || tab.url).origin } catch { item.origin = '' }
    const meta = await getAgentMeta?.(item.profile)
    check(item)
    const result = await executor.run(tab, item.name, item.args, {
      signal: item.controller.signal,
      agent: { profile: item.profile, name: meta?.name || item.profile, color: meta?.color || agentColor(item.profile) },
    })
    check(item)
    return contentFor(item, result)
  }

  async function pump(queue) {
    if (queue.active || !queue.items.length) return
    const item = queue.items.shift()
    queue.active = item
    let force
    const forced = new Promise((resolve) => { force = resolve })
    const aborted = () => {
      finish(item, errorContent(item.controller.signal.reason?.code))
      // Aborting a Promise does not terminate a dependency. Keep the lane
      // locked for a bounded grace period, then remove its execution target.
      item.watchdog = setTimeout(() => {
        item.forced = true
        const tab = item.tab
        try {
          const wc = tab?.webContents
          if (tab && lanes.getTab(tab.id) === tab) lanes.closeTab(tab.id)
          if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false })
          if (tab && lanes.getTab(tab.id) === tab) throw callError('blocked_by_policy')
        } catch {
          // Never run replacement work if teardown could not be established.
          quarantined.add(item.laneId)
        }
        force(errorContent('timeout'))
      }, abortGraceMs)
      item.watchdog.unref?.()
    }
    item.controller.signal.addEventListener('abort', aborted, { once: true })
    try {
      finish(item, await Promise.race([execute(item), forced]))
    } catch (error) {
      finish(item, errorContent(item.controller.signal.aborted ? item.controller.signal.reason?.code : error?.code))
    } finally {
      item.controller.signal.removeEventListener('abort', aborted)
      queue.active = null
      release(item)
      // Release only after unwind or forced tab teardown. Late results from a
      // forced run cannot settle the call or unlock a newer queue.
      if (queue.items.length) void pump(queue)
      else queues.delete(item.laneId)
    }
  }

  function call(params = {}, { owner, signal } = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) params = {}
    return new Promise((resolve) => {
      const item = { profile: params.profile, name: params.name, args: params.arguments === undefined ? {} : params.arguments,
        callId: params.callId, owner, started: Date.now(), resolve, controller: new AbortController() }
      item.done = new Promise((drained) => { item.drained = drained })
      try {
        gate(item.profile)
        item.laneId = `profile:${item.profile}`
        if (typeof item.callId !== 'string' || !item.callId || item.callId.length > 256 ||
            !validateArguments(item.name, item.args) ||
            [...calls].some((other) => other.owner === owner && other.callId === item.callId)) throw callError('bad_args')
        const serialized = JSON.stringify(item.args)
        if (Buffer.byteLength(serialized) > maxArgumentBytes) throw callError('resource_limit')
        // Freeze admitted arguments, so callers cannot enlarge or mutate queued
        // work after validation. Socket input is already bounded separately.
        item.args = JSON.parse(serialized)
        if (signal?.aborted) throw callError('blocked_by_policy')
        const queue = queues.get(item.laneId)
        if (calls.size >= maxQueuedCalls || (queue?.items.length || 0) + (queue?.active ? 1 : 0) >= maxQueuedCallsPerLane) {
          throw callError('resource_limit')
        }
        lanes.ensureLane(item.laneId)
        if (lanes.isPaused(item.laneId)) throw callError('user_took_control')
      } catch (error) {
        finish(item, errorContent(error?.code))
        return
      }
      calls.add(item)
      let queue = queues.get(item.laneId)
      if (!queue) queues.set(item.laneId, queue = { active: null, items: [] })
      queue.items.push(item)
      // Deadline includes queue wait. A cancelled active command still holds
      // capacity and the lane lock until its dependencies actually unwind.
      item.timer = setTimeout(() => cancelItem(item, 'timeout'), commandTimeoutMs)
      item.timer.unref?.()
      if (signal) {
        const abort = () => cancelItem(item, 'blocked_by_policy')
        signal.addEventListener('abort', abort, { once: true })
        // Remove the listener when the response settles, not after queue wait.
        item.resolve = (result) => { signal.removeEventListener('abort', abort); resolve(result) }
      }
      void pump(queue)
    })
  }

  function cancelItem(item, code) {
    const queue = queues.get(item.laneId)
    if (queue?.active === item) item.controller.abort(callError(code))
    else {
      if (queue) queue.items = queue.items.filter((entry) => entry !== item)
      finish(item, errorContent(code))
      release(item)
      if (queue && !queue.active && !queue.items.length) queues.delete(item.laneId)
    }
  }

  function cancel(callId, { owner } = {}) {
    for (const item of calls) {
      if (item.callId === callId && item.owner === owner) cancelItem(item, 'blocked_by_policy')
    }
  }

  function cancelLane(laneId, code = 'user_took_control') {
    for (const item of calls) if (item.laneId === laneId) cancelItem(item, code)
  }

  function takeover({ laneId, tabId }) {
    if (!/^profile:[a-z0-9][a-z0-9_-]{0,63}$/.test(laneId || '')) return
    cancelLane(laneId)
    if (!getSessionForProfile || !serveClient) return
    void (async () => {
      const sessionId = await getSessionForProfile(laneId.slice(8))
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return
      await serveClient.call('session.steer', { session_id: sessionId,
        text: `[Workspace] User took control of tab ${/^t_[a-z0-9]+$/.test(tabId || '') ? tabId : '(lane)'}; wait for them to hand it back.` })
    })().catch(() => {})
  }
  const changed = () => {
    for (const laneId of queues.keys()) if (lanes.isPaused(laneId)) cancelLane(laneId)
  }
  lanes.on('user-input', takeover)
  lanes.on('changed', changed)

  return {
    call, rejectCall, cancel, cancelLane, gate, listTools,
    async dispose() {
      if (disposed) return
      disposed = true
      lanes.off('user-input', takeover)
      lanes.off('changed', changed)
      for (const item of calls) cancelItem(item, 'app_unavailable')
      // Detached debuggers must not race a still-unwinding CDP run.
      await Promise.all([...queues.values()].filter((queue) => queue.active).map((queue) => queue.active.done))
      executor.dispose?.()
    },
  }
}

module.exports = { createDispatch, callError, errorContent, agentColor }
