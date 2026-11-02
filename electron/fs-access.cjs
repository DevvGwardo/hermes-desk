'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { validateFsPath, isInsideRoot, canonicalPath } = require('./fs-guard.cjs')

/** Files IPC has its own capability, not the historical whole-home jail.
 * @param {{home?: string, protectedRoots?: string[], defaultRoot?: string}} [options]
 */
function createFsAccess({ home = os.homedir(), protectedRoots = [], defaultRoot = path.join(home, 'Hermes Desk') } = {}) {
  const protectedPaths = [path.join(home, '.hermes'), path.join(home, '.agent-tasks'),
    path.join(home, 'Library'), ...protectedRoots].map(p => path.resolve(p))
  let selected = defaultRoot
  let generation = 0
  /**
   * @param {string} candidate
   * @param {boolean} [selecting]
   * @returns {string}
   */
  function safe(candidate, selecting = false) {
    const resolved = validateFsPath(candidate, 'path', [home])
    const relative = path.relative(canonicalPath(home), canonicalPath(resolved))
    if (!relative || relative.split(path.sep).some(part => part.startsWith('.')) ||
        protectedPaths.some(root => isInsideRoot(root, resolved) || selecting && isInsideRoot(resolved, root))) {
      throw new Error('Path not allowed: protected application or credential storage')
    }
    return resolved
  }
  /**
   * @param {string} candidate
   * @param {string} [label]
   * @returns {string}
   */
  function validate(candidate, label = 'path') {
    safe(candidate)
    return validateFsPath(candidate, label, [selected])
  }
  return {
    roots: () => [selected],
    root: () => { safe(selected); return selected },
    validate,
    /**
     * @param {string} candidate
     * @returns {boolean}
     */
    canAccess(candidate) { try { validate(candidate); return true } catch { return false } },
    async ensure() {
      safe(selected)
      await fs.promises.mkdir(selected, { recursive: true, mode: 0o700 })
      validate(fs.realpathSync(selected))
      return selected
    },
    /**
     * @param {string} candidate
     * @returns {string}
     */
    select(candidate) {
      const real = fs.realpathSync(safe(candidate, true))
      safe(real, true)
      if (!fs.statSync(real).isDirectory()) throw new Error('Choose a regular workspace folder')
      selected = real
      generation++
      return selected
    },
    reset() { selected = defaultRoot; generation++ },
    get generation() { return generation },
  }
}

module.exports = { createFsAccess }
