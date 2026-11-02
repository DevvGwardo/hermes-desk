'use strict'

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const agentEnv = require('./agent-env.cjs')

/**
 * @typedef {{pid: string, bundle: string}} ActionTarget
 * @typedef {(event: import('electron').IpcMainEvent, options: {message: string, detail?: string, button?: string}) => Promise<unknown>} ConfirmAction
 * @typedef {(file: string, args: string[], options: {timeout: number, maxBuffer: number, env: unknown, shell: boolean}) => Promise<{stdout: unknown, stderr: unknown}>} RunCli
 */
/**
 * @param {{confirm: ConfirmAction, run?: RunCli}} deps
 */
function createHudActionConsent({ confirm, run = promisify(execFile) }) {
  const options = { timeout: 3000, maxBuffer: 4096, env: agentEnv.helperEnv(), shell: false }
  /**
   * @returns {Promise<ActionTarget>}
   */
  async function frontmost() {
    const { stdout } = await run('/usr/bin/osascript', ['-e',
      'tell application "System Events" to get {unix id, bundle identifier} of first application process whose frontmost is true'], options)
    const match = /^(\d+), ([a-zA-Z0-9_.-]+)\s*$/.exec(String(stdout))
    if (!match || Number(match[1]) === process.pid) throw new Error('No external input target')
    return { pid: match[1], bundle: match[2] }
  }
  /**
   * @param {ActionTarget} target
   * @returns {Promise<boolean>}
   */
  async function restore(target) {
    await run('/usr/bin/osascript', ['-e', 'on run argv',
      '-e', 'tell application "System Events" to set frontmost of first application process whose unix id is (item 1 of argv as integer) to true',
      '-e', 'end run', target.pid], options)
    const current = await frontmost()
    return current.pid === target.pid && current.bundle === target.bundle
  }
  /**
   * @param {import('electron').IpcMainEvent} event
   * @param {unknown} description
   * @returns {Promise<{dispose: () => void, revalidate: () => Promise<boolean>} | null>}
   */
  return async (event, description) => {
    const sender = event.sender
    const frame = event.senderFrame
    if (!sender || !frame || frame !== sender.mainFrame) return null
    let invalidated = false
    let issued = false
    const invalidate = () => { invalidated = true }
    const dispose = () => {
      invalidated = true
      sender.removeListener('did-start-navigation', invalidate)
      sender.removeListener('render-process-gone', invalidate)
      sender.removeListener('destroyed', invalidate)
    }
    sender.on('did-start-navigation', invalidate)
    sender.on('render-process-gone', invalidate)
    sender.on('destroyed', invalidate)
    try {
      const target = await frontmost()
      if (!await confirm(event, { message: 'Allow one action in another application?',
        detail: `Target: ${target.bundle} (process ${target.pid})\n${description}\nOnly approve an action you requested.` })) return null
      if (invalidated || !await restore(target)) return null
      const expires = Date.now() + 30000
      let used = false
      issued = true
      return {
        dispose,
        async revalidate() {
          if (used || invalidated || Date.now() > expires || sender.isDestroyed() || sender.mainFrame !== frame) return false
          used = true
          try {
            // Restore only after the dialog, never after a later user app switch.
            const current = await frontmost()
            return !invalidated && current.pid === target.pid && current.bundle === target.bundle
          } catch { return false }
        },
      }
    } catch { return null } finally { if (!issued) dispose() }
  }
}

module.exports = { createHudActionConsent }
