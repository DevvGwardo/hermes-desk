import { describe, expect, it } from 'vitest'
import rig from './rig.svg?raw'
import motionText from './motion.json?raw'
import paletteText from './palette.json?raw'

type Pose = Partial<Record<'rotate' | 'tx' | 'ty' | 'sx' | 'sy', number>>
interface Fx { type: string; anchor: string; count?: number }
interface State {
  pose: Record<string, Pose>
  osc: Array<{ part: string; prop: keyof Pose; amp: number; freq: number; phase: number }>
  mouth: string
  eyes: { blinkEvery: [number, number]; look: string; pupilScale: number }
  fx: Fx[]
}
interface Motion {
  states: Record<string, State>
  springs: { default: { stiffness: number; damping: number }; parts: Record<string, { stiffness: number; damping: number }> }
  reactions: Record<string, { duration: number; pose: Record<string, Pose>; mouth?: string; fx: Fx[] }>
}
const motion = JSON.parse(motionText) as Motion
const palettes = JSON.parse(paletteText) as { default: Record<string, string>; agents: Record<string, Record<string, string>> }
const doc = new DOMParser().parseFromString(rig, 'image/svg+xml')
const parts = [...doc.querySelectorAll<SVGGElement>('[data-pivot]')]
const names = new Set(parts.map(part => part.id.replace('part-', '')))
const expressions = ['neutral', 'smile', 'open', 'o', 'flat', 'grin']
const keys = ['--m-primary', '--m-secondary', '--m-accent', '--m-belly', '--m-ink', '--m-eye', '--m-shine']

function luminance(hex: string): number {
  const values = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}
function checkPose(pose: Record<string, Pose>): void {
  for (const [name, target] of Object.entries(pose)) {
    expect(names.has(name), `unknown pose part: ${name}`).toBe(true)
    for (const [prop, value] of Object.entries(target)) {
      expect(['rotate', 'tx', 'ty', 'sx', 'sy']).toContain(prop)
      expect(Number.isFinite(value)).toBe(true)
      if (prop === 'sx' || prop === 'sy') expect(value).toBeGreaterThanOrEqual(0)
    }
  }
}
function checkFx(effects: Fx[]): void {
  for (const fx of effects) {
    expect(['sparkle', 'dots', 'zzz', 'sweat', 'ring']).toContain(fx.type)
    expect(doc.getElementById(fx.anchor)).not.toBeNull()
  }
}

describe('Wisp character contract', () => {
  it('parses as standalone, safe vector art with unique, locally resolved references', () => {
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 512 512')
    expect(doc.querySelector('script, image, foreignObject, animate, animateTransform')).toBeNull()
    const elements = [...doc.querySelectorAll('[id]')]
    expect(new Set(elements.map(el => el.id)).size).toBe(elements.length)
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        expect(attr.name.startsWith('on')).toBe(false)
        expect(attr.name.endsWith('href')).toBe(false)
        for (const reference of attr.value.matchAll(/url\(#([^)]+)\)/g)) {
          expect(reference[1]).toMatch(/^sprite-/)
          expect(doc.getElementById(reference[1])).not.toBeNull()
        }
      }
    }
    for (const el of doc.querySelectorAll('defs [id]')) expect(el.id).toMatch(/^sprite-/)
  })

  it('expresses every movable part as a pivoted group matching the real DOM hierarchy', () => {
    for (const name of ['root', 'body', 'head', 'eye-l', 'eye-r', 'lid-l', 'lid-r', 'mouth', 'tail', 'tail-tip', 'helmet', 'wing-l', 'wing-r']) {
      expect(names.has(name), `required part: ${name}`).toBe(true)
    }
    for (const part of parts) {
      expect(part.tagName).toBe('g')
      expect(part.id).toMatch(/^part-/)
      const pivot = part.getAttribute('data-pivot')!.split(' ').map(Number)
      expect(pivot).toHaveLength(2)
      expect(pivot.every(Number.isFinite)).toBe(true)
      const parent = part.parentElement?.closest('[data-pivot]')
      expect(part.getAttribute('data-parent')).toBe(parent?.id ?? null)
    }
    expect(doc.getElementById('part-head')!.parentElement!.id).toBe('part-body')
    for (const side of ['l', 'r']) expect(doc.getElementById(`part-eye-${side}`)!.querySelector(`#pupil-${side}`)).not.toBeNull()
  })

  it('has a useful static idle fallback and independently selectable mouth expressions', () => {
    const children = [...doc.getElementById('part-mouth')!.children]
    expect(children.map(el => el.id)).toEqual(expressions.map(expr => `mouth-${expr}`))
    expect(children.filter(el => !el.getAttribute('style')?.includes('display:none')).map(el => el.id)).toEqual(['mouth-neutral'])
    for (const side of ['l', 'r']) {
      expect(doc.getElementById(`part-lid-${side}`)!.getAttribute('transform')).toContain('scale(1 0)')
      expect(doc.getElementById(`part-spark-${side}`)!.getAttribute('transform')).toContain('scale(0)')
    }
  })

  it('uses only tintable contract pigments including all gradient stops', () => {
    const used = new Set<string>()
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of ['fill', 'stroke', 'stop-color', 'color', 'flood-color']) {
        const paint = el.getAttribute(attr)
        if (!paint || paint === 'none' || paint.startsWith('url(#')) continue
        expect(paint).toMatch(/^var\(--m-[a-z]+, #[0-9a-f]{6}\)$/)
        const variable = paint.match(/--m-[a-z]+/)![0]
        expect(keys).toContain(variable)
        used.add(variable)
      }
    }
    expect([...used].sort()).toEqual([...keys].sort())
    for (const stop of doc.querySelectorAll('stop')) expect(stop.getAttribute('stop-color')).toMatch(/^var\(/)
    expect(doc.querySelector('filter')).toBeNull()
  })

  it('covers all nine states with finite targets, declared parts, and supported effects', () => {
    expect(Object.keys(motion.states)).toEqual(['idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep'])
    for (const spec of Object.values(motion.states)) {
      checkPose(spec.pose)
      expect(expressions).toContain(spec.mouth)
      expect(spec.eyes.blinkEvery[0]).toBeGreaterThan(0)
      expect(spec.eyes.blinkEvery[1]).toBeGreaterThanOrEqual(spec.eyes.blinkEvery[0])
      expect(spec.eyes.pupilScale).toBeGreaterThan(0)
      expect(['cursor', 'center', 'up-left', 'down', 'wander']).toContain(spec.eyes.look)
      checkFx(spec.fx)
      for (const osc of spec.osc) {
        expect(names.has(osc.part), `unknown oscillator: ${osc.part}`).toBe(true)
        expect(['rotate', 'tx', 'ty', 'sx', 'sy']).toContain(osc.prop)
        expect([osc.amp, osc.freq, osc.phase].every(Number.isFinite)).toBe(true)
        expect(osc.freq).toBeGreaterThan(0)
        for (let step = 0; step < 320; step++) {
          const neutral = osc.prop === 'sx' || osc.prop === 'sy' ? 1 : 0
          const value = (spec.pose[osc.part]?.[osc.prop] ?? neutral) + osc.amp * Math.sin(step / 40 * osc.freq * Math.PI * 2 + osc.phase)
          expect(Number.isFinite(value)).toBe(true)
          if (osc.prop === 'sx' || osc.prop === 'sy') expect(value).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('keeps sleep closed and dims glow through standard transforms, without schema extensions', () => {
    expect(motion.states.sleep.pose['lid-l'].sy).toBe(1)
    expect(motion.states.sleep.pose['lid-r'].sy).toBe(1)
    for (const state of ['error', 'sleep']) {
      expect(motion.states[state].pose['inner-glow'].sx).toBeLessThan(0.6)
      expect(motion.states[state].pose.light.sx).toBe(0)
    }
    for (const side of ['l', 'r']) {
      expect(motion.states.tool.pose[`spark-${side}`].sx).toBeGreaterThan(0)
      expect(motion.states.browsing.osc.some(osc => osc.part === `pupil-${side}` && osc.prop === 'tx')).toBe(true)
    }
  })

  it('provides stable, looser appendage springs and bounded one-shot overlays', () => {
    for (const spring of [motion.springs.default, ...Object.values(motion.springs.parts)]) {
      expect(spring.stiffness).toBeGreaterThan(0)
      expect(spring.damping).toBeGreaterThan(0)
    }
    for (const name of Object.keys(motion.springs.parts)) expect(names.has(name)).toBe(true)
    expect(motion.springs.parts.tail.stiffness).toBeLessThan(motion.springs.default.stiffness)
    expect(motion.springs.parts['tail-tip'].stiffness).toBeLessThan(motion.springs.parts.tail.stiffness)
    expect(Object.keys(motion.reactions)).toEqual(['pulse', 'message', 'approval'])
    for (const reaction of Object.values(motion.reactions)) {
      expect(reaction.duration).toBeGreaterThan(0)
      expect(reaction.duration).toBeLessThanOrEqual(1.2)
      checkPose(reaction.pose)
      checkFx(reaction.fx)
      if (reaction.mouth) expect(expressions).toContain(reaction.mouth)
    }
  })

  it('ships a matching default and eight complete, dark-background-safe agent palettes', () => {
    expect(Object.keys(palettes.agents)).toHaveLength(8)
    for (const palette of [palettes.default, ...Object.values(palettes.agents)]) {
      expect(Object.keys(palette).sort()).toEqual([...keys].sort())
      for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrast(palette['--m-eye'], palette['--m-ink'])).toBeGreaterThan(7)
      for (const background of ['#161617', '#1c1c1e']) {
        expect(contrast(palette['--m-primary'], background)).toBeGreaterThan(7)
        expect(contrast(palette['--m-accent'], background)).toBeGreaterThan(7)
      }
    }
    for (const pigment of rig.matchAll(/var\((--m-[a-z]+), (#[0-9a-f]{6})\)/g)) {
      expect(pigment[2]).toBe(palettes.default[pigment[1]])
    }
  })
})
