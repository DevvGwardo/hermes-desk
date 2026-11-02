'use strict'

const { EventEmitter } = require('node:events')
const { randomBytes } = require('node:crypto')
const { LANE_RE, TAB_RE } = require('./url-policy.cjs')

const MAX_AGENT_TABS = 8
const MAX_LIVE_VIEWS = 20
const TAB_STATES = new Set(['idle', 'loading', 'agent-acting', 'user-paused'])

function workspaceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function createLanes({ urlPolicy, createView, destroyView, isVisibleTab = () => false,
  restore = null, onEnsureLane = () => {}, getLimits = () => ({}), getAgentMeta = () => null }) {
  const events = new EventEmitter()
  const laneMap = new Map()
  const tabs = new Map()
  const dataLocks = new Set()
  let clock = 0
  let liveQueue = Promise.resolve()
  let disposed = false
  function limits() {
    const config = getLimits() || {}
    const bounded = (value, fallback) => Number.isInteger(value) && value > 0 && value <= fallback ? value : fallback
    return { agent: bounded(config.maxTabsPerAgent, MAX_AGENT_TABS), live: bounded(config.maxLiveViews, MAX_LIVE_VIEWS) }
  }
  const api = {
    focusedLaneId: 'you',
    on: events.on.bind(events), off: events.off.bind(events), emit: events.emit.bind(events),
    allLanes: () => [...laneMap.keys()].map(ensureLane),
    isVisibleTab,
    ensureLane, listTabs, getTab: (id) => tabs.get(id) || null,
    getActiveTab: (id) => tabs.get(laneMap.get(id)?.activeTabId) || null,
    openTab, activateTab, closeTab, setTabState, moveTab, focusLane, pauseLane, resumeLane,
    isPaused: (id) => laneMap.get(id)?.paused === true,
    policyContext: (laneId) => ({ laneKind: ensureLane(laneId).kind, laneId, profile: ensureLane(laneId).profile }),
    changed: () => events.emit('changed'), dispose,
    getAgentMeta,
    getWorkspaceConfig: getLimits,
    lockLaneData(id) {
      ensureLane(id)
      if (dataLocks.has(id)) throw workspaceError('blocked_by_policy', 'Lane data operation in progress')
      dataLocks.add(id)
      return () => dataLocks.delete(id)
    },
  }

  function ensureLane(id) {
    if (typeof id !== 'string' || !LANE_RE.test(id)) throw workspaceError('bad_args', 'Invalid laneId')
    if (disposed) throw workspaceError('tab_closed', 'Workspace closed')
    if (!laneMap.has(id)) {
      const profile = id === 'you' ? undefined : id.slice(8)
      const lane = { id, kind: profile ? 'agent' : 'user', ...(profile ? { profile } : {}),
        partition: profile ? `persist:ws-agent-${profile}` : 'persist:ws-user',
        paused: false, label: profile || 'You', activeTabId: null }
      laneMap.set(id, lane)
      try { onEnsureLane(lane) } catch (error) { laneMap.delete(id); throw error }
      events.emit('changed')
    }
    const lane = laneMap.get(id)
    if (lane.profile) {
      const meta = getAgentMeta(lane.profile)
      lane.label = typeof meta?.name === 'string' && meta.name.trim() ?
        meta.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 128) : lane.profile
      lane.color = /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(meta?.color || '') ? meta.color : undefined
    }
    return lane
  }

  function listTabs(id) {
    return [...tabs.values()].filter((tab) => tab.laneId === id)
  }

  function newTab(lane, fields) {
    const tab = { id: `t_${randomBytes(8).readBigUInt64BE().toString(36)}`, laneId: lane.id,
      partition: lane.partition, url: '', title: '', favicon: undefined, state: 'idle',
      controller: lane.kind === 'agent' ? 'agent' : 'user', createdBy: 'user',
      sharedLogin: false, discarded: true, webContents: null, lastUsed: ++clock, ...fields }
    tab.ensureLive = () => {
      // Serial admission prevents simultaneous commands from exceeding the global cap.
      const next = liveQueue.then(async () => {
        if (dataLocks.has(tab.laneId)) throw workspaceError('blocked_by_policy', 'Lane data operation in progress')
        if (disposed || !tabs.has(tab.id)) throw workspaceError('tab_closed', 'Tab closed')
        const existing = tab.webContents && !tab.webContents.isDestroyed()
        const live = [...tabs.values()].filter((candidate) => candidate.webContents && !candidate.webContents.isDestroyed())
        while (live.length > limits().live - (existing ? 0 : 1)) {
          const candidate = live.filter((other) => other.id !== tab.id &&
            !isVisibleTab(other.id) && other.state !== 'agent-acting')
            .sort((a, b) => a.lastUsed - b.lastUsed)[0]
          if (!candidate) throw workspaceError('view_limit', 'All workspace views are busy')
          discard(candidate)
          live.splice(live.indexOf(candidate), 1)
        }
        if (existing) {
          tab.lastUsed = ++clock
          await tab.liveReady
          return tab.webContents
        }
        tab.webContents = createView(tab)
        tab.discarded = false
        try { await tab.liveReady } catch {
          discard(tab)
          throw workspaceError('blocked_by_policy', 'Tab initialization failed')
        }
        if (disposed || !tabs.has(tab.id) || tab.webContents?.isDestroyed()) {
          throw workspaceError('tab_closed', 'Tab closed')
        }
        tab.lastUsed = ++clock
        events.emit('changed')
        return tab.webContents
      })
      liveQueue = next.catch(() => {})
      return next
    }
    tabs.set(tab.id, tab)
    return tab
  }

  function discard(tab) {
    destroyView(tab)
    tab.webContents = null
    tab.discarded = true
    tab.state = api.isPaused(tab.laneId) ? 'user-paused' : 'idle'
    events.emit('changed')
  }

  async function openTab(laneId, rawUrl, { createdBy = 'user' } = {}) {
    const lane = ensureLane(laneId)
    if (dataLocks.has(laneId)) throw workspaceError('blocked_by_policy', 'Lane data operation in progress')
    if (!['user', 'agent'].includes(createdBy)) throw workspaceError('bad_args', 'Invalid tab creator')
    if (lane.kind === 'agent' && listTabs(laneId).length >= limits().agent) {
      throw workspaceError('tab_limit', 'Agent lane tab limit reached')
    }
    let url = ''
    if (rawUrl !== undefined) {
      const decision = urlPolicy.resolve(rawUrl, api.policyContext(laneId))
      if (!decision.ok) throw workspaceError('blocked_by_policy', decision.reason)
      url = decision.url
    }
    const tab = newTab(lane, { url, createdBy, state: lane.paused ? 'user-paused' : 'idle' })
    const previous = lane.activeTabId
    const previousFocus = api.focusedLaneId
    lane.activeTabId = tab.id
    if (createdBy === 'user') api.focusedLaneId = lane.id
    try {
      await tab.ensureLive()
      events.emit('changed')
      return tab
    } catch (error) {
      tabs.delete(tab.id)
      lane.activeTabId = previous
      if (api.focusedLaneId === lane.id) api.focusedLaneId = previousFocus
      events.emit('changed')
      throw error
    }
  }

  function requireTab(id) {
    if (typeof id !== 'string' || !TAB_RE.test(id)) throw workspaceError('bad_args', 'Invalid tabId')
    const tab = tabs.get(id)
    if (!tab) throw workspaceError('tab_closed', 'Tab not found')
    return tab
  }

  async function activateTab(id, { steal = true } = {}) {
    const tab = requireTab(id)
    ensureLane(tab.laneId).activeTabId = id
    if (steal) api.focusedLaneId = tab.laneId
    tab.lastUsed = ++clock
    await tab.ensureLive()
    events.emit('changed')
  }

  async function focusLane(id) {
    const lane = ensureLane(id)
    api.focusedLaneId = lane.id
    const tab = api.getActiveTab(id)
    if (tab) await tab.ensureLive()
    events.emit('changed')
  }

  function closeTab(id) {
    const tab = requireTab(id)
    const lane = ensureLane(tab.laneId)
    events.emit('tab-closing', tab)
    destroyView(tab)
    tabs.delete(id)
    tab.webContents = null
    if (lane.activeTabId === id) {
      lane.activeTabId = listTabs(lane.id).sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id || null
      const next = api.getActiveTab(lane.id)
      if (next && api.focusedLaneId === lane.id) next.ensureLive().catch(() => {})
    }
    events.emit('changed')
  }

  function setTabState(id, state) {
    if (!TAB_STATES.has(state)) throw workspaceError('bad_args', 'Invalid tab state')
    const tab = requireTab(id)
    tab.state = api.isPaused(tab.laneId) ? 'user-paused' : state
    if (state === 'agent-acting') tab.lastUsed = ++clock
    events.emit('changed')
  }

  function pauseLane(id) {
    const lane = ensureLane(id)
    lane.paused = true
    for (const tab of listTabs(id)) tab.state = 'user-paused'
    events.emit('changed')
  }

  function resumeLane(id) {
    const lane = ensureLane(id)
    lane.paused = false
    for (const tab of listTabs(id)) tab.state = 'idle'
    events.emit('changed')
  }

  function moveTab(id, laneId) {
    const tab = requireTab(id)
    const destination = ensureLane(laneId)
    if (dataLocks.has(laneId) || dataLocks.has(tab.laneId)) throw workspaceError('blocked_by_policy', 'Lane data operation in progress')
    if (tab.laneId === laneId) return tab
    if (destination.kind === 'agent' && listTabs(laneId).length >= limits().agent) {
      throw workspaceError('tab_limit', 'Agent lane tab limit reached')
    }
    if (tab.url) {
      const decision = urlPolicy.check(tab.url, api.policyContext(laneId))
      if (!decision.ok) throw workspaceError('blocked_by_policy', decision.reason)
    }
    const previous = ensureLane(tab.laneId)
    const wasVisible = api.focusedLaneId === previous.id && previous.activeTabId === id
    tab.laneId = laneId
    tab.controller = destination.kind === 'agent' ? 'agent' : 'user'
    tab.sharedLogin = destination.kind === 'agent' && tab.partition === 'persist:ws-user'
    tab.state = destination.paused ? 'user-paused' : 'idle'
    destination.activeTabId = id
    if (previous.activeTabId === id) previous.activeTabId = listTabs(previous.id)[0]?.id || null
    if (wasVisible) api.focusedLaneId = laneId
    events.emit('changed')
    return tab
  }

  function dispose() {
    disposed = true
    for (const tab of tabs.values()) destroyView(tab)
    tabs.clear()
    events.removeAllListeners()
  }

  ensureLane('you')
  if (restore) {
    for (const saved of restore.lanes) {
      const lane = ensureLane(saved.id)
      for (const savedTab of saved.tabs) {
        if (lane.kind === 'agent' && listTabs(lane.id).length >= limits().agent) break
        if (savedTab.url && !urlPolicy.check(savedTab.url, api.policyContext(lane.id)).ok) continue
        newTab(lane, { ...savedTab,
          partition: savedTab.sharedLogin ? 'persist:ws-user' : lane.partition,
          controller: lane.kind === 'agent' ? 'agent' : 'user' })
      }
      lane.activeTabId = tabs.has(saved.activeTabId) ? saved.activeTabId : listTabs(lane.id)[0]?.id || null
    }
    api.focusedLaneId = laneMap.has(restore.focusedLaneId) ? restore.focusedLaneId : 'you'
  }
  return api
}

module.exports = { createLanes, workspaceError, MAX_AGENT_TABS, MAX_LIVE_VIEWS }
