/**
 * In-chat blocking prompts raised by the agent mid-turn.
 *
 * Hermes pauses a tool call and asks the user a question through the gateway
 * (`tui_gateway` `_block`): a missing skill key (`secret.request`), a
 * clarifying question (`clarify.request`) or an MCP server to set up
 * (`mcp.setup.request`). Until it is answered the turn is stuck, so each one
 * is surfaced as a card above the composer.
 *
 * The transport that saw the event registers the prompt together with a
 * responder (it owns the RPC client). The UI only ever calls
 * `answerAgentPrompt` — it never learns which RPC carries the answer.
 *
 * Secrets: the store keeps the prompt's metadata only. A typed key lives in
 * the card's input state until Save, is handed straight to the responder and
 * is never stored, logged or persisted here.
 */

export type McpSetupAction = 'install' | 'enable' | 'authorize'

export interface ClarifyQuestion {
  /** Batch question id (`question_id` on the respond RPC); absent for a single question. */
  qid?: string
  question: string
  /** Empty = open-ended (free text only). */
  choices: string[]
  multiSelect: boolean
}

interface PromptBase {
  /** Gateway `request_id` — the key every respond RPC needs. */
  requestId: string
  conversationId: string
  sessionId?: string
  memberId?: string
  memberName?: string
  status: 'pending' | 'submitting' | 'failed'
}

export interface SecretPrompt extends PromptBase {
  kind: 'secret'
  /** The key's technical name (e.g. `TENOR_API_KEY`) — secondary text only. */
  envVar: string
  prompt: string
  skillName?: string
  help?: string
  requiredFor?: string
}

export interface ClarifyPrompt extends PromptBase {
  kind: 'clarify'
  questions: ClarifyQuestion[]
  /** Batch request: each question is answered with its own `question_id`. */
  batch: boolean
}

export interface McpSetupPrompt extends PromptBase {
  kind: 'mcp'
  server: string
  action: McpSetupAction
  reason: string
}

export type AgentPrompt = SecretPrompt | ClarifyPrompt | McpSetupPrompt

/** The outcome shape `setup_mcp` expects back (tools/setup_mcp_tool.py). */
export interface McpSetupOutcome {
  status: 'installed' | 'enabled' | 'authorized' | 'declined' | 'error'
  server: string
  detail?: string
  tools?: string[]
}

export type AgentPromptAnswer =
  | { kind: 'secret'; value: string }
  | { kind: 'secret'; skip: true }
  | {
      kind: 'clarify'
      answers: { qid?: string; answer: string }[]
      /** The answer was typed in the message box, so its bubble already exists. */
      typed?: boolean
      /** With `typed`: the question carrying the typed text (the rest are picks or the note). */
      typedIndex?: number
    }
  | { kind: 'clarify'; cancel: true }
  | { kind: 'mcp'; outcome: McpSetupOutcome }

export type AgentPromptResponder = (answer: AgentPromptAnswer) => Promise<void>

type Payload = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
}

function asPayload(raw: unknown): Payload | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Payload) : null
}

/** Humanize `TENOR_API_KEY` → "Tenor" for the card title. */
export function secretDisplayName(p: Pick<SecretPrompt, 'envVar' | 'skillName'>): string {
  const base = p.envVar
    .replace(/(^|_)(API_)?(KEY|TOKEN|SECRET)$/i, '')
    .replace(/_API$/i, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
  return base || p.skillName || 'API'
}

export function parseSecretRequest(
  raw: unknown,
  ctx: { conversationId: string; sessionId?: string },
): SecretPrompt | null {
  const p = asPayload(raw)
  if (!p) return null
  const requestId = str(p.request_id)
  const envVar = str(p.env_var)
  if (!requestId || !envVar) return null
  const meta = asPayload(p.metadata) ?? {}
  return {
    kind: 'secret',
    requestId,
    conversationId: ctx.conversationId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    status: 'pending',
    envVar,
    prompt: str(p.prompt),
    ...(str(meta.skill_name) ? { skillName: str(meta.skill_name) } : {}),
    ...(str(meta.help) ? { help: str(meta.help) } : {}),
    ...(str(meta.required_for) ? { requiredFor: str(meta.required_for) } : {}),
  }
}

export function parseClarifyRequest(
  raw: unknown,
  ctx: { conversationId: string; sessionId?: string },
): ClarifyPrompt | null {
  const p = asPayload(raw)
  if (!p) return null
  const requestId = str(p.request_id)
  if (!requestId) return null
  const base = {
    kind: 'clarify' as const,
    requestId,
    conversationId: ctx.conversationId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    status: 'pending' as const,
  }
  if (Array.isArray(p.questions) && p.questions.length > 0) {
    const questions: ClarifyQuestion[] = []
    for (const q of p.questions) {
      const row = asPayload(q)
      const qid = row ? str(row.qid) : ''
      const question = row ? str(row.question) : ''
      if (!qid || !question) continue
      const choices = strList(row!.choices)
      questions.push({ qid, question, choices, multiSelect: row!.multi_select === true && choices.length > 0 })
    }
    if (questions.length === 0) return null
    return { ...base, questions, batch: true }
  }
  const question = str(p.question)
  if (!question) return null
  const choices = strList(p.choices)
  return {
    ...base,
    questions: [{ question, choices, multiSelect: p.multi_select === true && choices.length > 0 }],
    batch: false,
  }
}

export function parseMcpSetupRequest(
  raw: unknown,
  ctx: { conversationId: string; sessionId?: string },
): McpSetupPrompt | null {
  const p = asPayload(raw)
  if (!p) return null
  const requestId = str(p.request_id)
  const server = str(p.server)
  if (!requestId || !server) return null
  const a = str(p.action).toLowerCase()
  const action: McpSetupAction = a === 'enable' || a === 'authorize' ? a : 'install'
  return {
    kind: 'mcp',
    requestId,
    conversationId: ctx.conversationId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    status: 'pending',
    server,
    action,
    reason: str(p.reason),
  }
}

/** Encode one clarify answer: multi-select → JSON array (clarify_tool parses it). */
export function encodeClarifyAnswer(selected: string[], multiSelect: boolean): string {
  const clean = selected.map((s) => s.trim()).filter(Boolean)
  if (multiSelect) return clean.length ? JSON.stringify(clean) : ''
  return clean[0] ?? ''
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let prompts: AgentPrompt[] = []
const responders = new Map<string, AgentPromptResponder>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* isolated */
    }
  }
}

export function subscribeAgentPrompts(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Snapshot (stable reference until the next change — safe for useSyncExternalStore). */
export function getAgentPrompts(): AgentPrompt[] {
  return prompts
}

export function agentPromptsFor(conversationId: string | null | undefined, all = prompts): AgentPrompt[] {
  if (!conversationId) return []
  return all.filter((p) => p.conversationId === conversationId)
}

/** Register (or replace, on a replayed request id) a prompt and its responder. */
export function setAgentPrompt(prompt: AgentPrompt, responder: AgentPromptResponder): void {
  responders.set(prompt.requestId, responder)
  prompts = [...prompts.filter((p) => p.requestId !== prompt.requestId), prompt]
  notify()
}

export function clearAgentPrompt(requestId: string): void {
  if (!prompts.some((p) => p.requestId === requestId)) return
  responders.delete(requestId)
  clarifyDrafts.delete(requestId)
  prompts = prompts.filter((p) => p.requestId !== requestId)
  notify()
}

/** Turn over / interrupted: nothing in this conversation is still waiting. */
export function clearAgentPromptsForConversation(conversationId: string): void {
  const drop = prompts.filter((p) => p.conversationId === conversationId)
  if (drop.length === 0) return
  for (const p of drop) {
    responders.delete(p.requestId)
    clarifyDrafts.delete(p.requestId)
  }
  prompts = prompts.filter((p) => p.conversationId !== conversationId)
  notify()
}

function patchStatus(requestId: string, status: AgentPrompt['status']): void {
  let changed = false
  prompts = prompts.map((p) => {
    if (p.requestId !== requestId || p.status === status) return p
    changed = true
    return { ...p, status }
  })
  if (changed) notify()
}

/**
 * A responder throws this when the prompt is no longer waiting: it timed out,
 * was answered on another device, or its turn already ended. Retrying can
 * never work, so the card is removed instead of being left to fail forever.
 */
export class PromptGoneError extends Error {
  constructor() {
    super('This question is no longer waiting.')
    this.name = 'PromptGoneError'
  }
}

/**
 * Send the user's answer through the transport that raised the prompt.
 * Resolves true and removes the card on success; on failure the card stays
 * (status `failed`) so the user can try again. A prompt that is gone
 * (`PromptGoneError`) resolves false and removes the card — the answer was
 * not delivered, so a typed reply goes out as a normal message instead.
 */
export async function answerAgentPrompt(requestId: string, answer: AgentPromptAnswer): Promise<boolean> {
  const responder = responders.get(requestId)
  const prompt = prompts.find((p) => p.requestId === requestId)
  if (!responder || !prompt || prompt.kind !== answer.kind || prompt.status === 'submitting') return false
  patchStatus(requestId, 'submitting')
  try {
    await responder(answer)
  } catch (err) {
    // Never surface the error object: for a secret it could echo the payload.
    if (responders.get(requestId) === responder) {
      if (err instanceof PromptGoneError) clearAgentPrompt(requestId)
      else patchStatus(requestId, 'failed')
    }
    return false
  }
  if (responders.get(requestId) === responder) clearAgentPrompt(requestId)
  return true
}

// ---------------------------------------------------------------------------
// Typed replies
// ---------------------------------------------------------------------------

/** Sent for a question the user left open when one typed reply covers it too. */
export const TYPED_REPLY_NOTE = '(No separate answer — the user typed one reply that covers this too.)'

/**
 * What the user has picked on a question card so far, one encoded answer per
 * question ('' = still open). The card publishes it so a typed reply can keep
 * those picks instead of throwing them away.
 */
const clarifyDrafts = new Map<string, string[]>()

export function setClarifyDraft(requestId: string, answers: string[] | null): void {
  if (answers && answers.some(Boolean)) clarifyDrafts.set(requestId, answers)
  else clarifyDrafts.delete(requestId)
}

/** The question card a typed message would answer, if one is waiting. */
export function waitingClarifyFor(conversationId: string | null | undefined, all = prompts): ClarifyPrompt | null {
  if (!conversationId) return null
  return (
    all.find(
      (p): p is ClarifyPrompt =>
        p.kind === 'clarify' && p.conversationId === conversationId && p.status !== 'submitting',
    ) ?? null
  )
}

/**
 * What the activity line says while the turn is paused on the user. Without
 * it the line keeps reading "Working…" (and a message typed meanwhile shows
 * as "queued"), which looks like a hung agent rather than a card to answer.
 * `approvalPending`: the tool-permission dock is up.
 */
export function waitingOnUserText(
  conversationId: string | null | undefined,
  approvalPending = false,
  all = prompts,
): string | null {
  const mine = agentPromptsFor(conversationId, all)
  if (mine.some((p) => p.kind === 'clarify')) return 'Waiting for your answer'
  if (mine.some((p) => p.kind === 'secret')) return 'Waiting for your key'
  if (mine.length > 0 || approvalPending) return 'Waiting for your go-ahead'
  return null
}

/** Add typed text to what was already picked on one question. */
function withTypedText(picked: string, text: string, multiSelect: boolean): string {
  if (!picked) return encodeClarifyAnswer([text], multiSelect)
  if (!multiSelect) return `${picked} — ${text}`
  let picks: string[] = []
  try {
    const parsed: unknown = JSON.parse(picked)
    if (Array.isArray(parsed)) picks = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    /* not a list: the typed text stands alone */
  }
  return encodeClarifyAnswer([...picks, text], true)
}

/**
 * The user typed in the composer while a question card was up: that text IS
 * the answer. Without this the send parks behind a turn that is itself
 * waiting on the card, and nothing moves until the question times out.
 *
 * A batch resumes only once every question has an answer. Picks already made
 * on the card are kept; the typed text goes on the first question still open
 * (the rest point to it), or is added to the last answer when none is open.
 *
 * Resolves false when no question is waiting (or the answer didn't go
 * through) — the caller then sends the text the normal way. Slash commands
 * stay commands, and keys and plugin cards are never answered from the
 * composer.
 */
export async function answerClarifyWithText(conversationId: string, text: string): Promise<boolean> {
  const clean = text.trim()
  if (!clean || clean.startsWith('/')) return false
  const prompt = waitingClarifyFor(conversationId)
  if (!prompt) return false
  const draft = clarifyDrafts.get(prompt.requestId) ?? []
  const picked = prompt.questions.map((_, i) => draft[i] ?? '')
  const firstOpen = picked.findIndex((a) => !a)
  const target = firstOpen >= 0 ? firstOpen : picked.length - 1
  const answers = prompt.questions.map((q, i) => ({
    ...(q.qid ? { qid: q.qid } : {}),
    answer:
      i === target
        ? withTypedText(picked[i]!, clean, q.multiSelect)
        : picked[i] || encodeClarifyAnswer([TYPED_REPLY_NOTE], q.multiSelect),
  }))
  return answerAgentPrompt(prompt.requestId, { kind: 'clarify', answers, typed: true, typedIndex: target })
}

/**
 * What the user answered on a question card, as text for the thread. The
 * card disappears once answered and the questions live nowhere else, so
 * without this the transcript shows the agent asking nothing and the user
 * saying nothing, then a reply that depends on both.
 *
 * For a typed answer, only the questions answered by picking a chip are
 * recorded — the typed text already has its own bubble.
 *
 * Null when there is nothing to record: a skip, or a typed answer with no
 * picks alongside it.
 */
export function clarifyAnswerRecord(prompt: ClarifyPrompt, answer: AgentPromptAnswer): string | null {
  if (answer.kind !== 'clarify' || 'cancel' in answer) return null
  const blocks: string[] = []
  prompt.questions.forEach((q, i) => {
    if (answer.typed && (answer.typedIndex === undefined || i === answer.typedIndex)) return
    const given = (q.qid ? answer.answers.find((a) => a.qid === q.qid) : answer.answers[i])?.answer ?? ''
    let text = given.trim()
    if (q.multiSelect) {
      try {
        const parsed: unknown = JSON.parse(given)
        if (Array.isArray(parsed)) text = parsed.filter((v) => typeof v === 'string').join(', ')
      } catch {
        /* not a list: shown as sent */
      }
    }
    if (text && text !== TYPED_REPLY_NOTE) blocks.push(`${q.question}\n${text}`)
  })
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/** Test-only reset. */
export function __resetAgentPrompts(): void {
  prompts = []
  responders.clear()
  clarifyDrafts.clear()
  listeners.clear()
}
