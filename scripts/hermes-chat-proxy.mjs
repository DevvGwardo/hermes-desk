#!/usr/bin/env node
/**
 * Local hermes-agent chat proxy for the Nub Agent (maiavm-desktop) app.
 *
 * The app's local route posts to `${serveUrl}/v1/chat/completions` WITHOUT
 * an Authorization header, and the browser preflight needs CORS. This shim
 * adds both: reads API_SERVER_KEY from ~/.hermes/.env, forwards to the local
 * api_server (127.0.0.1:8642), and answers CORS preflights.
 *
 * Streaming: SSE responses pass straight through (pipe), including
 * `event: hermes.tool.progress` frames for tool-call chips.
 *
 * Session continuity: forwards the `X-Hermes-Session-Id` request header
 * (continue an existing hermes session) and exposes the `X-Hermes-Session-Id`
 * response header so the renderer can capture the session id the api_server
 * created and send it back on the next message.
 *
 * Usage: node scripts/hermes-chat-proxy.mjs [port]   (default 8899)
 * In app devtools: localStorage.setItem('maia:hermesServeUrl','http://127.0.0.1:8899')
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] || 8899)
const UPSTREAM = process.env.HERMES_UPSTREAM || 'http://127.0.0.1:8642'

// API_SERVER_KEY lives in ~/.hermes/.env as API_SERVER_KEY=...
function loadKey() {
  try {
    const envPath = path.join(os.homedir(), '.hermes', '.env')
    const raw = fs.readFileSync(envPath, 'utf8')
    const m = raw.match(/^API_SERVER_KEY=(.+)$/m)
    if (m) return m[1].trim()
  } catch {}
  return process.env.API_SERVER_KEY || ''
}

const KEY = loadKey()

/** Vite / Electron-dev origins only. Never reflect a remote page. */
export function isAllowedProxyOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hermes-Session-Id',
    'Access-Control-Expose-Headers': 'X-Hermes-Session-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function applyCors(res, cors) {
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
}

function forward(req, res, cors) {
  const bodyChunks = []
  req.on('data', (c) => bodyChunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks)
    const headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Content-Length': body.length,
    }
    if (KEY) headers.Authorization = `Bearer ${KEY}`
    // Session continuity: pass the app's session id upstream.
    if (req.headers['x-hermes-session-id']) {
      headers['X-Hermes-Session-Id'] = String(req.headers['x-hermes-session-id'])
    }

    const upstream = new URL(req.url, UPSTREAM)
    const preq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: upstream.pathname + upstream.search,
        method: req.method,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode, { ...pres.headers, ...cors })
        pres.pipe(res)
      },
    )
    preq.on('error', (err) => {
      applyCors(res, cors)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }))
    })
    preq.end(body)
  })
}

function rejectOrigin(res) {
  res.writeHead(403, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'origin not allowed' } }))
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin
  if (!isAllowedProxyOrigin(origin)) {
    rejectOrigin(res)
    return
  }
  const cors = corsHeaders(origin)
  applyCors(res, cors)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  forward(req, res, cors)
})

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`hermes chat proxy: http://127.0.0.1:${PORT} -> ${UPSTREAM}`)
    console.log(`key loaded: ${KEY ? 'yes' : 'NO — chat will 401'}`)
    console.log(`cwd: ${path.dirname(fileURLToPath(import.meta.url))}`)
  })
}
