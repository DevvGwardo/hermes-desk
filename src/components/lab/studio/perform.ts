import type { CatExpression } from '../../FatCatIcon'
import type { OrbSeg } from './types'

/** Perform-to-record: while performing, keys 1-9 push {t, state} events.
 *  Commits to orb segments partitioning [firstEvent, endT): each press
 *  closes the previous seg at now and opens the next. Last event extends
 *  to endT; empty events → []. Ids are deterministic (perf-N); callers
 *  remap to uid() on commit. */
export function performTake(
  events: { t: number; state: CatExpression }[],
  endT: number,
): OrbSeg[] {
  if (!events.length) return []
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const out: OrbSeg[] = []
  sorted.forEach((e, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].t : endT
    const dur = end - e.t
    if (dur > 0) out.push({ id: `perf-${i}`, start: e.t, dur, state: e.state })
  })
  return out
}
