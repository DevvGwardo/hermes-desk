/**
 * Chat history over dashboard REST (hosted VMs).
 *
 * hermes routes (hermes_cli/web_routers/sessions.py):
 *   GET    /api/sessions?limit=&offset=&order=recent  → {sessions,total}
 *   GET    /api/sessions/search?q=&limit=              → {results}
 *   PATCH  /api/sessions/{id}   {title}
 *   GET    /api/sessions/{id}/export                   → session + messages JSON
 *   DELETE /api/sessions/{id}
 *
 * The local-hermes path (`hermes sessions list` table parse) stays in
 * agents/hermes-sessions.ts as the fallback when no VM is linked.
 */

import { serveGetDetailed } from './hermes-rest'
import { restFailureText } from './agent-rest'
import { mutateSession } from './session-mutation'

export interface SessionSummary {
  id: string
  title: string
  /** Raw hermes `source` (cli, telegram, cron, …). */
  source: string
  /** Plain-language label for `source`. */
  sourceLabel: string
  /** ISO timestamp of the latest activity (or start). */
  lastActive: string
  messageCount: number
  preview: string
  /** Search hit snippet (search results only). */
  snippet?: string
}

const SOURCE_LABELS: Record<string, string> = {
  cli: 'This app',
  tui: 'This app',
  api_server: 'This app',
  desktop: 'This app',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp',
  signal: 'Signal',
  matrix: 'Matrix',
  email: 'Email',
  sms: 'Text message',
  imessage: 'iMessage',
  bluebubbles: 'iMessage',
  mattermost: 'Mattermost',
  homeassistant: 'Home Assistant',
  google_chat: 'Google Chat',
  teams: 'Microsoft Teams',
  webhook: 'Webhook',
  cron: 'Routine',
  tool: 'Helper',
  vulcan_delegate: 'Helper',
  hermes_flow: 'Automation',
  acp: 'Code editor',
}

/** Plain label for a session `source` ("telegram:123" → "Telegram"). */
export function sessionSourceLabel(source: string | null | undefined): string {
  const raw = (source ?? '').trim().toLowerCase()
  if (!raw) return 'This app'
  const key = raw.split(':')[0]!
  const hit = SOURCE_LABELS[raw] ?? SOURCE_LABELS[key]
  if (hit) return hit
  return key
    .split('_')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

function toIso(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString()
  if (typeof v === 'string' && v) {
    const n = Number(v)
    if (Number.isFinite(n)) return toIso(n)
    const d = Date.parse(v)
    if (Number.isFinite(d)) return new Date(d).toISOString()
  }
  return new Date(0).toISOString()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function toSessionSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id) || str(r.session_id)
  if (!id) return null
  const source = str(r.source)
  const preview = str(r.preview).trim()
  const title = str(r.title).trim()
  return {
    id,
    title: title && title !== 'Untitled' ? title : preview.slice(0, 60) || 'Untitled chat',
    source,
    sourceLabel: sessionSourceLabel(source),
    lastActive: toIso(r.last_active ?? r.started_at ?? r.session_started),
    messageCount: typeof r.message_count === 'number' ? r.message_count : 0,
    preview,
    ...(typeof r.snippet === 'string' && r.snippet ? { snippet: r.snippet } : {}),
  }
}

export interface SessionListResult {
  ok: boolean
  sessions: SessionSummary[]
  total?: number
  error?: string
  /** True when the agent predates the sessions API. */
  needsUpdate?: boolean
}

function listFailure(status: number | undefined, message: string | undefined): SessionListResult {
  return {
    ok: false,
    sessions: [],
    error: restFailureText({ status, error: message }, 'Could not load chat history.'),
    ...(status === 404 ? { needsUpdate: true } : {}),
  }
}

export async function listSessions(opts: { limit?: number; offset?: number } = {}): Promise<SessionListResult> {
  const qs = new URLSearchParams({
    limit: String(Math.min(Math.max(opts.limit ?? 50, 1), 100)),
    offset: String(Math.max(opts.offset ?? 0, 0)),
    order: 'recent',
  })
  const res = await serveGetDetailed<{ sessions?: unknown[]; total?: number }>(`/api/sessions?${qs.toString()}`)
  if (!res.data) return listFailure(res.status ?? res.error?.status, res.error?.message)
  const sessions = (Array.isArray(res.data.sessions) ? res.data.sessions : [])
    .map(toSessionSummary)
    .filter((s): s is SessionSummary => s !== null)
  return { ok: true, sessions, total: typeof res.data.total === 'number' ? res.data.total : undefined }
}

export async function searchSessions(query: string, limit = 20): Promise<SessionListResult> {
  const q = query.trim()
  if (!q) return { ok: true, sessions: [] }
  const qs = new URLSearchParams({ q, limit: String(Math.min(Math.max(limit, 1), 100)) })
  const res = await serveGetDetailed<{ results?: unknown[] }>(`/api/sessions/search?${qs.toString()}`)
  if (!res.data) return listFailure(res.status ?? res.error?.status, res.error?.message)
  const sessions = (Array.isArray(res.data.results) ? res.data.results : [])
    .map(toSessionSummary)
    .filter((s): s is SessionSummary => s !== null)
  return { ok: true, sessions }
}

export async function renameSession(id: string, title: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  const res = await mutateSession<{ title?: string }>('PATCH', id, { title: title.trim() })
  if (!res.ok) return { ok: false, error: restFailureText(res, 'Could not rename this chat.') }
  return { ok: true, title: res.data?.title ?? title.trim() }
}

export async function deleteSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await mutateSession('DELETE', id, {})
  if (!res.ok) return { ok: false, error: restFailureText(res, 'Could not delete this chat.') }
  return { ok: true }
}

/** Safe download filename for an exported chat. */
export function exportFilename(title: string, id: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'chat'}-${id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '')}.json`
}

/** Trigger a browser download of `text` (works in Electron, web and mobile webviews). */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fetch a chat's full export and save it as a JSON file. */
export async function exportSession(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
  const res = await serveGetDetailed<unknown>(`/api/sessions/${encodeURIComponent(id)}/export`)
  if (res.data === null || res.data === undefined) {
    return {
      ok: false,
      error: restFailureText({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Could not export this chat.'),
    }
  }
  downloadText(exportFilename(title, id), JSON.stringify(res.data, null, 2))
  return { ok: true }
}

/** Sidebar "Export chat": download the hermes session behind a conversation. */
export async function exportConversationChat(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const { getState } = await import('./agents/store')
  const conv = getState().conversations.find((c) => c.id === conversationId)
  if (!conv?.hermesSessionId) return { ok: false, error: 'This chat has nothing to export yet.' }
  const res = await exportSession(conv.hermesSessionId, conv.title)
  if (!res.ok) {
    const { logger } = await import('./logger')
    logger.warn('[nub] export chat failed', res.error)
  }
  return res
}

export interface TranscriptLine {
  role: 'user' | 'assistant'
  text: string
}

function partText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      typeof p === 'string'
        ? p
        : p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
    )
    .join('')
}

/** The chat's words, oldest first: what you said and what the agent answered
 *  (tool calls and empty steps left out). The latest 200 messages. */
export function parseTranscript(data: unknown): TranscriptLine[] {
  const rows =
    data && typeof data === 'object' && Array.isArray((data as { messages?: unknown }).messages)
      ? ((data as { messages: unknown[] }).messages as unknown[])
      : []
  const out: TranscriptLine[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as { role?: unknown; content?: unknown }
    if (r.role !== 'user' && r.role !== 'assistant') continue
    const text = partText(r.content).trim()
    if (text) out.push({ role: r.role, text })
  }
  return out
}

/** Read a chat that has no conversation in this app (Telegram, a routine run…). */
export async function readSessionTranscript(
  id: string,
): Promise<{ ok: true; lines: TranscriptLine[] } | { ok: false; error: string }> {
  const res = await serveGetDetailed<unknown>(`/api/sessions/${encodeURIComponent(id)}/messages?limit=200&order=latest`)
  if (res.data == null) {
    return {
      ok: false,
      error: restFailureText({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Couldn’t open this chat.'),
    }
  }
  return { ok: true, lines: parseTranscript(res.data) }
}
