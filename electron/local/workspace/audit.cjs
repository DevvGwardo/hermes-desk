'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { PROFILE_RE, LANE_RE, TAB_RE, parseHttp } = require('./url-policy.cjs')

const MAX_BYTES = 5 * 1024 * 1024
const RESULTS = new Set(['ok', 'error', 'blocked', 'cancelled', 'off', 'pending', 'user_took_control',
  'blocked_by_policy', 'timeout', 'no_such_ref', 'tab_closed', 'bad_args', 'not_enabled', 'app_unavailable'])

/**
 * Whitelisted audit metadata. Every field is optional and untrusted: each one
 * is validated before it reaches the log line.
 * @typedef {object} AuditEntry
 * @property {unknown} [origin]
 * @property {unknown} [agent]
 * @property {unknown} [lane]
 * @property {unknown} [tab]
 * @property {unknown} [action]
 * @property {unknown} [result]
 * @property {unknown} [durationMs]
 * @property {unknown} [byUser]
 */
/**
 * @param {{userDataDir: string, maxBytes?: number, now?: () => Date, onError?: (message: string) => void}} options
 */
function createAudit({ userDataDir, maxBytes = MAX_BYTES, now = () => new Date(), onError = () => {} }) {
  const file = path.join(userDataDir, 'audit.jsonl')
  /**
   * @param {string} name
   * @returns {import('node:fs').Stats | null}
   */
  function regularFile(name) {
    try {
      const stat = fs.lstatSync(name)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe audit file')
      return stat
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * @param {AuditEntry} [entry]
   * @returns {boolean}
   */
  function log(entry = {}) {
    // Whitelist metadata; never serialize a command, page text, URL path, or exception.
    const origin = parseHttp(entry.origin)
    const record = {
      ts: now().toISOString(),
      agent: typeof entry.agent === 'string' && PROFILE_RE.test(entry.agent) ? entry.agent : null,
      lane: typeof entry.lane === 'string' && LANE_RE.test(entry.lane) ? entry.lane : null,
      tab: typeof entry.tab === 'string' && entry.tab.length <= 80 && TAB_RE.test(entry.tab) ? entry.tab : null,
      action: typeof entry.action === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/.test(entry.action) ? entry.action : 'unknown',
      origin: origin ? origin.origin : null,
      result: typeof entry.result === 'string' && RESULTS.has(entry.result) ? entry.result : 'error',
      durationMs: typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
      ...(typeof entry.byUser === 'boolean' ? { byUser: entry.byUser } : {}),
    }
    try {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
      const line = `${JSON.stringify(record)}\n`
      const stat = regularFile(file)
      if (stat && stat.size + Buffer.byteLength(line) > maxBytes) {
        // Three files total: the current log and two archives.
        for (const name of [file, `${file}.1`, `${file}.2`]) regularFile(name)
        if (regularFile(`${file}.2`)) fs.unlinkSync(`${file}.2`)
        if (regularFile(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`)
        fs.renameSync(file, `${file}.1`)
      }
      const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT |
        fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      try {
        fs.fchmodSync(fd, 0o600)
        fs.writeSync(fd, line)
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch {
      onError('Workspace audit unavailable')
      return false
    }
  }
  return { log }
}

module.exports = { createAudit, MAX_BYTES }
