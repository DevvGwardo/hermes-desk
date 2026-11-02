import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProbe } from '../../../scripts/spikes/mcp-hermes-load.mjs'
import { createProfileTokens } from './profile-tokens.cjs'

// Uses the unchanged, sandboxed spike. Observe only its disposable app socket:
// do not change Hermes, the shim, environment filtering, or discovery APIs.
describe.skipIf(process.env.HERMES_DESK_MCP_HERMES_LOAD !== '1')('real Hermes token-bearing MCP load', () => {
  it('loads the shim and forwards the exact stored per-profile token on every hello', async () => {
    const original = net.createServer
    const observed = []
    const observer = vi.spyOn(net, 'createServer').mockImplementation(function (listener) {
      return original.call(net, function (socket) {
        const directory = path.dirname(this.address())
        let buffer = ''
        socket.on('data', data => {
          buffer += data
          let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            const frame = JSON.parse(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            if (frame.method !== 'hello') continue
            const verified = createProfileTokens(directory).verify(frame.params.profile, frame.params.token)
            const privateFile = (fs.statSync(path.join(directory, 'profile-tokens.json')).mode & 0o777) === 0o600
            // Store only booleans/profile labels, never credentials or raw frames.
            observed.push({ profile: frame.params.profile, verified, privateFile })
          }
        })
        listener(socket)
      })
    })
    try {
      const receipt = await runProbe()
      expect(receipt.shim_spawned).toBe(true)
      expect(receipt.no_model_calls).toBe(true)
      expect(receipt.tcp_ports_bound).toEqual([])
      expect(observed).toEqual(['default', 'spike-alpha', 'default']
        .map(profile => ({ profile, verified: true, privateFile: true })))
    } finally { observer.mockRestore() }
  }, 120_000)
})
