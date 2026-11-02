/** AgentTransport interface — mock vs MaiaVM adapters. */

import type {
  Agent,
  ChatMessage,
  Conversation,
  Group,
  NewAgentProfile,
  PendingToolPermission,
  SubagentKind,
  SubagentRun,
  ToolPermissionChoice,
  Turn,
} from './types'
export type TransportEvent =
  | { type: 'message'; conversationId: string; message: ChatMessage }
  | { type: 'turn'; turn: Turn }
  | { type: 'subagent'; run: SubagentRun }
  | { type: 'agents'; agents: Agent[] }
  | { type: 'groups'; groups: Group[] }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'permission'; conversationId: string; ask: PendingToolPermission | null }
  | { type: 'queued'; conversationId: string; count: number; items: QueuedMessageItem[] }

/** A user send parked behind a live stream (deploy transport FIFO). */
export interface QueuedMessageItem {
  /** Stable id so the popover can remove a single parked send by key. */
  id: string
  text: string
  enqueuedAt: string
}

export interface SendMessageOptions {
  /** When false, do not echo `text` as a user bubble (parent continuation). */
  echoUser?: boolean
  /** With `echoUser: false`: the user DID type this and its bubble is already
   *  in the thread under this id (offline outbox replay). Lets the send still
   *  count as the user's own words — e.g. as the answer to a waiting question. */
  echoId?: string
  /** Skip the OpenAI-compat SSE hop — already failed this turn. */
  skipHermesStream?: boolean
  /** Grok reply-to-message — stored on the user bubble; prefixed for the model. */
  replyTo?: import('./types').MessageReplyTo
  /** Files already uploaded to the agent computer for this message: shown as
   *  chips on the bubble, and their paths are told to the agent. */
  attachments?: { name: string; path: string; kind: 'file' | 'image'; size?: number }[]
  /** HUD SEE: screenshots for this turn as `data:image/*` URLs, sent as
   *  `image_url` content parts. Deploy transport only; others ignore them. */
  images?: string[]
  /** Pixel space of the attached screenshot, so the HUD note can tell the
   *  model which coordinates to answer [POINT:]/[CLICK:] in. */
  sight?: import('../hud-protocol').HudSightInfo
}

export interface SpawnSubagentOptions {
  /** Peer display name for custom workers (Grok: "Message from TravelAgent"). */
  label?: string
  /** Hermes profile slug when the peer is a real profile (`profile:<name>`). */
  profile?: string
}

export interface AgentTransport {
  listAgents(): Promise<Agent[]>
  listGroups(): Promise<Group[]>
  listConversations(opts?: { followLive?: boolean }): Promise<Conversation[]>
  getMessages(conversationId: string): Promise<ChatMessage[]>
  /**
   * Deploy transport only: fetch the next OLDER server page of this
   * conversation's history and merge it above the thread. Resolves true when
   * rows were added. Paging state is published on the store's hydrate status
   * (`historyPaging`). Absent on transports without server paging.
   */
  loadOlderMessages?(conversationId: string): Promise<boolean>
  /**
   * Deploy transport only: refresh just the transcript page (no live-turn
   * /state snapshot — the poll owns that). Used for re-selecting a cached
   * thread. Absent → callers fall back to getMessages.
   */
  refreshTranscript?(conversationId: string): Promise<ChatMessage[]>
  /**
   * Deploy transport only: warm a conversation's newest transcript page into
   * the store WITHOUT selecting it (sidebar hover intent, post-boot warm-up),
   * so opening it paints from cache. Never polls live-turn state and never
   * follows a turn. Resolves true when it fetched. Absent → no prefetch.
   */
  prefetchTranscript?(conversationId: string): Promise<boolean>
  /**
   * Fetch the next conversation-list page ("Show more" in the sidebar).
   * State is published as `conversationsHasMore` / `conversationsLoadingMore`
   * on the hydrate status. The deploy transport syncs the whole list (see
   * conversation-sync.ts) and does not implement it.
   */
  loadMoreConversations?(): Promise<void>
  /**
   * Server-run group rooms are on for this account, so a message without an
   * @mention goes to the room's Chief of Staff first. Transports without
   * rooms don't implement it (the legacy fan-out has no Chief routing).
   */
  roomsEnabled?(): Promise<boolean>
  sendMessage(
    conversation: Conversation,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<{ turnId: string }>
  /** Grok Add reaction → Hermes `message.react` when a session exists. */
  reactToMessage?(
    conversation: Conversation,
    message: ChatMessage,
    emoji: string | null,
  ): Promise<void>
  spawnSubagentInto(
    conversation: Conversation,
    kind: SubagentKind,
    goal: string,
    opts?: SpawnSubagentOptions,
  ): Promise<SubagentRun>
  listSubagents(
    parentAgentId: string,
    opts?: { liveOnly?: boolean },
  ): Promise<SubagentRun[]>
  getSubagent(runId: string): Promise<SubagentRun>
  /** Stop a helper. Resolves false when the stop didn't reach the agent
   *  (no stop route on this deploy, no turn to stop, the request failed),
   *  so the UI can say so instead of looking done. */
  cancelSubagent(runId: string): Promise<boolean>
  /** Grok MessageSubagent: talk to a side chat that has a Hermes session.
   *  Resolves false when the message didn't reach the helper. */
  messageSubagent?(runId: string, text: string): Promise<boolean>
  /**
   * Abort the turn currently running in this conversation.
   *
   * Absent on transports that cannot interrupt a run. The deploy transport
   * gates this on the gateway's `stop` control probe, so a stale deploy
   * without the route reports false rather than pretending to stop.
   * Returns true when a stop was actually issued.
   */
  stopTurn?(conversationId: string): Promise<boolean>
  /**
   * Re-send the conversation's last user message as a fresh turn. Powers the
   * in-chat Retry on a failed turn, where the original send is gone.
   * Returns true when a resend was issued.
   */
  retryTurn?(conversationId: string): Promise<boolean>
  /**
   * The user checked the transcript after a send whose delivery was unknown:
   * lift the duplicate-send guard so the chat can send again.
   */
  acknowledgeUncertain?(conversationId: string): void
  createAgent(partial?: NewAgentProfile): Promise<Agent>
  /**
   * Deploy transport only: add the roster row now and finish the VM-side
   * setup (hermes profile, SOUL, roster write) in the background. `ready`
   * rejects when that setup was refused; the row stays until the caller
   * rolls it back.
   */
  createAgentOptimistic?(partial?: NewAgentProfile): { agent: Agent; ready: Promise<void> }
  createGroup(partial?: { name?: string; memberAgentIds?: string[] }): Promise<Group>
  setGroupMembers(groupId: string, memberAgentIds: string[]): Promise<Group>
  /**
   * Rename a group or set its purpose (`summary`, which server-run rooms put
   * in every member's prompt). Naming a group stops auto-naming it.
   */
  updateGroup?(groupId: string, patch: { name?: string; summary?: string }): Promise<Group | null>
  /**
   * Deploy transport only: poll an OPEN group conversation's server-run room
   * feed (fast while a member turn is live, slow when idle, paused while
   * hidden). Returns the release function. A no-op poll when rooms are off.
   */
  watchRoom?(conversationId: string): () => void
  /**
   * Deploy transport only: re-send group member profiles (name, title, bio,
   * role) after an agent edit, for every group the agent is in.
   */
  syncGroupProfiles?(agentId?: string): void
  /** An agent's profile changed locally: persist the roster so the next
   *  hydrate doesn't restore the old copy. */
  saveAgentEdit?(agentId: string): void
  /** Drop an agent from the roster (after its hermes profile was deleted). */
  removeAgent?(agentId: string): Promise<void>
  subscribe(cb: (ev: TransportEvent) => void): () => void
  /**
   * Deploy transport only: user sends currently parked behind a live stream.
   * `[]` on transports that never park sends (mock/serve).
   */
  listQueuedMessages?(conversationId: string): QueuedMessageItem[]
  /**
   * Deploy transport only: remove a single parked send before it drains,
   * without touching the rest of the FIFO. No-op if already drained.
   */
  removeQueuedMessage?(conversationId: string, itemId: string): boolean
  getComputerUrl(agentId: string): Promise<{ url: string | null; provider: string }>
  respondPermission?(
    conversationId: string,
    choice: ToolPermissionChoice,
    opts?: { optionId?: string; requestId?: string },
  ): Promise<void>
  /**
   * Deploy transport only: read-only skills list from
   * `GET /api/chat/runs/:turnId/skills`. `[]` when the route is unsupported
   * (stale deploy), no turn is known yet, or the agent reports no skills.
   */
  listSkills?(): Promise<import('./types').DeploySkillEntry[]>
  /**
   * Generic gateway JSON-RPC door (serve transport). Plugins use this via
   * `host.request` for profiles.*, cron.manage, skills.manage, mcp.catalog,
   * image.generate, model.options, etc. Absent on transports that don't
   * expose raw RPC (mock/deploy).
   */
  request?<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}
