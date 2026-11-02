import { num } from '../pose'
import type { ParticleParams, ParticleType } from '../types'
import { STAGE_PARTICLE_CAP } from './stage'
import type { Stage } from './stage'

const NS = 'http://www.w3.org/2000/svg'
export const INSTANCE_PARTICLE_CAP = 48

type Range = [number, number]
interface Preset {
  count: number
  layer: 'back' | 'front'
  /** Symbol size in px for a 160px mascot. */
  size: number
  life: Range
  speed: Range
  /** Emission angle range in degrees (0 = right, -90 = up). */
  angle: Range
  gravity: number
  drag: number
  sway?: [number, number]
  spin?: Range
  scale: [number, number]
  /** 'pop' grows quickly then shrinks; default interpolates scale[0] → scale[1]. */
  curve?: 'pop'
  fadeIn?: number
  fadeOut?: number
  opacity?: number
  /** Orbit around the emission point (dizzy stars). */
  orbit?: { radius: number; speed: number }
  /** Rotate to face the direction of travel (wind streaks). */
  align?: boolean
  colors?: string[]
}
export const PRESETS: Record<ParticleType, Preset> = {
  feather: { count: 4, layer: 'front', size: 18, life: [1.8, 2.8], speed: [40, 110], angle: [-160, -20], gravity: 70, drag: 1.7,
    sway: [16, 1.1], spin: [-140, 140], scale: [1, 0.85], fadeIn: 0.08, fadeOut: 0.4,
    colors: ['var(--m-secondary, #cfe0f4)', 'var(--m-primary, #8bb8e8)', 'var(--m-belly, #efe2c9)'] },
  dust: { count: 7, layer: 'back', size: 15, life: [0.45, 0.7], speed: [50, 120], angle: [-180, 0], gravity: -10, drag: 4.5,
    scale: [0.5, 1.7], fadeOut: 0.7, opacity: 0.8 },
  wind: { count: 1, layer: 'back', size: 26, life: [0.28, 0.4], speed: [10, 30], angle: [-180, 180], gravity: 0, drag: 2,
    scale: [0.8, 1.15], fadeIn: 0.15, fadeOut: 0.6, opacity: 0.7, align: true },
  sparkle: { count: 5, layer: 'front', size: 13, life: [0.6, 0.95], speed: [60, 140], angle: [-170, -10], gravity: 30, drag: 3,
    spin: [-200, 200], scale: [0.3, 1.1], curve: 'pop' },
  trail: { count: 1, layer: 'back', size: 34, life: [0.25, 0.35], speed: [2, 4], angle: [0, 0], gravity: 0, drag: 0,
    scale: [1, 0.45], fadeOut: 1, opacity: 0.55, align: true },
  letter: { count: 1, layer: 'front', size: 24, life: [1.3, 1.6], speed: [180, 240], angle: [-110, -70], gravity: 460, drag: 0.4,
    spin: [-260, 260], scale: [0.9, 1], fadeOut: 0.25 },
  zzz: { count: 1, layer: 'front', size: 14, life: [1.9, 2.4], speed: [30, 45], angle: [-70, -55], gravity: -4, drag: 0.6,
    sway: [6, 0.9], scale: [0.55, 1.25], fadeIn: 0.15, fadeOut: 0.45 },
  note: { count: 1, layer: 'front', size: 17, life: [1.3, 1.6], speed: [55, 75], angle: [-110, -70], gravity: -8, drag: 0.8,
    sway: [9, 1.6], spin: [-30, 30], scale: [0.6, 1.1], curve: 'pop', fadeOut: 0.35 },
  heart: { count: 3, layer: 'front', size: 14, life: [1.1, 1.5], speed: [45, 85], angle: [-130, -50], gravity: -12, drag: 1,
    sway: [7, 1.4], scale: [0.4, 1.05], curve: 'pop', fadeOut: 0.35 },
  sweat: { count: 1, layer: 'front', size: 11, life: [0.6, 0.8], speed: [40, 70], angle: [-60, -30], gravity: 300, drag: 0.5,
    scale: [0.7, 1], fadeOut: 0.3 },
  ring: { count: 1, layer: 'front', size: 26, life: [0.6, 0.75], speed: [0, 0], angle: [0, 0], gravity: 0, drag: 0,
    scale: [0.3, 2.6], fadeOut: 1, opacity: 0.9 },
  confetti: { count: 18, layer: 'front', size: 9, life: [1.5, 2.1], speed: [140, 300], angle: [-150, -30], gravity: 420, drag: 0.9,
    sway: [10, 2.2], spin: [-560, 560], scale: [1, 0.9], fadeOut: 0.25,
    colors: ['var(--m-accent, #ffd772)', 'var(--m-primary, #8bb8e8)', 'var(--m-secondary, #cfe0f4)', '#ff7d9d', 'var(--m-shine, #fffaf0)'] },
  star: { count: 3, layer: 'front', size: 12, life: [1.8, 2.1], speed: [0, 0], angle: [0, 0], gravity: 0, drag: 0,
    spin: [180, 260], scale: [0.6, 1], curve: 'pop', fadeOut: 0.25, orbit: { radius: 30, speed: 5.5 } },
}

interface Particle {
  el: SVGUseElement
  layer: 'back' | 'front'
  alive: boolean
  preset: Preset
  x: number; y: number; vx: number; vy: number
  ox: number; oy: number; phase: number
  rot: number; spin: number
  age: number; life: number
  size: number
}

/** Pooled physics particles for one mascot, drawn on the shared stage in client px. */
export class ParticleEmitter {
  private pool: Particle[] = []
  private groups: Record<'back' | 'front', SVGGElement>
  private live = 0
  private stage: Stage
  private rng: () => number
  private cap: number
  constructor(stage: Stage, rng: () => number, cap = INSTANCE_PARTICLE_CAP) {
    this.stage = stage
    this.rng = rng
    this.cap = cap
    const make = (svg: SVGSVGElement) => {
      const g = stage.doc.createElementNS(NS, 'g')
      g.setAttribute('data-mascot-particles', '')
      svg.append(g)
      return g
    }
    this.groups = { back: make(stage.back), front: make(stage.front) }
  }
  get active() { return this.live }
  setPalette(vars: Record<string, string>) {
    for (const g of Object.values(this.groups)) {
      for (const [key, value] of Object.entries(vars)) g.style.setProperty(key, value)
    }
  }
  private between([a, b]: Range) { return a + this.rng() * (b - a) }
  private acquire(layer: 'back' | 'front'): Particle | undefined {
    let p = this.pool.find(q => !q.alive && q.layer === layer)
    if (!p && this.pool.length < this.cap) {
      const el = this.stage.doc.createElementNS(NS, 'use')
      el.setAttribute('x', '-12'); el.setAttribute('y', '-12')
      el.setAttribute('width', '24'); el.setAttribute('height', '24')
      this.groups[layer].append(el)
      p = { el, layer, alive: false } as Particle
      this.pool.push(p)
    }
    if (!p) {
      // Instance cap reached: recycle the oldest live particle of this layer.
      p = this.pool.filter(q => q.layer === layer && q.alive).sort((a, b) => b.age / b.life - a.age / a.life)[0]
      if (p) { p.alive = false; this.live--; this.stage.particles-- }
    }
    return p
  }
  emit(type: ParticleType, x: number, y: number, scale = 1, params: ParticleParams = {}) {
    const preset = PRESETS[type]
    if (!preset) return
    const count = Math.max(0, Math.min(this.cap, Math.round(params.count ?? preset.count)))
    for (let i = 0; i < count; i++) {
      if (this.stage.particles >= STAGE_PARTICLE_CAP) return
      const p = this.acquire(preset.layer)
      if (!p) return
      const angle = (params.angle !== undefined
        ? params.angle + (params.spread ?? 0) * (this.rng() - 0.5)
        : params.spread !== undefined
          ? -90 + (this.rng() - 0.5) * params.spread
          : this.between(preset.angle)) * Math.PI / 180
      const speed = this.between(preset.speed) * Math.max(0.5, scale)
      Object.assign(p, {
        alive: true, preset,
        x, y, ox: x, oy: y,
        vx: Math.cos(angle) * speed + (params.vx ?? 0),
        vy: Math.sin(angle) * speed + (params.vy ?? 0),
        phase: preset.orbit ? (i / count) * Math.PI * 2 : this.rng() * Math.PI * 2,
        rot: preset.spin ? this.rng() * 360 : 0,
        spin: preset.spin ? this.between(preset.spin) : 0,
        age: 0, life: params.life ?? this.between(preset.life),
        size: preset.size * scale * (params.scale ?? 1) / 24,
      })
      p.el.setAttribute('href', `#mascot-fx-${type}`)
      const color = params.color ?? (preset.colors ? preset.colors[Math.floor(this.rng() * preset.colors.length)] : '')
      if (color) p.el.style.setProperty('--fx-color', color)
      else p.el.style.removeProperty('--fx-color')
      p.el.style.display = ''
      this.live++
      this.stage.particles++
      this.render(p)
    }
  }
  step(dt: number) {
    if (!this.live || dt <= 0) return
    for (const p of this.pool) {
      if (!p.alive) continue
      p.age += dt
      if (p.age >= p.life) {
        p.alive = false
        p.el.style.display = 'none'
        this.live--
        this.stage.particles--
        continue
      }
      const { preset } = p
      const drag = Math.exp(-preset.drag * dt)
      p.vx *= drag
      p.vy = p.vy * drag + preset.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.spin * dt
      this.render(p)
    }
  }
  private render(p: Particle) {
    const { preset } = p
    const u = p.age / p.life
    let x = p.x
    let y = p.y
    if (preset.orbit) {
      const a = p.phase + p.age * preset.orbit.speed
      x = p.ox + Math.cos(a) * preset.orbit.radius * p.size * 2
      y = p.oy + Math.sin(a) * preset.orbit.radius * p.size * 0.7
    }
    if (preset.sway) x += Math.sin(p.phase + p.age * preset.sway[1] * Math.PI * 2) * preset.sway[0] * p.size
    const [s0, s1] = preset.scale
    const shape = preset.curve === 'pop' ? Math.sin(Math.min(1, u * 1.15) * Math.PI) : u
    const scale = (preset.curve === 'pop' ? s0 + (s1 - s0) * Math.min(1, shape * 1.4) : s0 + (s1 - s0) * shape) * p.size
    const fadeIn = preset.fadeIn ?? 0
    const fadeOut = preset.fadeOut ?? 0.3
    let opacity = preset.opacity ?? 1
    if (fadeIn > 0 && u < fadeIn) opacity *= u / fadeIn
    if (fadeOut > 0 && u > 1 - fadeOut) opacity *= (1 - u) / fadeOut
    const rot = preset.align ? Math.atan2(p.vy, p.vx) * 180 / Math.PI : p.rot
    p.el.setAttribute('transform', `translate(${num(x)} ${num(y)}) rotate(${num(rot)}) scale(${num(scale)})`)
    p.el.setAttribute('opacity', num(Math.max(0, opacity)))
  }
  /** Point the next aligned particle (wind/trail) along a heading, in degrees. */
  aim(type: 'wind' | 'trail', x: number, y: number, heading: number, scale = 1, params: ParticleParams = {}) {
    this.emit(type, x, y, scale, { ...params, count: 1, angle: heading })
  }
  clear() {
    for (const p of this.pool) {
      if (p.alive) { p.alive = false; this.live--; this.stage.particles-- }
      p.el.style.display = 'none'
    }
  }
  destroy() {
    this.clear()
    for (const g of Object.values(this.groups)) g.remove()
    this.pool = []
  }
}
