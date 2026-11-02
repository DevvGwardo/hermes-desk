'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * @param {string} p
 * @returns {string|null} real path, or null when it cannot be resolved yet.
 */
function tryRealpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    // ENOENT / EACCES / ELOOP — path doesn't exist or can't be resolved yet.
    // Fall back to lexical resolution; caller will still validate containment.
    return null
  }
}

/**
 * @param {string} p
 * @returns {string}
 */
function canonicalPath(p) {
  const resolved = path.resolve(p)
  let ancestor = resolved
  while (true) {
    const real = tryRealpath(ancestor)
    if (real) return path.join(real, path.relative(ancestor, resolved))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return resolved
    ancestor = parent
  }
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isInsideRoot(root, candidate) {
  let r = canonicalPath(root)
  let c = canonicalPath(candidate)
  // Resolve symlinks where possible — a symlink at ~/evil -> /etc would
  // otherwise pass the lexical home check but escape on fs access.
  const rr = tryRealpath(r)
  const cc = tryRealpath(c)
  // If realpath succeeded, use the canonical paths; otherwise keep lexical.
  // Also try to resolve parent dirs when the leaf doesn't exist yet.
  if (rr) r = rr
  else {
    const pr = tryRealpath(path.dirname(r))
    if (pr) r = path.join(pr, path.basename(r))
  }
  if (cc) c = cc
  else {
    const pc = tryRealpath(path.dirname(c))
    if (pc) c = path.join(pc, path.basename(c))
  }
  if (process.platform === 'win32') {
    r = r.toLowerCase()
    c = c.toLowerCase()
  }
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  return c === r || c.startsWith(prefix)
}

/**
 * @returns {string[]}
 */
function allowedFsRoots() {
  const home = os.homedir()
  const roots = [home]
  const extra = process.env.HERMES_CWD
  if (typeof extra === 'string' && extra && isInsideRoot(home, extra)) {
    roots.push(path.resolve(extra))
  }
  return roots
}

/**
 * @param {string} rawPath
 * @param {string} [label]
 * @param {string[]} [roots]
 * @returns {string}
 */
function validateFsPath(rawPath, label = 'path', roots = allowedFsRoots()) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4096) {
    throw new Error(`Invalid ${label}`)
  }
  if (rawPath.includes('\0')) throw new Error(`Invalid ${label}: NUL byte`)
  if (!path.isAbsolute(rawPath)) throw new Error(`Invalid ${label}: absolute path required`)
  const resolved = path.resolve(rawPath)
  if (!roots.some((root) => isInsideRoot(root, resolved))) {
    throw new Error(`Invalid ${label}: outside home`)
  }
  return resolved
}

/**
 * @returns {string}
 */
function defaultFsRoot() {
  try {
    return validateFsPath(process.cwd(), 'cwd')
  } catch {
    return os.homedir()
  }
}

module.exports = {
  isInsideRoot,
  allowedFsRoots,
  validateFsPath,
  defaultFsRoot,
  canonicalPath,
}
