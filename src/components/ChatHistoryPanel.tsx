/**
 * Chat history — every conversation your agent has had, from any place
 * (this app, Telegram, Discord, routines…), over dashboard REST.
 *
 * Tap a chat to open it: one that lives in the sidebar opens there; any
 * other (a Telegram chat, a routine run) opens read-only right here.
 * Search, rename, export (download a JSON file) and delete (with confirm).
 * Hosted VMs only; a local hermes install keeps the CLI-backed sidebar.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppModal } from './AppModal'
import {
  deleteSession,
  exportSession,
  listSessions,
  readSessionTranscript,
  renameSession,
  searchSessions,
  type SessionSummary,
  type TranscriptLine,
} from '../lib/session-history'
import { MessageBody } from './MessageBody'
import { formatFriendlyWhen } from '../lib/friendly-time'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const ghostBtn =
  'rounded-full border border-[var(--ca-border)] px-2 py-0.5 text-[11px] text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)] disabled:opacity-40'
const PAGE = 50

/** "Today, 8:29 PM" / "Thu, Oct 2, 8:29 PM"; empty when unknown. */
function when(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t <= 0) return ''
  return formatFriendlyWhen(t)
}

function Row({
  s,
  onOpen,
  onChanged,
  onRemoved,
}: {
  s: SessionSummary
  onOpen: (s: SessionSummary) => void
  onChanged: (next: SessionSummary) => void
  onRemoved: (id: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'confirm-delete'>('idle')
  const [draft, setDraft] = useState(s.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doRename = async () => {
    const title = draft.trim()
    if (!title || title === s.title) {
      setMode('idle')
      return
    }
    setBusy(true)
    setError(null)
    const res = await renameSession(s.id, title)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not rename this chat.')
      return
    }
    onChanged({ ...s, title: res.title || title })
    setMode('idle')
  }

  const doExport = async () => {
    setBusy(true)
    setError(null)
    const res = await exportSession(s.id, s.title)
    setBusy(false)
    if (!res.ok) setError(res.error ?? 'Could not export this chat.')
  }

  const doDelete = async () => {
    setBusy(true)
    setError(null)
    const res = await deleteSession(s.id)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not delete this chat.')
      return
    }
    onRemoved(s.id)
  }

  return (
    <li className="rounded-lg px-2.5 py-2 ring-1 ring-[var(--ca-border)]" data-session-id={s.id}>
      {mode === 'rename' ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void doRename()
          }}
        >
          <input
            aria-label="Chat name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={fieldClass}
          />
          <button type="submit" disabled={busy} className={ghostBtn}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={ghostBtn} onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      ) : (
        // Phones: the actions sit under the title so it keeps the width.
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <button
            type="button"
            onClick={() => onOpen(s)}
            aria-label={`Open ${s.title}`}
            className="-m-1 min-w-0 flex-1 rounded-md p-1 text-left hover:bg-[var(--ca-hover)]"
          >
            <div className="truncate text-[12px] font-medium text-[var(--ca-ink)]">{s.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--ca-ink-muted)]">
              <span className="rounded-full bg-[var(--ca-primary-soft)] px-1.5 py-px text-[var(--ca-primary-text)]">
                {s.sourceLabel}
              </span>
              {when(s.lastActive) && <span>{when(s.lastActive)}</span>}
              {s.messageCount > 0 && <span>· {s.messageCount} messages</span>}
            </div>
            {(s.snippet || s.preview) && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ca-ink-muted)]">
                {(s.snippet || s.preview).replace(/>>>|<<</g, '')}
              </div>
            )}
          </button>
          {mode === 'idle' && (
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className={ghostBtn}
                aria-label={`Rename ${s.title}`}
                onClick={() => {
                  setDraft(s.title)
                  setMode('rename')
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className={ghostBtn}
                aria-label={`Export ${s.title}`}
                disabled={busy}
                onClick={() => void doExport()}
              >
                Export
              </button>
              <button
                type="button"
                className={`${ghostBtn} hover:text-[var(--ca-danger)]`}
                aria-label={`Delete ${s.title}`}
                onClick={() => setMode('confirm-delete')}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
      {mode === 'confirm-delete' && (
        <div role="alertdialog" aria-label="Delete this chat?" className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-[var(--ca-ink)]">Delete this chat for good?</span>
          <button type="button" className={ghostBtn} disabled={busy} onClick={() => setMode('idle')}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void doDelete()}
            className="rounded-full bg-[var(--ca-danger)] px-2.5 py-0.5 text-[11px] font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Deleting…' : 'Delete chat'}
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-[var(--ca-danger)]">{error}</p>}
    </li>
  )
}

type Reading =
  | { s: SessionSummary; state: 'loading' }
  | { s: SessionSummary; state: 'ok'; lines: TranscriptLine[] }
  | { s: SessionSummary; state: 'error'; error: string }

/** One chat, read-only: what you said and what the agent answered. */
function Transcript({ reading, onBack, onRetry }: { reading: Reading; onBack: () => void; onRetry: () => void }) {
  return (
    <div className="space-y-3" data-testid="chat-transcript">
      <div className="flex items-center gap-2">
        <button type="button" className={ghostBtn} onClick={onBack}>
          ‹ All chats
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ca-ink-muted)]">
          {reading.s.sourceLabel}
          {when(reading.s.lastActive) ? ` · ${when(reading.s.lastActive)}` : ''}
        </span>
      </div>
      <h3 className="text-[14px] font-semibold text-[var(--ca-ink)]">{reading.s.title}</h3>
      {reading.state === 'loading' ? (
        <p className="text-[12px] text-[var(--ca-ink-muted)]">Opening…</p>
      ) : reading.state === 'error' ? (
        <p role="alert" className="text-[12px] text-[var(--ca-danger)]">
          {reading.error}
          <button type="button" className={`${ghostBtn} ml-2`} onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : reading.lines.length === 0 ? (
        <p className="text-[12px] text-[var(--ca-ink-muted)]">Nothing was said in this chat.</p>
      ) : (
        <ol className="space-y-2.5">
          {reading.lines.map((line, i) => (
            <li
              key={i}
              className={`rounded-xl px-3 py-2 text-[12.5px] leading-relaxed text-[var(--ca-ink)] ${
                line.role === 'user' ? 'ml-8 bg-[var(--ca-primary-soft)]' : 'mr-4 ring-1 ring-[var(--ca-border)]'
              }`}
            >
              <div className="mb-0.5 text-[10px] font-medium text-[var(--ca-ink-muted)]">
                {line.role === 'user' ? 'You' : 'Agent'}
              </div>
              {line.role === 'assistant' ? (
                <MessageBody content={line.text} variant="markdown" />
              ) : (
                <p className="whitespace-pre-wrap">{line.text}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-[11px] text-[var(--ca-ink-muted)]">
        This chat isn’t in your sidebar, so it opens here to read.
      </p>
    </div>
  )
}

export function ChatHistoryPanel({
  open,
  onClose,
  onOpenSession,
}: {
  open: boolean
  onClose: () => void
  /** Open the chat in the main view. Returns false when no sidebar chat
   *  holds this session; it is then read here instead. */
  onOpenSession?: (sessionId: string) => boolean
}) {
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A failed "Show more": the chats already shown stay put. */
  const [moreError, setMoreError] = useState<string | null>(null)
  const [needsUpdate, setNeedsUpdate] = useState(false)
  const [reading, setReading] = useState<Reading | null>(null)
  const seq = useRef(0)
  const readSeq = useRef(0)

  const readChat = useCallback(async (s: SessionSummary) => {
    const mine = ++readSeq.current
    setReading({ s, state: 'loading' })
    const res = await readSessionTranscript(s.id)
    if (mine !== readSeq.current) return
    setReading(res.ok ? { s, state: 'ok', lines: res.lines } : { s, state: 'error', error: res.error })
  }, [])

  const openChat = (s: SessionSummary) => {
    if (onOpenSession?.(s.id)) return
    void readChat(s)
  }

  useEffect(() => {
    if (!open) {
      readSeq.current++
      setReading(null)
    }
  }, [open])

  const load = useCallback(async (q: string) => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    setMoreError(null)
    const res = q.trim() ? await searchSessions(q, 50) : await listSessions({ limit: PAGE })
    if (mine !== seq.current) return
    setLoading(false)
    setNeedsUpdate(Boolean(res.needsUpdate))
    if (!res.ok) {
      setError(res.error ?? 'Could not load chat history.')
      setSessions([])
      return
    }
    setSessions(res.sessions)
    setTotal(q.trim() ? undefined : res.total)
  }, [])

  // Each open starts on the full list, as search and the Marketplace do. The
  // panel stays mounted on desktop, so the last query would otherwise carry
  // over (its debounced search is cancelled by the reset below).
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => void load(query), query ? 250 : 0)
    return () => clearTimeout(t)
  }, [open, query, load])

  const loadMore = async () => {
    setLoading(true)
    setMoreError(null)
    const res = await listSessions({ limit: PAGE, offset: sessions.length })
    setLoading(false)
    if (res.ok) {
      const seen = new Set(sessions.map((s) => s.id))
      setSessions([...sessions, ...res.sessions.filter((s) => !seen.has(s.id))])
      setTotal(res.total)
    } else setMoreError(res.error ?? 'Couldn’t load more chats.')
  }

  return (
    <AppModal open={open} onClose={onClose} title="Chat history" size="md" contentKey={reading ? 'read' : 'list'}>
      {reading ? (
        <div className="p-4">
          <Transcript
            reading={reading}
            onBack={() => {
              readSeq.current++
              setReading(null)
            }}
            onRetry={() => void readChat(reading.s)}
          />
        </div>
      ) : (
      <div className="space-y-3 p-4">
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search your chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={fieldClass}
        />
        {needsUpdate ? (
          <p className="text-[12px] text-[var(--ca-ink-muted)]">
            Your agent needs an update for this. Use Update agent in Agent info.
          </p>
        ) : error ? (
          <p role="alert" className="text-[12px] text-[var(--ca-danger)]">
            {error}
            <button type="button" className={`${ghostBtn} ml-2`} onClick={() => void load(query)}>
              Retry
            </button>
          </p>
        ) : loading && sessions.length === 0 ? (
          <p className="text-[12px] text-[var(--ca-ink-muted)]">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-[12px] text-[var(--ca-ink-muted)]">
            {query.trim() ? 'No chats match that search.' : 'No chats yet.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {sessions.map((s) => (
              <Row
                key={s.id}
                s={s}
                onOpen={openChat}
                onChanged={(next) => setSessions((list) => list.map((x) => (x.id === next.id ? next : x)))}
                onRemoved={(id) => {
                  setSessions((list) => list.filter((x) => x.id !== id))
                  setTotal((n) => (typeof n === 'number' ? Math.max(0, n - 1) : n))
                }}
              />
            ))}
          </ul>
        )}
        {moreError && (
          <p role="alert" className="text-[11px] text-[var(--ca-danger)]">
            {moreError}
          </p>
        )}
        {!query.trim() && typeof total === 'number' && sessions.length < total && !error && (
          <button type="button" className={ghostBtn} disabled={loading} onClick={() => void loadMore()}>
            {loading ? 'Loading…' : moreError ? 'Try again' : 'Show more'}
          </button>
        )}
      </div>
      )}
    </AppModal>
  )
}
