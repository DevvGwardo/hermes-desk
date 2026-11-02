export const MASCOT_STATES = [
  'idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep',
] as const
export type MascotState = typeof MASCOT_STATES[number]
export const POSE_PROPS = ['rotate', 'tx', 'ty', 'sx', 'sy'] as const
export type PoseProp = typeof POSE_PROPS[number]
export type Pose = Record<PoseProp, number>
export type PartPose = Partial<Pose>
export type PoseMap = Record<string, PartPose>
export interface Oscillator {
  part: string
  prop: PoseProp
  amp: number
  freq: number
  phase?: number
}
export interface EyeSpec {
  blinkEvery?: [number, number]
  look?: 'cursor' | 'center' | 'wander' | 'down' | 'up' | 'up-left' | 'up-right' | 'left' | 'right' | string
  pupilScale?: number
}
export interface FxSpec {
  type: 'sparkle' | 'dots' | 'zzz' | 'sweat' | 'ring'
  anchor?: string
  x?: number
  y?: number
  count?: number
  color?: string
  size?: number
  /** Seconds per cycle; fx are deterministic, not particle simulations. */
  duration?: number
}
export interface StateSpec {
  pose?: PoseMap
  osc?: Oscillator[]
  mouth?: string
  eyes?: EyeSpec
  fx?: FxSpec[]
  /** v2: clips played when entering, while in, and when leaving the state. */
  enter?: string
  loop?: string
  exit?: string
}
export interface SpringSpec { stiffness: number; damping?: number }
export interface ReactionSpec extends StateSpec {
  duration?: number
  /** v2: play this clip as an overlay layer instead of (or as well as) the pose overlay. */
  clip?: string
}
export interface MotionSpec {
  states: Record<MascotState, StateSpec> & Record<string, StateSpec>
  springs?: { default?: SpringSpec; parts?: Record<string, SpringSpec> }
  reactions?: Record<string, ReactionSpec>
  /** v2: autonomous idle acts, clip name -> weight. Missing clips are ignored. */
  behaviors?: Record<string, number>
}

export type EaseName =
  | 'linear' | 'inSine' | 'outSine' | 'inOutSine' | 'inQuad' | 'outQuad' | 'inOutQuad'
  | 'inCubic' | 'outCubic' | 'inOutCubic' | 'inBack' | 'outBack' | 'inOutBack'
  | 'outElastic' | 'outBounce' | 'step' | `spring(${number},${number})` | string
export interface PartKey extends PartPose { t: number; ease?: EaseName }
export interface RootKey { t: number; x?: number; y?: number; rotate?: number; sx?: number; sy?: number; ease?: EaseName }
export interface ShowKey { t: number; part: string; visible: boolean }
export interface MouthKey { t: number; expr: string }
export interface EyesKey { t: number; look?: [number, number] | null; lid?: number; ease?: EaseName }
export interface FxKey { t: number; type: ParticleType; anchor?: string; params?: ParticleParams }
export interface EventKey { t: number; name: string }
/** Keyframed choreography (motion v2 §1). Times are seconds from the clip start. */
export interface ClipSpec {
  duration: number
  loop?: boolean
  blendIn?: number
  blendOut?: number
  /** override (default): tracks replace the state pose by weight; additive: tracks add deltas from identity. */
  mode?: 'override' | 'additive'
  /** Multiplies per-part spring stiffness while the clip holds a part, so fast choreography survives the lag. */
  springScale?: number
  procedural?: { blink?: boolean; breathe?: boolean; lookAt?: boolean }
  /** 'frame' clips the rig at its feet line while the clip plays (peeking up from below). */
  mask?: 'frame'
  tracks: {
    parts?: Record<string, PartKey[]>
    root?: RootKey[]
    show?: ShowKey[]
    mouth?: MouthKey[]
    eyes?: EyesKey[]
    fx?: FxKey[]
    events?: EventKey[]
  }
  next?: string
}
export type PlayResult = 'done' | 'interrupted'
export interface PlayOptions {
  onEvent?: (name: string) => void
  speed?: number
  /** replace (default) fades out other clips; queue waits for them; layer plays on top. */
  mode?: 'replace' | 'queue' | 'layer'
  /** Force looping (or not) regardless of the clip's own flag. */
  loop?: boolean
  /** Called synchronously, on the frame the clip ends (the promise settles a microtask later). */
  onEnd?: (result: PlayResult) => void
}

export const PARTICLE_TYPES = [
  'feather', 'dust', 'wind', 'sparkle', 'trail', 'letter', 'zzz', 'note', 'heart', 'sweat', 'ring', 'confetti', 'star',
] as const
export type ParticleType = typeof PARTICLE_TYPES[number]
export interface ParticleParams {
  count?: number
  /** Initial direction bias in client px/s. */
  vx?: number
  vy?: number
  spread?: number
  /** Emission direction in degrees (0 = right, -90 = up); spread then widens it. */
  angle?: number
  /** Multiplies the preset's size. */
  scale?: number
  life?: number
  color?: string
}

export type FlightPath = 'arc' | 'swoop' | 'direct' | 'loop'
export type FlightTarget = Element | DOMRect | { x: number; y: number }
export interface FlightOptions {
  path?: FlightPath
  /** Cruise speed in client px/s. */
  speed?: number
  takeoff?: string
  cruise?: string
  glide?: string
  land?: string
  /** Stay on the target after landing (default: true for elements with data-mascot-perch). */
  perch?: boolean
  edge?: 'top' | 'left' | 'right'
  offset?: number
  /** Fly back to the home slot after landing (after `dwell` ms). */
  returnHome?: boolean
  dwell?: number
  /** Peak size in px mid-flight. */
  size?: number
  /** Size in px once landed (default: the size it took off at). */
  landSize?: number
}
export type FlightResult = 'arrived' | 'interrupted' | 'aborted'
export type MascotLocation = 'home' | 'flying' | 'perched' | 'away'
export type PaletteKey = 'primary' | 'secondary' | 'accent' | 'belly' | 'ink' | 'eye' | 'shine'
/** Accept either `primary` or the literal contract key `--m-primary`. */
export type Palette = Partial<Record<PaletteKey | `--m-${PaletteKey}`, string>>
export interface PalettePackage {
  default: Palette
  agents: Palette[] | Record<string, Palette>
}
export interface Character {
  id: string
  svg: string
  motion: MotionSpec
  palette: PalettePackage
  clips: Record<string, ClipSpec>
}
export interface FrameClock {
  now(): number
  subscribe(callback: (timeMs: number) => void): () => void
}
export interface MascotOptions {
  svg: string
  motion: MotionSpec
  palette?: Palette
  size?: number
  state?: MascotState | string
  fps?: number
  reducedMotion?: boolean
  interactive?: boolean
  seed?: number | string
  clock?: FrameClock
  /** Explicit isolation prefix, useful for deterministic snapshots. */
  idPrefix?: string
  /** v2 keyframed clips by name. */
  clips?: Record<string, ClipSpec>
  /** v2 autonomous idle behaviour layer (off by default). */
  autonomy?: boolean | { rate?: number }
  /** Wall clock for time-of-day behaviour; defaults to `new Date()`. */
  wallClock?: () => Date
  /** Only one instance per key may be away from home at a time (e.g. the agent id). */
  stageKey?: string
  /** Optional point (client px) the behaviour layer may glance at, e.g. the newest message. */
  attention?: () => { x: number; y: number } | null
}
export interface MascotHandle {
  setState(state: MascotState | string): void
  react(name: string): void
  /** ViewBox coordinates, not client pixels. Null restores the state's gaze. */
  lookAt(x: number, y: number): void
  lookAt(point: null): void
  setPalette(palette: Palette): void
  setSize(size: number): void
  setReducedMotion(reduced: boolean | undefined): void
  pause(): void
  resume(): void
  destroy(): void
  /** v2 clips */
  play(name: string, options?: PlayOptions): Promise<PlayResult>
  stop(name?: string): void
  clips(): string[]
  /** v2 stage */
  flyTo(target: FlightTarget, options?: FlightOptions): Promise<FlightResult>
  perchOn(element: Element, options?: Omit<FlightOptions, 'perch'>): Promise<FlightResult>
  goHome(options?: FlightOptions): Promise<FlightResult>
  location(): MascotLocation
  /** The home slot element the mascot was mounted into. */
  element(): HTMLElement
  /** v2 particles, anchored to a part (default head) unless x/y client px are given. */
  emit(type: ParticleType, options?: ParticleParams & { anchor?: string; x?: number; y?: number }): void
  setAutonomy(on: boolean): void
}
