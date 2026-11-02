'use strict'

/**
 * System notifications from the main window (reply finished, approval
 * needed, routine ran) — the page cannot post them itself: the session's
 * permission policy denies `notifications` (main.cjs installPermissionPolicy).
 * The renderer sends a small payload; this module bounds it before it
 * reaches the OS, and the click target is echoed back to the page as-is.
 */

const TARGET_KINDS = new Set(['conversation', 'routines'])
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/

/** @param {unknown} v @param {number} max */
function clip(v, max) {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** A safe `{ title, body, target }`, or null when there is nothing to show.
 * @param {unknown} payload
 */
function sanitizeNotification(payload) {
  if (!payload || typeof payload !== 'object') return null
  const data = /** @type {Record<string, unknown>} */ (payload)
  const title = clip(data.title, 80)
  if (!title) return null
  const body = clip(data.body, 240)
  let target = null
  const t = /** @type {Record<string, unknown> | null | undefined} */ (data.target)
  if (t && typeof t === 'object' && typeof t.kind === 'string' && TARGET_KINDS.has(t.kind)) {
    const id = typeof t.id === 'string' && ID_RE.test(t.id) ? t.id : undefined
    if (t.kind === 'conversation' && !id) target = null
    else target = id ? { kind: t.kind, id } : { kind: t.kind }
  }
  return { title, body, target, force: data.force === true }
}

module.exports = { sanitizeNotification }
