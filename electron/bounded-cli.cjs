'use strict'

const { spawn } = require('node:child_process')
let inflight = 0
/**
 * @typedef {{ok: boolean, code: number, data: string|null, error?: string}} BoundedCliResult
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{spawnImpl?: typeof spawn, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<BoundedCliResult>}
 */
function runBoundedCli(bin, args, env, { spawnImpl = spawn, timeoutMs = 30000, maxBytes = 1024 * 1024 } = {}) {
  if (inflight >= 4) return Promise.resolve({ ok: false, code: -1, data: null, error: 'Local command busy' })
  inflight++
  return new Promise(resolve => {
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    let settled = false, size = 0, out = '', err = ''
    /**
     * @param {BoundedCliResult} result
     */
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      inflight--
      resolve(result)
    }
    /**
     * @param {string} error
     */
    const stop = error => {
      const pid = child?.pid
      try {
        if (process.platform !== 'win32' && Number.isSafeInteger(pid) && typeof pid === 'number' && pid > 1) process.kill(-pid, 'SIGKILL')
        else child?.kill('SIGKILL')
      } catch { try { child?.kill('SIGKILL') } catch {} }
      finish({ ok: false, code: -1, data: null, error })
    }
    try {
      const proc = child = spawnImpl(bin, args, { env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      if (!proc.stdout || !proc.stderr) return stop('Local command unavailable')
      timer = setTimeout(() => stop('Local command timed out'), timeoutMs)
      timer.unref?.()
      /**
       * @param {Buffer} data
       * @param {boolean} stderr
       */
      const collect = (data, stderr) => {
        if (settled) return
        size += data.length
        if (size > maxBytes) return stop('Local command output too large')
        if (stderr) err += data.toString()
        else out += data.toString()
      }
      proc.stdout.on('data', data => collect(data, false))
      proc.stderr.on('data', data => collect(data, true))
      proc.once('error', () => stop('Local command unavailable'))
      proc.once('close', code => finish({ ok: code === 0, code: code ?? -1,
        data: (out || err).trim(), ...(code === 0 ? {} : { error: 'Local command failed' }) }))
    } catch { stop('Local command unavailable') }
  })
}
module.exports = { runBoundedCli }
