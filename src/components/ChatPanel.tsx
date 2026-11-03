import { useTurnControls } from './chat/useTurnControls'
import { useThreadGroups } from './chat/useThreadGroups'
import { TranscriptRow, ArtifactStack, copyTextOf, subagentDisplayName, transcriptRowShape } from './chat/TranscriptRow'
export { copyTextOf } from './chat/TranscriptRow'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  type ActivityPhase,
  type Agent,
  type ChatMessage,
  type LiveActivity,
  type QueuedMessageItem,
  type SubagentKind,
  type SubagentRun,
  type ToolActivityWhere,
  ACTIVITY_HOLD_MS,
  activityWhereLabel,
  formatActivityElapsed,
  holdLiveActivity,
  liveActivityFromMessages,
  permissionChoiceLabel,
} from '../lib/agents'
import type { PendingToolPermission, ToolPermissionChoice } from '../lib/agents'
import { AgentMascot as Pip, type AgentMascotPresence } from './AgentMascot'
import type { GrokOrbShape } from './FatCatIcon'
import { useWindowFocused } from '../lib/useWindowFocused'
import { fetchHermesSessionMessages } from '../lib/agents/hermes-sessions'
import { listHermesProfiles, profileToAgent } from '../lib/agents/hermes-profiles'
import { resolveSpawnToken, spawnSuggestions, type SpawnSuggestion } from '../lib/spawn-suggest'
import { displayUserPrompt, peerSpawnGoal, peerToken } from '../lib/peer-roster'
import { chatWallpaperClass, useChatWallpaper } from '../lib/chat-wallpaper'
import { findChatHits } from '../lib/search-index'
import {
  appendTranscript,
  dictateDeniedCopy,
  DictateEngine,
  initialDictateStatus,
  type DictateLike,
  type DictateStatus,
} from '../lib/dictate'
import {
  sttBridgeAvailable,
  sttStatus,
  transcribeAudio,
} from '../lib/stt'
import { VOICE_BAND_COUNT } from '../lib/voice-meter'
import { MessageBody } from './MessageBody'
import { DatePill, messengerDateLabel, messengerDayKey } from './chat/DatePill'
import { inferredPickedUpIds } from './chat/ReadTicks'
import { SessionFooter } from './chat/SessionFooter'
import { messageMascotPresence } from './chat/presence'
import { InlineApproval } from './chat/InlineApproval'
import { MessengerComposer } from './chat/MessengerComposer'
import { Button } from './ui/Button'
import { Icon } from './ui/icons'
import '../styles/skin-messenger.css'
import '../styles/desk-pages.css'
import { ReplyPill } from './ReplyQuote'
import { ThreadPane } from './ThreadPane'
import { useLiveMessages } from '../lib/agents/useLiveMessage'
import {
  repliesChipLabelForRoot,
  threadMessagesForRoot,
} from '../lib/threading'
import { applyComposerMiddleware, composerMiddlewareContributions } from '../plugins/areas'
import { replyPreviewForMessage } from './MessageActions'
import type { MessageReplyTo } from '../lib/agents'
import { AttachmentTray, type TrayAttachment } from './Attachments'
import { setAttachmentPreview } from '../lib/attachment-previews'
import { droppedFiles } from '../lib/dropped-files'
import { draftFor, setDraftFor } from '../lib/composer-drafts'
import { appendSkillRequest, genUiRequest, onSkillDraft, withGenUiPromptHint } from '../lib/skill-draft'
import { failedSend, type SendOutcome } from '../lib/agents/send-outcome'
import { RoomUsage } from './chat/RoomUsage'
import type { LocalRoomState } from '../lib/agents/local-rooms'
import { inlineImageDataUrl } from '../lib/image-prep'
import { LocalComputerIcon } from './WhereIcons'
import { hostMachinePhrase } from '../lib/host-label'
import { extractReplyMedia } from '../lib/reply-media'
import {
  artifactAnchorIndex,
  deriveProjectArtifacts,
  isOpenablePage,
  type ProjectArtifact,
} from '../lib/project-artifacts'
import { bubbleGroupPositions, type BubbleGroupPos } from '../lib/bubble-groups'
import { createBottomFollower, type BottomFollower } from '../lib/bottom-follow'
import { catchUpScrollTarget } from '../lib/catch-up-scroll'
import {
  insertMention,
  mentionCandidates,
  mentionQueryAt,
  type MentionCandidate,
  type MentionMember,
} from '../lib/mentions'
import type { HandoffStrip, RoomStatus } from '../lib/agents/rooms'
import { HandoffTranscriptModal } from './HandoffTranscriptModal'
import { AgentIdentityContext, type AgentIdentity } from './agent-identity'
import { AgentProfileCard, type AgentProfile } from './AgentProfileCard'
import { agentLook, roomLooks } from '../lib/agents/identity'
import { learnedRoomMember } from '../lib/agents/rooms'
import { isOrchestrator } from '../lib/peer-roster'
import { AgentPromptDock, useWaitingClarify, useWaitingOnUserText } from './AgentPromptDock'
import { tidyPastedText } from '../lib/composer-paste'
import { askAgainTarget, draftAfterEdit, resendableAttachments } from '../lib/chat-resend'
import { enterSends } from '../lib/composer-enter'
import { chatStarters, starterLabel } from '../lib/chat-starters'
import { renderCapture } from '../lib/render-capture'
import { ChatSessionContext } from './chat/ChatSessionContext'
import { isModelRouteError, type SessionModelRoute } from '../lib/agents/session-model'

interface ChatPanelProps {
  messages: ChatMessage[]
  skin?: 'messenger' | 'classic'
  /** Profile/model context supplied by the local transport or parent. */
  profile?: string
  model?: string
  provider?: string
  modelRoute?: SessionModelRoute
  onOpenModel?: () => void
  onOpenSkills?: () => void
  onInspectContext?: () => Promise<import('../lib/agents/session-context').SessionContextSnapshot>
  delegationActions?: import('../lib/agents/native-delegation').NativeDelegationActions
  /** In-app model switching for an individual chat. */
  modelActions?: import('./chat/ModelPicker').ModelActions
  /** User-message ids acknowledged by Hermes message.start. */
  pickedUpMessageIds?: ReadonlySet<string>
  /** Branch from the chosen bubble through the parent's session action. */
  onBranch?: (message: ChatMessage) => void
  /** Retain chat state, but suspend global interactions while another view covers it. */
  active?: boolean
  /** The transcript is still on its first fetch — show a skeleton, not the
   *  empty state (an unloaded thread is unknown, not empty). */
  transcriptLoading?: boolean
  /** A CACHED transcript is re-checking with the server: `behind` when newer
   *  messages are known to be on the way (pill at once), `checking`
   *  otherwise (pill only if the check runs long). */
  transcriptSyncing?: 'behind' | 'checking' | null
  /** The last transcript fetch failed and left no rows: offer a retry instead
   *  of the empty state (a failed load is unknown, not empty). */
  transcriptError?: boolean
  /** Re-run the transcript load for this thread (the transcriptError offer). */
  onRetryTranscript?: () => void
  /** The server has older history above the downloaded rows (paging). */
  historyHasMore?: boolean
  /** An older server page is being fetched. */
  historyLoadingOlder?: boolean
  /** Fetch the next older server page (prepended to `messages`). */
  onLoadOlder?: () => unknown
  /** No usable conversation: disable drafting as well as sending. */
  disabled?: boolean
  /** Server actions are unavailable; local drafting can continue. */
  readOnly?: boolean
  statusLine?: string | null
  sending?: boolean
  /** When set, overrides composer mark (thinking/working/error/idle). */
  activityState?: ActivityPhase | 'happy'
  threadKey: string
  /** Live subagents for the parent of this thread (typing-indicator hint). */
  liveSubagents?: SubagentRun[]
  /** Grok Bot parity: subagents pulled INTO this conversation (side chats). */
  conversationSubagents?: SubagentRun[]
  /** Resolve agent display name for DM chips / group speakers. */
  agentName?: (id: string) => string
  onSend: (
    text: string,
    opts?: {
      replyTo?: MessageReplyTo
      /** Files already on the agent computer, sent with this message. */
      attachments?: { name: string; path: string; kind: 'file' | 'image'; size?: number }[]
      /** Small attached images, also shown to the agent directly. */
      images?: string[]
    },
  ) => void | SendOutcome | Promise<void | SendOutcome>
  /** Grok Add reaction — Hermes `message.react` when the session exists. */
  onReact?: (message: ChatMessage, emoji: string | null) => void
  onChoice?: (choiceId: string, label: string) => void
  /** Slash-command actions (UI-level). Hermes commands pass through as text. */
  onOpenKanban?: () => void
  onOpenPreview?: (artifact: ProjectArtifact) => void
  onOpenHost?: (artifact: ProjectArtifact) => void
  onDownloadProject?: (artifact: ProjectArtifact) => void
  onOpenFile?: (path: string) => void
  onSaveFileToMac?: (path: string) => void
  onCopyToBox?: () => void
  /** Local files dropped or picked in the composer (images + text). */
  /** Uploads to the agent computer; `onUploaded` reports each file (by index) as it lands or fails. */
  onAttachLocalFiles?: (files: File[], onUploaded?: (result: AttachUploadResult) => void) => void
  onPickAttachments?: () => Promise<{ name: string; path: string; kind: 'file' | 'image'; size?: number }[]>
  todos?: unknown[]
  usage?: Record<string, unknown>
  localRoom?: LocalRoomState
  onSetRoomBudget?: (limit: number) => Promise<boolean>
  mascotPresence?: AgentMascotPresence
  /** Agent VM cwd — used to attach Preview/Host cards to this thread. */
  cwd?: string
  onOpenSettings?: () => void
  onOpenPlugins?: () => void
  onNewAgent?: () => void
  onNewConversation?: () => void
  /** Grok Bot parity: spawn a separate agent into this conversation (sub-thread). */
  onSpawnSubagent?: (kind: SubagentKind, goal: string, label?: string) => Promise<SubagentRun | null>
  /** Resolve false when the stop didn't reach the agent: the chat says so. */
  onCancelSubagent?: (runId: string) => void | Promise<boolean>
  /** Resolve false when the message didn't reach the helper: the chat says
   *  so and puts the text back in the box. */
  onMessageSubagent?: (runId: string, text: string) => void | Promise<boolean>
  /** Pending Hermes `approval.request` — Grok local-tool permission dock. */
  permissionAsk?: PendingToolPermission | null
  onPermission?: (choice: ToolPermissionChoice, opts?: { optionId?: string }) => void
  /** Abort the in-flight turn. Wired to the transport's stop control; when
   *  absent the composer shows no stop affordance (transports that cannot
   *  interrupt a run). */
  onStopTurn?: () => void | Promise<unknown>
  /** Resend the last user message after a failed turn. */
  onRetryTurn?: () => void | Promise<unknown>
  /** The user checked the transcript after an uncertain send; sends may resume. */
  onAcknowledgeUncertain?: (threadKey: string) => void | Promise<unknown>
  /** Drop a send parked in the offline outbox (keyed by message id). */
  onDiscardPending?: (messageId: string) => void
  /** Grok Bot parity: the in-chat working mascot is the TARGET AGENT's
   *  mascot (customized shape/color, else seed-derived) — never a hardcoded
   *  default cat. */
  mascot?: { shape?: GrokOrbShape; color?: string }
  /** Number of user sends parked behind the current live stream (0 = none).
   *  Drives the "N queued" badge on the activity line so a mid-stream send
   *  is visibly acknowledged instead of silently swallowed. */
  queuedCount?: number
  /** The parked sends themselves (deploy transport FIFO) — powers the
   *  click-to-view queue popover on the badge. */
  queuedItems?: QueuedMessageItem[]
  /** Remove a single parked send before it drains. */
  onRemoveQueued?: (itemId: string) => void
  /** Jump-to-message from the global search palette. */
  focusMessageId?: string | null
  onFocusMessageHandled?: () => void
  /** Name of the parent conversation's agent — side-chat header. */
  parentAgentName?: string
  /** Group rooms: label each agent bubble with who spoke. */
  showAgentSpeaker?: boolean
  /** Roster used to autofill `/spawn` with Hermes profiles / agents. */
  agents?: Agent[]
  /** Local tool activity location. */
  toolWhere?: ToolActivityWhere
  /** Server-run group room: presence line, pass line and liveness (drives
   *  the stop control even before any member has typed a word). */
  roomStatus?: RoomStatus | null
  /** Hand-off strips for a server-run room, keyed by transcript row id. */
  roomHandoffs?: ReadonlyMap<string, HandoffStrip> | null
  /** Every strip in the open room incl. human-started turns (hand-off modal
   *  threads follow-up replies through these). */
  roomThreadStrips?: ReadonlyMap<string, HandoffStrip> | null
  /** Profile card → "Message": open (or create) the 1:1 chat with an agent. */
  onOpenAgent?: (agentId: string) => void
  /** Group members for the composer's @mention picker (`@everyone` is added). */
  mentionMembers?: MentionMember[]
  /** The agent this chat is with: picks the empty chat's starter prompts. */
  starterAgent?: Agent | null
}

export type AttachUploadResult =
  | { index: number; path: string; kind: 'file' | 'image'; error?: undefined }
  | { index: number; error: string; path?: undefined; kind?: undefined }

function isShowableImageFile(file: File): boolean {
  return file.type ? /^image\/(png|jpeg|gif|webp|svg\+xml)$/i.test(file.type)
    : /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)
}

function isFileNamePaste(text: string, files: File[]): boolean {
  if (!files.length || !text.trim()) return false
  const names = new Set(files.map((file) => file.name))
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .every((line) => names.has(line) || names.has(line.slice(line.lastIndexOf('/') + 1)))
}

/**
 * Slash commands handled BY THE APP (UI actions). Anything else starting
 * with '/' is forwarded to the agent chat verbatim — Hermes understands its
 * own 95 slash commands (/memory, /skills, /plan, /tasks, /model, …), so
 * those just work end-to-end when the backend is a Hermes agent.
 */
const APP_SLASH: { cmd: string; label: string; detail: string; run: (p: SlashActions) => void }[] = [
  { cmd: '/kanban', label: 'Open Kanban board', detail: 'tasks · swarm · multi-agent', run: (p) => p.onOpenKanban?.() },
  { cmd: '/send-file', label: 'Send a file to the agent computer', detail: 'copy · to-box', run: (p) => p.onCopyToBox?.() },
  { cmd: '/plugins', label: 'Open Plugins', detail: 'MCP servers · tools', run: (p) => p.onOpenPlugins?.() },
  { cmd: '/settings', label: 'Open Settings', detail: 'app config', run: (p) => p.onOpenSettings?.() },
  { cmd: '/new-agent', label: 'Create a new agent', detail: 'agents', run: (p) => p.onNewAgent?.() },
  { cmd: '/new', label: 'New conversation', detail: 'fresh thread', run: (p) => p.onNewConversation?.() },
  { cmd: '/spawn', label: 'Spawn a subagent', detail: 'profile · agent · kind', run: (p) => p.setSpawnDraft?.() },
  { cmd: '/loop', label: 'Loop a prompt on an interval', detail: '5m · self-paced · --times N · --until', run: (p) => p.setLoopDraft?.() },
  { cmd: '/genui', label: 'Prepare GenUI card (render_ui)', detail: 'stat · table · bar_chart · checklist', run: (p) => p.setGenUiDraft?.() },
  { cmd: '/help', label: 'Show slash commands', detail: 'app + hermes commands pass through', run: (p) => p.onHelp?.() },
]

interface SlashActions {
  onOpenKanban?: () => void
  onCopyToBox?: () => void
  onOpenSettings?: () => void
  onOpenPlugins?: () => void
  onNewAgent?: () => void
  onNewConversation?: () => void
  onHelp?: () => void
  /** Fill the composer with the /spawn scaffold so the user can finish it. */
  setSpawnDraft?: () => void
  setLoopDraft?: () => void
  setGenUiDraft?: () => void
}

function slashAvailable(cmd: string, p: SlashActions): boolean {
  if (cmd === '/kanban') return Boolean(p.onOpenKanban)
  if (cmd === '/send-file') return Boolean(p.onCopyToBox)
  if (cmd === '/plugins') return Boolean(p.onOpenPlugins)
  return true
}

/** Subagent kinds valid for `/spawn <kind> <goal>` — mirrors src/lib/spawn.ts. */
function ChainIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[var(--ca-ink-muted)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 9.5l3-3M7 11.5l-1.2 1.2a2.2 2.2 0 11-3.1-3.1L4 8.4M9 4.5l1.2-1.2a2.2 2.2 0 113.1 3.1L12 7.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** A file attached in the composer, held until the message is sent. */
interface ComposerAttachment extends TrayAttachment {
  /** Where it landed on the agent computer. */
  path?: string
  /** data: URL of a small image, sent inline so the agent can see it. */
  inline?: string
}

const EMPTY_ATTACHMENTS: ComposerAttachment[] = []

function PaperclipIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 8.5l4-4a2.12 2.12 0 013 3l-5.2 5.2a3.2 3.2 0 11-4.5-4.5L9.2 3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 8a4.5 4.5 0 009 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 12.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m3.5 7 4.5-4.5L12.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** How long after a wheel/touch/key/scrollbar gesture a `scroll` event still
 *  counts as the user's own (see userScrollIntentAtRef). */
const USER_SCROLL_INTENT_MS = 1000
/** How far above the bottom the reader must be for the jump pill. */
const JUMP_BUTTON_AFTER_PX = 320

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** Grok-parity dictation waveform — REAL mic EQ. The local recorder gives us a
 *  live MediaStream, so each bar is one frequency band from the FFT spectrum
 *  (bass → treble → looks like a real visualizer), not a shared volume pulse. */
function VoiceBars({ className, levels }: { className?: string; levels: number[] }) {
  // M4: will-change only while the meter is live (see index.css).
  return (
    <span
      className={`ca-voice-bars ${className ?? ''}`}
      aria-hidden="true"
      data-live={levels.some((l) => l > 0.13) ? 'true' : undefined}
    >
      {Array.from({ length: VOICE_BAND_COUNT }, (_, i) => {
        const band = levels[i] ?? 0
        // Resting floor 0.12 → loud 0.94. The meter's band values are already
        // compressed; keep the display linear so silences look quiet.
        const scale = Math.max(0.12, Math.min(0.94, 0.12 + band * 0.82))
        return <span key={i} style={{ transform: `scaleY(${scale.toFixed(3)})` }} />
      })}
    </span>
  )
}

/** Format elapsed dictation seconds as m:ss. */
const formatDictateTime = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Grok sand-activity-line: mascot + verb, docked above the composer
 *  (not inside the overflowing transcript — that clips the 42px mark). */
function ActivityLine({
  mascot,
  text,
  markState,
  agentId = 'default',
  presence,
  where,
  queuedCount = 0,
  queuedItems = [],
  onRemoveQueued,
  leaving = false,
  turnControl,
}: {
  /** Row is collapsing away: freeze the mascot, hide from assistive tech. */
  leaving?: boolean
  mascot?: { shape?: GrokOrbShape; color?: string; eye?: string }
  text: string
  markState: import('./FatCatIcon').CatExpression
  agentId?: string
  presence?: AgentMascotPresence
  where?: ToolActivityWhere
  queuedCount?: number
  /** The parked sends themselves (deploy transport FIFO). Empty on
   *  transports that don't park sends — the badge then has no popover. */
  queuedItems?: QueuedMessageItem[]
  onRemoveQueued?: (itemId: string) => void
  turnControl?: { stopping: boolean; onStop: () => void }
}) {
  const focused = useWindowFocused()
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [queueOpen, setQueueOpen] = useState(false)
  const queueRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    startedAt.current = Date.now()
    setNow(Date.now())
  }, [text])
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  // Close the queue popover on outside click or Escape (non-intrusive: it
  // never steals focus on open, only on explicit keyboard interaction).
  useEffect(() => {
    if (!queueOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (queueRef.current && !queueRef.current.contains(e.target as Node)) setQueueOpen(false)
    }
    const onKeyDown = ((e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setQueueOpen(false)
    }) as EventListener
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [queueOpen])
  // Queue drained while the popover was open → close it.
  useEffect(() => {
    if (queueOpen && queuedCount === 0) setQueueOpen(false)
  }, [queueOpen, queuedCount])
  const elapsed = formatActivityElapsed(now - startedAt.current)
  // All tools run on this Mac.
  const WhereIcon = LocalComputerIcon
  const whereLabel = where ? activityWhereLabel(where) : null
  const canInspectQueue = queuedItems.length > 0 || (queuedCount > 0 && onRemoveQueued != null)
  return (
    <div
      className={`ca-activity-in flex shrink-0 items-center gap-3 px-5 pb-2 pt-1${turnControl ? ' desk-run-control' : ''}`}
      data-testid={turnControl ? 'current-run' : undefined}
      data-role={leaving ? undefined : 'assistant'}
      data-activity={leaving ? undefined : text}
      aria-hidden={leaving || undefined}
    >
      <span className="shrink-0">
        <Pip agentId={agentId} profile={mascot?.color ? { ui_meta: { accent_color: mascot.color } } : undefined} presence={presence ?? (markState === 'error' ? 'error' : markState === 'thinking' ? 'thinking' : 'tool')} reducedMotion={!focused || leaving ? true : undefined} size={32} />
      </span>
      <span className="min-w-0 truncate text-[15px] font-medium text-[var(--ca-ink)]"
        role={turnControl ? 'status' : undefined} aria-live={turnControl ? 'polite' : undefined}>
        {/* Keyed on the verb: a new step ("Reading files…") crossfades in and
            restarts the sheen. The elapsed suffix stays solid. */}
        <span key={text} className="ca-activity-verb">
          {text}
        </span>
        {elapsed ? (
          <span className="font-normal text-[var(--ca-ink-muted)]">{` · ${elapsed}`}</span>
        ) : null}
      </span>
      {where ? (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]"
          role="img"
          aria-label={whereLabel ?? undefined}
          title={whereLabel ?? undefined}
          data-role="activity-where"
          data-where={where}
        >
          <WhereIcon size={11} />
          {`On ${hostMachinePhrase()}`}
        </span>
      ) : null}
      {queuedCount > 0 ? (
        <div ref={queueRef} className="relative shrink-0">
          {canInspectQueue ? (
            <button
              type="button"
              data-role="queued-count"
              aria-expanded={queueOpen}
              aria-label={`${queuedCount} message${queuedCount === 1 ? '' : 's'} waiting behind the current reply — view queue`}
              title="Messages waiting behind the current reply — click to view"
              onClick={() => setQueueOpen((v) => !v)}
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--ca-ink)] ring-1 ring-[var(--ca-primary)]/50 transition-colors hover:bg-[var(--ca-primary)]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ca-primary)]"
            >
              {queuedCount} queued
            </button>
          ) : (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--ca-ink)] ring-1 ring-[var(--ca-primary)]/50"
              data-role="queued-count"
              title="Messages waiting behind the current reply"
            >
              {queuedCount} queued
            </span>
          )}
          {queueOpen && canInspectQueue ? (
            <div
              data-role="queued-popover"
              role="dialog"
              aria-label="Queued messages"
              className="absolute bottom-full right-0 z-40 mb-2 w-72 overflow-hidden rounded-xl border border-[var(--ca-border)] bg-[var(--ca-surface)] shadow-lg shadow-black/20"
            >
              <div className="flex items-center justify-between border-b border-[var(--ca-border)] px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ca-ink-muted)]">
                  Queued messages
                </span>
                <span className="text-[11px] text-[var(--ca-ink-muted)]">{queuedCount}</span>
              </div>
              <ul className="max-h-56 overflow-y-auto py-1" data-role="queued-list">
                {queuedItems.map((item, idx) => (
                  <li
                    key={item.id}
                    className="group flex items-start gap-2 px-3 py-2 hover:bg-[var(--ca-primary)]/5"
                    data-role="queued-item"
                  >
                    <span className="mt-0.5 w-4 shrink-0 text-[10px] font-medium tabular-nums text-[var(--ca-ink-muted)]">
                      {idx + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--ca-ink)]">
                      {item.text}
                    </span>
                    {onRemoveQueued ? (
                      <button
                        type="button"
                        data-role="queued-remove"
                        aria-label="Remove queued message"
                        title="Remove — this message won't be sent"
                        onClick={() => onRemoveQueued(item.id)}
                        className="shrink-0 rounded p-0.5 text-[var(--ca-ink-muted)] opacity-0 transition-opacity hover:text-[var(--ca-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="border-t border-[var(--ca-border)] px-3 py-1.5 text-[10px] text-[var(--ca-ink-muted)]">
                Sent in order when the current reply finishes
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {turnControl && !leaving && (
        <Button size="sm" variant="danger" data-testid="stop-turn" aria-label="Stop the agent"
          title="Stop this reply (⌘. stops every agent)"
          disabled={turnControl.stopping} onClick={turnControl.onStop}>
          <Icon name="stop" size={16} />{turnControl.stopping ? 'Stopping…' : 'Stop'}
        </Button>
      )}
    </div>
  )
}

/** True when a keyboard event originates inside a text-entry field. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/** Right after a thread opens, following snaps instead of gliding. */
const THREAD_OPEN_SNAP_MS = 600
/** How long the activity line's row takes to collapse (see .ca-activity-slot). */
const ACTIVITY_EXIT_MS = 240

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function PermissionDock({
  ask,
  onChoice,
}: {
  ask: PendingToolPermission
  onChoice: (choice: ToolPermissionChoice, opts?: { optionId?: string }) => void
}) {
  const busy = ask.status === 'submitting'
  // A1 widget-question variant (Grok sand-widget--choices): canned answer
  // chips resolved through the same approval RPC. No options → legacy buttons.
  const options = ask.kind === 'question' || ask.options?.length ? (ask.options ?? []) : null
  if (options && options.length > 0) {
    return (
      <div
        role="region"
        aria-label="Agent question"
        className="mb-2 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2.5 shadow-[var(--ca-shadow-soft)]"
      >
        <p className="text-sm font-medium text-[var(--ca-ink)]">
          {ask.description?.trim() || 'The agent has a question for you.'}
        </p>
        {ask.command?.trim() ? (
          <pre className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--ca-ink-muted)]">
            {ask.command.trim()}
          </pre>
        ) : null}
        {ask.status === 'failed' && (
          <p className="mt-1 text-[11px] text-[var(--ca-danger)]">
            Your answer didn't go through. Check your connection and try again.
          </p>
        )}
        <div role="group" aria-label="Choose an answer" className="mt-2 flex flex-wrap gap-1.5">
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              title={o.hint ? `${o.label} — ${o.hint} (key ${i + 1})` : `Key ${i + 1}`}
              onClick={() => onChoice('once', { optionId: o.id })}
              className="sand-widget-option rounded-full border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1 text-[11px] font-medium text-[var(--ca-ink)] transition hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-primary-text)] disabled:opacity-50"
            >
              <span className="mr-1 opacity-50">{i + 1}</span>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  const actions = ask.choices.filter((c) => c !== 'deny')
  const canDeny = ask.choices.includes('deny')
  const primary = actions.includes('always') ? 'always' : actions[0]
  const detail = ask.command?.trim() || ask.description?.trim() || ''
  return (
    <div
      role="region"
      aria-label="Local tool permissions"
      className="mb-2 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2.5 shadow-[var(--ca-shadow-soft)]"
    >
      <p className="text-sm font-medium text-[var(--ca-ink)]">
        {ask.memberName ? `${ask.memberName} needs approval to run a command on your computer.` : 'Allow this agent to run a command on your computer?'}
      </p>
      {ask.risk === 'high-stakes' ? (
        <p className="mt-1 text-[11px] text-[var(--ca-ink-muted)]">
          Money moves need your approval each time — no standing grants are offered here.
        </p>
      ) : null}
      {detail ? (
        <pre className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--ca-ink-muted)]">
          {detail}
        </pre>
      ) : null}
      {ask.status === 'failed' && (
        <p className="mt-1 text-[11px] text-[var(--ca-danger)]">
          Your answer didn't go through. Check your connection and try again.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actions.map((c) => (
          <button
            key={c}
            type="button"
            disabled={busy}
            onClick={() => onChoice(c)}
            className={
              c === primary
                ? 'nub-btn-primary px-2.5 py-1 text-[11px] disabled:opacity-50'
                : 'rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink)] hover:bg-[var(--ca-hover)] disabled:opacity-50'
            }
          >
            {permissionChoiceLabel(c)}
          </button>
        ))}
        {canDeny && (
          <button
            type="button"
            disabled={busy}
            title="Deny once (Esc)"
            onClick={() => onChoice('deny')}
            className="rounded-full px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)] disabled:opacity-50"
          >
            Deny once
          </button>
        )}
      </div>
    </div>
  )
}

function useHeldLiveActivity(live: LiveActivity): LiveActivity {
  const [hold, setHold] = useState(() => ({
    shown: live,
    shownAtMs: Date.now(),
    queued: null as LiveActivity | null,
  }))
  useEffect(() => {
    setHold((prev) => holdLiveActivity(prev, live, Date.now()))
  }, [live])
  useEffect(() => {
    if (!hold.queued) return
    const wait = Math.max(0, ACTIVITY_HOLD_MS - (Date.now() - hold.shownAtMs))
    const id = window.setTimeout(() => {
      setHold((prev) => {
        if (!prev.queued) return prev
        return { shown: prev.queued, shownAtMs: Date.now(), queued: null }
      })
    }, wait)
    return () => window.clearTimeout(id)
  }, [hold.queued, hold.shownAtMs])
  return hold.shown
}

/** Subagent-window reply: `MEDIA:` tags stripped, their images shown below. */
function ReplyWithMedia({ content }: { content: string }) {
  const media = extractReplyMedia(content)
  return (
    <>
      <MessageBody content={media.text} variant="markdown" />
      {media.inline.map((img, i) => (
        <img key={i} src={img.dataUrl} alt="Image from the agent" className="max-w-full rounded-xl" />
      ))}
    </>
  )
}

/** First-open intro while a thread's first fetch is in flight — the same
 *  language as the web intro (WebConnect): the agent's own Grok orb in its
 *  `loading` whirl, centred, with the caption easing in beneath it. No
 *  placeholder bubbles. While the transcript is loading the activity line
 *  is not shown, so this is still the one live mascot on screen
 *  (docs/CHAT_LOAD_AND_MOTION_SPEC.md M1). */
function TranscriptIntro({ mascot }: { mascot?: { shape?: GrokOrbShape; color?: string } }) {
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="transcript-intro"
      className="flex min-h-[55vh] flex-col items-center justify-center text-center"
    >
      <div className="ca-enter">
        <Pip agentId={mascot?.color ?? 'default'} presence="thinking" size={64} />
      </div>
      <p
        className="ca-enter mt-4 text-[13px] text-[var(--ca-ink-muted)]"
        style={{ '--i': 2 } as CSSProperties}
      >
        Opening conversation…
      </p>
    </div>
  )
}

/** An unproven re-check shows its pill only past this, so a quick refresh
 *  never flashes it. */
const SYNC_CHECKING_HINT_MS = 700

/**
 * A cached thread re-checking with the server. Floats over the transcript
 * (never in the flow, so it cannot move the rows or fight stick-to-bottom).
 * `behind`: newer messages are known to be coming, shown at once.
 * `checking`: shown only if the check outlasts SYNC_CHECKING_HINT_MS.
 */
function TranscriptSyncPill({ mode, className }: { mode: 'behind' | 'checking'; className: string }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (mode !== 'checking') return
    const id = window.setTimeout(() => setLate(true), SYNC_CHECKING_HINT_MS)
    return () => window.clearTimeout(id)
  }, [mode])
  if (mode === 'checking' && !late) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="transcript-sync"
      data-mode={mode}
      className={`nub-glass nub-glass-solid ca-sync-pill pointer-events-none absolute bottom-3 z-20 flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink-muted)] shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)] ${className}`}
    >
      <span aria-hidden className="flex items-center gap-[3px]">
        <span className="typing-dot ca-sync-dot" />
        <span className="typing-dot ca-sync-dot" />
        <span className="typing-dot ca-sync-dot" />
      </span>
      {mode === 'behind' ? 'Loading new messages' : 'Checking for new messages'}
    </div>
  )
}

const EMPTY_ARTIFACTS: ProjectArtifact[] = []
Object.freeze(EMPTY_ARTIFACTS)
const EMPTY_MENTION_MEMBERS: MentionMember[] = []
function TranscriptDays({ skin, messages, children }: { skin: 'messenger' | 'classic'; messages: ChatMessage[]; children: ReactNode[] }) {
  if (skin === 'classic') return <>{children}</>
  const days: { key: string; date: string; rows: ReactNode[] }[] = []
  messages.forEach((message, i) => {
    const key = messengerDayKey(message.createdAt)
    const previous = days[days.length - 1]
    if (previous?.key === key) previous.rows.push(children[i])
    else days.push({ key, date: message.createdAt, rows: [children[i]] })
  })
  return <>{days.map((day, i) => <div className="messenger-day" key={`${day.key}:${i}`}><DatePill date={day.date} />{day.rows}</div>)}</>
}

/** ThreadPane over live rows: a reply streaming inside an open thread keeps
 *  growing without re-rendering the panel around it. */
function LiveThreadPane(props: ComponentProps<typeof ThreadPane>) {
  const messages = useLiveMessages(props.messages)
  return <ThreadPane {...props} messages={messages} />
}

export function SideChatHeader({
  parentName,
  parentMascot,
  childLabel,
  childRunning,
}: {
  parentName?: string
  parentMascot?: { shape?: GrokOrbShape; color?: string }
  childLabel: string
  childRunning: boolean
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ca-border)] px-4 py-2">
      <Pip agentId={parentName ?? parentMascot?.color ?? 'default'} size={18} reducedMotion />
      <span className="text-sm font-medium text-[var(--ca-ink)]">{parentName ?? 'Agent'}</span>
      <ChainIcon />
      {/* M1: the header text and the activity line carry the motion — a
          second running engine here doubles vzt loops on the chat path. */}
      <Pip agentId={childLabel} size={18} presence={childRunning ? 'tool' : 'idle'} reducedMotion />
      <span className="text-sm font-medium text-[var(--ca-ink)]">{childLabel}</span>
    </div>
  )
}

function SideChatFooter({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--ca-ink-muted)]">
        <LockIcon />
        This chat is view-only
      </span>
      <button
        type="button"
        onClick={onClose}
        className="rounded-full px-3 py-1 text-xs font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)]"
      >
        Close Chat
      </button>
    </div>
  )
}

/** Read-only side chat: a spawned subagent is a separate agent session. */
function SubagentThreadView({
  run,
  parentName,
  parentMascot,
}: {
  run: SubagentRun | null
  parentName?: string
  parentMascot?: { shape?: GrokOrbShape; color?: string }
}) {
  const [transcript, setTranscript] = useState<ChatMessage[]>([])
  useEffect(() => {
    if (!run?.hermesSessionId) {
      setTranscript([])
      return
    }
    let cancelled = false
    void fetchHermesSessionMessages(run.hermesSessionId).then((msgs) => {
      if (!cancelled) setTranscript(msgs)
    })
    return () => {
      cancelled = true
    }
  }, [run?.hermesSessionId, run?.status, run?.digests.length])

  if (!run) return null
  const childLabel = subagentDisplayName(run.kind, run.label)
  const talking = transcript.length > 0 ? transcript : null

  const speakerRow = (who: 'parent' | 'child', body: ReactNode, key: string) => (
    <div key={key} className="flex items-start gap-2">
      <Pip agentId={who === 'parent' ? parentName ?? parentMascot?.color ?? 'default' : childLabel} size={18} reducedMotion />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-[var(--ca-ink-muted)]">
          {who === 'parent' ? (parentName ?? 'Agent') : childLabel}
        </p>
        {body}
      </div>
    </div>
  )

  return (
    <div className="space-y-3">
      {talking &&
        talking.map((m) =>
          speakerRow(
            m.role === 'user' ? 'parent' : 'child',
            <div
              className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-[var(--ca-bubble-user)] text-white'
                  : 'border border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)]'
              }`}
            >
              {m.role === 'user' ? (
                <MessageBody content={displayUserPrompt(m.content)} variant="plain" />
              ) : (
                <ReplyWithMedia content={m.content} />
              )}
            </div>,
            m.id,
          ),
        )}

      {!talking &&
        run.digests.map((d) =>
          speakerRow(
            'child',
            <div className="rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3.5 py-2.5 text-sm text-[var(--ca-ink)]">
              <ReplyWithMedia content={d.text} />
            </div>,
            d.id,
          ),
        )}

      {run.result?.summary &&
        speakerRow(
          'child',
          <div className="rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3.5 py-2.5 text-sm text-[var(--ca-ink)]">
            <ReplyWithMedia content={run.result.summary} />
          </div>,
          'result',
        )}

      {run.error && (
        <div className="rounded-2xl border border-[var(--ca-danger)]/40 bg-[var(--ca-danger)]/10 px-3.5 py-2.5 text-sm text-[var(--ca-danger)]">
          {run.error}
        </div>
      )}
    </div>
  )
}

export const ChatPanel = memo(function ChatPanel({
  messages,
  skin = 'messenger',
  profile: profileName,
  model = 'Profile default',
  provider,
  modelRoute,
  onOpenModel,
  onOpenSkills,
  onInspectContext,
  delegationActions,
  modelActions,
  pickedUpMessageIds,
  onBranch,
  active = true,
  transcriptLoading = false,
  transcriptSyncing = null,
  transcriptError = false,
  onRetryTranscript,
  historyHasMore = false,
  historyLoadingOlder = false,
  onLoadOlder,
  disabled: disabledProp,
  readOnly = false,
  statusLine,
  sending,
  threadKey,
  liveSubagents = [],
  conversationSubagents = [],
  agentName,
  onSend,
  onReact,
  onChoice,
  onOpenKanban,
  onOpenPreview,
  onOpenHost,
  onDownloadProject,
  onOpenFile,
  onSaveFileToMac,
  onCopyToBox,
  onAttachLocalFiles,
  onPickAttachments,
  todos,
  usage,
  mascotPresence,
  cwd,
  onOpenSettings,
  onOpenPlugins,
  onNewAgent,
  onNewConversation,
  onSpawnSubagent,
  onCancelSubagent,
  onMessageSubagent,
  mascot,
  parentAgentName,
  showAgentSpeaker = false,
  agents = [],
  permissionAsk = null,
  onPermission,
  onStopTurn,
  onRetryTurn,
  onAcknowledgeUncertain,
  onDiscardPending,
  focusMessageId = null,
  onFocusMessageHandled,
  queuedCount = 0,
  queuedItems = [],
  onRemoveQueued,
  roomStatus = null,
  roomHandoffs = null,
  roomThreadStrips = null,
  onOpenAgent,
  mentionMembers = EMPTY_MENTION_MEMBERS,
  starterAgent = null,
  localRoom,
  onSetRoomBudget,
}: ChatPanelProps) {
  const disabled = disabledProp || readOnly
  const toolWhere: ToolActivityWhere = 'mac'
  // The unsent text belongs to its conversation (lib/composer-drafts.ts):
  // switching chats swaps it, and a reload keeps it.
  const draftThreadRef = useRef(threadKey)
  draftThreadRef.current = threadKey
  const [draftBox, setDraftBox] = useState(() => ({ thread: threadKey, text: draftFor(threadKey) }))
  const draft = draftBox.thread === threadKey ? draftBox.text : draftFor(threadKey)
  const setDraft = useCallback((next: string | ((prev: string) => string)) => {
    const thread = draftThreadRef.current
    setDraftBox((box) => {
      const prev = box.thread === thread ? box.text : draftFor(thread)
      return { thread, text: typeof next === 'function' ? next(prev) : next }
    })
  }, [])
  useEffect(() => {
    setDraftFor(draftBox.thread, draftBox.text)
  }, [draftBox])
  const submitGenerationRef = useRef(0)
  const pendingMiddlewareRef = useRef<symbol | null>(null)
  const pendingSendsRef = useRef(new Set<string>())
  const [pendingSends, setPendingSends] = useState<ReadonlySet<string>>(new Set())
  const [sendFailures, setSendFailures] = useState<Record<string, SendOutcome['status']>>({})
  const sendHeld = pendingSends.has(threadKey) || sendFailures[threadKey] === 'uncertain'
  useEffect(() => () => {
    submitGenerationRef.current += 1
    pendingMiddlewareRef.current = null
  }, [threadKey, disabled, active])
  // Files attached in the composer: uploaded right away, held as chips, and
  // sent with the next message (per thread, so switching chats keeps them).
  const [attachedByThread, setAttachedByThread] = useState<Record<string, ComposerAttachment[]>>({})
  const [pickingAttachments, setPickingAttachments] = useState<string | null>(null)
  const pendingAttachmentPickRef = useRef<string | null>(null)
  const [attachmentError, setAttachmentError] = useState<{ thread: string; text: string } | null>(null)
  const pickingHere = pickingAttachments === threadKey
  const [activeDate, setActiveDate] = useState(messages.at(-1)?.createdAt ?? '')
  useEffect(() => { setActiveDate(messages.at(-1)?.createdAt ?? '') }, [threadKey])
  const attached = attachedByThread[threadKey] ?? EMPTY_ATTACHMENTS
  // The picked files behind chips still uploading or failed, for Retry.
  const attachmentFilesRef = useRef(new Map<string, File>())
  const attachUploading = attached.some((a) => a.status === 'uploading')
  /** The thread whose message waits for its uploads (see handleSubmit). */
  const [sendQueued, setSendQueued] = useState<{ thread: string; waitingOn: string[] } | null>(null)
  const queuedHere = sendQueued?.thread === threadKey
  const submitRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!queuedHere || attachUploading) return
    const waitedOn = sendQueued?.waitingOn ?? []
    setSendQueued(null)
    // One of the files it waited on failed: the message holds, and the
    // reader decides (retry or remove it, then send).
    if (attached.some((a) => a.status === 'failed' && waitedOn.includes(a.id))) return
    submitRef.current()
  }, [queuedHere, attachUploading, attached, sendQueued])
  const attachReady = attached.filter((a) => a.status === 'ready')
  /** Composer caret (the @mention picker reads the token under it). */
  const [caret, setCaret] = useState(0)
  /** Caret to restore after a programmatic draft edit (mention insert). */
  const pendingCaretRef = useRef<number | null>(null)
  /** `@` position whose picker the user dismissed with Escape. */
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null)
  /** Pass line the user closed (hidden until the text changes). */
  // Dismissed pass lines, keyed by room + thread + text: hiding one never
  // hides the same words in another room or a later thread.
  const [hiddenPassLines, setHiddenPassLines] = useState<ReadonlySet<string>>(() => new Set())
  const [replyTarget, setReplyTarget] = useState<MessageReplyTo | null>(null)
  // A1: brief Grok sand-widget--resolved flash after answering a question chip.
  const [widgetResolved, setWidgetResolved] = useState<string | null>(null)
  const widgetResolveTimer = useRef<number | null>(null)
  // A4: open reply-thread pane (root message id), with viewport tracking so
  // the pane flips between drawer (>720px) and full-screen sheet (≤720px).
  const [threadRootId, setThreadRootId] = useState<string | null>(null)
  const [quoteJumpId, setQuoteJumpId] = useState<string | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  )
  const [slashSel, setSlashSel] = useState(0)
  const pickerId = useId()
  const [activeSubagentId, setActiveSubagentId] = useState<string | null>(null)
  const [liveProfiles, setLiveProfiles] = useState<Agent[]>([])
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null)
  /** Hand-off transcript modal: the strip's row + the pill that opened it. */
  const [handoffView, setHandoffView] = useState<{ rowId: string; turnId: string } | null>(null)
  const openHandoff = useCallback((rowId: string, turnId: string) => setHandoffView({ rowId, turnId }), [])
  const closeHandoff = useCallback(() => setHandoffView(null), [])
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [dictateStatus, setDictateStatus] = useState<DictateStatus>(initialDictateStatus)
  const [dictateSeconds, setDictateSeconds] = useState(0)
  const [dictateLevels, setDictateLevels] = useState<number[]>(() =>
    new Array(VOICE_BAND_COUNT).fill(0),
  )
  const [dropActive, setDropActive] = useState(false)
  // dragenter/dragleave fire for every child crossed; the overlay shows
  // while the pointer is anywhere inside.
  const dragDepth = useRef(0)
  const acceptsFileDrop = (e: DragEvent<HTMLElement>) =>
    Boolean(onAttachLocalFiles) && !inSideChat && !disabled && Array.from(e.dataTransfer.types).includes('Files')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Stick-to-bottom gate: false while the user is scrolled up reading. */
  const stickToBottomRef = useRef(true)
  /** Last time the user did something that scrolls on purpose (wheel, touch,
   *  scroll keys, scrollbar drag). Only those may disarm stick-to-bottom:
   *  the browser also fires `scroll` on its own — scroll anchoring and
   *  content-visibility rows swapping their 88px estimate for a real height —
   *  and treating those as "the user scrolled up" silently stopped the
   *  transcript following new messages. */
  const userScrollIntentAtRef = useRef(0)
  const pointerHeldRef = useRef(false)
  const captureEpochRef = useRef(0)
  useLayoutEffect(() => {
    captureEpochRef.current++
    renderCapture.record('thread', { epoch: captureEpochRef.current })
  }, [threadKey])
  const noteUserScrollIntent = useCallback(() => {
    userScrollIntentAtRef.current = Date.now()
    renderCapture.record('intent', { epoch: captureEpochRef.current })
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<DictateLike | null>(null)
  /** Draft as it stood when the current take began (see startDictate). */
  const dictateBaseRef = useRef('')
  /** Mirror of `draft` for callbacks that must not re-bind on every keystroke. */
  const draftRef = useRef('')
  draftRef.current = draft
  /** False when the active engine cannot meter the mic (platform recognizer). */
  const [dictateLevelsSupported, setDictateLevelsSupported] = useState(true)
  const dictateHoldRef = useRef(false)
  const dictateHoldTimerRef = useRef(0)
  const reduce = prefersReducedMotion()
  // Unmount: clear pending widget + dictate-hold timers so no setState fires post-unmount.
  useEffect(() => {
    return () => {
      if (widgetResolveTimer.current !== null) window.clearTimeout(widgetResolveTimer.current)
      window.clearTimeout(dictateHoldTimerRef.current)
    }
  }, [])
  const [wallpaper] = useChatWallpaper()
  const openSubagent = useCallback((runId: string) => {
    setActiveSubagentId(runId)
  }, [])

  const { retryBusy, stopping, turnControlNote, setTurnControlNote, retryTransportTurn, stopRunningTurn } =
    useTurnControls(threadKey, roomStatus?.passRootId, onRetryTurn, onStopTurn)

  const { repliesByRoot, topLevel, threadGroupsMemo, rootIdByMessage } = useThreadGroups(messages)

  // --- Transcript windowing -------------------------------------------------
  // Every message used to mount: measured on a 390×844 phone profile, 2,100
  // messages cost 27,864 DOM nodes and 2.1s from tap to visible chat, against
  // 1.27s for 7 messages. Scrolling was never the problem (p95 frame delta
  // held at ~10ms) — mounting and layout were. Only the tail is rendered
  // initially; "Load earlier" extends the window by a chunk.
  //
  // Anything that must address an arbitrary row forces the full render, so
  // windowing can never make a target unreachable: the in-chat find bar and a
  // jump-to-message from the palette both set `showAll`.
  //
  // Spec C6: "Load earlier" first widens the DOM window over the
  // already-downloaded rows. Once the window reaches the top (`renderFrom ===
  // 0`) and the server reports more history (`historyHasMore`), it fetches the
  // next OLDER page (`before=nextCursor`); the transport merges it above the
  // thread in ONE setState and the pendingPrependRef compensation below keeps
  // the visible tail visually still.
  const WINDOW_CHUNK = 60
  const [windowChunks, setWindowChunks] = useState(1)
  const showAll = findOpen || Boolean(focusMessageId) || Boolean(quoteJumpId)
  const renderFrom = showAll
    ? 0
    : Math.max(0, topLevel.length - WINDOW_CHUNK * windowChunks)
  const visibleTopLevel = renderFrom > 0 ? topLevel.slice(renderFrom) : topLevel
  const liveAvatarId = visibleTopLevel.findLast((message) => message.role === 'agent')?.id
  const pickedUpIds = useMemo(() => pickedUpMessageIds ?? inferredPickedUpIds(messages), [pickedUpMessageIds, messages])
  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  // A helper Stop or steer that didn't reach the agent says so here, above
  // the composer, instead of looking done.
  const [helperNote, setHelperNote] = useState<string | null>(null)
  const sendNote = sendFailures[threadKey] === 'rejected'
    ? 'Message was not sent. Your draft and files are still here. Try Send again when available.'
    : sendFailures[threadKey] === 'uncertain'
      ? 'Hermes may have already accepted this message. Your draft and files are still here. Check the transcript before retrying.'
      : null
  const composerNote = sendNote ?? (attachmentError?.thread === threadKey ? attachmentError.text : helperNote)
  useEffect(() => {
    if (!helperNote) return
    const t = window.setTimeout(() => setHelperNote(null), 8000)
    return () => window.clearTimeout(t)
  }, [helperNote])
  useEffect(() => {
    if (!attachmentError) return
    const t = window.setTimeout(() => setAttachmentError(null), 8000)
    return () => window.clearTimeout(t)
  }, [attachmentError])
  const cancelHelper = useCallback(
    async (runId: string) => {
      if (!onCancelSubagent) return
      setHelperNote(null)
      const ok = await onCancelSubagent(runId)
      if (ok === false) setHelperNote('Couldn’t stop the helper. Check your connection and try again.')
    },
    [onCancelSubagent],
  )
  // Quick-reply chips retire once one of them was picked (a later message
  // sent as "[choice:<id>] …" for one of their ids): they stay as a record
  // but can't send the same pick again.
  const answeredChoices = useMemo(() => {
    const out = new Set<string>()
    const picked = new Set<string>()
    for (let i = topLevel.length - 1; i >= 0; i--) {
      const m = topLevel[i]!
      if (m.role === 'user') {
        const id = /^\[choice:([^\]\s]+)\]/.exec(m.content.trim())?.[1]
        if (id) picked.add(id)
      } else if (m.choices?.some((c) => picked.has(c.id))) out.add(m.id)
    }
    return out
  }, [topLevel])

  // New messages ease in instead of popping: a row whose id first appears
  // AFTER this thread's first render, below every row already known (an
  // append — a send, a reply, a turn from another device). Rows that were
  // there on open, older pages paged in above, and gap fills in the middle
  // mount in place. Kept for the row's life so memo'd rows stay stable; the
  // CSS animation only plays on mount.
  const arrivalsRef = useRef<{
    thread: string
    known: Set<string>
    entering: Set<string>
    /** Ids appended by the latest pass that added any (catch-up anchoring). */
    batch: string[]
  }>({
    thread: '',
    known: new Set(),
    entering: new Set(),
    batch: [],
  })
  const enteringIds = useMemo(() => {
    const st = arrivalsRef.current
    if (st.thread !== threadKey || st.known.size === 0) {
      arrivalsRef.current = {
        thread: threadKey,
        known: new Set(messages.map((m) => m.id)),
        entering: new Set(),
        batch: [],
      }
      return arrivalsRef.current.entering
    }
    let lastKnown = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (st.known.has(messages[i].id)) {
        lastKnown = i
        break
      }
    }
    const batch: string[] = []
    for (let i = 0; i < messages.length; i++) {
      const id = messages[i].id
      if (st.known.has(id)) continue
      st.known.add(id)
      if (i > lastKnown) {
        st.entering.add(id)
        batch.push(id)
      }
    }
    if (batch.length > 0) {
      st.entering = new Set(st.entering)
      st.batch = batch
    }
    return st.entering
  }, [messages, threadKey])
  const hasEarlier = renderFrom > 0 || (historyHasMore && Boolean(onLoadOlder))

  // Prepending rows must not move the reader: capture the scroll height before
  // the extra chunk commits and add back exactly what was inserted.
  const listRefForPrepend = useRef<HTMLDivElement>(null)
  const pendingPrependRef = useRef<number | null>(null)
  // Keyed on the first rendered NON-system row too: a server page prepended
  // while the window already starts at 0 changes the head row, not
  // `renderFrom` — and it lands BELOW a leading "Conversation started." row,
  // so the literal first row would not change.
  const headRowId = visibleTopLevel.find((m) => m.role !== 'system')?.id ?? null
  // Double-click guard: the store's loadingOlder flag arrives a render late.
  const loadingOlderRef = useRef(false)
  // Current thread, read by an older load's settle callback (see handler).
  const threadKeyRef = useRef(threadKey)
  threadKeyRef.current = threadKey
  const loadEarlierBtnRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const el = listRefForPrepend.current
    const before = pendingPrependRef.current
    if (!el || before === null) return
    pendingPrependRef.current = null
    el.scrollTop += el.scrollHeight - before
  }, [renderFrom, headRowId])

  const loadEarlier = useCallback(() => {
    const el = listRefForPrepend.current
    if (renderFrom > 0) {
      pendingPrependRef.current = el ? el.scrollHeight : null
      setWindowChunks((n) => n + 1)
      return
    }
    // Window already at the top of the downloaded rows: page the server.
    if (!historyHasMore || historyLoadingOlder || !onLoadOlder || loadingOlderRef.current) return
    loadingOlderRef.current = true
    // A load that settles after a thread switch must not clear the new
    // thread's guard / pending compensation (the [threadKey] reset ran).
    const loadThread = threadKey
    const btnHadFocus =
      typeof document !== 'undefined' && document.activeElement === loadEarlierBtnRef.current
    pendingPrependRef.current = el ? el.scrollHeight : null
    // Widen with the fetch so the prepended page actually renders.
    setWindowChunks((n) => n + 1)
    void Promise.resolve(onLoadOlder()).finally(() => {
      if (threadKeyRef.current !== loadThread) return
      loadingOlderRef.current = false
      // Nothing landed (error / all duplicates): drop the pending
      // compensation so a later tail append does not jump the reader.
      if (listRefForPrepend.current && pendingPrependRef.current !== null) {
        requestAnimationFrame(() => {
          pendingPrependRef.current = null
        })
      }
      // The last page removes the button: hand keyboard focus to the
      // transcript instead of dropping it on <body>. Only when the user was
      // still on the button — never steal focus they moved elsewhere.
      if (btnHadFocus) {
        requestAnimationFrame(() => {
          const btn = loadEarlierBtnRef.current
          if (btn && btn.isConnected) return
          const active = document.activeElement
          if (active && active !== document.body) return
          listRefForPrepend.current?.focus({ preventScroll: true })
        })
      }
    })
  }, [renderFrom, historyHasMore, historyLoadingOlder, onLoadOlder])

  // A shorter thread must not stay clipped by an earlier, longer one, and a
  // prepend pending for the previous thread must not compensate this one.
  useEffect(() => {
    setWindowChunks(1)
    setQuoteJumpId(null)
    pendingPrependRef.current = null
    loadingOlderRef.current = false
  }, [threadKey])

  const threadRoot = useMemo(
    () => messages.find((m) => m.id === threadRootId) ?? null,
    [messages, threadRootId],
  )
  const threadTitle = useMemo(() => {
    if (!threadRoot) return 'Reply thread'
    const text = threadRoot.content.replace(/\s+/g, ' ').trim()
    return text.length > 48 ? `${text.slice(0, 47)}…` : text || 'Reply thread'
  }, [threadRoot])

  // Only track viewport width while a thread pane is open — it's the sole
  // consumer, so resize events otherwise re-render the whole transcript for
  // nothing. Coalesce bursts to one update per frame.
  useEffect(() => {
    if (threadRootId === null) return
    let raf = 0
    function onResize() {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        setViewportWidth(window.innerWidth)
      })
    }
    setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [threadRootId])

  /** Stable across renders: resolves the thread root via a ref, so the
   *  opener handed to every memo'd row never churns during streaming ticks.
   *  Behavior matches the previous map-closure version at call time. */
  const rootIdByMessageRef = useRef(rootIdByMessage)
  rootIdByMessageRef.current = rootIdByMessage
  const openThreadFor = useCallback((messageId: string) => {
    setThreadRootId(rootIdByMessageRef.current.get(messageId) ?? messageId)
  }, [])

  /** Stable row actions: created once so TranscriptRow props stay identical
   *  for unchanged messages. (Row-local hover closures are built inside the
   *  memo'd row, not here.) */
  const replyToMessage = useCallback((target: ChatMessage) => {
    setReplyTarget(replyPreviewForMessage(target))
    textareaRef.current?.focus()
  }, [])
  const editMessage = useCallback(
    (target: ChatMessage) => {
      const text = copyTextOf(target)
      setDraft((d) => {
        const next = draftAfterEdit(d, text)
        pendingCaretRef.current = next.length
        return next
      })
      setReplyTarget(target.replyTo ?? null)
      textareaRef.current?.focus()
    },
    [setDraft],
  )
  // Ask again lives on one row; route the send through a ref so that row's
  // callback keeps its identity while the panel re-renders.
  const askAgain = useMemo(() => (sending ? null : askAgainTarget(messages)), [messages, sending])
  const askAgainRef = useRef(askAgain)
  askAgainRef.current = askAgain
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const askAgainNow = useCallback(() => {
    const target = askAgainRef.current
    if (!target) return
    const attachments = resendableAttachments(target.prompt)
    onSendRef.current(copyTextOf(target.prompt), {
      ...(target.prompt.replyTo ? { replyTo: target.prompt.replyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    })
  }, [])
  const reactToMessage = useCallback(
    (target: ChatMessage, emoji: string | null) => {
      onReact?.(target, emoji)
    },
    [onReact],
  )

  // C3 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): deriveProjectArtifacts
  // concatenates the whole thread and runs several regexes over it. Settled
  // messages are immutable during a stream, so cache the derivation on
  // (cwd, message ids, tail signature) — a content-only tick changes the
  // tail signature only when the tail's rendered bytes actually moved, and
  // settled history never does. A new message id recomputes.
  const projectArtifactsCache = useRef<{ key: string; value: ProjectArtifact[] } | null>(null)
  const tailMsg = messages.length > 0 ? messages[messages.length - 1] : null
  // A reply that is still streaming is scanned once it settles: the tail's
  // length moved on every token, so the "cache" recomputed the whole-thread
  // scan per token anyway.
  const tailSig = tailMsg
    ? `${tailMsg.id}:${tailMsg.streaming ? 'live' : tailMsg.content.length}:${(tailMsg.toolEvents ?? [])
        .map((ev) => `${ev.status ?? ''}:${(ev.args ?? '').length}:${(ev.result ?? '').length}`)
        .join('.')}`
    : ''
  const projectArtifactsKey = `${cwd ?? ''}\u0000${messages
    .map((m) => m.id)
    .join(',')}\u0000${tailSig}`
  const projectArtifacts =
    projectArtifactsCache.current?.key === projectArtifactsKey
      ? projectArtifactsCache.current.value
      : deriveProjectArtifacts(messages, cwd).filter(isOpenablePage)
  projectArtifactsCache.current = { key: projectArtifactsKey, value: projectArtifacts }
  // artifactAnchorIndex scans every transcript prefix (one full derive per
  // prefix over the whole text), so it must not rerun on every `messages`
  // identity change. The anchor is cached on the transcript shape (top-level
  // ids) + artifact id-set + cwd: streaming ticks grow the last message's
  // content but leave every earlier prefix — and therefore every earlier
  // anchor verdict — untouched, while a tick that introduces an artifact
  // changes the id-set and recomputes. A newly arrived message changes the
  // ids and recomputes. Exact same verdicts, computed only when inputs that
  // can move the anchor change. The key omits content by design: earlier
  // messages are immutable mid-stream (streaming only patches the live last
  // message) and history loads mint new ids, so any content change that could
  // move the anchor invalidates the key above.
  const artifactAnchorCache = useRef<{ key: string; value: number }>({ key: '', value: -1 })
  const artifactAnchorKey = `${cwd ?? ''}\n${topLevel.map((m) => m.id).join(',')}\n${projectArtifacts.map((a) => a.id).join(',')}`
  let artifactAfterIndex: number
  if (artifactAnchorCache.current.key === artifactAnchorKey) {
    artifactAfterIndex = artifactAnchorCache.current.value
  } else {
    // Anchored against `topLevel` so the stack lands relative to the
    // collapsed transcript actually rendered below.
    artifactAfterIndex = artifactAnchorIndex(topLevel, cwd)
    artifactAnchorCache.current = { key: artifactAnchorKey, value: artifactAfterIndex }
  }

  // Bubble grouping (iMessage-style stacks). Keyed on what can change a
  // verdict: ids (role/speaker/time/replyTo are fixed per id), whether a row
  // shows anything, errors, tool/attachment counts, and where the artifact
  // stack sits. A streaming tick only moves the live tail's flags, so the
  // pass reruns at most once per visible change, not per token.
  const showArtifactUi = Boolean(onOpenPreview || onDownloadProject || onOpenHost)
  const withFiles = Boolean(onOpenFile)
  const bubbleGroupsCache = useRef<{ key: string; value: BubbleGroupPos[] }>({ key: '', value: [] })
  const bubbleGroupsKey = `${renderFrom}|${artifactAfterIndex}|${showArtifactUi && projectArtifacts.length > 0 ? 1 : 0}|${withFiles ? 1 : 0}|${visibleTopLevel
    .map(
      (m) =>
        `${m.id}:${m.content?.trim() ? 1 : 0}${m.error ? 1 : 0}${m.toolEvents?.length ?? 0}.${m.attachments?.length ?? 0}.${m.choices?.length ?? 0}`,
    )
    .join(',')}`
  let bubbleGroups: BubbleGroupPos[]
  if (bubbleGroupsCache.current.key === bubbleGroupsKey) {
    bubbleGroups = bubbleGroupsCache.current.value
  } else {
    bubbleGroups = bubbleGroupPositions(
      visibleTopLevel.map((m, i) => {
        const { hasBubble, fileCards } = transcriptRowShape(m, withFiles)
        const artifactsHere =
          showArtifactUi && projectArtifacts.length > 0 && renderFrom + i === artifactAfterIndex
        return {
          m,
          hidden: !hasBubble && fileCards.length === 0 && !artifactsHere,
          breakAfter: !hasBubble || fileCards.length > 0 || artifactsHere,
        }
      }),
    )
    bubbleGroupsCache.current = { key: bubbleGroupsKey, value: bubbleGroups }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listHermesProfiles()
        if (!cancelled) setLiveProfiles(rows.map((p) => profileToAgent(p)))
      } catch {
        /* desktop bridge / serve optional */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const spawnRoster = useMemo(() => {
    const byId = new Map<string, Agent>()
    for (const a of agents) byId.set(a.id, a)
    for (const a of liveProfiles) if (!byId.has(a.id)) byId.set(a.id, a)
    return [...byId.values()]
  }, [agents, liveProfiles])

  // Grok parity: reset to the parent stream when switching conversations.
  useEffect(() => {
    setActiveSubagentId(null)
    setThreadRootId(null)
  }, [threadKey])

  const activeRun =
    activeSubagentId !== null
      ? (conversationSubagents.find((r) => r.id === activeSubagentId) ?? null)
      : null
  const inSideChat = activeRun !== null
  useEffect(() => onSkillDraft(request => {
    if (request.threadKey !== draftThreadRef.current || inSideChat || readOnly) return
    setDraft(appendSkillRequest(draftRef.current, request.text))
    textareaRef.current?.focus()
  }), [inSideChat, readOnly, setDraft])

  // First-open reveal: when the loading intro gave way to real rows for
  // THIS thread, fade the list in once (.ca-transcript-in). A cached thread
  // never showed the intro, so it opens instantly. Render-phase state so
  // the class lands on the same commit as the rows (no unstyled frame).
  const skeletonVisible = !inSideChat && messages.length === 0 && !sending && transcriptLoading
  const [skeletonThread, setSkeletonThread] = useState<string | null>(null)
  const [revealThread, setRevealThread] = useState<string | null>(null)
  if (skeletonVisible && skeletonThread !== threadKey) setSkeletonThread(threadKey)
  if (
    !skeletonVisible &&
    skeletonThread === threadKey &&
    messages.length > 0 &&
    revealThread !== threadKey
  ) {
    setRevealThread(threadKey)
  }

  const canMessageSide =
    Boolean(onMessageSubagent) &&
    activeRun?.status !== 'cancelled' &&
    Boolean(activeRun?.hermesSessionId || activeRun?.hermesSubagentId)

  useEffect(() => {
    if (!active || findOpen) return
    if (!inSideChat && !permissionAsk) return
    function onKey(e: globalThis.KeyboardEvent) {
      // Foreground dialogs/menus own their keys, not the request behind them.
      if (e.defaultPrevented || e.isComposing || e.repeat ||
          document.querySelector('[data-esc-layer], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return
      // A1: 1–9 pick a widget answer chip — but never while typing into a field.
      if (
        permissionAsk &&
        permissionAsk.status === 'pending' &&
        (permissionAsk.options?.length ?? 0) > 0 &&
        !isTextEntryTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        const idx = Number(e.key) - 1
        const option = Number.isInteger(idx) && idx >= 0 ? permissionAsk.options?.[idx] : undefined
        if (option) {
          e.preventDefault()
          onPermission?.('once', { optionId: option.id })
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (permissionAsk && permissionAsk.status !== 'submitting' && permissionAsk.choices.includes('deny')) {
          onPermission?.('deny')
        } else setActiveSubagentId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, inSideChat, permissionAsk, onPermission, findOpen])

  // Window focus (Cmd+I / palette "Focus prompt") → focus the composer.
  // Palette "Spawn subagent" → focus + drop the /spawn scaffold into the draft.
  useEffect(() => {
    if (!active) return
    function onFocusComposer() {
      textareaRef.current?.focus()
    }
    function onSpawnScaffold() {
      setDraft('/spawn ')
      textareaRef.current?.focus()
    }
    window.addEventListener('maia:focus-composer', onFocusComposer)
    window.addEventListener('maia:spawn-scaffold', onSpawnScaffold)
    return () => {
      window.removeEventListener('maia:focus-composer', onFocusComposer)
      window.removeEventListener('maia:spawn-scaffold', onSpawnScaffold)
    }
  }, [active, setDraft])

  const findHits = useMemo(
    (): ReturnType<typeof findChatHits> =>
      findOpen && findQuery.trim() ? findChatHits(messages, findQuery) : [],
    [messages, findQuery, findOpen],
  )
  const findCount = findHits.length
  const activeFindId = findOpen && findCount > 0 ? findHits[Math.min(findIndex, findCount - 1)]?.messageId ?? null : null

  const openFind = useCallback(() => {
    setFindOpen(true)
    window.setTimeout(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }, 0)
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindIndex(0)
    setHighlightMessageId(null)
  }, [])

  const stepFind = useCallback(
    (delta: -1 | 1) => {
      if (findCount === 0) return
      setFindIndex((i) => (i + delta + findCount) % findCount)
    },
    [findCount],
  )

  useEffect(() => {
    if (!active) return
    function onFind() {
      openFind()
    }
    function onKey(e: globalThis.KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') return
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
      }
    }
    window.addEventListener('maia:find-in-chat', onFind)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('maia:find-in-chat', onFind)
      window.removeEventListener('keydown', onKey)
    }
  }, [active, openFind])

  useEffect(() => {
    closeFind()
  }, [threadKey, closeFind])

  useEffect(() => {
    if (!active || !findOpen) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeFind()
        return
      }
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        stepFind(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, findOpen, closeFind, stepFind])

  useEffect(() => {
    setFindIndex(0)
  }, [findQuery])

  const stopDictate = useCallback(() => {
    void recRef.current?.stop()
    setDictateSeconds(0)
  }, [])

  const startDictate = useCallback(() => {
    setDictateSeconds(0)
    // Snapshot the draft so a live (interim) transcript can replace itself
    // rather than append repeatedly as the recognizer revises its guess.
    dictateBaseRef.current = draftRef.current
    void recRef.current?.start()
  }, [])
  // A held take belongs to this chat. Never transcribe it into another
  // conversation after its composer unmounts or the retained chat is hidden.
  useEffect(() => () => {
    if (skin === 'messenger') recRef.current?.cancel()
  }, [threadKey, active, skin])

  // Dictation is on-device only. No browser or mobile speech fallback.
  useEffect(() => {
    const hooks = {
      onStatus: (status: DictateStatus) => {
        setDictateStatus(status)
        // Bars only dance while the mic is live; settle them otherwise.
        if (status !== 'listening') setDictateLevels(new Array(VOICE_BAND_COUNT).fill(0))
      },
    }
    if (sttBridgeAvailable()) {
      let cancelled = false
      void sttStatus().then((stt) => {
        if (cancelled) return
        if (!stt.ok) {
          setDictateStatus('unavailable')
          return
        }
        setDictateLevelsSupported(true)
        // An engine exists — clear any 'unavailable' seed from mount.
        setDictateStatus('idle')
        recRef.current = new DictateEngine({
          transcribe: transcribeAudio,
          hooks: {
            ...hooks,
            onFinal: (text) => setDraft((d) => appendTranscript(d, text)),
            onLevels: setDictateLevels,
          },
        })
      })
      return () => {
        cancelled = true
        recRef.current?.cancel()
        recRef.current = null
      }
    }
    setDictateStatus('unavailable')
  }, [])

  useEffect(() => {
    if (dictateStatus !== 'listening') return
    const id = window.setInterval(() => {
      setDictateSeconds((s) => s + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [dictateStatus])

  useEffect(() => {
    if (!findOpen || !activeFindId) {
      if (findOpen) setHighlightMessageId(null)
      return
    }
    const root = listRef.current
    const el = root?.querySelector(`[data-message-id="${CSS.escape(activeFindId)}"]`)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    }
    setHighlightMessageId(activeFindId)
  }, [findOpen, activeFindId, reduce])

  // Native browser control is blocked by the installed Hermes contract.
  const spawnItems = spawnSuggestions(draft, spawnRoster).filter((s) => s.token !== 'browserUse')
  const slashMatch = spawnItems.length === 0 && draft.startsWith('/') && !draft.includes(' ') ? draft : null
  // A command typed out in full comes first, so Enter runs it: "/new" is
  // also a prefix of "/new-agent", which is listed earlier.
  const slashItemsPreview = slashMatch
    ? APP_SLASH.filter((c) => c.cmd.startsWith(slashMatch.toLowerCase())).sort(
        (a, b) => Number(b.cmd === slashMatch.toLowerCase()) - Number(a.cmd === slashMatch.toLowerCase()),
      )
    : []
  const mentionMatch =
    !inSideChat && mentionMembers.length > 0 && spawnItems.length === 0 && !slashMatch
      ? mentionQueryAt(draft, caret)
      : null
  const mentionItems: MentionCandidate[] =
    mentionMatch && mentionMatch.start !== mentionDismissedAt
      ? mentionCandidates(mentionMembers, mentionMatch.query).slice(0, 8)
      : []
  const lastMessage = messages[messages.length - 1]
  // A server-run room is live while any member turn is queued or running,
  // including before the first token (nothing is streaming yet).
  const streamActive = Boolean(sending || lastMessage?.streaming || roomStatus?.live)
  const roomPresence = !inSideChat ? (roomStatus?.presence ?? null) : null
  const passLineKey = roomStatus?.passLine
    ? `${threadKey}\u0001${roomStatus.passRootId ?? ''}\u0001${roomStatus.passLine}`
    : null
  const roomPassLine =
    !inSideChat && roomStatus?.passLine && passLineKey && !hiddenPassLines.has(passLineKey)
      ? roomStatus.passLine
      : null
  // A question card is up: whatever is typed next is the answer to it.
  const awaitingAnswer = useWaitingClarify(threadKey) && !inSideChat
  // Any card waiting on the user (question, key, plugin, permission): the
  // turn is paused on them, so the activity line must not read "Working…".
  const waitingOnUser = useWaitingOnUserText(
    inSideChat ? null : threadKey,
    !inSideChat && permissionAsk?.status === 'pending',
  )
  const liveActivity = useHeldLiveActivity(
    useMemo(() => liveActivityFromMessages(messages, sending === true, toolWhere), [messages, sending, toolWhere]),
  )
  const busyBanner = statusLine || null
  const showRunControl = Boolean(onStopTurn && (streamActive || stopping) && !inSideChat)
  const showActivityLine =
    !inSideChat &&
    (showRunControl ||
      Boolean(busyBanner) ||
      Boolean(roomPresence) ||
      Boolean(waitingOnUser) ||
      liveActivity.mode !== 'none' ||
      // A parked send must stay visible: with the line hidden the user saw
      // their bubble and nothing else — no badge, no mascot — and read it as
      // "no response".
      (queuedCount ?? 0) > 0 ||
      liveSubagents.some((s) => s.status === 'queued' || s.status === 'running'))
  // The activity line unmounts when a reply settles, so screen readers would
  // never hear that it finished. One always-mounted region says so instead.
  const [replyAnnouncement, setReplyAnnouncement] = useState('')
  const replyWatchRef = useRef({ key: threadKey, active: streamActive })
  const lastMessageRef = useRef(lastMessage)
  lastMessageRef.current = lastMessage
  useEffect(() => {
    const prev = replyWatchRef.current
    replyWatchRef.current = { key: threadKey, active: streamActive }
    if (prev.key !== threadKey || streamActive) {
      setReplyAnnouncement('')
      return
    }
    if (!prev.active || !active || inSideChat) return
    const last = lastMessageRef.current
    setReplyAnnouncement(last?.role === 'agent' && last.error ? 'Reply failed. Try again is available.' : 'Reply ready')
  }, [threadKey, streamActive, active, inSideChat])
  useEffect(() => {
    setSlashSel(0)
  }, [draft])
  useEffect(() => {
    setReplyTarget(null)
  }, [threadKey])

  useLayoutEffect(() => {
    const pos = pendingCaretRef.current
    if (pos === null) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(pos, pos)
  }, [draft])

  // Composer auto-grow. `rows={1}` + `max-h-32` alone pinned the box at one
  // line and scrolled the draft inside it (measured: 44px for six lines), so
  // a multi-line instruction on a phone was written into a one-line slot.
  // Height is written to the element directly rather than through state: a
  // state round-trip re-renders the whole panel on every keystroke. Reset to
  // `auto` first so the box can shrink when text is deleted.
  // The window-resize pass re-measures when the column width changes, since
  // the same draft wraps to a different line count.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  useEffect(() => {
    const onResize = () => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const onHelp = () =>
    setDraft('/help — app commands: /kanban /plugins /settings /new-agent /spawn /loop · hermes commands (memory, skills, plan, tasks…) pass through to the agent')
  const setSpawnDraft = () => {
    setDraft('/spawn ')
    textareaRef.current?.focus()
  }
  // /loop is a Hermes command, not an app action: scaffold the composer and let
  // the send path pass it through verbatim.
  const setLoopDraft = () => {
    setDraft('/loop ')
    textareaRef.current?.focus()
  }
  const setGenUiDraft = () => {
    const base = draftRef.current.replace(/^\/genui\b\s*/i, '')
    const next = appendSkillRequest(base, genUiRequest())
    pendingCaretRef.current = next.length
    setDraft(next)
    textareaRef.current?.focus()
  }
  const slashActions: SlashActions = {
    onOpenKanban,
    onCopyToBox,
    onOpenSettings,
    onOpenPlugins,
    onNewAgent,
    onNewConversation,
    onHelp,
    setSpawnDraft,
    setLoopDraft,
    setGenUiDraft,
  }
  const slashItems = slashItemsPreview.filter((c) => slashAvailable(c.cmd, slashActions))

  // Hand-off strip → the member's reply: scroll it into view and flash it.
  const jumpHighlightTimer = useRef<number | null>(null)
  const jumpToRow = useCallback(
    (rowId: string) => {
      const el = listRef.current?.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)
      if (!(el instanceof HTMLElement)) {
        if (skin === 'messenger') {
          const rootId = rootIdByMessageRef.current.get(rowId) ?? rowId
          if (rootId !== rowId) setThreadRootId(rootId)
          setQuoteJumpId(rootId)
        }
        return
      }
      stickToBottomRef.current = false
      followerRef.current?.stop()
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
      setHighlightMessageId(rowId)
      if (jumpHighlightTimer.current) window.clearTimeout(jumpHighlightTimer.current)
      jumpHighlightTimer.current = window.setTimeout(() => {
        setHighlightMessageId((cur) => (cur === rowId ? null : cur))
      }, 1600)
    },
    [reduce, skin],
  )
  useLayoutEffect(() => {
    if (quoteJumpId) jumpToRow(quoteJumpId)
  }, [quoteJumpId, jumpToRow])
  useEffect(
    () => () => {
      if (jumpHighlightTimer.current) window.clearTimeout(jumpHighlightTimer.current)
    },
    [],
  )

  const focusSettleRef = useRef<(() => void) | null>(null)
  useEffect(() => () => focusSettleRef.current?.(), [])
  useEffect(() => {
    if (!focusMessageId) return
    const root = listRef.current
    if (!root) return
    const el = root.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
    if (!(el instanceof HTMLElement)) return
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    setHighlightMessageId(focusMessageId)
    onFocusMessageHandled?.()
    // Cards and pictures above the target finish laying out after this
    // scroll and push it out of view (a freshly opened chat, a search jump
    // on the phone). Re-centre it as the thread settles, until the user
    // scrolls or ~1.2s pass. Held in a ref: the parent clears
    // `focusMessageId` right away, and that cleanup must not cancel this.
    focusSettleRef.current?.()
    let settled = false
    const stop = () => {
      settled = true
    }
    const recentre = () => {
      if (!settled && el.isConnected) el.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
    root.addEventListener('wheel', stop, { passive: true })
    root.addEventListener('touchstart', stop, { passive: true })
    root.addEventListener('keydown', stop)
    const timers = [250, 600, 1200].map((ms) => window.setTimeout(recentre, ms))
    const target = focusMessageId
    timers.push(
      window.setTimeout(() => {
        setHighlightMessageId((cur) => (cur === target ? null : cur))
      }, 1600),
    )
    focusSettleRef.current = () => {
      timers.forEach((id) => window.clearTimeout(id))
      root.removeEventListener('wheel', stop)
      root.removeEventListener('touchstart', stop)
      root.removeEventListener('keydown', stop)
      focusSettleRef.current = null
    }
  }, [focusMessageId, messages, onFocusMessageHandled, reduce])

  // C5 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): pin from CONTENT HEIGHT, not from
  // `messages` identity. A ResizeObserver on the transcript's inner wrapper
  // fires only when the content actually changed height, and scrollTop is
  // written only when the viewport drifted more than 2px off the bottom — a
  // token that added no height costs zero scroll work and zero layout reads
  // on the main thread. Find / focus jump mount the full transcript and
  // scroll to their own target, so the pin stands down while they are active.
  const listInnerRef = useRef<HTMLDivElement | null>(null)
  const pinSuppressedRef = useRef(false)
  pinSuppressedRef.current = Boolean(findOpen || focusMessageId || highlightMessageId)
  // Scrolled up past a screenful: a pill offers the way back down, and says
  // so when a reply arrived meanwhile (it used to land out of sight).
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const awaySinceCountRef = useRef(0)
  const newSinceAway = awayFromBottom && messages.length > awaySinceCountRef.current
  useEffect(() => {
    setAwayFromBottom(false)
  }, [threadKey])
  const jumpingUntilRef = useRef(0)
  function jumpToLatest() {
    const el = listRef.current
    stickToBottomRef.current = true
    setAwayFromBottom(false)
    if (!el) return
    // The transcript's own glide (the one new replies follow with); the
    // pill stays hidden while it runs instead of flickering back.
    jumpingUntilRef.current = Date.now() + 1500
    getFollower(el).follow()
  }

  const hasResizeObserver = typeof ResizeObserver !== 'undefined'
  // Following glides (src/lib/bottom-follow.ts) instead of hopping a line or
  // a whole message at a time. The first moments of a thread snap: opening a
  // chat lands at the bottom, it never scrolls there.
  const threadOpenedAtRef = useRef(0)
  useEffect(() => {
    threadOpenedAtRef.current = typeof performance !== 'undefined' ? performance.now() : 0
  }, [threadKey])
  const reduceRef = useRef(reduce)
  reduceRef.current = reduce
  const followerRef = useRef<BottomFollower | null>(null)
  const getFollower = useCallback((el: HTMLElement): BottomFollower => {
    if (!followerRef.current) {
      followerRef.current = createBottomFollower(el, {
        canFollow: () => stickToBottomRef.current && !pinSuppressedRef.current,
        instant: () =>
          reduceRef.current ||
          (typeof document !== 'undefined' && document.hidden) ||
          performance.now() - threadOpenedAtRef.current < THREAD_OPEN_SNAP_MS,
      })
    }
    return followerRef.current
  }, [])
  useLayoutEffect(() => {
    if (!renderCapture.isRecording()) return
    renderCapture.record('commit', {
      epoch: captureEpochRef.current, rows: messages.length, skin, active, sending,
      loading: transcriptLoading, finding: findOpen, focusJump: Boolean(focusMessageId || highlightMessageId),
      away: awayFromBottom, pinned: stickToBottomRef.current, reduced: reduce, hidden: document.hidden,
    })
  })
  useEffect(() => () => followerRef.current?.stop(), [])
  useEffect(() => {
    const el = listRef.current
    const inner = listInnerRef.current
    if (!el || !inner || !hasResizeObserver) return
    const pin = () => {
      if (renderCapture.isRecording()) renderCapture.record('resize', {
        epoch: captureEpochRef.current, pinned: stickToBottomRef.current,
        scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      })
      if (pinSuppressedRef.current) return
      if (!stickToBottomRef.current) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance > 2) {
        stickToBottomRef.current = true
        getFollower(el).follow()
      }
    }
    const ro = new ResizeObserver(pin)
    ro.observe(inner)
    // The scroller itself shrinks when something below it appears (the
    // activity line, a queued-send list, a growing composer) and grows when
    // it goes. The content did not change height, so observing only the
    // inner wrapper missed it and the tail slid under the fold for a frame.
    ro.observe(el)
    return () => ro.disconnect()
    // The inner wrapper remounts per thread / side-chat — re-observe it.
  }, [hasResizeObserver, threadKey, activeRun?.id, getFollower])

  // Arrival snap. Without ResizeObserver (old engines / tests) this is the
  // only pin; with it, it is the backstop for arrivals the observer can miss
  // (growth outside the observed wrapper, a row swapped in at the same
  // height). Keyed on the tail so streaming tokens don't re-run it.
  const tailMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const tailKey = tailMessage ? `${messages.length}:${tailMessage.id}:${tailMessage.role}` : ''
  const lastTailKeyRef = useRef('')
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (highlightMessageId || focusMessageId) return
    // Grok pins the transcript scroller only. `scrollIntoView` walks ancestor
    // viewports and tucks the activity mascot under the composer.
    const snap = () => {
      renderCapture.record('follow', { epoch: captureEpochRef.current })
      stickToBottomRef.current = true
      getFollower(el).follow()
    }
    const prevTail = lastTailKeyRef.current
    lastTailKeyRef.current = tailKey
    // The user's own send always follows: they just typed at the bottom and
    // expect their message and the reply to land in view, even if they had
    // scrolled up earlier.
    if (tailKey !== prevTail && tailMessage?.role === 'user' && catchUpTailRef.current !== tailKey) {
      snap()
      return
    }
    // Stick-to-bottom gate: if the user scrolled up to read, don't yank the
    // transcript back down. Only a programmatic snap or the user scrolling
    // back to (near) bottom re-arms following.
    if (!stickToBottomRef.current) return
    if (hasResizeObserver && tailKey === prevTail && !sending) return
    // C5: a settled arrival follows the bottom with the glide (native smooth
    // scrolling restarted on every token and fought the mascot). One frame
    // lets content-visibility rows settle their real height first.
    const id = window.requestAnimationFrame(snap)
    return () => window.cancelAnimationFrame(id)
  }, [messages, tailKey, sending, threadKey, hasResizeObserver, highlightMessageId, focusMessageId, getFollower])

  // Catch-up arrivals (src/lib/catch-up-scroll.ts): rows from the server this
  // device did not have — a cached thread that was behind, or a turn from
  // another device. They glide in (the thread is already on screen, so the
  // open-snap no longer applies), and a batch taller than the screen lands
  // on its first row instead of past it. Own sends and live streams keep
  // plain following: `sending`, and their local rows carry no server stamp.
  const catchUpTailRef = useRef('')
  const handledBatchRef = useRef<string[] | null>(null)
  useLayoutEffect(() => {
    const batch = arrivalsRef.current.batch
    if (batch === handledBatchRef.current) return
    handledBatchRef.current = batch
    if (!batch.length || sending || inSideChat || pinSuppressedRef.current) return
    if (!stickToBottomRef.current) return
    const byId = new Map(messages.map((m) => [m.id, m]))
    if (!batch.every((id) => byId.get(id)?.turnCreatedAt)) return
    const el = listRef.current
    if (!el) return
    threadOpenedAtRef.current = Number.NEGATIVE_INFINITY
    const rows = batch
      .map((id) => el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`))
      .filter((r): r is HTMLElement => r !== null)
    if (!rows.length) return
    // Rows below the fold skip layout (content-visibility) and report the
    // 88px placeholder; lay the new ones out for real before measuring. The
    // remembered size (contain-intrinsic-size: auto) keeps it after restore.
    for (const r of rows) r.style.contentVisibility = 'visible'
    const box = el.getBoundingClientRect()
    const target = catchUpScrollTarget({
      rowTop: rows[0].getBoundingClientRect().top - box.top + el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    })
    requestAnimationFrame(() => {
      for (const r of rows) r.style.contentVisibility = ''
    })
    if (target === null) return
    stickToBottomRef.current = false
    catchUpTailRef.current = tailKey
    followerRef.current?.stop()
    if (reduce || typeof el.scrollTo !== 'function') el.scrollTop = target
    else el.scrollTo({ top: target, behavior: 'smooth' })
  }, [enteringIds]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once per appended batch

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (!inSideChat && (pendingSendsRef.current.has(threadKey) || sendFailures[threadKey] === 'uncertain')) return
    if (!inSideChat && pendingAttachmentPickRef.current === threadKey) return
    if (pendingMiddlewareRef.current !== null) return
    const submittedDraft = draft
    const generation = submitGenerationRef.current
    const clearSubmittedDraft = () => {
      if (draftFor(threadKey) === submittedDraft) setDraftFor(threadKey, '')
      setDraftBox(box => box.thread === threadKey && box.text === submittedDraft ? { ...box, text: '' } : box)
    }
    let text = draft.trim()
    // Attached files go with this message; wait for them to finish landing.
    const files = inSideChat ? [] : attachReady
    if (!inSideChat && attachUploading && !disabled) {
      // Send is pressed while files are still uploading: the message goes as
      // soon as they land (pressing again cancels). It used to do nothing.
      setSendQueued((q) =>
        q?.thread === threadKey
          ? null
          : { thread: threadKey, waitingOn: attached.filter((a) => a.status === 'uploading').map((a) => a.id) },
      )
      return
    }
    if (disabled || attachUploading || (!text && files.length === 0)) return
    if (inSideChat && activeRun && canMessageSide && onMessageSubagent) {
      const runId = activeRun.id
      setDraft('')
      setHelperNote(null)
      void Promise.resolve(onMessageSubagent(runId, text)).then((ok) => {
        if (ok !== false) return
        // Put the words back so nothing typed is lost.
        setDraft((d) => (d.trim() ? d : text))
        setHelperNote('Couldn’t reach the helper. Your message is back in the box.')
      })
      return
    }
    // Plugin composer middleware runs first (e.g. hermes-bots @mention
    // handoff) — it may rewrite the draft before send. Isolated: a throwing
    // handler is skipped, never blocks the message. Fast path: with no
    // middleware registered this stays fully synchronous (existing callers
    // assert the send synchronously).
    if (composerMiddlewareContributions().length > 0) {
      const pending = Symbol()
      pendingMiddlewareRef.current = pending
      try {
        const next = await applyComposerMiddleware({ text })
        text = (next?.text ?? text).trim()
      } catch {
        /* middleware failures never block a normal send */
      } finally {
        if (pendingMiddlewareRef.current === pending) pendingMiddlewareRef.current = null
      }
      // A delayed plugin must not send into a changed/closed/offline chat.
      if (submitGenerationRef.current !== generation) return
      if (!text && files.length === 0) return
    }
    // Do not block on `sending`. Nub/mock await the full SSE (and hung
    // streams never resolve), so locking Enter/Send here makes the app
    // feel dead while Working… is still on screen. Stream liveness is
    // the activity line, not a composer lock.
    // /spawn <kind> <goal> → spawn a real local subagent and report back.
    if (/^\/spawn\b/.test(text)) {
      void runSpawnCommand(text)
      clearSubmittedDraft()
      return
    }
    // App-level slash commands run locally (open panels); everything else
    // (including Hermes commands) goes to the agent chat verbatim.
    if (text.startsWith('/')) {
      const firstWord = text.split(/\s+/)[0]!.toLowerCase()
      const appCmd = APP_SLASH.find((c) => c.cmd === firstWord)
      if (appCmd && slashAvailable(appCmd.cmd, slashActions)) {
        appCmd.run(slashActions)
        clearSubmittedDraft()
        return
      }
    }
    const images = files.flatMap((a) => (a.inline ? [a.inline] : [])).slice(0, 4)
    const sendOptions = files.length ? {
        ...(replyTarget ? { replyTo: replyTarget } : {}),
        attachments: files.map((a) => ({
          name: a.name,
          path: a.path!,
          kind: a.kind,
          ...(a.size !== undefined ? { size: a.size } : {}),
        })),
        ...(images.length ? { images } : {}),
      } : replyTarget ? { replyTo: replyTarget } : undefined
    pendingSendsRef.current.add(threadKey)
    setPendingSends(new Set(pendingSendsRef.current))
    setSendFailures(previous => ({ ...previous, [threadKey]: 'accepted' }))
    let outcome: void | SendOutcome
    try {
      const result = onSend(withGenUiPromptHint(text), sendOptions)
      // Legacy synchronous callers still clear synchronously. Native callers
      // resolve acceptance, not the eventual model reply.
      outcome = result && 'then' in result ? await result : result
    } catch (error) {
      outcome = failedSend(error)
    } finally {
      pendingSendsRef.current.delete(threadKey)
      setPendingSends(new Set(pendingSendsRef.current))
    }
    if (outcome?.status === 'rejected' || outcome?.status === 'uncertain') {
      setSendFailures(previous => ({ ...previous, [threadKey]: outcome!.status }))
      return
    }
    const sentIds = new Set(files.map(a => a.id))
    setAttachedByThread(previous => ({ ...previous, [threadKey]: (previous[threadKey] ?? []).filter(c => !sentIds.has(c.id)) }))
    clearSubmittedDraft()
    if (draftThreadRef.current === threadKey) setReplyTarget(current => current === replyTarget ? null : current)
  }

  submitRef.current = () => void handleSubmit()

  /** Parse `/spawn <name> <goal>` — name is a Hermes profile/agent or a kind. */
  function runSpawnCommand(raw: string) {
    const parts = raw.split(/\s+/)
    const token = parts[1] ?? ''
    const goal = parts.slice(2).join(' ').trim()
    const resolved = resolveSpawnToken(token, spawnRoster)
    if (!resolved || !goal) {
      const names = spawnRoster.map((a) => peerToken(a)).filter(Boolean)
      const nameHint = names.length > 0 ? names.join(' ') : 'default'
      onSend(
        `/spawn usage: \`/spawn <name> <goal>\` — names: ${nameHint} · kinds: bash executor explore debug custom …`,
      )
      return
    }
    if (!onSpawnSubagent) {
      onSend('[spawn unavailable] the desktop app bridge is required for subagent sessions.')
      return
    }
    const named = spawnRoster.find(
      (a) =>
        peerToken(a).toLowerCase() === token.toLowerCase() ||
        a.name.toLowerCase() === token.toLowerCase(),
    )
    void onSpawnSubagent(
      resolved.kind,
      named ? peerSpawnGoal(named, goal) : goal,
      named?.name ?? (resolved.kind === 'custom' ? resolved.label : undefined),
    )
  }

  function applySpawnSuggestion(item: SpawnSuggestion) {
    setDraft(`/spawn ${item.token} `)
    setSlashSel(0)
    textareaRef.current?.focus()
  }

  function applyMention(item: MentionCandidate) {
    if (!mentionMatch) return
    const el = textareaRef.current
    const at = el?.selectionStart ?? caret
    const next = insertMention(draft, mentionMatch.start, at, item.label)
    // The caret is placed in a layout effect, in the same commit as the new
    // text: a rAF ran after the next keystroke, so fast typing landed the
    // first character at the end of the draft.
    pendingCaretRef.current = next.caret
    setDraft(next.text)
    setCaret(next.caret)
    setSlashSel(0)
  }

  // Paste: a clipboard of files (a screenshot, a file copied in Finder)
  // attaches them like the paperclip does. Text is tidied first
  // (tidyPastedText) so trailing newlines don't open a blank area under the
  // draft. execCommand keeps the insert on the native undo stack; the manual
  // splice is the fallback where it's unsupported.
  /** Attach files: each shows as a tile at once and uploads in the
   *  background; the message they go with is the next one sent. */
  function attachFiles(files: File[], refused: { name: string; error: string }[] = []) {
    if (disabled || !onAttachLocalFiles || files.length + refused.length === 0) return
    const key = threadKey
    const batch = `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    if (refused.length > 0) {
      const notes: ComposerAttachment[] = refused.map((r, i) => ({
        id: `${batch}_x${i}`,
        name: r.name,
        kind: 'file',
        status: 'failed',
        error: r.error,
      }))
      setAttachedByThread((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ...notes] }))
    }
    if (files.length === 0) return
    const isImage = (f: File) => isShowableImageFile(f)
    const chips: ComposerAttachment[] = files.map((f, i) => ({
      id: `${batch}_${i}`,
      name: f.name || 'file',
      kind: isImage(f) ? 'image' : 'file',
      status: 'uploading',
      size: f.size,
      ...(isImage(f) && typeof URL.createObjectURL === 'function' ? { thumb: URL.createObjectURL(f) } : {}),
    }))
    setAttachedByThread((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ...chips] }))
    // Images also travel with the message itself (shrunk to fit), so the agent can see them.
    files.forEach((f, i) => {
      if (!isImage(f)) return
      void inlineImageDataUrl(f).then((url) => {
        if (url) patchAttachment(key, chips[i]!.id, { inline: url })
      })
    })
    uploadAttachments(
      key,
      chips.map((chip, i) => ({ chip, file: files[i]! })),
    )
    textareaRef.current?.focus()
  }

  function patchAttachment(key: string, id: string, next: Partial<ComposerAttachment>) {
    setAttachedByThread((prev) => {
      const list = prev[key]
      if (!list?.some((c) => c.id === id)) return prev // removed meanwhile
      return { ...prev, [key]: list.map((c) => (c.id === id ? { ...c, ...next } : c)) }
    })
  }

  /** Upload chips' files; the originals are kept so a failed one can be retried. */
  function uploadAttachments(key: string, pairs: { chip: ComposerAttachment; file: File }[]) {
    if (!onAttachLocalFiles) return
    for (const { chip, file } of pairs) attachmentFilesRef.current.set(chip.id, file)
    onAttachLocalFiles(
      pairs.map((p) => p.file),
      (r) => {
        const chip = pairs[r.index]?.chip
        if (!chip) return
        if (r.error !== undefined) {
          patchAttachment(key, chip.id, { status: 'failed', error: r.error })
          return
        }
        attachmentFilesRef.current.delete(chip.id)
        // The sent message shows this picture without downloading it back.
        if (chip.thumb) setAttachmentPreview(r.path, chip.thumb)
        // A pasted "image.png" is stamped to stay unique; show the name it got.
        const name = r.path.split('/').pop() || chip.name
        patchAttachment(key, chip.id, { status: 'ready', path: r.path, kind: r.kind, name, error: undefined })
      },
    )
  }

  function retryAttachment(id: string) {
    if (disabled || !onAttachLocalFiles) return
    const file = attachmentFilesRef.current.get(id)
    const chip = attached.find((c) => c.id === id)
    if (!file || !chip) return
    patchAttachment(threadKey, id, { status: 'uploading', error: undefined })
    uploadAttachments(threadKey, [{ chip, file }])
  }

  function removeAttachment(id: string) {
    attachmentFilesRef.current.delete(id)
    setAttachedByThread((prev) => ({ ...prev, [threadKey]: (prev[threadKey] ?? []).filter((c) => c.id !== id) }))
  }

  async function pickLocalAttachments() {
    if (!onPickAttachments || disabled || pendingAttachmentPickRef.current !== null) return
    const key = threadKey
    pendingAttachmentPickRef.current = key
    setPickingAttachments(key)
    setAttachmentError(previous => previous?.thread === key ? null : previous)
    try {
      const files = await onPickAttachments()
      const batch = crypto.randomUUID()
      setAttachedByThread(previous => ({ ...previous, [key]: [
        ...(previous[key] ?? []), ...files.map((file, index): ComposerAttachment => ({
          ...file, id: `${batch}:${index}`, status: 'ready',
        })),
      ] }))
    } catch { setAttachmentError({ thread: key, text: 'Could not attach that file. Check Hermes and try again.' }) }
    finally {
      pendingAttachmentPickRef.current = null
      setPickingAttachments(null)
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const raw = e.clipboardData.getData('text/plain')
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0 && (!raw || isFileNamePaste(raw, files))) {
      if (!onAttachLocalFiles || inSideChat) return
      e.preventDefault()
      attachFiles(files)
      return
    }
    const el = e.currentTarget
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? start
    const text = tidyPastedText(raw, draft.slice(0, start), draft.slice(end))
    if (text === raw) return
    e.preventDefault()
    if (!text) return
    if (document.execCommand?.('insertText', false, text)) return
    pendingCaretRef.current = start + text.length
    setDraft(draft.slice(0, start) + text + draft.slice(end))
    setCaret(start + text.length)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (spawnItems.length === 0 && slashItems.length === 0 && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSel((s) => Math.min(s + 1, mentionItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSel((s) => Math.max(s - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        const item = mentionItems[Math.min(slashSel, mentionItems.length - 1)]
        if (item) applyMention(item)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissedAt(mentionMatch?.start ?? null)
        return
      }
    }
    const menu = spawnItems.length > 0 ? spawnItems : slashItems
    if (menu.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSel((s) => Math.min(s + 1, menu.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSel((s) => Math.max(s - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        if (spawnItems.length > 0) {
          const item = spawnItems[slashSel]
          if (item) applySpawnSuggestion(item)
          return
        }
        const item = slashItems[slashSel]
        if (item) {
          item.run(slashActions)
          if (item.cmd !== '/spawn') setDraft('')
        }
        return
      }
      if (e.key === 'Escape') {
        // Handled here: the window-level Esc (deny a pending ask) skips it.
        e.preventDefault()
        setDraft('')
        return
      }
    }
    if (e.key === 'Escape' && replyTarget) {
      e.preventDefault()
      setReplyTarget(null)
      return
    }
    // Enter confirming an IME word (Japanese, Chinese, Korean…) is not a
    // send; on a phone keyboard Enter is a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && enterSends()) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  // ── Agent identity: looks, names, profile card ─────────────────────────
  const memberIdsForLooks = useMemo(() => mentionMembers.map((m) => m.id), [mentionMembers])
  const looks = useMemo(
    () => roomLooks(memberIdsForLooks, agents),
    // roomStatus changes when a feed lands, which is when member colors
    // learned from other devices arrive.
    [memberIdsForLooks, agents, roomStatus],
  )
  const [profileTarget, setProfileTarget] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [modelDetailsThread, setModelDetailsThread] = useState<string | null>(null)
  useEffect(() => { setProfileTarget(null); setModelDetailsThread(null) }, [threadKey, active])
  const identity = useMemo<AgentIdentity>(
    () => ({
      lookOf: (id) => looks.get(id) ?? agentLook(id, agents),
      nameOf: (id) => agentName?.(id) ?? id,
      idForName: (name) => {
        const n = name.trim().toLowerCase()
        if (!n) return null
        return (
          agents.find((a) => a.name.trim().toLowerCase() === n)?.id ??
          mentionMembers.find((m) => m.name.trim().toLowerCase() === n)?.id ??
          null
        )
      },
      openProfile: inSideChat || !active ? undefined : (id, anchor) => setProfileTarget({ id, anchor }),
    }),
    [looks, agents, agentName, mentionMembers, inSideChat, active],
  )
  const profile = useMemo<AgentProfile | null>(() => {
    if (!profileTarget) return null
    const id = profileTarget.id
    const agent = agents.find((a) => a.id === id)
    const learned = learnedRoomMember(id)
    const inRoom = mentionMembers.length > 0
    const chief = inRoom
      ? roomStatus?.chiefId
        ? roomStatus.chiefId === id
        : agent
          ? isOrchestrator(agent)
          : learned?.role === 'orchestrator'
      : false
    const live = roomStatus?.liveMembers?.[id]
    return {
      id,
      name: identity.nameOf(id),
      title: agent?.persona?.title?.trim() || learned?.title || undefined,
      description: agent?.persona?.description?.trim() || agent?.summary?.trim() || learned?.description || undefined,
      chief,
      look: identity.lookOf(id),
      liveText: live ? (live.phase === 'working' && live.tool ? `using ${live.tool}` : live.phase)
        : !showAgentSpeaker && starterAgent?.id === id && sending
          ? waitingOnUser ? 'waiting for you' : 'working on your request' : null,
      known: Boolean(agent),
      idleText: showAgentSpeaker && !mentionMembers.some(member => member.id === id) ? 'No longer in this room' : undefined,
      unavailableText: id.startsWith('profile:') ? 'This local profile is hidden or unavailable. Its earlier messages stay in this chat.' : undefined,
    }
  }, [profileTarget, agents, mentionMembers, roomStatus, identity, showAgentSpeaker, starterAgent?.id, sending, waitingOnUser])
  const closeProfile = useCallback(() => setProfileTarget(null), [])
  const mentionFromCard = useCallback((name: string) => {
    setDraft((d) => `${d}${d && !/\s$/.test(d) ? ' ' : ''}@${name} `)
    textareaRef.current?.focus()
  }, [])
  // In a room the activity line shows whoever is furthest along, not the
  // group's primary agent.
  const activityMascot = useMemo(() => {
    const lead = !inSideChat ? roomStatus?.leadMemberId : null
    if (!lead) return mascot
    const look = identity.lookOf(lead)
    return look ? { shape: mascot?.shape, color: look.body, eye: look.eye } : mascot
  }, [inSideChat, roomStatus?.leadMemberId, identity, mascot])
  const activityLineProps: ComponentProps<typeof ActivityLine> | null = showActivityLine
    ? {
        mascot: activityMascot,
        agentId: starterAgent?.id ?? `profile:${profileName || 'default'}`,
        presence: mascotPresence ?? (waitingOnUser ? 'waiting-approval' : lastMessage?.role === 'agent' ? messageMascotPresence(lastMessage) : 'thinking'),
        text: stopping ? 'Stopping…' : waitingOnUser
          ? waitingOnUser
          : busyBanner
            ? busyBanner
          : roomPresence
            ? roomPresence
              : liveActivity.mode !== 'none'
                ? liveActivity.text
                : (queuedCount ?? 0) > 0
                  ? 'Queued — sends when the agent is free'
                  : 'Waiting on another agent',
        markState:
          waitingOnUser && !busyBanner && !roomPresence
                ? 'idle'
                : liveActivity.mode !== 'none'
                  ? liveActivity.markState
                  : busyBanner || roomPresence
                    ? 'working'
                    : 'orbit',
        where: liveActivity.where ?? toolWhere,
        queuedCount,
        queuedItems,
        onRemoveQueued,
        turnControl: showRunControl ? { stopping, onStop: stopRunningTurn } : undefined,
      }
    : null
  // The activity line opens and closes its row instead of popping: it sits
  // below the transcript, so appearing / vanishing resized the scroller by
  // ~65px in one frame and the whole transcript lurched at the start and end
  // of every reply. It stays mounted (last props, mascot frozen) while its
  // row collapses, then unmounts.
  const lastActivityPropsRef = useRef(activityLineProps)
  if (activityLineProps) lastActivityPropsRef.current = activityLineProps
  const [activityMounted, setActivityMounted] = useState(showActivityLine)
  if (showActivityLine && !activityMounted) setActivityMounted(true)
  useEffect(() => {
    if (showActivityLine || !activityMounted) return
    const t = window.setTimeout(() => setActivityMounted(false), reduce ? 0 : ACTIVITY_EXIT_MS)
    return () => window.clearTimeout(t)
  }, [showActivityLine, activityMounted, reduce])

  const PermissionSurface = skin === 'messenger' ? InlineApproval : PermissionDock
  const pickerCount = inSideChat ? 0 : spawnItems.length || slashItems.length || mentionItems.length
  const pickerOpen = pickerCount > 0
  const composerInput = (
    <textarea
      ref={textareaRef}
      aria-label="Message the agent"
      aria-controls={pickerOpen ? pickerId : undefined}
      aria-activedescendant={pickerOpen && slashSel < pickerCount ? `${pickerId}-${slashSel}` : undefined}
      aria-autocomplete="list"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        setCaret(e.target.selectionStart ?? e.target.value.length)
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      rows={1}
      enterKeyHint={enterSends() ? 'send' : 'enter'}
      autoCapitalize="sentences"
      autoCorrect="on"
      placeholder={
        readOnly ? 'Draft a message…' : disabled ? 'Choose an agent…'
          : inSideChat ? `Message ${subagentDisplayName(activeRun!.kind, activeRun!.label)}…`
            : awaitingAnswer ? 'Type your answer…'
              : mentionMembers.length > 0 ? 'Message the room · @ to mention'
                : skin === 'messenger' ? 'Message' : 'Message the agent…'
      }
      // Reconnects must not disable a focused textarea and eject its caret.
      // `disabled` still gates Send and every server-backed action.
      disabled={disabledProp}
      className="nub-composer-input max-h-[min(40vh,320px)] min-h-[36px] py-1.5 flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-6 text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] disabled:opacity-50"
    />
  )

  const latestReply = messages.findLast(message => message.role === 'agent')
  const modelContext = !inSideChat && !showAgentSpeaker && profileName ? <ChatSessionContext
    key={threadKey} profile={profileName} configuredModel={model} configuredProvider={provider}
    route={modelRoute} offline={readOnly}
    attention={Boolean(latestReply?.error && isModelRouteError(`${latestReply.errorNote ?? ''} ${latestReply.content}`))}
    open={modelDetailsThread === threadKey} onToggle={open => setModelDetailsThread(open ? threadKey : null)}
    onOpenSettings={onOpenModel || onOpenSettings} onInspectContext={onInspectContext} delegationActions={delegationActions}
    modelActions={readOnly ? undefined : modelActions} /> : undefined

  return (
    <AgentIdentityContext.Provider value={identity}>
    <section
      data-mascot-session={active ? threadKey : undefined}
      data-wallpaper={wallpaper}
      data-skin={skin}
      style={mascot?.color ? { '--messenger-accent': mascot.color } as CSSProperties : undefined}
      // .ca-fade on mount: the chat eases in as it takes over the pane from
      // the boot surface or the splash. Mount-only (ChatPanel persists across
      // thread switches), so opening conversations stays instant.
      className={`ca-fade messenger-chat relative flex h-full min-h-0 min-w-0 flex-1 flex-col ${chatWallpaperClass(wallpaper)}`}
      // Files dropped anywhere on the chat attach to the next message (not
      // only on the composer strip, which was an easy target to miss).
      onDragEnter={(e) => {
        if (!acceptsFileDrop(e)) return
        e.preventDefault()
        dragDepth.current++
        setDropActive(true)
      }}
      onDragOver={(e) => {
        if (!acceptsFileDrop(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!acceptsFileDrop(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropActive(false)
      }}
      onDrop={(e) => {
        if (!acceptsFileDrop(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDropActive(false)
        const { files, folders } = droppedFiles(e.dataTransfer)
        attachFiles(files, folders.map((name) => ({ name, error: 'Folders can’t be sent. Zip it, then drop the .zip' })))
      }}
    >
      {dropActive && (
        <div
          data-testid="chat-drop-overlay"
          className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-3xl border-2 border-dashed border-[var(--ca-primary)] bg-[var(--ca-primary-soft)]/70 backdrop-blur-[2px]"
        >
          <p className="rounded-full bg-[var(--ca-card)] px-4 py-2 text-[14px] font-medium text-[var(--ca-ink)] shadow-[var(--ca-shadow-soft)]">
            Drop to send to the agent computer
          </p>
        </div>
      )}
      {activeRun && (
        <SideChatHeader
          parentName={parentAgentName}
          parentMascot={mascot}
          childLabel={subagentDisplayName(activeRun.kind, activeRun.label)}
          childRunning={activeRun.status === 'queued' || activeRun.status === 'running'}
        />
      )}

      <div className="messenger-transcript-frame relative flex min-h-0 flex-1 flex-row" data-dated={skin === 'messenger' && messages.length > 0 || undefined} data-away={awayFromBottom || undefined}>
        {skin === 'messenger' && messages.length > 0 && <div className="messenger-date-gutter" role="group" aria-label="Current transcript date">
          <span className="messenger-date-pill">{messengerDateLabel(activeDate || messages.at(-1)!.createdAt)}</span>
        </div>}
        <div
          data-testid="chat-scroller"
          ref={(el) => {
            listRef.current = el
            listRefForPrepend.current = el
          }}
          // C5/M3: overflow-anchor keeps the browser from re-anchoring the
          // viewport while rows resize; the JS pin above owns stick-to-bottom.
          style={{ overflowAnchor: 'auto' }}
        onWheel={noteUserScrollIntent}
        onTouchStart={noteUserScrollIntent}
        onTouchMove={noteUserScrollIntent}
        onPointerDown={() => {
          // Scrollbar drag: every scroll event of the drag counts as intent.
          pointerHeldRef.current = true
          noteUserScrollIntent()
        }}
        onPointerUp={() => {
          pointerHeldRef.current = false
        }}
        onPointerCancel={() => {
          pointerHeldRef.current = false
        }}
        onKeyDown={(e) => {
          if (SCROLL_KEYS.has(e.key)) noteUserScrollIntent()
        }}
        onScroll={() => {
          // Re-arm following when the view is back at (near) the bottom —
          // programmatic snaps land there too. Disarm only when the user
          // scrolled up on purpose; browser-initiated scrolls (anchoring,
          // content-visibility height swaps) must not stop following.
          const el = listRef.current
          if (!el) return
          let dateChanged = false
          if (skin === 'messenger') {
            const top = el.getBoundingClientRect().top
            const row = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > top)
            const date = messages.find(message => message.id === row?.dataset.messageId)?.createdAt
            dateChanged = Boolean(date && date !== activeDate)
            if (date) setActiveDate(previous => previous === date ? previous : date)
          }
          const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
          const nearBottom = fromBottom < 48
          const away = fromBottom > JUMP_BUTTON_AFTER_PX && Date.now() > jumpingUntilRef.current
          if (renderCapture.isRecording()) renderCapture.record('scroll', {
            epoch: captureEpochRef.current, rows: messages.length, skin, dateChanged,
            scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
            away, pinned: stickToBottomRef.current, hidden: document.hidden,
          })
          if (away !== awayFromBottom) {
            if (away) awaySinceCountRef.current = messages.length
            setAwayFromBottom(away)
          }
          if (nearBottom) {
            stickToBottomRef.current = true
          } else if (
            pointerHeldRef.current ||
            Date.now() - userScrollIntentAtRef.current < USER_SCROLL_INTENT_MS
          ) {
            stickToBottomRef.current = false
          }
        }}
        tabIndex={-1}
        className="messenger-transcript relative min-h-0 min-w-0 flex-1 isolate space-y-3 overflow-y-auto px-5 py-5 focus:outline-none"
      >
          {findOpen && (
            <div className="sticky top-0 z-20 flex items-center gap-2 rounded-xl bg-[var(--ca-card)] px-3 py-1.5 shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)]">
              <input
                ref={findInputRef}
                aria-label="Find in chat"
                value={findQuery}
                placeholder="Find in chat"
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closeFind()
                    return
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    stepFind(e.shiftKey ? -1 : 1)
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)]"
              />
              <span
                data-testid="find-count"
                aria-live="polite"
                className="shrink-0 text-[11px] tabular-nums text-[var(--ca-ink-muted)]"
              >
                {findQuery.trim() && findCount === 0 ? 'No matches' : findCount === 0 ? '' : (
                  <>
                    <span aria-hidden="true">{Math.min(findIndex, findCount - 1) + 1}/{findCount}</span>
                    <span className="sr-only">{Math.min(findIndex, findCount - 1) + 1} of {findCount}</span>
                  </>
                )}
              </span>
              <button
                type="button"
                aria-label="Previous match"
                onClick={() => stepFind(-1)}
                disabled={findCount === 0}
                className="rounded-md px-1.5 py-0.5 text-xs text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)] disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Next match"
                onClick={() => stepFind(1)}
                disabled={findCount === 0}
                className="rounded-md px-1.5 py-0.5 text-xs text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)] disabled:opacity-40"
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="Close find"
                onClick={closeFind}
                className="rounded-md px-1.5 py-0.5 text-xs text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)]"
              >
                {/* "Esc" is a key hint; a phone has no key to press. */}
                Esc
              </button>
            </div>
          )}
          <div
            key={activeRun ? `side:${activeRun.id}` : threadKey}
            ref={listInnerRef}
            className="space-y-3"
          >
            {activeRun && (
              <SubagentThreadView
                run={activeRun}
                parentName={parentAgentName}
                parentMascot={mascot}
              />
            )}
            {skeletonVisible && <TranscriptIntro mascot={mascot} />}
            {!inSideChat && (
              <div className={revealThread === threadKey ? 'space-y-4 ca-transcript-in' : 'space-y-4'}>
                {hasEarlier && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      data-testid="load-earlier"
                      ref={loadEarlierBtnRef}
                      onClick={loadEarlier}
                      // aria-disabled (not `disabled`): a disabled button
                      // drops keyboard focus mid-load. loadEarlier early-
                      // returns while a page is in flight.
                      aria-disabled={renderFrom === 0 && historyLoadingOlder}
                      aria-busy={renderFrom === 0 && historyLoadingOlder}
                      className="rounded-full border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] shadow-[var(--ca-shadow-soft)] transition hover:bg-[var(--ca-hover)] aria-disabled:opacity-60"
                    >
                      {renderFrom > 0
                        ? `Load earlier messages (${renderFrom})`
                        : historyLoadingOlder
                          ? 'Loading earlier messages…'
                          : 'Load earlier messages'}
                    </button>
                  </div>
                )}
                <TranscriptDays skin={skin} messages={visibleTopLevel}>
                {visibleTopLevel.map((m, i) => (
                  <TranscriptRow
                    key={m.id}
                    m={m}
                    entering={enteringIds.has(m.id)}
                    liveAvatar={m.id === liveAvatarId}
                    groupPos={bubbleGroups[i] ?? 'single'}
                    repliesChip={
                      repliesByRoot.has(m.id)
                        ? repliesChipLabelForRoot(m.id, threadGroupsMemo)
                        : ''
                    }
                    showArtifacts={
                      Boolean(onOpenPreview || onDownloadProject || onOpenHost) &&
                      projectArtifacts.length > 0 &&
                      renderFrom + i === artifactAfterIndex
                    }
                    highlighted={highlightMessageId === m.id}
                    projectArtifacts={
                      (onOpenPreview || onDownloadProject || onOpenHost) &&
                      projectArtifacts.length > 0 &&
                      renderFrom + i === artifactAfterIndex
                        ? projectArtifacts
                        : EMPTY_ARTIFACTS
                    }
                    agentName={agentName}
                    showAgentSpeaker={showAgentSpeaker}
                    onChoice={answeredChoices.has(m.id) ? undefined : onChoice}
                    onOpenSubagent={openSubagent}
                    onCancelSubagent={onCancelSubagent ? cancelHelper : undefined}
                    onOpenFile={onOpenFile}
                    onOpenPreview={onOpenPreview}
                    onOpenHost={onOpenHost}
                    onDownloadProject={onDownloadProject}
                    onSaveFileToMac={onSaveFileToMac}
                    onOpenThread={openThreadFor}
                    onReplyToMessage={replyToMessage}
                    onReactToMessage={onReact ? reactToMessage : undefined}
                    onRetryTurn={onRetryTurn ? retryTransportTurn : undefined}
                    retryBusy={retryBusy}
                    onDiscardPending={onDiscardPending}
                    onEditMessage={editMessage}
                    onAskAgain={askAgain?.rowId === m.id ? askAgainNow : undefined}
                    handoffStrip={!inSideChat ? roomHandoffs?.get(m.id) : undefined}
                    onJumpToRow={jumpToRow}
                    onOpenHandoff={openHandoff}
                    mentions={!inSideChat && mentionMembers.length > 0 ? mentionMembers : undefined}
                    skin={skin}
                    pickedUp={pickedUpIds.has(m.id)}
                    onBranch={onBranch}
                    replySender={m.replyTo?.role === 'user' ? 'You' : (() => {
                      const target = m.replyTo ? messagesById.get(m.replyTo.id) : undefined
                      return target?.fromAgentId && agentName ? agentName(target.fromAgentId) : parentAgentName
                    })()}
                  />
                ))}
                </TranscriptDays>
                {projectArtifacts.length > 0 && (onOpenPreview || onDownloadProject || onOpenHost) && artifactAfterIndex < 0 && (
                  <ArtifactStack
                    artifacts={projectArtifacts}
                    onPreview={onOpenPreview}
                    onDownload={onDownloadProject}
                    onHost={onOpenHost}
                  />
                )}
              </div>
            )}
            {/* The first load failed and left no rows: the thread is unknown,
                not empty — offer the retry instead of a fresh-chat starter. */}
            {!inSideChat && !sending && !transcriptLoading && transcriptError && !messages.some((m) => m.role !== 'system') && (
              <div data-testid="transcript-error" className="ca-enter flex min-h-40 flex-col items-center justify-center gap-3 py-6">
                <p className="sand-on-wall rounded-full border border-[var(--ca-border)] px-3 py-1 text-[12px] text-[var(--ca-ink-muted)]">
                  Couldn’t load this conversation.
                </p>
                <button
                  type="button"
                  onClick={onRetryTranscript}
                  className="rounded-full border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] shadow-[var(--ca-shadow-soft)] transition hover:bg-[var(--ca-hover)]"
                >
                  Retry
                </button>
              </div>
            )}
            {/* Nothing from you or the agent yet (a new chat opens on a
                "Conversation started." note): offer a first message. */}
            {!inSideChat && !sending && !transcriptLoading && !transcriptError && !messages.some((m) => m.role !== 'system') && (
              <div data-testid="chat-starters" className="ca-enter flex min-h-40 flex-col items-center justify-center gap-3 py-6">
                <Pip agentId={starterAgent?.id ?? 'default'} profile={starterAgent} presence={mascotPresence} lookAtCursor size={64} />
                <p className="sand-on-wall rounded-full border border-[var(--ca-border)] px-3 py-1 text-[12px] text-[var(--ca-ink-muted)]">
                  {readOnly ? 'Hermes is offline. Open Settings to reconnect.' : showAgentSpeaker ? 'Message the room, or @mention a member to direct the work.' : starterAgent ? 'Send a message to this local profile.' : 'Choose a local profile in the sidebar to start.'}
                </p>
                <div className="flex max-w-xl flex-wrap justify-center gap-2">
                  {chatStarters(starterAgent, mentionMembers.length > 0).map((text) => (
                    <button
                      key={text}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        pendingCaretRef.current = text.length
                        setDraft(text)
                        textareaRef.current?.focus()
                      }}
                      className="nub-chip messenger-starter-chip px-3 py-1.5 text-[13px] font-medium disabled:opacity-50"
                      style={{ background: 'var(--desk-surface-3)', color: 'var(--desk-text-primary)', borderColor: 'var(--desk-agent-accent)' }}
                    >
                      {starterLabel(text)}
                    </button>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>

        {transcriptSyncing && !awayFromBottom && !inSideChat && messages.length > 0 && (
          <TranscriptSyncPill
            mode={transcriptSyncing}
            className={threadRootId !== null ? 'left-4' : 'left-1/2 -translate-x-1/2'}
          />
        )}
        {awayFromBottom && (
          <button
            type="button"
            data-testid="jump-to-latest"
            onClick={jumpToLatest}
            aria-label={newSinceAway ? 'New reply below. Jump to latest' : 'Jump to latest'}
            className={`nub-glass nub-glass-solid messenger-latest absolute bottom-3 z-20 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)] ${
              threadRootId !== null && !inSideChat ? 'left-4' : 'left-1/2 -translate-x-1/2'
            }`}
          >
            {newSinceAway && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--ca-primary)]" />}
            {newSinceAway ? 'New reply' : 'Latest'}
            <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v10M4 9l4 4 4-4" />
            </svg>
          </button>
        )}

        {threadRootId !== null && !inSideChat && (
          <LiveThreadPane
            open
            onClose={() => setThreadRootId(null)}
            messages={threadMessagesForRoot(threadRootId, threadGroupsMemo)}
            width={viewportWidth}
            onSend={onSend}
            agentName={agentName}
            title={threadTitle}
            skin={skin}
            accentColor={mascot?.color}
            profile={profileName || starterAgent?.hermesProfile || 'default'}
            model={model}
            room={showAgentSpeaker}
            pickedUpMessageIds={pickedUpIds}
          />
        )}
      </div>
      {skin === 'messenger' && !inSideChat && <SessionFooter todos={todos} usage={usage} />}

      <span className="sr-only" aria-live="polite" data-testid="reply-announcement">{replyAnnouncement}</span>
      {activityMounted && lastActivityPropsRef.current && (
        <div className="ca-activity-slot" data-open={showActivityLine ? 'true' : 'false'}>
          <div className="ca-activity-slot-inner">
            <ActivityLine {...lastActivityPropsRef.current} leaving={!showActivityLine} />
          </div>
        </div>
      )}

      {localRoom && !inSideChat && <RoomUsage key={localRoom.conversationId} journal={localRoom}
        memberName={agentName ?? (id => id)} onSetBudget={onSetRoomBudget} />}
      {composerNote && (
        <div data-testid="helper-note" role="alert" className="flex shrink-0 justify-center px-5 pb-1">
          <span className="sand-on-wall rounded-full border border-[var(--ca-border)] px-3 py-0.5 text-[11px] text-[var(--ca-danger)]">
            {composerNote}
            {sendFailures[threadKey] === 'uncertain' && (
              <button type="button" className="ml-2 underline" onClick={() => {
                void onAcknowledgeUncertain?.(threadKey)
                setSendFailures(previous => ({ ...previous, [threadKey]: 'rejected' }))
              }}>
                I checked the transcript
              </button>
            )}
          </span>
        </div>
      )}

      {turnControlNote && !inSideChat && (
        <div role="alert" className="flex shrink-0 justify-center px-5 pb-1">
          <span className="sand-on-wall inline-flex min-w-0 items-center gap-1.5 rounded-xl border border-[var(--ca-border)] py-1 pl-3 pr-1 text-[11px] text-[var(--ca-danger)]">
            <span>{turnControlNote}</span>
            <button type="button" aria-label="Dismiss turn control error" onClick={() => setTurnControlNote(null)}
              className="shrink-0 rounded-full px-2 py-1 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)]">
              ×
            </button>
          </span>
        </div>
      )}

      {roomPassLine && (
        <div
          data-testid="room-pass-line"
          role="status"
          className="flex shrink-0 justify-center px-5 pb-1"
        >
          {/* Same pill as a system notice, so it reads on any wallpaper. */}
          <span className="sand-on-wall inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--ca-border)] py-0.5 pl-3 pr-1 text-[11px] text-[var(--ca-ink-muted)]">
          <span className="truncate">{roomPassLine}</span>
          <button
            type="button"
            aria-label="Hide"
            title="Hide"
            onClick={() => {
              if (passLineKey) setHiddenPassLines((prev) => new Set(prev).add(passLineKey))
            }}
            className="rounded-full px-1 leading-none text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
          >
            ×
          </button>
          </span>
        </div>
      )}

      {!readOnly && !inSideChat && !roomStatus?.live && roomStatus?.canRetry && onRetryTurn && (
        <div className="flex shrink-0 justify-center px-5 pb-1">
          <button
            type="button"
            onClick={retryTransportTurn}
            disabled={retryBusy}
            className="sand-on-wall rounded-full border border-[var(--ca-border)] px-3 py-0.5 text-[11px] text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)] disabled:opacity-50"
          >
            {retryBusy ? 'Trying again…' : 'Try failed members again'}
          </button>
        </div>
      )}

      {!readOnly && (!inSideChat || canMessageSide) && <AgentPromptDock conversationId={threadKey} />}
      {inSideChat && !canMessageSide ? (
        <SideChatFooter onClose={() => setActiveSubagentId(null)} />
      ) : (
      <form
        onSubmit={handleSubmit}
        className="messenger-form relative p-3"
      >
        {skin === 'classic' && modelContext}
        {inSideChat && (
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--ca-ink-muted)]">Message this agent</span>
            <button
              type="button"
              onClick={() => setActiveSubagentId(null)}
              className="rounded-full px-3 py-1 text-xs font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)]"
            >
              Close Chat
            </button>
          </div>
        )}
        {!inSideChat && spawnItems.length === 0 && slashItems.length === 0 && mentionItems.length > 0 && (
          <div
            data-testid="mention-picker"
            id={pickerId}
            role="listbox"
            aria-label="Mention a member"
            className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-xl bg-[var(--ca-card)] shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)]"
          >
            {mentionItems.map((item, i) => (
              <button
                key={item.id}
                id={`${pickerId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === slashSel}
                onMouseEnter={() => setSlashSel(i)}
                // Keep the textarea focused (and its caret) through the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyMention(item)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                  i === slashSel ? 'bg-[var(--ca-primary-soft)]' : ''
                }`}
              >
                {item.id !== 'everyone' && <Pip agentId={item.id} size={18} reducedMotion />}
                <span className="text-sm font-medium text-[var(--ca-primary-text)]">@{item.label}</span>
                {item.detail ? (
                  <span className="flex-1 truncate text-right text-[11px] text-[var(--ca-ink-muted)]">
                    {item.detail}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
        {(!inSideChat && (slashItems.length > 0 || spawnItems.length > 0)) && (
          <div
            id={pickerId}
            role="listbox"
            aria-label={spawnItems.length > 0 ? 'Subagent suggestions' : 'Commands'}
            className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-xl bg-[var(--ca-card)] shadow-[var(--ca-shadow-soft)] ring-1 ring-[var(--ca-border)]"
          >
            {spawnItems.length > 0 &&
              spawnItems.map((item, i) => (
                <button
                  key={`${item.source}:${item.token}`}
                  id={`${pickerId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === slashSel}
                  onMouseEnter={() => setSlashSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySpawnSuggestion(item)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                    i === slashSel ? 'bg-[var(--ca-primary-soft)]' : ''
                  }`}
                >
                  <span className="font-mono text-sm text-[var(--ca-primary-text)]">{item.token}</span>
                  <span className="flex-1 truncate text-xs text-[var(--ca-ink)]">{item.label}</span>
                  <span className="text-[9px] uppercase tracking-wider text-[var(--ca-ink-muted)]">
                    {item.detail}
                  </span>
                </button>
              ))}
            {spawnItems.length === 0 &&
              slashItems.map((item, i) => (
                <button
                  key={item.cmd}
                  id={`${pickerId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === slashSel}
                  onMouseEnter={() => setSlashSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    item.run(slashActions)
                    if (item.cmd !== '/spawn') setDraft('')
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                    i === slashSel ? 'bg-[var(--ca-primary-soft)]' : ''
                  }`}
                >
                  <span className="font-mono text-sm text-[var(--ca-primary-text)]">{item.cmd}</span>
                  <span className="flex-1 truncate text-xs text-[var(--ca-ink)]">{item.label}</span>
                  <span className="text-[9px] uppercase tracking-wider text-[var(--ca-ink-muted)]">
                    {item.detail}
                  </span>
                </button>
              ))}
          </div>
        )}
        {!inSideChat && permissionAsk && onPermission && (
          <PermissionSurface
            ask={permissionAsk}
            {...(skin === 'messenger' ? { agentName: starterAgent?.name || parentAgentName } : {})}
            onChoice={(choice, opts) => {
              if (opts?.optionId) {
                const label =
                  permissionAsk.options?.find((o) => o.id === opts.optionId)?.label ?? opts.optionId
                setWidgetResolved(label)
                if (widgetResolveTimer.current !== null) window.clearTimeout(widgetResolveTimer.current)
                widgetResolveTimer.current = window.setTimeout(() => setWidgetResolved(null), 1600)
              }
              // Legacy buttons keep today's exact single-argument call shape.
              if (opts === undefined) onPermission(choice)
              else onPermission(choice, opts)
            }}
          />
        )}
        {!permissionAsk &&
          widgetResolved !== null &&
          (() => {
            const reduced = prefersReducedMotion()
            return (
              <div
                data-testid="widget-resolved"
                role="status"
                style={reduced ? undefined : { transition: 'opacity 0.18s ease-out' }}
                className="mb-2 flex items-center gap-1.5 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-[12px] text-[var(--ca-ink-muted)] shadow-[var(--ca-shadow-soft)]"
              >
                <span aria-hidden>✓</span>
                <span>
                  Answered: <span className="font-medium text-[var(--ca-ink)]">{widgetResolved}</span>
                </span>
              </div>
            )
          })()}
        {!inSideChat && replyTarget && (
          <ReplyPill replyTo={replyTarget} onClear={() => setReplyTarget(null)} />
        )}
        {/* M4: solid fill, same alpha as the glass fill — the composer sits
            directly over the scrolling transcript, and a 16px backdrop blur
            there promoted an extra compositor layer per frame. Modals keep
            their blur (nothing scrolls under them). */}
        {skin === 'messenger' ? (
          <>
            {!inSideChat && onAttachLocalFiles && (
              <input ref={fileInputRef} type="file" aria-label="Attach files" multiple className="hidden" onChange={(e) => {
                const files = Array.from(e.target.files || [])
                e.target.value = ''
                if (files.length) attachFiles(files)
              }} />
            )}
            <MessengerComposer
              key={threadKey}
              input={composerInput}
              tray={!inSideChat && attached.length > 0 ? <AttachmentTray items={attached} onRemove={removeAttachment} onRetry={retryAttachment} retryDisabled={disabled} /> : undefined}
              hasText={draft.trim() !== '' || attachReady.length > 0 || attachUploading}
              disabled={disabled}
              sendDisabled={!inSideChat && (pickingHere || sendHeld)}
              profile={profileName || starterAgent?.hermesProfile || 'default'}
              model={inSideChat ? 'Helper session' : modelRoute?.model ?? model}
              context={modelContext}
              room={showAgentSpeaker}
              onCommands={() => { setDraft('/'); setSlashSel(0); textareaRef.current?.focus() }}
              onModel={inSideChat ? undefined : modelContext ? () => setModelDetailsThread(threadKey) : onOpenModel || onOpenSettings}
              onSkills={inSideChat || showAgentSpeaker ? undefined : onOpenSkills}
              onGenUi={inSideChat || readOnly ? undefined : setGenUiDraft}
              onAttach={!inSideChat && (onPickAttachments || onAttachLocalFiles || onCopyToBox) && !pickingAttachments ? () => {
                if (onPickAttachments) void pickLocalAttachments()
                else if (onAttachLocalFiles) fileInputRef.current?.click()
                else onCopyToBox?.()
              } : undefined}
              onEmoji={(emoji) => {
                const input = textareaRef.current
                const start = input?.selectionStart ?? draft.length
                const end = input?.selectionEnd ?? start
                pendingCaretRef.current = start + emoji.length
                setDraft(draft.slice(0, start) + emoji + draft.slice(end))
                textareaRef.current?.focus()
              }}
              onStartDictate={startDictate}
              onStopDictate={stopDictate}
              dictateStatus={dictateStatus}
              dictateIndicator={dictateStatus === 'denied'
                ? dictateDeniedCopy({ desktop: sttBridgeAvailable(), nativePhone: false })
                : <>{dictateLevelsSupported && <VoiceBars levels={dictateLevels} />}<span>{dictateStatus === 'processing' ? 'Transcribing…' : 'Listening…'}</span>{dictateSeconds > 0 && <span>{formatDictateTime(dictateSeconds)}</span>}</>}
              sendLabel={queuedHere ? 'Sending when files finish uploading — press to cancel' : 'Send'}
              sendQueued={Boolean(queuedHere)}
            />
          </>
        ) : (
        <div className="nub-glass nub-glass-solid flex flex-wrap items-end gap-x-3 rounded-2xl px-3 py-2.5">
          {/* The tray takes a full row above the input line when files are attached. */}
          {!inSideChat && attached.length > 0 && (
            <div className="basis-full">
              <AttachmentTray items={attached} onRemove={removeAttachment} onRetry={retryAttachment} retryDisabled={disabled} />
            </div>
          )}
          {(onPickAttachments || onCopyToBox || onAttachLocalFiles) && !inSideChat && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                aria-label="Attach files"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || [])
                  e.target.value = ''
                  if (files.length && onAttachLocalFiles) attachFiles(files)
                  else if (files.length && onCopyToBox) onCopyToBox()
                }}
              />
              <button
                type="button"
                aria-label="Attach a file"
                title="Send a file or image (or drag onto the composer)"
                onClick={() => {
                  if (onPickAttachments) void pickLocalAttachments()
                  else if (onAttachLocalFiles) fileInputRef.current?.click()
                  else onCopyToBox?.()
                }}
                disabled={disabled || pickingAttachments !== null}
                className="mb-0.5 rounded-full p-1 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-50"
              >
                <PaperclipIcon />
              </button>
            </>
          )}
          {composerInput}
          {dictateStatus !== 'unavailable' &&
            (dictateStatus === 'listening' || dictateStatus === 'processing' ? (
              <button
                type="button"
                aria-label="Stop dictation"
                title={dictateStatus === 'processing' ? 'Transcribing locally…' : 'Stop dictation'}
                disabled={disabled || dictateStatus === 'processing'}
                onClick={() => stopDictate()}
                onPointerUp={() => stopDictate()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && dictateStatus === 'listening') {
                    e.preventDefault()
                    stopDictate()
                  }
                }}
                className="mb-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[var(--ca-hover)] px-2.5 text-[11px] font-medium text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)]"
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--ca-primary-fill)] text-white"
                >
                  <span className="block h-[6px] w-[6px] rounded-[1px] bg-white" />
                </span>
                {dictateLevelsSupported ? (
                  <VoiceBars className="text-[var(--ca-primary-text)]" levels={dictateLevels} />
                ) : (
                  // The platform recognizer exposes no audio levels, so an EQ
                  // here would be animation pretending to be a meter. A pulse
                  // says "listening" without claiming to measure anything.
                  <span
                    className="ca-listening-pulse"
                    aria-hidden="true"
                  />
                )}
                <span role="status" className="whitespace-nowrap text-[var(--ca-ink)]">
                  {dictateStatus === 'processing' ? 'Transcribing…' : 'Listening…'}
                </span>
                {dictateSeconds > 0 && (
                  <span className="whitespace-nowrap tabular-nums text-[var(--ca-ink-muted)]">
                    {formatDictateTime(dictateSeconds)}
                  </span>
                )}
              </button>
            ) : dictateStatus === 'denied' ? (
              <span
                role="status"
                className="mb-0.5 min-w-0 text-[11px] leading-tight text-[var(--ca-ink-muted)]"
              >
                {dictateDeniedCopy({ desktop: sttBridgeAvailable(), nativePhone: false })}
              </span>
            ) : (
              <button
                type="button"
                aria-label="Click or hold to dictate"
                title="Click or hold to dictate"
                disabled={disabled}
                onPointerDown={(e) => {
                  if (e.button !== 0 || disabled) return
                  dictateHoldRef.current = false
                  window.clearTimeout(dictateHoldTimerRef.current)
                  dictateHoldTimerRef.current = window.setTimeout(() => {
                    dictateHoldRef.current = true
                    startDictate()
                  }, 350)
                }}
                onPointerUp={() => {
                  window.clearTimeout(dictateHoldTimerRef.current)
                  if (dictateHoldRef.current) {
                    dictateHoldRef.current = false
                    stopDictate()
                    return
                  }
                  startDictate()
                }}
                onPointerCancel={() => {
                  window.clearTimeout(dictateHoldTimerRef.current)
                  if (dictateHoldRef.current) {
                    dictateHoldRef.current = false
                    stopDictate()
                  }
                }}
                onClick={(e) => {
                  // Pointer takes are handled above; keyboard activation has detail 0.
                  if (e.detail === 0 && !disabled) startDictate()
                }}
                className="mb-0.5 rounded-full p-1 text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-50"
              >
                <MicIcon />
              </button>
            ))}
          {!disabled && (draft.trim() !== '' || attachReady.length > 0 || attachUploading) && (
            <button
              type="submit"
              aria-label={queuedHere ? 'Sending when files finish uploading — press to cancel' : 'Send'}
              aria-pressed={attachUploading ? queuedHere : undefined}
              disabled={!inSideChat && (pickingHere || sendHeld)}
              title={
                !inSideChat && pickingHere
                  ? 'Wait for the files to finish attaching'
                  : queuedHere
                  ? 'Sends when the files finish uploading (press to cancel)'
                  : attachUploading
                    ? 'Send when the files finish uploading'
                    : 'Send'
              }
              className={`maia-send-in mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white disabled:opacity-50 ${
                queuedHere
                  ? 'bg-[var(--ca-primary-fill)]/70'
                  : attachUploading
                    ? 'bg-[var(--ca-primary-fill)]/55 hover:bg-[var(--ca-primary-fill)]'
                    : 'bg-[var(--ca-primary-fill)] hover:bg-[var(--ca-primary-fill-hover)]'
              }`}
            >
              {queuedHere ? (
                <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" />
              ) : (
                <SendIcon />
              )}
            </button>
          )}
        </div>
        )}
      </form>
      )}
    </section>
    {roomHandoffs && (
      <HandoffTranscriptModal
        open={handoffView !== null}
        rowId={handoffView?.rowId ?? null}
        focusTurnId={handoffView?.turnId || null}
        strips={roomHandoffs}
        threadStrips={roomThreadStrips}
        messages={messages}
        agentName={agentName}
        mentions={mentionMembers.length > 0 ? mentionMembers : undefined}
        onJump={jumpToRow}
        onReply={
          disabled
            ? undefined
            : (text, target) => onSend(text, { replyTo: replyPreviewForMessage(target) })
        }
        onClose={closeHandoff}
      />
    )}
    {active && profile && profileTarget && (
      <AgentProfileCard
        profile={profile}
        anchor={profileTarget.anchor}
        onClose={closeProfile}
        onMessage={onOpenAgent}
        onMention={!disabled && !readOnly && mentionMembers.some(member => member.id === profile.id) ? mentionFromCard : undefined}
      />
    )}
    </AgentIdentityContext.Provider>
  )
})
