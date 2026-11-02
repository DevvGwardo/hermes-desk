/**
 * ThreadPane (A4) — the reply-thread surface for a collapsed chain.
 *
 * >720px: right-side drawer. ≤720px: full-screen sheet (MobileApp width
 * breakpoint). Lists root + descendants in order; the composer sends through
 * the normal send path with `replyTo` pinned to the thread root, so every
 * transport (mock/serve/deploy) lands the message in-thread unchanged.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { enterSends } from '../lib/composer-enter'
import type { ChatMessage, MessageReplyTo } from '../lib/agents'
import { displayUserPrompt } from '../lib/peer-roster'
import { MessageBody, messageHasWideContent } from './MessageBody'
import { ReplyQuote } from './ReplyQuote'
import { InlineShot, LocalImage as VmShot } from './LocalImage'
import { LocalMedia as VmMedia } from './LocalMedia'
import { extractReplyMedia } from '../lib/reply-media'
import { DatePill, messengerDateLabel, messengerDayKey } from './chat/DatePill'
import { QuotedReply } from './chat/QuotedReply'
import { ReadTicks, inferredPickedUpIds, messengerTime } from './chat/ReadTicks'
import { MessengerComposer } from './chat/MessengerComposer'
import { appendTranscript, dictateDeniedCopy, DictateEngine, initialDictateStatus, type DictateStatus } from '../lib/dictate'
import { sttBridgeAvailable, sttStatus, transcribeAudio } from '../lib/stt'
import '../styles/skin-messenger.css'
import { AgentMascot } from './AgentMascot'
import { Button } from './ui/Button'
import { messageMascotPresence } from './chat/presence'

export const THREAD_BREAKPOINT = 720

/** ChatPanel parity: only the tail mounts; "Load earlier" extends by a chunk. */
const WINDOW_CHUNK = 60

function speakerOf(msg: ChatMessage, agentName?: (id: string) => string): string {
  if (msg.role === 'user') return 'you'
  return (msg.fromAgentId && agentName?.(msg.fromAgentId)) || msg.fromAgentId || 'Hermes'
}

/** Drawer when wide, sheet when narrow — decided by container query width. */
export function isSheetWidth(width: number): boolean {
  return width <= THREAD_BREAKPOINT
}

interface ThreadPaneProps {
  open: boolean
  onClose: () => void
  messages: ChatMessage[]
  /** Viewport/container width in px — sheet below the 720px breakpoint. */
  width: number
  onSend: (text: string, opts?: { replyTo?: MessageReplyTo }) => void
  agentName?: (id: string) => string
  title: string
  skin?: 'messenger' | 'classic'
  accentColor?: string
  profile?: string
  model?: string
  room?: boolean
  pickedUpMessageIds?: ReadonlySet<string>
}

/** One thread row (root card or reply bubble). Memo'd on message identity so a
 *  streaming tick — which replaces only the streaming message object — bails
 *  out for every settled row. */
const ThreadRow = memo(function ThreadRow({
  msg,
  isRoot,
  agentName,
  skin,
  pickedUp,
  onJump,
}: {
  msg: ChatMessage
  isRoot: boolean
  agentName?: (id: string) => string
  skin?: 'messenger' | 'classic'
  pickedUp?: boolean
  onJump?: (messageId: string) => void
}) {
  const media = msg.role === 'user' ? null : extractReplyMedia(msg.content)
  const body = media ? media.text : displayUserPrompt(msg.content)
  const variant = msg.role === 'user' ? 'plain' : 'markdown'
  const shots = media && (
    <>
      {media.images.map((path) => (
        <VmShot key={path} path={path} alt="Image from the agent computer" zoom />
      ))}
      {media.inline.map((img, i) => (
        <InlineShot key={i} dataUrl={img.dataUrl} alt="Image from the agent" zoom />
      ))}
      {media.media.map((path) => (
        <VmMedia key={path} path={path} />
      ))}
    </>
  )
  if (skin === 'messenger') {
    return (
      <div data-message-id={msg.id}>
        <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          {msg.role === 'agent' && <AgentMascot agentId={msg.fromAgentId ?? 'default'} presence={messageMascotPresence(msg)} size={28} reducedMotion className="messenger-bubble-avatar" />}
          <div className="ca-bubble messenger-thread-bubble" data-side={msg.role === 'user' ? 'end' : 'start'} data-wide={messageHasWideContent(body) || undefined} data-thread-root={isRoot || undefined}>
            {msg.replyTo && <QuotedReply replyTo={msg.replyTo} onJump={onJump} />}
            <MessageBody content={body} variant={variant} streaming={msg.streaming} skin={skin} reasoning={msg.reasoning} toolEvents={msg.toolEvents} />
            {shots}
            <div className="messenger-stamp">
              <time dateTime={msg.createdAt}>{messengerTime(msg.createdAt)}</time>
              {msg.role === 'user' && <ReadTicks pickedUp={pickedUp} pending={msg.pending} />}
            </div>
          </div>
        </div>
      </div>
    )
  }
  if (isRoot) {
    return (
      <div className="rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3.5 py-2.5 shadow-[var(--ca-shadow-soft)]">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--ca-primary-text)]">
          {speakerOf(msg, agentName)}
        </p>
        <MessageBody content={body} variant={variant} />
        {shots}
      </div>
    )
  }
  return (
    <div
      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[92%] rounded-2xl px-3 py-2 text-[14px] leading-6 ${
          msg.role === 'user'
            ? 'rounded-br-md bg-[var(--ca-bubble-user)] text-white'
            : 'rounded-bl-md border border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)]'
        }`}
      >
        {msg.replyTo && <ReplyQuote replyTo={msg.replyTo} onUser={msg.role === 'user'} />}
        <p
          className={`mb-0.5 text-[10px] font-medium uppercase tracking-wide ${
            msg.role === 'user' ? 'text-white/90' : 'text-[var(--ca-primary-text)]'
          }`}
        >
          {speakerOf(msg, agentName)}
        </p>
        <MessageBody content={body} variant={variant} />
        {shots}
      </div>
    </div>
  )
})

export const ThreadPane = memo(function ThreadPane({
  open,
  onClose,
  messages,
  width,
  onSend,
  agentName,
  title,
  skin = 'messenger',
  accentColor,
  profile = 'default',
  model = 'Profile default',
  room = false,
  pickedUpMessageIds,
}: ThreadPaneProps) {
  const [draft, setDraft] = useState('')
  const [windowChunks, setWindowChunks] = useState(1)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [jumpId, setJumpId] = useState<string | null>(null)
  const [activeDate, setActiveDate] = useState(messages.at(-1)?.createdAt ?? '')
  useEffect(() => { setActiveDate(messages.at(-1)?.createdAt ?? '') }, [title])
  const pickedUpIds = useMemo(() => pickedUpMessageIds ?? inferredPickedUpIds(messages), [pickedUpMessageIds, messages])
  const recorderRef = useRef<DictateEngine | null>(null)
  const [dictateStatus, setDictateStatus] = useState<DictateStatus>(initialDictateStatus)
  useEffect(() => {
    if (!open || skin !== 'messenger' || !sttBridgeAvailable()) return
    let cancelled = false
    void sttStatus().then((status) => {
      if (cancelled || !status.ok) return
      setDictateStatus('idle')
      recorderRef.current = new DictateEngine({
        transcribe: transcribeAudio,
        hooks: {
          onStatus: setDictateStatus,
          onFinal: (text) => setDraft((draft) => appendTranscript(draft, text)),
        },
      })
    })
    return () => {
      cancelled = true
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [open, skin])
  const jumpToMessage = useCallback((id: string) => {
    setWindowChunks(Math.max(1, Math.ceil(messages.length / WINDOW_CHUNK)))
    setJumpId(id)
  }, [messages.length])
  useLayoutEffect(() => {
    if (!jumpId) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpId)}"]`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    setJumpId(null)
  }, [jumpId])

  // The thread-reply snippet walks the root body — memoize so streaming ticks
  // around an open pane don't repay the replace on every keystroke render.
  const rootContent = messages[0]?.content ?? ''
  const rootSnippet = useMemo(
    () => rootContent.replace(/\s+/g, ' ').trim().slice(0, 96),
    [rootContent],
  )

  useEffect(() => {
    if (open) {
      setDraft('')
      setWindowChunks(1)
      inputRef.current?.focus()
    }
  }, [open])

  const loadEarlier = useCallback(() => {
    setWindowChunks((n) => n + 1)
  }, [])

  if (!open) return null

  const root = messages[0]
  const rest = messages.slice(1)
  const renderFrom = Math.max(0, rest.length - WINDOW_CHUNK * windowChunks)
  const visibleRest = renderFrom > 0 ? rest.slice(renderFrom) : rest
  const hasEarlier = renderFrom > 0
  const sheet = isSheetWidth(width)
  const days: { key: string; date: string; rows: ChatMessage[] }[] = []
  for (const message of root ? [root, ...visibleRest] : visibleRest) {
    const key = messengerDayKey(message.createdAt)
    const previous = days[days.length - 1]
    if (previous?.key === key) previous.rows.push(message)
    else days.push({ key, date: message.createdAt, rows: [message] })
  }

  function submit() {
    const text = draft.trim()
    if (!text || !root) return
    onSend(text, {
      replyTo: {
        id: root.id,
        role: root.role,
        snippet: rootSnippet,
        // Marks this as a THREAD reply so it collapses under the root; a plain
        // quote reply leaves this unset and stays inline.
        thread: true,
      },
    })
    setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && enterSends()) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      data-testid="thread-pane"
      data-skin={skin}
      style={accentColor ? { '--messenger-accent': accentColor } as CSSProperties : undefined}
      className={`messenger-thread ${
        sheet
          ? 'fixed inset-0 z-40 flex flex-col bg-[var(--ca-card)]'
          : 'relative z-10 flex h-full w-[22rem] max-w-[45%] shrink-0 flex-col border-l border-[var(--ca-border)] bg-[var(--ca-hover)]'
      }`}
      role="complementary"
      aria-label={`Thread: ${title}`}
    >
      <div className="flex items-center justify-between border-b border-[var(--ca-border)] px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-[var(--ca-ink)]">{title}</p>
          {rest.length > 0 && (
            <p className="text-[11px] text-[var(--ca-ink-muted)]">
              {rest.length} {rest.length === 1 ? 'reply' : 'replies'}
            </p>
          )}
        </div>
        <Button
          onClick={onClose}
          className="shrink-0 rounded-full px-2 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-ink)]"
        >
          Close
        </Button>
      </div>

      {skin === 'messenger' && messages.length > 0 && <div className="messenger-thread-date-gutter" aria-label="Current thread date"><span className="messenger-date-pill">{messengerDateLabel(activeDate || messages.at(-1)!.createdAt)}</span></div>}
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3" data-testid="thread-messages" onScroll={() => {
        const list = listRef.current
        if (!list) return
        const row = [...list.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top)
        const date = messages.find(message => message.id === row?.dataset.messageId)?.createdAt
        if (date) setActiveDate(date)
      }}>
        {hasEarlier && (
          <button
            type="button"
            onClick={loadEarlier}
            className="w-full rounded-full px-2.5 py-1 text-[11px] font-medium text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-primary-soft)]"
          >
            Load earlier ({renderFrom} more)
          </button>
        )}
        {skin === 'messenger' ? days.map((day, i) => (
          <div className="messenger-day" key={`${day.key}:${i}`}>
            <DatePill date={day.date} />
            {day.rows.map((message) => (
              <div className="ca-row" key={message.id}>
                <ThreadRow msg={message} isRoot={message.id === root?.id} agentName={agentName} skin={skin} pickedUp={pickedUpIds.has(message.id)} onJump={jumpToMessage} />
              </div>
            ))}
          </div>
        )) : (
          <>
            {root && <ThreadRow msg={root} isRoot agentName={agentName} />}
            {visibleRest.map((message) => <ThreadRow key={message.id} msg={message} isRoot={false} agentName={agentName} />)}
          </>
        )}
      </div>

      {skin === 'messenger' ? (
        <form className="messenger-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <MessengerComposer
            input={<textarea ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} rows={1} placeholder="Reply in thread…" aria-label="Reply in thread" className="min-w-0 flex-1 resize-none bg-transparent outline-none" />}
            hasText={Boolean(draft.trim())}
            profile={profile}
            model={model}
            room={room}
            sendLabel="Send thread reply"
            onCommands={() => { setDraft('/'); inputRef.current?.focus() }}
            onEmoji={(emoji) => { setDraft((text) => text + emoji); inputRef.current?.focus() }}
            onStartDictate={() => { void recorderRef.current?.start() }}
            onStopDictate={() => { void recorderRef.current?.stop() }}
            dictateStatus={dictateStatus}
            dictateIndicator={dictateStatus === 'denied' ? dictateDeniedCopy({ desktop: true, nativePhone: false }) : undefined}
          />
        </form>
      ) : (
      <div className="border-t border-[var(--ca-border)] p-2">
        <div className="flex items-end gap-1.5 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Reply in thread…"
            aria-label="Reply in thread"
            className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            aria-label="Send thread reply"
            className="nub-btn-primary px-3 py-1 text-[11px] disabled:opacity-50"
          >
            Send
          </button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-[var(--ca-ink-muted)]">
          Replies stay attached to this thread.
        </p>
      </div>
      )}
    </div>
  )
})
