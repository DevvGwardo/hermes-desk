/**
 * NewChatBar — Grok Bot parity agent picker.
 *
 * Reverse-engineered from the Grok Bot asar (`sand-new-chat-bar`): clicking
 * "+ New" opens a recipient picker instead of silently creating a
 * conversation with the current agent. The bar is:
 *   - a "To:" label + search input ("Search or create Bots")
 *   - a filtered roster: existing agents + groups (with mascots), plus a
 *     "create" entry when the typed name matches nothing
 *   - keyboard navigation (↑/↓, Tab, Enter, ⌘1-9), Escape to dismiss
 *   - picking an agent/group opens (or creates) a conversation with it via
 *     onOpenTarget — grok's `openAgentExchange` after commit.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { Agent, Group, ThreadRef } from '../lib/agents'
import { resolveAgentMascot } from '../lib/agents'
import { memberCatColors } from '../lib/agents/identity'
import { FatCatIcon } from './FatCatIcon'

interface NewChatBarProps {
  open: boolean
  agents: Agent[]
  groups: Group[]
  /** Open (or create) a conversation with the chosen target. */
  onOpenTarget: (target: ThreadRef) => void
  /** Create a brand-new agent from the typed name (grok "create" row). */
  onCreateAgent?: (name?: string) => void
  onClose: () => void
}

type Option =
  | { kind: 'agent'; id: string; name: string; agent: Agent }
  | { kind: 'group'; id: string; name: string; group: Group }
  | { kind: 'create'; name: string }
  | { kind: 'create-new'; name: string }

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Filter + rank agents/groups by the typed query (grok `J_n`). */
function filterOptions(agents: Agent[], groups: Group[], query: string): Option[] {
  const q = normalize(query)
  const base: Option[] = [
    ...agents.map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name, agent: a })),
    ...groups.map((g) => ({ kind: 'group' as const, id: g.id, name: g.name, group: g })),
  ]
  if (!q) {
    // Grok: empty query lists the roster; a "create-new" hint leads the list
    // only when nothing exists yet.
    const roster = base
    return roster.length === 0 ? [{ kind: 'create-new', name: '' }] : roster
  }
  const tokens = q.split(' ')
  const scored = base
    .map((opt) => {
      const hay = normalize(opt.name)
      let score = 0
      for (const tok of tokens) {
        if (hay.includes(tok)) score += 1
      }
      return { opt, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.opt)
  if (scored.length === 0) return [{ kind: 'create', name: query.trim() }]
  return scored
}

export default function NewChatBar({
  open,
  agents,
  groups,
  onOpenTarget,
  onCreateAgent,
  onClose,
}: NewChatBarProps) {
  const reduce = useReducedMotion()
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(() => filterOptions(agents, groups, query), [agents, groups, query])
  const active = options.length === 0 ? 0 : Math.min(highlighted, options.length - 1)

  // Focus the input whenever the bar opens (grok focuses the picker input).
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlighted(0)
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    }
  }, [open])

  if (!open) return null

  const commit = (opt: Option | undefined) => {
    if (!opt) return
    if (opt.kind === 'agent') {
      onOpenTarget({ type: 'agent', agentId: opt.id })
      onClose()
    } else if (opt.kind === 'group') {
      onOpenTarget({ type: 'group', groupId: opt.id })
      onClose()
    } else if (opt.kind === 'create') {
      // Grok: typing an unknown name shows "create <name>". We create a new
      // agent named after the query and open a chat with it.
      onCreateAgent?.(opt.name)
      onClose()
    } else {
      // create-new (empty roster)
      onCreateAgent?.()
      onClose()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => (options.length === 0 ? 0 : Math.min(h + 1, options.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(options[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      const idx = Number(e.key) - 1
      if (idx < options.length) {
        e.preventDefault()
        commit(options[idx])
      }
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        className="absolute left-2 right-2 top-[52px] z-40 overflow-hidden rounded-2xl bg-[var(--ca-card)] shadow-[var(--ca-shadow)] ring-1 ring-[var(--ca-border)]"
      >
        {/* To: field (grok sand-new-chat-bar) */}
        <div className="flex items-center gap-2 border-b border-[var(--ca-border)] px-3 py-2">
          <span className="text-xs font-medium text-[var(--ca-ink-muted)]">To:</span>
          <input
            ref={inputRef}
            aria-label="To"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlighted(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search or create Bots"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)]"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent picker"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--ca-ink-muted)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
          >
            ✕
          </button>
        </div>

        {/* Roster (grok: filtered agents + create rows) */}
        <div className="max-h-72 overflow-y-auto p-1.5">
          {options.length === 0 && (
            <p className="px-3 py-3 text-center text-xs text-[var(--ca-ink-muted)]">
              No agents found.
            </p>
          )}
          {options.map((opt, i) => {
            const isActive = i === active
            const row =
              'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition ' +
              (isActive ? 'bg-[var(--ca-primary-soft)]' : 'hover:bg-[var(--ca-hover)]')
            const name =
              opt.kind === 'agent' || opt.kind === 'group' || opt.kind === 'create'
                ? opt.name
                : 'New Bot'
            const sub =
              opt.kind === 'agent'
                ? opt.agent.persona?.title ?? opt.agent.summary ?? 'agent'
                : opt.kind === 'group'
                  ? `${opt.group.memberAgentIds.length} members`
                  : opt.kind === 'create'
                    ? `Create "${opt.name}"`
                    : 'Create a new Bot'

            let icon: React.ReactNode = <span className="text-sm">🤖</span>
            if (opt.kind === 'agent') {
              const mascot = resolveAgentMascot(opt.agent)
              icon = (
                <FatCatIcon
                  expression="happy"
                  shape={mascot.shape}
                  fgColor={mascot.color}
                  fx={null}
                  still
                  size={26}
                />
              )
            } else if (opt.kind === 'group') {
              const members = opt.group.memberAgentIds
                .map((id) => agents.find((a) => a.id === id))
                .filter(Boolean) as Agent[]
              const colors = memberCatColors(members)
              icon = (
                <span className="flex -space-x-1">
                  {members.slice(0, 2).map((m) => {
                    const mascot = resolveAgentMascot(m)
                    return (
                      <FatCatIcon
                        key={m.id}
                        expression="happy"
                        shape={mascot.shape}
                        fgColor={colors.get(m.id) ?? mascot.color}
                        fx={null}
                        still
                        size={20}
                        className="rounded-full ring-2 ring-[var(--ca-card)]"
                      />
                    )
                  })}
                  {members.length === 0 && <span className="text-sm">👥</span>}
                </span>
              )
            } else if (opt.kind === 'create') {
              icon = <span className="text-sm">✨</span>
            } else {
              icon = <span className="text-sm">✨</span>
            }

            return (
              <button
                key={`${opt.kind}-${'id' in opt ? opt.id : opt.name}`}
                type="button"                onMouseEnter={() => setHighlighted(i)}
                onClick={() => commit(opt)}
                className={row}
              >
                <span className="shrink-0">{icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--ca-ink)]">
                    {name}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">
                    {sub}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {/* Footer hint (grok key-cap hints) */}
        <div className="flex items-center gap-3 border-t border-[var(--ca-border)] px-3 py-1.5 text-[10px] text-[var(--ca-ink-muted)]">
          <span>
            <kbd className="rounded bg-[var(--ca-card)] px-1 ring-1 ring-[var(--ca-border)]">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="rounded bg-[var(--ca-card)] px-1 ring-1 ring-[var(--ca-border)]">↵</kbd> open
          </span>
          <span>
            <kbd className="rounded bg-[var(--ca-card)] px-1 ring-1 ring-[var(--ca-border)]">esc</kbd> close
          </span>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
