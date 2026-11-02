#!/usr/bin/env node
/**
 * Live probe: the exact RPC surface hermes-bots needs against a running
 * `hermes serve` (default http://127.0.0.1:9119). Proves the backend half of
 * the plugin host — the renderer half is covered by plugin-host-smoke.mjs.
 *
 *   node scripts/serve-plugin-rpc-probe.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)

const BASE = process.env.HERMES_SERVE_URL || 'http://127.0.0.1:9119'

async function main() {
  // Token: env (HERMES_DASHBOARD_SESSION_TOKEN) or the dev convenience file.
  let token = process.env.HERMES_DASHBOARD_SESSION_TOKEN || ''
  if (!token) {
    try {
      token = readFileSync(path.join(homedir(), '.hermes', 'serve.token'), 'utf8').trim()
    } catch {
      /* none */
    }
  }

  // Node 22 has global WebSocket.
  const http = new URL(BASE)
  const scheme = http.protocol === 'https:' ? 'wss:' : 'ws:'
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  const wsUrl = `${scheme}//${http.host}/api/ws${qs}`

  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 60000)
    })

  ws.onmessage = (ev) => {
    try {
      const frame = JSON.parse(String(ev.data))
      if (frame.id && pending.has(String(frame.id))) {
        const { resolve, reject } = pending.get(String(frame.id))
        pending.delete(String(frame.id))
        if (frame.error) reject(new Error(`${frame.error.code}: ${frame.error.message}`))
        else resolve(frame.result)
      }
    } catch {}
  }

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('ws connect failed'))
    setTimeout(() => reject(new Error('ws connect timeout')), 15000)
  })
  console.log(`  • WS ${wsUrl} open`)

  // The RPCs hermes-bots uses via host.request — a representative subset.
  const probes = [
    ['profiles.list', {}],
    ['session.list', {}],
    ['model.options', {}],
    ['mcp.catalog', {}],
    ['cron.manage', { action: 'list' }],
  ]

  let failed = 0
  for (const [method, params] of probes) {
    try {
      const res = await call(method, params)
      const shape = Array.isArray(res) ? `${res.length} rows` : Object.keys(res ?? {}).slice(0, 4).join(',')
      console.log(`  ✓ ${method} → ${shape}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${method} → ${err.message}`)
    }
  }

  ws.close()
  console.log(failed === 0 ? '\nall plugin RPCs reachable' : `\n${failed}/${probes.length} probes failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
