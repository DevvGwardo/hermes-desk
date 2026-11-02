import { describe, expect, it } from 'vitest'
import rig from './rig.svg?raw'
import motionSource from './motion.json?raw'
import paletteSource from './palette.json?raw'

type Pose = Partial<Record<'rotate' | 'tx' | 'ty' | 'sx' | 'sy', number>>
interface StateSpec {
  pose: Record<string, Pose>
  osc: Array<{ part: string; prop: keyof Pose; amp: number; freq: number; phase: number }>
  mouth: string
  eyes: { blinkEvery: [number, number]; look: string; pupilScale: number }
  fx?: Array<{ type: string; anchor: string }>
}
interface MotionSpec {
  states: Record<string, StateSpec>
  springs: {
    default: { stiffness: number; damping: number }
    parts: Record<string, { stiffness: number; damping: number }>
  }
  reactions: Record<string, { duration: number; pose: Record<string, Pose> }>
}
const motion: MotionSpec = JSON.parse(motionSource)
const palettes: { default: Record<string, string>; agents: Array<Record<string, string>> } = JSON.parse(paletteSource)
const document = new DOMParser().parseFromString(rig, 'image/svg+xml')
const parts = [...document.querySelectorAll<SVGGElement>('[id^="part-"]')]
const partNames = new Set(parts.map(part => part.id.slice(5)))
const stateNames = ['idle', 'thinking', 'tool', 'browsing', 'waiting', 'talking', 'happy', 'error', 'sleep']
const mouthNames = ['neutral', 'smile', 'open', 'o', 'flat', 'grin']
const paletteKeys = ['primary', 'secondary', 'accent', 'belly', 'ink', 'eye', 'shine']
const poseKeys = ['rotate', 'tx', 'ty', 'sx', 'sy']

function checkPose(pose: Record<string, Pose>) {
  for (const [name, values] of Object.entries(pose)) {
    expect(partNames.has(name), `Unknown part ${name}`).toBe(true)
    for (const [prop, value] of Object.entries(values)) {
      expect(poseKeys, `${name}.${prop}`).toContain(prop)
      expect(Number.isFinite(value), `${name}.${prop}`).toBe(true)
      if (prop === 'sx' || prop === 'sy') {
        expect(value).toBeGreaterThanOrEqual(name.startsWith('lid-') ? 0 : 0.1)
        expect(value).toBeLessThanOrEqual(2)
      }
    }
  }
}

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (high + 0.05) / (low + 0.05)
}

describe('Dash vector rig', () => {
  it('is accessible, well-formed, self-contained vector art at the contract dimensions', () => {
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 512 512')
    expect(document.querySelector('title')?.textContent).toContain('Dash')
    expect(document.querySelector('desc')?.textContent).toContain('sandals')
    expect(document.querySelectorAll('script, image, foreignObject, animate, animateTransform, use')).toHaveLength(0)
    expect(rig).not.toMatch(/\b(?:href|onload|onclick)=/i)
  })

  it('has unique IDs and character-prefixed paint servers and clips', () => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const node of document.querySelectorAll('defs [id]')) expect(node.id).toMatch(/^fox-/)
    for (const match of rig.matchAll(/url\(#([^)]+)\)/g)) expect(document.getElementById(match[1])).not.toBeNull()
  })

  it('declares finite pivots and the real nested parent for every articulated group', () => {
    expect(parts.length).toBeGreaterThanOrEqual(20)
    for (const part of parts) {
      expect(part.tagName).toBe('g')
      const pivot = part.getAttribute('data-pivot')?.split(/\s+/).map(Number)
      expect(pivot).toHaveLength(2)
      expect(pivot?.every(Number.isFinite)).toBe(true)
      const parent = part.parentElement?.closest('[id^="part-"]')
      if (part.id === 'part-root') {
        expect(parent).toBeNull()
        expect(part.hasAttribute('data-parent')).toBe(false)
      } else {
        expect(part.getAttribute('data-parent')).toBe(parent?.id)
      }
    }
    expect(document.getElementById('part-head')?.getAttribute('data-parent')).toBe('part-body')
  })

  it('provides all required face parts, local pupil clips, and independently movable talaria', () => {
    for (const name of ['body', 'head', 'eye-l', 'eye-r', 'lid-l', 'lid-r', 'mouth']) {
      expect(partNames.has(name)).toBe(true)
    }
    for (const side of ['l', 'r']) {
      const pupil = document.getElementById(`pupil-${side}`)
      expect(pupil?.closest('[id^="part-"]')?.id).toBe(`part-eye-${side}`)
      expect(pupil?.parentElement?.getAttribute('clip-path')).toBe(`url(#fox-eye-clip-${side})`)
      expect(document.getElementById(`part-wing-${side}`)?.getAttribute('data-parent')).toBe(`part-foot-${side}`)
    }
  })

  it('includes six expressions with exactly one visible in the raw SVG', () => {
    const mouths = [...document.querySelectorAll('[id^="mouth-"]')]
    expect(mouths.map(node => node.id.slice(6)).sort()).toEqual([...mouthNames].sort())
    expect(mouths.filter(node => node.getAttribute('display') !== 'none').map(node => node.id)).toEqual(['mouth-neutral'])
    for (const mouth of mouths) expect(mouth.parentElement?.id).toBe('part-mouth')
  })

  it('uses only supported CSS variable colours, including gradient stops', () => {
    const used = new Set<string>()
    for (const node of document.querySelectorAll('*')) {
      for (const name of ['fill', 'stroke', 'stop-color']) {
        const value = node.getAttribute(name)
        if (!value || value === 'none' || value.startsWith('url(#fox-')) continue
        const match = value.match(/^var\(--m-([a-z]+), (#[0-9a-f]{6})\)$/i)
        expect(match, `${node.id || node.tagName} ${name}=${value}`).not.toBeNull()
        if (match) {
          expect(paletteKeys).toContain(match[1])
          expect(palettes.default[match[1]].toLowerCase()).toBe(match[2].toLowerCase())
          used.add(match[1])
        }
      }
    }
    expect([...used].sort()).toEqual([...paletteKeys].sort())
  })

  it('paints the tail in front of the head so sleep can cover the muzzle without a new engine API', () => {
    const children = [...document.getElementById('part-body')!.children]
    expect(children.indexOf(document.getElementById('part-tail')!)).toBeGreaterThan(children.indexOf(document.getElementById('part-head')!))
  })
})

describe('Dash motion contract', () => {
  it('implements exactly the nine required states', () => {
    expect(Object.keys(motion.states).sort()).toEqual([...stateNames].sort())
  })

  for (const name of stateNames) {
    it(`has a valid, engine-addressable ${name} pose, oscillator set, face, and FX`, () => {
      const state = motion.states[name]
      checkPose(state.pose)
      expect(mouthNames).toContain(state.mouth)
      expect(state.eyes.blinkEvery).toHaveLength(2)
      expect(state.eyes.blinkEvery[0]).toBeGreaterThan(0)
      expect(state.eyes.blinkEvery[1]).toBeGreaterThanOrEqual(state.eyes.blinkEvery[0])
      expect(['cursor', 'center', 'wander', 'down', 'up-left']).toContain(state.eyes.look)
      expect(state.eyes.pupilScale).toBeGreaterThan(0)
      expect(state.eyes.pupilScale).toBeLessThanOrEqual(1.2)
      for (const osc of state.osc) {
        expect(partNames.has(osc.part)).toBe(true)
        expect(poseKeys).toContain(osc.prop)
        expect([osc.amp, osc.freq, osc.phase].every(Number.isFinite)).toBe(true)
        expect(osc.amp).toBeGreaterThan(0)
        expect(osc.freq).toBeGreaterThan(0)
        expect(osc.freq).toBeLessThanOrEqual(4)
        if (osc.prop === 'sx' || osc.prop === 'sy') {
          expect((state.pose[osc.part]?.[osc.prop] ?? 1) - osc.amp).toBeGreaterThan(0)
        }
      }
      for (const fx of state.fx ?? []) {
        expect(['sparkle', 'dots', 'zzz', 'sweat', 'ring']).toContain(fx.type)
        expect(document.getElementById(fx.anchor)).not.toBeNull()
      }
    })
  }

  it('keeps sleep lids closed and all other resting lids open or partially lowered', () => {
    for (const state of stateNames) {
      const pose = motion.states[state].pose
      for (const side of ['l', 'r']) {
        if (state === 'sleep') expect(pose[`lid-${side}`].sy).toBe(1)
        else expect(pose[`lid-${side}`].sy).toBeLessThan(0.4)
      }
    }
  })

  it('encodes the signature motion for paws, swivelling ears, wing flutters, tail wags, and speech', () => {
    expect(motion.states.thinking.pose['hand-l'].rotate).toBeLessThan(-100)
    for (const part of ['hand-l', 'hand-r', 'tail']) expect(motion.states.tool.osc.some(osc => osc.part === part)).toBe(true)
    for (const part of ['ear-l', 'ear-r', 'wing-l', 'wing-r']) expect(motion.states.browsing.osc.some(osc => osc.part === part)).toBe(true)
    expect(motion.states.browsing.eyes.look).toBe('wander')
    expect(motion.states.talking.osc.some(osc => osc.part === 'mouth' && osc.prop === 'sy')).toBe(true)
    expect(motion.states.happy.osc.some(osc => osc.part === 'body' && osc.prop === 'ty')).toBe(true)
    expect(motion.states.sleep.pose.tail.rotate).toBeLessThan(-90)
    expect(motion.states.sleep.fx?.[0].type).toBe('zzz')
  })

  it('provides finite positive springs and the three documented one-shot overlays', () => {
    for (const [part, spring] of Object.entries(motion.springs.parts)) {
      expect(partNames.has(part)).toBe(true)
      expect(spring.stiffness).toBeGreaterThan(0)
      expect(spring.damping).toBeGreaterThan(0)
      expect(Number.isFinite(spring.stiffness + spring.damping)).toBe(true)
    }
    expect(motion.springs.default.stiffness).toBeGreaterThan(0)
    expect(motion.springs.default.damping).toBeGreaterThan(0)
    expect(Object.keys(motion.reactions).sort()).toEqual(['approval', 'message', 'pulse'])
    for (const reaction of Object.values(motion.reactions)) {
      expect(reaction.duration).toBeGreaterThan(0)
      expect(reaction.duration).toBeLessThanOrEqual(1)
      checkPose(reaction.pose)
    }
  })
})

describe('Dash agent palettes', () => {
  it('ships one default and eight unique complete palettes', () => {
    expect(palettes.agents).toHaveLength(8)
    const all = [palettes.default, ...palettes.agents]
    expect(new Set(all.map(palette => palette.primary)).size).toBe(9)
    for (const palette of all) {
      expect(Object.keys(palette).sort()).toEqual([...paletteKeys].sort())
      for (const colour of Object.values(palette)) expect(colour).toMatch(/^#[a-f0-9]{6}$/i)
    }
  })

  it('keeps the silhouette, scarf, and cream details readable on both messenger canvases', () => {
    for (const palette of [palettes.default, ...palettes.agents]) {
      for (const canvas of ['#161617', '#1c1c1e']) {
        for (const key of ['primary', 'accent', 'belly', 'shine']) {
          expect(contrast(palette[key], canvas), `${key} on ${canvas}`).toBeGreaterThan(4)
        }
      }
      expect(contrast(palette.ink, palette.eye)).toBeGreaterThan(8)
      expect(contrast(palette.ink, palette.belly)).toBeGreaterThan(7)
      expect(contrast(palette.ink, palette.primary)).toBeGreaterThan(4)
    }
  })
})
