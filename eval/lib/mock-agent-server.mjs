#!/usr/bin/env node
/**
 * Mock Hermes-deploy chat backend for chat invariants.
 *
 * Speaks the real wire (see src/lib/agents/deploy-stream.ts + hermes-deploy-transport.ts):
 *   POST /api/chat                              -> SSE, X-Hermes-Turn-Id / X-Hermes-Session-Id headers
 *   GET  /api/chat/runs/:turnId/events          -> SSE resume; honors Last-Event-Id (serves only id > n), always [DONE]
 *   GET  /api/chat/conversations?instanceId=... -> { conversations: [], turns: [] }  (list + hydrate polls)
 *   GET  /api/chat/state?instanceId=...&sessionId=... -> { turn: null }
 *   OPTIONS *                                   -> 204 preflight
 *
 * Fault injection (all faults apply to the POST stream only; /events always completes):
 *   dropAfterBytes N : end the response gracefully (res.end, NO [DONE]) once >= N bytes written,
 *                      finishing the frame in flight first -> client reattaches with Last-Event-Id.
 *   dropAfterMs    ms: same graceful end once the stream has run this long.
 *   malformedAtEnd     : write a truncated-JSON data frame right before [DONE]; parser must skip it.
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/streams')
const DEFAULT_FRAME_DELAY_MS = 20

/** Resolve 'f1' | 'f1-golden-single-turn' | a .json path -> fixture object. Objects pass through. */
export function loadFixture(ref) {
  if (ref && typeof ref === 'object') return ref
  let hit =
    typeof ref === 'string' && ref.endsWith('.json') && existsSync(ref)
      ? ref
      : path.join(FIXTURE_DIR, `${ref}.json`)
  if (!existsSync(hit)) {
    const fuzzy = readdirSync(FIXTURE_DIR).find((f) => f.endsWith('.json') && f.startsWith(`${ref}-`))
    if (fuzzy) hit = path.join(FIXTURE_DIR, fuzzy)
  }
  if (!existsSync(hit)) throw new Error(`fixture not found: ${ref} (searched ${FIXTURE_DIR})`)
  const fixture = JSON.parse(readFileSync(hit, 'utf8'))
  if (!Array.isArray(fixture.turns) || fixture.turns.length === 0) {
    throw new Error(`fixture ${fixture.name ?? ref} has no turns`)
  }
  for (const t of fixture.turns) {
    if (!t.turnId || !Array.isArray(t.events)) throw new Error(`fixture turn missing turnId/events`)
  }
  return fixture
}

/** Full assistant text of a turn = concatenation of its delta chunks. */
export function fullTextForTurn(turn) {
  return turn.events.filter((e) => typeof e.delta === 'string').map((e) => e.delta).join('')
}

/** Highest numeric SSE id stamped on any event of the turn. */
export function maxEventId(turn) {
  return Math.max(0, ...turn.events.map((e) => (typeof e.id === 'number' ? e.id : 0)))
}

/** Render one fixture event as its exact SSE frame string. */
export function renderEvent(e) {
  if (typeof e.raw === 'string') return e.raw
  if (typeof e.delta === 'string') {
    return `id: ${e.id}\ndata: ${JSON.stringify({ choices: [{ delta: { content: e.delta } }] })}\n\n`
  }
  if (e.tool) {
    const payload = { tool: e.tool.tool }
    if (e.tool.label != null) payload.label = e.tool.label
    if (e.tool.emoji != null) payload.emoji = e.tool.emoji
    return `id: ${e.id}\nevent: hermes.tool.progress\ndata: ${JSON.stringify(payload)}\n\n`
  }
  if (e.done) return 'data: [DONE]\n\n'
  throw new Error(`unrenderable fixture event: ${JSON.stringify(e)}`)
}

/** All frames of a turn, in order — last entry is the [DONE] frame. */
export function sseFramesForTurn(turn) {
  const frames = turn.events.filter((e) => !e.done).map(renderEvent)
  frames.push('data: [DONE]\n\n')
  return frames
}

const MALFORMED_FRAME = 'data: {"choices":[{"delta":{"content"\n\n'

/**
 * Create the mock server. Resolves once listening on an ephemeral 127.0.0.1 port.
 * Returns { url, port, requests, close }. `requests` records every request received:
 * { seq, method, url, path, query, lastEventId, authorization, contentType, accept, body }.
 */
export async function createMockAgentServer({
  fixture,
  dropAfterBytes,
  dropAfterMs,
  malformedAtEnd = false,
  frameDelayMs = DEFAULT_FRAME_DELAY_MS,
} = {}) {
  const fx = typeof fixture === 'string' ? loadFixture(fixture) : fixture
  if (!fx) throw new Error('createMockAgentServer: fixture (object or ref) required')

  // Mutable so tests can arm faults after server startup (setFaults below).
  const faults = { dropAfterBytes, dropAfterMs, malformedAtEnd }

  const requests = []
  let seq = 0
  let postCounter = 0
  let closed = false
  const openRes = new Set()

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'X-Hermes-Turn-Id, X-Hermes-Session-Id')
  }

  async function playTurnSse(req, res, turn) {
    openRes.add(res)
    req.on('aborted', () => openRes.delete(res))
    res.on('close', () => openRes.delete(res))

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Hermes-Turn-Id, X-Hermes-Session-Id',
      'X-Hermes-Session-Id': fx.sessionId ?? 'sess_eval_mock',
      'X-Hermes-Turn-Id': turn.turnId,
    })

    const startedAt = Date.now()
    let bytes = 0
    const write = (frame) =>
      new Promise((resolve) => {
        res.write(frame, () => resolve())
      })

    const events = turn.events.filter((e) => !e.done).map((e) => ({ e, frame: renderEvent(e) }))
    for (const { e, frame } of events) {
      if (faults.dropAfterMs && Date.now() - startedAt >= faults.dropAfterMs) {
        res.end() // graceful fault: no [DONE] -> client reattaches via /events
        return
      }
      const delay = typeof e.delayMs === 'number' ? e.delayMs : frameDelayMs
      if (delay > 0) await sleep(delay)
      await write(frame)
      bytes += Buffer.byteLength(frame)
      if (faults.dropAfterBytes != null && bytes >= faults.dropAfterBytes) {
        res.end() // frame in flight is complete and flushed before end()
        return
      }
    }
    if (faults.malformedAtEnd) await write(MALFORMED_FRAME)
    await write(renderEvent({ done: true }))
    res.end()
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    let bodyRaw = ''
    req.on('data', (c) => (bodyRaw += c))
    await new Promise((r) => req.on('end', r))

    let body = null
    try {
      body = bodyRaw ? JSON.parse(bodyRaw) : null
    } catch {
      body = null
    }

    requests.push({
      seq: ++seq,
      t: Date.now(),
      method: req.method,
      url: u.pathname + u.search,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      lastEventId: Number.parseInt(req.headers['last-event-id'] ?? '', 10) || 0,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      accept: req.headers.accept ?? null,
      body,
    })

    cors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Last-Event-Id',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }

    // Capability probe uses OPTIONS /api/chat/runs/__probe__/<action> expecting 204 — handled above.

    if (req.method === 'POST' && u.pathname === '/api/chat') {
      const idx = Math.min(postCounter, fx.turns.length - 1)
      postCounter += 1
      await playTurnSse(req, res, fx.turns[idx])
      return
    }

    const evMatch = /^\/api\/chat\/runs\/([^/]+)\/events$/.exec(u.pathname)
    if (req.method === 'GET' && evMatch) {
      const tid = decodeURIComponent(evMatch[1])
      const turn = fx.turns.find((t) => t.turnId === tid)
      if (!turn) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown turn' }))
        return
      }
      const since = Number.parseInt(req.headers['last-event-id'] ?? '', 10) || 0
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Hermes-Turn-Id, X-Hermes-Session-Id',
      })
      for (const e of turn.events) {
        if (typeof e.id !== 'number' || e.id <= since) continue
        await sleep(frameDelayMs)
        await new Promise((r) => res.write(renderEvent(e), r))
      }
      res.end(renderEvent({ done: true })) // resume always terminates cleanly
      return
    }

    if (req.method === 'GET' && u.pathname === '/api/chat/conversations') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ conversations: [], turns: [] }))
      return
    }

    if (req.method === 'GET' && u.pathname === '/api/chat/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ turn: null }))
      return
    }

    if (u.pathname === '/api/nub/desktop/roster') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ roster: null, agentsMd: [] }))
      return
    }

    // VM-fs fallback endpoints (fetchVmRosterViaFs et al.) — empty payloads are fine.
    if (u.pathname.startsWith('/api/instances/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }

    if (u.pathname.startsWith('/api/nub/') || u.pathname.startsWith('/api/chat/runs/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', path: u.pathname }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    fixture: fx,
    /** Arm/replace fault injection for subsequent POST streams (e.g. dropAfterBytes, malformedAtEnd). */
    setFaults(next = {}) {
      faults.dropAfterBytes = next.dropAfterBytes
      faults.dropAfterMs = next.dropAfterMs
      faults.malformedAtEnd = !!next.malformedAtEnd
    },
    async close() {
      if (closed) return
      closed = true
      for (const res of openRes) {
        try {
          res.end()
        } catch {}
      }
      openRes.clear()
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
