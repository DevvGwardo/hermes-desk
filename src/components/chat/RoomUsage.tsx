import { useEffect, useRef, useState } from 'react'
import type { LocalRoomState } from '../../lib/agents/local-rooms'
import { roomUsageSummary } from '../../lib/agents/room-usage'

interface Props {
  journal: LocalRoomState
  memberName: (id: string) => string
  onSetBudget?: (limit: number) => Promise<boolean>
}

/** Reported tokens, not a billing cap. Unreported usage is never priced as zero. */
export function RoomUsage({ journal, memberName, onSetBudget }: Props) {
  const summary = roomUsageSummary(journal)
  const [limit, setLimit] = useState(String(summary.tokenBudget))
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setLimit(String(summary.tokenBudget)) }, [summary.tokenBudget])
  async function save() {
    const value = Number(limit)
    if (busyRef.current || !onSetBudget) return
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
      setError('Choose a whole token limit between 1 and 10,000,000.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      if (!await onSetBudget(value) && mounted.current) setError('Could not save the token budget. No paused work was resumed.')
    } catch {
      if (mounted.current) setError('Could not save the token budget. No paused work was resumed.')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const format = (n: number) => n.toLocaleString('en-US')
  return <details className="px-5 py-1 text-[11px] text-[var(--ca-ink-muted)]" data-testid="room-usage">
    <summary className="cursor-pointer">
      Reported room tokens: {format(summary.total)} · {summary.pausedRoots.length ? 'Budget paused' : summary.retryPaused ? 'Budget reached' : `${format(summary.tokenBudget)} per request`}
      {summary.unknownTurns > 0 && ' · Incomplete usage'}
    </summary>
    <div className="flex flex-col gap-2 py-2">
      {summary.pausedRoots.length > 0 && <p role="status">Token budget reached. Raise the limit to resume queued members, or Stop to cancel them.</p>}
      {!summary.pausedRoots.length && summary.retryPaused && <p role="status">Token budget reached. Raise the limit before retrying failed members. Failed turns are not retried automatically.</p>}
      <ul aria-label="Member token usage">
        {Object.entries(summary.members).map(([id, usage]) => <li key={id}>
          {usage.name ?? memberName(id)}: {format(usage.total)} total ({format(usage.input)} input, {format(usage.output)} output)
          {usage.unknownTurns > 0 && `; ${usage.unknownTurns} turn(s) with unknown usage`}
        </li>)}
      </ul>
      <label className="flex items-center gap-2">
        Per-request token budget
        <input aria-label="Per-request token budget" type="number" min={1} max={10_000_000} step={1}
          className="w-28 rounded border border-[var(--ca-border)] px-2 py-1"
          value={limit} disabled={busy || !onSetBudget} onChange={event => setLimit(event.target.value)} />
      </label>
      <button type="button" className="self-start rounded border border-[var(--ca-border)] px-2 py-1"
        disabled={busy || !onSetBudget} onClick={() => void save()}>{busy ? 'Saving budget…' : 'Save token budget'}</button>
      {error && <p role="alert">{error}</p>}
      <p>Pauses new member turns using reported tokens. Running calls can exceed the limit. Missing usage is unknown, not free.</p>
      <p>Cost estimate unavailable: no verified model pricing.</p>
    </div>
  </details>
}
