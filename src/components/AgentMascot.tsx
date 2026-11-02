import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import owlRig from '../lib/mascot/characters/owl/rig.svg?raw'
import owlMotion from '../lib/mascot/characters/owl/motion.json'
import { paletteVariables, staticRig } from '../lib/mascot/rig'
import { agentAccent, agentPalette, agentPaletteId, type MascotProfile } from '../lib/mascot/agent-palette'
import { registerMascot } from '../lib/mascot/cues'
import type { MascotHandle, MascotState, MotionSpec } from '../lib/mascot/types'

export { agentColor } from '../lib/mascot/agent-palette'
export type AgentMascotPresence =
  | 'idle' | 'thinking' | 'tool' | 'browsing' | 'waiting-approval'
  | 'talking' | 'happy' | 'error' | 'sleep' | 'offline'
export type AgentMascotReaction = 'pulse' | 'message' | 'approval'
export interface AgentMascotProps {
  agentId: string
  profile?: MascotProfile | string | null
  presence?: AgentMascotPresence
  size?: number
  lookAtCursor?: boolean
  /** Edge-triggered. Clear the prop before replaying the same reaction. */
  reaction?: AgentMascotReaction | null
  className?: string
  title?: string
  reducedMotion?: boolean
  /** Autonomous idle acts (hops, head swivels, preening…). Defaults on from 24px up. */
  autonomy?: boolean
  /** A home avatar (sidebar, agent card, HUD): app cues may fly this Pip across the window. */
  flight?: boolean
}

const states: Record<AgentMascotPresence, MascotState> = {
  idle: 'idle', thinking: 'thinking', tool: 'tool', browsing: 'browsing',
  'waiting-approval': 'waiting', talking: 'talking', happy: 'happy',
  error: 'error', sleep: 'sleep', offline: 'sleep',
}

type MascotComponent = typeof import('../lib/mascot/Mascot').Mascot
let loadedMascot: MascotComponent | undefined
let mascotLoad: Promise<MascotComponent> | undefined
function loadMascot() {
  // The generic registry includes every gallery concept. Keep it and the
  // animation engine out of the app's startup chunk, sharing one deferred load.
  return mascotLoad ??= import('../lib/mascot/Mascot').then(({ Mascot }) => {
    loadedMascot = Mascot
    return Mascot
  })
}

/** Pip is the single agent silhouette. The engine owns motion and accessibility preferences. */
export const AgentMascot = memo(function AgentMascot({
  agentId, profile, presence = 'idle', size = 40, lookAtCursor = false,
  reaction, className, title, reducedMotion, autonomy, flight = false,
}: AgentMascotProps) {
  const instanceId = useId()
  const id = agentPaletteId(profile, agentId)
  const accent = agentAccent(profile)
  const palette = useMemo(
    () => agentPalette({ id, ui_meta: { accent_color: accent } }),
    [id, accent],
  )
  const html = useMemo(
    () => ({ __html: staticRig(owlRig, owlMotion as unknown as MotionSpec, `pip-${instanceId}`) }),
    [instanceId],
  )
  const [Mascot, setMascot] = useState<MascotComponent | undefined>(() => loadedMascot)
  useEffect(() => {
    if (Mascot) return
    let alive = true
    void loadMascot().then(component => {
      if (alive) setMascot(() => component)
    }).catch(() => {
      // A missing/offline chunk must not remove the agent's avatar.
      mascotLoad = undefined
    })
    return () => { alive = false }
  }, [Mascot])
  const handle = useRef<MascotHandle | null>(null)
  const unregister = useRef<(() => void) | undefined>(undefined)
  // The lazy child's engine can be recreated without replaying this parent's effects.
  const attachHandle = useCallback((instance: MascotHandle | null) => {
    unregister.current?.()
    unregister.current = undefined
    handle.current = instance
    if (instance && agentId) {
      unregister.current = registerMascot(agentId, { handle: instance, element: () => instance.element(), canFly: flight })
    }
  }, [agentId, flight])
  const lastReaction = useRef<AgentMascotReaction | null | undefined>(null)
  useEffect(() => {
    if (!Mascot) return
    if (reaction !== lastReaction.current && reaction && presence !== 'offline') handle.current?.react(reaction)
    lastReaction.current = reaction
  }, [reaction, presence, id, lookAtCursor, Mascot])
  if (!Mascot) return <span
    className={className}
    data-character="owl"
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    style={{
      display: 'inline-block', width: size, height: size, lineHeight: 0, flexShrink: 0,
      ...paletteVariables(palette), opacity: presence === 'offline' ? 0.45 : undefined,
    } as CSSProperties}
    dangerouslySetInnerHTML={html}
  />
  return <Mascot
    character="owl"
    state={states[presence]}
    palette={palette}
    seed={`${id}:${instanceId}`}
    size={size}
    lookAtCursor={lookAtCursor}
    reducedMotion={reducedMotion}
    autonomy={presence !== 'offline' && (autonomy ?? size >= 24)}
    stageKey={flight ? `agent:${agentId}` : undefined}
    apiRef={attachHandle}
    className={className}
    title={title}
    style={presence === 'offline' ? { opacity: 0.45 } : undefined}
  />
})
