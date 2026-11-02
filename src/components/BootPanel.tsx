import { useEffect, useState, type CSSProperties } from 'react'
import { FatCatIcon } from './FatCatIcon'

/** m:ss elapsed clock for boot/waiting surfaces. Shared with MobileSyncing. */
export function formatBootElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Reassurance copy kicks in at 12s; agency (retry) at 45s. */
export const BOOT_SLOW_MS = 12_000
export const BOOT_VERY_SLOW_MS = 45_000

/**
 * Post-sign-in boot surface. Replaces the chat pane while the first roster +
 * conversation hydrate are in flight (first-ever sign-in has no cached
 * roster, and the SSH-backed roster fetch can take tens of seconds).
 *
 * The store only exposes two binary flags, so progress is an honest staged
 * checklist (connect → sync) plus a live elapsed clock — never a fake
 * percentage. Tiered slow messaging sets expectations at 12s and offers
 * agency (retry) at 45s instead of leaving a silent skeleton.
 */
export function BootPanel(props: {
  rosterHydrating: boolean
  conversationsHydrating: boolean
  rosterHydrateError?: string | null
  onRetryRoster?: () => void
}) {
  const rosterDone = !props.rosterHydrating
  const conversationsDone = !props.conversationsHydrating
  const [mountedAt] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(mountedAt)
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsedMs = nowMs - mountedAt
  const slow = elapsedMs >= BOOT_SLOW_MS
  const verySlow = elapsedMs >= BOOT_VERY_SLOW_MS

  const title = rosterDone ? 'Syncing your conversations…' : 'Waking your agent…'
  const detail = rosterDone
    ? 'Your agents are here — pulling your threads from the VM.'
    : 'Connecting to your private VM and loading your workspace.'
  const done = rosterDone && conversationsDone

  const stages: Array<{ label: string; state: 'done' | 'active' | 'pending' }> = [
    { label: 'Connect to your agent', state: rosterDone ? 'done' : 'active' },
    {
      label: 'Sync your conversations',
      state: !rosterDone ? 'pending' : conversationsDone ? 'done' : 'active',
    },
  ]

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col items-center justify-center px-6"
      aria-busy={!done}
      data-testid="boot-panel"
    >
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        {/* Same intro as the web pairing screen (WebConnect): the bare Grok
            orb in its `loading` whirl, then the copy and progress entering
            beneath it (.ca-enter, --i). */}
        <div className="ca-enter">
          <FatCatIcon expression="loading" size={88} title="Nub" />
        </div>
        {/* Single live region for stage changes — the clock and checklist below
            are aria-hidden so screen readers aren't chattered at every tick. */}
        <h2
          className="ca-enter mt-5 text-[15px] font-semibold text-[var(--ca-ink)]"
          style={{ '--i': 1 } as CSSProperties}
          aria-live="polite"
        >
          {/* Keyed: each stage title crossfades in rather than snapping. */}
          <span key={done ? 'done' : title} className="ca-fade inline-block">
            {done ? 'Almost ready…' : title}
          </span>
        </h2>
        <p
          key={done ? 'done' : detail}
          className="ca-fade mt-1 text-[13px] leading-relaxed text-[var(--ca-ink-muted)]"
        >
          {done ? 'Finishing up your workspace.' : detail}
        </p>

        {!done && !props.rosterHydrateError ? (
          <ul className="ca-enter mt-4 space-y-1" style={{ '--i': 2 } as CSSProperties} aria-hidden="true">
            {stages.map((s) => (
              <li
                key={s.label}
                className={
                  s.state === 'done'
                    ? 'flex items-center justify-center gap-2 text-[12px] text-[var(--ca-ink-muted)] line-through'
                    : s.state === 'active'
                      ? 'flex items-center justify-center gap-2 text-[12px] font-medium text-[var(--ca-ink)]'
                      : 'flex items-center justify-center gap-2 text-[12px] text-[var(--ca-ink-muted)] opacity-60'
                }
              >
                <span key={s.state} className="ca-fade w-4 shrink-0 text-center">
                  {s.state === 'done' ? '✓' : s.state === 'active' ? '→' : '○'}
                </span>
                <span>{s.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {props.rosterHydrateError ? (
          <div
            role="alert"
            className="mt-4 w-full rounded-[var(--ca-radius-sm)] border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ca-ink)]"
          >
            <p>{props.rosterHydrateError}</p>
            {props.onRetryRoster && (
              <button
                type="button"
                onClick={props.onRetryRoster}
                className="mt-1 font-medium text-[var(--ca-primary-text)] hover:underline"
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Shimmer bar: highlight sweeps across the track. The
                nub-boot-shimmer hook silences it under prefers-reduced-motion
                (the generic .skeleton-shine guard can't see inline styles). */}
            <div
              className="ca-enter mt-5 h-1.5 w-44 overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--ca-border)', '--i': 3 } as CSSProperties}
              aria-hidden="true"
            >
              <div
                className="nub-boot-shimmer h-full w-full rounded-full"
                style={{
                  backgroundImage:
                    'linear-gradient(100deg, transparent 20%, var(--ca-primary) 50%, transparent 80%)',
                  backgroundSize: '200% 100%',
                  animation: 'skeleton-shine 1.6s ease-in-out infinite',
                }}
              />
            </div>
            <p
              className="mt-3 font-mono text-[11px] tabular-nums text-[var(--ca-ink-muted)]"
              aria-hidden="true"
            >
              Waiting {formatBootElapsed(elapsedMs)}
            </p>
            <div
              className="mt-1 min-h-4 text-[11px] text-[var(--ca-ink-muted)]"
              style={{ opacity: slow ? 1 : 0, transition: 'opacity var(--ca-dur-3) var(--ca-ease)' }}
            >
              {verySlow ? (
                <p>
                  Still working — this is taking longer than usual.{' '}
                  {props.onRetryRoster && (
                    <button
                      type="button"
                      onClick={props.onRetryRoster}
                      className="font-medium text-[var(--ca-primary-text)] hover:underline"
                    >
                      Retry now
                    </button>
                  )}
                </p>
              ) : (
                <p>First connection can take up to a minute — your agents are on their way.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
