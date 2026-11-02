import { useEffect, useRef } from 'react'
import { takeDueLocalRoutines, type Routine } from './routines'

/** Longest single wait, so a sleeping machine or clock change is noticed. */
export const SCHEDULER_MAX_WAIT_MS = 30_000

/** One firing of a job: the same job at a new `nextRunAt` is a new occurrence. */
function occurrenceKey(job: Routine): string {
  return `${job.id}@${job.nextRunAt ?? ''}`
}

function isSchedulable(j: Routine): boolean {
  return (
    j.origin === 'local' &&
    j.enabled &&
    j.prompt.trim() !== '' &&
    !!j.nextRunAt &&
    Number.isFinite(Date.parse(j.nextRunAt))
  )
}

/**
 * Fires client-side (`local`) routines while the app is open. VM and host
 * Hermes jobs have their own schedulers and are ignored here.
 *
 * No timer at all unless an enabled local job exists. When jobs exist, arm a
 * one-shot timeout for the earliest `nextRunAt` (capped at 30s) and re-arm
 * after each fire, so idle gaps cost zero wakeups.
 *
 * Each occurrence is claimed before `fire` runs: `nextRunAt` only advances
 * once the caller marks the run, which is after the prompt is sent (or never,
 * if sending throws), and re-arming on a still-due job would otherwise fire
 * it again every 0ms until then.
 */
export function useLocalRoutineScheduler(
  jobs: Routine[],
  fire: (job: Routine) => void | Promise<void>,
): void {
  const fireRef = useRef(fire)
  fireRef.current = fire
  const claimed = useRef(new Set<string>())

  useEffect(() => {
    const live = new Set(jobs.map(occurrenceKey))
    for (const key of claimed.current) if (!live.has(key)) claimed.current.delete(key)

    const pending = () => jobs.filter((j) => isSchedulable(j) && !claimed.current.has(occurrenceKey(j)))
    if (pending().length === 0) return
    let cancelled = false
    let timer = 0
    const arm = () => {
      if (cancelled) return
      const waiting = pending()
      if (waiting.length === 0) return
      const now = Date.now()
      let delay = SCHEDULER_MAX_WAIT_MS
      for (const j of waiting) delay = Math.min(delay, Math.max(0, Date.parse(j.nextRunAt!) - now))
      timer = window.setTimeout(tick, delay)
    }
    const tick = () => {
      if (cancelled) return
      for (const job of takeDueLocalRoutines(jobs)) {
        const key = occurrenceKey(job)
        if (claimed.current.has(key)) continue
        claimed.current.add(key)
        void Promise.resolve()
          .then(() => fireRef.current(job))
          .catch(() => {
            /* the caller surfaces failures; the claim stops a retry storm */
          })
      }
      arm()
    }
    arm()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [jobs])
}
