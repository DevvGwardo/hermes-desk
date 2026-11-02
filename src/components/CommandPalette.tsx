import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Agent, ChatMessage, Conversation, Group } from '../lib/agents'
import { describeRoutineSchedule, displayRoutineName, formatCronSchedule, type RoutineOrigin } from '../lib/routines'
import {
  SEARCH_TABS,
  SEARCH_TAB_LABEL,
  buildSearchRows,
  collectSearchCorpus,
  emptyCopy,
  shortcutIndex,
  type SearchRow,
  type SearchTab,
} from '../lib/search-index'
import { AgentMascot } from './AgentMascot'
import { Icon, type IconName } from './ui/icons'
import { LocalPanelTheme } from './settings/local/common'
import { hostMachinePhrase } from '../lib/host-label'
import {
  probeTranscriptTail,
  readTranscriptTails,
  type TranscriptTailHit,
} from '../lib/hermes-rest'
import { normalizeSearchText, tokenize } from '../lib/search-index'
import { parseHash } from '../lib/router'
import { getStructuralState } from '../lib/agents/store'

export interface PaletteCommand {
  id: string
  label: string
  keywords?: string[]
  detail?: string
  icon?: string
  run: () => void
}

export interface PaletteFile {
  path: string
  label: string
}

type PaletteRoutine = {
  id: string
  origin?: RoutineOrigin
  name?: string | null
  schedule?: unknown
  schedule_display?: string | null
  enabled?: boolean
  prompt?: string | null
  nextRunAt?: string | null
  scheduleLabel?: string
}

type RoutineState = PaletteRoutine[] | 'loading' | 'unavailable'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Send a composer event after closing whatever covers the chat. */
  onDispatchToChat?: (event: 'maia:focus-composer' | 'maia:spawn-scaffold') => void
  commands: PaletteCommand[]
  agents: Agent[]
  groups?: Group[]
  conversations?: Conversation[]
  hiddenConversations?: Conversation[]
  messagesByThreadId?: Record<string, ChatMessage[]>
  files?: PaletteFile[]
  routines?: RoutineState
  onJumpToAgent: (agentId: string) => void
  onJumpToGroup?: (groupId: string) => void
  onJumpToMessage?: (conversationId: string, messageId: string) => void
  onOpenFile?: (path: string) => void
  onOpenLink?: (url: string) => void
  onOpenRoutine?: (jobId: string, origin?: RoutineOrigin) => void
  onCreateRoutine?: () => void
  onCreateAgent?: () => void
  onCreateGroup?: () => void
  onOpenFiles?: () => void
  onNewConversation?: () => void
  onRetryRoutines?: () => void
  /**
   * B1: paired instance id for cross-session transcript search. Null/absent
   * keeps today's local-only search (route is also OPTIONS-probed).
   */
  transcriptSearchInstanceId?: string | null
}

const MOD = '⌘'

function SearchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16.5 20 20.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function RowIcon({ row, agents }: { row: SearchRow; agents: Agent[] }) {
  if (row.kind === 'agent') {
    return <AgentMascot agentId={row.agent.id} profile={row.agent} reducedMotion size={32} />
  }
  if (row.kind === 'group') {
    const members = row.group.memberAgentIds
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean) as Agent[]
    return (
      <span className="flex -space-x-1.5">
        {members.slice(0, 2).map((m) => {
          return (
            <AgentMascot
              key={m.id}
              agentId={m.id}
              profile={m}
              reducedMotion
              size={28}
              className="rounded-full ring-2 ring-[var(--ca-card)]"
            />
          )
        })}
        {members.length === 0 && (
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ca-primary-soft)] text-xs">
            <Icon name="sidebar" size={18} />
          </span>
        )}
      </span>
    )
  }
  const glyph: IconName =
    row.kind === 'file' ? 'file' : row.kind === 'link' ? 'external' : row.kind === 'routine' ? 'reload' : row.kind === 'message' ? 'reply' : 'sparkle'
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ca-primary-soft)] text-[13px]">
      <Icon name={glyph} size={18} />
    </span>
  )
}

/**
 * Cmd+K / sidebar Search — Grok Bot spotlight with All / Messages / Agents /
 * Groups / Files / Links / Routines / Actions.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  agents,
  groups = [],
  conversations = [],
  hiddenConversations = [],
  messagesByThreadId = {},
  files = [],
  routines = [],
  onJumpToAgent,
  onJumpToGroup,
  onJumpToMessage,
  onOpenFile,
  onOpenLink,
  onOpenRoutine,
  onCreateRoutine,
  onCreateAgent,
  onCreateGroup,
  onOpenFiles,
  onNewConversation,
  onRetryRoutines,
  transcriptSearchInstanceId = null,
  onDispatchToChat,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sel, setSel] = useState(0)
  const [tab, setTab] = useState<SearchTab>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const route = parseHash(window.location.hash)
  const current = conversations.find(conversation => conversation.id ===
    (route.conversationId ?? getStructuralState().selectedConversationId))
  const selectedAgentId = route.agentId ?? (current?.target.type === 'agent' ? current.target.agentId : null)
  const hasSelectedAgent = agents.some(agent => agent.id === selectedAgentId)

  const spawnCommand: PaletteCommand = {
    id: 'spawn-subagent',
    label: 'Spawn subagent',
    keywords: ['subagent', 'spawn', 'task', 'worker', 'delegate', 'dispatch'],
    detail: 'Agents',
    run: () => {
      if (onDispatchToChat) {
        // Close whatever covers the chat (Routines) first, or the composer's
        // listeners are off and nothing happens.
        onDispatchToChat('maia:focus-composer')
        onDispatchToChat('maia:spawn-scaffold')
        return
      }
      window.dispatchEvent(new CustomEvent('maia:focus-composer'))
      window.dispatchEvent(new CustomEvent('maia:spawn-scaffold'))
    },
  }
  const allCommands = useMemo(() => [
    ...(onDispatchToChat ? [spawnCommand] : []),
    ...commands.filter(command => typeof command.run === 'function' &&
      (command.id !== 'toggle-hud' || !!window.nubAgent?.hud?.toggle) &&
      (command.id !== 'open-info' || hasSelectedAgent) &&
      (command.id !== 'open-hermes-tools' || hasSelectedAgent) &&
      (command.id !== 'open-hermes-tools' || commands.some(item => item.id === 'open-info')))
      .map(command => command.id === 'open-hermes-tools'
        ? { ...command, run: commands.find(item => item.id === 'open-info')!.run }
        : command.id === 'toggle-hud' ? { ...command, label: 'Show Pip HUD' } : command),
  ], [commands, onDispatchToChat, hasSelectedAgent])
  // Explicit callbacks win. Otherwise use the real shell command, never
  // swallow it just because the identifier is a reserved create/open action.
  const actionHandlers: Record<string, (() => void) | undefined> = {
    'create-routine': onCreateRoutine, 'new-agent': onCreateAgent, 'new-group': onCreateGroup,
    'open-files': onOpenFiles, 'new-conversation': onNewConversation,
  }
  const openFiles = onOpenFiles ?? allCommands.find(command => command.id === 'open-files')?.run
  const openLink = onOpenLink ?? (window.nubAgent?.openExternal
    ? (url: string) => { void window.nubAgent?.openExternal(url) } : undefined)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 150)
    return () => window.clearTimeout(id)
  }, [query])

  // Skip the corpus scan while the palette is closed — it walks every
  // message of every thread (URL extraction + file-ref regexes) and the
  // store refreshes its collections on each poll, which otherwise re-runs
  // this on a 15s cadence for nothing. Reopens recompute via `open`.
  const corpus = useMemo(
    () =>
      open
        ? collectSearchCorpus({
            conversations: [...conversations, ...hiddenConversations],
            messagesByThreadId,
            agents,
            groups,
          })
        : { messages: [], files: [], links: [] },
    [open, conversations, hiddenConversations, messagesByThreadId, agents, groups],
  )

  const extraFiles = useMemo(() => {
    const seen = new Set(corpus.files.map((f) => f.path))
    return files.filter((f) => !seen.has(f.path)).map((f) => ({ path: f.path, label: f.label }))
  }, [corpus.files, files])

  const routineList = Array.isArray(routines) ? routines : []
  const routinesUnavailable = routines === 'unavailable'
  const routinesLoading = routines === 'loading'

  // B1: cross-session hits from the paired agent's transcript tail. Only
  // fetched after the OPTIONS probe passes; a stale deploy leaves this empty
  // and the palette behaves exactly as before. Fetch-once-per-open: one
  // instance fetch per open, filtered locally per keystroke.
  const [serverHits, setServerHits] = useState<TranscriptTailHit[]>([])
  const serverHitsCache = useRef(new Map<string, TranscriptTailHit[]>())
  useEffect(() => {
    if (!open) return
    if (!transcriptSearchInstanceId) {
      setServerHits([])
      return
    }
    const cached = serverHitsCache.current.get(transcriptSearchInstanceId)
    if (cached) {
      setServerHits(cached)
      return
    }
    let cancelled = false
    void (async () => {
      if (!(await probeTranscriptTail())) return
      if (cancelled) return
      const hits = await readTranscriptTails(transcriptSearchInstanceId, { limit: 300 })
      if (cancelled) return
      serverHitsCache.current.set(transcriptSearchInstanceId, hits ?? [])
      setServerHits(hits ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [open, transcriptSearchInstanceId])

  const items = useMemo(() => {
    const rows = buildSearchRows(
      {
        agents,
        groups: onJumpToGroup ? groups : [],
        commands: allCommands.map((c) => ({
          id: c.id,
          label: c.label,
          keywords: c.keywords,
          detail: c.detail,
        })),
        messages: onJumpToMessage ? corpus.messages : [],
        files: onOpenFile ? [...corpus.files, ...extraFiles] : [],
        links: openLink ? corpus.links : [],
        routines: (onOpenRoutine ? routineList : []).map((j) => ({
          id: j.id,
          origin: j.origin,
          name: displayRoutineName({ name: j.name, id: String(j.id) }),
          schedule: formatCronSchedule(j.schedule) || formatCronSchedule(j.schedule_display)
            ? describeRoutineSchedule({
                schedule: formatCronSchedule(j.schedule) || formatCronSchedule(j.schedule_display),
                nextRunAt: j.nextRunAt,
                scheduleLabel: j.scheduleLabel,
              })
            : '',
          enabled: j.enabled,
          prompt: j.prompt,
        })),
      },
      tab,
      debounced,
    )
    const pinned = pinnedCreateRows(tab, {
      onCreateRoutine,
      onCreateAgent,
      onCreateGroup,
      onOpenFiles: openFiles,
      onNewConversation,
    }).filter((row) => createRowMatches(row, debounced))
    const pinnedIds = new Set(pinned.map((r) => r.id))
    const local = [...pinned, ...rows.filter((r) => !pinnedIds.has(r.id))]

    // Merge server transcript hits: server wins on duplicate text within the
    // same conversation; unmapped sessions are skipped rather than faked.
    if (serverHits.length === 0 || !onJumpToMessage) return local
    const tokens = tokenize(debounced)
    if (tokens.length === 0) return local
    const sessionToConv = new Map<string, Conversation>()
    for (const c of [...conversations, ...hiddenConversations]) {
      if (c.hermesSessionId) sessionToConv.set(c.hermesSessionId, c)
    }
    const localTextByConv = new Map<string, Set<string>>()
    for (const r of local) {
      if (r.kind !== 'message') continue
      const set = localTextByConv.get(r.conversationId) ?? new Set<string>()
      set.add(normalizeSearchText(r.label))
      localTextByConv.set(r.conversationId, set)
    }
    const extra: SearchRow[] = []
    const seen = new Set<string>()
    for (const hit of serverHits) {
      const norm = normalizeSearchText(hit.text)
      if (!norm || !tokens.every((t) => norm.includes(t))) continue
      const conv = sessionToConv.get(hit.sessionId)
      if (!conv) continue
      const key = `${conv.id}:${norm}`
      if (seen.has(key)) continue
      seen.add(key)
      // Server wins on dedupe: identical text already offered locally → skip.
      if (localTextByConv.get(conv.id)?.has(norm)) continue
      extra.push({
        kind: 'message',
        id: `srv:${hit.sessionId}:${hit.rowId}`,
        label: hit.text.length > 96 ? `${hit.text.slice(0, 95)}…` : hit.text,
        subtitle: `${conv.title} · agent transcript`,
        conversationId: conv.id,
        messageId: '',
      })
    }
    return [...local, ...extra]
  }, [
    agents,
    groups,
    allCommands,
    corpus,
    extraFiles,
    routineList,
    tab,
    debounced,
    onCreateRoutine,
    onCreateAgent,
    onCreateGroup,
    onOpenFiles,
    openFiles,
    onOpenFile,
    onOpenLink,
    onJumpToGroup,
    onJumpToMessage,
    onOpenRoutine,
    onNewConversation,
    serverHits,
    conversations,
    hiddenConversations,
  ])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebounced('')
    setSel(0)
    setTab('all')
    const t = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => setSel(0), [debounced, tab])

  // Enter / ⌘1–9 typed faster than the debounce would act on the previous
  // query's rows (often a pinned "Create …" row). Flush the query instead
  // and run the pick once the rows match what was typed.
  const pendingRun = useRef<number | null>(null)
  useEffect(() => {
    if (pendingRun.current === null || debounced !== query) return
    const idx = pendingRun.current
    pendingRun.current = null
    if (items[idx]) run(items[idx])
  })

  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    if (el instanceof HTMLElement) el.scrollIntoView?.({ block: 'nearest' })
  }, [sel, items])

  // Closing gives focus back to where it was (the composer, a sidebar row),
  // as AppModal does. Only when focus would otherwise be lost: a surface the
  // pick opened (an editor, the composer) keeps the focus it took.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    return () => {
      const now = document.activeElement
      if ((!now || now === document.body) && prev?.isConnected) prev.focus()
    }
  }, [open])

  // Escape dismisses the palette from anywhere inside it — not just while the
  // search input holds focus (tab pills and result rows included).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !dialogRef.current ||
        [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
          .filter((dialog) => !dialog.closest('[inert]')).at(-1) !== dialogRef.current) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const run = (item: SearchRow) => {
    switch (item.kind) {
      case 'agent':
        onJumpToAgent(item.agent.id)
        break
      case 'group':
        onJumpToGroup?.(item.group.id)
        break
      case 'message':
        onJumpToMessage?.(item.conversationId, item.messageId)
        break
      case 'file':
        onOpenFile?.(item.path)
        break
      case 'link':
        openLink?.(item.url)
        break
      case 'routine':
        onOpenRoutine?.(item.jobId, item.origin)
        break
      case 'action': {
        const handler = actionHandlers[item.commandId] ?? allCommands.find(command => command.id === item.commandId)?.run
        if (!handler) return
        handler()
        break
      }
    }
    onClose()
  }

  const cycleTab = (dir: 1 | -1) => {
    const i = SEARCH_TABS.indexOf(tab)
    const next = SEARCH_TABS[(i + dir + SEARCH_TABS.length) % SEARCH_TABS.length]
    setTab(next)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, Math.max(0, items.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      e.preventDefault()
      cycleTab(1)
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0) {
      e.preventDefault()
      cycleTab(-1)
    } else if (e.key === 'Enter' && query !== debounced) {
      e.preventDefault()
      pendingRun.current = 0
      setDebounced(query)
    } else if (e.key === 'Enter' && items[sel]) {
      e.preventDefault()
      run(items[sel])
    } else if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1
      if (query !== debounced) {
        e.preventDefault()
        pendingRun.current = idx
        setDebounced(query)
      } else if (items[idx]) {
        e.preventDefault()
        run(items[idx])
      }
    }
  }

  const empty =
    items.length === 0 && debounced.trim()
      ? { label: `No matches for “${debounced.trim()}”` }
      : emptyCopy(tab)
  const showEmpty = items.length === 0 && !(tab === 'routines' && routinesLoading)
  const emptyAction = emptyActionForTab(tab, {
    onCreateRoutine,
    onCreateAgent,
    onCreateGroup,
    onOpenFiles: openFiles,
    onNewConversation,
  })

  return (
    // px-3 below `sm`: on a phone the card keeps a margin instead of
    // running edge to edge.
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh] sm:px-0 inert:z-40" onClick={onClose}>
      <div className="nub-scrim absolute inset-0" />
      <LocalPanelTheme />
      <div
        ref={dialogRef}
        role="dialog"
        data-esc-layer
        aria-modal="true"
        aria-label="Search"
        className="hd-local-surface desk-theme nub-overlay relative w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl ring-1 ring-[var(--ca-border)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Tab stays inside the open search (input and category pills); the
          // page behind is dimmed and aria-modal hides it.
          if (e.key !== 'Tab' || !dialogRef.current) return
          const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])',
          )
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--ca-border)] px-3 py-2.5">
          <span className="text-[var(--ca-ink-muted)]">
            <SearchGlyph />
          </span>
          <input
            ref={inputRef}
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="maia-palette-listbox"
            aria-activedescendant={items[sel] ? `palette-option-${sel}` : undefined}
            className="min-h-8 min-w-0 flex-1 bg-transparent text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)]"
          />
        </div>

        <div
          role="tablist"
          aria-label="Search category"
          className="flex gap-1 overflow-x-auto border-b border-[var(--ca-border)] px-2 py-1.5"
        >
          {SEARCH_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`min-h-8 min-w-8 shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
                tab === id
                  ? 'bg-[var(--ca-ink)] text-[var(--ca-card)]'
                  : 'text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]'
              }`}
            >
              {SEARCH_TAB_LABEL[id]}
            </button>
          ))}
        </div>

        <span className="sr-only" aria-live="polite">
          {!debounced.trim() ? '' : items.length === 0 ? 'No matches' : `${items.length} ${items.length === 1 ? 'result' : 'results'}`}
        </span>
        <div ref={listRef} role="listbox" id="maia-palette-listbox" aria-label="Search results" className="max-h-80 overflow-y-auto p-1.5">
          {tab === 'routines' && routinesUnavailable && (
            <div className="mb-1 flex items-center justify-between gap-2 rounded-xl bg-[var(--ca-card)] px-3 py-2 text-[11px] text-[var(--ca-ink-muted)]">
              <span>Scheduler is offline — routines you create stay on {hostMachinePhrase()}.</span>
              {onRetryRoutines ? (
                <button
                  type="button"
                  onClick={onRetryRoutines}
                  className="shrink-0 rounded-full bg-[var(--ca-card)] px-2 py-0.5 font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)]"
                >
                  Retry
                </button>
              ) : null}
            </div>
          )}
          {tab === 'routines' && routinesLoading && (
            <div className="px-3 py-4 text-center text-xs text-[var(--ca-ink-muted)]">Loading routines…</div>
          )}
          {showEmpty && (
            <div className="px-3 py-6 text-center">
              <div className="text-sm font-medium text-[var(--ca-ink)]">{empty.label}</div>
              {'hint' in empty && empty.hint ? (
                <div className="mt-1 text-xs text-[var(--ca-ink-muted)]">{empty.hint}</div>
              ) : null}
              {emptyAction ? (
                <button
                  type="button"
                  onClick={() => {
                    emptyAction.run()
                    onClose()
                  }}
                  className="mt-3 rounded-full bg-[var(--ca-ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-card)]"
                >
                  {emptyAction.label}
                </button>
              ) : null}
            </div>
          )}
          {items.map((item, i) => {
            const hotkey = shortcutIndex(i)
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                id={`palette-option-${i}`}
                aria-selected={i === sel}
                tabIndex={-1}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(item)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${
                  i === sel ? 'bg-[var(--ca-primary-soft)]' : 'hover:bg-[var(--ca-hover)]'
                }`}
              >
                <span className="shrink-0">
                  <RowIcon row={item} agents={agents} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-[var(--ca-ink)]">{item.label}</span>
                    {item.kind === 'agent' && item.badge ? (
                      <span className="shrink-0 rounded-md bg-[var(--ca-card)] px-1.5 py-px text-[10px] font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{item.subtitle}</span>
                </span>
                {hotkey != null && (
                  <kbd
                    className="hidden shrink-0 rounded-md bg-[var(--ca-card)] sm:inline px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]"
                    style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' }}
                  >
                    {MOD}
                    {hotkey}
                  </kbd>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function pinnedCreateRows(
  tab: SearchTab,
  cbs: {
    onCreateRoutine?: () => void
    onCreateAgent?: () => void
    onCreateGroup?: () => void
    onOpenFiles?: () => void
    onNewConversation?: () => void
  },
): SearchRow[] {
  const rows: SearchRow[] = []
  if (tab === 'routines' && cbs.onCreateRoutine) {
    rows.push({
      kind: 'action',
      id: 'cmd:create-routine',
      label: 'Create Routine',
      subtitle: 'Schedule a recurring task',
      commandId: 'create-routine',
      keywords: ['new', 'create', 'routine', 'cron', 'schedule'],
    })
  }
  if (tab === 'agents' && cbs.onCreateAgent) {
    rows.push({
      kind: 'action',
      id: 'cmd:new-agent',
      label: 'New Agent',
      subtitle: 'Create an agent',
      commandId: 'new-agent',
      keywords: ['new', 'create', 'agent', 'bot'],
    })
  }
  if (tab === 'groups' && cbs.onCreateGroup) {
    rows.push({
      kind: 'action',
      id: 'cmd:new-group',
      label: 'New Group',
      subtitle: 'Start a shared room',
      commandId: 'new-group',
      keywords: ['new', 'create', 'group', 'room'],
    })
  }
  if (tab === 'files' && cbs.onOpenFiles) {
    rows.push({
      kind: 'action',
      id: 'cmd:open-files',
      label: 'Open Files',
      subtitle: 'Browse the workspace',
      commandId: 'open-files',
      keywords: ['open', 'files', 'folder', 'workspace'],
    })
  }
  return rows
}

function createRowMatches(row: SearchRow, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const hay = [row.label, row.subtitle, ...((row.kind === 'action' && row.keywords) || [])]
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => hay.includes(t))
}

function emptyActionForTab(
  tab: SearchTab,
  cbs: {
    onCreateRoutine?: () => void
    onCreateAgent?: () => void
    onCreateGroup?: () => void
    onOpenFiles?: () => void
    onNewConversation?: () => void
  },
): { label: string; run: () => void } | null {
  if (tab === 'routines' && cbs.onCreateRoutine) return { label: 'Create Routine', run: cbs.onCreateRoutine }
  if (tab === 'agents' && cbs.onCreateAgent) return { label: 'New Agent', run: cbs.onCreateAgent }
  if (tab === 'groups' && cbs.onCreateGroup) return { label: 'New Group', run: cbs.onCreateGroup }
  if (tab === 'files' && cbs.onOpenFiles) return { label: 'Open Files', run: cbs.onOpenFiles }
  if (tab === 'messages' && cbs.onNewConversation) {
    return { label: 'New Conversation', run: cbs.onNewConversation }
  }
  return null
}
