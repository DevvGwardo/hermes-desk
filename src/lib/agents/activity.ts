/**
 * Agent / chat activity → presence contract (product-owned).
 * Visual FX keys live only in blob-fx PRESENCE_TO_FX (dzt).
 *
 * MaiaVM Instance mapping (later):
 * - chat ack / stream open → listening → radar
 * - reasoning / thinking events → thinking → dots
 * - tool/subagent start → spawning → gather; running → progress
 * - token stream → writing → pencil
 * - outbound deliver → sending → send
 * - inbound digest/result → receiving → receive
 * - upload → uploading → dock
 * - STT / dictation → dictating → wave
 * - instance error → alerting → bang
 * - stopped / power off → powering-down → standby
 * Presence keys stay product-owned; FX keys are the visual layer (PRESENCE_TO_FX).
 */

import { PRESENCE_TO_FX, type FxState, type PresenceState } from '../blob-fx'
import { AVATAR_BODY_COLORS } from '../avatar-spec'
import type { GrokOrbShape } from '../../components/FatCatIcon'
import type { AgentStatus, SubagentStatus, TurnPhase } from './types'

/** Chat / composer / turn activity phases (UI + mock runtime). */
export type ActivityPhase =
  | 'idle'
  | 'listening' // acked / awaiting model
  | 'thinking' // model reasoning
  | 'working' // tools / subagents active
  | 'sending' // outbound user/agent message in flight
  | 'writing' // streaming assistant tokens (future)
  | 'receiving' // inbound stream chunk / subagent digest (future)
  | 'surprised' // soft attention / unexpected
  | 'sleeping' // agent stopped / offline
  | 'error' // hard failure
  | null

export interface PresenceInput {
  /** Explicit override (highest). `null` forces FX off; omit to skip. */
  presence?: PresenceState | null
  sending?: boolean
  activityPhase?: ActivityPhase
  /** Live subagents — if any, pick strongest: failed > running > queued > completed */
  subagents?: { status: SubagentStatus }[]
  turnPhase?: TurnPhase
  agentStatus?: AgentStatus
  agentBusy?: boolean
}

export function activityPhaseToPresence(phase: ActivityPhase): PresenceState | null {
  switch (phase) {
    case 'listening':
      return 'radar'
    case 'thinking':
      return 'thinking'
    case 'working':
      return 'loading'
    case 'sending':
      return 'sending'
    case 'writing':
      return 'writing'
    case 'receiving':
      return 'receiving'
    case 'surprised':
      return 'radar'
    case 'sleeping':
      return 'powering-down'
    case 'error':
      return 'alerting'
    case 'idle':
    case null:
    default:
      return null
  }
}

export function subagentStatusToPresence(
  status: SubagentStatus,
): PresenceState | null {
  switch (status) {
    case 'queued':
      return 'spawning'
    case 'running':
      return 'progress'
    case 'completed':
      return 'receiving'
    case 'failed':
      return 'alerting'
    case 'cancelled':
      return 'powering-down'
    default:
      return null
  }
}

export function turnPhaseToPresence(phase: TurnPhase): PresenceState | null {
  switch (phase) {
    case 'acked':
      return 'radar'
    case 'working':
      return 'loading'
    case 'delivering':
      return 'sending'
    case 'done':
      return null
    case 'failed':
      return 'alerting'
    default:
      return null
  }
}

/**
 * Map agent lifecycle status → presence.
 * `busy` means live chat / subagent work (runtime activity), NOT “row selected”
 * in sidebar chrome. Selected-running alone must not drive FX.
 */
export function agentStatusToPresence(
  status: AgentStatus,
  opts?: { busy?: boolean },
): PresenceState | null {
  switch (status) {
    case 'error':
      return 'alerting'
    case 'provisioning':
      return 'radar'
    case 'running':
      // busy → thinking (dots). Could be loading/whirl; keep thinking.
      return opts?.busy ? 'thinking' : null
    case 'stopped':
      return 'powering-down'
    default:
      return null
  }
}

/** Conversations currently working: in-flight sends plus streaming replies.
 *  Selection is not in the formula — Grok Bot `isRunning` is per-agent. */
export function collectLiveConversationIds(
  inFlightIds: Iterable<string>,
  messagesByThreadId: Record<string, { streaming?: boolean }[]>,
): Set<string> {
  const ids = new Set(inFlightIds)
  for (const [tid, msgs] of Object.entries(messagesByThreadId)) {
    if (msgs.some((m) => m.streaming)) ids.add(tid)
  }
  return ids
}

export type ChromeAvatarFx = {
  presence: PresenceState | null
  fx: null | 'auto'
  still: boolean
}

/**
 * Sidebar / idle chrome avatar: only animate for inherently active lifecycle.
 * running/stopped → face expression only; explicit fx null beats expression→FX.
 */
export function chromeAvatarPresence(status: AgentStatus): ChromeAvatarFx {
  if (status === 'provisioning') {
    return { presence: 'radar', fx: 'auto', still: false }
  }
  if (status === 'error') {
    return { presence: 'alerting', fx: 'auto', still: false }
  }
  if (status === 'running') {
    // Running = ALIVE: full idle life (blink / gaze / breathing pose) but no
    // ambient FX patterns — the sidebar list stays calm, the chat header is
    // where busy FX live. 'happy' expression + idle loop reads as "working".
    return { presence: null, fx: null, still: false }
  }
  // stopped: face expression only, frozen (agent is off)
  return { presence: null, fx: null, still: true }
}

/** Alias used by sidebar product path. */
export const sidebarAvatarFx = chromeAvatarPresence

/**
 * Face the orb should wear. Live chats use `working` (desktop busy).
 * Provisioning is `listening` — never `thinking`, whose belt is three
 * dots and reads as a stuck loader on the phone home strip.
 */
export function agentOrbExpression(
  agent: { status?: AgentStatus } | null | undefined,
  live: boolean,
): 'working' | 'error' | 'sleeping' | 'listening' | 'idle' {
  if (live) return 'working'
  if (agent?.status === 'error') return 'error'
  if (agent?.status === 'stopped') return 'sleeping'
  if (agent?.status === 'provisioning') return 'listening'
  return 'idle'
}

/** Nubcat body fills — alias of AVATAR_BODY_COLORS (single source in avatar-spec). */
export const NUBCAT_COLORS = AVATAR_BODY_COLORS

/** Kept for callers that still import the old shape list — cat only. */
export const ALL_AVATAR_SHAPES: GrokOrbShape[] = ['cat']

/**
 * Resolve an agent's mascot. Silhouette is always the nubcat; color is the
 * user's pick, otherwise a stable seed-derived color from NUBCAT_COLORS.
 */
export function resolveAgentMascot(
  agent: { avatarShape?: GrokOrbShape | string | null; avatarColor?: string | null; id: string } | null | undefined,
): { shape: GrokOrbShape; color: string } {
  if (!agent) return { shape: 'cat', color: NUBCAT_COLORS[0] }
  return { shape: 'cat', color: agent.avatarColor ?? avatarColorForSeed(agent.id) }
}

/** Always the nubcat — leftover stored shapes are ignored. */
export function avatarShapeForSeed(_seed: string): GrokOrbShape {
  return 'cat'
}

/** Stable per-agent color among the four nubcats. */
export function avatarColorForSeed(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return NUBCAT_COLORS[h % NUBCAT_COLORS.length]
}

/** Strongest live-subagent status: failed > running > queued > completed. */
function strongestSubagentStatus(
  subagents: { status: SubagentStatus }[],
): SubagentStatus | null {
  if (subagents.length === 0) return null
  const rank: Record<SubagentStatus, number> = {
    failed: 4,
    running: 3,
    queued: 2,
    completed: 1,
    cancelled: 0,
  }
  let best: SubagentStatus | null = null
  let bestRank = -1
  for (const s of subagents) {
    const r = rank[s.status] ?? 0
    if (r > bestRank) {
      bestRank = r
      best = s.status
    }
  }
  return best
}

/**
 * Priority: explicit presence → sending → subagents → activityPhase →
 * turnPhase → agentStatus → null.
 */
export function resolvePresence(input: PresenceInput): PresenceState | null {
  if (input.presence !== undefined) return input.presence
  if (input.sending) return 'sending'

  if (input.subagents && input.subagents.length > 0) {
    const status = strongestSubagentStatus(input.subagents)
    if (status) {
      const fromSub = subagentStatusToPresence(status)
      if (fromSub) return fromSub
    }
  }

  if (input.activityPhase !== undefined) {
    const fromPhase = activityPhaseToPresence(input.activityPhase)
    if (fromPhase) return fromPhase
  }

  if (input.turnPhase !== undefined) {
    const fromTurn = turnPhaseToPresence(input.turnPhase)
    if (fromTurn) return fromTurn
  }

  if (input.agentStatus !== undefined) {
    return agentStatusToPresence(input.agentStatus, { busy: input.agentBusy })
  }

  return null
}

/** Compose resolvePresence → PRESENCE_TO_FX (single dzt table). */
export function resolveFxFromActivity(input: PresenceInput): FxState | null {
  const presence = resolvePresence(input)
  return presence ? PRESENCE_TO_FX[presence] ?? null : null
}
