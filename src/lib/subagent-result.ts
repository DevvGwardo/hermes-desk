/**
 * Pick a specialist body worth handing to the parent (Grok CheckSubagent).
 * Queue status lines and mock fillers are not a flight answer.
 */

import type { SubagentRun } from './agents/types'

export function isPlaceholderResult(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^Task t-\S+ (completed|failed|cancelled)/i.test(t)) return true
  if (/^\(local demo\)/i.test(t)) return true
  if (/^Working \(/i.test(t)) return true
  if (/^Finishing \w+ pass/i.test(t)) return true
  if (/^Specialist finished\.?$/i.test(t)) return true
  if (/Specialist did not report back/i.test(t)) return true
  if (/^Waiting for specialist/i.test(t)) return true
  if (/^No summary from specialist/i.test(t)) return true
  if (/^Specialist returned no summary/i.test(t)) return true
  if (/^Specialist timed out/i.test(t)) return true
  return false
}

export function usableSubagentBody(run: SubagentRun): string {
  const candidates = [
    run.error,
    run.result?.summary,
    ...[...run.digests].reverse().map((d) => d.text),
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)

  const real = candidates.find((s) => !isPlaceholderResult(s))
  return (real ?? candidates[0] ?? '(no result)').trim()
}
