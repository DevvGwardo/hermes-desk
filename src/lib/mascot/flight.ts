import { spring, stepSpring } from './spring'
import { acquireStage, releaseStage } from './fx/stage'
import type { Stage } from './fx/stage'
import { visibleBounds } from './visibility'
import type { FlightOptions, FlightPath, FlightResult, FlightTarget, MascotLocation, PlayOptions, PlayResult } from './types'

export interface Vec { x: number; y: number }
const v = (x: number, y: number): Vec => ({ x, y })
const add = (a: Vec, b: Vec) => v(a.x + b.x, a.y + b.y)
const sub = (a: Vec, b: Vec) => v(a.x - b.x, a.y - b.y)
const scale = (a: Vec, k: number) => v(a.x * k, a.y * k)
const len = (a: Vec) => Math.hypot(a.x, a.y)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return v(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y)
}

/** Arc-length table, so eased progress maps to distance travelled rather than curve parameter. */
export class ArcPath {
  private samples: Vec[] = []
  private lengths: number[] = []
  length = 0
  p0: Vec; p1: Vec; p2: Vec; p3: Vec
  private n: number
  constructor(p0: Vec, p1: Vec, p2: Vec, p3: Vec, n = 48) {
    this.p0 = p0; this.p1 = p1; this.p2 = p2; this.p3 = p3
    this.n = n
    this.build()
  }
  set(p0: Vec, p1: Vec, p2: Vec, p3: Vec) { Object.assign(this, { p0, p1, p2, p3 }); this.build() }
  private build() {
    this.samples = []
    this.lengths = []
    let total = 0
    let prev = this.p0
    for (let i = 0; i <= this.n; i++) {
      const point = bezier(this.p0, this.p1, this.p2, this.p3, i / this.n)
      total += i ? len(sub(point, prev)) : 0
      this.samples.push(point)
      this.lengths.push(total)
      prev = point
    }
    this.length = total
  }
  /** Point at a fraction (0..1) of the path's length. */
  at(fraction: number): Vec {
    if (this.length <= 0) return this.p3
    const target = clamp(fraction, 0, 1) * this.length
    let i = 1
    while (i < this.n && this.lengths[i] < target) i++
    const l0 = this.lengths[i - 1]
    const l1 = this.lengths[i]
    const u = l1 > l0 ? (target - l0) / (l1 - l0) : 0
    const a = this.samples[i - 1]
    const b = this.samples[i]
    return v(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u)
  }
}

/** Control-point offsets (c1 from start, c2 from end) per path style. Offsets survive a moving target. */
export function pathOffsets(path: FlightPath, p0: Vec, p3: Vec): [Vec, Vec] {
  const d = sub(p3, p0)
  const dist = len(d)
  const h = clamp(dist * 0.45, 60, 320)
  const sign = d.x >= 0 ? 1 : -1
  switch (path) {
    case 'direct': return [v(d.x / 3, d.y / 3 - 18), v(-d.x / 3, -d.y / 3 - 18)]
    case 'swoop': return [v(d.x * 0.45, h * 0.55), v(-d.x * 0.2, -h * 0.85)]
    case 'loop': return [v(d.x + sign * h * 0.9, -h * 1.1), v(-(d.x + sign * h * 0.9), -h * 1.1)]
    case 'arc':
    default: return [v(d.x * 0.12, -h), v(-d.x * 0.12, -h * 0.75)]
  }
}
/** Hermite progress with initial slope m0 (keeps speed continuous on re-target) and an eased arrival. */
export const hermite = (u: number, m0: number) => {
  const t = clamp(u, 0, 1)
  return (t ** 3 - 2 * t * t + t) * m0 + (-2 * t ** 3 + 3 * t * t)
}

export interface FlightHost {
  doc: Document
  host: HTMLElement
  svg: SVGSVGElement
  homeSize(): number
  /** Feet anchor in viewBox units. */
  feet(): [number, number]
  reduced(): boolean
  play(name: string, options?: PlayOptions): Promise<PlayResult>
  hasClip(name: string): boolean
  stopClips(): void
  setClipSpeed(name: string, speed: number): void
  /** Called whenever the svg is re-homed so the engine can restore its own sizing. */
  restoreSize(): void
  emitAt(type: 'wind' | 'trail', x: number, y: number, heading: number, size: number): void
  palette(): Record<string, string>
}

type Phase = 'home' | 'fade-out' | 'fade-in' | 'takeoff' | 'cruise' | 'landing' | 'perched' | 'away' | 'dwell'
interface Goal {
  target: FlightTarget
  options: FlightOptions
  home: boolean
  resolve: (result: FlightResult) => void
  settled: boolean
}
const flying = new Map<string, Flight>()
const PLACEHOLDER = '<svg viewBox="0 0 512 512" width="100%" height="100%" aria-hidden="true" style="display:block;overflow:visible">' +
  '<circle cx="256" cy="256" r="196" fill="none" stroke="var(--m-primary, #8bb8e8)" stroke-width="16" stroke-dasharray="34 30" stroke-linecap="round" opacity=".45"/>' +
  '<ellipse cx="256" cy="430" rx="120" ry="20" fill="var(--m-primary, #8bb8e8)" opacity=".3"/>' +
  '<path d="M112 424 C190 404 322 404 400 424" fill="none" stroke="var(--m-secondary, #cfe0f4)" stroke-width="26" stroke-linecap="round" opacity=".6"/>' +
  '<path d="M322 412 C340 386 364 378 388 382" fill="none" stroke="var(--m-secondary, #cfe0f4)" stroke-width="16" stroke-linecap="round" opacity=".5"/></svg>'

/** Moves a mascot out of its frame and across the window (motion v2 §2). */
export class Flight {
  phase: Phase = 'home'
  pos: Vec = v(0, 0)
  vel: Vec = v(0, 0)
  renderSize = 0
  private stage?: Stage
  private container?: HTMLDivElement
  private shadow?: HTMLDivElement
  private placeholder?: HTMLSpanElement
  private perchBox?: HTMLSpanElement
  private perchHost?: { el: HTMLElement; position: string }
  private goal?: Goal
  private path?: ArcPath
  private offsets: [Vec, Vec] = [v(0, 0), v(0, 0)]
  private start: Vec = v(0, 0)
  private progress = 0
  private duration = 1
  private m0 = 0
  private sizes = { from: 0, to: 0, peak: 0 }
  private bank = spring(0)
  private timer = 0
  private windClock = 0
  private cruiseClip = 'fly'
  private resizeOff?: () => void
  private h: FlightHost
  private key?: string
  constructor(host: FlightHost, key?: string) {
    this.h = host
    this.key = key
  }

  get location(): MascotLocation {
    if (this.phase === 'home') return 'home'
    if (this.phase === 'perched') return 'perched'
    if (this.phase === 'away' || this.phase === 'dwell') return 'away'
    return 'flying'
  }
  get airborne() { return this.phase === 'takeoff' || this.phase === 'cruise' || this.phase === 'landing' || this.phase.startsWith('fade') }

  flyTo(target: FlightTarget, options: FlightOptions = {}, home = false): Promise<FlightResult> {
    return new Promise(resolve => {
      this.settle('interrupted')
      if (this.key) {
        const other = flying.get(this.key)
        if (other && other !== this) other.snapHome('interrupted')
        flying.set(this.key, this)
      }
      this.goal = { target, options, home, resolve, settled: false }
      if (!this.h.doc.defaultView) return this.settle('aborted')
      if (this.phase === 'home') this.detach()
      else if (this.phase === 'perched') this.unperch()
      if (this.h.reduced()) {
        this.phase = 'fade-out'
        this.timer = 0
        return
      }
      if (this.phase === 'cruise' || this.phase === 'landing') return this.beginCruise()
      if (this.phase === 'takeoff') return
      this.takeoff()
    })
  }

  private takeoff() {
    this.phase = 'takeoff'
    this.vel = v(0, 0)
    const name = this.goal?.options.takeoff ?? 'takeoff'
    if (!this.h.hasClip(name)) return this.beginCruise()
    const go = () => { if (this.phase === 'takeoff') this.beginCruise() }
    void this.h.play(name, { mode: 'replace', onEvent: e => { if (e === 'airborne') go() }, onEnd: r => { if (r === 'done') go() } })
  }

  private targetPoint(): Vec | null {
    const goal = this.goal
    if (!goal) return null
    const { target, options } = goal
    if (goal.home) {
      const rect = this.h.host.getBoundingClientRect()
      const size = rect.width || this.h.homeSize()
      const [fx, fy] = this.h.feet()
      return this.homeEdge(v(rect.left + fx / 512 * size, rect.top + fy / 512 * (rect.height || size)), size)
    }
    if (typeof (target as Element).getBoundingClientRect === 'function') {
      const el = target as Element
      if (!el.isConnected) return null
      const rect = el.getBoundingClientRect()
      const offset = options.offset ?? 0
      const inset = Math.min(rect.width / 2, this.sizeAt(1) * 0.42)
      const edge = options.edge ?? 'top'
      const x = edge === 'left' ? rect.left + inset : edge === 'right' ? rect.right - inset : rect.left + rect.width / 2
      return v(x + offset, rect.top)
    }
    const point = target as { x: number; y: number }
    return v(point.x, point.y)
  }
  private scroller?: { target: unknown; el: Element | null }
  private withinScroller(point: Vec): boolean {
    const target = this.goal?.target as Element | undefined
    if (!target || typeof target.getBoundingClientRect !== 'function') return true
    if (this.scroller?.target !== target) {
      let el = target.parentElement
      const view = this.h.doc.defaultView
      while (el && view && !/(auto|scroll|hidden)/.test(view.getComputedStyle(el).overflowY)) el = el.parentElement
      this.scroller = { target, el }
    }
    const el = this.scroller.el
    if (!el) return true
    const r = el.getBoundingClientRect()
    return point.x >= r.left && point.x <= r.right && point.y >= r.top - 2 && point.y <= r.bottom
  }
  /** A home slot scrolled out of its list (a sidebar row) takes off from, and lands back on, the list's nearest edge. */
  private homeEdge(feet: Vec, size: number): Vec {
    const box = visibleBounds(this.h.host)
    if (!box) return feet
    const [, fy] = this.h.feet()
    const above = fy / 512 * size
    return v(clamp(feet.x, box.left, box.right), clamp(feet.y, Math.min(box.bottom, box.top + above), box.bottom))
  }
  private sizeAt(fraction: number) {
    const { from, to, peak } = this.sizes
    const base = from + (to - from) * fraction
    return peak ? base + (peak - base) * Math.sin(Math.PI * clamp(fraction, 0, 1)) : base
  }

  private beginCruise() {
    const goal = this.goal
    const p3 = this.targetPoint()
    if (!goal || !p3) return this.snapHome('aborted')
    const options = goal.options
    const speed = Math.max(60, options.speed ?? 520)
    this.start = { ...this.pos }
    this.offsets = pathOffsets(options.path ?? 'arc', this.start, p3)
    const current = len(this.vel)
    if (current > 30) {
      // Re-target mid-air: leave along the current velocity so the path has no corner.
      const lead = Math.max(len(this.offsets[0]) * 0.6, current * 0.3)
      this.offsets[0] = scale(this.vel, lead / current)
    }
    this.path = new ArcPath(this.start, add(this.start, this.offsets[0]), add(p3, this.offsets[1]), p3)
    this.clampControls(this.path)
    this.duration = Math.max(0.5, this.path.length / speed + 0.2)
    this.m0 = clamp(current * this.duration / Math.max(1, this.path.length), 0, 3)
    this.progress = 0
    const home = this.h.homeSize()
    this.sizes = { from: this.renderSize || home, to: goal.home ? home : options.landSize ?? (this.renderSize || home), peak: options.size ?? 0 }
    this.phase = 'cruise'
    this.cruiseClip = options.cruise ?? 'fly'
    if (this.h.hasClip(this.cruiseClip)) void this.h.play(this.cruiseClip, { mode: 'replace', loop: true })
    this.listenResize()
  }
  /** Keep control points inside the window so loops and swoops stay on screen. */
  private clampControls(path: ArcPath) {
    const win = this.h.doc.defaultView
    if (!win) return
    const margin = Math.min(80, this.renderSize)
    const w = win.innerWidth || 1024
    const hgt = win.innerHeight || 768
    const fit = (p: Vec) => v(clamp(p.x, margin, Math.max(margin, w - margin)), clamp(p.y, margin, Math.max(margin, hgt - margin / 2)))
    path.set(path.p0, fit(path.p1), fit(path.p2), path.p3)
  }

  private detach() {
    const stage = this.stage ??= acquireStage(this.h.doc)
    const rect = this.h.svg.getBoundingClientRect()
    const size = rect.width || this.h.homeSize()
    const [fx, fy] = this.h.feet()
    this.renderSize = size
    this.pos = this.homeEdge(v(rect.left + fx / 512 * size, rect.top + fy / 512 * (rect.height || size)), size)
    this.vel = v(0, 0)
    this.bank = spring(0)
    const container = this.container ??= this.h.doc.createElement('div')
    container.setAttribute('data-mascot-flight', '')
    container.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;pointer-events:none'
    for (const [key, value] of Object.entries(this.h.palette())) container.style.setProperty(key, value)
    const shadow = this.shadow ??= this.h.doc.createElement('div')
    shadow.setAttribute('data-mascot-shadow', '')
    shadow.style.cssText = 'position:absolute;left:0;top:0;border-radius:50%;opacity:0;pointer-events:none;' +
      'background:radial-gradient(closest-side, rgba(0,0,0,.38), rgba(0,0,0,0))'
    stage.flights.append(shadow, container)
    container.append(this.h.svg)
    this.h.svg.style.width = '100%'
    this.h.svg.style.height = '100%'
    if (!this.placeholder) {
      const placeholder = this.h.doc.createElement('span')
      placeholder.setAttribute('data-mascot-away', '')
      placeholder.style.cssText = 'display:block;width:100%;height:100%;opacity:.9'
      placeholder.innerHTML = PLACEHOLDER
      this.placeholder = placeholder
    }
    if (!this.placeholder.isConnected) this.h.host.append(this.placeholder)
    this.place()
  }
  private place(groundY?: number) {
    const c = this.container
    if (!c) return
    const size = this.renderSize
    const [fx, fy] = this.h.feet()
    const ox = fx / 512 * size
    const oy = fy / 512 * size
    c.style.width = `${size}px`
    c.style.height = `${size}px`
    c.style.transformOrigin = `${ox}px ${oy}px`
    c.style.transform = `translate3d(${(this.pos.x - ox).toFixed(2)}px, ${(this.pos.y - oy).toFixed(2)}px, 0) rotate(${this.bank.value.toFixed(2)}deg)`
    c.style.opacity = this.phase === 'fade-out' ? String(1 - clamp(this.timer / 0.16, 0, 1))
      : this.phase === 'fade-in' ? String(clamp(this.timer / 0.16, 0, 1)) : ''
    const s = this.shadow
    if (!s) return
    if (groundY === undefined) { s.style.opacity = '0'; return }
    const height = Math.max(0, groundY - this.pos.y)
    const k = clamp(1 - height / 420, 0.3, 1)
    const w = size * 0.5 * k
    s.style.width = `${w}px`
    s.style.height = `${w * 0.22}px`
    s.style.transform = `translate3d(${(this.pos.x - w / 2).toFixed(2)}px, ${(groundY - w * 0.11).toFixed(2)}px, 0)`
    s.style.opacity = (0.55 * k).toFixed(3)
  }

  update(dt: number) {
    if (this.phase === 'home' || dt <= 0) return
    const goal = this.goal
    switch (this.phase) {
      case 'fade-out': {
        this.timer += dt
        if (this.timer >= 0.16) {
          const p3 = this.targetPoint()
          if (!p3) return this.snapHome('aborted')
          this.pos = p3
          if (goal) this.sizes = { from: this.renderSize, to: goal.home ? this.h.homeSize() : goal.options.landSize ?? this.renderSize, peak: 0 }
          this.renderSize = this.sizes.to || this.renderSize
          this.phase = 'fade-in'
          this.timer = 0
        }
        this.place()
        return
      }
      case 'fade-in': {
        this.timer += dt
        this.place()
        if (this.timer >= 0.16) this.arrive()
        return
      }
      case 'takeoff': {
        this.place(this.pos.y)
        return
      }
      case 'cruise': {
        const path = this.path!
        const p3 = this.targetPoint()
        if (!p3) return this.snapHome('aborted')
        if (p3.x !== path.p3.x || p3.y !== path.p3.y) path.set(path.p0, path.p1, add(p3, this.offsets[1]), p3)
        this.progress = Math.min(1, this.progress + dt / this.duration)
        const fraction = hermite(this.progress, this.m0)
        const next = path.at(fraction)
        this.vel = scale(sub(next, this.pos), 1 / dt)
        this.pos = next
        this.renderSize = this.sizeAt(fraction)
        const speed = Math.max(60, goal?.options.speed ?? 520)
        this.bank.target = clamp(this.vel.x / speed * 20, -26, 26)
        stepSpring(this.bank, dt, { stiffness: 70, damping: 13 })
        this.flap(speed)
        this.trail(dt, speed)
        this.place(path.p0.y + (p3.y - path.p0.y) * fraction)
        if (this.progress >= 1) this.land()
        return
      }
      case 'landing': {
        this.bank.target = 0
        stepSpring(this.bank, dt, { stiffness: 90, damping: 16 })
        const p3 = this.targetPoint()
        if (p3) this.pos = p3
        this.place(this.pos.y)
        return
      }
      case 'perched': {
        if (this.perchBox) {
          if (!this.perchBox.isConnected) return this.snapHome('aborted')
          return
        }
        const p3 = this.targetPoint()
        if (!p3) { void this.goHome(); return }
        this.pos = p3
        this.place()
        // A tracked perch inside a scroller hides while its target is scrolled out of view.
        if (this.container) this.container.style.visibility = this.withinScroller(p3) ? '' : 'hidden'
        return
      }
      case 'dwell': {
        this.timer += dt
        if (this.timer * 1000 >= (goal?.options.dwell ?? 900)) void this.goHome(goal?.options)
        return
      }
      case 'away':
        return
    }
  }
  /** Climbing flaps faster, descending glides. */
  private flap(speed: number) {
    const glide = this.goal?.options.glide ?? 'glide'
    const vy = this.vel.y / speed
    if (vy > 0.45 && this.cruiseClip !== glide && this.h.hasClip(glide)) {
      this.cruiseClip = glide
      void this.h.play(glide, { mode: 'replace', loop: true })
    } else if (vy < 0.15 && this.cruiseClip === glide) {
      this.cruiseClip = this.goal?.options.cruise ?? 'fly'
      if (this.h.hasClip(this.cruiseClip)) void this.h.play(this.cruiseClip, { mode: 'replace', loop: true })
    }
    if (this.cruiseClip !== glide) this.h.setClipSpeed(this.cruiseClip, clamp(1 - vy * 0.9, 0.75, 1.9))
  }
  private trail(dt: number, speed: number) {
    const v = len(this.vel)
    this.windClock += dt
    if (v < speed * 0.55 || this.windClock < 0.07) return
    this.windClock = 0
    const heading = Math.atan2(this.vel.y, this.vel.x) * 180 / Math.PI
    const back = scale(this.vel, -0.06)
    const body = this.pos.y - this.renderSize * 0.42
    this.h.emitAt('wind', this.pos.x + back.x, body + back.y, heading, this.renderSize)
    if (v > speed * 1.15) this.h.emitAt('trail', this.pos.x + back.x * 0.5, body + back.y * 0.5, heading, this.renderSize)
  }
  private land() {
    this.phase = 'landing'
    this.vel = v(0, 0)
    const name = this.goal?.options.land ?? 'land'
    if (!this.h.hasClip(name)) return this.arrive()
    void this.h.play(name, { mode: 'replace', onEnd: () => { if (this.phase === 'landing') this.arrive() } })
  }
  private arrive() {
    const goal = this.goal
    this.unlistenResize()
    this.bank = spring(0)
    if (!goal) return this.snapHome('aborted')
    if (goal.home) return this.rehome('arrived')
    const target = goal.target
    const element = typeof (target as Element).getBoundingClientRect === 'function' ? target as HTMLElement : null
    const perch = goal.options.perch ?? Boolean(element?.hasAttribute?.('data-mascot-perch'))
    if (element && perch) {
      this.phase = 'perched'
      if (element.hasAttribute('data-mascot-perch')) this.reparent(element)
      else this.place()
    } else this.phase = 'away'
    this.place()
    const returnHome = goal.options.returnHome
    this.settle('arrived')
    if (returnHome) {
      this.goal = { ...goal, settled: true }
      this.phase = 'dwell'
      this.timer = 0
    }
  }
  /** Re-parent into an opted-in perch so the mascot scrolls with it. */
  private reparent(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const view = this.h.doc.defaultView
    const position = view?.getComputedStyle(element).position ?? ''
    if (!position || position === 'static') {
      this.perchHost = { el: element, position: element.style.position }
      element.style.position = 'relative'
    }
    const size = this.renderSize
    const [fx, fy] = this.h.feet()
    const box = this.perchBox ??= this.h.doc.createElement('span')
    box.setAttribute('data-mascot-perched', '')
    box.style.cssText = `position:absolute;pointer-events:none;z-index:5;width:${size}px;height:${size}px;` +
      `left:${(this.pos.x - rect.left - element.clientLeft - fx / 512 * size).toFixed(2)}px;` +
      `top:${(this.pos.y - rect.top - element.clientTop - fy / 512 * size).toFixed(2)}px`
    for (const [key, value] of Object.entries(this.h.palette())) box.style.setProperty(key, value)
    box.append(this.h.svg)
    element.append(box)
    this.container?.remove()
    this.shadow?.remove()
  }
  /** Leave a perch: put the svg back on the stage at its current on-screen position. */
  private unperch() {
    if (this.container) this.container.style.visibility = ''
    if (!this.perchBox) return
    const rect = this.h.svg.getBoundingClientRect()
    const [fx, fy] = this.h.feet()
    const size = rect.width || this.renderSize
    this.pos = v(rect.left + fx / 512 * size, rect.top + fy / 512 * (rect.height || size))
    const stage = this.stage ??= acquireStage(this.h.doc)
    stage.flights.append(this.shadow!, this.container!)
    this.container!.append(this.h.svg)
    this.perchBox.remove()
    this.perchBox = undefined
    if (this.perchHost) {
      this.perchHost.el.style.position = this.perchHost.position
      this.perchHost = undefined
    }
    this.place()
  }

  goHome(options: FlightOptions = {}): Promise<FlightResult> {
    if (this.phase === 'home') return Promise.resolve('arrived')
    this.unperch()
    const { returnHome: _r, dwell: _d, ...rest } = options
    return this.flyTo(this.h.host, { path: 'arc', ...rest, perch: false }, true)
  }
  private rehome(result: FlightResult) {
    this.unlistenResize()
    if (this.perchBox) this.unperch()
    this.placeholder?.remove()
    this.h.host.append(this.h.svg)
    this.container?.remove()
    this.shadow?.remove()
    this.h.restoreSize()
    this.phase = 'home'
    this.vel = v(0, 0)
    this.bank = spring(0)
    if (this.key && flying.get(this.key) === this) flying.delete(this.key)
    if (this.stage) { releaseStage(this.stage); this.stage = undefined }
    this.settle(result)
  }
  /** Abort without a path: straight back into the home slot. */
  snapHome(result: FlightResult = 'aborted') {
    if (this.phase === 'home') return this.settle(result)
    this.h.stopClips()
    this.rehome(result)
  }
  private settle(result: FlightResult) {
    const goal = this.goal
    if (goal && !goal.settled) { goal.settled = true; goal.resolve(result) }
  }
  private listenResize() {
    if (this.resizeOff) return
    const win = this.h.doc.defaultView
    if (!win) return
    const abort = () => { if (this.airborne) this.snapHome('aborted') }
    win.addEventListener('resize', abort)
    this.resizeOff = () => win.removeEventListener('resize', abort)
  }
  private unlistenResize() { this.resizeOff?.(); this.resizeOff = undefined }
  /** The document was hidden: flights abort cleanly; perches stay. */
  hidden() { if (this.airborne) this.snapHome('aborted') }
  destroy() {
    this.unlistenResize()
    this.settle('interrupted')
    if (this.perchHost) this.perchHost.el.style.position = this.perchHost.position
    this.perchBox?.remove()
    this.container?.remove()
    this.shadow?.remove()
    this.placeholder?.remove()
    if (this.key && flying.get(this.key) === this) flying.delete(this.key)
    if (this.stage) releaseStage(this.stage)
    this.stage = undefined
    this.phase = 'home'
  }
}
