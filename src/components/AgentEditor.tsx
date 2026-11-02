/**
 * AgentEditor — Grok Bot parity create flow.
 *
 * Clicking "+ New agent" / the picker's "create" row opens THIS editor
 * instead of insta-creating a default agent: fill in the name, title and
 * bio, pick the mascot shape + color with a LIVE preview, then "Create
 * agent" commits it (transport.createAgent with the full profile) and opens
 * the first conversation. Escape / Cancel closes without creating.
 *
 * Renders in the shared AppModal; only the current opening owns dismissal.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentRole, NewAgentProfile } from '../lib/agents'
import type { AgentMcpServer } from '../lib/agents/types'
import { AppModal } from './AppModal'
import { AvatarStudio } from './AvatarStudio'
import { CHIEF_OF_STAFF_PRESET } from '../lib/peer-roster'
import { AgentMcpAttach } from './AgentMcpAttach'
import { TONE_PRESETS } from '../lib/agent-profiles'

interface AgentEditorProps {
  open: boolean
  /** Prefill from the picker's "create <name>" row (optional). */
  initialName?: string
  onClose: () => void
  onCreate: (profile: NewAgentProfile) => void | Promise<void>
}

export function AgentEditor({ open, initialName, onClose, onCreate }: AgentEditorProps) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [role, setRole] = useState<AgentRole>('specialist')
  const [mcpServers, setMcpServers] = useState<AgentMcpServer[]>([])
  const [tone, setTone] = useState<string>('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const openingRef = useRef<object | null>(null)
  const createAction = useRef<{ opening: object } | null>(null)
  const focusFrame = useRef<number | null>(null)
  const invalidateOpening = useCallback(() => {
    openingRef.current = null
    createAction.current = null
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = null
  }, [])

  // Reset the draft whenever the editor opens (fresh create each time).
  useLayoutEffect(() => {
    invalidateOpening()
    setCreating(false)
    setError('')
    if (open) {
      const opening = {}
      openingRef.current = opening
      setName(initialName ?? '')
      setTitle('')
      setDescription('')
      setRole('specialist')
      setMcpServers([])
      setTone('')
      const input = nameRef.current
      const frame = requestAnimationFrame(() => {
        if (focusFrame.current !== frame || openingRef.current !== opening) return
        focusFrame.current = null
        if (!input?.isConnected || input.disabled || createAction.current) return
        const active = document.activeElement
        if (active === document.body || active === input.closest('[role="dialog"]'))
          input.focus({ preventScroll: true })
      })
      focusFrame.current = frame
    }
    return invalidateOpening
  }, [open, initialName, invalidateOpening])

  const requestClose = () => {
    invalidateOpening()
    onClose()
  }

  const commit = async () => {
    const trimmed = name.trim()
    const opening = openingRef.current
    if (!open || !opening || !trimmed || createAction.current) return
    const action = { opening }
    createAction.current = action
    const current = () => createAction.current === action && openingRef.current === opening
    setCreating(true)
    setError('')
    try {
      await onCreate({
        name: trimmed,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        avatarShape: 'cat',
        // No color: each agent gets its own from the nubcat palette (by id).
        role,
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(tone ? { personality: TONE_PRESETS.find((p) => p.id === tone)?.text } : {}),
      })
      if (current()) requestClose()
    } catch (err) {
      if (!current()) return
      const msg = err instanceof Error ? err.message : ''
      // Unlinked transport leaks its internal guard text — translate it.
      setError(
        msg.startsWith('not linked')
          ? 'Hermes is not connected. Check Hermes setup and try again.'
          : msg || 'Could not create agent.',
      )
    } finally {
      if (current()) {
        createAction.current = null
        setCreating(false)
      }
    }
  }

  return (
    <AppModal open={open} onClose={requestClose} title="Create agent" size="md">
      <div className="space-y-3.5 p-4">
        <AvatarStudio />

        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Name</div>
          <input
            ref={nameRef}
            aria-label="Name"
            value={name}
            disabled={creating}
            onChange={(e) => { if (openingRef.current && !createAction.current) setName(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
              }
            }}
            placeholder="Bob"
            className="w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30"
          />
        </div>

        <button
          type="button"
          disabled={creating}
          onClick={() => {
            if (!openingRef.current || createAction.current) return
            setName((n) => n.trim() || CHIEF_OF_STAFF_PRESET.name)
            setTitle(CHIEF_OF_STAFF_PRESET.title)
            setDescription(CHIEF_OF_STAFF_PRESET.description)
            setRole(CHIEF_OF_STAFF_PRESET.role)
          }}
          className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
            role === 'orchestrator'
              ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink)] ring-2 ring-[var(--ca-primary)]/40'
              : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:bg-[var(--ca-card)] hover:text-[var(--ca-ink)]'
          }`}
        >
          <span className="font-medium text-[var(--ca-ink)]">Chief of Staff</span>
          <span className="mt-0.5 block text-[11px] leading-snug">
            Coordinates other agents, then summarizes what they return.
          </span>
        </button>

        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Title</div>
          <input
            aria-label="Title"
            value={title}
            disabled={creating}
            onChange={(e) => { if (openingRef.current && !createAction.current) setTitle(e.target.value) }}
            placeholder="Describe what your agent does"
            className="w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30"
          />
        </div>

        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Description</div>
          <textarea
            aria-label="Description"
            value={description}
            disabled={creating}
            onChange={(e) => { if (openingRef.current && !createAction.current) setDescription(e.target.value) }}
            rows={2}
            placeholder="What this agent is for"
            className="w-full resize-none rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-xs text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30"
          />
        </div>

        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Personality</div>
          <div role="radiogroup" aria-label="Personality" className="flex flex-wrap gap-1.5">
            {[{ id: '', label: 'Same as main agent' }, ...TONE_PRESETS].map((p) => (
              <button
                key={p.id || 'inherit'}
                type="button"
                role="radio"
                aria-checked={tone === p.id}
                disabled={creating}
                onClick={() => { if (openingRef.current && !createAction.current) setTone(p.id) }}
                className={`rounded-full px-2.5 py-1 text-[11px] transition ${
                  tone === p.id
                    ? 'bg-[var(--ca-primary-fill)] text-white'
                    : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:text-[var(--ca-ink)]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-[var(--ca-ink-muted)]">
            You can fine-tune this later in Agent info.
          </p>
        </div>

        <AgentMcpAttach selected={mcpServers} disabled={creating}
          onChange={next => { if (openingRef.current && !createAction.current) setMcpServers(next) }} />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--ca-border)] px-4 py-3">
        {error ? (
          <span role="alert" className="mr-auto max-w-[18rem] text-[11px] leading-4 text-[var(--ca-danger)]">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={requestClose}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!name.trim() || creating}
          className="rounded-lg bg-[var(--ca-primary-fill)] px-3.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {creating ? 'Creating…' : 'Create agent'}
        </button>
      </div>
    </AppModal>
  )
}
