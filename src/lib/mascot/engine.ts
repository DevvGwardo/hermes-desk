import { AutonomousBehaviors, BlinkScheduler, DEFAULT_BEHAVIORS, GazeScheduler, IdleFidgets, isDrowsy, oscillate, seededRandom } from './behaviors'
import { ClipPlayer, compileClips, ROOT_PROPS, sampleChannel } from './clips'
import type { CompiledClip, Layer } from './clips'
import { Flight } from './flight'
import { mascotFrameClock } from './frame-clock'
import { FxLayer } from './fx'
import { ParticleEmitter } from './fx/particles'
import { acquireStage, releaseStage } from './fx/stage'
import type { Stage } from './fx/stage'
import { authoredMatrix, composeTransform, fullPose, IDENTITY_MATRIX, IDENTITY_POSE, multiply, poseMatrix, transformPoint } from './pose'
import type { Matrix } from './pose'
import { paletteVariables, PALETTE_KEYS, prepareRig, smallInsetTransform } from './rig'
import { DEFAULT_SPRING, spring, stepSpring } from './spring'
import type { Spring } from './spring'
import { POSE_PROPS } from './types'
import type {
  ClipSpec, MascotHandle, MascotOptions, Palette, ParticleParams, ParticleType, PlayOptions, PlayResult, Pose, PoseProp,
  ReactionSpec, SpringSpec,
} from './types'
import { watchPointer, watchVisibility } from './visibility'

interface Part {
  name: string
  el: SVGGElement
  parent?: Part
  pivot: [number, number]
  base: string
  baseMatrix: Matrix
  springs: Record<PoseProp, Spring>
  /** The current state's target pose; clips blend over it. */
  target: Pose
  /** How strongly an override clip holds each prop this frame (suppresses state oscillators). */
  hold: Pose
  config: SpringSpec
  pose: Pose
  last: string
}
let sequence = 0
const SVG_NS = 'http://www.w3.org/2000/svg'
const NO_LAYERS: Layer[] = []
const normalize = (name: string) => name.replace(/^part-/, '')
const compiledCache = new WeakMap<Record<string, ClipSpec>, Record<string, CompiledClip>>()
function compiled(clips?: Record<string, ClipSpec>) {
  if (!clips) return {}
  let hit = compiledCache.get(clips)
  if (!hit) { hit = compileClips(clips); compiledCache.set(clips, hit) }
  return hit
}
const boostedSprings = new WeakMap<SpringSpec, Map<number, SpringSpec>>()
function boosted(config: SpringSpec, factor: number): SpringSpec {
  const key = Math.round(factor * 20) / 20
  let byFactor = boostedSprings.get(config)
  if (!byFactor) boostedSprings.set(config, byFactor = new Map())
  let hit = byFactor.get(key)
  if (!hit) {
    const damping = config.damping ?? 2 * Math.sqrt(config.stiffness)
    hit = { stiffness: config.stiffness * key, damping: damping * Math.sqrt(key) }
    byFactor.set(key, hit)
  }
  return hit
}

export function createMascot(el: HTMLElement, options: MascotOptions): MascotHandle {
  const { motion } = options
  if (!motion.states.idle) throw new Error('Mascot motion requires an idle state')
  const clock = options.clock ?? mascotFrameClock
  const doc = el.ownerDocument
  const prefix = options.idPrefix ?? `mascot-${++sequence}`
  const seed = options.seed ?? 1
  const markup = prepareRig(options.svg, prefix)
  const container = doc.createElement('div')
  container.innerHTML = markup
  const svg = container.firstElementChild as SVGSVGElement
  const insetGroups = [...svg.querySelectorAll<SVGGElement>('g[data-small-inset]')].map(node => ({
    node, inset: Number(node.dataset.smallInset), base: node.getAttribute('transform') ?? '',
  }))
  // Whole-rig motion (clip root tracks) lives on one wrapper so every part, and the ambient fx, follow it.
  const motionRoot = doc.createElementNS(SVG_NS, 'g')
  motionRoot.setAttribute('data-mascot-motion-root', '')
  for (const child of [...svg.childNodes]) {
    if (!(child.nodeType === 1 && (child as Element).localName === 'defs')) motionRoot.append(child)
  }
  // Optional floor mask for clips that sink below the feet line.
  const motionMask = doc.createElementNS(SVG_NS, 'g')
  motionMask.setAttribute('data-mascot-mask', '')
  motionMask.append(motionRoot)
  svg.append(motionMask)
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.overflow = 'visible'
  svg.style.display = 'block'
  el.replaceChildren(svg)
  let state = motion.states[options.state ?? 'idle'] ? options.state ?? 'idle' : 'idle'
  let spec = motion.states[state]
  let size = options.size ?? 160
  let small = size <= 48
  let forcedReduced = options.reducedMotion
  const query = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
  let reduced = forcedReduced ?? query?.matches ?? false
  let dead = false
  let paused = false
  let visible = true
  let hidden = doc.hidden
  let unsubscribe: (() => void) | undefined
  let time = 0
  let last = clock.now()
  let targetLook: [number, number] | null = null
  let glance: { x: number; y: number; until: number } | null = null
  let pointer: [number, number] | null = null
  let reaction: { spec: ReactionSpec; start: number } | undefined
  let palette: Palette = options.palette ?? {}
  const rng = seededRandom(seed)
  // Independent streams prevent gaze/fidget/behaviour changes from moving blink times.
  const blink = new BlinkScheduler(rng, spec.eyes?.blinkEvery)
  const gaze = new GazeScheduler(seededRandom(`${seed}:gaze`))
  const fidgets = new IdleFidgets(seededRandom(`${seed}:fidget`))
  const autonomyRate = typeof options.autonomy === 'object' ? options.autonomy.rate ?? 1 : 1
  let behaviors: AutonomousBehaviors | undefined
  const wallClock = options.wallClock ?? (() => new Date())
  let drowsy = false
  let drowsyCheckedAt = -Infinity
  const lookX = spring(0)
  const lookY = spring(0)
  const weights = new Map<string, Spring>([[state, spring(1)]])
  const parts = new Map<string, Part>()
  for (const node of svg.querySelectorAll<SVGGElement>('[data-mascot-part]')) {
    const name = node.dataset.mascotPart!
    const pivot = (node.dataset.pivot ?? '0 0').trim().split(/[\s,]+/).map(Number)
    if (pivot.length !== 2 || !pivot.every(Number.isFinite)) throw new Error(`Invalid pivot on ${name}`)
    const pose = fullPose(spec.pose?.[name] ?? spec.pose?.[`part-${name}`])
    parts.set(name, {
      name, el: node, pivot: pivot as [number, number], base: node.getAttribute('transform') ?? '',
      baseMatrix: authoredMatrix(node.getAttribute('transform') ?? ''),
      springs: Object.fromEntries(POSE_PROPS.map(prop => [prop, spring(pose[prop])])) as Record<PoseProp, Spring>,
      target: { ...pose }, hold: { rotate: 0, tx: 0, ty: 0, sx: 0, sy: 0 },
      config: motion.springs?.parts?.[name] ?? motion.springs?.parts?.[`part-${name}`] ?? motion.springs?.default ?? DEFAULT_SPRING,
      pose: { ...pose }, last: '',
    })
  }
  for (const part of parts.values()) {
    const declared = part.el.dataset.parent
    const parentNode = part.el.parentElement?.closest<SVGGElement>('[data-mascot-part]')
    const parent = declared ? parts.get(normalize(declared)) : parts.get(parentNode?.dataset.mascotPart ?? '')
    if (declared && !parent && declared !== 'root' && declared !== 'part-root') throw new Error(`Missing parent ${declared}`)
    if (parent) {
      let ancestor: Part | undefined = parent
      const seen = new Set<Part>([part])
      while (ancestor) {
        if (seen.has(ancestor)) throw new Error('Mascot part hierarchy contains a cycle')
        seen.add(ancestor)
        const next: string | undefined = ancestor.el.dataset.parent
        ancestor = next ? parts.get(normalize(next)) : undefined
      }
      part.parent = parent
      // A flat rig may declare its hierarchy. Nested rigs retain paint order.
      if (!parent.el.contains(part.el)) parent.el.append(part.el)
    }
  }
  /** Feet anchor in viewBox units: the root part's pivot, else bottom centre. */
  const rootPivot: [number, number] = parts.get('root')?.pivot ?? [256, 480]
  let rootMatrix: Matrix = [...IDENTITY_MATRIX]
  let rootLast = ''
  let masked = false
  const maskId = `${prefix}-mascot-frame`
  function setMasked(on: boolean) {
    if (on === masked) return
    masked = on
    if (on && !svg.querySelector(`[id="${maskId}"]`)) {
      const defs = doc.createElementNS(SVG_NS, 'defs')
      const clip = doc.createElementNS(SVG_NS, 'clipPath')
      clip.setAttribute('id', maskId)
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse')
      const rect = doc.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', '-1024'); rect.setAttribute('y', '-1024')
      rect.setAttribute('width', '2560'); rect.setAttribute('height', String(1024 + rootPivot[1] + 12))
      clip.append(rect); defs.append(clip); svg.prepend(defs)
    }
    if (on) motionMask.setAttribute('clip-path', `url(#${maskId})`)
    else motionMask.removeAttribute('clip-path')
  }
  const pupils = [...svg.querySelectorAll<SVGGElement>('[data-mascot-pupil]')].map(node => ({
    node, base: node.getAttribute('transform') ?? '',
    pivot: (node.dataset.pivot ?? node.closest<SVGGElement>('[data-mascot-part]')?.dataset.pivot ?? '256 256').split(/[\s,]+/).map(Number),
    last: '',
  }))
  const mouths = [...svg.querySelectorAll<SVGGElement>('[data-mascot-mouth]')]
  let mouthNow = ''
  const nightcap = parts.get('nightcap')?.el
  const fx = new FxLayer(motionRoot)
  // Keyframed clips (motion v2 §1).
  const player = new ClipPlayer(compiled(options.clips), {
    event: () => {},
    fx: (_layer, key) => emitFx(key.type, key.anchor, key.params),
    next: (_layer, next) => {
      if (player.has(next)) void player.play(next, { mode: 'replace' })
      else if (motion.states[next]) api.setState(next)
    },
  })
  const showOverrides = new Map<string, string>()
  const showNow = new Map<string, boolean>()
  // Particles live on the shared stage overlay, created on first use.
  let stage: Stage | undefined
  let emitter: ParticleEmitter | undefined
  function particles(): ParticleEmitter | undefined {
    if (dead || reduced || !doc.body) return undefined
    if (!emitter) {
      stage = acquireStage(doc)
      emitter = new ParticleEmitter(stage, seededRandom(`${seed}:fx`))
      emitter.setPalette(paletteVariables(palette))
    }
    return emitter
  }
  function anchorPoint(anchor = 'head'): [number, number] {
    const name = normalize(anchor)
    if (name === 'feet' || name === 'root') return transformPoint(rootMatrix, ...rootPivot)
    const part = parts.get(name) ?? parts.get('head')
    return part ? transformPoint(multiply(rootMatrix, world(part)), ...part.pivot) : [256, 240]
  }
  function emitFx(type: ParticleType, anchor?: string, params: ParticleParams = {}) {
    const em = particles()
    if (!em) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const [x, y] = anchorPoint(anchor)
    em.emit(type, rect.left + x / 512 * rect.width, rect.top + y / 512 * rect.height, rect.width / 160, params)
  }
  // Stage flight (motion v2 §2).
  const flight = new Flight({
    doc, host: el, svg,
    homeSize: () => size,
    feet: () => rootPivot,
    reduced: () => reduced,
    play: (name, opts) => api.play(name, opts),
    hasClip: name => player.has(name),
    stopClips: () => player.stop(),
    setClipSpeed: (name, speed) => player.setSpeed(name, speed),
    restoreSize: () => applySize(size),
    emitAt: (type, x, y, heading, px) => particles()?.aim(type, x, y, heading, px / 160),
    palette: () => paletteVariables(palette),
  }, options.stageKey)

  function updateMouth(value: string) {
    const selected = mouths.some(node => node.dataset.mascotMouth === value) ? value : 'neutral'
    if (selected === mouthNow) return
    mouthNow = selected
    for (const node of mouths) node.style.display = node.dataset.mascotMouth === selected ? 'inline' : 'none'
  }
  function updateFx() { fx.set(small || reduced ? [] : reaction?.spec.fx ?? spec.fx ?? []) }
  function applyPalette(next: Palette = {}) {
    palette = next
    for (const key of PALETTE_KEYS) svg.style.removeProperty(`--m-${key}`)
    const vars = paletteVariables(next)
    for (const [key, value] of Object.entries(vars)) svg.style.setProperty(key, value)
    emitter?.setPalette(vars)
  }
  function applySize(n: number) {
    if (!Number.isFinite(n) || n <= 0) throw new Error('Mascot size must be positive')
    size = n
    small = size <= 48
    if (flight.location === 'home') {
      svg.style.width = `${size}px`
      svg.style.height = `${size}px`
    }
    for (const { node, inset, base } of insetGroups) {
      const transform = [smallInsetTransform(inset, size), base].filter(Boolean).join(' ')
      if (transform) node.setAttribute('transform', transform)
      else node.removeAttribute('transform')
    }
    updateFx()
  }
  function world(part: Part): Matrix {
    const local = multiply(poseMatrix(part.pose, part.pivot), part.baseMatrix)
    return part.parent ? multiply(world(part.parent), local) : multiply(IDENTITY_MATRIX, local)
  }
  function toViewBox(x: number, y: number): [number, number] | null {
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return [(x - rect.left) / rect.width * 512, (y - rect.top) / rect.height * 512]
  }
  function glanceAt() {
    const point = options.attention?.() ?? (pointer ? { x: pointer[0], y: pointer[1] } : null)
    const local = point ? toViewBox(point.x, point.y) : null
    const [x, y] = local ?? [256 + (rng() - 0.5) * 900, 200 + (rng() - 0.5) * 300]
    glance = { x, y, until: time + 1.2 + rng() * 0.8 }
  }
  function checkDrowsy() {
    if (time - drowsyCheckedAt < 30) return
    drowsyCheckedAt = time
    drowsy = Boolean(behaviors) && isDrowsy(wallClock())
    if (nightcap) nightcap.style.display = drowsy && (state === 'idle' || state === 'sleep') ? '' : 'none'
  }
  function applyShow(name: string, visible: boolean) {
    const node = parts.get(normalize(name))?.el ?? svg.querySelector<SVGElement>(`[id="${prefix}-${name}"]`)
    if (!node) return
    if (!showOverrides.has(name)) showOverrides.set(name, node.style.display)
    node.style.display = visible ? 'inline' : 'none'
  }
  function restoreShow(name: string) {
    const node = parts.get(normalize(name))?.el ?? svg.querySelector<SVGElement>(`[id="${prefix}-${name}"]`)
    if (node) node.style.display = showOverrides.get(name) ?? ''
    showOverrides.delete(name)
  }

  function draw(dt: number) {
    if (!reduced) player.update(dt)
    const layers = reduced ? NO_LAYERS : player.layers
    checkDrowsy()
    // Clip-level procedural switches, mouth, lids, gaze and visibility overrides.
    let blinkOn = true
    let breatheOn = true
    let lookOn = true
    let clipMouth: string | undefined
    let lid = 0
    let look: [number, number] | null = null
    let lookWeight = 0
    let mask = false
    showNow.clear()
    for (const layer of layers) {
      const { clip, weight, local } = layer
      if (clip.spec.mask === 'frame' && weight > 0) mask = true
      if (weight > 0.5) {
        const procedural = clip.spec.procedural
        if (procedural?.blink === false) blinkOn = false
        if (procedural?.breathe === false) breatheOn = false
        if (procedural?.lookAt === false) lookOn = false
        clipMouth = ClipPlayer.step(clip.mouth, local)?.expr ?? clipMouth
        for (const key of clip.show) if (key.t <= local) showNow.set(key.part, key.visible)
      }
      if (clip.lid) lid = Math.max(lid, sampleChannel(clip.lid, local) * weight)
      if (clip.look) { look = [sampleChannel(clip.look.x, local), sampleChannel(clip.look.y, local)]; lookWeight = weight }
    }
    const resting = drowsy && state === 'idle' && !reduced
    const closure = Math.max(state === 'sleep' ? 1 : blinkOn ? blink.sample(time) : 0, lid, resting ? 0.4 : 0)
    if (!reduced) {
      const fallback = gaze.sample(time, spec.eyes)
      if (glance && time > glance.until) glance = null
      const aim = targetLook ?? (glance ? [glance.x, glance.y] : null)
      let gx = aim ? Math.max(-12, Math.min(12, (aim[0] - 256) / 14)) : fallback[0]
      let gy = aim ? Math.max(-9, Math.min(9, (aim[1] - 240) / 18)) : fallback[1]
      if (!lookOn) { gx = 0; gy = 0 }
      if (look) { gx += (look[0] * 12 - gx) * lookWeight; gy += (look[1] * 9 - gy) * lookWeight }
      lookX.target = gx
      lookY.target = gy
      stepSpring(lookX, dt)
      stepSpring(lookY, dt)
      for (const [name, weight] of weights) {
        stepSpring(weight, dt)
        if (name !== state && Math.abs(weight.value) < 0.0001) weights.delete(name)
      }
    }
    let envelope = 0
    if (reaction) {
      const progress = (time - reaction.start) / Math.max(0.1, reaction.spec.duration ?? 0.65)
      if (progress >= 1) { reaction = undefined; updateFx() }
      else envelope = Math.sin(progress * Math.PI) ** 2
    }
    const fidget = !reduced && !behaviors && state === 'idle' ? fidgets.sample(time) : 0
    const hasBreath = (spec.osc ?? []).some(osc => normalize(osc.part) === 'body' && osc.prop === 'sy')
    for (const part of parts.values()) {
      for (const prop of POSE_PROPS) {
        const s = part.springs[prop]
        let target = part.target[prop]
        let hold = 0
        let boost = 1
        for (const layer of layers) {
          const ch = layer.clip.parts.get(part.name)?.[prop]
          if (!ch) continue
          const value = sampleChannel(ch, layer.local)
          if (layer.clip.mode === 'additive') target += (value - IDENTITY_POSE[prop]) * layer.weight
          else { target += (value - target) * layer.weight; hold = Math.max(hold, layer.weight) }
          boost = Math.max(boost, 1 + (layer.clip.springScale - 1) * layer.weight)
        }
        s.target = target
        part.hold[prop] = hold
        if (reduced) { s.value = s.target; s.velocity = 0; part.pose[prop] = s.target }
        else part.pose[prop] = stepSpring(s, dt, boost > 1.01 ? boosted(part.config, boost) : part.config)
      }
      if (!reduced) {
        for (const [name, weight] of weights) {
          for (const osc of motion.states[name].osc ?? []) {
            if (normalize(osc.part) !== part.name) continue
            if (!breatheOn && part.name === 'body' && osc.prop === 'sy') continue
            part.pose[osc.prop] += oscillate(osc, time) * weight.value * (1 - part.hold[osc.prop])
          }
        }
        if (reaction) {
          const overlay = reaction.spec.pose?.[part.name] ?? reaction.spec.pose?.[`part-${part.name}`]
          for (const prop of POSE_PROPS) part.pose[prop] += ((overlay?.[prop] ?? (prop === 'sx' || prop === 'sy' ? 1 : 0)) - (prop === 'sx' || prop === 'sy' ? 1 : 0)) * envelope
          for (const osc of reaction.spec.osc ?? []) {
            if (normalize(osc.part) === part.name) part.pose[osc.prop] += oscillate(osc, time - reaction.start) * envelope
          }
        }
        if (part.name === 'head') part.pose.rotate += fidget
        if (part.name === 'body' && !hasBreath && breatheOn) part.pose.sy += Math.sin(time * Math.PI * 0.5) * 0.012
      }
      if (part.name.startsWith('lid-')) part.pose.sy *= closure
      if (part.name.startsWith('eye-')) part.pose.sy *= Math.max(0.045, 1 - closure)
      const transform = `${composeTransform(part.pose, part.pivot)}${part.base ? ` ${part.base}` : ''}`
      if (part.last !== transform) { part.el.setAttribute('transform', transform); part.last = transform }
    }
    // Whole-rig root track.
    const root = { x: 0, y: 0, rotate: 0, sx: 1, sy: 1 }
    for (const layer of layers) {
      for (const prop of ROOT_PROPS) {
        const ch = layer.clip.root[prop]
        if (!ch) continue
        const value = sampleChannel(ch, layer.local)
        if (layer.clip.mode === 'additive') root[prop] += (value - (prop === 'sx' || prop === 'sy' ? 1 : 0)) * layer.weight
        else root[prop] += (value - root[prop]) * layer.weight
      }
    }
    const rootPose = { tx: root.x, ty: root.y, rotate: root.rotate, sx: root.sx, sy: root.sy }
    const identity = !root.x && !root.y && !root.rotate && root.sx === 1 && root.sy === 1
    const rootTransform = identity ? '' : composeTransform(rootPose, rootPivot)
    if (rootTransform !== rootLast) {
      rootLast = rootTransform
      if (rootTransform) motionRoot.setAttribute('transform', rootTransform)
      else motionRoot.removeAttribute('transform')
      rootMatrix = identity ? [...IDENTITY_MATRIX] : poseMatrix(rootPose, rootPivot)
    }
    setMasked(mask)
    for (const [name, on] of showNow) applyShow(name, on)
    for (const name of [...showOverrides.keys()]) if (!showNow.has(name)) restoreShow(name)
    updateMouth(clipMouth ?? reaction?.spec.mouth ?? spec.mouth ?? 'neutral')
    for (const pupil of pupils) {
      const scale = spec.eyes?.pupilScale ?? 1
      const transform = `${composeTransform({ rotate: 0, tx: reduced ? 0 : lookX.value, ty: reduced ? 0 : lookY.value, sx: scale, sy: scale }, pupil.pivot)} ${pupil.base}`
      if (pupil.last !== transform) { pupil.node.setAttribute('transform', transform); pupil.last = transform }
    }
    if (!small && !reduced) fx.draw(time, name => {
      const part = parts.get(normalize(name))
      return part ? transformPoint(world(part), ...part.pivot) : [256, 240]
    })
    emitter?.step(dt)
    flight.update(dt)
    if (behaviors && !reduced && state === 'idle' && flight.location === 'home' && !player.busy && !reaction) {
      const act = behaviors.sample(time, name => name === 'look' || player.has(name), drowsy)
      if (act === 'look') glanceAt()
      else if (act) void player.play(act, { mode: 'replace' })
    }
    svg.dataset.mascotState = state
    svg.dataset.mascotProfile = reduced ? 'reduced' : small ? 'small' : 'full'
    if (svg.dataset.mascotLocation !== flight.location) {
      svg.dataset.mascotLocation = flight.location
      // Coming home may need to pause again if the home slot is offscreen.
      if (unsubscribe) sync()
    }
  }
  function tick(now: number) {
    const cap = reduced ? 20 : small && flight.location === 'home' ? 30 : 60
    const fps = Math.max(1, Math.min(cap, options.fps ?? 60))
    if (now - last < 1000 / fps - 0.5) return
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
    last = now
    time += dt
    draw(dt)
  }
  function sync() {
    const away = flight.location !== 'home'
    if (dead || paused || hidden || (!visible && !away)) {
      unsubscribe?.(); unsubscribe = undefined
      // Stage particles only advance on this clock: drop them rather than freeze them on screen.
      emitter?.clear()
      svg.dataset.mascotPaused = 'true'
    } else if (!unsubscribe) {
      last = clock.now()
      unsubscribe = clock.subscribe(tick)
      svg.dataset.mascotPaused = 'false'
    }
  }
  function setReduced(value: boolean | undefined) {
    forcedReduced = value
    reduced = forcedReduced ?? query?.matches ?? false
    reaction = undefined
    if (reduced) {
      player.clear()
      emitter?.clear()
      if (flight.airborne) flight.snapHome('aborted')
    }
    updateFx(); draw(0)
  }
  function setAutonomy(on: boolean) {
    if (on && !behaviors) {
      behaviors = new AutonomousBehaviors(seededRandom(`${seed}:acts`), motion.behaviors ?? DEFAULT_BEHAVIORS, autonomyRate, time)
    } else if (!on) behaviors = undefined
    drowsyCheckedAt = -Infinity
  }
  const mediaChange = () => { if (forcedReduced === undefined) setReduced(undefined) }
  query?.addEventListener('change', mediaChange)
  if (options.autonomy) setAutonomy(true)
  applyPalette(options.palette)
  applySize(size)
  draw(0)
  const unwatch = watchVisibility(el, {
    visible: on => { visible = on; sync() },
    hidden: on => {
      hidden = on
      if (on) flight.hidden()
      sync()
    },
  })
  const unpointer = options.interactive || options.autonomy ? watchPointer(doc, (x, y) => {
    pointer = [x, y]
    if (!options.interactive || !visible || hidden || paused || dead || reduced || spec.eyes?.look !== 'cursor') return
    targetLook = toViewBox(x, y) ?? targetLook
  }) : () => {}
  sync()
  const api: MascotHandle = {
    setState(next) {
      if (dead) return
      const previous = state
      const before = spec
      state = motion.states[next] ? next : 'idle'
      spec = motion.states[state]
      reaction = undefined
      for (const part of parts.values()) {
        const pose = fullPose(spec.pose?.[part.name] ?? spec.pose?.[`part-${part.name}`])
        part.target = pose
        for (const prop of POSE_PROPS) part.springs[prop].target = pose[prop]
      }
      for (const weight of weights.values()) weight.target = 0
      if (!weights.has(state)) weights.set(state, spring(0))
      weights.get(state)!.target = 1
      targetLook = null
      blink.setRange(spec.eyes?.blinkEvery ?? [2.5, 6], time)
      behaviors?.defer(time, 3)
      drowsyCheckedAt = -Infinity
      if (previous !== state && !reduced && !flight.airborne) {
        if (before.exit && player.has(before.exit)) void player.play(before.exit, { mode: 'replace' })
        else if (before.loop) player.stop(before.loop)
        if (spec.enter && player.has(spec.enter)) void player.play(spec.enter, { mode: before.exit ? 'queue' : 'replace' })
        if (spec.loop && player.has(spec.loop)) void player.play(spec.loop, { mode: 'queue', loop: true })
      }
      updateFx(); draw(0)
    },
    react(name) {
      if (dead || reduced) return
      const reactionSpec = motion.reactions?.[name]
      if (reactionSpec) {
        reaction = { spec: reactionSpec, start: time }
        updateFx()
        if (reactionSpec.mouth) updateMouth(reactionSpec.mouth)
        if (reactionSpec.clip && player.has(reactionSpec.clip)) void player.play(reactionSpec.clip, { mode: 'layer' })
      } else if (player.has(name)) void player.play(name, { mode: 'layer' })
      behaviors?.defer(time, 3)
    },
    lookAt(x: number | null, y?: number) { if (!dead) targetLook = x === null ? null : [x, y ?? 256] },
    setPalette(next) { if (!dead) applyPalette(next) },
    setSize(n) { if (!dead) { applySize(n); draw(0) } },
    setReducedMotion(value) { if (!dead) setReduced(value) },
    pause() { if (!dead) { paused = true; sync() } },
    resume() { if (!dead) { paused = false; sync() } },
    play(name: string, opts: PlayOptions = {}): Promise<PlayResult> {
      const clip = player.get(name)
      if (dead || !clip) { opts.onEnd?.('interrupted'); return Promise.resolve('interrupted') }
      if (reduced) {
        // No choreography: fire its events in order so callers still progress, and honour state hand-offs.
        for (const key of clip.events) opts.onEvent?.(key.name)
        const next = clip.spec.next
        if (next && !player.has(next) && motion.states[next]) api.setState(next)
        const result: PlayResult = clip.loop || opts.loop ? 'interrupted' : 'done'
        opts.onEnd?.(result)
        return Promise.resolve(result)
      }
      behaviors?.defer(time, 2)
      return player.play(name, opts)
    },
    stop(name?: string) { player.stop(name) },
    clips() { return player.names() },
    flyTo(target, opts) {
      if (dead) return Promise.resolve('aborted')
      const result = flight.flyTo(target, opts)
      sync()
      return result
    },
    perchOn(element, opts) { return api.flyTo(element, { ...opts, perch: true }) },
    goHome(opts) {
      if (dead) return Promise.resolve('aborted')
      const result = flight.goHome(opts)
      sync()
      return result
    },
    location() { return flight.location },
    element() { return el },
    emit(type, opts = {}) {
      const { anchor, x, y, ...params } = opts
      if (x === undefined || y === undefined) return emitFx(type, anchor, params)
      const rect = svg.getBoundingClientRect()
      particles()?.emit(type, x, y, (rect.width || size) / 160, params)
    },
    setAutonomy(on) { if (!dead) setAutonomy(on) },
    destroy() {
      if (dead) return
      dead = true
      unsubscribe?.()
      unwatch(); unpointer()
      query?.removeEventListener('change', mediaChange)
      player.clear()
      flight.destroy()
      emitter?.destroy()
      if (stage) releaseStage(stage)
      fx.destroy()
      svg.remove()
    },
  }
  return api
}
