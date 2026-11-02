/** Profile-scoped transcript parsing and paging. Live rows keep ownership. */
import type { ChatMessage, Conversation } from './types'
import { toolEventFromPayload, toolResultStatus } from './hermes-transport'
import { parseTranscriptMessages, singleFlightTranscript, type HermesExportMessage } from './hermes-sessions'
import { getConversation, getMessagesForConversation, getHydrateStatus, getState, setState, setHistoryPaging } from './store'
import { capGenUiEvents, isSuccessfulGenUiStatus, isRenderUiTool } from '../genui'
import { serveBridgeConnection } from '../serve-bridge'

const PAGE_SIZE = 50

export interface LocalHistoryRow extends HermesExportMessage {
  text?: string
  display_kind?: string
  tool_call_id?: string
  tool_id?: string
  result?: unknown
  duration_s?: number
  summary?: string
  status?: string
  name?: string
  args?: Record<string, unknown>
  active?: boolean | number
  tool_calls?: (NonNullable<HermesExportMessage['tool_calls']>[number] & { id?: string; type?: string })[] | null
}

/** Deferred local batches are persisted as one tool_call per actual dispatch. */
function historyRenderTool(name: string | null | undefined, args?: unknown): string | undefined {
  if (name && isRenderUiTool(name)) return name
  if (name !== 'tool_call') return undefined
  if (typeof args === 'string') {
    if (args.length > 64 * 1024) return undefined
    try { args = JSON.parse(args) } catch { return undefined }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const entry = record.calls === undefined ? record
    : Array.isArray(record.calls) && record.calls.length === 1 ? record.calls[0] : undefined
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const target = (entry as Record<string, unknown>).name
  return typeof target === 'string' && isRenderUiTool(target) ? target : undefined
}

/**
 * New Hermes display projections omit tool results and assistant call rows.
 * Preserve their human-facing text/order; supplement render rows only when the
 * backend's raw export proves a successful pair under the SAME durable prompt.
 */
export function restoreProjectedGenUi(projected: LocalHistoryRow[], raw: LocalHistoryRow[]): LocalHistoryRow[] {
  const completedByPrompt = new Map<string, NonNullable<ChatMessage['toolEvents']>>()
  let section: LocalHistoryRow[] = [], promptId: string | undefined
  const finish = () => {
    if (promptId) completedByPrompt.set(promptId, localHistoryMessages('raw', 'raw', 'raw', section)
      .flatMap(message => message.toolEvents ?? []).filter(event => event.genui))
  }
  for (const row of raw.slice(0, 20_000)) {
    if (!row || typeof row !== 'object' || row.active === false || row.active === 0) continue
    if (row.role === 'user') {
      finish()
      section = []
      const id = row.row_id ?? row.id
      promptId = id === undefined ? undefined : String(id)
    }
    section.push(row)
  }
  finish()
  const out: LocalHistoryRow[] = []
  let available: NonNullable<ChatMessage['toolEvents']> = []
  let projectedPromptId: string | undefined
  for (const row of projected) {
    if (row.role === 'user') {
      projectedPromptId = String(row.row_id ?? row.id)
      available = completedByPrompt.get(projectedPromptId) ?? []
    }
    const name = historyRenderTool(row.name ?? row.tool_name, row.args)
    const deferredWithoutArgs = (row.name ?? row.tool_name) === 'tool_call' && row.args == null
    const event = row.role === 'tool' && (name || deferredWithoutArgs) && row.tool_call_id
      ? available.find(event => event.toolCallId === row.tool_call_id && (!name || event.tool === name)) : undefined
    if (event?.genui) {
      out.push({ role: 'assistant', id: `genui:${projectedPromptId}:${event.toolCallId}`, timestamp: row.timestamp, tool_calls: [{
        id: event.toolCallId, function: { name: event.tool },
      }] })
      out.push({ ...row, name: event.tool, result: { genui: event.genui, ...(event.genuiOccurrence ? { genuiOccurrence: event.genuiOccurrence } : {}) }, status: 'completed' })
    } else out.push(row)
  }
  return out
}

const MAX_RAW_HISTORY_BYTES = 8 * 1024 * 1024
async function rawGenUiHistory(storedId: string, profile: string): Promise<LocalHistoryRow[]> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) || !storedId || storedId.length > 256) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const connection = await serveBridgeConnection()
    if (!connection) return []
    // Already allowlisted read-only route. Main attaches auth; never expose a token.
    const response = await fetch(`${connection.baseUrl}/api/sessions/${encodeURIComponent(storedId)}/export?profile=${encodeURIComponent(profile)}`,
      { credentials: 'omit', signal: controller.signal })
    if (!response.ok) return []
    let text: string
    if (response.body) {
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_RAW_HISTORY_BYTES) { await reader.cancel(); return [] }
        chunks.push(value)
      }
      const buffer = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
      text = new TextDecoder().decode(buffer)
    } else text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RAW_HISTORY_BYTES) return []
    const record = JSON.parse(text) as { messages?: LocalHistoryRow[] }
    return Array.isArray(record.messages) ? record.messages : []
  } catch { return [] }
  finally { clearTimeout(timer) }
}

function storedRenderResult(raw: unknown, name: string): unknown {
  if (!isRenderUiTool(name) || typeof raw !== 'string' || raw.length > 64 * 1024) return raw
  const wrapper = /^<untrusted_tool_result source="([^"\n]+)">\n[^\n]*\n\n(\{[^\n]*\})\n<\/untrusted_tool_result>$/.exec(raw)
  if (!wrapper || wrapper[1] !== name) return raw
  try { return JSON.parse(wrapper[2]!) } catch { return raw }
}

/** Group the raw history before paging so intermediate tool calls never become empty turns. */
export function localHistoryMessages(storedId: string, threadId: string, profile: string, rows: LocalHistoryRow[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  let turn: ChatMessage | undefined
  for (const [index, row] of rows.entries()) {
    if (row.display_kind === 'hidden') continue
    if (row.role === 'user') turn = undefined
    if (row.role === 'tool') {
      if (!turn) continue
      const tools = turn.toolEvents ?? []
      const id = row.tool_call_id ?? row.tool_id
      const at = id ? tools.findIndex(tool => tool.toolCallId === id)
        : tools.findIndex(tool => !isRenderUiTool(tool.tool) && tool.tool === row.tool_name && tool.result === undefined)
      if (at < 0) continue
      const result = storedRenderResult(row.result ?? row.text ?? row.content, tools[at]!.tool)
      tools[at] = toolEventFromPayload({
        name: tools[at]!.tool, tool_id: tools[at]!.toolCallId, result,
        duration_s: row.duration_s, summary: row.summary,
      }, toolResultStatus(row) === 'failed' ? 'failed' : toolResultStatus(result), tools[at])
      if (!isSuccessfulGenUiStatus(row.status)) {
        tools[at]!.genui = undefined
        tools[at]!.genuiOccurrence = undefined
      }
      turn.toolEvents = capGenUiEvents(tools)
      continue
    }
    const parsed = parseTranscriptMessages(storedId, JSON.stringify({ messages: [{
      ...row, id: row.row_id ?? row.id ?? index, content: row.text ?? row.content,
    }] }))[0]
    if (!parsed) continue
    parsed.threadId = threadId
    parsed.fromAgentId = `profile:${profile}`
    if (row.role !== 'assistant') { messages.push(parsed); continue }
    const explicitTurn = row.display_metadata && typeof row.display_metadata === 'object' && 'turn_id' in row.display_metadata
      && typeof row.display_metadata.turn_id === 'string' ? row.display_metadata.turn_id : parsed.turnId
    if (!turn) {
      turn = { ...parsed, content: '', reasoning: undefined, toolEvents: [], turnId: explicitTurn ?? `history:${row.row_id ?? row.id ?? index}` }
      messages.push(turn)
    }
    if (parsed.content) turn.content += (turn.content ? '\n\n' : '') + parsed.content
    if (parsed.reasoning) turn.reasoning = (turn.reasoning ? turn.reasoning + '\n' : '') + parsed.reasoning
    // Keep the final row id for reaction/branch cutoffs, but the first row's stable key.
    if (parsed.hermesRowId !== undefined) turn.hermesRowId = parsed.hermesRowId
    for (const [toolIndex, call] of (row.tool_calls ?? []).entries()) {
      if (!call.function?.name) continue
      const name = historyRenderTool(call.function.name, call.function.arguments) ?? call.function.name
      if (isRenderUiTool(name) && call.id &&
          turn.toolEvents!.some(tool => tool.toolCallId === call.id && tool.tool === name)) continue
      turn.toolEvents!.push(toolEventFromPayload({
        name, tool_id: call.id ?? `history:${index}:${toolIndex}`,
        args_text: call.function.arguments,
      }, 'completed'))
    }
    if (row.status === 'error') turn.error = true
  }
  return messages.filter(message => message.role !== 'agent' || message.content.trim() || message.reasoning || message.toolEvents?.length)
}


interface HistoryIO {
  bind(conversation: Conversation): Promise<{ profile: string; storedId: string; runtimeId: string }>
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  capture?(conversation: Conversation): { key: string; current: () => boolean }
}

export class LocalHistory {
  private io: HistoryIO
  private visibleHistoryCount = new Map<string, number>()
  constructor(io: HistoryIO) { this.io = io }

  private requireConversation(id: string): Conversation {
    const conversation = getConversation(id)
    if (!conversation) throw new Error('Conversation no longer exists')
    return conversation
  }

  private async read(
    conversationId: string, outerCurrent: () => boolean = () => true, captureCurrent?: (current: () => boolean) => void,
  ): Promise<{ messages: ChatMessage[]; current: () => boolean }> {
    const conversation = getState().conversations.find((c) => c.id === conversationId)
    if (!conversation?.hermesSessionId) return { messages: getMessagesForConversation(conversationId), current: outerCurrent }
    const binding = await this.io.bind(conversation)
    const owner = this.io.capture?.(this.requireConversation(conversationId))
    const current = () => outerCurrent() && (!owner || owner.current())
    captureCurrent?.(current)
    if (!current()) throw new Error('History ownership changed')
    // CONTRACT: session.history has no limit/before. Page the full response locally.
    const messages = await singleFlightTranscript(`local-history:${binding.profile}:${binding.storedId}:${conversationId}:${owner?.key ?? ''}`, async () => {
      const result = await this.io.request<{ messages: LocalHistoryRow[] }>(
        'session.history', { session_id: binding.runtimeId, profile: binding.profile },
      )
      this.requireConversation(conversationId)
      if (!current()) throw new Error('History ownership changed')
      let rows = result.messages
      if (rows.some(row => row.role === 'tool' &&
          (historyRenderTool(row.name ?? row.tool_name, row.args) ||
            (row.name ?? row.tool_name) === 'tool_call' && row.args == null) &&
          row.result === undefined && row.content === undefined && row.text === undefined)) {
        const raw = await rawGenUiHistory(binding.storedId, binding.profile)
        this.requireConversation(conversationId)
        if (!current()) throw new Error('History ownership changed')
        rows = restoreProjectedGenUi(rows, raw)
      }
      return localHistoryMessages(binding.storedId, conversationId, binding.profile, rows)
    })
    return { messages, current }
  }

  async getMessages(
    conversationId: string, current: () => boolean = () => true, published?: (messages: ChatMessage[]) => void,
  ): Promise<ChatMessage[]> {
    if (!getConversation(conversationId)) return []
    const cached = getMessagesForConversation(conversationId)
    if (cached.some((message) => message.streaming || message.pending)) return cached
    try {
      const read = await this.read(conversationId, current)
      if (!getConversation(conversationId)) return []
      if (!read.current()) return getMessagesForConversation(conversationId)
      const all = read.messages
      if (getMessagesForConversation(conversationId).some((m) => m.streaming || m.pending)) return getMessagesForConversation(conversationId)
      const count = this.visibleHistoryCount.get(conversationId) ?? PAGE_SIZE
      const messages = all.slice(-count)
      this.visibleHistoryCount.set(conversationId, count)
      setState((state) => ({ messagesByThreadId: { ...state.messagesByThreadId, [conversationId]: messages } }), { persist: false })
      if (!read.current()) return getMessagesForConversation(conversationId)
      setHistoryPaging(conversationId, { hasMore: all.length > count, loadingOlder: false })
      if (read.current()) published?.(messages)
      return messages
    } catch {
      return getConversation(conversationId) ? getMessagesForConversation(conversationId) : []
    }
  }

  async loadOlderMessages(conversationId: string): Promise<boolean> {
    if (!getConversation(conversationId)) return false
    const paging = getHydrateStatus().historyPaging[conversationId]
    setHistoryPaging(conversationId, { hasMore: true, loadingOlder: true })
    let owns = this.io.capture?.(this.requireConversation(conversationId)).current ?? (() => !!getConversation(conversationId))
    try {
      const read = await this.read(conversationId, undefined, owner => { owns = owner })
      if (!getConversation(conversationId)) return false
      if (!read.current()) return false
      const all = read.messages
      const current = this.visibleHistoryCount.get(conversationId) ?? PAGE_SIZE
      const count = current + PAGE_SIZE
      const latest = getMessagesForConversation(conversationId)
      let messages = all.slice(-count)
      if (latest.some((message) => message.streaming || message.pending)) {
        // Only prepend history while a live turn owns the current transcript.
        const anchor = messages.findIndex((message) => message.id === latest[0]?.id)
        if (anchor <= 0) {
          setHistoryPaging(conversationId, { hasMore: paging?.hasMore ?? false, loadingOlder: false })
          return false
        }
        messages = [...messages.slice(0, anchor), ...latest]
      }
      this.visibleHistoryCount.set(conversationId, count)
      setState((state) => ({ messagesByThreadId: { ...state.messagesByThreadId, [conversationId]: messages } }), { persist: false })
      if (!read.current()) return false
      setHistoryPaging(conversationId, { hasMore: all.length > count, loadingOlder: false })
      return messages.length > latest.length
    } catch {
      if (owns() && getConversation(conversationId)) setHistoryPaging(conversationId, { hasMore: true, loadingOlder: false })
      return false
    }
  }

}
