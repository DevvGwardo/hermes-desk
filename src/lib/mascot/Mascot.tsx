import { memo, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, Ref } from 'react'
import { createMascot } from './engine'
import { characters } from './registry'
import { paletteVariables, staticRig } from './rig'
import type { FrameClock, MascotHandle, MascotState, Palette } from './types'

export interface MascotProps {
  character: string
  state?: MascotState | string
  palette?: Palette
  size?: number
  lookAtCursor?: boolean
  reducedMotion?: boolean
  fps?: number
  seed?: number | string
  clock?: FrameClock
  className?: string
  style?: CSSProperties
  title?: string
  apiRef?: Ref<MascotHandle>
  /** Motion v2 autonomous idle acts (hops, head swivels, preening…). */
  autonomy?: boolean
  /** Only one instance per key may fly away from home at a time. */
  stageKey?: string
  /** Point (client px) idle glances may look at, e.g. the newest message. */
  attention?: () => { x: number; y: number } | null
}
function assignRef(ref: Ref<MascotHandle> | undefined, value: MascotHandle | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

/** Idle rig is present in SSR; lifecycle owns only this isolated SVG subtree. */
export const Mascot = memo(function Mascot({
  character, state = 'idle', palette, size = 160, lookAtCursor = false, reducedMotion,
  fps, seed = 1, clock, className, style, title, apiRef, autonomy = false, stageKey, attention,
}: MascotProps) {
  const entry = characters[character]
  if (!entry) throw new Error(`Unknown mascot character: ${character}`)
  const id = useId()
  const host = useRef<HTMLSpanElement>(null)
  const handle = useRef<MascotHandle | null>(null)
  const latest = useRef({ state, palette, size, reducedMotion, autonomy, attention })
  latest.current = { state, palette, size, reducedMotion, autonomy, attention }
  const html = useMemo(() => ({ __html: staticRig(entry.svg, entry.motion, `ssr-${id}`) }), [entry, id])
  useLayoutEffect(() => {
    const current = latest.current
    const engine = createMascot(host.current!, {
      svg: entry.svg, motion: entry.motion, state: current.state,
      palette: current.palette ?? entry.palette.default, size: current.size,
      reducedMotion: current.reducedMotion, interactive: lookAtCursor, fps, seed, clock,
      clips: entry.clips, autonomy: current.autonomy, stageKey,
      attention: () => latest.current.attention?.() ?? null,
    })
    handle.current = engine
    assignRef(apiRef, engine)
    return () => { engine.destroy(); handle.current = null; assignRef(apiRef, null) }
  }, [entry, lookAtCursor, fps, seed, clock, apiRef, stageKey])
  useLayoutEffect(() => { handle.current?.setState(state) }, [state])
  useLayoutEffect(() => { handle.current?.setPalette(palette ?? entry.palette.default) }, [palette, entry])
  useLayoutEffect(() => { handle.current?.setSize(size) }, [size])
  useLayoutEffect(() => { handle.current?.setReducedMotion(reducedMotion) }, [reducedMotion])
  useLayoutEffect(() => { handle.current?.setAutonomy(autonomy) }, [autonomy])
  return <span
    ref={host}
    className={className}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    data-character={character}
    style={{ display: 'inline-block', width: size, height: size, lineHeight: 0, flexShrink: 0, ...paletteVariables(palette ?? entry.palette.default), ...style } as CSSProperties}
    dangerouslySetInnerHTML={html}
  />
})
