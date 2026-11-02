/** Transcript rendering owns per-row live subscriptions and user actions. */
import { memo } from 'react'
import type { ChatMessage, SubagentKind, SubagentStatus } from '../../lib/agents/types'
import { useLiveMessage } from '../../lib/agents/useLiveMessage'
import { isReplyPartRow } from '../../lib/agents/answer-placement'
import type { HandoffStrip } from '../../lib/agents/rooms'
import type { MentionMember } from '../../lib/mentions'
import type { BubbleGroupPos } from '../../lib/bubble-groups'
import { cachedDateFormat } from '../../lib/date-format'
import { displayUserPrompt } from '../../lib/peer-roster'
import { extractReplyMedia } from '../../lib/reply-media'
import { safeLinkUrl } from '../../lib/safe-image-url'
import { areMessageReactionsEnabled } from '../../lib/message-actions'
import { fileCardsForMessage } from '../../lib/file-refs'
import { screenshotPathsFromMessage, type ProjectArtifact } from '../../lib/project-artifacts'
import { AgentMascot as Pip } from '../AgentMascot'
import { AgentNameChip, useAgentIdentity } from '../agent-identity'
import { MessageBody, messageHasWideContent } from '../MessageBody'
import { validatedGenUiEvents } from '../../lib/genui'
import { SystemNotice } from './SystemNotice'
import { MessageAttachments } from '../Attachments'
import { MessageActionAnchor } from '../MessageActions'
import { LinkPreviews } from '../LinkPreviewCard'
import { ReplyQuote } from '../ReplyQuote'
import { ProjectArtifactCard } from '../ProjectArtifactCard'
import { FileCardStack } from '../FileCard'
import { RoomHandoffStrip } from '../RoomHandoffStrip'
import { QuotedReply } from './QuotedReply'
import { ReadTicks, messengerTime } from './ReadTicks'
import { messageMascotPresence } from './presence'

const KIND_LABEL: Record<SubagentKind, string> = {
  executor: 'Executor',
  browserUse: 'Browser',
  computerUse: 'Computer',
  cloudCoder: 'Cloud coder',
  watcher: 'Watcher',
  explore: 'Explore',
  bash: 'Shell',
  shell: 'Shell',
  debug: 'Debug',
  mediaReview: 'Media',
  watchVideo: 'Video',
  cursorGuide: 'Cursor',
  fileGlobbed: 'Files',
  custom: 'Custom',
}

export function subagentDisplayName(kind: SubagentKind, label?: string): string {
  const named = label?.trim()
  return named || KIND_LABEL[kind]
}

function subagentEventVerb(status: SubagentStatus): 'Messaged' | 'Message from' {
  return status === 'queued' || status === 'running' ? 'Messaged' : 'Message from'
}

function statusDotClass(status: SubagentStatus): string {
  if (status === 'queued' || status === 'running') return 'animate-pulse bg-[var(--ca-primary)]'
  if (status === 'failed') return 'bg-[var(--ca-danger)]'
  if (status === 'completed') return 'bg-[var(--ca-success)]'
  return 'bg-[var(--ca-ink-muted)]'
}

/** "Messaged Penny": Penny's own mascot when the label names a known agent. */
function SubagentMascot({ label }: { label: string }) {
  const { idForName } = useAgentIdentity()
  const id = idForName?.(label) ?? null
  return <Pip agentId={id ?? label} size={16} reducedMotion />
}

function ChatAgentAvatar({ message, live }: { message: ChatMessage; live: boolean }) {
  const identity = useAgentIdentity()
  const avatar = <Pip agentId={message.fromAgentId ?? 'default'} presence={messageMascotPresence(message)}
    size={28} reducedMotion={!live} className="messenger-bubble-avatar" />
  if (!message.fromAgentId || !identity.openProfile) return avatar
  const id = message.fromAgentId
  return <button type="button" className="messenger-bubble-avatar-button self-start shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--ca-primary)] focus-visible:outline-offset-2"
    aria-label={`About ${identity.nameOf(id)}`} onClick={event => identity.openProfile?.(id, event.currentTarget)}>
    {avatar}
  </button>
}


/** Clock glyph for a send parked in the offline outbox. */
function ClockIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.3 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


/** Retry glyph for a failed turn. */
function RetryIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.8 6.6A5 5 0 1 0 13 8.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13.4 2.9v3.9H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


export function ArtifactStack({
  artifacts,
  onPreview,
  onDownload,
  onHost,
}: {
  artifacts: ProjectArtifact[]
  onPreview?: (artifact: ProjectArtifact) => void
  onDownload?: (artifact: ProjectArtifact) => void
  onHost?: (artifact: ProjectArtifact) => void
}) {
  return (
    <div data-project-artifacts className="relative z-0 space-y-2">
      {artifacts.map((artifact) => (
        <ProjectArtifactCard
          key={artifact.id}
          artifact={artifact}
          onPreview={onPreview}
          onDownload={onDownload}
          onHost={onHost}
        />
      ))}
    </div>
  )
}


/** A message as the reader sees it, for Copy. */
export function copyTextOf(m: ChatMessage): string {
  if (m.role === 'user') return displayUserPrompt(m.content)
  return extractReplyMedia(m.content).text
}

/** Tooltip-only timestamp for a bubble (clean look — no visible time element).
 *  Mirrors the home list's locale time format (home-model.ts), with a short
 *  date so older messages still read unambiguously. */
function messageTimeTitle(iso: string): string | undefined {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return undefined
  return cachedDateFormat('bubble', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(t)
}

const Bubble = memo(function Bubble({
  msg,
  onChoice,
  agentName,
  onOpenSubagent,
  onCancelSubagent,
  onOpenFile,
  flush,
  tagSpeaker,
  repliesChip = '',
  messageId,
  onOpenThread,
  onRetry,
  retryBusy,
  onDiscardPending,
  groupPos = 'single',
  mentions,
  skin = 'classic',
  pickedUp = false,
  onJumpToRow,
  replySender,
}: {
  msg: ChatMessage
  onChoice?: (choiceId: string, label: string) => void
  agentName?: (id: string) => string
  /** Place in a run of same-speaker bubbles — drives the corner shape. */
  groupPos?: BubbleGroupPos
  /** Grok Bot parity: click the subagent bubble → open its sub-thread window. */
  onOpenSubagent?: (runId: string) => void
  onCancelSubagent?: (runId: string) => void
  onOpenFile?: (path: string) => void
  /** Parent already owns row alignment (hover-action shrink-wrap). */
  flush?: boolean
  tagSpeaker?: boolean
  /** Group room members: `@Name` tokens in the text render as mention chips. */
  mentions?: MentionMember[]
  /** A4: "N replies" chip on a collapsed thread root. */
  repliesChip?: string
  /** Stable row opener: the parent passes the callback once and the row id
   *  per bubble, so the prop identity never churns during streaming ticks. */
  messageId?: string
  onOpenThread?: (messageId: string) => void
  /** Failed turn → offer a resend. */
  onRetry?: () => void
  /** A resend is in flight — block a second tap. */
  retryBusy?: boolean
  /** Drop a parked offline send (only meaningful on `msg.pending` rows). */
  onDiscardPending?: () => void
  skin?: 'messenger' | 'classic'
  pickedUp?: boolean
  onJumpToRow?: (messageId: string) => void
  replySender?: string
}) {
  const isUser = msg.role === 'user'
  const isSystem = msg.role === 'system'
  const isSubagent = msg.role === 'subagent'
  const isAgentDm = msg.role === 'agent' && !!msg.fromAgentId && !!msg.toAgentId
  const speaker =
    msg.fromAgentId && agentName ? agentName(msg.fromAgentId) : msg.fromAgentId
  const media = isUser ? null : extractReplyMedia(msg.content)
  const errorActionUrl = msg.errorAction ? safeLinkUrl(msg.errorAction.url) : null
  const errorAction =
    msg.errorAction && errorActionUrl?.startsWith('https://')
      ? { label: msg.errorAction.label, url: errorActionUrl }
      : null

  if (isSystem) {
    return <SystemNotice content={msg.content} details={msg.noticeDetails} />
  }

  if (isSubagent) {
    const kind = msg.subagentKind ?? 'executor'
    const status = msg.subagentStatus ?? 'running'
    const runId = msg.subagentRunId
    const label = subagentDisplayName(kind, msg.subagentLabel)
    const verb = subagentEventVerb(status)
    const live = status === 'queued' || status === 'running'
    return (
      <div className="flex justify-start gap-1">
        <button
          type="button"
          onClick={() => runId && onOpenSubagent?.(runId)}
          disabled={!runId}
          title={runId ? `Open ${label} conversation` : undefined}
          className={`nub-subagent-pill sand-on-wall inline-flex items-center gap-1.5 rounded-full border border-[var(--ca-border)] py-1 pl-1 pr-2.5 text-left text-[12px] text-[var(--ca-ink-muted)] transition ${
            runId
              ? 'cursor-pointer hover:text-[var(--ca-ink)]'
              : 'cursor-default'
          }`}
        >
          <SubagentMascot label={label} />
          <span>
            {verb} {label}
          </span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(status)}`} />
        </button>
        {live && runId && onCancelSubagent && (
          <button
            type="button"
            aria-label={`Stop ${label}`}
            title={`Stop ${label}`}
            onClick={() => onCancelSubagent(runId)}
            className="sand-on-wall rounded-full border border-[var(--ca-border)] px-2 py-1 text-[11px] text-[var(--ca-ink-muted)] transition hover:text-[var(--ca-ink)]"
          >
            Stop
          </button>
        )}
      </div>
    )
  }

  // Files sent with the message (they have a place on the agent computer):
  // pictures and file cards beside the bubble, not rows inside it.
  const sentFiles = (msg.attachments ?? []).filter((a) => a.path)
  const otherAttachments = (msg.attachments ?? []).filter((a) => !a.path)
  const bodyText = media ? media.text : displayUserPrompt(msg.content)
  const bubbleEmpty =
    skin !== 'messenger' && sentFiles.length > 0 && !bodyText.trim() && !msg.replyTo && otherAttachments.length === 0 &&
    !msg.choices?.length && validatedGenUiEvents(msg.toolEvents).length === 0
  return (
    <div
      className={
        sentFiles.length > 0
          ? `flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`
          : flush
            ? undefined
            : `flex ${isUser ? 'justify-end' : 'justify-start'}`
      }
    >
      {sentFiles.length > 0 && <MessageAttachments items={sentFiles} align={isUser ? 'end' : 'start'} onOpenFile={onOpenFile} />}
      {!bubbleEmpty && (
      <div
        title={messageTimeTitle(msg.createdAt)}
        data-side={isUser ? 'end' : 'start'}
        data-group={groupPos}
        className={`ca-bubble ${flush ? 'w-full' : 'min-w-0 max-w-[min(42rem,88%)]'} overflow-hidden px-4 py-3 text-[15px] leading-relaxed shadow-[var(--ca-shadow-soft)] ${
          isUser
            ? 'bg-[var(--ca-bubble-user)] text-white'
            : isAgentDm
              ? 'border border-[var(--ca-primary)]/30 bg-[var(--ca-primary-soft)]/40 text-[var(--ca-ink)]'
              : 'border border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)]'
        }`}
      >
        {(isAgentDm || tagSpeaker) && speaker && (
          <div className="mb-1.5">
            {msg.fromAgentId ? (
              <AgentNameChip agentId={msg.fromAgentId} label={isAgentDm ? `from ${speaker}` : speaker} />
            ) : (
              <span className="inline-flex items-center rounded-full bg-[var(--ca-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)]">
                {speaker}
              </span>
            )}
          </div>
        )}
        {msg.replyTo && (skin === 'messenger'
          ? <QuotedReply replyTo={msg.replyTo} sender={replySender} onJump={onJumpToRow} />
          : <ReplyQuote replyTo={msg.replyTo} onUser={isUser} />)}
        <MessageBody
          content={bodyText}
          variant={isUser ? 'plain' : 'markdown'}
          streaming={msg.streaming}
          onOpenFile={isUser ? undefined : onOpenFile}
          mentions={mentions}
          onUser={isUser}
          skin={skin}
          reasoning={msg.reasoning}
          toolEvents={msg.toolEvents}
          genuiScope={msg.role === 'agent' && msg.fromAgentId ? JSON.stringify([msg.threadId, msg.fromAgentId]) : undefined}
        />
        {otherAttachments.length > 0 && (
          <ul className="mt-2 space-y-1">
            {otherAttachments.map((a) => (
              <li
                key={a.id}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs ${
                  isUser
                    ? 'bg-white/20 text-white'
                    : 'border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
                }`}
              >
                <span>{a.kind === 'image' ? '🖼' : '📎'}</span>
                <span className="truncate">{a.name}</span>
                {/* Opaque white + a raised label opacity: `text-white/90` under an
                    `opacity-60` label measured 3.56:1 (and ~2.9:1 on the label)
                    against the blue user bubble — below WCAG AA 4.5:1. The
                    attachment name is information the reader needs, not decoration. */}
                <span className="ml-auto uppercase tracking-wide opacity-90">{a.kind}</span>
              </li>
            ))}
          </ul>
        )}

        {media?.inline.map((img, i) => (
          <img key={i} src={img.dataUrl} alt="Image from the agent" className="max-w-full rounded-xl" />
        ))}
        {/* No cards on a failed turn: its text is our error copy (or a
            reply cut short), not something to preview. */}
        {!isUser && !msg.streaming && !msg.error && <LinkPreviews text={bodyText} />}

        {msg.choices && msg.choices.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!onChoice}
                onClick={() => onChoice?.(c.id, c.label)}
                className="nub-chip px-3 py-1 text-xs font-medium disabled:cursor-default disabled:opacity-50"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {repliesChip && (
          <button
            type="button"
            data-testid="thread-chip"
            onClick={() => onOpenThread?.(messageId ?? msg.id)}
            className="sand-on-wall mt-2 inline-flex items-center gap-1 rounded-full border border-[var(--ca-border)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ca-primary-text)] transition"
            title="Open reply thread"
          >
            {repliesChip}
          </button>
        )}

        {/* Offline outbox: this send is parked, not delivered. The marker has
            to be on the bubble itself — a banner elsewhere would not say
            WHICH message is still waiting. */}
        {isUser && msg.pending && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/85">
            <ClockIcon />
            <span>Waiting to send</span>
            {onDiscardPending ? (
              <button
                type="button"
                data-testid="discard-pending"
                onClick={onDiscardPending}
                className="ml-1 rounded-full px-1.5 py-0.5 font-semibold underline decoration-white/40 underline-offset-2 hover:decoration-white"
              >
                Discard
              </button>
            ) : null}
          </div>
        )}

        {/* Failed turn: the error text is the bubble, so the way back has to
            live next to it — there is no retry anywhere else in the app. */}
        {!isUser && msg.error && (onRetry || errorAction || msg.errorNote) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {msg.errorNote && (
              <p data-testid="turn-error-note" className="w-full text-[12px] text-[var(--ca-ink-muted)]">
                {msg.errorNote}
              </p>
            )}
            {errorAction && (
              <a
                href={errorAction.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="turn-error-action"
                className="inline-flex items-center rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-semibold text-white transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ca-primary)]"
              >
                {errorAction.label}
              </a>
            )}
            {onRetry && (
            <button
              type="button"
              data-testid="retry-turn"
              disabled={retryBusy}
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-[var(--ca-danger)] ring-1 ring-[var(--ca-danger)]/40 transition hover:bg-[var(--ca-danger)]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ca-danger)] disabled:opacity-50"
            >
              <RetryIcon />
              Try again
            </button>
            )}
          </div>
        )}
        {skin === 'messenger' && (
          <div className="messenger-stamp">
            <time dateTime={msg.createdAt}>{messengerTime(msg.createdAt)}</time>
            {isUser && <ReadTicks pickedUp={pickedUp} pending={msg.pending} />}
          </div>
        )}
      </div>
      )}
    </div>
  )
})


/** Shared by row rendering and bubble grouping so they never disagree. */
export function transcriptRowShape(
  m: ChatMessage,
  withFiles: boolean,
): { hasBubble: boolean; fileCards: ReturnType<typeof fileCardsForMessage> } {
  const fileCards = withFiles ? [...fileCardsForMessage(m)] : []
  if (withFiles && m.role !== 'user') {
    const media = extractReplyMedia(m.content)
    // File captures stay reachable through the local Files viewer, without
    // importing a VM image/audio/video loader into this shell.
    for (const path of [...media.images, ...media.media, ...screenshotPathsFromMessage(m)]) {
      if (!fileCards.some((file) => file.path === path)) fileCards.push({ path, action: 'write', source: 'tool' })
    }
  }
  const hasBubble =
    Boolean(m.content?.trim()) ||
    Boolean(m.attachments?.length) ||
    Boolean(m.choices?.length) ||
    (m.role === 'agent' && validatedGenUiEvents(m.toolEvents).length > 0)
  return { hasBubble, fileCards }
}


/**
 * One collapsed-transcript row owns its live subscription and action closures.
 * Parent callbacks must stay stable for unchanged rows to bail out. Rows without
 * artifacts receive the parent's frozen empty array rather than a fresh array.
 */
export const TranscriptRow = memo(function TranscriptRow({
  m: storedMessage,
  entering = false,
  liveAvatar = false,
  groupPos,
  repliesChip,
  showArtifacts,
  highlighted,
  projectArtifacts,
  agentName,
  showAgentSpeaker,
  onChoice,
  onOpenSubagent,
  onCancelSubagent,
  onOpenFile,
  onOpenPreview,
  onOpenHost,
  onDownloadProject,
  onSaveFileToMac,
  onOpenThread,
  onReplyToMessage,
  onReactToMessage,
  onRetryTurn,
  retryBusy,
  onDiscardPending,
  onEditMessage,
  onAskAgain,
  handoffStrip,
  onJumpToRow,
  onOpenHandoff,
  mentions,
  skin,
  pickedUp,
  onBranch,
  replySender,
}: {
  m: ChatMessage
  /** Arrived after the thread first rendered: eases in (.ca-row-in). */
  entering?: boolean
  /** The newest agent reply: its Pip avatar animates; older rows keep a still pose. */
  liveAvatar?: boolean
  groupPos: BubbleGroupPos
  repliesChip: string
  showArtifacts: boolean
  highlighted: boolean
  projectArtifacts: ProjectArtifact[]
  agentName?: (id: string) => string
  showAgentSpeaker: boolean
  onChoice?: (choiceId: string, label: string) => void
  onOpenSubagent?: (runId: string) => void
  onCancelSubagent?: (runId: string) => void
  onOpenFile?: (path: string) => void
  onOpenPreview?: (artifact: ProjectArtifact) => void
  onOpenHost?: (artifact: ProjectArtifact) => void
  onDownloadProject?: (artifact: ProjectArtifact) => void
  onSaveFileToMac?: (path: string) => void
  onOpenThread: (messageId: string) => void
  onReplyToMessage: (target: ChatMessage) => void
  onReactToMessage?: (target: ChatMessage, emoji: string | null) => void
  /** Stable resend for a failed turn (only rendered on `m.error` rows). */
  onRetryTurn?: () => void
  retryBusy?: boolean
  /** Stable discard for a parked offline send (only on `m.pending` rows). */
  onDiscardPending?: (messageId: string) => void
  /** Stable: put one of your messages back in the composer. */
  onEditMessage?: (target: ChatMessage) => void
  /** Only on the newest reply (see askAgainTarget): resend its prompt. */
  onAskAgain?: () => void
  /** Server-run room: who this message handed work to, and how it's going. */
  handoffStrip?: HandoffStrip
  onJumpToRow?: (rowId: string) => void
  /** Open the hand-off transcript modal (strip row, clicked pill's turn). */
  onOpenHandoff?: (rowId: string, turnId: string) => void
  mentions?: MentionMember[]
  skin?: 'messenger' | 'classic'
  pickedUp?: boolean
  onBranch?: (message: ChatMessage) => void
  replySender?: string
}) {
  // The panel holds the structural snapshot; this row follows its own
  // streamed text so a token re-renders the bubble, not the whole panel.
  const m = useLiveMessage(storedMessage)
  const shape = transcriptRowShape(m, Boolean(onOpenFile))
  const hasBubble = shape.hasBubble || (m.role === 'agent' && validatedGenUiEvents(m.toolEvents).length > 0) ||
    (skin === 'messenger' && Boolean(m.reasoning || m.toolEvents?.length))
  const { fileCards } = shape
  const canAct = (m.role === 'user' || m.role === 'agent') && !isReplyPartRow(m)
  if (!hasBubble && fileCards.length === 0 && !showArtifacts && !(skin === 'messenger' && (m.toolEvents?.length || m.streaming))) {
    return null
  }
  return (
    <div
      data-message-id={m.id}
      data-group={groupPos}
      // M3 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): settled rows opt into
      // content-visibility so offscreen layout is skipped. The streaming row
      // is excluded — a changing intrinsic height plus content-visibility
      // skips layout and breaks stick-to-bottom.
      className={`ca-row ${!m.streaming ? 'ca-cv-row' : ''} ${entering ? 'ca-row-in' : ''} ${
        showArtifacts || fileCards.length > 0
          ? 'relative z-0 space-y-2'
          : ''
      } ${
        highlighted
          ? 'rounded-2xl ring-2 ring-[var(--ca-primary)]/50'
          : ''
      }`.trim() || undefined}
    >
      {skin === 'messenger' && m.streaming && !hasBubble && <div className="messenger-preparing" role="status">Hermes is preparing your answer</div>}
      {hasBubble && (
        <div
          className={`flex ${
            m.role === 'user' ? 'justify-end' : m.role === 'system' ? 'justify-center' : 'justify-start'
          }`}
        >
          {skin === 'messenger' && m.role === 'agent' && <ChatAgentAvatar message={m} live={liveAvatar} />}
          <MessageActionAnchor
            msg={m}
            speakerName={
              m.role === 'user'
                ? 'you'
                : m.fromAgentId && agentName
                  ? agentName(m.fromAgentId)
                  : 'Hermes'
            }
            onReply={
              canAct
                ? () => {
                    onReplyToMessage(m)
                  }
                : undefined
            }
            onReact={
              onReactToMessage &&
              areMessageReactionsEnabled() &&
              canAct
                ? (emoji) => onReactToMessage(m, emoji)
                : undefined
            }
            onCopy={
              m.content
                ? async () => {
                    // What the bubble shows: no `MEDIA:` tags or inlined
                    // base64 in a reply, no wrapper around a sent prompt.
                    const text = copyTextOf(m)
                    if (window.nubAgent?.clipboard?.writeText) {
                      await window.nubAgent.clipboard.writeText(text)
                    } else {
                      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
                      await navigator.clipboard.writeText(text)
                    }
                  }
                : undefined
            }
            onReplyInThread={
              canAct ? () => onOpenThread(m.id) : undefined
            }
            onEdit={
              onEditMessage && canAct && m.role === 'user' && !m.pending && copyTextOf(m).trim()
                ? () => onEditMessage(m)
                : undefined
            }
            onAskAgain={onAskAgain}
            onRetry={skin === 'messenger' && canAct ? onRetryTurn : undefined}
            onBranch={canAct && onBranch ? () => onBranch(m) : undefined}
            retryBusy={retryBusy}
            wide={skin === 'messenger' && (messageHasWideContent(m.content) || !!m.toolEvents?.length)}
            skin={skin}
          >
            <Bubble
              msg={m}
              flush
              onChoice={onChoice}
              agentName={agentName}
              tagSpeaker={showAgentSpeaker && (groupPos === 'single' || groupPos === 'first')}
              groupPos={groupPos}
              mentions={mentions}
              onOpenSubagent={onOpenSubagent}
              onCancelSubagent={onCancelSubagent}
              onOpenFile={onOpenFile}
              repliesChip={repliesChip}
              messageId={m.id}
              onOpenThread={onOpenThread}
              onRetry={m.error ? onRetryTurn : undefined}
              retryBusy={retryBusy}
              skin={skin}
              pickedUp={pickedUp}
              onJumpToRow={onJumpToRow}
              replySender={replySender}
              onDiscardPending={
                m.pending && onDiscardPending ? () => onDiscardPending(m.id) : undefined
              }
            />
          </MessageActionAnchor>
        </div>
      )}
      {hasBubble && handoffStrip && <RoomHandoffStrip strip={handoffStrip} onJump={onJumpToRow} onOpen={onOpenHandoff} />}
      {fileCards.length > 0 && onOpenFile && (
        <FileCardStack
          files={fileCards}
          onOpen={onOpenFile}
          onSaveToMac={onSaveFileToMac}
        />
      )}
      {showArtifacts && (onOpenPreview || onDownloadProject || onOpenHost) && (
        <ArtifactStack
          artifacts={projectArtifacts}
          onPreview={onOpenPreview}
          onDownload={onDownloadProject}
          onHost={onOpenHost}
        />
      )}
    </div>
  )
})

