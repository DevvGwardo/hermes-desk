'use strict'

/**
 * Filesystem trust checks for external binaries we are about to exec.
 *
 * The gold standard is secrets-op.cjs: fixed paths + codesign team-ID
 * pinning. That is not available for self-built / Homebrew tools
 * (whisper-cli, ffmpeg, ~/.agent-tasks task) which carry ad-hoc or no
 * Apple signatures — so enforce the next-best anchors before every spawn:
 *
 *  1. regular file (no directories/devices)
 *  2. not group- or world-writable (a tampered install refuses to run)
 *  3. the resolved path is logged so a swap is detectable after the fact
 *
 * Pure Node — no electron imports — unit-testable like secrets-op.
 */

const fs = require('fs')
const path = require('path')

/**
 * @typedef {{ existsSync?: (path: string) => boolean,
 *   statSync?: (path: string) => import('node:fs').Stats,
 *   log?: (line: string) => void }} BinTrustDeps
 */
const defaultDeps = {
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  log: (/** @type {string} */ line) => console.log(line),
}

/** Paths already announced — keep the audit trail to first sight only. */
const _loggedPaths = new Set()

/**
 * @param {string} candidatePath absolute path to a binary we intend to spawn
 * @param {BinTrustDeps} [deps]
 * @returns {{ ok: boolean, error?: string }}
 */
function inspectBinTrust(candidatePath, deps = defaultDeps) {
  const existsSync = deps.existsSync || defaultDeps.existsSync
  const statSync = deps.statSync || defaultDeps.statSync
  if (!candidatePath || typeof candidatePath !== 'string') {
    return { ok: false, error: 'empty binary path' }
  }
  if (!existsSync(candidatePath)) {
    return { ok: false, error: `not found: ${candidatePath}` }
  }
  let st
  try {
    st = statSync(candidatePath)
  } catch (err) {
    return { ok: false, error: `stat failed for ${candidatePath}: ${err instanceof Error ? err.message : 'unknown error'}` }
  }
  if (!st.isFile()) {
    return { ok: false, error: `not a regular file: ${candidatePath}` }
  }
  // POSIX permission bits are meaningless on Windows.
  if (process.platform !== 'win32') {
    const groupOrWorldWritable = (st.mode & 0o022) !== 0
    if (groupOrWorldWritable) {
      return {
        ok: false,
        error: `refusing group/world-writable binary (${(st.mode & 0o777).toString(8)}): ${candidatePath}`,
      }
    }
  }
  return { ok: true }
}

/** inspectBinTrust + a one-line resolution log so swaps are visible.
 *  Repeat resolutions of the same path log once per process (git status
 *  fires on every file-tree refresh — no spam).
 * @param {string} candidatePath
 * @param {string} label
 * @param {BinTrustDeps} [deps]
 */
function verifyAndLogBin(candidatePath, label, deps = defaultDeps) {
  const verdict = inspectBinTrust(candidatePath, deps)
  const key = `${label}:${candidatePath}`
  if (!_loggedPaths.has(key)) {
    _loggedPaths.add(key)
    if (verdict.ok) {
      ;(deps.log || defaultDeps.log)(`[bin-guard] ${label}: ${candidatePath}`)
    } else {
      ;(deps.log || defaultDeps.log)(`[bin-guard] ${label}: REFUSED — ${verdict.error}`)
    }
  }
  return verdict
}

/**
 * Pass-3: resolve a binary name from PATH (+ optional extra dirs), returning
 * the first candidate that passes the trust check. Every external spawn in
 * the main process goes through this (or a fixed verified path) so no
 * security-relevant tool is ever exec'd from an unvetted PATH entry.
 *
 * @param {string} bin bare binary name (e.g. 'hermes', 'git', 'ffmpeg')
 * @param {{ extraDirs?: string[], deps?: BinTrustDeps }} [opts] fallback dirs appended after PATH
 * @returns {{ ok: boolean, bin?: string, error?: string }}
 */
function resolveTrustedBin(bin, opts = {}) {
  if (!bin || typeof bin !== 'string' || bin.includes('/') || bin.includes('\\')) {
    return { ok: false, error: 'binary name must be a bare name' }
  }
  const envPath = process.env.PATH || ''
  const seen = new Set(envPath.split(path.delimiter).filter(Boolean))
  const dirs = [...seen]
  for (const extra of opts.extraDirs || []) {
    if (!seen.has(extra)) dirs.push(extra)
  }
  let refused = null
  for (const dir of dirs) {
    const candidate = path.join(dir, bin)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
    } catch {
      continue
    }
    if (verifyAndLogBin(candidate, bin, opts.deps).ok) return { ok: true, bin: candidate }
    // Executable but untrusted — remember why and keep looking.
    refused = `refused untrusted candidate: ${candidate}`
  }
  return {
    ok: false,
    error: refused || `${bin} not found on PATH${opts.extraDirs?.length ? ' (+ fallbacks)' : ''}`,
  }
}

module.exports = { inspectBinTrust, verifyAndLogBin, resolveTrustedBin }
