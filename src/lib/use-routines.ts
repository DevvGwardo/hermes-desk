/**
 * Routine state shared by both shells: the desktop/web App and the phone
 * shell (MobileApp) render the same Routines page and editor, so they must
 * read and write the same cache the same way.
 *
 * Owns the list (`routines`, the loading/unavailable status the palette
 * reads, and `cache`, the plain array every view lists), whether the linked
 * agent's scheduler answered, and every write: save, delete, pause/resume,
 * run now. Local drafts fire from here too (useLocalRoutineScheduler) while
 * the app is open. When to refresh, and which screen is showing, stay with
 * the shell.
 */
import { useCallback, useState } from 'react'
import { getState } from './agents'
import { getActiveTransport } from './agents/active-transport'
import type { ThreadRef } from './agents'
import { maybeApplyAvatarIntent } from './avatar-intent'
import {
  loadRoutines,
  markLocalRun,
  removeRoutine,
  routineDraftOf,
  sameRoutine,
  setRoutineEnabled,
  testRunRemote,
  upsertRoutine,
  type Routine,
  type RoutineDraft,
} from './routines'
import { useLocalRoutineScheduler } from './use-local-routine-scheduler'

export type RoutinesStatus = Routine[] | 'loading' | 'unavailable'

export interface UseRoutinesOptions {
  /** Open (or create) the chat for a target — a local routine runs there. */
  openWithTarget: (target: ThreadRef) => void
  /** Fallback agent when a local routine names none. */
  selectedAgentId?: string | null
}

export function useRoutines({ openWithTarget, selectedAgentId }: UseRoutinesOptions) {
  const [routines, setRoutines] = useState<RoutinesStatus>('loading')
  const [cache, setCache] = useState<Routine[]>([])
  /** The linked agent's scheduler didn't answer on the last load. */
  const [unreachable, setUnreachable] = useState(false)

  const refresh = useCallback(async () => {
    setRoutines('loading')
    const { jobs, source } = await loadRoutines()
    setCache(jobs)
    setUnreachable(source === 'unreachable')
    if ((source === 'local' || source === 'unreachable') && jobs.length === 0) setRoutines('unavailable')
    else setRoutines(jobs)
  }, [])

  /** Test run / run now: agent and host jobs start where they live; a local
   *  draft is sent to its agent in chat. */
  const firePrompt = useCallback(
    async (draft: RoutineDraft, job?: Routine | null) => {
      const prompt = draft.prompt.trim()
      if (job && (await testRunRemote(job))) {
        await refresh()
        return
      }
      if (!prompt) throw new Error('Add an instruction before running this routine.')
      const agentId = draft.agentId || job?.agentId || selectedAgentId
      if (agentId) openWithTarget({ type: 'agent', agentId })
      const state = getState()
      const conv =
        state.conversations.find((c) => c.id === state.selectedConversationId) ??
        state.conversations.find((c) => c.target.type === 'agent' && c.target.agentId === agentId)
      if (!conv) throw new Error('Pick an agent first, then test run.')
      if (agentId) maybeApplyAvatarIntent(agentId, prompt, conv.id)
      const { transport } = await getActiveTransport()
      await transport.sendMessage(conv, prompt)
      if (job?.origin === 'local') {
        setCache((prev) => prev.map((j) => (sameRoutine(j, job) ? markLocalRun(j) : j)))
      }
    },
    [openWithTarget, selectedAgentId, refresh],
  )

  const save = useCallback(async (draft: RoutineDraft, existing: Routine | null) => {
    const saved = await upsertRoutine(draft, existing)
    setCache((prev) => {
      const next = prev.some((j) => sameRoutine(j, saved))
        ? prev.map((j) => (sameRoutine(j, saved) ? saved : j))
        : [saved, ...prev]
      setRoutines(next)
      return next
    })
    return saved
  }, [])

  const remove = useCallback(async (job: Routine) => {
    await removeRoutine(job)
    setCache((prev) => {
      const next = prev.filter((j) => !sameRoutine(j, job))
      setRoutines(next.length === 0 ? 'unavailable' : next)
      return next
    })
  }, [])

  /** Pause / resume in place without rewriting a backend job's content. */
  const toggle = useCallback(
    async (job: Routine, enabled: boolean) => {
      const saved = await setRoutineEnabled(job, enabled)
      setCache((prev) => {
        const next = prev.map((j) => (sameRoutine(j, job) ? saved : j))
        setRoutines(next)
        return next
      })
      // The scheduler recomputes the next run on resume; read it back so the
      // row doesn't lose its "Next …" until the next refresh.
      if (job.origin !== 'local') void refresh()
    },
    [refresh],
  )

  const fireScheduled = useCallback(
    async (job: Routine) => {
      try {
        await firePrompt(routineDraftOf(job), job)
      } catch (err) {
        // A failed send still consumes this occurrence (firePrompt only
        // marks runs that sent), so the job waits for its next slot.
        setCache((prev) => prev.map((j) => (sameRoutine(j, job) ? markLocalRun(j) : j)))
        throw err
      }
    },
    [firePrompt],
  )

  useLocalRoutineScheduler(cache, fireScheduled)

  return { routines, cache, unreachable, refresh, firePrompt, save, remove, toggle }
}
