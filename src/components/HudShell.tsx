/**
 * HudShell — chrome-free floating chat for ?win=hud.
 *
 * Inherits hermes-agent's HUD contract:
 * - Same renderer, same store, same session as the main window — the composer
 *   here IS the app's composer (same session id, same backend). Only the frame
 *   changes.
 * - surface: "hud" on every prompt.submit (via src/lib/hud.ts) so the server
 *   prepends hud_surface_note to the model input. See hermes-agent:
 *   tui_gateway/methods_prompt.py (client_surface) + agent/prompt_builder.py.
 * - Spotlight shape: at rest just the composer bar; transcript fades in on
 *   activity/focus (recent + busy/awaiting), mirrored from hermes HudShell.
 * - Orb idle state: when the strip is unfocused AND idle it collapses to the
 *   Pip (agent palette). The window itself shrinks to the mascot via
 *   nubAgent.hud.setCollapsed so the strip rectangle stops catching clicks.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { getActiveTransport } from '../lib/agents/active-transport'
import { getMessagesForConversation, getState, subscribe } from '../lib/agents/store'
import { maybeApplyAvatarIntent } from '../lib/avatar-intent'
import { isHudWindow } from '../lib/hud'
import type { ChatMessage } from '../lib/agents/types'
import { AgentMascot, agentColor, type AgentMascotPresence } from './AgentMascot'
import { AgentPromptDock, useWaitingOnUserText } from './AgentPromptDock'
import { DictateEngine, appendTranscript, initialDictateStatus } from '../lib/dictate'
import { sttStatus, transcribeAudio } from '../lib/stt'
import type { DictateStatus } from '../lib/dictate'
import {
  POINT_RE,
  POINT_ONCE_RE,
  TYPE_RE,
  TYPE_ONCE_RE,
  CLICK_RE,
  CLICK_ONCE_RE,
  describeActMarker,
} from '../lib/hud-protocol'
import {
  mapSightPoint,
  seeErrorCopy,
  seeErrorNeedsPermission,
  sightInfo,
  type HudCapture,
  type HudSeeResult,
} from '../lib/hud-sight'
import { hudBadge, type HudActivity, type HudActivityEvent } from '../lib/hud-activity'

const RECENT_HOLD_MS = 3500

/* Clicky point protocol: an agent reply may carry [POINT:x,y(:label)?] — the
 * cat flies to that screen point (moveTo + the pointer pulse is the cursor
 * overlay). The markers live in src/lib/hud-protocol.ts next to the note that
 * teaches them to the model, so the two cannot drift apart. */

/** Strip Clicky act/point markers ([POINT:x,y:l], [TYPE:t], [CLICK:x,y]) from
 *  display — they are instructions to the cat, never prose for the user. */
function stripMarkers(text: string): string {
  return text
    .replace(POINT_RE, '')
    .replace(CLICK_RE, '')
    .replace(TYPE_RE, '')
    // Anchored at the run's start: an unanchored `[ \t]+\n` rescans long blank runs.
    .replace(/(?<![ \t])[ \t]+\n/g, '\n')
    .trim()
}

/**
 * Acting (click/type) needs macOS Accessibility, and a blocked input event is
 * invisible: osascript exits 0 whether the click landed or was dropped. So we
 * ask main once and, when the answer is a hard no, say so instead of nodding
 * along. `null` = unknown (no bridge) = behave as before and try.
 */
type ActStatus = { trusted?: boolean; available?: boolean; backend?: string | null } | null

type HudBridge = {
  see?: (mode: 'screen' | 'region') => Promise<HudSeeResult>
  openScreenPermission?: () => Promise<unknown>
  getActivity?: () => Promise<HudActivity | null>
  onActivity?: (cb: (v: HudActivity | null) => void) => (() => void) | void
  openConversation?: (conversationId: string) => Promise<unknown>
}

function hudBridge(): HudBridge | undefined {
  return (window as unknown as { nubAgent?: { hud?: HudBridge } }).nubAgent?.hud
}

/** Finished-turn keys the user has already seen on the cat (per device). */
const SEEN_KEY = 'nub:hud:seenActivity'
const SEEN_MAX = 60

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {}
}

function useHudMessages(): ChatMessage[] {
  const [msgs, setMsgs] = useState<ChatMessage[]>(() => {
    if (!isHudWindow()) return []
    const s = getState()
    const id = s.selectedConversationId
    return id ? getMessagesForConversation(id) : []
  })
  useEffect(() => {
    if (!isHudWindow()) return
    const unsub = subscribe(() => {
      const s = getState()
      const id = s.selectedConversationId
      setMsgs(id ? getMessagesForConversation(id) : [])
    })
    return unsub
  }, [])
  return msgs
}

function selectedHudAgent() {
  const state = getState()
  const target = state.conversations.find(c => c.id === state.selectedConversationId)?.target
  const id = target?.type === 'agent' ? target.agentId
    : target?.type === 'group' ? state.groups.find(g => g.id === target.groupId)?.primaryAgentId
    : undefined
  return state.agents.find(agent => agent.id === id) ?? state.agents[0] ?? null
}

type HudDragBridge = {
  dragStart?: () => Promise<unknown>
  dragMove?: () => Promise<unknown>
  dragEnd?: () => Promise<unknown>
}

/** Screen px the pointer must travel before a press on the cat becomes a drag. */
const DRAG_THRESHOLD_PX = 4

/**
 * Drag the HUD window by the cat. The cat is a button (clickable, so not an
 * app-region drag), so presses are tracked here and main moves the window by
 * the cursor delta. A press that travels less than DRAG_THRESHOLD_PX is still
 * a click; after a real drag the next click is swallowed.
 */
function useHudDrag() {
  const drag = useRef<{ x: number; y: number; moved: boolean; raf: number | null } | null>(null)
  const swallowClick = useRef(false)
  const bridge = () =>
    (window as unknown as { nubAgent?: { hud?: HudDragBridge } }).nubAgent?.hud

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.altKey || !bridge()?.dragStart) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.screenX, y: e.screenY, moved: false, raf: null }
    swallowClick.current = false
    void bridge()?.dragStart?.()
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.screenX - d.x, e.screenY - d.y) < DRAG_THRESHOLD_PX) return
    d.moved = true
    if (d.raf !== null) return
    d.raf = requestAnimationFrame(() => {
      if (drag.current) drag.current.raf = null
      void bridge()?.dragMove?.()
    })
  }
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    if (d.raf !== null) cancelAnimationFrame(d.raf)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    swallowClick.current = d.moved
    drag.current = null
    void bridge()?.dragEnd?.()
  }
  /** True once per finished drag: the click that ends a drag is not a tap. */
  const consumeDragClick = () => {
    const was = swallowClick.current
    swallowClick.current = false
    return was
  }
  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    consumeDragClick,
  }
}

export function HudShell() {
  const orbDrag = useHudDrag()
  const mascotDrag = useHudDrag()
  const messages = useHudMessages()
  // The HUD runs its own turns, so a question / key / plugin card the agent
  // raises mid-turn lands in THIS window — it must be shown here, or the agent
  // waits on a card nobody can see while the cat keeps "thinking".
  const hudConversationId = isHudWindow() ? getState().selectedConversationId : null
  const waitingOnUser = useWaitingOnUserText(hudConversationId, false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recent, setRecent] = useState(false)
  const [focused, setFocused] = useState(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true,
  )
  const [walking, setWalking] = useState(false)
  const [pointer, setPointer] = useState<{ phase: 'walk' | 'point'; angle: number } | null>(null)
  const [pointLabel, setPointLabel] = useState('')
  const [actStatus, setActStatus] = useState<ActStatus>(null)
  const [actLoaded, setActLoaded] = useState(false)
  const [actBlocked, setActBlocked] = useState(false)
  const [dictateStatus, setDictateStatus] = useState<DictateStatus>(initialDictateStatus)
  // SEE: a capture waiting to ride the next send, and the one the CURRENT
  // exchange was sent with (its geometry maps the reply's coordinates).
  const [capture, setCapture] = useState<HudCapture | null>(null)
  const [seeBusy, setSeeBusy] = useState<'screen' | 'region' | null>(null)
  const [seeError, setSeeError] = useState<{ copy: string; permission: boolean } | null>(null)
  const [actRefused, setActRefused] = useState<string | null>(null)
  const sightRef = useRef<HudCapture | null>(null)
  // Badge: what the main window says the agents are doing + what we've shown.
  const [activity, setActivity] = useState<HudActivity | null>(null)
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen())
  const [card, setCard] = useState<HudActivityEvent | null>(null)
  // Act markers only fire for replies that arrive while this HUD is open —
  // never for a stale reply sitting in the transcript when the HUD boots.
  const mountedAt = useRef(Date.now())
  const dictateRef = useRef<DictateEngine | null>(null)
  const dictateHoldRef = useRef(false)
  const recentTimer = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const visibleMessages = useMemo(() => {
    const tail = messages.slice(-8)
    return tail.filter((m) => m.role === 'user' || m.role === 'agent')
  }, [messages])

  const bumpRecent = () => {
    setRecent(true)
    if (recentTimer.current) window.clearTimeout(recentTimer.current)
    recentTimer.current = window.setTimeout(() => setRecent(false), RECENT_HOLD_MS)
  }

  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      // Mascot-widget open: an unfocused open IS the cat. Skip the bump so
      // there is no strip flash — the orb renders from the first frame.
      if (!document.hasFocus()) return
    }
    bumpRecent()
  }, [messages.length])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visibleMessages])

  useEffect(() => {
    const onFocus = () => {
      setFocused(true)
      bumpRecent()
    }
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Never collapse while the user could be typing: only when unfocused AND idle.
  // A pending capture or an in-flight look keeps the bubble open: the region
  // picker steals focus, and the user still has to ask their question.
  const collapsed = !focused && !recent && !seeBusy && !capture && !waitingOnUser

  // Main tells us when the cat is walking a commanded path (bob) and where
  // the pointer aims (moveTo/gestureAt target direction).
  useEffect(() => {
    const bridge = (
      window as unknown as {
        nubAgent?: { hud?: { onPointer?: (cb: (v: { phase: string; angle: number }) => void) => (() => void) | void } }
      }
    ).nubAgent?.hud
    const off = bridge?.onPointer?.((v) => {
      if (v && (v.phase === 'walk' || v.phase === 'point')) {
        setWalking(v.phase === 'walk')
        setPointer({ phase: v.phase, angle: Number(v.angle) || 0 })
      } else {
        setWalking(false)
        setPointer(null)
        setPointLabel('')
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  // Tell the main process to shrink/restore the window rectangle. Collapsed,
  // the strip would otherwise float as an invisible 620x340 click-catcher.
  useEffect(() => {
    const bridge = (window as unknown as { nubAgent?: { hud?: { setCollapsed?: (c: boolean) => void } } }).nubAgent?.hud
    try {
      bridge?.setCollapsed?.(collapsed)
    } catch {
      /* browser preview: no bridge, cosmetic-only collapse */
    }
  }, [collapsed])

  // Selection and profile edits can change without changing the message count.
  const mascotAgent = useSyncExternalStore(subscribe, selectedHudAgent, () => null)
  const mascotAgentId = mascotAgent?.id ?? ''
  const mascotColor = agentColor(mascotAgent)

  // Click-through: transparent HUD areas never steal clicks from the apps
  // behind them (Clicky-class pets are felt, not framed). The renderer
  // hit-tests mouseover; solid elements (bubble, cat, inputs) stay interactive.
  useEffect(() => {
    const hud = (
      window as unknown as { nubAgent?: { hud?: { setClickThrough?: (v: boolean) => void } } }
    ).nubAgent?.hud
    if (!hud?.setClickThrough) return
    const isSolid = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest('button,input,.hud-bubble,.hud-orb,[data-hud-solid]'))
    const onOver = (e: MouseEvent) => hud.setClickThrough?.(!isSolid(e.target))
    document.addEventListener('mouseover', onOver, true)
    hud.setClickThrough?.(false)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      hud.setClickThrough?.(false)
    }
  }, [])

  // Clicky act protocol — ONE effect, priority CLICK > TYPE > POINT, one key.
  // The latest agent reply is read once: a CLICK fires clickAt, else a TYPE
  // fires typeText, else a POINT flies the cat (moveTo + caption). POINT is
  // skipped whenever the same reply carries an act marker — the arrival walk
  // for the act already points at the target, so a separate POINT flight
  // would yank the cat away mid-act. Once per marker via a single key.
  // (Merged from lastPointKey + lastTypeKey + lastClickKey, which could fire
  // POINT and an act from the same reply in the same tick.)
  const lastActKey = useRef<string | null>(null) // was lastClickKey + lastTypeKey + lastPointKey, merged
  useEffect(() => {
    const last = [...visibleMessages].reverse().find((m) => m.role === 'agent')
    if (!last) return
    // A reply that predates this HUD session is history, not an instruction:
    // re-opening the cat must never replay an old click.
    const born = Date.parse(last.createdAt)
    if (Number.isFinite(born) && born < mountedAt.current) return
    // Coordinates in a reply to a screenshot turn are SCREENSHOT PIXELS; map
    // them to screen points. Outside the image (or a stale capture) = refuse.
    const sight = sightRef.current
    const toScreen = (x: number, y: number) => (sight ? mapSightPoint(sight, x, y) : { x, y })
    // Act markers wait for the probe; POINT is display-only and fires ungated.
    const body = last.content || ''
    const click = CLICK_ONCE_RE.exec(body)
    if (click) {
      if (!actLoaded) return
      const m = click
      const key = last.id + ':click:' + m[1] + ',' + m[2]
      if (lastActKey.current === key) return
      lastActKey.current = key
      if (actIsBlocked()) {
        setActBlocked(true)
        return
      }
      const pt = toScreen(Number(m[1]), Number(m[2]))
      if (!pt) {
        setActRefused("I didn't click — that spot is outside what I can see. Show me again?")
        return
      }
      const hud = (window as unknown as { nubAgent?: { hud?: { clickAt?: (x: number, y: number) => void } } }).nubAgent?.hud
      void hud?.clickAt?.(pt.x, pt.y)
      return
    }
    const type = TYPE_ONCE_RE.exec(body)
    if (type) {
      if (!actLoaded) return
      const m = type
      const key = last.id + ':type:' + m[1]
      if (lastActKey.current === key) return
      lastActKey.current = key
      if (actIsBlocked()) {
        setActBlocked(true)
        return
      }
      const hud = (window as unknown as { nubAgent?: { hud?: { typeText?: (text: string) => void } } }).nubAgent?.hud
      hud?.typeText?.(m[1])
      return
    }
    // No act marker: POINT is display-only guidance, safe to fly.
    const point = POINT_ONCE_RE.exec(body)
    if (!point) return
    const m = point
    const key = last.id + ':point:' + m[1] + ',' + m[2]
    if (lastActKey.current === key) return
    lastActKey.current = key
    const pt = toScreen(Number(m[1]), Number(m[2]))
    if (!pt) return
    const hud = (window as unknown as { nubAgent?: { hud?: { moveTo?: (x: number, y: number) => void } } }).nubAgent?.hud
    hud?.moveTo?.(pt.x, pt.y)
    setPointLabel(m[3] || '')
  }, [visibleMessages, actStatus, actLoaded])

  // Badge feed: the main window's live view of every conversation, relayed
  // by electron main. Null = no main window (nothing trustworthy to show).
  useEffect(() => {
    const hud = hudBridge()
    if (!hud?.onActivity) return
    let alive = true
    void Promise.resolve(hud.getActivity?.()).then((v) => {
      if (alive && v !== undefined) setActivity(v ?? null)
    })
    const off = hud.onActivity((v) => setActivity(v ?? null))
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [])

  const markSeen = (keys: string[]) => {
    if (keys.length === 0) return
    setSeen((prev) => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      saveSeen(next)
      return next
    })
  }

  // Expanding shows the newest unseen finish as a card; collapsing again
  // means it has been seen (and so has everything else that finished).
  const wasCollapsed = useRef(collapsed)
  useEffect(() => {
    if (wasCollapsed.current === collapsed) return
    wasCollapsed.current = collapsed
    if (!collapsed) {
      const unseen = (activity?.events ?? []).find((e) => !seen.has(e.key))
      setCard(unseen ?? null)
    } else {
      markSeen((activity?.events ?? []).map((e) => e.key))
      setCard(null)
    }
  }, [collapsed])

  const openCard = (ev: HudActivityEvent) => {
    void hudBridge()?.openConversation?.(ev.id)
    markSeen([ev.key])
    setCard(null)
  }
  const dismissCard = (ev: HudActivityEvent) => {
    markSeen([ev.key])
    setCard(null)
  }

  const badge = useMemo(() => hudBadge(activity, seen), [activity, seen])

  /** SEE: one capture per tap — the whole display, or a dragged region. */
  const look = async (mode: 'screen' | 'region') => {
    const hud = hudBridge()
    if (!hud?.see || seeBusy) return
    setSeeBusy(mode)
    setSeeError(null)
    try {
      const res = await hud.see(mode)
      if (res && res.ok) {
        setCapture({ dataUrl: res.dataUrl, mode: res.mode, geometry: res.geometry, capturedAt: res.capturedAt })
      } else if (res) {
        const copy = seeErrorCopy(res.error)
        if (copy) setSeeError({ copy, permission: seeErrorNeedsPermission(res.error) })
      }
    } catch {
      setSeeError({ copy: "Couldn't capture the screen. Try again.", permission: false })
    } finally {
      setSeeBusy(null)
      bumpRecent()
      inputRef.current?.focus()
    }
  }

  // Ask main once whether this app may inject input at all. Unknown (no
  // bridge, e.g. browser preview) means "try" — only a hard no blocks.
  // Act markers WAIT for this to settle: firing before it lands would bypass
  // the gate entirely, which is the one thing it exists to prevent.
  useEffect(() => {
    const hud = (window as unknown as { nubAgent?: { hud?: { actStatus?: () => unknown } } }).nubAgent?.hud
    const pending = hud?.actStatus?.()
    if (!pending) {
      setActLoaded(true) // nothing to ask — behave as before
      return
    }
    void Promise.resolve(pending).then((s) => {
      if (s && typeof s === 'object') setActStatus(s as ActStatus)
      setActLoaded(true)
    })
  }, [])

  /** True when we KNOW acting cannot work — surface it, don't pretend. */
  const actIsBlocked = () => actStatus !== null && actStatus.trusted === false

  // (TYPE and CLICK effects merged into the single act effect above.)

  // Local STT (whisper.cpp): reuse the repo's DictateEngine. The mic is hidden
  // entirely when the bridge/model is unavailable (plain browser, no model).
  useEffect(() => {
    let cancelled = false
    void sttStatus().then((s) => {
      if (cancelled) return
      if (!s.ok) { setDictateStatus('unavailable'); return }
      dictateRef.current = new DictateEngine({
        transcribe: transcribeAudio,
        hooks: {
          onStatus: (status) => setDictateStatus(status),
          onFinal: (t) => setText((draft) => appendTranscript(draft, t)),
        },
      })
    })
    return () => { cancelled = true; dictateRef.current = null }
  }, [])

  // Clicky bubble shows the CURRENT exchange only — the full transcript lives
  // in the main window. Small mascot, small bubble, nothing else.
  const lastUser = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'user') return visibleMessages[i].content || ''
    }
    return ''
  }, [visibleMessages])
  const lastAgent = useMemo(() => {
    // The reply to the CURRENT question = first agent message after lastUser.
    let userFrom = -1
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'user') { userFrom = i; break }
    }
    if (userFrom === -1) {
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        if (visibleMessages[i].role === 'agent') return visibleMessages[i]
      }
      return null
    }
    for (let i = userFrom + 1; i < visibleMessages.length; i++) {
      if (visibleMessages[i].role === 'agent') return visibleMessages[i]
    }
    return null
  }, [visibleMessages])
  const agentText = lastAgent ? stripMarkers(lastAgent.content || '') : ''
  // Mirror MessageBody: trailing whitespace is trimmed so partial deltas do
  // not paint blank lines mid-stream, and whitespace-only text paints nothing.
  const agentTextLive = agentText.trimEnd()
  const lastUserLive = lastUser.trimEnd()
  // D-03: the act is visible, not silent. stripMarkers keeps instructions out
  // of the prose; this chip is the honest trace of what the cat did (or is
  // doing) to the user's screen.
  const actSummary = lastAgent ? describeActMarker(lastAgent.content || '') : null

  const startDictate = () => {
    if (dictateStatus !== 'idle' && dictateStatus !== 'denied') return
    dictateHoldRef.current = true
    void dictateRef.current?.start()
  }
  const stopDictate = () => {
    if (!dictateHoldRef.current) return
    dictateHoldRef.current = false
    void dictateRef.current?.stop()
  }

  const lastMsg = visibleMessages[visibleMessages.length - 1]
  const mascotPresence: AgentMascotPresence = waitingOnUser
    ? 'waiting-approval'
    : seeBusy
      ? 'browsing'
      : sending
        ? 'thinking'
        : lastMsg?.role === 'agent' && lastMsg.streaming
          ? 'talking'
          : badge.kind === 'error' || actBlocked || seeError
            ? 'error'
            : walking || badge.kind === 'working'
              ? 'tool'
              : badge.kind === 'done'
                ? 'happy'
                : mascotAgent?.status === 'stopped'
                  ? 'offline'
                  : mascotAgent?.status === 'error' ? 'error' : 'idle'

  const canSend = (text.trim().length > 0 || capture !== null) && !sending

  const send = async () => {
    const shot = capture
    // A capture with no question is still a question.
    const trimmed = text.trim() || (shot ? (shot.mode === 'region' ? 'What is this?' : "What's on my screen?") : '')
    if (!trimmed || sending) return
    setSending(true)
    setText('')
    setCapture(null)
    setActRefused(null)
    // This exchange's replies are answered against this capture (or none).
    sightRef.current = shot
    bumpRecent()
    try {
      const state = getState()
      let conv = state.conversations.find((c) => c.id === state.selectedConversationId) ?? state.conversations[0]
      if (!conv) {
        // No conversation yet — create one via runtime-like path: use deploy/serve transport
        const state2 = getState()
        const agents = state2.agents
        const agentId = agents[0]?.id
        if (!agentId) return
        conv = {
          id: "conv_" + Date.now().toString(36),
          title: trimmed.slice(0, 32),
          target: { type: 'agent', agentId },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as unknown as typeof conv
      }
      const { transport } = await getActiveTransport()
      const t = conv.target as { type: string; agentId?: string; groupId?: string }
      const avatarAgentId =
        t.type === 'agent' ? t.agentId : getState().groups.find((g) => g.id === t.groupId)?.primaryAgentId
      if (avatarAgentId) maybeApplyAvatarIntent(avatarAgentId, trimmed, conv.id)
      await transport.sendMessage(
        conv,
        trimmed,
        shot ? { images: [shot.dataUrl], sight: sightInfo(shot) } : undefined,
      )
    } catch {
      /* transport surfaces its own error bubble */
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const badgeLabel =
    badge.kind === 'working'
      ? badge.count > 1
        ? `Working on ${badge.count} chats`
        : `Working on “${badge.title}”`
      : badge.kind === 'done'
        ? `Finished “${badge.event.title}”`
        : badge.kind === 'error'
          ? `Failed: “${badge.event.title}”`
          : ''
  const workingCount = activity?.working.length ?? 0

  const close = () => {
    const hud = (window as unknown as { nubAgent?: { hud?: { close?: () => void } } }).nubAgent?.hud
    if (hud?.close) void hud.close()
    else window.close()
  }

  const expand = () => {
    setFocused(true)
    bumpRecent()
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0)
    raf(() => inputRef.current?.focus())
  }

  if (collapsed) {
    return (
      <div
        data-hud-shell
        data-hud-collapsed=""
        className="hud-root hud-collapsed flex h-screen w-screen cursor-default select-none flex-col items-center justify-center"
        style={{ WebkitAppRegion: 'drag' } as unknown as Record<string, string>}
      >
        <button
          type="button"
          data-testid="hud-orb"
          data-mascot={mascotColor}
          data-walking={walking ? '' : undefined}
          aria-label={badgeLabel ? `Open Nub HUD — ${badgeLabel}` : 'Open Nub HUD'}
          title={badgeLabel ? `${badgeLabel}\n(click to open · drag to move · Alt-click to call the owl)` : 'Open Nub HUD (drag to move, Alt-click to call the owl to your cursor)'}
          {...orbDrag.handlers}
          onClick={(e) => {
            if (orbDrag.consumeDragClick()) return
            // Alt-click = provocation: "come here". Otherwise open the strip.
            const bridge = (
              window as unknown as { nubAgent?: { hud?: { goToCursor?: () => void } } }
            ).nubAgent?.hud
            if (e.altKey && bridge?.goToCursor) {
              e.preventDefault()
              bridge.goToCursor()
              return
            }
            expand()
          }}
          className="hud-orb relative grid cursor-grab place-items-center rounded-full transition-transform hover:scale-110 active:cursor-grabbing"
          style={{ WebkitAppRegion: 'no-drag' } as unknown as Record<string, string>}
        >
          <AgentMascot
            agentId={mascotAgentId}
            profile={mascotAgent}
            presence={mascotPresence}
            size={84}
            lookAtCursor
          />
          {pointer && (
            <span
              data-testid="hud-pointer"
              data-phase={pointer.phase}
              className="hud-pointer-orbit"
              style={{ transform: `rotate(${pointer.angle + Math.PI / 2}rad)` }}
            >
              <span className="hud-pointer-arrow" style={{ borderBottomColor: mascotColor }} />
            </span>
          )}
          {pointer && pointLabel ? (
            <span data-testid="hud-pointer-label" className="hud-pointer-label">{pointLabel}</span>
          ) : null}
          {badge.kind !== 'none' ? (
            <span
              data-testid="hud-badge"
              data-badge={badge.kind}
              aria-hidden
              className={'hud-badge hud-badge-' + badge.kind}
            >
              {badge.kind === 'working'
                ? badge.count > 1 ? badge.count : ''
                : badge.kind === 'error'
                  ? '!'
                  : '✓'}
            </span>
          ) : null}
        </button>
      </div>
    )
  }

  return (
    <div
      data-hud-shell
      data-hud-collapsed={undefined}
      data-hud-recent={recent ? '' : undefined}
      className="hud-root flex h-screen w-screen flex-col overflow-hidden"
      style={{ WebkitAppRegion: 'no-drag' } as unknown as Record<string, string>}
    >
      {/* Clicky-mode speech bubble: the CURRENT exchange + input, with a tail
       * pointing at the mascot below. The full transcript lives in the main
       * window — here it's buddy, bubble, nothing else. */}
      <div
        data-testid="hud-bubble"
        className="hud-bubble relative mx-auto flex min-h-0 w-full max-w-[360px] flex-1 flex-col rounded-[20px] px-3.5 pb-3 pt-2.5"
      >
        <span aria-hidden data-testid="hud-bubble-tail" className="hud-bubble-tail" />
        <div
          className="hud-head mb-1.5 flex shrink-0 cursor-grab items-center justify-between"
          style={{ WebkitAppRegion: 'drag' } as unknown as Record<string, string>}
        >
          <span data-testid="hud-header" className="hud-title">
            Nub
            {workingCount > 0 ? (
              <span className="hud-working ml-1.5">
                · working on {workingCount === 1 ? '1 chat' : `${workingCount} chats`}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={close}
            className="hud-close grid h-6 w-6 place-items-center rounded-full"
            style={{ WebkitAppRegion: 'no-drag' } as unknown as Record<string, string>}
            aria-label="Close HUD"
          >
            <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>

        {card ? (
          <div
            data-testid="hud-activity-card"
            data-status={card.status}
            role="status"
            className="hud-activity-card mb-1.5 flex shrink-0 items-start gap-2 rounded-xl px-2.5 py-1.5 text-[11px] leading-snug"
          >
            <span aria-hidden className="mt-px">{card.status === 'error' ? '⚠️' : '✅'}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {card.status === 'error' ? 'Failed' : 'Finished'} · {card.title}
              </div>
              {card.preview ? <div className="hud-card-preview mt-0.5">{card.preview}</div> : null}
            </div>
            <button
              type="button"
              data-testid="hud-activity-open"
              onClick={() => openCard(card)}
              className="hud-card-open shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
            >
              Open
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissCard(card)}
              className="hud-card-dismiss shrink-0 px-0.5"
            >
              ×
            </button>
          </div>
        ) : null}

        <div
          ref={listRef}
          data-hud-thread
          // The top fade is for content scrolled under the header — at the
          // top it would only wash out the first message.
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollTop > 2) el.setAttribute('data-scrolled', '')
            else el.removeAttribute('data-scrolled')
          }}
          className="hud-thread flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1"
        >
          {lastUserLive ? (
            <div className="hud-msg hud-msg-user ml-auto max-w-[85%] rounded-2xl rounded-br-md px-3 py-1.5 text-[13px] leading-snug">
              <div className="whitespace-pre-wrap break-words">{lastUserLive}</div>
            </div>
          ) : null}
          {agentTextLive ? (
            <div className="hud-msg hud-msg-agent mr-auto text-[13.5px] leading-relaxed">
              <div className="whitespace-pre-wrap break-words">{agentTextLive}</div>
            </div>
          ) : lastAgent && lastAgent.streaming ? (
            <div className="hud-msg hud-msg-agent hud-typing mr-auto">{waitingOnUser ?? '…'}</div>
          ) : !lastUserLive ? (
            <div className="hud-empty my-auto py-4 text-center text-[12px]">Ask anything — or tap 👁 so Nub can see your screen, ✂︎ to select an area.</div>
          ) : null}
          {actSummary ? (
            <div
              data-testid="hud-act-chip"
              data-act={actSummary.startsWith('clicked') ? 'click' : 'type'}
              className="hud-act-chip mr-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
            >
              <span aria-hidden>🐾</span>
              <span>{actSummary}</span>
            </div>
          ) : null}
        </div>

        {waitingOnUser ? (
          <div data-testid="hud-prompt" className="hud-prompt mt-1.5 shrink-0">
            <AgentPromptDock conversationId={hudConversationId} />
          </div>
        ) : null}

        {actRefused ? (
          <div data-testid="hud-act-refused" role="alert" className="hud-note mt-1 shrink-0 rounded-lg px-2 py-1 text-[10px] leading-snug">
            {actRefused}
          </div>
        ) : null}

        {seeError ? (
          <div
            data-testid="hud-see-error"
            role="alert"
            className="hud-see-error mt-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] leading-snug"
          >
            <span className="flex-1">{seeError.copy}</span>
            {seeError.permission ? (
              <button
                type="button"
                data-testid="hud-see-fix"
                onClick={() => void hudBridge()?.openScreenPermission?.()}
                className="hud-see-fix shrink-0 rounded-full px-2 py-0.5 font-medium"
              >
                Open Settings
              </button>
            ) : null}
            <button type="button" aria-label="Dismiss" onClick={() => setSeeError(null)} className="hud-see-dismiss shrink-0 px-0.5">
              ×
            </button>
          </div>
        ) : null}

        {capture ? (
          <div data-testid="hud-capture" data-mode={capture.mode} className="hud-capture mt-1.5 flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1">
            <img
              src={capture.dataUrl}
              alt=""
              aria-hidden
              className="hud-capture-thumb h-8 max-w-[56px] rounded object-cover"
            />
            <span className="hud-capture-label flex-1 text-[10px]">
              {capture.mode === 'region' ? 'Area attached' : 'Screen attached'} — Nub will look at it
            </span>
            <button
              type="button"
              aria-label="Remove screenshot"
              onClick={() => setCapture(null)}
              className="hud-capture-remove shrink-0 px-1"
            >
              ×
            </button>
          </div>
        ) : null}

        {/* Act honestly: a blocked input event is invisible (osascript exits 0
            either way), so when we KNOW it cannot work, say so and offer the
            one click that fixes it. Shown only after a marker was dropped. */}
        {actBlocked ? (
          <div
            data-testid="hud-act-hint"
            className="hud-act-hint mt-1.5 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] leading-snug"
          >
            <span className="flex-1">Clicking and typing need Accessibility access.</span>
            <button
              type="button"
              data-testid="hud-act-fix"
              onClick={() => {
                const hud = (
                  window as unknown as {
                    nubAgent?: { hud?: { requestActPermission?: () => Promise<{ trusted?: boolean }> } }
                  }
                ).nubAgent?.hud
                void Promise.resolve(hud?.requestActPermission?.()).then((r) => {
                  if (r && r.trusted) {
                    setActStatus({ trusted: true })
                    setActBlocked(false)
                  }
                })
              }}
              className="hud-act-fix shrink-0 rounded-full px-2 py-0.5 font-medium"
            >
              Enable
            </button>
          </div>
        ) : null}

        <div className="hud-composer mt-2 flex shrink-0 items-center gap-1.5 rounded-full p-1">
          {dictateStatus !== 'unavailable' && (
            <button
              type="button"
              data-testid="hud-mic"
              aria-label={dictateStatus === 'listening' ? 'Stop dictation' : 'Hold to talk'}
              title={dictateStatus === 'processing' ? 'Transcribing locally…' : 'Hold to talk, or press Space to start and stop (local whisper)'}
              disabled={dictateStatus === 'processing'}
              onPointerDown={startDictate}
              onPointerUp={stopDictate}
              onPointerLeave={stopDictate}
              onClick={(e) => {
                // Keyboard activation (detail 0) toggles; pointer holds are handled above.
                if (e.detail !== 0) return
                if (dictateStatus === 'listening') stopDictate()
                else startDictate()
              }}
              data-listening={dictateStatus === 'listening' ? '' : undefined}
              className="hud-mic grid h-8 w-8 shrink-0 place-items-center rounded-full disabled:opacity-40"
            >
              {dictateStatus === 'listening' ? (
                <span aria-hidden className="hud-rec-dot" />
              ) : (
                <svg aria-hidden width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
                  <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
                </svg>
              )}
            </button>
          )}
          {hudBridge()?.see ? (
            <>
              <button
                type="button"
                data-testid="hud-see-screen"
                aria-label="Let Nub see your screen"
                title="Let Nub see your screen (attaches a screenshot to your next message)"
                disabled={seeBusy !== null || sending}
                onClick={() => void look('screen')}
                data-active={capture?.mode === 'screen' ? '' : undefined}
                className="hud-see grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] disabled:opacity-40"
              >
                {seeBusy === 'screen' ? '…' : '👁'}
              </button>
              <button
                type="button"
                data-testid="hud-see-region"
                aria-label="Select an area for Nub"
                title="Select an area of your screen for Nub to look at"
                disabled={seeBusy !== null || sending}
                onClick={() => void look('region')}
                data-active={capture?.mode === 'region' ? '' : undefined}
                className="hud-see grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px] disabled:opacity-40"
              >
                {seeBusy === 'region' ? '…' : '✂︎'}
              </button>
            </>
          ) : null}
          <input
            ref={inputRef}
            aria-label="Ask Nub"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={bumpRecent}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
              if (e.key === 'Escape') close()
            }}
            placeholder={
              waitingOnUser === 'Waiting for your answer'
                ? 'Type your answer…'
                : capture
                  ? capture.mode === 'region'
                    ? 'Ask about this area…'
                    : 'Ask about your screen…'
                  : 'Ask Nub…'
            }
            autoFocus
            className="hud-input h-8 min-w-0 flex-1 bg-transparent px-2 text-[13.5px] focus:outline-none"
          />
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            className="hud-send grid h-8 w-8 shrink-0 place-items-center rounded-full"
            aria-label="Send"
          >
            <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* The mascot anchors the bubble — click to dock back to the cat. */}
      <div className="flex shrink-0 items-center justify-center py-1.5">
        <button
          type="button"
          data-testid="hud-mascot"
          data-mascot={mascotColor}
          aria-label="Dock HUD to orb"
          title="Dock HUD to orb (drag to move)"
          {...mascotDrag.handlers}
          onClick={() => {
            if (mascotDrag.consumeDragClick()) return
            setFocused(false)
            setRecent(false)
          }}
          className="hud-mascot grid shrink-0 cursor-grab place-items-center rounded-full transition-transform hover:scale-110 active:cursor-grabbing"
        >
          <AgentMascot agentId={mascotAgentId} profile={mascotAgent} presence={mascotPresence} size={56} lookAtCursor />
          {pointer && pointLabel ? (
            <span data-testid="hud-pointer-label" className="hud-pointer-label">{pointLabel}</span>
          ) : null}
        </button>
      </div>
    </div>
  )
}
