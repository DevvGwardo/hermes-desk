import { ease } from './ease'
import type { Ease } from './ease'
import { POSE_PROPS } from './types'
import type { ClipSpec, EventKey, FxKey, MouthKey, PlayOptions, PlayResult, PoseProp, ShowKey } from './types'

export interface Channel { t: number[]; v: number[]; e: Ease[] }
export const ROOT_PROPS = ['x', 'y', 'rotate', 'sx', 'sy'] as const
export type RootProp = typeof ROOT_PROPS[number]
export interface CompiledClip {
  name: string
  spec: ClipSpec
  duration: number
  loop: boolean
  blendIn: number
  blendOut: number
  mode: 'override' | 'additive'
  springScale: number
  parts: Map<string, Partial<Record<PoseProp, Channel>>>
  root: Partial<Record<RootProp, Channel>>
  show: ShowKey[]
  mouth: MouthKey[]
  look: { x: Channel; y: Channel } | null
  lid: Channel | null
  fx: FxKey[]
  events: EventKey[]
}

const byTime = <T extends { t: number }>(keys: T[] = []) => [...keys].sort((a, b) => a.t - b.t)
/** One channel per property, built only from keys that set it, so missing keys hold. */
function channel<K extends { t: number; ease?: string }>(keys: K[], read: (key: K) => number | undefined): Channel | undefined {
  const t: number[] = []
  const v: number[] = []
  const e: Ease[] = []
  for (const key of keys) {
    const value = read(key)
    if (value === undefined || !Number.isFinite(value)) continue
    t.push(key.t); v.push(value); e.push(ease(key.ease))
  }
  return t.length ? { t, v, e } : undefined
}
export function sampleChannel(ch: Channel, time: number): number {
  const { t, v, e } = ch
  if (time <= t[0]) return v[0]
  const last = t.length - 1
  if (time >= t[last]) return v[last]
  let i = 0
  while (i < last && time >= t[i + 1]) i++
  const span = t[i + 1] - t[i]
  const u = span > 0 ? (time - t[i]) / span : 1
  return v[i] + (v[i + 1] - v[i]) * e[i + 1](u)
}
const normalize = (name: string) => name.replace(/^part-/, '')

export function compileClip(name: string, spec: ClipSpec): CompiledClip {
  if (!(spec.duration > 0)) throw new Error(`Clip ${name} needs a positive duration`)
  const parts = new Map<string, Partial<Record<PoseProp, Channel>>>()
  for (const [part, raw] of Object.entries(spec.tracks.parts ?? {})) {
    const keys = byTime(raw)
    const channels: Partial<Record<PoseProp, Channel>> = {}
    for (const prop of POSE_PROPS) {
      const ch = channel(keys, key => key[prop])
      if (ch) channels[prop] = ch
    }
    parts.set(normalize(part), channels)
  }
  const rootKeys = byTime(spec.tracks.root)
  const root: Partial<Record<RootProp, Channel>> = {}
  for (const prop of ROOT_PROPS) {
    const ch = channel(rootKeys, key => key[prop])
    if (ch) root[prop] = ch
  }
  const eyes = byTime(spec.tracks.eyes)
  const lookX = channel(eyes, key => key.look?.[0])
  const lookY = channel(eyes, key => key.look?.[1])
  return {
    name, spec,
    duration: spec.duration,
    loop: Boolean(spec.loop),
    blendIn: Math.max(0, spec.blendIn ?? 0.12),
    blendOut: Math.max(0, spec.blendOut ?? 0.18),
    mode: spec.mode ?? 'override',
    springScale: Math.max(1, spec.springScale ?? 4),
    parts, root,
    show: byTime(spec.tracks.show),
    mouth: byTime(spec.tracks.mouth),
    look: lookX && lookY ? { x: lookX, y: lookY } : null,
    lid: channel(eyes, key => key.lid) ?? null,
    fx: byTime(spec.tracks.fx),
    events: byTime(spec.tracks.events),
  }
}
export function compileClips(specs: Record<string, ClipSpec> = {}): Record<string, CompiledClip> {
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, compileClip(name, spec)]))
}

export interface Layer {
  clip: CompiledClip
  speed: number
  loop: boolean
  /** Unwrapped local time in clip seconds. */
  elapsed: number
  /** Wrapped local time used for sampling. */
  local: number
  age: number
  weight: number
  out: { age: number; from: number } | null
  done: boolean
  resolve: (result: PlayResult) => void
  onEvent?: (name: string) => void
}
export interface ClipHost {
  event(layer: Layer, name: string): void
  fx(layer: Layer, key: FxKey): void
  next(layer: Layer, next: string): void
}
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

/** Deterministic layered clip playback, advanced by the engine's own clock. */
export class ClipPlayer {
  layers: Layer[] = []
  private queued: Array<{ clip: CompiledClip; options: PlayOptions; resolve: (r: PlayResult) => void }> = []
  private library: Record<string, CompiledClip>
  private host: ClipHost
  constructor(library: Record<string, CompiledClip>, host: ClipHost) {
    this.library = library
    this.host = host
  }
  has(name: string) { return Boolean(this.library[name]) }
  names() { return Object.keys(this.library) }
  get(name: string): CompiledClip | undefined { return this.library[name] }
  /** True while any non-looping clip is still playing (not merely fading). */
  get busy() { return this.layers.some(l => !l.out && !l.done && !l.loop) || this.queued.length > 0 }
  get active() { return this.layers.length > 0 }
  playing(name: string) { return this.layers.some(l => l.clip.name === name && !l.out) }

  play(name: string, options: PlayOptions = {}): Promise<PlayResult> {
    const clip = this.library[name]
    if (!clip) { options.onEnd?.('interrupted'); return Promise.resolve('interrupted') }
    return new Promise(settle => {
      const resolve = (result: PlayResult) => { options.onEnd?.(result); settle(result) }
      if (options.mode === 'queue' && this.busy) this.queued.push({ clip, options, resolve })
      else this.start(clip, options, resolve)
    })
  }
  private start(clip: CompiledClip, options: PlayOptions, resolve: (r: PlayResult) => void) {
    if (options.mode !== 'layer') {
      for (const layer of this.layers) this.fade(layer)
      // A replace cancels anything that was waiting behind the old clips.
      if (options.mode !== 'queue') for (const q of this.queued.splice(0)) q.resolve('interrupted')
    }
    const layer: Layer = {
      clip, speed: Math.max(0.05, options.speed ?? 1), loop: options.loop ?? clip.loop,
      elapsed: 0, local: 0, age: 0, weight: clip.blendIn > 0 ? 0 : 1, out: null, done: false,
      resolve, onEvent: options.onEvent,
    }
    this.layers.push(layer)
    this.fire(layer, -1e-9, 0)
  }
  private fade(layer: Layer) {
    if (layer.out) return
    layer.out = { age: 0, from: layer.weight }
    if (!layer.done) { layer.done = true; layer.resolve('interrupted') }
  }
  stop(name?: string) {
    for (const layer of this.layers) if (!name || layer.clip.name === name) this.fade(layer)
    for (const q of this.queued.filter(q => !name || q.clip.name === name)) q.resolve('interrupted')
    this.queued = this.queued.filter(q => name && q.clip.name !== name)
  }
  setSpeed(name: string, speed: number) {
    for (const layer of this.layers) if (layer.clip.name === name && !layer.out) layer.speed = Math.max(0.05, speed)
  }
  /** Fire events and fx whose times fall in (from, to] of unwrapped local time. */
  private fire(layer: Layer, from: number, to: number) {
    const { clip } = layer
    if (!clip.events.length && !clip.fx.length) return
    const d = clip.duration
    const first = layer.loop ? Math.floor(Math.max(0, from) / d) : 0
    const last = layer.loop ? Math.floor(to / d) : 0
    for (let cycle = first; cycle <= last; cycle++) {
      const base = cycle * d
      for (const key of clip.fx) if (base + key.t > from && base + key.t <= to) this.host.fx(layer, key)
      for (const key of clip.events) {
        if (base + key.t > from && base + key.t <= to) {
          layer.onEvent?.(key.name)
          this.host.event(layer, key.name)
        }
      }
    }
  }
  update(dt: number) {
    for (const layer of [...this.layers]) {
      layer.age += dt
      if (layer.out) {
        layer.out.age += dt
        const u = layer.clip.blendOut > 0 ? layer.out.age / layer.clip.blendOut : 1
        layer.weight = layer.out.from * (1 - smooth(u))
        if (u >= 1) this.layers.splice(this.layers.indexOf(layer), 1)
        continue
      }
      layer.weight = layer.clip.blendIn > 0 ? smooth(layer.age / layer.clip.blendIn) : 1
      if (layer.done) continue
      const before = layer.elapsed
      layer.elapsed += dt * layer.speed
      const { duration } = layer.clip
      if (!layer.loop && layer.elapsed >= duration) {
        this.fire(layer, before, duration)
        layer.local = duration
        layer.done = true
        layer.resolve('done')
        const next = layer.clip.spec.next
        if (next) this.host.next(layer, next)
        // Hold the final frame while it fades, unless something replaced it already.
        if (!next || !this.library[next]) this.fade(layer)
        continue
      }
      this.fire(layer, before, layer.elapsed)
      layer.local = layer.loop ? layer.elapsed % duration : layer.elapsed
    }
    if (this.queued.length && !this.layers.some(l => !l.out && !l.done && !l.loop)) {
      const { clip, options, resolve } = this.queued.shift()!
      this.start(clip, { ...options, mode: 'replace' }, resolve)
    }
  }
  /** Most recent value at or before local time from a step track. */
  static step<T extends { t: number }>(keys: T[], local: number): T | undefined {
    let hit: T | undefined
    for (const key of keys) { if (key.t <= local) hit = key; else break }
    return hit
  }
  clear() {
    for (const layer of this.layers) if (!layer.done) layer.resolve('interrupted')
    for (const q of this.queued) q.resolve('interrupted')
    this.layers = []
    this.queued = []
  }
}
