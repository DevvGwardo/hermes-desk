import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutonomousBehaviors, isDrowsy, seededRandom } from './behaviors'
import { compileClip, sampleChannel } from './clips'
import { cueMascot, PENDING_DELIVERY_MS, registerMascot, resetMascotCues, retryPending } from './cues'
import { ease, EASE_NAMES } from './ease'
import { createMascot } from './engine'
import { ArcPath, hermite, pathOffsets } from './flight'
import { ManualFrameClock } from './frame-clock'
import { INSTANCE_PARTICLE_CAP, ParticleEmitter } from './fx/particles'
import { acquireStage, releaseStage, STAGE_PARTICLE_CAP } from './fx/stage'
import { characters } from './registry'
import type { ClipSpec, MascotHandle, MascotOptions } from './types'

const owl = characters.owl
const originalOwlClips = [
  'takeoff', 'fly', 'glide', 'hover', 'land',
  'hop', 'walk', 'peek', 'head-swivel', 'preen', 'stretch', 'shake-off',
  'blink-double', 'hoot', 'celebrate', 'dizzy', 'deliver',
]
const handles: MascotHandle[] = []
let clock: ManualFrameClock
const rects = new WeakMap<Element, DOMRect>()
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect
function place(el: Element, x: number, y: number, w: number, h: number) { rects.set(el, rect(x, y, w, h)) }

beforeEach(() => {
  clock = new ManualFrameClock()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  // Home slots, targets and the svg (while at home) report fixed layout; everything else follows its slot.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const own = rects.get(this)
    if (own) return own
    const slot = this.closest('[data-test-slot]')
    return slot && rects.get(slot) ? rects.get(slot)! : rect(0, 0, 0, 0)
  })
})
afterEach(() => {
  for (const h of handles.splice(0)) h.destroy()
  document.body.replaceChildren()
  resetMascotCues()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount(options: Partial<MascotOptions> = {}, at: [number, number, number] = [100, 500, 160]) {
  const el = document.createElement('span')
  el.setAttribute('data-test-slot', '')
  document.body.append(el)
  place(el, at[0], at[1], at[2], at[2])
  const handle = createMascot(el, { svg: owl.svg, motion: owl.motion, clips: owl.clips, clock, size: at[2], seed: 'v2', ...options })
  handles.push(handle)
  return { el, handle, svg: () => document.querySelector<SVGSVGElement>(`svg[data-mascot-state]`)!, part: (n: string) => el.ownerDocument.querySelector<SVGGElement>(`[data-mascot-part="${n}"]`)! }
}
const flightBox = () => document.querySelector<HTMLElement>('[data-mascot-flight]')
function flightPos() {
  const t = flightBox()!.style.transform
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(t)!
  return [Number(m[1]), Number(m[2])]
}

describe('eases', () => {
  it('every named ease and spring() lands exactly on 0 and 1', () => {
    for (const name of [...EASE_NAMES, 'spring(170,12)', 'spring(60,4)', 'unknown']) {
      expect(ease(name)(0), name).toBeCloseTo(0, 6)
      expect(ease(name)(1), name).toBeCloseTo(1, 6)
    }
    expect(ease('outBack')(0.6)).toBeGreaterThan(1)
  })
})

describe('clips', () => {
  const spec: ClipSpec = {
    duration: 1,
    tracks: {
      parts: { head: [{ t: 0, rotate: 0 }, { t: 0.5, rotate: 40, ease: 'linear' }, { t: 1, ty: 10 }] },
      root: [{ t: 0, y: 0 }, { t: 0.5, y: -50, ease: 'linear' }, { t: 1, y: 0, ease: 'linear' }],
      events: [{ t: 0.25, name: 'a' }, { t: 0.75, name: 'b' }],
    },
  }
  it('compiles channels per property and holds missing keys', () => {
    const clip = compileClip('t', spec)
    const rotate = clip.parts.get('head')!.rotate!
    expect(sampleChannel(rotate, 0.25)).toBeCloseTo(20)
    expect(sampleChannel(rotate, 0.9)).toBe(40) // later key only sets ty: rotate holds
    expect(clip.parts.get('head')!.ty!.t).toEqual([1])
  })
  it('plays deterministically, fires events in order, and resolves done', async () => {
    const a = mount({ clips: { t: spec }, idPrefix: 'g' })
    const b = mount({ clips: { t: spec }, idPrefix: 'g' })
    const events: string[] = []
    const done = a.handle.play('t', { onEvent: e => events.push(e) })
    void b.handle.play('t')
    for (let i = 0; i < 20; i++) {
      clock.advance(70)
      expect(a.el.innerHTML).toBe(b.el.innerHTML)
    }
    expect(events).toEqual(['a', 'b'])
    await expect(done).resolves.toBe('done')
  })
  it('applies root tracks to the motion root and returns to identity', () => {
    const { el, handle } = mount({ clips: { t: spec } })
    void handle.play('t')
    clock.advance(500)
    const root = el.querySelector('[data-mascot-motion-root]')!
    expect(root.getAttribute('transform')).toMatch(/^translate\(0 -50\)/)
    clock.advance(2000)
    expect(root.hasAttribute('transform')).toBe(false)
  })
  it('replace interrupts, queue waits, loops run until stopped', async () => {
    const loop: ClipSpec = { duration: 0.3, loop: true, tracks: { parts: { head: [{ t: 0, rotate: 5 }] } } }
    const { handle } = mount({ clips: { t: spec, loop } })
    const first = handle.play('t')
    const queued = handle.play('t', { mode: 'queue' })
    clock.advance(1100)
    await expect(first).resolves.toBe('done')
    const replaced = handle.play('loop')
    await expect(queued).resolves.toBe('interrupted')
    let settled = false
    void replaced.then(() => { settled = true })
    clock.advance(3000)
    await Promise.resolve()
    expect(settled).toBe(false)
    handle.stop('loop')
    await expect(replaced).resolves.toBe('interrupted')
  })
  it('state enter clips play on a real state change and next hands back to a state', async () => {
    const { svg, handle } = mount()
    handle.setState('happy')
    clock.advance(400)
    // celebrate hops the whole rig
    expect(svg().querySelector('[data-mascot-motion-root]')!.getAttribute('transform')).toBeTruthy()
    const toState = mount({ clips: { go: { duration: 0.2, next: 'sleep', tracks: {} } } })
    const played = toState.handle.play('go')
    clock.advance(400)
    await expect(played).resolves.toBe('done')
    expect(toState.el.querySelector('svg')!.dataset.mascotState).toBe('sleep')
  })
  it('peek masks the rig at its feet line only while playing', () => {
    const { el, handle } = mount()
    void handle.play('peek')
    clock.advance(500)
    const mask = el.querySelector('[data-mascot-mask]')!
    expect(mask.getAttribute('clip-path')).toMatch(/^url\(#.+-mascot-frame\)$/)
    clock.advance(3500)
    expect(mask.hasAttribute('clip-path')).toBe(false)
  })
  it('reduced motion skips choreography but still fires events', async () => {
    const { handle } = mount({ reducedMotion: true })
    const events: string[] = []
    await expect(handle.play('takeoff', { onEvent: e => events.push(e) })).resolves.toBe('done')
    expect(events).toEqual(['airborne'])
  })
  it('every owl clip compiles and references real parts and particle types', () => {
    const parts = new Set([...owl.svg.matchAll(/id="part-([\w-]+)"/g)].map(m => m[1]))
    expect(Object.keys(owl.clips)).toEqual(expect.arrayContaining(originalOwlClips))
    for (const [name, clip] of Object.entries(owl.clips)) {
      const compiled = compileClip(name, clip)
      for (const part of compiled.parts.keys()) expect(parts.has(part), `${name}:${part}`).toBe(true)
      for (const key of clip.tracks.fx ?? []) expect(['feet', ...parts]).toContain(key.anchor ?? 'head')
    }
    for (const state of Object.values(owl.motion.states)) {
      for (const ref of [state.enter, state.loop, state.exit]) if (ref) expect(owl.clips[ref], ref).toBeTruthy()
    }
    for (const reaction of Object.values(owl.motion.reactions ?? {})) if (reaction.clip) expect(owl.clips[reaction.clip]).toBeTruthy()
  })
  it.each(originalOwlClips)('plays the original %s clip at sidebar and full size', async name => {
    for (const size of [40, 160]) {
      const options = { reducedMotion: false, autonomy: false }
      const animated = mount(options, [100, 500, size])
      const idle = mount(options, [100, 500, size])
      const snapshot = (el: HTMLElement) => [...el.querySelectorAll('[data-mascot-motion-root], [data-mascot-part]')]
        .map(part => part.getAttribute('transform')).join('|')
      const played = animated.handle.play(name, { loop: false })
      let changed = false
      for (let i = 0; i < 8; i++) {
        clock.advance(owl.clips[name].duration * 1000 / 10)
        const frame = snapshot(animated.el)
        expect(frame).not.toMatch(/NaN|Infinity/)
        if (frame !== snapshot(idle.el)) changed = true
      }
      expect(changed, `${name} at ${size}px must change the rendered pose`).toBe(true)
      clock.advance(owl.clips[name].duration * 1000 + 1000)
      await expect(played).resolves.toBe('done')
      animated.handle.destroy()
      idle.handle.destroy()
    }
  })
})

describe('stage flight', () => {
  function target(x: number, y: number, w = 240, h = 120, perch = true) {
    const el = document.createElement('div')
    if (perch) el.setAttribute('data-mascot-perch', '')
    document.body.append(el)
    place(el, x, y, w, h)
    return el
  }
  it('leaves home for the stage overlay, shows an empty perch, and lands with feet on the edge', async () => {
    const { el, handle } = mount()
    const card = target(700, 200)
    const arrived = handle.flyTo(card, { speed: 600 })
    clock.advance(30)
    expect(document.getElementById('mascot-stage')).toBeTruthy()
    expect(el.querySelector('[data-mascot-away]')).toBeTruthy()
    expect(handle.location()).toBe('flying')
    let last = flightPos()
    let maxStep = 0
    for (let i = 0; i < 240 && handle.location() === 'flying'; i++) {
      clock.advance(1000 / 60)
      if (!flightBox()?.isConnected) break
      const next = flightPos()
      maxStep = Math.max(maxStep, Math.hypot(next[0] - last[0], next[1] - last[1]))
      last = next
    }
    await expect(arrived).resolves.toBe('arrived')
    expect(maxStep).toBeLessThan(600 * 1.6 / 60 + 4) // no teleports: bounded by peak speed per frame
    expect(handle.location()).toBe('perched')
    const box = card.querySelector<HTMLElement>('[data-mascot-perched]')!
    expect(box).toBeTruthy()
    // Feet (root pivot y = 444/512) sit within 2px of the perch's top edge.
    const feet = parseFloat(box.style.top) + 444 / 512 * parseFloat(box.style.height)
    expect(Math.abs(feet)).toBeLessThan(2)
    expect(card.style.position).toBe('relative')
  })
  it('re-targets mid-air without a corner or teleport, then flies home', async () => {
    const { el, handle } = mount()
    const first = handle.flyTo(target(900, 100), { speed: 600 })
    clock.advance(700)
    let last = flightPos()
    const second = handle.flyTo({ x: 300, y: 150 }, { speed: 600 })
    await expect(first).resolves.toBe('interrupted')
    let maxStep = 0
    for (let i = 0; i < 200 && handle.location() === 'flying'; i++) {
      clock.advance(1000 / 60)
      const next = flightPos()
      maxStep = Math.max(maxStep, Math.hypot(next[0] - last[0], next[1] - last[1]))
      last = next
    }
    await expect(second).resolves.toBe('arrived')
    expect(maxStep).toBeLessThan(600 * 1.6 / 60 + 4)
    expect(handle.location()).toBe('away')
    const home = handle.goHome({ speed: 900 })
    clock.advance(4000)
    await expect(home).resolves.toBe('arrived')
    expect(handle.location()).toBe('home')
    expect(el.querySelector('svg')).toBeTruthy()
    expect(el.querySelector('[data-mascot-away]')).toBeNull()
    expect(document.querySelector('[data-mascot-flight]')).toBeNull()
  })
  it('returnHome dwells on the target and comes back', async () => {
    const { el, handle } = mount()
    const arrived = handle.flyTo(target(600, 300), { speed: 800, returnHome: true, dwell: 300 })
    clock.advance(3000)
    await expect(arrived).resolves.toBe('arrived')
    clock.advance(4000)
    expect(handle.location()).toBe('home')
    expect(el.querySelector('svg')).toBeTruthy()
  })
  it('aborts cleanly on resize and when the document hides', async () => {
    const { el, handle } = mount()
    const flight = handle.flyTo(target(800, 100), { speed: 300 })
    clock.advance(800)
    window.dispatchEvent(new Event('resize'))
    await expect(flight).resolves.toBe('aborted')
    expect(handle.location()).toBe('home')
    expect(el.querySelector('svg')).toBeTruthy()
    const again = handle.flyTo(target(800, 100), { speed: 300 })
    clock.advance(800)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await expect(again).resolves.toBe('aborted')
  })
  it('reduced motion fades out and in at the destination without a path', async () => {
    const { handle } = mount({ reducedMotion: true })
    const card = target(700, 200)
    const flight = handle.flyTo(card)
    clock.advance(80)
    expect(Number(flightBox()!.style.opacity)).toBeLessThan(1)
    const before = flightPos()
    clock.advance(120)
    const after = flightPos()
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeGreaterThan(300) // jumped, no path
    clock.advance(300)
    await expect(flight).resolves.toBe('arrived')
  })
  it('one stage flight per key: a second instance sends the first home', async () => {
    const a = mount({ stageKey: 'agent:x' }, [100, 500, 40])
    const b = mount({ stageKey: 'agent:x' }, [100, 600, 40])
    const first = a.handle.flyTo({ x: 600, y: 300 })
    clock.advance(500)
    void b.handle.flyTo({ x: 700, y: 300 })
    await expect(first).resolves.toBe('interrupted')
    expect(a.handle.location()).toBe('home')
  })
  it('path helpers: arc length table and hermite progress', () => {
    const path = new ArcPath({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 })
    expect(path.length).toBeCloseTo(100, 0)
    expect(path.at(0.5).x).toBeCloseTo(50, 0)
    expect(hermite(0, 0)).toBe(0)
    expect(hermite(1, 2)).toBe(1)
    for (const style of ['arc', 'swoop', 'direct', 'loop'] as const) {
      const [a, b] = pathOffsets(style, { x: 0, y: 400 }, { x: 600, y: 200 })
      expect([a.x, a.y, b.x, b.y].every(Number.isFinite)).toBe(true)
    }
  })
})

describe('particles', () => {
  it('caps live particles per instance and per stage', () => {
    const stage = acquireStage(document)
    const emitters = Array.from({ length: 6 }, (_, i) => new ParticleEmitter(stage, seededRandom(i)))
    for (let i = 0; i < 10; i++) emitters[0].emit('confetti', 10, 10, 1, { count: 40 })
    expect(emitters[0].active).toBeLessThanOrEqual(INSTANCE_PARTICLE_CAP)
    for (const e of emitters) for (let i = 0; i < 5; i++) e.emit('feather', 10, 10, 1, { count: 40 })
    expect(stage.particles).toBeLessThanOrEqual(STAGE_PARTICLE_CAP)
    expect(emitters.reduce((n, e) => n + e.active, 0)).toBe(stage.particles)
    for (let i = 0; i < 400; i++) for (const e of emitters) e.step(1 / 60)
    expect(stage.particles).toBe(0)
    for (const e of emitters) e.destroy()
    releaseStage(stage)
  })
  it('clip fx emit on the stage, tinted by the agent palette', () => {
    const { handle } = mount({ palette: { primary: '#123456' } })
    void handle.play('hop')
    clock.advance(600)
    const group = document.querySelector<SVGGElement>('#mascot-stage [data-mascot-particles]')!
    expect(group.style.getPropertyValue('--m-primary')).toBe('#123456')
    expect(document.querySelectorAll('#mascot-stage use[href="#mascot-fx-dust"]').length).toBeGreaterThan(0)
  })
})

describe('behaviour layer', () => {
  it('is seeded, staggered and weighted to available acts', () => {
    const a = new AutonomousBehaviors(seededRandom('x'), { hop: 1, preen: 1 })
    const b = new AutonomousBehaviors(seededRandom('x'), { hop: 1, preen: 1 })
    const picks = (s: AutonomousBehaviors) => Array.from({ length: 40 }, (_, i) => s.sample(i * 3, n => n !== 'preen'))
    const pa = picks(a)
    expect(pa).toEqual(picks(b))
    expect(pa.filter(Boolean).every(p => p === 'hop')).toBe(true)
    expect(pa.filter(Boolean).length).toBeGreaterThan(3)
  })
  it('acts autonomously while idle and goes drowsy after 23:00', () => {
    expect(isDrowsy(new Date(2026, 9, 7, 23, 30))).toBe(true)
    expect(isDrowsy(new Date(2026, 9, 7, 14, 0))).toBe(false)
    const { el, part } = mount({ autonomy: true, wallClock: () => new Date(2026, 9, 7, 14, 0) })
    const seen = new Set<string>()
    for (let i = 0; i < 600; i++) {
      clock.advance(100)
      seen.add(el.querySelector('[data-mascot-motion-root]')!.getAttribute('transform') ?? '')
      seen.add(part('head').getAttribute('transform')!)
    }
    expect(seen.size).toBeGreaterThan(20)
    const night = mount({ autonomy: true, wallClock: () => new Date(2026, 9, 7, 23, 30) })
    clock.advance(200)
    const lid = night.el.querySelector('[data-mascot-part="lid-l"]')!.getAttribute('transform')!
    expect(Number(/scale\([\d.]+ ([\d.]+)\)/.exec(lid)![1])).toBeGreaterThanOrEqual(0.4)
  })
})

describe('cues', () => {
  it('reacts everywhere when no flight is possible, and flies the visible home avatar otherwise', async () => {
    const home = mount({ stageKey: 'agent:a' }, [10, 100, 40])
    const bubbleAvatar = mount({}, [10, 700, 28])
    const react = vi.spyOn(bubbleAvatar.handle, 'react')
    const off1 = registerMascot('a', { handle: home.handle, element: () => home.el, canFly: true })
    const off2 = registerMascot('a', { handle: bubbleAvatar.handle, element: () => bubbleAvatar.el, canFly: false })
    expect(cueMascot('a', { type: 'deliver' }, 0)).toBe(false)
    expect(react).toHaveBeenCalledWith('message')
    const row = document.createElement('div')
    row.setAttribute('data-mascot-session', 'current')
    row.setAttribute('data-message-id', 'm1')
    row.innerHTML = '<div class="ca-bubble" data-side="start"></div>'
    document.body.append(row)
    place(row.firstElementChild!, 300, 400, 300, 80)
    resetMascotCues()
    registerMascot('a', { handle: home.handle, element: () => home.el, canFly: true })
    registerMascot('a', { handle: bubbleAvatar.handle, element: () => bubbleAvatar.el, canFly: false })
    expect(cueMascot('a', { type: 'deliver', key: 't1' }, 100_000)).toBe(true)
    clock.advance(50)
    expect(home.handle.location()).toBe('flying')
    expect(bubbleAvatar.handle.location()).toBe('home')
    // A repeated completion event for the same turn does not queue another flight.
    expect(cueMascot('a', { type: 'deliver', key: 't1' }, 100_500)).toBe(false)
    // A second finish while Pip is still out waits, then gets its own flight once Pip is home.
    expect(cueMascot('a', { type: 'deliver', key: 't2' }, 100_600)).toBe(false)
    cueMascot('a', { type: 'home' })
    clock.advance(5000)
    expect(home.handle.location()).toBe('home')
    retryPending(106_000)
    clock.advance(50)
    expect(home.handle.location()).toBe('flying')
    retryPending(107_000)
    cueMascot('a', { type: 'home' })
    clock.advance(5000)
    retryPending(113_000)
    clock.advance(50)
    expect(home.handle.location()).toBe('home') // nothing else queued
    off1(); off2()
  })
  it('a finished session scrolled below the sidebar fold still flies from the list edge to the current message', async () => {
    const roster = document.createElement('div')
    roster.style.overflowY = 'auto'
    document.body.append(roster)
    place(roster, 0, 100, 240, 500)
    const home = mount({ stageKey: 'agent:b' }, [10, 900, 40])
    roster.append(home.el)
    const off = registerMascot('b', { handle: home.handle, element: () => home.el, canFly: true })
    // The current session shows only the user's own message.
    const row = document.createElement('div')
    row.setAttribute('data-mascot-session', 'current')
    row.setAttribute('data-message-id', 'm1')
    row.innerHTML = '<div class="ca-bubble" data-side="end"></div>'
    document.body.append(row)
    place(row.firstElementChild!, 500, 300, 300, 80)
    expect(cueMascot('b', { type: 'deliver' }, 0)).toBe(true)
    clock.advance(30)
    expect(home.handle.location()).toBe('flying')
    const [x, y] = flightPos()
    expect(x).toBeGreaterThanOrEqual(-1)
    expect(y + 444 / 512 * 40).toBeLessThanOrEqual(601) // feet on the roster's bottom edge, not off-screen
    off()
  })
  it('a finish with no message on screen flies once one appears, and stale ones expire', () => {
    const home = mount({ stageKey: 'agent:d' }, [10, 100, 40])
    const off = registerMascot('d', { handle: home.handle, element: () => home.el, canFly: true })
    expect(cueMascot('d', { type: 'deliver' }, 0)).toBe(false)
    retryPending(1_000)
    expect(home.handle.location()).toBe('home')
    const row = document.createElement('div')
    row.setAttribute('data-mascot-session', 'current')
    row.setAttribute('data-message-id', 'm1')
    row.innerHTML = '<div class="ca-bubble" data-side="start"></div>'
    document.body.append(row)
    place(row.firstElementChild!, 500, 300, 300, 80)
    retryPending(2_000)
    clock.advance(30)
    expect(home.handle.location()).toBe('flying')
    cueMascot('d', { type: 'home' })
    clock.advance(6000)
    expect(home.handle.location()).toBe('home')
    // Queued long enough ago: dropped rather than flown out of context.
    row.remove()
    expect(cueMascot('d', { type: 'deliver' }, 10_000)).toBe(false)
    document.body.append(row)
    retryPending(10_000 + PENDING_DELIVERY_MS + 1)
    clock.advance(30)
    expect(home.handle.location()).toBe('home')
    off()
  })
  it('a finish while the window is hidden waits until it is shown', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const home = mount({ stageKey: 'agent:e' }, [10, 100, 40])
    const off = registerMascot('e', { handle: home.handle, element: () => home.el, canFly: true })
    const row = document.createElement('div')
    row.setAttribute('data-mascot-session', 'current')
    row.setAttribute('data-message-id', 'm1')
    row.innerHTML = '<div class="ca-bubble" data-side="start"></div>'
    document.body.append(row)
    place(row.firstElementChild!, 500, 300, 300, 80)
    expect(cueMascot('e', { type: 'deliver' }, 0)).toBe(false)
    hidden.mockReturnValue(false)
    retryPending(1_000)
    clock.advance(30)
    expect(home.handle.location()).toBe('flying')
    off()
  })
  it('does not fly a home avatar whose whole list is off-screen', () => {
    const roster = document.createElement('div')
    roster.style.overflowY = 'auto'
    document.body.append(roster)
    place(roster, -400, 100, 240, 500)
    const home = mount({ stageKey: 'agent:c' }, [-390, 900, 40])
    roster.append(home.el)
    const react = vi.spyOn(home.handle, 'react')
    const off = registerMascot('c', { handle: home.handle, element: () => home.el, canFly: true })
    const row = document.createElement('div')
    row.setAttribute('data-mascot-session', 'current')
    row.setAttribute('data-message-id', 'm1')
    row.innerHTML = '<div class="ca-bubble" data-side="start"></div>'
    document.body.append(row)
    place(row.firstElementChild!, 500, 300, 300, 80)
    expect(cueMascot('c', { type: 'deliver' }, 0)).toBe(false)
    expect(react).toHaveBeenCalledWith('message')
    off()
  })
  it('flies another agent into the current session, not a different transcript, then returns home', async () => {
    const current = mount({ stageKey: 'agent:current' }, [10, 100, 40])
    const visitor = mount({ stageKey: 'agent:visitor' }, [10, 200, 40])
    registerMascot('current', { handle: current.handle, element: () => current.el, canFly: true })
    registerMascot('visitor', { handle: visitor.handle, element: () => visitor.el, canFly: true })
    const session = document.createElement('section')
    session.setAttribute('data-mascot-session', 'current-session')
    session.innerHTML = '<div data-message-id="current"><div class="ca-bubble" data-side="start"></div></div>'
    document.body.append(session)
    const bubble = session.querySelector<HTMLElement>('.ca-bubble')!
    place(bubble, 300, 400, 300, 80)
    const other = document.createElement('div')
    other.innerHTML = '<div data-message-id="other"><div class="ca-bubble" data-side="start"></div></div>'
    document.body.append(other)
    place(other.querySelector('.ca-bubble')!, 600, 200, 300, 80)
    const fly = vi.spyOn(visitor.handle, 'flyTo')
    const play = vi.spyOn(visitor.handle, 'play')
    expect(cueMascot('visitor', { type: 'deliver', key: 'background-turn' })).toBe(true)
    expect(fly).toHaveBeenCalledWith(bubble, expect.objectContaining({ returnHome: true }))
    clock.advance(3000)
    await Promise.resolve()
    expect(play).toHaveBeenCalledWith('deliver')
    expect(current.handle.location()).toBe('home')
    clock.advance(6000)
    expect(visitor.handle.location()).toBe('home')
    expect(visitor.el.querySelector('svg')).toBeTruthy()
    // A retained or unrelated transcript is not a destination when no chat is active.
    session.removeAttribute('data-mascot-session')
    expect(cueMascot('visitor', { type: 'deliver', key: 'later-turn' })).toBe(false)
    expect(fly).toHaveBeenCalledTimes(1)
  })
})
