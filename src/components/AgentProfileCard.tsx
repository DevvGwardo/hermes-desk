import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentLook } from '../lib/agents/identity'
import { FatCatIcon } from './FatCatIcon'

/**
 * Who is this? Opens from any agent name or mascot in a chat: the agent's
 * mascot, name, title, what it does, whether it leads the room, what it's
 * doing right now, and the two things you'd do next (message it directly,
 * or @mention it here).
 */
export interface AgentProfile {
  id: string
  name: string
  title?: string
  description?: string
  chief: boolean
  look: AgentLook | null
  /** "typing", "using web search", "reading" — null when idle. */
  liveText: string | null
  /** False for a member this device doesn't have (created on another device). */
  known: boolean
  idleText?: string
  unavailableText?: string
}

const CARD_W = 300

export function AgentProfileCard({
  profile,
  anchor,
  onClose,
  onMessage,
  onMention,
}: {
  profile: AgentProfile
  anchor: HTMLElement
  onClose: () => void
  onMessage?: (agentId: string) => void
  onMention?: (name: string) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Below the anchor, flipped above when it would run off the bottom, and
  // clamped to the viewport with a 12px margin.
  useLayoutEffect(() => {
    const position = () => {
      if (!anchor.isConnected) { onClose(); return }
      const r = anchor.getBoundingClientRect()
      const h = ref.current?.offsetHeight ?? 220
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(CARD_W, vw - 24)
      const left = Math.max(12, Math.min(r.left, vw - w - 12))
      const below = r.bottom + 6
      const top = below + h > vh - 12 ? Math.max(12, r.top - h - 6) : below
      setPos(previous => previous?.left === left && previous.top === top ? previous : { left, top })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [anchor, profile, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [anchor, onClose])

  // Keyboard users land in the card.
  useEffect(() => {
    const card = ref.current
    card?.focus()
    return () => {
      // Mention/Message may have deliberately moved focus to another control.
      if (anchor.isConnected && (card?.contains(document.activeElement) || document.activeElement === document.body))
        anchor.focus({ preventScroll: true })
    }
  }, [anchor])

  const { look } = profile
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`About ${profile.name}`}
      tabIndex={-1}
      data-testid="agent-profile-card"
      data-esc-layer
      className="fixed z-50 flex flex-col gap-3 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] p-4 text-[var(--ca-ink)] shadow-[var(--ca-shadow)] outline-none"
      style={{ width: Math.min(CARD_W, typeof window === 'undefined' ? CARD_W : window.innerWidth - 24), left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
          style={{ backgroundColor: look ? `${look.body}66` : 'var(--ca-primary-soft)' }}
        >
          <FatCatIcon size={40} still fgColor={look?.body} bgColor={look?.eye} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold">{profile.name}</span>
            {profile.chief && (
              <span className="rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ca-primary-text)]">
                Leads this room
              </span>
            )}
          </div>
          {profile.title && <div className="truncate text-[12px] text-[var(--ca-ink-muted)]">{profile.title}</div>}
          <div className="mt-1 flex items-center gap-1.5 text-[12px]" data-testid="agent-profile-live">
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${profile.liveText ? 'bg-[var(--ca-success)]' : 'border border-[var(--ca-ink-muted)]'}`}
            />
            <span className={profile.liveText ? 'text-[var(--ca-success-text)]' : 'text-[var(--ca-ink-muted)]'}>
              {profile.liveText ? `${profile.liveText[0]!.toUpperCase()}${profile.liveText.slice(1)} here` : profile.idleText ?? 'Idle in this chat'}
            </span>
          </div>
        </div>
        <button type="button" aria-label={`Close ${profile.name} profile`} onClick={onClose}
          className="rounded-md px-1.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ca-focus-ring)]">
          Close
        </button>
      </div>
      {profile.description ? (
        <p className="line-clamp-4 text-[13px] leading-snug text-[var(--ca-ink-soft)]">{profile.description}</p>
      ) : profile.known ? (
        <p className="text-[12px] text-[var(--ca-ink-muted)]">
          No description yet. Add one in the agent’s info.
        </p>
      ) : null}
      {!profile.known && <p className="text-[12px] text-[var(--ca-ink-muted)]">
        {profile.unavailableText ?? 'Set up on another device.'}
      </p>}
      <div className="flex gap-2">
        {onMessage && profile.known && (
          <button
            type="button"
            onClick={() => {
              onMessage(profile.id)
              onClose()
            }}
            className="nub-btn-primary flex-1 rounded-full px-3 py-1.5 text-[13px] font-medium"
          >
            Message
          </button>
        )}
        {onMention && (
          <button
            type="button"
            onClick={() => {
              onMention(profile.name)
              onClose()
            }}
            className="flex-1 rounded-full border border-[var(--ca-field-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-hover)]"
          >
            @Mention
          </button>
        )}
      </div>
    </div>
  )
}
