'use strict'
/**
 * hud-activity-relay.cjs — shape gate for the main-window → HUD activity feed.
 *
 * The main renderer publishes what its agents are doing; main forwards it to
 * the HUD so the collapsed cat can show a badge. Both ends are our own
 * renderers, but the payload crosses a process boundary and ends up rendered
 * in an always-on-top window, so it is re-shaped here: known keys only,
 * bounded lengths, bounded counts. Pure (no electron) for unit tests.
 *
 * Wire shape (v1):
 *   { v: 1,
 *     working: [{ id, title }],                                  // live now
 *     events:  [{ key, id, title, preview, status: 'done'|'error', at }] }
 */

const MAX_ITEMS = 10
const MAX_TITLE = 80
const MAX_PREVIEW = 220
const MAX_KEY = 160
const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/

/** @param {unknown} v */
function sanitizeConversationId(v) {
  return typeof v === 'string' && ID_RE.test(v) ? v : null
}

/** @param {unknown} v @param {number} max */
function clip(v, max) {
  if (typeof v !== 'string') return ''
  // Strip C0 controls (keep \n), collapse runs of whitespace.
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** @param {unknown} payload */
function sanitizeActivity(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = /** @type {Record<string, unknown>} */ (payload)
  if (data.v !== 1) return null
  const working = []
  for (const w of Array.isArray(data.working) ? data.working : []) {
    const id = sanitizeConversationId(w && w.id)
    if (!id) continue
    working.push({ id, title: clip(w.title, MAX_TITLE) })
    if (working.length >= MAX_ITEMS) break
  }
  const events = []
  for (const e of Array.isArray(data.events) ? data.events : []) {
    const id = sanitizeConversationId(e && e.id)
    if (!id) continue
    const status = e.status === 'error' ? 'error' : e.status === 'done' ? 'done' : null
    if (!status) continue
    const at = Number(e.at)
    if (!Number.isFinite(at) || at <= 0) continue
    const key = clip(e.key, MAX_KEY)
    if (!key) continue
    events.push({ key, id, title: clip(e.title, MAX_TITLE), preview: clip(e.preview, MAX_PREVIEW), status, at })
    if (events.length >= MAX_ITEMS) break
  }
  return { v: 1, working, events }
}

/**
 * @param {{ allLanes(): { id: string, kind: string, paused?: boolean, profile: string, label: string }[],
 *   listTabs(id: string): { state: string, url: string }[] } | null | undefined} lanes
 * @param {(profile: string) => string | null | undefined} [getStoredSession]
 */
function workspaceActivity(lanes, getStoredSession) {
  /** @type {{ id: string, title: string }[]} */
  const working = []
  if (!lanes) return sanitizeActivity({ v: 1, working, events: [] })
  for (const lane of lanes.allLanes() || []) {
    if (lane.kind !== 'agent' || lane.paused) continue
    const tab = lanes.listTabs(lane.id).find((entry) => entry.state === 'agent-acting')
    if (!tab) continue
    let host = 'a page'
    try {
      const url = new URL(tab.url)
      if (['http:', 'https:'].includes(url.protocol)) host = url.hostname
    } catch {}
    const stored = getStoredSession?.(lane.profile)
    const id = typeof stored === 'string' && ID_RE.test(stored)
      ? `local:${lane.profile}:${stored}` : `profile:${lane.profile}`
    working.push({ id, title: `${clip(lane.label, 40)} is browsing ${host}` })
  }
  return sanitizeActivity({ v: 1, working, events: [] })
}

/** @param {unknown} chat @param {unknown} workspace */
function mergeActivity(chat, workspace) {
  const first = sanitizeActivity(chat) || { v: 1, working: [], events: [] }
  const second = sanitizeActivity(workspace) || { v: 1, working: [], events: [] }
  const seen = new Set()
  return sanitizeActivity({ v: 1, working: [...second.working, ...first.working].filter((entry) => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  }), events: first.events })
}

module.exports = { sanitizeActivity, sanitizeConversationId, workspaceActivity, mergeActivity,
  MAX_ITEMS, MAX_TITLE, MAX_PREVIEW }
