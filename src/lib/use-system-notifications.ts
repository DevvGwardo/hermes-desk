/**
 * What taps the reader on the shoulder when the app is not in front
 * (lib/system-notify.ts posts; it stays quiet while the app is in front):
 *
 * - a reply finished (or failed) — any conversation, the open one included
 *   when the window is in the background;
 * - the agent is waiting on an approval;
 * - a routine that keeps its results in the app ("Only in Nub Agent") ran —
 *   the notification carries what it found; a run with nothing to report
 *   ([SILENT]) stays quiet. Routines that post to Telegram etc. already reach
 *   the reader there.
 *
 * Each also lands in the bell (routines and approvals always, replies when
 * you were away), so a dismissed popup isn't lost.
 *
 * A reply that posted no notification (app in front, or notifications off)
 * gets the in-app cue instead (lib/ui-sounds.ts): the OS already sounds for
 * a posted one, so the two never double up.
 */
import { useEffect, useRef } from 'react'
import { getState, onReplySettled } from './agents/store'
import { getPendingToolPermission, subscribePendingToolPermission } from './agents/tool-permission'
import { extractReplyMedia } from './reply-media'
import { listServeCronJobs, type ServeCronJob } from './hermes-rest'
import { displayRoutineName } from './routines'
import { listRoutineRuns, LOCAL_DELIVERY, readRunOutput, SILENT_RUN_TEXT, splitSilence } from './routine-cron'
import { notify, onNotificationClick, previewText, type NotifyTarget } from './system-notify'
import { addAppNotification } from './notifications'
import { claimCue, installUiSoundUnlock, playUiSound, takeTurnStopped, turnCue } from './ui-sounds'
import type { HermesLocalTransport, LocalTransportEvent } from './agents/hermes-local-transport'
import { shouldNotify } from './agents/roster'

export function notifyLocalEvent(event: LocalTransportEvent, seen: Set<string>, policy = shouldNotify): void {
  let conversationId: string
  let id: string
  let title: string
  let body: string
  let kind: 'approval' | 'clarify' | 'reply'
  if (event.type === 'permission' && event.ask?.status === 'pending' && policy({ kind: 'approval' })) {
    conversationId = event.conversationId; id = `approval:${event.ask.id}`
    title = 'Approval needed'; body = 'Your agent needs your OK. Open the chat to review.'; kind = 'approval'
  } else if (event.type === 'clarify' && event.prompt && policy({ kind: 'clarify' })) {
    conversationId = event.conversationId; id = `clarify:${event.prompt.requestId}`
    title = 'Your agent has a question'; body = 'Open the chat to answer.'; kind = 'clarify'
  } else if (event.type === 'turn' && event.turn.phase === 'done' && event.turn.finishedAt &&
    policy({ kind: 'finished', startedAt: event.turn.startedAt, finishedAt: event.turn.finishedAt,
      windowFocused: document.visibilityState === 'visible' && document.hasFocus() })) {
    conversationId = event.turn.threadId; id = `finished:${event.turn.id}`
    title = 'Run finished'; body = 'Your agent finished its run. Open the chat to read the result.'; kind = 'reply'
  } else return
  if (seen.has(id)) return
  seen.add(id)
  if (seen.size > 200) seen.delete(seen.values().next().value!)
  const state = getState()
  const conversation = state.conversations.find(c => c.id === conversationId)
  const agentId = conversation?.target.type === 'agent' ? conversation.target.agentId : undefined
  const name = state.agents.find(agent => agent.id === agentId)?.name
  if (name) title = `${name}: ${title}`
  const target = { kind: 'conversation', id: conversationId } as const
  void notify({ title, body, target, tag: id })
  addAppNotification({ id, source: 'app', kind, title, body, target })
}

/** How often linked routines are checked for a new run. */
export const ROUTINE_POLL_MS = 3 * 60_000

function conversationLabel(threadId: string, agentId?: string): string {
  const s = getState()
  const conv = s.conversations.find((c) => c.id === threadId)
  const agent = agentId ? s.agents.find((a) => a.id === agentId) : undefined
  return agent?.name || conv?.title || 'Nub Agent'
}

/** Pure: which jobs ran since `seen`, and the new baseline. The first look
 *  (empty baseline) only records, so opening the app never replays history. */
export function routinesThatRan(
  jobs: ServeCronJob[],
  seen: Map<string, string> | null,
): { ran: ServeCronJob[]; next: Map<string, string> } {
  const next = new Map<string, string>()
  const ran: ServeCronJob[] = []
  for (const job of jobs) {
    const id = typeof job.id === 'string' ? job.id : ''
    const last = typeof job.last_run_at === 'string' ? job.last_run_at : ''
    if (!id) continue
    next.set(id, last)
    if (!seen || !last || seen.get(id) === last) continue
    const deliver = typeof job.deliver === 'string' && job.deliver ? job.deliver : LOCAL_DELIVERY
    if (deliver === LOCAL_DELIVERY) ran.push(job)
  }
  return { ran, next }
}

export function useSystemNotifications({
  linked,
  onOpenConversation,
  onOpenRoutine,
  local = false,
  transport,
  policy = shouldNotify,
}: {
  linked: boolean
  onOpenConversation: (conversationId: string) => void
  onOpenRoutine?: (jobId?: string) => void
  local?: boolean
  transport?: HermesLocalTransport | null
  policy?: typeof shouldNotify
}): void {
  const handlers = useRef({ onOpenConversation, onOpenRoutine })
  handlers.current = { onOpenConversation, onOpenRoutine }
  const seen = useRef(new Set<string>())
  useEffect(() => transport?.subscribeLocal(event => notifyLocalEvent(event, seen.current, policy)), [transport, policy])

  // Clicks: open what the notification was about.
  useEffect(
    () =>
      onNotificationClick((target: NotifyTarget | null) => {
        if (!target) return
        if (target.kind === 'conversation') handlers.current.onOpenConversation(target.id)
        else handlers.current.onOpenRoutine?.(target.id)
      }),
    [],
  )

  // Replies.
  useEffect(() => installUiSoundUnlock(), [])
  useEffect(
    () => {
      if (local) return
      return onReplySettled(({ threadId, message }) => {
        const stopped = takeTurnStopped(threadId)
        const title = conversationLabel(threadId, message.fromAgentId)
        const text = previewText(extractReplyMedia(message.content ?? '').text)
        const body = message.error ? 'Couldn’t finish that reply. Open the chat to retry.' : text || 'Replied.'
        const target = { kind: 'conversation', id: threadId } as const
        void notify({ title, body, target, tag: `reply:${message.id}` }).then((shown) => {
          // A reply you were away for (or one that failed) stays findable in
          // the bell; one you watched arrive doesn't need to.
          if (shown || message.error) {
            addAppNotification({ id: `reply:${message.id}`, source: 'app', kind: 'reply', title, body, target })
          }
          if (shown) return
          const started = Date.parse(message.createdAt)
          const cue = turnCue({
            lastRole: message.error ? 'error' : 'assistant',
            stoppedByUser: stopped,
            queued: false,
            elapsedMs: Number.isFinite(started) ? Date.now() - started : 0,
            away: document.hidden || !document.hasFocus(),
          })
          if (cue && claimCue(`${threadId}:${message.id}`)) playUiSound(cue)
        })
      })
    },
    [local],
  )

  // Approvals.
  useEffect(() => {
    if (local) return
    let lastId: string | null = getPendingToolPermission()?.id ?? null
    return subscribePendingToolPermission(() => {
      const ask = getPendingToolPermission()
      if (!ask || ask.id === lastId) {
        lastId = ask?.id ?? null
        return
      }
      lastId = ask.id
      const what = previewText(ask.description || ask.command || 'An action', 120)
      const title = `${conversationLabel(ask.conversationId)} needs your OK`
      const target = { kind: 'conversation', id: ask.conversationId } as const
      void notify({ title, body: what, target, tag: `approval:${ask.id}` })
      addAppNotification({ id: `approval:${ask.id}`, source: 'app', kind: 'approval', title, body: what, target })
    })
  }, [local])

  // Routines that keep their results in the app.
  useEffect(() => {
    if (!linked) return
    let alive = true
    let seen: Map<string, string> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      const jobs = await listServeCronJobs().catch(() => null)
      if (!alive) return
      if (jobs) {
        const { ran, next } = routinesThatRan(jobs, seen)
        seen = next
        for (const job of ran) {
          const id = String(job.id)
          const runs = await listRoutineRuns(id, 1).catch(() => null)
          if (!alive) return
          const last = runs?.kind === 'ok' ? runs.value[0] : undefined
          const failed = last?.status === 'failed'
          // The routine's own answer is the notification: what it found,
          // not "it ran". A run with nothing to report stays quiet.
          const output = last && !failed ? await readRunOutput(last.id, last.profile).catch(() => null) : null
          if (!alive) return
          if (output === SILENT_RUN_TEXT || (output && splitSilence(output).silent)) continue
          const title = `Routine: ${displayRoutineName({ name: typeof job.name === 'string' ? job.name : '', id: String(job.id) })}`
          const body = failed
            ? 'It didn’t finish. Open it to see why.'
            : output
              ? previewText(output, 220)
              : 'It ran. Open it to read the result.'
          const target = { kind: 'routines', id } as const
          const key = `routine:${id}:${String(job.last_run_at)}`
          void notify({ title, body, target, tag: key })
          addAppNotification({ id: key, source: 'app', kind: 'routine', title, body, target, runId: last?.id, runProfile: last?.profile })
        }
      }
      timer = setTimeout(() => void check(), ROUTINE_POLL_MS)
    }
    void check()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [linked])
}
