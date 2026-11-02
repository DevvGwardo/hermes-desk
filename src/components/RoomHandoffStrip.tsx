import { memo } from 'react'
import type { HandoffPill, HandoffState, HandoffStrip } from '../lib/agents/rooms'
import { AgentMascot } from './agent-identity'

/**
 * The hand-off strip under a room message that @mentioned members: one
 * pill per member it asked, showing that member's live phase or outcome,
 * then the Chief's wrap-up. With `onOpen`, any pill opens the hand-off's
 * transcript (HandoffTranscriptModal); otherwise a replied pill jumps to
 * the reply.
 * Data: `roomHandoffStrips` (lib/agents/rooms.ts) over the feed's handoffs.
 */

const LIVE = new Set<HandoffState | 'pending'>(['queued', 'reading', 'working', 'typing'])

function Dot({ state }: { state: HandoffState | 'pending' }) {
  const live = LIVE.has(state)
  const tone =
    state === 'replied'
      ? 'bg-[var(--ca-success)]'
      : state === 'failed'
        ? 'bg-[var(--ca-danger)]'
        : live
          ? 'bg-[var(--ca-primary)]'
          : 'border border-[var(--ca-ink-muted)] bg-transparent'
  return (
    <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
      {live && (
        <span className="absolute inset-0 rounded-full bg-[var(--ca-primary)] opacity-60 motion-safe:animate-ping" />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${tone}`} />
    </span>
  )
}

function stateText(state: HandoffState | 'pending'): string {
  return state === 'failed'
    ? 'text-[var(--ca-danger)]'
    : state === 'replied'
      ? 'text-[var(--ca-success-text)]'
      : LIVE.has(state)
        ? 'text-[var(--ca-primary-text)]'
        : 'text-[var(--ca-ink-muted)]'
}

function Pill({
  pill,
  prefix,
  dashed,
  onJump,
  onOpen,
}: {
  pill: Omit<HandoffPill, 'state'> & { state: HandoffState | 'pending' }
  prefix: string
  dashed?: boolean
  onJump?: (rowId: string) => void
  onOpen?: (turnId: string) => void
}) {
  const body = (
    <>
      <Dot state={pill.state} />
      <AgentMascot agentId={pill.memberId} size={14} />
      <span className="max-w-[10rem] truncate font-medium text-[var(--ca-ink)]">
        {prefix}
        {pill.name}
      </span>
      <span className={`max-w-[12rem] truncate ${stateText(pill.state)}`}>
        {pill.label}
        {pill.replyRowId && onJump && !onOpen ? ' ↓' : ''}
      </span>
    </>
  )
  const cls = `inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 ${
    dashed
      ? 'border border-dashed border-[var(--ca-border-strong)]'
      : 'bg-[var(--ca-primary-soft)]'
  }`
  if (onOpen) {
    return (
      <button
        type="button"
        data-testid="handoff-pill"
        data-state={pill.state}
        title={`See ${pill.name}'s part of this hand-off`}
        onClick={() => onOpen(pill.turnId)}
        className={`${cls} cursor-pointer hover:ring-1 hover:ring-[var(--ca-primary)] focus-visible:outline-2 focus-visible:outline-[var(--ca-focus-ring)]`}
      >
        {body}
      </button>
    )
  }
  if (pill.replyRowId && onJump) {
    const rowId = pill.replyRowId
    return (
      <button
        type="button"
        data-testid="handoff-pill"
        data-state={pill.state}
        title={`Jump to ${pill.name}'s reply`}
        onClick={() => onJump(rowId)}
        className={`${cls} cursor-pointer hover:ring-1 hover:ring-[var(--ca-primary)] focus-visible:outline-2 focus-visible:outline-[var(--ca-focus-ring)]`}
      >
        {body}
      </button>
    )
  }
  return (
    <span data-testid="handoff-pill" data-state={pill.state} className={cls}>
      {body}
    </span>
  )
}

export const RoomHandoffStrip = memo(function RoomHandoffStrip({
  strip,
  onJump,
  onOpen,
}: {
  strip: HandoffStrip
  onJump?: (rowId: string) => void
  /** Open the transcript modal for this strip, focused on a pill's turn. */
  onOpen?: (rowId: string, turnId: string) => void
}) {
  const open = onOpen ? (turnId: string) => onOpen(strip.rowId, turnId) : undefined
  const names = strip.pills.map((p) => p.name)
  const summary = `Handed off to ${names.join(', ')}: ${strip.pills
    .map((p) => `${p.name} ${p.label}`)
    .join(', ')}${strip.wrap ? `. ${strip.wrap.name} ${strip.wrap.label}` : ''}`
  return (
    <div className="flex justify-start" data-testid="handoff-strip" data-done={strip.done ? 'true' : 'false'}>
      <div
        role="group"
        aria-label={summary}
        className="sand-on-wall mt-1 flex max-w-full flex-wrap items-center gap-1.5 rounded-2xl border border-[var(--ca-border)] px-2 py-1 text-[11px] leading-tight"
      >
        <span className="pl-0.5 text-[var(--ca-ink-muted)]">Handed off</span>
        {strip.pills.map((p) => (
          <Pill key={p.turnId} pill={p} prefix="@" onJump={onJump} onOpen={open} />
        ))}
        {strip.wrap && (
          <>
            <span aria-hidden className="text-[var(--ca-ink-muted)]">
              →
            </span>
            <Pill pill={strip.wrap} prefix="" dashed onJump={onJump} onOpen={open} />
          </>
        )}
      </div>
    </div>
  )
})
