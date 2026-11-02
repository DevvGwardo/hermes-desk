/**
 * Hermes-agent session hydration (desktop).
 *
 * The app's conversations are ALSO real hermes-agent sessions — the chat route
 * and subagent spawns go through the local `hermes` CLI, which persists every
 * conversation in ~/.hermes/sessions.db. On boot we read `hermes sessions list`
 * back over the Electron bridge and merge any session that isn't already a
 * conversation into the sidebar, so conversations the user had survive refresh
 * (they were never lost — the app just never read them back).
 *
 * Hermes Bot Mode: the sidebar is a bot roster (one row per agent/profile),
 * never a dump of individual `hermes sessions list` rows. Worker sessions
 * bind onto subagent runs. Leftover sessions stay off the roster.
 */

import { boundHermesSessionIds, findSubagentRunForSession, getState, setState, upsertSubagent } from './store'
import type { ChatMessage, SubagentRun } from './types'
import { hydrateMessageExtras } from '../message-actions'
import { isDeletedConversation } from './tombstones'
import { serveBridgeConnection } from '../serve-bridge'

type HermesBridge = (kind: string, args: string[]) => Promise<{
  ok: boolean
  code?: number
  data?: unknown
  error?: string
}>

function getBridge(): HermesBridge | null {
  const w = window as unknown as { nubAgent?: { hermes?: HermesBridge } }
  return w.nubAgent?.hermes ?? null
}

/**
 * Transcript single-flight: concurrent transcript fetches for the same
 * session share one in-flight promise instead of stacking identical
 * requests. Shared by the selection effect (via transport.getMessages) and
 * the transports' own getMessages paths. Entries are deleted on settle, so
 * sequential refreshes still re-fetch.
 */
const transcriptInflight = new Map<string, Promise<unknown>>()

export function singleFlightTranscript<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = transcriptInflight.get(key)
  if (existing) return existing as Promise<T>
  let p: Promise<T>
  try {
    p = loader()
  } catch (err) {
    return Promise.reject(err)
  }
  transcriptInflight.set(key, p)
  const cleanup = () => {
    if (transcriptInflight.get(key) === p) transcriptInflight.delete(key)
  }
  p.then(cleanup, cleanup)
  return p
}

export interface HermesSessionRow {
  id: string
  title: string
  /** ISO timestamp: from the CLI session id (YYYYMMDD_HHMMSS_…) when present,
   *  else parsed from the table's relative "Last Active" column. */
  createdAt: string
}

/** `hermes sessions list` prints a table (no --json). Parse rows:
 *  `Title  Workspace  Last Active  ID`. Workspace may be `—`. */
export function parseSessionsTable(text: unknown): HermesSessionRow[] {
  if (typeof text !== 'string') return []
  const rows: HermesSessionRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || /^Title\b/.test(trimmed) || /^─+$/.test(trimmed)) continue
    // Split on 2+ spaces — ID is the last token, "Last Active" the one before,
    // title is everything before the workspace column. Titles may contain
    // single spaces only.
    const parts = trimmed.split(/\s{2,}/)
    if (parts.length < 4) continue
    const id = parts[parts.length - 1]!.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue
    const title = parts.slice(0, parts.length - 3).join(' ').trim() || id
    const lastActive = parts[parts.length - 2]!.trim()
    rows.push({ id, title, createdAt: rowTime(id, lastActive) })
  }
  // Table order is newest-first already; keep it stable.
  return rows
}

/** Resolve an absolute timestamp: prefer the CLI session id (encodes
 *  YYYYMMDD_HHMMSS), else parse the relative "Last Active" label. */
function rowTime(id: string, lastActive: string): string {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (m) {
    const [, y, mo, d, h, mi, s] = m
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ).toISOString()
  }
  const rel = relativeToTime(lastActive)
  return rel ? rel : new Date().toISOString()
}

/** Parse hermes' relative labels: "just now", "5m ago", "2h ago", "3d ago",
 *  "1w ago". Returns ISO or null. */
function relativeToTime(label: string): string | null {
  if (!label) return null
  const t = label.toLowerCase().trim()
  if (t === 'just now' || t === 'now') return new Date().toISOString()
  const m = t.match(/^(\d+)\s*(s|m|h|d|w)\s*ago$/)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]!
  const ms =
    unit === 's' ? n * 1000
    : unit === 'm' ? n * 60_000
    : unit === 'h' ? n * 3_600_000
    : unit === 'd' ? n * 86_400_000
    : n * 604_800_000
  return new Date(Date.now() - ms).toISOString()
}

/**
 * Hermes Bot Mode / Grok roster: a bot is a profile. Sessions are never
 * sidebar rows. Worker sessions bind onto subagent runs. At most one
 * existing agent conversation may grandfather the newest leftover session
 * as its pinned forever-chat (plugin.js `meta.chat`).
 *
 * Returns how many sidebar rows were added (always 0 — we do not dump sessions).
 */
export function absorbHermesSessionRows(rows: HermesSessionRow[]): number {
  if (rows.length === 0) return 0
  const owned = boundHermesSessionIds()
  const leftovers: HermesSessionRow[] = []
  const claims: SubagentRun[] = []

  for (const r of rows) {
    if (owned.has(r.id)) continue
    // Deleted sessions stay deleted — never re-bind as a forever-chat pin.
    if (isDeletedConversation(r.id)) continue
    const run = findSubagentRunForSession(r.id, r.title)
    if (run) {
      const next = { ...run, hermesSessionId: r.id }
      claims.push(next)
      owned.add(r.id)
      continue
    }
    // Worker sessions — never a sidebar row, even if the pill isn't bound yet.
    if (/\[maia-run:/.test(r.title)) continue
    leftovers.push(r)
  }

  for (const run of claims) {
    upsertSubagent(run)
  }

  pinNewestSessionOntoAgentChat(leftovers)
  return 0
}

/** Pin the newest leftover session onto one existing agent conversation. */
function pinNewestSessionOntoAgentChat(leftovers: HermesSessionRow[]): void {
  if (leftovers.length === 0) return
  const newest = [...leftovers].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  if (!newest) return
  const state = getState()
  const eligible = (c: (typeof state.conversations)[number]) =>
    c.target.type === 'agent' && !c.hermesSessionId && !c.hiddenFromSidebar
  const unpinned =
    state.conversations.find((c) => c.id === state.selectedConversationId && eligible(c)) ??
    state.conversations.find(eligible)
  if (!unpinned) return
  setState((prev) => ({
    conversations: prev.conversations.map((c) =>
      c.id === unpinned.id ? { ...c, hermesSessionId: newest.id } : c,
    ),
  }))
}

/** Remove persisted `hermes_*` session-dump rows (Bot Mode: sessions ≠ roster). */
export function pruneHydratedSessionDump(): number {
  const prev = getState()
  const dumpIds = new Set(prev.conversations.filter((c) => c.id.startsWith('hermes_')).map((c) => c.id))
  if (dumpIds.size === 0) return 0
  const conversations = prev.conversations.filter((c) => !dumpIds.has(c.id))
  const messagesByThreadId = { ...prev.messagesByThreadId }
  for (const id of dumpIds) delete messagesByThreadId[id]
  let selectedConversationId = prev.selectedConversationId
  if (selectedConversationId && dumpIds.has(selectedConversationId)) {
    selectedConversationId = conversations.find((c) => !c.hiddenFromSidebar)?.id ?? null
  }
  setState({ conversations, messagesByThreadId, selectedConversationId })
  return dumpIds.size
}

/**
 * Merge real hermes sessions into the conversation sidebar. Idempotent:
 * sessions already present (by hermesSessionId) or owned by a subagent run
 * are skipped. Returns the number of conversations added. No-op in a plain
 * browser (no bridge).
 */
export async function hydrateHermesSessions(): Promise<number> {
  const { getActiveTransport } = await import('./active-transport')
  const before = new Set(getState().conversations.map((c) => c.id))
  await (await getActiveTransport()).transport.listConversations()
  return getState().conversations.filter((c) => !before.has(c.id)).length
}

/** Parse a `hermes sessions export` record into chat messages. */
export interface HermesExportMessage {
  role: string
  content?: string | null
  timestamp?: number
  tool_calls?: { function?: { name?: string; arguments?: string } }[] | null
  tool_name?: string | null
  reasoning?: string | null
  id?: number | string
  row_id?: number
  display_kind?: string
  display_metadata?: unknown
}

const MACHINE_NOTICE_TITLES = new Map([
  ['process_complete', 'Background process update'],
  ['async_delegation_complete', 'Subagent task update'],
])

function machineNoticeTitle(metadata: unknown, fallback: string): string {
  let value = metadata
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = null }
  }
  const title = value && typeof value === 'object' && !Array.isArray(value) && 'display_text' in value
    ? value.display_text : null
  return typeof title === 'string' && title.trim() ? title.trim() : fallback
}

export function parseTranscriptMessages(
  sessionId: string,
  text: unknown,
): ChatMessage[] {
  if (typeof text !== 'string') return []
  let record: { messages?: HermesExportMessage[] }
  try {
    record = JSON.parse(text) as { messages?: HermesExportMessage[] }
  } catch {
    return []
  }
  const list = Array.isArray(record.messages) ? record.messages : []
  return list
    // Skip tool-result blobs — grok parks tools in the activity line +
    // Full conversation outline, never the raw output dumped inline.
    .filter((m) => m && typeof m === 'object' && typeof m.role === 'string' && m.role !== 'tool' && m.display_kind !== 'hidden')
    .filter((m) => {
      if (m.role === 'user') return true
      if (m.role !== 'assistant') return false
      if (typeof m.content === 'string' && m.content.length > 0) return true
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true
      return typeof m.reasoning === 'string' && m.reasoning.trim().length > 0
    })
    .map((m, i) => {
      const ts = typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : new Date().toISOString()
      const extras = hydrateMessageExtras(typeof m.content === 'string' ? m.content : '', {
        id: m.row_id ?? m.id,
        displayMetadata: m.display_metadata,
      })
      const base: ChatMessage = {
        id: `hermes_${sessionId}_${m.id ?? i}`,
        threadId: '',
        role: m.role === 'user' ? 'user' : 'agent',
        createdAt: ts,
        ...extras,
      }
      // The model's user role is not authorship. Keep provider context untouched;
      // only backend-typed completion rows become display-only system notices.
      const noticeTitle = m.role === 'user' ? MACHINE_NOTICE_TITLES.get(m.display_kind ?? '') : undefined
      if (noticeTitle) {
        base.role = 'system'
        base.content = machineNoticeTitle(m.display_metadata, noticeTitle)
        base.noticeDetails = typeof m.content === 'string' ? m.content : ''
      }
      // Surface tool calls for the activity line + Full conversation outline.
      const tools = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (tools.length > 0) {
        base.toolEvents = tools
          .filter((t) => t?.function?.name)
          .map((t) => {
            const name = t.function!.name!
            const args = t.function?.arguments
            return {
              tool: name,
              label: name,
              status: 'completed' as const,
              summary: typeof args === 'string' && args.trim() ? args.slice(0, 240) : undefined,
            }
          })
      } else if (m.tool_name) {
        base.toolEvents = [{ tool: m.tool_name, label: m.tool_name, status: 'completed' as const }]
      }
      if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
        base.reasoning = m.reasoning
      }
      return base
    })
}

/**
 * Fetch a Hermes session transcript without writing it into a conversation
 * thread. Used by the subagent side_chat window.
 */
export async function fetchHermesSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const serve = await tryServeTranscriptMessages(sessionId, '')
  if (serve && serve.length > 0) return serve

  const bridge = getBridge()
  if (!bridge) return []
  const res = await bridge('sessions', ['export', '--session-id', sessionId, '--format', 'jsonl', '-'])
  if (!res.ok || typeof res.data !== 'string') return []
  return parseTranscriptMessages(sessionId, res.data)
}

/** Main-chat history uses the same profile-scoped transport as sending. */
export async function loadHermesTranscript(conversationId: string): Promise<number> {
  const { getActiveTransport } = await import('./active-transport')
  return (await (await getActiveTransport()).transport.getMessages(conversationId)).length
}

/** Serve REST transcript fetch; empty when serve is unavailable. */
async function tryServeTranscriptMessages(
  sessionId: string,
  conversationId: string,
): Promise<ChatMessage[] | null> {
  return singleFlightTranscript(`serve-transcript:${sessionId}`, async () => {
  // Main attaches the session token (serve-bridge.ts) — none is held here.
  const conn = await serveBridgeConnection()
  if (!conn) return null
  try {
    const res = await fetch(
      `${conn.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&order=latest`,
      { credentials: 'omit' },
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      messages?: (HermesExportMessage & { created_at?: string | number })[]
    }
    const list = Array.isArray(data.messages) ? data.messages : []
    const messages = parseTranscriptMessages(sessionId, JSON.stringify({
      messages: list.filter(m => m && typeof m === 'object').map(m => ({
        ...m, timestamp: typeof m.created_at === 'number' ? m.created_at : m.timestamp,
      })),
    })).map(message => ({ ...message, threadId: conversationId }))
    return messages.length > 0 ? messages : null
    } catch {
      return null
    }
  })
}