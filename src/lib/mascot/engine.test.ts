import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMascot } from './engine'
import { ManualFrameClock } from './frame-clock'
import { characters } from './registry'
import { fullPose, multiply, poseMatrix, transformPoint } from './pose'
import { smallInsetTransform } from './rig'
import type { MascotHandle, MascotOptions, MotionSpec } from './types'

const test = characters._test
const handles: MascotHandle[] = []
let clock: ManualFrameClock
function mount(options: Partial<MascotOptions> = {}) {
  const el = document.createElement('span')
  document.body.append(el)
  const handle = createMascot(el, { svg: test.svg, motion: test.motion, clock, ...options })
  handles.push(handle)
  const part = (name: string) => el.querySelector<SVGGElement>(`[data-mascot-part="${name}"]`)!
  return { el, handle, part }
}
function quietMotion(): MotionSpec {
  const motion = structuredClone(test.motion)
  for (const state of Object.values(motion.states)) state.osc = []
  return motion
}
function poseNumber(el: Element, field: 'rotate' | 'tx' | 'ty' | 'sy') {
  const transform = el.getAttribute('transform')!
  if (field === 'rotate') return Number(transform.match(/rotate\(([^)]+)\)/)![1])
  if (field === 'sy') return Number(transform.match(/scale\(([^)]+)\)/)![1].split(' ')[1])
  return Number(transform.match(/translate\(([^)]+)\)/)![1].split(' ')[field === 'tx' ? 0 : 1])
}
beforeEach(() => {
  clock = new ManualFrameClock()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('mascot poses and state composition', () => {
  it('composes a pivot and inherited parent without applying the parent twice', () => {
    const parent = poseMatrix(fullPose({ rotate: 90, tx: 10 }), [100, 100])
    const child = poseMatrix(fullPose({ sx: 2 }), [110, 100])
    const [x, y] = transformPoint(multiply(parent, child), 115, 100)
    expect(x).toBeCloseTo(110)
    expect(y).toBeCloseTo(120)
    const { part } = mount({ state: 'thinking', motion: quietMotion() })
    expect(part('head').parentElement).toBe(part('body'))
    expect(part('eye-l').parentElement).toBe(part('head'))
    expect(part('head').getAttribute('transform')).toContain('translate(256 271) rotate(-9)')
    expect(part('eye-l').getAttribute('transform')).toContain('rotate(0)')
  })
  it('uses data-parent for flat rigs and rejects cycles', () => {
    const svg = '<svg viewBox="0 0 512 512"><g id="part-body" data-pivot="256 400"/><g id="part-head" data-pivot="256 240" data-parent="part-body"/></svg>'
    const { part } = mount({ svg })
    expect(part('head').parentElement).toBe(part('body'))
    expect(() => mount({ svg: svg.replace('data-pivot="256 400"', 'data-pivot="256 400" data-parent="part-head"') })).toThrow('cycle')
  })
  it('spring-blends state targets, converges and falls back to idle', () => {
    const { handle, part } = mount({ motion: quietMotion() })
    handle.setState('thinking')
    expect(poseNumber(part('head'), 'rotate')).toBe(0)
    clock.advance(150)
    expect(poseNumber(part('head'), 'rotate')).toBeLessThan(0)
    expect(poseNumber(part('head'), 'rotate')).toBeGreaterThan(-9)
    clock.advance(1800)
    expect(poseNumber(part('head'), 'rotate')).toBeCloseTo(-9, 3)
    handle.setState('not-a-state')
    clock.advance(1800)
    expect(poseNumber(part('head'), 'rotate')).toBeCloseTo(0, 3)
  })
  it('fades oscillator amplitude rather than jumping on state changes', () => {
    const motion = quietMotion()
    motion.states.thinking.pose = {}
    motion.states.thinking.osc = [{ part: 'head', prop: 'rotate', amp: 10, freq: 0, phase: Math.PI / 2 }]
    const { handle, part } = mount({ motion })
    handle.setState('thinking')
    expect(poseNumber(part('head'), 'rotate')).toBe(0)
    clock.advance(150)
    expect(poseNumber(part('head'), 'rotate')).toBeGreaterThan(0)
    expect(poseNumber(part('head'), 'rotate')).toBeLessThan(10)
    clock.advance(1800)
    expect(poseNumber(part('head'), 'rotate')).toBeCloseTo(10, 3)
  })
  it('shows exactly one mouth and restores it after a one-shot reaction', () => {
    const { handle, el, part } = mount()
    handle.setState('thinking')
    const shown = () => [...el.querySelectorAll<SVGGElement>('[data-mascot-mouth]')].filter(n => n.style.display !== 'none')
    expect(shown().map(n => n.dataset.mascotMouth)).toEqual(['o'])
    handle.react('message')
    expect(shown().map(n => n.dataset.mascotMouth)).toEqual(['smile'])
    clock.advance(350)
    expect(poseNumber(part('body'), 'ty')).toBeLessThan(-15)
    clock.advance(800)
    expect(shown().map(n => n.dataset.mascotMouth)).toEqual(['o'])
    expect(poseNumber(part('body'), 'ty')).toBe(0)
  })
  it('clamps pupil look-at and null restores the state gaze', () => {
    const { handle, el } = mount()
    const pupil = () => el.querySelector('[data-mascot-pupil="l"]')!
    handle.lookAt(100000, -100000)
    clock.advance(1800)
    expect(poseNumber(pupil(), 'tx')).toBeCloseTo(12, 3)
    expect(poseNumber(pupil(), 'ty')).toBeCloseTo(-9, 3)
    handle.lookAt(null)
    clock.advance(1800)
    expect(Math.abs(poseNumber(pupil(), 'tx'))).toBeLessThan(1)
  })
  it('isolates gradient ids between instances and supports CSS palette keys', () => {
    const a = mount({ palette: { '--m-primary': '#abcdef' } })
    const b = mount()
    const aGradient = a.el.querySelector('linearGradient')!.id
    const bGradient = b.el.querySelector('linearGradient')!.id
    expect(aGradient).not.toBe(bGradient)
    expect(a.el.innerHTML).toContain(`url(#${aGradient})`)
    expect(a.el.querySelector('svg')!.style.getPropertyValue('--m-primary')).toBe('#abcdef')
    a.handle.setPalette({ accent: '#123456' })
    expect(a.el.querySelector('svg')!.style.getPropertyValue('--m-primary')).toBe('')
    expect(a.el.querySelector('svg')!.style.getPropertyValue('--m-accent')).toBe('#123456')
  })
  it('FX anchors follow authored transforms as well as the pose hierarchy', () => {
    const motion = quietMotion()
    motion.states.idle.fx = [{ type: 'dots', anchor: 'part-head', count: 1, y: 0 }]
    const svg = test.svg.replace('id="part-head"', 'id="part-head" transform="translate(20 0)"')
    const { el, part } = mount({ motion, svg })
    expect(part('head').getAttribute('transform')).toContain('translate(20 0)')
    expect(el.querySelector('[data-mascot-fx] circle')!.getAttribute('transform')).toContain('translate(276 271)')
  })
})

describe('motion profiles and visibility', () => {
  it('adds opt-in pixel padding only to small artwork and preserves authored transforms', () => {
    const svg = test.svg.replace('<g id="part-body"', '<g data-small-inset="1.5" transform="translate(2 3)"><g id="part-body"')
      .replace('</svg>', '</g></svg>')
    const { el, handle } = mount({ svg, size: 16 })
    const wrapper = el.querySelector('[data-small-inset]')!
    for (const size of [16, 24, 40, 48]) {
      handle.setSize(size)
      expect(wrapper.getAttribute('transform')).toBe(`${smallInsetTransform(1.5, size)} translate(2 3)`)
      const scale = Number(wrapper.getAttribute('transform')!.match(/scale\(([^)]+)\)/)![1])
      expect((1 - scale) * size / 2).toBeCloseTo(1.5)
    }
    handle.setSize(160)
    expect(wrapper.getAttribute('transform')).toBe('translate(2 3)')
    handle.setSize(24)
    expect(wrapper.getAttribute('transform')).toBe(`${smallInsetTransform(1.5, 24)} translate(2 3)`)
  })
  it('rejects invalid small insets and bounds scaling at tiny sizes', () => {
    for (const inset of [NaN, Infinity, -1]) expect(() => smallInsetTransform(inset, 16)).toThrow('small inset')
    expect(smallInsetTransform(1.5, 1)).toContain('scale(0.5)')
    expect(smallInsetTransform(0, 16)).toBe('')
    expect(smallInsetTransform(1.5, 64)).toBe('')
    const { el } = mount({ size: 16 })
    expect(el.querySelector('[data-small-inset]')).toBeNull()
  })
  it('reduced-motion output is static apart from scheduled blinks', () => {
    const { el, part, handle } = mount({ state: 'happy', reducedMotion: true })
    const before = el.innerHTML
    clock.advance(1000)
    expect(el.innerHTML).toBe(before)
    expect(el.querySelector('[data-mascot-fx]')!.children).toHaveLength(0)
    handle.react('approval')
    clock.advance(1000)
    expect(el.innerHTML).toBe(before)
    handle.setState('thinking')
    expect(poseNumber(part('head'), 'rotate')).toBe(-9)
  })
  it('reduced motion still blinks and respects its frame cap', () => {
    const motion = quietMotion()
    motion.states.idle.eyes = { blinkEvery: [0.5, 0.5], look: 'center' }
    const { part, el } = mount({ motion, reducedMotion: true })
    const before = el.innerHTML
    clock.advance(20)
    expect(el.innerHTML).toBe(before)
    clock.advance(530, 10)
    expect(poseNumber(part('lid-l'), 'sy')).toBeGreaterThan(0.4)
    clock.advance(250)
    expect(poseNumber(part('lid-l'), 'sy')).toBe(0)
    expect(poseNumber(part('body'), 'sy')).toBe(1)
  })
  it('tracks the OS preference unless an explicit override is supplied', () => {
    let matches = true
    let change: () => void
    const remove = vi.fn()
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return matches },
      addEventListener: (_: string, cb: () => void) => { change = cb },
      removeEventListener: remove,
    }))
    const { el, handle } = mount()
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('reduced')
    matches = false
    change!()
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('full')
    handle.setReducedMotion(true)
    change!()
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('reduced')
    handle.setReducedMotion(undefined)
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('full')
    handle.destroy()
    expect(remove).toHaveBeenCalledOnce()
  })
  it('small profile keeps springs, gaze, oscillators and reactions but drops ambient fx and caps fps', () => {
    const { handle, el, part } = mount({ state: 'happy', size: 40 })
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('small')
    const body = part('body').getAttribute('transform')
    handle.react('message')
    handle.lookAt(9999, 9999)
    clock.advance(1000)
    expect(part('body').getAttribute('transform')).not.toBe(body)
    expect(poseNumber(el.querySelector('[data-mascot-pupil="l"]')!, 'tx')).toBeGreaterThan(0)
    expect(el.querySelector('[data-mascot-fx]')!.children).toHaveLength(0)
    // 30fps cap: a single 60Hz tick after a redraw does not redraw again.
    clock.advance(1000 / 30)
    const settled = part('body').getAttribute('transform')
    clock.advance(1000 / 60 - 1)
    expect(part('body').getAttribute('transform')).toBe(settled)
    handle.setSize(160)
    expect(el.querySelector('svg')!.dataset.mascotProfile).toBe('full')
    expect(el.querySelector('[data-mascot-fx]')!.children.length).toBeGreaterThan(0)
  })
  it('pauses offscreen and resumes without integrating the hidden interval', () => {
    let callback: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IntersectionObserverCallback) { callback = cb }
      observe() {}
      unobserve() {}
      disconnect = disconnect
    })
    const { el, part, handle } = mount()
    handle.setState('thinking')
    clock.advance(100)
    callback!([{ target: el, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(clock.subscribers).toBe(0)
    const before = part('head').getAttribute('transform')
    clock.advance(20000)
    expect(part('head').getAttribute('transform')).toBe(before)
    callback!([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(clock.subscribers).toBe(1)
    clock.advance(100)
    expect(poseNumber(part('head'), 'rotate')).toBeGreaterThan(-9)
    handle.destroy()
    expect(disconnect).toHaveBeenCalledOnce()
  })
  it('drops its stage particles when it pauses instead of freezing them on screen', () => {
    let callback: IntersectionObserverCallback
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IntersectionObserverCallback) { callback = cb }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const { el, handle } = mount()
    handle.emit('dust', { x: 40, y: 40, count: 4 })
    const live = () => [...document.querySelectorAll<SVGElement>('#mascot-stage use')].filter(p => p.style.display !== 'none').length
    expect(live()).toBeGreaterThan(0)
    callback!([{ target: el, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(live()).toBe(0)
  })
  it('document visibility and manual pause are independent gates', () => {
    const { handle } = mount()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.subscribers).toBe(0)
    handle.pause()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clock.subscribers).toBe(0)
    handle.resume()
    expect(clock.subscribers).toBe(1)
    handle.destroy()
    handle.resume()
    expect(clock.subscribers).toBe(0)
  })
  it('the same clock and seed produce identical poses and blink times', () => {
    const a = mount({ idPrefix: 'golden', seed: 'fixed' })
    const b = mount({ idPrefix: 'golden', seed: 'fixed' })
    for (let i = 0; i < 30; i++) {
      clock.advance(233)
      expect(a.el.innerHTML).toBe(b.el.innerHTML)
    }
  })
  it('rejects active markup and external resources before insertion', () => {
    for (const content of ['<script>alert(1)</script>', '<image href="https://example.com/x.png"/>', '<g onclick="x()"/>', '<path fill="url(https://example.com/a)"/>']) {
      expect(() => mount({ svg: `<svg viewBox="0 0 512 512">${content}</svg>` })).toThrow()
    }
  })
})
