'use strict'

const GATEWAY_URL = 'http://127.0.0.1:8642'

/** Diagnostics only. No key, profile files, or authenticated gateway routes.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
function createGatewayClient({ fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  return {
    async health() {
      try {
        const response = await fetchImpl(`${GATEWAY_URL}/health`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return { state: 'down', url: GATEWAY_URL, detail: `Health HTTP ${response.status}` }
        const data = await response.json()
        const version = typeof data?.version === 'string' ? data.version.slice(0, 100) : undefined
        return { state: 'up', url: GATEWAY_URL, ...(version ? { version } : {}) }
      } catch {
        return { state: 'down', url: GATEWAY_URL, detail: 'Gateway unavailable' }
      }
    },
  }
}

module.exports = { createGatewayClient, GATEWAY_URL }
