/**
 * Read-only orphan-run probe — fixture replay only, no network, no prod touch.
 *
 * Replays recorded SSE event sequences (fixtures) and classifies each turn:
 *   - "ok"                    — at least one non-empty delta.content token
 *     (mirrors hermes-stream.ts `alive = content.trim() || toolEvents.length>0`
 *     content half; tool-only turns covered via kind:"tool" counting as progress
 *     only when accompanied by tokens — pure token rule keeps this probe strict).
 *   - "role-only-no-tokens"   — ≥1 frame arrived (role chunk / error / done) but
 *     zero content tokens. 429 smell: upstream LLM 429/409 or 504 surfaces as a
 *     role chunk with no deltas (see mock-transport linkedAgentSlowReply +
 *     vm-run-control isConcurrentRunLimitError 409|429).
 *   - "headers-only-close"    — SSE headers accepted, then close with no frame
 *     at all (hermes-stream FIRST_TOKEN_MS "no first token" path).
 *
 * Fixture turn shape: { id: string, events: Array<Event> }
 *   Event kinds: headers | data { delta?: { role?, content? }, finish_reason? }
 *     | tool { tool, status } | done | error { status?, message? } | close
 *   A flat { content: "..." } on data events is also accepted.
 */

export const CLASSES = ['ok', 'role-only-no-tokens', 'headers-only-close']

function tokenCharsOf(ev) {
  if (!ev || typeof ev !== 'object') return 0
  const fromDelta =
    ev.delta && typeof ev.delta.content === 'string' ? ev.delta.content.length : 0
  const flat = typeof ev.content === 'string' ? ev.content.length : 0
  return fromDelta + flat
}

function isFrame(ev) {
  // headers/close alone mean "connected but nothing arrived".
  return !!ev && ev.kind !== 'headers' && ev.kind !== 'close'
}

export function classifyTurn(turn) {
  if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.events)) {
    throw new TypeError('malformed turn: expected { id: string, events: [] }')
  }
  const tokens = turn.events.reduce((n, ev) => n + tokenCharsOf(ev), 0)
  if (tokens > 0) return 'ok'
  return turn.events.some(isFrame) ? 'role-only-no-tokens' : 'headers-only-close'
}

export function verdictReason(turn) {
  const tokens = turn.events.reduce((n, ev) => n + tokenCharsOf(ev), 0)
  const frames = turn.events.filter(isFrame).length
  const err = turn.events.find((e) => e && e.kind === 'error')
  const fin = turn.events.find((e) => e && (e.finish_reason || e.kind === 'done'))
  if (tokens > 0)
    return `${tokens} token chars${fin ? `, finish=${fin.finish_reason || 'done'}` : ''}`
  if (frames > 0)
    return `0 tokens across ${frames} frame(s)${err ? `, err=${err.status || err.message || '?'}` : ''} — 429 smell`
  return 'headers accepted, no frame before close'
}

export function summarizeTurns(turns) {
  if (!Array.isArray(turns)) throw new TypeError('expected an array of turns')
  const counts = { ok: 0, 'role-only-no-tokens': 0, 'headers-only-close': 0 }
  for (const t of turns) counts[classifyTurn(t)] += 1
  return counts
}

/** Embedded sample fixture demonstrating all three classes. */
export const SAMPLE_FIXTURE = [
  {
    id: 't-ok',
    events: [
      { kind: 'headers' },
      { kind: 'data', delta: { role: 'assistant' } },
      { kind: 'data', delta: { content: 'hello there' } },
      { kind: 'data', delta: {}, finish_reason: 'stop' },
      { kind: 'done' },
    ],
  },
  {
    id: 't-role429',
    events: [
      { kind: 'headers' },
      { kind: 'data', delta: { role: 'assistant' } },
      { kind: 'error', status: 429, message: 'Too many concurrent runs (max 10)' },
      { kind: 'close' },
    ],
  },
  {
    id: 't-hdr',
    events: [{ kind: 'headers' }, { kind: 'close' }],
  },
]

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  let turns
  try {
    const arg = process.argv[2]
    if (!arg || arg === '--sample') {
      turns = SAMPLE_FIXTURE
    } else {
      const { readFileSync, existsSync } = await import('node:fs')
      try {
        turns = existsSync(arg)
          ? JSON.parse(readFileSync(arg, 'utf8'))
          : JSON.parse(arg)
      } catch {
        console.error('probe-orphan-runs: arg must be a JSON array, a fixture file path, or --sample')
        process.exit(1)
      }
    }
    if (!Array.isArray(turns)) throw new TypeError('fixture must be an array of turns')
    for (const t of turns) console.log(`turn ${t.id}: ${classifyTurn(t)} (${verdictReason(t)})`)
    const c = summarizeTurns(turns)
    console.log(
      `summary: ok=${c.ok} role-only-no-tokens=${c['role-only-no-tokens']} headers-only-close=${c['headers-only-close']} total=${turns.length}`,
    )
    process.exit(0)
  } catch (err) {
    console.error(`probe-orphan-runs: ${err.message}`)
    process.exit(1)
  }
}
