import { useEffect, useState } from 'react'

/** How long a load runs before the line says the agent is slow to answer. */
export const SLOW_AGENT_MS = 4000

/**
 * "Loading…" for a Settings section that waits on the agent. A cold or busy
 * agent can take until the 30 s request timeout to answer, and a bare
 * "Loading…" that long reads as broken, so after SLOW_AGENT_MS it says what
 * is happening. Remount it (or stop rendering it) to restart the clock.
 */
export function SlowLoading({ className = 'text-[12px] text-[var(--ca-ink-muted)]' }: { className?: string }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_AGENT_MS)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <p className={className} role="status" aria-live="polite">
      {slow ? 'Still waiting for your agent. It may be starting up, which can take a minute.' : 'Loading…'}
    </p>
  )
}
