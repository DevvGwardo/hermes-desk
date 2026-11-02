import { describe, expect, it, vi } from 'vitest'
import { createMascot } from '../../engine'
import { ManualFrameClock } from '../../frame-clock'
import { characters } from '../../registry'
import rig from './rig.svg?raw'
import motion from './motion.json'
import palettes from './palette.json'
import deliver from './clips/deliver.json'

type Pose = Partial<Record<'tx' | 'ty' | 'rotate' | 'sx' | 'sy', number>>
type Oscillator = { part: string; prop: string; amp: number; freq: number; phase: number }
type Effect = { type: string; anchor: string; count?: number }
type State = {
  pose: Record<string, Pose>
  osc: Oscillator[]
  mouth: string
  eyes: { blinkEvery: number[]; look: string; pupilScale: number }
  fx?: Effect[]
}
const document = new DOMParser().parseFromString(rig, 'image/svg+xml')
const parts = new Map([...document.querySelectorAll('g[id^="part-"]')].map(node => [node.id.slice(5), node]))
const states = motion.states as Record<string, State>
const paintKeys = ['--m-primary', '--m-secondary', '--m-accent', '--m-belly', '--m-ink', '--m-eye', '--m-shine']
const expressions = ['neutral', 'smile', 'open', 'o', 'flat', 'grin']

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(component => {
    const value = Number.parseInt(component, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Pip owl rig contract', () => {
  it('is valid original inline SVG with no external media or executable content', () => {
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 512 512')
    expect(document.querySelectorAll('script, image, foreignObject, animate, animateTransform')).toHaveLength(0)
    expect(rig).not.toMatch(/\son\w+\s*=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
    expect(document.querySelectorAll('[href], [xlink\\:href]')).toHaveLength(0)
  })

  it('has a real root-body-head hierarchy, required face parts, and finite pivots', () => {
    for (const name of ['root', 'body', 'head', 'eye-l', 'eye-r', 'pupil-l', 'pupil-r', 'lid-l', 'lid-r', 'mouth']) {
      expect(parts.has(name), name).toBe(true)
    }
    for (const [name, node] of parts) {
      const pivot = node.getAttribute('data-pivot')!.split(/\s+/).map(Number)
      expect(pivot, name).toHaveLength(2)
      expect(pivot.every(value => Number.isFinite(value) && value >= 0 && value <= 512), name).toBe(true)
      if (name === 'root') {
        expect(node.hasAttribute('data-parent')).toBe(false)
      } else {
        expect(node.getAttribute('data-parent'), name).toBe(node.parentElement!.closest('[id^="part-"]')!.id)
      }
    }
    expect(parts.get('head')!.getAttribute('data-parent')).toBe('part-body')
    expect(parts.get('body')!.getAttribute('data-parent')).toBe('part-root')
    for (const side of ['l', 'r']) {
      expect(parts.get(`eye-${side}`)!.contains(parts.get(`pupil-${side}`)!)).toBe(true)
      expect(parts.get(`pupil-${side}`)!.parentElement!.getAttribute('clip-path')).toBe(`url(#owl-eye-clip-${side})`)
    }
  })

  it('uses unique ids and character-prefixed, resolvable paint servers', () => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const node of document.querySelectorAll('defs [id]')) expect(node.id).toMatch(/^owl-/)
    for (const [, id] of rig.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(id)
  })

  it('keeps every paint color tintable and every expression engine-selectable', () => {
    for (const node of document.querySelectorAll('*')) {
      for (const attr of ['fill', 'stroke', 'stop-color']) {
        const paint = node.getAttribute(attr)
        if (paint == null || paint === 'none') continue
        expect(paint, `${node.tagName}.${attr}`).toMatch(/^(var\(--m-(primary|secondary|accent|belly|ink|eye|shine), #[0-9a-f]{6}\)|url\(#owl-[\w-]+\))$/)
      }
    }
    const mouth = parts.get('mouth')!
    expect([...mouth.children].map(node => node.id)).toEqual(expressions.map(name => `mouth-${name}`))
    expect(mouth.children[0].hasAttribute('display')).toBe(false)
    for (const node of [...mouth.children].slice(1)) expect(node.getAttribute('display')).toBe('none')
    for (const name of ['lid-l', 'lid-r', 'letter', 'ruff-l', 'ruff-r']) {
      // Authored zero scales multiply the engine pose and can never reopen.
      expect(parts.get(name)!.hasAttribute('transform')).toBe(false)
    }
    for (const side of ['l', 'r']) expect(parts.get(`pupil-${side}`)!.querySelector(`#pupil-${side}`)).toBeTruthy()
  })
})

describe('Pip owl motion contract', () => {
  it('tosses the existing letter outward from its own anchor without changing delivery events', () => {
    const toss = deliver.tracks.fx.find(fx => fx.type === 'letter')!
    expect(toss.anchor).toBe('letter')
    // Every allowed launch angle points left, away from the owl's eye discs.
    for (const direction of [toss.params.angle - toss.params.spread / 2, toss.params.angle + toss.params.spread / 2]) {
      expect(Math.cos(direction * Math.PI / 180)).toBeLessThan(0)
      expect(Math.sin(direction * Math.PI / 180)).toBeLessThan(0)
    }
    expect(deliver.tracks.events.some(event => event.name === 'toss' && event.t === toss.t)).toBe(true)
    expect(deliver.tracks.parts.letter.some(frame => frame.t > toss.t && frame.sx === 0 && frame.sy === 0)).toBe(true)
  })

  it('uses distinct coarse wing silhouettes while preserving rummaging, scanning and speaking', () => {
    const wingProfile = (state: State) => ['wing-l', 'wing-r'].map(name => {
      const angle = state.pose[name].rotate ?? 0
      return Math.sign(angle) * Math.round(Math.abs(angle) / 30)
    }).join(',')
    expect(new Set(['idle', 'tool', 'browsing', 'talking', 'error'].map(name => wingProfile(states[name]))).size).toBe(5)
    expect(states.tool.pose['satchel-flap'].sy).toBeLessThan(0)
    expect(states.browsing.osc.filter(osc => osc.part.startsWith('pupil-'))).toHaveLength(2)
    expect(states.talking.osc.some(osc => osc.part === 'mouth')).toBe(true)
    expect(states.error.pose['ruff-l'].sx).toBeGreaterThan(0)
  })

  it('covers all nine states with valid pose, oscillator, gaze, and effect references', () => {
    expect(Object.keys(states)).toEqual(['idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep'])
    for (const [name, state] of Object.entries(states)) {
      expect(expressions, name).toContain(state.mouth)
      expect(state.eyes.blinkEvery, name).toHaveLength(2)
      expect(state.eyes.blinkEvery[0]).toBeGreaterThan(0)
      expect(state.eyes.blinkEvery[1]).toBeGreaterThanOrEqual(state.eyes.blinkEvery[0])
      expect(state.eyes.pupilScale).toBeGreaterThan(0)
      expect(['cursor', 'center', 'wander', 'down', 'up-left']).toContain(state.eyes.look)
      for (const [part, pose] of Object.entries(state.pose)) {
        expect(parts.has(part), `${name}.${part}`).toBe(true)
        for (const [prop, value] of Object.entries(pose)) {
          expect(['tx', 'ty', 'rotate', 'sx', 'sy']).toContain(prop)
          expect(Number.isFinite(value)).toBe(true)
        }
      }
      for (const osc of state.osc) {
        expect(parts.has(osc.part), `${name}.${osc.part}`).toBe(true)
        expect(['tx', 'ty', 'rotate', 'sx', 'sy']).toContain(osc.prop)
        expect([osc.amp, osc.freq, osc.phase].every(Number.isFinite)).toBe(true)
        expect(osc.freq).toBeGreaterThan(0)
      }
      for (const fx of state.fx ?? []) {
        expect(['sparkle', 'dots', 'zzz', 'sweat', 'ring']).toContain(fx.type)
        expect(parts.has(fx.anchor.replace(/^part-/, ''))).toBe(true)
      }
    }
  })

  it('keeps the letter, ruffs, eyelids, and satchel state-specific', () => {
    for (const [name, state] of Object.entries(states)) {
      expect(state.pose.letter.sx, name).toBe(name === 'waiting' ? 1 : 0)
      expect(state.pose.letter.sy, name).toBe(name === 'waiting' ? 1 : 0)
      for (const side of ['l', 'r']) {
        expect(state.pose[`ruff-${side}`].sx, name).toBe(name === 'error' ? 1 : 0)
        expect(state.pose[`ruff-${side}`].sy, name).toBe(name === 'error' ? 1 : 0)
        // The engine multiplies this full-lid scale by blink/sleep closure.
        expect(state.pose[`lid-${side}`].sy, name).toBe(1)
      }
    }
    expect(states.tool.pose['satchel-flap'].sy).toBeLessThan(0)
    expect(states.waiting.pose['wing-l'].rotate! + states.waiting.pose.letter.rotate!).toBeLessThan(10)
    expect(states.talking.osc.some(osc => osc.part === 'mouth' && osc.prop === 'sy')).toBe(true)
    expect(states.browsing.osc.filter(osc => osc.part.startsWith('pupil-'))).toHaveLength(2)
  })

  it('provides stable springs and all three bounded additive reactions', () => {
    for (const spring of [motion.springs.default, ...Object.values(motion.springs.parts)]) {
      expect(spring.stiffness).toBeGreaterThan(0)
      expect(spring.damping).toBeGreaterThan(0)
    }
    for (const part of Object.keys(motion.springs.parts)) expect(parts.has(part), part).toBe(true)
    expect(motion.springs.parts['ear-l'].stiffness).toBeLessThan(motion.springs.default.stiffness)
    expect(Object.keys(motion.reactions)).toEqual(['pulse', 'message', 'approval'])
    for (const reaction of Object.values(motion.reactions)) {
      expect(reaction.duration).toBeGreaterThan(0)
      expect(reaction.duration).toBeLessThanOrEqual(2)
      for (const [part, pose] of Object.entries(reaction.pose)) {
        expect(parts.has(part), part).toBe(true)
        expect(Object.values(pose).every(Number.isFinite)).toBe(true)
      }
      for (const osc of reaction.osc) expect(parts.has(osc.part), osc.part).toBe(true)
    }
  })
})

describe('Pip with the production engine', () => {
  it('restores the held-letter visibility after a toss and when delivery is interrupted', async () => {
    vi.spyOn(globalThis.document, 'hidden', 'get').mockReturnValue(false)
    const host = globalThis.document.createElement('span')
    globalThis.document.body.append(host)
    const clock = new ManualFrameClock()
    const handle = createMascot(host, { svg: rig, motion: characters.owl.motion,
      clips: characters.owl.clips, clock, size: 40, reducedMotion: false })
    const letter = host.querySelector<SVGGElement>('[data-mascot-part="letter"]')!
    try {
      const complete = handle.play('deliver')
      clock.advance(650)
      expect(letter.style.display).toBe('none')
      clock.advance(1800)
      expect(await complete).toBe('done')
      expect(letter.style.display).not.toBe('none')
      const interrupted = handle.play('deliver')
      clock.advance(650)
      expect(letter.style.display).toBe('none')
      handle.setReducedMotion(true)
      handle.setState('waiting')
      expect(await interrupted).toBe('interrupted')
      expect(letter.style.display).not.toBe('none')
      expect(letter.getAttribute('transform')).toContain('scale(1 1)')
    } finally { handle.destroy(); host.remove() }
  })

  it('pads small poses without altering the full-size rig or pose amplitudes', () => {
    const host = globalThis.document.createElement('span')
    const clock = new ManualFrameClock()
    const handle = createMascot(host, { svg: rig, motion: characters.owl.motion, clock, size: 16 })
    const wrapper = host.querySelector('[data-small-inset]')!
    expect(wrapper.contains(host.querySelector('[data-mascot-part="root"]'))).toBe(true)
    for (const state of Object.keys(states)) {
      handle.setState(state)
      expect(wrapper.getAttribute('transform')).toBe('translate(256 256) scale(0.85) translate(-256 -256)')
    }
    handle.setReducedMotion(true)
    expect(wrapper.getAttribute('transform')).toContain('scale(0.85)')
    handle.setSize(160)
    expect(wrapper.hasAttribute('transform')).toBe(false)
    handle.setSize(40)
    expect(wrapper.getAttribute('transform')).toContain('scale(0.94)')
    handle.destroy()
  })
  it('reveals the waiting letter, error ruffs, and closed sleep eyes without zero-scale bases', () => {
    const host = globalThis.document.createElement('span')
    const clock = new ManualFrameClock()
    // Reduced motion snaps to state targets, so each state's pose is observable immediately.
    const handle = createMascot(host, { svg: rig, motion: characters.owl.motion, clock, size: 40, reducedMotion: true })
    const part = (name: string) => host.querySelector(`[data-mascot-part="${name}"]`)!.getAttribute('transform')!
    expect(part('letter')).toContain('scale(0 0)')
    expect(part('lid-l')).toContain('scale(1 0)')
    handle.setState('waiting')
    expect(part('letter')).toContain('scale(1 1)')
    handle.setState('error')
    expect(part('ruff-l')).toContain('scale(1 1)')
    handle.setState('sleep')
    expect(part('lid-l')).toContain('scale(1 1)')
    expect(part('lid-r')).toContain('scale(1 1)')
    handle.setState('idle')
    expect(part('ruff-l')).toContain('scale(0 0)')
    expect(part('lid-l')).toContain('scale(1 0)')
    handle.destroy()
  })

  it('drives nested pupils with gaze and scales pulse around identity rather than collapsing', () => {
    vi.spyOn(globalThis.document, 'hidden', 'get').mockReturnValue(false)
    const host = globalThis.document.createElement('span')
    const clock = new ManualFrameClock()
    const handle = createMascot(host, { svg: rig, motion: characters.owl.motion, clock, size: 160, reducedMotion: false })
    expect(host.querySelectorAll('[data-mascot-pupil]')).toHaveLength(2)
    handle.lookAt(512, 0)
    clock.advance(500)
    const pupil = host.querySelector('[data-mascot-pupil="l"]')!
    expect(pupil.getAttribute('transform')).not.toContain('translate(0 0)')
    handle.react('pulse')
    clock.advance(325)
    const transform = host.querySelector('[data-mascot-part="body"]')!.getAttribute('transform')!
    const scale = Number(transform.match(/scale\([\d.]+ ([\d.]+)\)/)![1])
    expect(scale).toBeGreaterThan(1)
    expect(scale).toBeLessThan(1.15)
    handle.destroy()
  })
})

describe('Pip owl palettes', () => {
  it('has a default plus eight complete, high-contrast agent palettes', () => {
    expect(Object.keys(palettes.agents)).toHaveLength(8)
    for (const palette of [palettes.default, ...Object.values(palettes.agents)]) {
      expect(Object.keys(palette)).toEqual(paintKeys)
      for (const color of Object.values(palette)) expect(color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(contrast(palette['--m-eye'], palette['--m-ink'])).toBeGreaterThan(9)
      expect(contrast(palette['--m-accent'], palette['--m-ink'])).toBeGreaterThan(5)
      for (const background of ['#161617', '#1c1c1e']) {
        expect(contrast(palette['--m-primary'], background)).toBeGreaterThan(5)
        expect(contrast(palette['--m-belly'], background)).toBeGreaterThan(9)
      }
    }
  })

  it('matches the default palette to every SVG color fallback', () => {
    for (const [, key, color] of rig.matchAll(/var\((--m-[a-z]+), (#[0-9a-f]{6})\)/g)) {
      expect(palettes.default[key as keyof typeof palettes.default], key).toBe(color)
    }
  })
})
