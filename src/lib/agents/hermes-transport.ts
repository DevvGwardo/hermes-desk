/**
 * HermesServeTransport — primary AgentTransport (Hermes-native parity).
 *
 * Talks to `hermes serve` (JSON-RPC/WS) for:
 *   - listAgents()      → Hermes profiles (via session.list profile info + agent roster)
 *   - listConversations() → Hermes sessions (session.list)
 *   - getMessages()     → live session transcript (session.resume / REST messages)
 *   - sendMessage()     → session.create + prompt.submit with streamed deltas +
 *                         tool events + session continuity
 *   - subscribe()       → WS event fan-out (message.delta, tool.start/complete,
 *                         session.info, status updates)
 *
 * May use an explicitly configured local API (SSE) path. An unavailable
 * backend reports failure, never a demo reply or a fabricated worker result.
 */

/** Local `hermes serve` runs tools on this Mac. */
export const TOOL_ACTIVITY_WHERE = 'mac' as const

import type { AgentTransport, SendMessageOptions, TransportEvent } from './transport'
import {
  applyLocalReaction,
  applyReaction,
  areMessageReactionsEnabled,
  mergePreservedReactions,
  submitTextForReply,
} from '../message-actions'
import {
  HermesServeClient,
  probeServe,
  resolveServeConnection,
  serveCreateSession,
  serveListSessions,
  servePromptSubmit,
  serveApprovalRespond,
  serveInterrupt,
  serveSubagentInterrupt,
  serveSubagentSteer,
  serveDelegationStatus,
  serveMessageReact,
  serveSetMessageReactions,
  serveSecretRespond,
  serveClarifyRespond,
  serveMcpSetupRespond,
  type ServeRespondResult,
  serveReloadMcp,
  type ServeConnection,
  type ServeEvent,
  type ServeMessageComplete,
  type ServeMessageDelta,
  type ServeSessionRow,
  type ServeToolEvent,
  type ServeApprovalRequest,
  type ServeSessionInfo,
} from '../hermes-serve'
import { streamChatCompletion, upsertToolProgress, type ToolProgressEvent } from '../hermes-stream'
import type {
  Agent,
  ChatMessage,
  Conversation,
  Group,
  NewAgentProfile,
  SubagentKind,
  SubagentRun,
  ToolPermissionChoice,
  Turn,
} from './types'
import {
  appendMessageContent,
  appendMessage,
  appendSubagentMessage,
  autoTitleConversation,
  findSubagentRunForSession,
  flushMessagePatches,
  getMessagesForConversation,
  getState,
  patchMessage,
  setState,
  syncSubagentMessage,
  touchConversation,
  upsertSubagent,
  upsertTurn,
} from './store'
import { spawnSubagent as spawnReal, taggedSpawnGoal } from '../spawn'
import { pollSubagent } from '../subagent-status'
import { absorbHermesSessionRows, singleFlightTranscript } from './hermes-sessions'
import { hasInlineImagePlaceholder } from './persist'
import { logger } from '../logger'
import { groupAutoName } from './rooms'
import { clearPendingToolPermission, getPendingToolPermission, getPendingToolPermissions, parseApprovalOptions, setPendingToolPermission, setApprovalMode, parseApprovalMode, shouldPromptToolPermission, isHighStakesApproval, choicesForApprovalRisk } from './tool-permission'
import type { ApprovalRisk } from './types'
import { promptWithPeerRoster } from '../peer-roster'
import { isDelegateTaskTool, delegateToolFailed } from '../delegate-task'
import {
  applyBrowserProgressEvent,
  applySubagentGatewayEvent,
  conversationHasLiveDelegates,
  failDelegateRuns,
  materializeDelegateRuns,
  parseToolArgs,
  settleOrphanDelegates,
  shouldFinishAfterLeavingActive,
  usableDelegateSummary,
} from '../delegate-apply'
import { isPlaceholderResult } from '../subagent-result'
import { syncDesktopAgentToHermes } from '../hermes-agents'
import { hudSurface, isHudWindow } from '../hud'
import { withHudMarkerNote } from '../hud-protocol'
import {
  PromptGoneError,
  agentPromptsFor,
  answerClarifyWithText,
  clarifyAnswerRecord,
  clearAgentPrompt,
  clearAgentPromptsForConversation,
  parseClarifyRequest,
  parseMcpSetupRequest,
  parseSecretRequest,
  setAgentPrompt,
  type AgentPrompt,
  type AgentPromptAnswer,
} from './agent-prompts'
import { answerAtFor } from './answer-placement'
import { withAttachmentNote } from '../attachment-note'
import { genUiResultFromResult, isSuccessfulGenUiStatus, isRenderUiTool, capGenUiEvents } from '../genui'

/**
 * Prime a model-bound prompt with the Clicky marker grammar
 * ([POINT:] / [TYPE:] / [CLICK:]) — HUD turns only.
 *
 * That grammar is meant to arrive from the server as `hud_surface_note`
 * (see src/lib/hud.ts) and it does not teach the markers yet, so the client
 * teaches them: prepended to the prompt on the same channel the peer roster
 * already uses, so the model sees the note and the bubble the user reads does
 * not. Gated on this window actually BEING the HUD — the same session can be
 * driven from the main window on one turn and the cat on the next, and a
 * desktop-pet grammar is nonsense in a normal conversation.
 *
 * Subagent goals are deliberately NOT primed (see the two other
 * `surface: hudSurface()` call sites): the note tells the reader it IS the
 * cat, and a background worker is not.
 */
export function hudPrimedText(text: string): string {
  return isHudWindow() ? withHudMarkerNote(text) : text
}

export interface HermesServeTransportOptions {
  /** Serve base URL. When omitted, resolved via the Electron bridge/env. */
  baseUrl?: string
  token?: string
  /** Serve HTTP base (defaults to baseUrl) used for REST fallbacks. */
  httpBase?: string
  /** api_server SSE URL — used as the mid-tier fallback. */
  apiUrl?: string
}

export type HermesToolEvent = NonNullable<ChatMessage['toolEvents']>[number] & {
  durationMs?: number
  exitCode?: number
  labels?: { text?: string; label?: string }[]
}

/** Hermes success envelopes often contain error:null. Exit codes are detail, not transport failure. */
export function toolResultStatus(result: unknown): 'completed' | 'failed' {
  if (typeof result === 'string') {
    try { return toolResultStatus(JSON.parse(result)) } catch { return 'completed' }
  }
  if (!result || typeof result !== 'object') return 'completed'
  const value = result as Record<string, unknown>
  const error = value.error
  return value.is_error === true || value.isError === true ||
    (typeof error === 'string' && !!error.trim()) ||
    (error !== null && typeof error === 'object' && Object.keys(error).length > 0) ||
    ['error', 'failed', 'failure', 'cancelled', 'interrupted'].includes(String(value.status ?? '').toLowerCase())
    ? 'failed' : 'completed'
}

export function toolEventFromPayload(
  payload: ServeToolEvent,
  status: HermesToolEvent['status'],
  previous?: HermesToolEvent,
): HermesToolEvent {
  const extra = payload as ServeToolEvent & { labels?: HermesToolEvent['labels']; result_text?: string; status?: unknown }
  let result = payload.result
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { /* Plain tool output. */ }
  }
  const exitCode = result && typeof result === 'object' ? (result as { exit_code?: unknown }).exit_code : undefined
  const generated = isRenderUiTool(payload.name) && status === 'completed' &&
    toolResultStatus(payload) === 'completed' && isSuccessfulGenUiStatus(extra.status)
    ? genUiResultFromResult(payload.result) : null
  return {
    ...previous, tool: payload.name, label: previous?.label ?? payload.name,
    toolCallId: payload.tool_id ?? previous?.toolCallId, status,
    ...(payload.args ? { args: safeJson(payload.args) } : payload.args_text ? { args: payload.args_text.slice(0, 300) } : {}),
    genui: generated?.genui,
    genuiOccurrence: generated?.genuiOccurrence,
    ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
    ...(payload.result !== undefined ? { result: typeof payload.result === 'string' ? payload.result.slice(0, 400) : safeJson(payload.result)?.slice(0, 400) } : {}),
    ...(extra.labels ? { labels: extra.labels } : {}),
    ...(typeof payload.duration_s === 'number' && Number.isFinite(payload.duration_s) && payload.duration_s >= 0
      ? { durationMs: payload.duration_s * 1000 } : {}),
    ...(typeof exitCode === 'number' && Number.isInteger(exitCode) ? { exitCode } : {}),
  }
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** Abort a serve turn that has gone silent (no WS events) this long. */
const STREAM_IDLE_MS = 120_000
/** A tool reported as running still ends the turn after this long with no events at all. */
const STREAM_TOOL_QUIET_CEILING_MS = 30 * 60_000

/** Compact JSON stringify for tool args (stable, truncates long payloads). */
function safeJson(v: Record<string, unknown> | unknown): string | undefined {
  try {
    const s = JSON.stringify(v)
    if (!s) return undefined
    return s.length > 300 ? `${s.slice(0, 300)}…` : s
  } catch {
    return undefined
  }
}

/**
 * FIX (double-render of streamed replies):
 * The serve backend emits `message.complete` with the FULL final text. The
 * delta path already grew the bubble token-by-token, so replacing `content`
 * with the full text would duplicate the reply. Instead:
 *   - if the streamed content already ends with the final text → just seal it
 *   - if the final text is a suffix of the streamed content → trim the overlap
 *   - if the final text is strictly longer (rare: deltas dropped) → replace
 * The delta-appended content is authoritative; message.complete only seals
 * `streaming:false` and fills in gaps.
 */
function finalizeStreamedContent(streamed: string, finalText: string | undefined): string {
  if (!finalText) return streamed
  const trimmed = finalText.trim()
  if (!trimmed) return streamed
  // Identical or already fully present — nothing to do.
  if (streamed === trimmed || streamed.endsWith(trimmed)) return streamed
  // Final text extends beyond what streamed in (dropped deltas) — keep final.
  if (trimmed.startsWith(streamed)) return trimmed
  // Partial overlap: strip the already-streamed prefix from the final text
  // and keep only the tail we haven't shown yet.
  let overlap = 0
  const maxOverlap = Math.min(streamed.length, trimmed.length)
  for (let i = 1; i <= maxOverlap; i++) {
    if (streamed.endsWith(trimmed.slice(0, i))) overlap = i
  }
  if (overlap > 0) return streamed + trimmed.slice(overlap)
  // No overlap at all (shouldn't happen for a same-turn reply) — prefer the
  // streamed text, which is what the user actually watched arrive.
  return streamed
}

export class HermesServeTransport implements AgentTransport {
  private client: HermesServeClient | null = null
  private conn: ServeConnection | null = null
  private httpBase = ''
  private apiUrl: string | null = null
  private listeners = new Set<(ev: TransportEvent) => void>()
  private sessionIdByConversation = new Map<string, string>()
  protected streamingByConversation = new Map<string, boolean>()
  /** Idle watchdog so a missing `message.complete` cannot leave streaming:true forever. */
  private streamWatch = new Map<
    string,
    { timer: number; replyId: string; sessionId?: string; quietSince: number }
  >()
  /** Accumulated assistant text for side-chat sessions (not parent conversations). */
  private childTextByRun = new Map<string, string>()
  /** Run ids whose child transcript the aggregate poller refreshes. */
  private childPollers = new Set<string>()
  /** Run ids registered for delegate status tracking (owned by the aggregate poller). */
  private delegatePollers = new Set<string>()
  private seenDelegateActive = new Set<string>()
  /**
   * Per-conversation aggregate delegate pollers (conversation ids with a
   * live tick). One poller per conversation issues a single
   * delegation.status + one transcript refresh pass per tick for ALL live
   * runs in that conversation — replacing the old per-run timers that each
   * fired their own status call every 2.5s.
   */
  private aggregateDelegatePollers = new Set<string>()

  constructor(opts: HermesServeTransportOptions = {}) {
    if (opts.baseUrl && opts.token) {
      this.conn = { baseUrl: opts.baseUrl.replace(/\/+$/, ''), token: opts.token }
      this.httpBase = (opts.httpBase ?? opts.baseUrl).replace(/\/+$/, '')
    }
    if (opts.apiUrl) this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
  }

  /** True when a serve endpoint is configured AND reachable. */
  static async isAvailable(): Promise<boolean> {
    const conn = await resolveServeConnection()
    if (!conn) return false
    return probeServe(conn.baseUrl)
  }

  protected emit(ev: TransportEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(ev)
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  protected async ensureClient(): Promise<HermesServeClient> {
    if (this.client) return this.client
    if (!this.conn) {
      this.conn = await resolveServeConnection()
      if (!this.conn) throw new Error('hermes serve not configured (set token via desktop bridge or env)')
      this.httpBase = this.conn.baseUrl
    }
    const client = new HermesServeClient({
      baseUrl: this.conn.baseUrl,
      token: this.conn.token,
    })
    await client.connect()
    client.onAny((ev: ServeEvent) => this.handleServeEvent(ev))
    this.client = client
    if (areMessageReactionsEnabled()) {
      void serveSetMessageReactions(client, true).catch(() => {
        /* older serve without config.set / display.message_reactions */
      })
    }
    return client
  }

  private emitSubagent(run: SubagentRun): void {
    this.emit({ type: 'subagent', run })
    if (!run.conversationId) return
    const msg = getMessagesForConversation(run.conversationId).find(
      (m) => m.subagentRunId === run.id,
    )
    if (msg) this.emit({ type: 'message', conversationId: run.conversationId, message: msg })
  }

  /** Close SSE-only delegate pills (no hermesSessionId). Bound children keep running. */
  private emitSettledOrphans(
    conv: Conversation,
    status: 'completed' | 'failed',
    reason: string,
  ): void {
    for (const run of settleOrphanDelegates({ conversation: conv, reason, status })) {
      this.emitSubagent(run)
    }
  }

  protected handleServeEvent(ev: ServeEvent): void {
    if (ev.session_id) {
      const live = this.conversationForSession(ev.session_id)
      if (live) this.bumpStreamWatch(live.id)
    }
    if (typeof ev.type === 'string' && ev.type.startsWith('subagent.')) {
      this.applyDelegateGateway(ev)
      return
    }
    if (this.handlePromptEvent(ev)) return
    if (ev.session_id) {
      const child = findSubagentRunForSession(ev.session_id)
      if (child) {
        this.applyServeEventToSubagent(child, ev)
        return
      }
    }
    switch (ev.type) {
      case 'session.info': {
        const p = (ev.payload ?? {}) as ServeSessionInfo
        const raw = p.yolo === true ? 'yolo' : p.approval_mode
        if (raw != null && String(raw).length > 0) setApprovalMode(parseApprovalMode(raw))
        break
      }
      case 'message.reaction': {
        const p = ev.payload as
          | { row_id?: number; reactions?: ChatMessage['reactions']; role?: string }
          | undefined
        if (!p || !ev.session_id) return
        const conv = this.conversationForSession(ev.session_id)
        if (!conv) return
        const msgs = getMessagesForConversation(conv.id)
        const role = p.role === 'user' || p.role === 'assistant' ? p.role : undefined
        const hit =
          (p.row_id != null ? msgs.find((m) => m.hermesRowId === p.row_id) : undefined) ??
          (role
            ? [...msgs].reverse().find((m) => (m.role === 'user' ? 'user' : 'assistant') === role)
            : undefined)
        if (!hit) return
        patchMessage(conv.id, hit.id, {
          reactions: p.reactions ?? [],
          ...(p.row_id != null ? { hermesRowId: p.row_id } : {}),
        })
        const next = getMessagesForConversation(conv.id).find((m) => m.id === hit.id)
        if (next) this.emit({ type: 'message', conversationId: conv.id, message: next })
        break
      }
      case 'message.delta': {
        const p = ev.payload as ServeMessageDelta | undefined
        if (!p || !ev.session_id) return
        const conv = this.conversationForSession(ev.session_id)
        if (!conv) return
        const msgs = getMessagesForConversation(conv.id)
        const streaming = msgs.filter((m) => m.streaming).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).pop()
        const replyId = streaming?.id
        if (!replyId) return
        // Queued append, not read-then-replace: two deltas in one rAF must
        // not drop the first token.
        appendMessageContent(conv.id, replyId, p.text)
        const finalMsg = getMessagesForConversation(conv.id).find((m) => m.id === replyId)
        if (finalMsg) this.emit({ type: 'message', conversationId: conv.id, message: finalMsg })
        break
      }
      case 'tool.start': {
        const p = ev.payload as ServeToolEvent | undefined
        if (!p || !ev.session_id) return
        this.pushToolEvent(ev.session_id, p, 'running')
        if (isDelegateTaskTool(p.name)) this.materializeDelegateTool(ev.session_id, p)
        break
      }
      case 'tool.complete': {
        const p = ev.payload as ServeToolEvent | undefined
        if (!p || !ev.session_id) return
        // Grok parity: a tool whose result is an error envelope renders as
        // failed (x-circle icon) instead of the done wrench.
        const status = toolResultStatus(p) === 'failed' ? 'failed' : toolResultStatus(p.result)
        this.pushToolEvent(ev.session_id, p, status)
        if (isDelegateTaskTool(p.name)) this.onDelegateToolComplete(ev.session_id, p)
        break
      }
      case 'message.complete': {
        const p = ev.payload as ServeMessageComplete | undefined
        if (!p || !ev.session_id) return
        const conv = this.conversationForSession(ev.session_id)
        if (!conv) return
        const msgs = getMessagesForConversation(conv.id)
        const streaming = msgs.filter((m) => m.streaming).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).pop()
        if (streaming) {
          // FIX: don't blindly replace the streamed content with the full
          // final text — that's what duplicated replies. Dedupe instead.
          const finalContent = finalizeStreamedContent(streaming.content ?? '', p.text)
          // A failed turn (e.g. the model provider's usage limit) used to seal
          // as an empty bubble. Keep the reason so the chat can explain it.
          const failed = p.status === 'error' || p.status === 'interrupted' ||
            (typeof p.error === 'string' && !!p.error.trim())
          const failure = failed
            ? (typeof p.error === 'string' && p.error.trim()) ||
              (p.status === 'interrupted' ? 'This reply was interrupted before it finished.' : 'Your agent could not finish this reply.')
            : null
          patchMessage(conv.id, streaming.id, {
            content: finalContent || failure || '',
            streaming: false,
            error: Boolean(failed),
            errorNote: finalContent && failure ? failure : undefined,
          })
          const finalMsg = getMessagesForConversation(conv.id).find((m) => m.id === streaming.id)
          if (finalMsg) this.emit({ type: 'message', conversationId: conv.id, message: finalMsg })
          if (finalContent && !failed) autoTitleConversation(conv.id, finalContent)
        }
        this.streamingByConversation.delete(conv.id)
        this.clearStreamWatch(conv.id)
        // The turn is over — any card it raised can no longer be answered.
        clearAgentPromptsForConversation(conv.id)
        // Parent turn ending does not mean the specialist is done — Hermes
        // often replies "I'll post when it lands" while delegate_task still runs.
        this.watchLiveDelegates(conv)
        // Turn bookkeeping
        const turnId = `turn_${ev.session_id}_${Date.now().toString(36)}`
        const turn: Turn = {
          id: turnId,
          threadId: conv.id,
          agentId: conv.target.type === 'agent' ? conv.target.agentId : '',
          userMessageId: '',
          phase: p.status === 'error' || p.status === 'interrupted' ||
            (typeof p.error === 'string' && !!p.error.trim()) ? 'failed' : 'done',
          subagentRunIds: [],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }
        upsertTurn(turn)
        this.emit({ type: 'turn', turn })
        break
      }
      case 'approval.request': {
        if (!ev.session_id) return
        const conv = this.conversationForSession(ev.session_id)
        if (!conv) return
        if (!shouldPromptToolPermission()) {
          void (async () => {
            try {
              const client = await this.ensureClient()
              await serveApprovalRespond(client, { session_id: ev.session_id!, choice: 'always' })
            } catch {
              /* cube may already skip in yolo */
            }
            for (const ask of getPendingToolPermissions()) if (ask.sessionId === ev.session_id && ask.conversationId === conv.id) clearPendingToolPermission(ask.id)
            this.emit({ type: 'permission', conversationId: conv.id, ask: null })
          })()
          return
        }
        const p = (ev.payload ?? {}) as ServeApprovalRequest
        const options = parseApprovalOptions(p.options)
        const risk: ApprovalRisk = isHighStakesApproval(p.command, p.description) ? 'high-stakes' : 'standard'
        const ask = {
          id: `ask_${ev.session_id}_${Date.now().toString(36)}`,
          conversationId: conv.id,
          sessionId: ev.session_id,
          command: typeof p.command === 'string' ? p.command : undefined,
          description: typeof p.description === 'string' ? p.description : undefined,
          choices: choicesForApprovalRisk(p.choices, risk),
          risk,
          ...(options ? { options, kind: 'question' as const } : {}),
          status: 'pending' as const,
        }
        setPendingToolPermission(ask)
        this.emit({ type: 'permission', conversationId: conv.id, ask })
        break
      }
      default:
        break
    }
  }

  /**
   * Blocking in-chat prompts (`secret.request` / `clarify.request` /
   * `mcp.setup.request`) and their `.expire` twins. Handled before the
   * side-chat routing so a spawned child's question still reaches the user.
   * Returns true when the event was a prompt event.
   */
  private handlePromptEvent(ev: ServeEvent): boolean {
    const type = String(ev.type)
    if (type === 'secret.expire' || type === 'clarify.expire' || type === 'mcp.setup.expire') {
      const rid = (ev.payload as { request_id?: unknown } | undefined)?.request_id
      if (typeof rid === 'string' && rid) clearAgentPrompt(rid)
      return true
    }
    if (type !== 'secret.request' && type !== 'clarify.request' && type !== 'mcp.setup.request') {
      return false
    }
    if (!ev.session_id) return true
    const conversationId = this.promptConversationId(ev.session_id)
    if (!conversationId) return true
    const ctx = { conversationId, sessionId: ev.session_id }
    const prompt: AgentPrompt | null =
      type === 'secret.request'
        ? parseSecretRequest(ev.payload, ctx)
        : type === 'clarify.request'
          ? parseClarifyRequest(ev.payload, ctx)
          : parseMcpSetupRequest(ev.payload, ctx)
    if (!prompt) return true
    setAgentPrompt(prompt, (answer) => this.respondPrompt(prompt, answer))
    this.bumpStreamWatch(conversationId)
    return true
  }

  private promptConversationId(sessionId: string): string | null {
    const conv = this.conversationForSession(sessionId)
    if (conv) return conv.id
    const child = findSubagentRunForSession(sessionId)
    return child?.conversationId ?? null
  }

  /** Route a card's answer to the matching gateway respond RPC. Never logs the answer. */
  private async respondPrompt(prompt: AgentPrompt, answer: AgentPromptAnswer): Promise<void> {
    const client = await this.ensureClient()
    const request_id = prompt.requestId
    // The gateway answers a late respond with `expired` instead of an error:
    // the wait already ended, so nothing was delivered.
    const delivered = (res: ServeRespondResult) => {
      if (res?.status === 'expired') throw new PromptGoneError()
    }
    if (answer.kind === 'secret') {
      delivered(await serveSecretRespond(client, { request_id, value: 'skip' in answer ? '' : answer.value }))
      return
    }
    if (answer.kind === 'clarify') {
      if ('cancel' in answer || answer.answers.length === 0) {
        delivered(await serveClarifyRespond(client, { request_id, answer: '' }))
        return
      }
      // Where the reply stands now, before the answer lets it carry on.
      flushMessagePatches()
      const reply = getMessagesForConversation(prompt.conversationId)
        .filter((m) => m.role === 'agent' && m.streaming)
        .pop()
      const answerAt = reply ? answerAtFor(reply) : undefined
      for (const a of answer.answers) {
        delivered(
          await serveClarifyRespond(client, {
            request_id,
            answer: a.answer,
            ...(a.qid ? { question_id: a.qid } : {}),
          }),
        )
      }
      // Answered on the card: leave what was asked and answered in the thread
      // (the card is gone and the questions live nowhere else).
      const record = prompt.kind === 'clarify' ? clarifyAnswerRecord(prompt, answer) : null
      if (record && answerAt) {
        const row: ChatMessage = {
          id: uid('usr'),
          threadId: prompt.conversationId,
          role: 'user',
          content: record,
          createdAt: new Date().toISOString(),
          answerAt,
        }
        appendMessage(prompt.conversationId, row)
        this.emit({ type: 'message', conversationId: prompt.conversationId, message: row })
      }
      return
    }
    const ok = ['installed', 'enabled', 'authorized'].includes(answer.outcome.status)
    if (ok) {
      // Reload BEFORE unblocking the tool so the agent resumes with the new server's tools.
      await serveReloadMcp(client, prompt.sessionId).catch(() => {
        /* config landed; tools arrive next session */
      })
    }
    delivered(await serveMcpSetupRespond(client, { request_id, result: JSON.stringify(answer.outcome) }))
  }

  private applyDelegateGateway(ev: ServeEvent): void {
    if (!ev.session_id) return
    const conv = this.conversationForSession(ev.session_id)
    if (!conv) return
    const run = applySubagentGatewayEvent({
      conversation: conv,
      type: ev.type,
      payload: ev.payload,
      agents: getState().agents,
    })
    if (run) {
      this.watchDelegate(run.id)
      if (run.hermesSessionId) this.pollChildTranscript(run.id)
      this.emitSubagent(run)
    }
  }

  private materializeDelegateTool(sessionId: string, p: ServeToolEvent): void {
    const conv = this.conversationForSession(sessionId)
    if (!conv) return
    const args = parseToolArgs(p.args, p.args_text)
    const runs = materializeDelegateRuns({
      conversation: conv,
      args,
      toolCallId: p.tool_id,
      agents: getState().agents,
    })
    for (const run of runs) {
      this.watchDelegate(run.id)
      this.emitSubagent(run)
    }
    void this.refreshDelegationBindings(sessionId)
  }

  private async refreshDelegationBindings(parentSessionId: string): Promise<void> {
    try {
      const conv = this.conversationForSession(parentSessionId)
      if (!conv) return
      const status = await this.delegationSnapshot(conv.id)
      for (const row of status.active ?? []) {
        const run = applySubagentGatewayEvent({
          conversation: conv,
          type: 'subagent.start',
          payload: row,
          agents: getState().agents,
        })
        if (run) {
          this.watchDelegate(run.id)
          this.emitSubagent(run)
        }
      }
    } catch {
      /* status is best-effort */
    }
  }

  private onDelegateToolComplete(sessionId: string, p: ServeToolEvent): void {
    const conv = this.conversationForSession(sessionId)
    if (!conv) return
    const err = delegateToolFailed(p.result)
    if (!err) return
    for (const run of failDelegateRuns({ conversation: conv, toolCallId: p.tool_id, error: err })) {
      this.emitSubagent(run)
    }
  }

  private noteDelegateFromSse(conversationId: string, ev: ToolProgressEvent): void {
    const conv = getState().conversations.find((c) => c.id === conversationId)
    if (!conv) return
    const runs = materializeDelegateRuns({
      conversation: conv,
      args: { goal: ev.label || 'Delegated task' },
      toolCallId: ev.toolCallId,
      agents: getState().agents,
    })
    for (const run of runs) this.emitSubagent(run)
  }

  private noteSubagentFromSse(
    conversationId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const conv = getState().conversations.find((c) => c.id === conversationId)
    if (!conv) return
    const run = applySubagentGatewayEvent({
      conversation: conv,
      type,
      payload,
      agents: getState().agents,
    })
    if (run) this.emitSubagent(run)
  }

  private noteBrowserFromSse(
    conversationId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (type !== 'browser.progress') return
    const conv = getState().conversations.find((c) => c.id === conversationId)
    if (!conv) return
    const run = applyBrowserProgressEvent({ conversation: conv, payload })
    if (run) this.emitSubagent(run)
  }

  private pushToolEvent(sessionId: string, p: ServeToolEvent, status: 'running' | 'completed' | 'failed'): void {
    const conv = this.conversationForSession(sessionId)
    if (!conv) return
    const msgs = getMessagesForConversation(conv.id)
    const streaming = msgs.filter((m) => m.streaming).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).pop()
    if (!streaming) return
    const toolEvents = [...(streaming.toolEvents ?? [])]
    const existing = toolEvents.findIndex((t) => t.toolCallId === p.tool_id && t.tool === p.name)
    // Grok parity: capture the summary so the Full conversation outline
    // can expand unlabeled detail (no Arguments/Result labels).
    if (existing >= 0) {
      toolEvents[existing] = toolEventFromPayload(p, status, toolEvents[existing])
    } else {
      toolEvents.push(toolEventFromPayload(p, status))
    }
    patchMessage(conv.id, streaming.id, { toolEvents: capGenUiEvents(toolEvents) })
  }

  private applyServeEventToSubagent(run: SubagentRun, ev: ServeEvent): void {
    if (run.status === 'cancelled') return
    // A failed spawned helper still takes follow-ups; its next reply revives it.
    if (run.status === 'failed' && (run.source !== 'spawn' || ev.type !== 'message.delta')) return
    const now = new Date().toISOString()
    if (ev.type === 'message.delta') {
      const p = ev.payload as ServeMessageDelta | undefined
      if (!p?.text) return
      const text = (this.childTextByRun.get(run.id) ?? '') + p.text
      this.childTextByRun.set(run.id, text)
      const next: SubagentRun = {
        ...run,
        status: 'running',
        startedAt: run.startedAt ?? now,
        digests: [{ id: 'live', at: now, text }],
        ...(run.finishedAt ? { finishedAt: undefined, error: undefined } : {}),
      }
      upsertSubagent(next)
      syncSubagentMessage(next)
      this.emit({ type: 'subagent', run: next })
      return
    }
    if (ev.type === 'message.complete') {
      const p = ev.payload as ServeMessageComplete | undefined
      const text = (p?.text || this.childTextByRun.get(run.id) || '').trim()
      this.childTextByRun.delete(run.id)
      // A spawned helper's reply is its whole task: nothing else settles it
      // (no delegate watch, no completion-by-absence). A follow-up message
      // revives it through message.delta above.
      const settles = run.source === 'spawn'
      if (!text && !settles) return
      const failed = settles && (p?.status === 'error' || !!p?.error?.trim())
      const next: SubagentRun = {
        ...run,
        status: settles ? (failed ? 'failed' : 'completed') : 'running',
        startedAt: run.startedAt ?? now,
        digests: text ? [{ id: 'live', at: now, text }] : run.digests,
        ...(settles ? { finishedAt: now } : {}),
        ...(settles && text ? { result: { summary: text } } : {}),
        ...(failed ? { error: p?.error?.trim() || 'The helper could not finish.' } : {}),
      }
      upsertSubagent(next)
      syncSubagentMessage(next)
      this.emit({ type: 'subagent', run: next })
    }
  }

  /** Grok side_chat: a real Hermes session attached to the parent conversation. */
  private async spawnViaServeSideChat(
    run: SubagentRun,
    conversation: Conversation,
    goal: string,
    opts?: { label?: string; profile?: string },
  ): Promise<SubagentRun | null> {
    try {
      const client = await this.ensureClient()
      const created = await serveCreateSession(client, {
        title: taggedSpawnGoal(run.id, opts?.label || run.title),
        parent_session_id: conversation.hermesSessionId,
        source: 'subagent',
        ...(opts?.profile ? { profile: opts.profile } : {}),
        ...(opts?.label
          ? { messages: [{ role: 'system', content: `You are ${opts.label}. Do the user's task.` }] }
          : {}),
      })
      const sid = created.session_id
      if (!sid) return null
      const next: SubagentRun = {
        ...run,
        hermesSessionId: sid,
        status: 'running',
        startedAt: new Date().toISOString(),
      }
      upsertSubagent(next)
      syncSubagentMessage(next)
      this.emit({ type: 'subagent', run: next })
      await servePromptSubmit(client, { session_id: sid, text: goal, surface: hudSurface() })
      this.pollChildTranscript(next.id)
      this.watchDelegate(next.id)
      return next
    } catch {
      return null
    }
  }

  /** Backup when WS events for the child session don't land on this client. */
  private pollChildTranscript(runId: string): void {
    const run = getState().subagentsById[runId]
    if (!run?.conversationId) {
      // No conversation anchor for the aggregate poller — one direct refresh.
      void this.refreshChildTranscript(runId)
      return
    }
    this.childPollers.add(runId)
    this.ensureAggregateDelegatePoller(run.conversationId)
  }

  /** Single transcript refresh pass for one child run (no timer — the
   *  per-conversation aggregate poller drives this once per tick). */
  private async refreshChildTranscript(runId: string): Promise<void> {
    const run = getState().subagentsById[runId]
    if (!run?.hermesSessionId) {
      this.childPollers.delete(runId)
      return
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      this.childPollers.delete(runId)
      return
    }
    try {
      const msgs = await this.fetchTranscript(run.hermesSessionId)
      const last = [...msgs].reverse().find((m) => m.role === 'agent' && m.content.trim())
      if (last && last.content !== (run.digests.at(-1)?.text ?? '')) {
        const now = new Date().toISOString()
        const next: SubagentRun = {
          ...run,
          status: 'running',
          digests: [{ id: 'live', at: now, text: last.content }],
        }
        upsertSubagent(next)
        syncSubagentMessage(next)
        this.emit({ type: 'subagent', run: next })
      }
    } catch {
      /* transient */
    }
  }

  private watchLiveDelegates(conv: Conversation): void {
    for (const run of Object.values(getState().subagentsById)) {
      if (run.conversationId !== conv.id) continue
      if (run.status !== 'queued' && run.status !== 'running') continue
      this.watchDelegate(run.id)
      if (run.hermesSessionId) this.pollChildTranscript(run.id)
    }
  }

  private watchDelegate(runId: string): void {
    const run = getState().subagentsById[runId]
    if (!run?.conversationId) return
    this.delegatePollers.add(runId)
    if (run.hermesSessionId) this.childPollers.add(runId)
    this.ensureAggregateDelegatePoller(run.conversationId)
  }

  /**
   * Start the single aggregate poller for a conversation (no-op when one is
   * already ticking). Each tick performs exactly one delegation.status call
   * plus one transcript refresh pass covering every live run in the
   * conversation. Interval backs off from 2.5s to 5–10s once a delegate has
   * been seen active (steady-state long runs poll lazily).
   */
  private ensureAggregateDelegatePoller(conversationId: string): void {
    if (!conversationId || this.aggregateDelegatePollers.has(conversationId)) return
    this.aggregateDelegatePollers.add(conversationId)
    void this.tickAggregateDelegates(conversationId)
  }

  private async tickAggregateDelegates(conversationId: string): Promise<void> {
    const liveRuns = () =>
      Object.values(getState().subagentsById).filter(
        (r) =>
          r.conversationId === conversationId &&
          (r.status === 'queued' || r.status === 'running'),
      )
    try {
      const status = await this.delegationSnapshot(conversationId)
      const conv = getState().conversations.find((c) => c.id === conversationId) ?? null
      if (conv) {
        for (const run of liveRuns()) {
          const row = (status.active ?? []).find(
            (r) =>
              (run.hermesSubagentId && r.subagent_id === run.hermesSubagentId) ||
              (run.hermesSessionId && r.child_session_id === run.hermesSessionId) ||
              (!run.hermesSubagentId && r.goal && run.title && r.goal.slice(0, 48) === run.title.slice(0, 48)),
          )
          if (row) {
            this.seenDelegateActive.add(run.id)
            const next = applySubagentGatewayEvent({
              conversation: conv,
              type: 'subagent.start',
              payload: row,
              agents: getState().agents,
            })
            if (next) {
              this.emitSubagent(next)
              if (next.hermesSessionId) this.pollChildTranscript(next.id)
            }
          } else if (status.completionFromAbsence !== false &&
            shouldFinishAfterLeavingActive({
              seenActive: this.seenDelegateActive.has(run.id),
              stillActive: false,
              startedAt: run.startedAt,
              nowMs: Date.now(),
            })
          ) {
            this.finishDelegateFromPoll(run)
            this.delegatePollers.delete(run.id)
            this.childPollers.delete(run.id)
            this.seenDelegateActive.delete(run.id)
          }
        }
      }
      for (const run of liveRuns()) {
        if (run.hermesSessionId && this.childPollers.has(run.id)) {
          await this.refreshChildTranscript(run.id)
        }
      }
    } catch {
      /* status is best-effort */
    }
    // Drop terminal runs from the tracking sets so they don't pin state.
    for (const run of Object.values(getState().subagentsById)) {
      if (run.conversationId !== conversationId) continue
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        this.delegatePollers.delete(run.id)
        this.childPollers.delete(run.id)
        this.seenDelegateActive.delete(run.id)
      }
    }
    if (liveRuns().length === 0) {
      this.aggregateDelegatePollers.delete(conversationId)
      return
    }
    const settled = liveRuns().some((r) => this.seenDelegateActive.has(r.id))
    const delay = settled ? 5000 + Math.random() * 5000 : 2500
    window.setTimeout(() => {
      if (!this.aggregateDelegatePollers.has(conversationId)) return
      void this.tickAggregateDelegates(conversationId)
    }, delay)
  }

  protected async delegationSnapshot(_conversationId: string): Promise<{
    active?: { subagent_id?: string; goal?: string; status?: string; child_session_id?: string }[]
    completionFromAbsence?: boolean
  }> {
    return serveDelegationStatus(await this.ensureClient())
  }

  private finishDelegateFromPoll(run: SubagentRun): void {
    const conv = run.conversationId
      ? getState().conversations.find((c) => c.id === run.conversationId)
      : null
    if (!conv) return
    const summary = usableDelegateSummary(run)
    if (!summary || isPlaceholderResult(summary)) return
    const done = applySubagentGatewayEvent({
      conversation: conv,
      type: 'subagent.complete',
      payload: {
        subagent_id: run.hermesSubagentId,
        child_session_id: run.hermesSessionId,
        status: 'completed',
        summary,
        task_index: run.taskIndex ?? 0,
      },
      agents: getState().agents,
    })
    if (done) this.emitSubagent(done)
  }

  /** Map a hermes session id → local conversation id (tracked on create/resume). */
  protected conversationForSession(sessionId: string): Conversation | null {
    const state = getState()
    // 1. direct map (set when a session was created/resumed in this runtime)
    const mappedId = this.sessionIdByConversation.get(sessionId)
    const byMap = mappedId ? state.conversations.find((c) => c.id === mappedId) : null
    if (byMap) return byMap
    // 2. conversations carrying this session id
    const bySession = state.conversations.find((c) => c.hermesSessionId === sessionId)
    if (bySession) return bySession
    return null
  }

  protected clearStreamWatch(conversationId: string): void {
    const cur = this.streamWatch.get(conversationId)
    if (!cur) return
    window.clearTimeout(cur.timer)
    this.streamWatch.delete(conversationId)
  }

  protected armStreamWatch(conversationId: string, replyId: string, sessionId?: string, quietSince = Date.now()): void {
    this.clearStreamWatch(conversationId)
    if (!this.streamingByConversation.has(conversationId)) return
    const timer = window.setTimeout(() => this.onStreamWatchFire(conversationId), STREAM_IDLE_MS)
    this.streamWatch.set(conversationId, { timer, replyId, sessionId, quietSince })
  }

  /** Stream activity: restart the idle window. */
  protected bumpStreamWatch(conversationId: string): void {
    const cur = this.streamWatch.get(conversationId)
    if (!cur) return
    this.armStreamWatch(conversationId, cur.replyId, cur.sessionId)
  }

  /** The watchdog found a reason to keep waiting: re-arm without counting it as activity. */
  protected holdStreamWatch(conversationId: string): void {
    const cur = this.streamWatch.get(conversationId)
    if (!cur) return
    this.armStreamWatch(conversationId, cur.replyId, cur.sessionId, cur.quietSince)
  }

  protected onStreamWatchFire(conversationId: string): void {
    const pending = getPendingToolPermission(conversationId)
    if (pending?.conversationId === conversationId && pending.status === 'pending') {
      this.holdStreamWatch(conversationId)
      return
    }
    if (conversationHasLiveDelegates(conversationId)) {
      this.holdStreamWatch(conversationId)
      return
    }
    // Waiting on the user (key / question / plugin card) is not a hung turn.
    if (agentPromptsFor(conversationId).length > 0) {
      this.holdStreamWatch(conversationId)
      return
    }
    flushMessagePatches()
    const cur = this.streamWatch.get(conversationId)
    // A long tool may legitimately be quiet, but a serve that died mid-tool
    // never reports it finished: past the ceiling the turn settles.
    if (getMessagesForConversation(conversationId).some((message) =>
      message.streaming && message.toolEvents?.some((tool) => tool.status === 'running')) &&
      (!cur || Date.now() - cur.quietSince < STREAM_TOOL_QUIET_CEILING_MS)) {
      this.holdStreamWatch(conversationId)
      return
    }
    const sessionId = cur?.sessionId
    this.settleHungStream(conversationId)
    if (sessionId) {
      void this.interruptStreamWatch(conversationId, sessionId)
        .catch(() => {
          /* interrupt is best-effort */
        })
    }
  }

  protected async interruptStreamWatch(_conversationId: string, sessionId: string): Promise<void> {
    const client = await this.ensureClient()
    await serveInterrupt(client, sessionId)
  }

  protected settleHungStream(conversationId: string): void {
    this.clearStreamWatch(conversationId)
    clearAgentPromptsForConversation(conversationId)
    if (!this.streamingByConversation.has(conversationId)) return
    this.streamingByConversation.delete(conversationId)
    const msgs = getMessagesForConversation(conversationId)
    const streaming = msgs.filter((m) => m.streaming).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).pop()
    if (streaming) {
      // A silent watchdog fire means the turn never completed. Say so — an
      // empty bubble that just stops looks like the agent ignored you.
      const partial = streaming.content.trim().length > 0
      const timeout = "Your agent connected but didn't finish a reply. The turn timed out after two minutes without updates. Try again or check Diagnostics."
      patchMessage(conversationId, streaming.id, {
        streaming: false,
        error: true,
        content: partial ? streaming.content : timeout,
        errorNote: partial ? timeout : undefined,
        toolEvents: streaming.toolEvents?.map((tool) => tool.status === 'running'
          ? { ...tool, status: 'failed' } : tool),
      })
      const finalMsg = getMessagesForConversation(conversationId).find((m) => m.id === streaming.id)
      if (finalMsg) this.emit({ type: 'message', conversationId, message: finalMsg })
    }
    const conv = getState().conversations.find((c) => c.id === conversationId)
    if (conv) {
      this.emitSettledOrphans(
        conv,
        'failed',
        'Specialist did not report back (parent stream ended).',
      )
    }
  }

  // -------------------------------------------------------------------------
  // AgentTransport
  // -------------------------------------------------------------------------

  async listAgents(): Promise<Agent[]> {
    const client = await this.ensureClient()
    const res = await serveListSessions(client, { limit: 1 })
    void res // profile name from session rows is optional; keep roster simple
    // Agents == profiles in Hermes-native mode. We derive the primary agent
    // from the serve profile; a fuller profile roster lands in Phase 2.
    const state = getState()
    const existing = state.agents.find((a) => a.id === 'local-hermes')
    const agent: Agent = existing ?? {
      id: 'local-hermes',
      name: 'Hermes',
      status: 'running',
      region: 'serve',
      createdAt: new Date().toISOString(),
      summary: 'Hermes agent (hermes serve backend).',
      persona: { title: 'Hermes agent', description: 'Local or remote hermes serve.' },
    }
    return [agent]
  }

  async listGroups(): Promise<Group[]> {
    return getState().groups
  }

  async listConversations(): Promise<Conversation[]> {
    const client = await this.ensureClient()
    const res = await serveListSessions(client, { limit: 100 })
    const now = new Date().toISOString()
    const added = absorbHermesSessionRows(
      (res.sessions ?? []).map((r: ServeSessionRow) => ({
        id: r.id,
        title: r.title || r.preview?.slice(0, 60) || r.id,
        createdAt: r.started_at ? new Date(r.started_at * 1000).toISOString() : now,
      })),
    )
    const state = getState()
    if (added > 0) {
      for (const c of state.conversations) {
        if (c.hermesSessionId) this.sessionIdByConversation.set(c.hermesSessionId, c.id)
      }
      this.emit({ type: 'conversations', conversations: state.conversations })
    }
    return [...state.conversations].sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    // Serve streaming keeps the store current; hydrate from the store first,
    // then fall back to a REST transcript fetch.
    const local = getMessagesForConversation(conversationId)
    const hasReal = local.some((m) => m.role === 'user' || m.role === 'agent')
    // The persisted store swaps inline data: images for a placeholder
    // (persist.ts). Re-fetch once the thread is idle so the images come back;
    // mid-turn or with an unsent row the local copy is newer than serve's.
    const needsReload =
      hasReal &&
      local.some((m) => hasInlineImagePlaceholder(m.content)) &&
      !local.some((m) => m.streaming || m.pending)
    if (hasReal && !needsReload) return local
    const conv = getState().conversations.find((c) => c.id === conversationId)
    if (!conv?.hermesSessionId) return local
    try {
      const fetched = await this.fetchTranscript(conv.hermesSessionId)
      // A send that started while the fetch was out owns the thread now.
      const now = getMessagesForConversation(conversationId)
      if (needsReload && (now.length !== local.length || now.some((m) => m.streaming || m.pending))) {
        return now
      }
      const messages = needsReload
        ? mergePreservedReactions(
            local,
            fetched.map((m) => ({ ...m, threadId: conversationId })),
          )
        : fetched
      if (messages.length > 0) {
        setState((prev) => ({
          messagesByThreadId: { ...prev.messagesByThreadId, [conversationId]: messages },
        }))
        return messages
      }
    } catch {
      /* fall back to store */
    }
    return local
  }

  /** Fetch a session transcript over serve REST (auth header). */
  private async fetchTranscript(sessionId: string): Promise<ChatMessage[]> {
    // Single-flight with the selection effect + getMessages paths (same key
    // as hermes-sessions' serve transcript fetch): concurrent callers share
    // one REST fetch instead of stacking identical requests.
    return singleFlightTranscript(`serve-transcript:${sessionId}`, async () => {
      const base = this.httpBase || this.conn?.baseUrl
      if (!base) return []
      const res = await fetch(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&order=latest`,
        {
          headers: this.conn?.token ? { 'X-Hermes-Session-Token': this.conn.token } : undefined,
          credentials: 'omit',
        },
      )
      if (!res.ok) return []
      const data = (await res.json()) as { messages?: { id?: string | number; role?: string; content?: string | null; created_at?: string | number }[] }
      const list = Array.isArray(data.messages) ? data.messages : []
      return list
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m, i) => ({
          id: `hermes_${sessionId}_${m.id ?? i}`,
          threadId: '',
          role: m.role === 'user' ? ('user' as const) : ('agent' as const),
          content: m.content as string,
          createdAt:
            typeof m.created_at === 'number'
              ? new Date(m.created_at * 1000).toISOString()
              : new Date().toISOString(),
        }))
    })
  }

  async sendMessage(
    conversation: Conversation,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ turnId: string }> {
    const conversationId = conversation.id
    const turnId = uid('turn')
    const echoUser = opts?.echoUser !== false
    // Uploaded files: the agent is told where they are (the bubble shows chips).
    const modelText = submitTextForReply(withAttachmentNote(text, (opts?.attachments ?? []).map((a) => a.path)), opts?.replyTo)
    let echoId: string | undefined
    if (echoUser) {
      const userMsg: ChatMessage = {
        id: uid('usr'),
        threadId: conversationId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.attachments?.length
          ? { attachments: opts.attachments.map((a) => ({ id: uid('att'), name: a.name, kind: a.kind, path: a.path, ...(a.size !== undefined ? { size: a.size } : {}) })) }
          : {}),
      }
      appendMessage(conversationId, userMsg)
      this.emit({ type: 'message', conversationId, message: userMsg })
      echoId = userMsg.id
    }
    // Do not re-select here: the user may have switched to another agent
    // while this turn is in flight (Grok: isRunning is per-agent).
    touchConversation(conversationId)

    // Same busy-gate as mock/deploy transports: a second send while a turn
    // is still streaming gets the friendly busy bubble instead of stacking
    // two live replies in one thread.
    flushMessagePatches()
    const liveReply = getMessagesForConversation(conversationId)
      .filter((m) => m.role === 'agent' && m.streaming)
      .pop()
    if (getMessagesForConversation(conversationId).some((m) => m.streaming)) {
      // The live turn may be waiting on a question card: a typed reply is
      // the answer to it, not a second send.
      const answerAt = liveReply ? answerAtFor(liveReply) : undefined
      // Typed by the user: echoed just now, or earlier by the offline outbox.
      const typedEchoId = echoId ?? opts?.echoId
      const answerText = withAttachmentNote(text, (opts?.attachments ?? []).map((a) => a.path))
      if (typedEchoId && (await answerClarifyWithText(conversationId, answerText))) {
        if (answerAt) patchMessage(conversationId, typedEchoId, { answerAt })
        return { turnId }
      }
      const busy: ChatMessage = {
        id: uid('msg'),
        threadId: conversationId,
        role: 'agent',
        fromAgentId:
          conversation.target.type === 'agent' ? conversation.target.agentId : undefined,
        content: 'Still working on your last one. Wait a moment, then try again.',
        createdAt: new Date().toISOString(),
      }
      appendMessage(conversationId, busy)
      this.emit({ type: 'message', conversationId, message: busy })
      return { turnId: uid('turn') }
    }

    const reply: ChatMessage = {
      id: uid('msg'),
      threadId: conversationId,
      role: 'agent',
      fromAgentId: conversation.target.type === 'agent' ? conversation.target.agentId : undefined,
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      toolEvents: [],
    }
    appendMessage(conversationId, reply)
    this.emit({ type: 'message', conversationId, message: reply })
    this.streamingByConversation.set(conversationId, true)

    try {
      const client = await this.ensureClient()
      // Continuity: reuse the hermes session id already bound to this
      // conversation (if any), else create a fresh serve session.
      let sessionId = conversation.hermesSessionId
      if (!sessionId) {
        // Server-authoritative model: the client deliberately
        // sends NO model override on session.create — the serve backend falls
        // back to its profile default, so users cannot pick/change models.
        const created = await serveCreateSession(client, {
          title: text.slice(0, 40),
        })
        sessionId = created.session_id
        this.sessionIdByConversation.set(sessionId, conversationId)
        setState((prev) => ({
          conversations: prev.conversations.map((c) =>
            c.id === conversationId ? { ...c, hermesSessionId: sessionId } : c,
          ),
        }))
      }
      await servePromptSubmit(client, {
        session_id: sessionId,
        // The model only learns the [POINT:]/[TYPE:]/[CLICK:] grammar from
        // `hud_surface_note`, which the server prepends for surface:"hud" —
        // and that note does not teach it yet. Prime the turn locally on the
        // same channel the peer roster uses: model sees it, bubble does not.
        text: hudPrimedText(promptWithPeerRoster(modelText, getState().agents, conversation)),
        surface: hudSurface(),
      })
      this.armStreamWatch(conversationId, reply.id, sessionId)
      return { turnId }
    } catch {
      // Serve failure → configured local API (SSE), otherwise report offline.
      // Never write "(serve unavailable: …)" as the assistant reply.
      if (this.apiUrl) {
        const streamed = await this.streamViaApi(conversationId, modelText, reply.id)
        if (streamed) return { turnId }
      }
      this.streamingByConversation.delete(conversationId)
      this.clearStreamWatch(conversationId)
      // The parent failed and no real stream can settle its unbound workers.
      this.emitSettledOrphans(conversation, 'failed', 'Hermes serve offline')
      const empty = !(
        getMessagesForConversation(conversationId).find((m) => m.id === reply.id)?.content ?? ''
      ).trim()
      if (empty) {
        setState((prev) => ({
          messagesByThreadId: {
            ...prev.messagesByThreadId,
            [conversationId]: (prev.messagesByThreadId[conversationId] ?? []).filter(
              (m) => m.id !== reply.id,
            ),
          },
        }))
      } else {
        patchMessage(conversationId, reply.id, { streaming: false })
      }
      throw new Error('Hermes serve offline — Retry / Diagnostics')
    }
  }

  async reactToMessage(
    conversation: Conversation,
    message: ChatMessage,
    emoji: string | null,
  ): Promise<void> {
    const snapshot = message.reactions
    applyLocalReaction(conversation.id, message.id, emoji, 'user')
    try {
      const client = await this.ensureClient()
      const sessionId = conversation.hermesSessionId
      if (!sessionId) return
      const result = await serveMessageReact(client, {
        session_id: sessionId,
        ...(message.hermesRowId != null
          ? { row_id: message.hermesRowId }
          : { newest_role: message.role === 'user' ? 'user' : 'assistant' }),
        emoji,
        author: 'user',
      })
      patchMessage(conversation.id, message.id, {
        reactions: result.reactions ?? applyReaction(snapshot, emoji, 'user'),
        hermesRowId: result.row_id,
      })
    } catch {
      patchMessage(conversation.id, message.id, { reactions: snapshot ?? [] })
    }
  }

  /** Mid-tier fallback: existing OpenAI-compat SSE stream. */
  private async streamViaApi(
    conversationId: string,
    text: string,
    replyId: string,
  ): Promise<boolean> {
    if (!this.apiUrl) return false
    const history = getMessagesForConversation(conversationId)
      .filter((m) => m.role === 'user' || m.role === 'agent')
      .slice(-8)
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }))
    const toolEvents: ToolProgressEvent[] = []
    const result = await streamChatCompletion(
      this.apiUrl,
      { message: promptWithPeerRoster(text, getState().agents, getState().conversations.find((c) => c.id === conversationId) ?? null), history },
      {
        onDelta: (delta) => {
          patchMessage(conversationId, replyId, {
            content:
              (getMessagesForConversation(conversationId).find((m) => m.id === replyId)?.content ?? '') +
              delta,
          })
        },
        onTool: (ev) => {
          const merged = upsertToolProgress(toolEvents, ev)
          toolEvents.length = 0
          toolEvents.push(...merged)
          patchMessage(conversationId, replyId, { toolEvents: [...toolEvents] })
          if (isDelegateTaskTool(ev.tool) && ev.status === 'running') {
            this.noteDelegateFromSse(conversationId, ev)
          }
        },
        onSubagent: (ev) => {
          this.noteSubagentFromSse(conversationId, ev.type, ev.payload)
        },
        onBrowser: (ev) => {
          this.noteBrowserFromSse(conversationId, ev.type, ev.payload)
        },
      },
    )
    const conv = getState().conversations.find((c) => c.id === conversationId) ?? null
    const keepContent = result.content.trim()
    // A failed stream strands helpers known only from it (no session to poll):
    // close those, then keep watching the ones Hermes can still report on.
    if (conv && !result.ok) {
      for (const run of settleOrphanDelegates({
        conversation: conv,
        reason: 'Specialist did not report back (parent stream ended).',
        status: 'failed',
      })) this.emitSubagent(run)
    }
    if (conv) this.watchLiveDelegates(conv)
    patchMessage(conversationId, replyId, {
      content: keepContent,
      streaming: false,
      toolEvents,
    })
    if (result.sessionId) {
      setState((prev) => ({
        conversations: prev.conversations.map((c) =>
          c.id === conversationId ? { ...c, hermesSessionId: result.sessionId } : c,
        ),
      }))
    }
    this.streamingByConversation.delete(conversationId)
    this.clearStreamWatch(conversationId)
    if (keepContent) autoTitleConversation(conversationId, keepContent)
    // A failed, empty stream is not a reply: the caller shows the offline error.
    return result.ok || Boolean(keepContent)
  }

  async spawnSubagentInto(
    conversation: Conversation,
    kind: SubagentKind,
    goal: string,
    opts?: { label?: string; profile?: string },
  ): Promise<SubagentRun> {
    const conversationId = conversation.id
    const agentId =
      conversation.target.type === 'agent' ? conversation.target.agentId : 'inst_ops'
    const title = goal.length > 48 ? `${goal.slice(0, 48)}…` : goal || `${kind} task`
    const now = new Date().toISOString()
    const run: SubagentRun = {
      id: uid('run'),
      parentAgentId: agentId,
      kind,
      title,
      status: 'queued',
      createdAt: now,
      digests: [],
      conversationId,
      source: 'spawn',
      ...(opts?.label ? { label: opts.label } : {}),
    }
    // Grok Bot parity: the subagent is ALSO a bubble in the parent transcript,
    // so it's visible in the chat even before the sub-thread tab is opened.
    upsertSubagent(run)
    appendSubagentMessage(conversationId, run)
    this.emit({ type: 'subagent', run })
    this.emit({
      type: 'message',
      conversationId,
      message: getMessagesForConversation(conversationId).find(
        (m) => m.subagentRunId === run.id,
      )!,
    })

    // Grok Bot parity: custom/named peers are a SEPARATE serve session
    // (side_chat) parented to this conversation — not the default task-queue
    // worker. Typed kinds still go on the local queue.
    const goalTagged = taggedSpawnGoal(run.id, goal)
    if (kind === 'custom') {
      const served = await this.spawnViaServeSideChat(run, conversation, goalTagged, opts)
      if (served) return served
    }

    const spawned = await spawnReal(kind, goalTagged, opts?.profile ? { agent: opts.profile } : undefined)
    if (spawned.ok) {
      const withTask: SubagentRun = { ...run, status: 'queued', taskId: spawned.taskId }
      upsertSubagent(withTask)
      this.emit({ type: 'subagent', run: withTask })
      pollSubagent(withTask.id)
      return withTask
    }
    // A failed real spawn must never become a fabricated successful run.
    run.status = 'failed'
    run.finishedAt = new Date().toISOString()
    run.error = spawned.error || 'Could not start the local Hermes worker.'
    upsertSubagent(run)
    syncSubagentMessage(run)
    this.emit({ type: 'subagent', run })
    return run
  }

  async listSubagents(parentAgentId: string, opts?: { liveOnly?: boolean }): Promise<SubagentRun[]> {
    const state = getState()
    let runs = Object.values(state.subagentsById).filter((r) => r.parentAgentId === parentAgentId)
    if (opts?.liveOnly) runs = runs.filter((r) => r.status === 'queued' || r.status === 'running')
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async getSubagent(runId: string): Promise<SubagentRun> {
    const run = getState().subagentsById[runId]
    if (!run) throw new Error(`Subagent not found: ${runId}`)
    return run
  }

  async cancelSubagent(runId: string): Promise<boolean> {
    const prev = getState().subagentsById[runId]
    if (!prev) return false
    const run: SubagentRun = { ...prev, status: 'cancelled', finishedAt: new Date().toISOString(), error: 'Cancelled by user' }
    upsertSubagent(run)
    syncSubagentMessage(run)
    this.emit({ type: 'subagent', run })
    this.childTextByRun.delete(runId)
    let reached = true
    try {
      const client = await this.ensureClient()
      if (prev.hermesSubagentId) {
        await serveSubagentInterrupt(client, prev.hermesSubagentId)
      } else if (prev.hermesSessionId) {
        await serveInterrupt(client, prev.hermesSessionId)
      }
    } catch {
      // The local row is cancelled either way; say the interrupt didn't land.
      reached = false
    }
    if (prev.taskId) {
      const w = window as unknown as { nubAgent?: { task?: (args: string[]) => Promise<unknown> } }
      try {
        await w.nubAgent?.task?.(['cancel', prev.taskId])
      } catch {
        /* queue cancel is best-effort */
      }
    }
    return reached
  }

  async messageSubagent(runId: string, text: string): Promise<boolean> {
    const run = getState().subagentsById[runId]
    const clean = text.trim()
    if (!run || !clean) return false
    const client = await this.ensureClient()
    if (run.status === 'completed' || run.status === 'failed') {
      const next: SubagentRun = { ...run, status: 'running' }
      upsertSubagent(next)
      syncSubagentMessage(next)
      this.emit({ type: 'subagent', run: next })
    }
    const live = getState().subagentsById[runId] ?? run
    const parentSid =
      (live.conversationId
        ? getState().conversations.find((c) => c.id === live.conversationId)?.hermesSessionId
        : undefined) ?? undefined
    if (live.hermesSubagentId && live.status === 'running') {
      const steered = await serveSubagentSteer(client, {
        subagent_id: live.hermesSubagentId,
        text: clean,
        ...(parentSid ? { session_id: parentSid } : {}),
      })
      if (steered.status === 'queued') return true
    }
    const sid = live.hermesSessionId
    if (!sid) return false
    await servePromptSubmit(client, { session_id: sid, text: clean, surface: hudSurface() })
    return true
  }

  async createAgent(partial?: NewAgentProfile): Promise<Agent> {
    const n = getState().agents.length + 1
    const agent: Agent = {
      id: uid('inst'),
      name: partial?.name ?? `Agent ${n}`,
      status: 'running',
      region: 'serve',
      createdAt: new Date().toISOString(),
      summary: 'Hermes agent.',
      persona: {
        title: partial?.title ?? 'Generalist',
        description: partial?.description ?? 'Hermes agent.',
      },
      ...(partial?.avatarShape ? { avatarShape: partial.avatarShape } : {}),
      ...(partial?.avatarColor ? { avatarColor: partial.avatarColor } : {}),
      ...(partial?.avatarEyeColor ? { avatarEyeColor: partial.avatarEyeColor } : {}),
      ...(partial?.role ? { role: partial.role } : {}),
      ...(partial?.mcpServers && partial.mcpServers.length > 0
        ? { mcpServers: partial.mcpServers }
        : {}),
    }
    setState((prev) => ({ agents: [...prev.agents, agent] }))
    this.emit({ type: 'agents', agents: getState().agents })
    try {
      await syncDesktopAgentToHermes(agent)
    } catch (err) {
      logger.warn('[nub] failed to sync serve agent', err)
    }
    return agent
  }

  async createGroup(partial?: { name?: string; memberAgentIds?: string[] }): Promise<Group> {
    const agents = getState().agents.filter((a) => a.status === 'running')
    const memberAgentIds = partial?.memberAgentIds ?? agents.slice(0, 2).map((a) => a.id)
    const primaryAgentId = memberAgentIds[0] ?? getState().agents[0]?.id ?? 'local-hermes'
    const group: Group = {
      id: uid('grp'),
      name: partial?.name?.trim() || groupAutoName(getState().agents.filter(a => memberAgentIds.includes(a.id)).map(a => a.name)),
      autoNamed: !partial?.name?.trim(),
      memberAgentIds,
      primaryAgentId,
      summary: 'Group room',
      createdAt: new Date().toISOString(),
    }
    setState((prev) => ({ groups: [...prev.groups, group] }))
    this.emit({ type: 'groups', groups: getState().groups })
    return group
  }

  async setGroupMembers(groupId: string, memberAgentIds: string[]): Promise<Group> {
    const group = getState().groups.find((g) => g.id === groupId)
    if (!group) throw new Error(`Group not found: ${groupId}`)
    const next: Group = {
      ...group,
      memberAgentIds: [...memberAgentIds],
      ...(group.autoNamed ? { name: groupAutoName(getState().agents.filter(a => memberAgentIds.includes(a.id)).map(a => a.name)) } : {}),
      primaryAgentId: memberAgentIds.includes(group.primaryAgentId)
        ? group.primaryAgentId
        : (memberAgentIds[0] ?? group.primaryAgentId),
    }
    return this.saveGroup(next)
  }

  async updateGroup(groupId: string, patch: { name?: string; summary?: string }): Promise<Group> {
    const group = getState().groups.find(g => g.id === groupId)
    if (!group) throw new Error(`Group not found: ${groupId}`)
    return this.saveGroup({ ...group,
      ...(patch.name !== undefined ? {
        name: patch.name.trim() || groupAutoName(getState().agents.filter(a => group.memberAgentIds.includes(a.id)).map(a => a.name)),
        autoNamed: !patch.name.trim(),
      } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
    })
  }

  private saveGroup(group: Group): Group {
    const previous = getState().groups.find(g => g.id === group.id)
    if (!previous) throw new Error(`Group not found: ${group.id}`)
    setState(state => ({
      groups: state.groups.map(g => g.id === group.id ? group : g),
      conversations: state.conversations.map(c => c.target.type === 'group' &&
        c.target.groupId === group.id && c.title === previous.name ? { ...c, title: group.name } : c),
    }))
    this.emit({ type: 'groups', groups: getState().groups })
    return group
  }

  async getComputerUrl(): Promise<{ url: string | null; provider: string }> {
    return { url: 'nub-vm://computer/screenshot', provider: 'vm' }
  }

  async respondPermission(
    conversationId: string,
    choice: ToolPermissionChoice,
    opts?: { optionId?: string; requestId?: string },
  ): Promise<void> {
    const ask = getPendingToolPermission(conversationId)
    if (!ask || ask.status === 'submitting' || (opts?.requestId && opts.requestId !== ask.id)) return
    const submitting = { ...ask, status: 'submitting' as const }
    setPendingToolPermission(submitting)
    try {
      const client = await this.ensureClient()
      if (!getPendingToolPermissions().includes(submitting)) return
      // A1 widget chips: the chosen option id IS the answer we hand back.
      await serveApprovalRespond(client, {
        session_id: ask.sessionId,
        choice: opts?.optionId ?? choice,
      })
      clearPendingToolPermission(ask.id)
      this.emit({ type: 'permission', conversationId, ask: null })
    } catch {
      if (getPendingToolPermissions().includes(submitting)) setPendingToolPermission({ ...ask, status: 'failed' })
    }
  }

  subscribe(cb: (ev: TransportEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * Generic gateway JSON-RPC door — the plugin host's `host.request` path.
   * Reuses the live WS client; falls back to the OpenAI-compat REST turn
   * when no WS session is needed (method whitelist below).
   */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = await this.ensureClient()
    return client.request<T>(method, params)
  }
}

export { resolveServeConnection, probeServe }
