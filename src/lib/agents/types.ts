/**
 * Multi-agent / subagent types (Nub Agent).
 * Aligns with docs/SUBAGENTS_AND_MULTI_AGENT.md §6.
 */

export type AgentStatus = 'running' | 'stopped' | 'provisioning' | 'error'

/** Grok Bot "Chief of Staff" analogue: orchestrator delegates to specialists. */
export type AgentRole = 'orchestrator' | 'specialist'

export interface AgentPersona {
  title?: string
  description?: string
  /** Short preview only — full instructions stay server/box side */
  instructionsPreview?: string
}

export interface AgentMemory {
  summary?: string
  pinnedNoteIds?: string[]
}

/** Named agent == MaiaVM Instance in the product mapping */
export interface Agent {
  id: string
  name: string
  status: AgentStatus
  region: string
  createdAt: string
  summary: string
  persona?: AgentPersona
  memory?: AgentMemory
  unreadCount?: number
  /** Mascot customization (Grok Bot parity): orb silhouette shape. */
  avatarShape?: import('../../components/FatCatIcon').GrokOrbShape
  /** Mascot customization (Grok Bot parity): orb body color. */
  avatarColor?: string
  /** Mascot customization: nubcat eye fill (must be in NUBCAT_EYE_COLORS). */
  avatarEyeColor?: string
  /**
   * Grok Bot Chief of Staff analogue. Orchestrators always see the peer
   * roster and get specialist results folded back so they can summarize.
   * Inferred from name/title ("Chief of Staff") when unset.
   */
  role?: AgentRole
  /**
   * MCP servers attached to this specialist (Grok custom-bot plugins).
   * Written into `$HERMES_HOME/agents/<slug>.md` as `mcp_servers`.
   * This is NOT a new Hermes profile — profiles own the global
   * `config.yaml` MCP map; specialists only pin a subset.
   */
  mcpServers?: AgentMcpServer[]
  /**
   * Real hermes profile backing this agent on a hosted VM (created by
   * "New agent" via POST /api/profiles). Absent for app-only agents.
   */
  hermesProfile?: string
}

/** One MCP plugin pinned on a desktop-created specialist. */
export interface AgentMcpServer {
  name: string
  /** HTTP/SSE URL. Required for Hermes agent-file `mcp_servers` entries. */
  url?: string
}

export type SubagentKind =
  | 'executor'
  | 'browserUse'
  | 'computerUse'
  | 'cloudCoder'
  | 'watcher'
  // grok's extended roster (14 kinds total)
  | 'explore'
  | 'bash'
  | 'shell'
  | 'debug'
  | 'mediaReview'
  | 'watchVideo'
  | 'cursorGuide'
  | 'fileGlobbed'
  | 'custom'

export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SubagentDigest {
  id: string
  at: string
  text: string
  attachments?: { id: string; name: string; kind: 'file' | 'image' }[]
}

export interface SubagentRun {
  id: string
  parentAgentId: string
  kind: SubagentKind
  title: string
  status: SubagentStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  digests: SubagentDigest[]
  result?: {
    summary: string
    artifacts?: { id: string; name: string; kind: 'file' | 'image' }[]
  }
  error?: string
  /**
   * The conversation this subagent was pulled into (Grok Bot parity: a
   * subagent is a SEPARATE agent session bound to the parent conversation,
   * opened from a clickable pill in the parent stream).
   */
  conversationId?: string
  /** Real backend handle: ~/.agent-tasks queue task id (t-xxx) when spawned
   *  onto the local hermes worker; used for live status polling. */
  taskId?: string
  /**
   * Hermes session the worker opened for this run (Grok side_chat). Bound
   * during poll / hydration so the sub-thread can load that transcript and
   * so hydrateHermesSessions does not dump it as a sidebar row.
   */
  hermesSessionId?: string
  /** Display name for custom/peer workers (Grok: "Message from TravelAgent"). */
  label?: string
  /**
   * Hermes `delegate_task` child id — used for `subagent.interrupt` /
   * `subagent.steer`. Distinct from the store run id and from the child
   * session id.
   */
  hermesSubagentId?: string
  /** Parent `delegate_task` tool_id, so parallel tasks[] share one call. */
  toolCallId?: string
  /** Index inside a parallel `delegate_task(tasks=[...])` batch. */
  taskIndex?: number
  /** How this run was created. Native Hermes path is `delegate_task`. */
  source?: 'delegate_task' | 'spawn' | 'queue'
  /**
   * Cube browser-use job bound to this run (plan step 2). Set when the
   * first `browser.progress` event for the job matches a queued/running
   * `browserUse` run — the job id is server-issued, so the spawn cannot
   * know it up front.
   */
  browserJobId?: string
}

export type MessageRole = 'user' | 'agent' | 'system' | 'subagent'

/** One emoji reaction on a message. Hermes: one per author, iOS-tapback style. */
export interface MessageReaction {
  emoji: string
  author: 'agent' | 'user'
  /** Epoch seconds (Hermes `at`). */
  at?: number
}

/** Grok `replyTo` — the message this bubble is answering. */
export interface MessageReplyTo {
  id: string
  role: MessageRole
  snippet: string
  /**
   * True for a THREAD reply ("Reply in thread"), absent for a quote reply.
   *
   * Both gestures store `replyTo`, but they are different features: a quote
   * reply is an inline bubble carrying a quote pill, while a thread reply
   * collapses into the root's reply chain. Without this flag `threadGroups`
   * collapsed every quoted reply into a thread, so using plain Reply made the
   * message vanish from the transcript behind an "N replies" chip.
   */
  thread?: boolean
}

export interface ChatChoice {
  id: string
  label: string
}

export interface ChatMessage {
  id: string
  /** Thread owner: agent id or group id */
  threadId: string
  role: MessageRole
  content: string
  /** Model-facing process/delegation output, collapsed behind a system notice. */
  noticeDetails?: string
  createdAt: string
  /** Durable Hermes `messages.id` — `message.react` keys off this. */
  hermesRowId?: number
  /** Grok/Hermes tapbacks painted on the bubble. */
  reactions?: MessageReaction[]
  /** Grok reply-quote: this send answers `replyTo`. */
  replyTo?: MessageReplyTo
  /** When role==='agent' in a group or DM */
  fromAgentId?: string
  toAgentId?: string
  /** When role==='subagent' */
  subagentRunId?: string
  subagentKind?: SubagentKind
  subagentStatus?: SubagentStatus
  /** Peer name when kind is `custom` (Grok: "Message from TravelAgent"). */
  subagentLabel?: string
  /** `path`: where the file sits on the agent computer (sent attachments). */
  attachments?: { id: string; name: string; kind: 'file' | 'image'; path?: string; size?: number }[]
  choices?: ChatChoice[]
  /** Streaming (Grok parity): tool-call activity for the Full conversation
   *  outline panel + live activity line. Not rendered inside the bubble. */
  toolEvents?: {
    tool: string
    emoji?: string
    label?: string
    toolCallId?: string
    status: 'running' | 'completed' | 'failed'
    /** Short result summary (grok: `summary` field on tool-call entries). */
    summary?: string
    /** Raw args JSON (kept for transport; outline shows unlabeled summary only). */
    args?: string
    /** Raw tool result (kept for transport; outline shows unlabeled summary only). */
    result?: string
    /** Full bounded data-only spec from a successful render_ui result. Revalidated on hydration/display. */
    genui?: import('../genui').GenUiSpec
    /** Server-issued durable result occurrence; absent legacy results never persist local notes. */
    genuiOccurrence?: string
  }[]
  /** Assistant reasoning, if the backend sent it (Grok outline kind `thinking`). */
  reasoning?: string
  /** True while the message is still being streamed (content grows). */
  streaming?: boolean
  /** This bubble holds a failed turn's error text, not a reply. Drives the
   *  in-chat Retry affordance: without it the error text is indistinguishable
   *  from a normal answer, so a failed turn had no way back. */
  error?: boolean
  /** Failed turn the user fixes outside the chat (a lapsed plan): the button
   *  next to Try again. `url` is https, checked again when rendered. */
  errorAction?: { label: string; url: string }
  /** Why a failed turn stopped, when the bubble keeps the partial reply as
   *  its text (a stream that broke mid-answer). */
  errorNote?: string
  /** User send parked in the offline outbox — shown in the thread but not yet
   *  delivered. Cleared when the flush succeeds. */
  pending?: boolean
  /** Deploy transcript: the server turn this row belongs to (user echo and
   *  agent reply). Marks the row as server-known — merges never rebind it to
   *  another turn, and paging dedupes echoes on it. */
  turnId?: string
  /** Deploy transcript: the server turn's `createdAt`. Server-known rows are
   *  ordered by (turnCreatedAt, turnId); rows without it keep their place. */
  turnCreatedAt?: string
  /** A typed answer to a question the agent asked mid-reply: which reply,
   *  and where in its text the answer was given (`tail` = the text just
   *  before it, to re-find the spot). Display only — see answer-placement. */
  answerAt?: { replyId: string; offset: number; tail: string }
}

export type TurnPhase = 'acked' | 'working' | 'delivering' | 'done' | 'failed'

export interface Turn {
  id: string
  threadId: string
  agentId: string
  userMessageId: string
  phase: TurnPhase
  subagentRunIds: string[]
  startedAt: string
  finishedAt?: string
}

export interface Group {
  id: string
  name: string
  memberAgentIds: string[]
  primaryAgentId: string
  summary?: string
  unreadCount?: number
  createdAt: string
  /**
   * Shared-room invite link (format `nub-agent://group/<groupId>`). When
   * present the group is a shared room that external users can join.
   */
  inviteLink?: string
  /** Names of users who joined remotely via the invite link (not local agents). */
  remoteMembers?: string[]
  /** The name was generated from the members ("A, B and C") and follows
   *  member changes until the user names the group. */
  autoNamed?: boolean
}

export type ThreadRef =
  | { type: 'agent'; agentId: string }
  | { type: 'group'; groupId: string }

/** Editable fields supplied when CREATING a new agent (Grok Bot parity:
 *  the create flow goes through the agent editor first — name, persona,
 *  and mascot look — before the agent exists). */
export interface NewAgentProfile {
  name?: string
  title?: string
  description?: string
  avatarShape?: import('../../components/FatCatIcon').GrokOrbShape | null
  avatarColor?: string | null
  avatarEyeColor?: string | null
  role?: AgentRole
  mcpServers?: AgentMcpServer[]
  /** Personality text (SOUL.md) for the new hermes profile, e.g. a tone preset. */
  personality?: string
}

/**
 * Canonical avatar contract lives in ../avatar-spec (single source of
 * truth: AvatarSpec, palettes, validateAvatar, resolveAvatarSpec).
 * Re-exported here so agent types stay the import point; reaches the
 * agents barrel via `export * from './types'`.
 */
export type { AvatarSpec } from '../avatar-spec'

/**
 * A conversation is the top-level chat unit (Grok Desktop parity): the sidebar
 * lists conversations, each keeps its own message history, and a conversation
 * talks to ONE target (an agent, or a group room). Creating a new conversation
 * does NOT create a new agent — it's a fresh thread bound to the same target.
 */
export interface Conversation {
  id: string
  /** 'New conversation' until the first reply auto-titles it (first line, ≤60 chars). */
  title: string
  /** The agent or group this conversation talks to. */
  target: ThreadRef
  createdAt: string
  lastUsedAt: string
  /** Real hermes-agent session id when this conversation is hydrated from
   *  `hermes sessions list` (desktop bridge). Local app conversations omit it. */
  hermesSessionId?: string
  /** Per-member cube sessions for a group room. Kept off `hermesSessionId`
   *  so list-conversations does not invent extra 1:1 threads. */
  memberSessionIds?: Record<string, string>
  /** Renderer-owned shared room log and routing journal. DMs remain serve-owned. */
  localRoom?: import('./local-rooms').LocalRoomState
  /** Workspace folder for this conversation's files (Grok Bot parity:
   *  workspace_root_path per conversation). Hydrated hermes sessions carry
   *  their export cwd; local conversations get a default workspace. */
  cwd?: string
  /** Grok Bot parity: Hide from sidebar. Conversation stays in the store. */
  hiddenFromSidebar?: boolean
  /** Grok Bot parity: pinned rows sort above the rest. */
  pinned?: boolean
  /** Per-thread unread (Mark as Unread / Mark as Read). */
  hasUnread?: boolean
  /** Unread message count when known (Grok "Unread activity" badge). */
  unreadCount?: number
  /** Last line from the VM conversation list (phone home, no local transcript yet). */
  preview?: string
  /** Synthesized forever-chat for a VM whose roster has no threads yet. Not
   *  real server state — hidden while hydration is in flight so the user
   *  sees loading skeletons, never placeholder content. */
  placeholder?: boolean
}

export function threadKey(ref: ThreadRef): string {
  return ref.type === 'agent' ? `agent:${ref.agentId}` : `group:${ref.groupId}`
}

export type ToolPermissionChoice = 'once' | 'session' | 'always' | 'deny'

/**
 * Read-only skill entry from the deploy proxy's skills route
 * (`GET /api/chat/runs/:turnId/skills` → gateway `GET /v1/skills`).
 * Disabled skills are excluded upstream, so there is no `enabled` flag.
 */
export interface DeploySkillEntry {
  name: string
  description?: string | null
  category?: string | null
  [key: string]: unknown
}

/** One choice chip on a Grok-widget-style question ask (A1). */
export interface ApprovalOption {
  id: string
  label: string
  hint?: string
}

/** Hermes `approval.request` parked above the composer (Grok local-tool dock). */
export interface PendingToolPermission {
  id: string
  conversationId: string
  sessionId: string
  /** Room requests retain the member identity as well as session ownership. */
  memberId?: string
  memberName?: string
  command?: string
  description?: string
  /** Exact action patterns supplied by Hermes, never inferred from the command. */
  patterns?: string[]
  choices: ToolPermissionChoice[]
  /**
   * Risk class of the requested action. `high-stakes` (money movement,
   * purchases, credential-adjacent actions) never offers standing grants —
   * the dock only shows one-time choices so every occurrence needs a fresh
   * decision. Defaults to `standard` when absent.
   */
  risk?: ApprovalRisk
  /**
   * Grok 0.24 widget parity: when the gateway asks a question with canned
   * answers, the dock renders these chips instead of Allow/Deny buttons.
   * Resolution still goes through the same approval RPC.
   */
  options?: ApprovalOption[]
  kind?: 'command' | 'question'
  status: 'pending' | 'submitting' | 'failed'
}

/** Risk class driving which approval choices may be offered. */
export type ApprovalRisk = 'standard' | 'high-stakes'
