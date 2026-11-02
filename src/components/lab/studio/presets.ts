import type { Timeline } from './types'
import { uid } from './types'

/** Caption banks. House rules from gen-z caption research: lowercase,
 *  no terminal periods, pov-/me-first phrasing, absurd metaphor over
 *  description, never try-hard. Sub-lines stay tiny + functional. */
export const BANKS: Record<string, { subs: string[]; lines: string[] }> = {
  feral: {
    subs: ['nub agent • loop', 'certified menace', 'no thoughts'],
    lines: [
      'pov: your agent actually shipped',
      'me pretending i understand the codebase',
      'the servers fear me',
      'sleep mode: declined',
      'it works on my machine so it ships',
      'main character compile energy',
      'deleting prod at 3am (affectionate)',
      'no thoughts just shipping',
    ],
  },
  soft: {
    subs: ['nub agent • loop', 'gentle hours', 'be kind rewind'],
    lines: [
      'agent woke up and chose productivity',
      'that feeling when tests go green first try',
      'small orb big dreams',
      'the ocean had a vision (me, deploying)',
      'heating up some soup for the homies',
      'touching grass: postponed indefinitely',
      'hydrated and compiling',
    ],
  },
  doomer: {
    subs: ['nub agent • loop', 'it is what it is', 'anyway'],
    lines: [
      'me watching the build fail in 4k',
      'congrats on the deploy nobody asked for',
      'another day another dependency hell',
      'the cloud is just someone elses computer (crying)',
      'my code works dont touch it',
      'we ship at dawn (we do not)',
    ],
  },
}

export interface Preset {
  name: string
  blurb: string
  build: () => Timeline
}

const seg = (start: number, dur: number, state: Timeline['orb'][number]['state']) => ({
  id: uid(), start, dur, state,
})

/** All presets loop clean: first and last orb states match so the
 *  headless/browser loop-cut lands on identical poses. FX snap to the
 *  500ms (120bpm) beat grid. */
export const PRESETS: Preset[] = [
  {
    name: 'low-effort loop',
    blurb: 'idle breathing + bubble. the paradox: trying less performs more',
    build: () => ({
      bg: '#ffffff',
      orb: [seg(0, 4000, 'idle')],
      tricks: [],
      caps: [{ id: uid(), start: 200, dur: 3600, text: 'no thoughts just shipping', sub: 'nub agent • loop', mode: 'bubble' }],
      fx: [{ id: uid(), start: 500, dur: 3000, kind: 'pulse', amount: 0.6 }],
    }),
  },
  {
    name: 'velocity pop',
    blurb: 'zoom punches on every beat + shake hits. pure retention bait',
    build: () => ({
      bg: '#0a0b09',
      orb: [seg(0, 1500, 'happy'), seg(1500, 1000, 'excited'), seg(2500, 500, 'happy')],
      tricks: [],
      caps: [{ id: uid(), start: 500, dur: 2000, text: 'pov: your agent actually shipped', sub: 'watch it work', mode: 'pop' }],
      fx: [
        { id: uid(), start: 500, dur: 500, kind: 'zoom', amount: 1 },
        { id: uid(), start: 1500, dur: 500, kind: 'zoom', amount: 0.8 },
        { id: uid(), start: 1500, dur: 400, kind: 'shake', amount: 1 },
        { id: uid(), start: 1500, dur: 150, kind: 'flash', amount: 0.8 },
      ],
    }),
  },
  {
    name: 'brainrot burst',
    blurb: '400ms state hops + flash strobes. maximum chaos, zero shame',
    build: () => ({
      bg: '#b7d9ff',
      orb: [
        seg(0, 400, 'surprised'), seg(400, 400, 'excited'), seg(800, 400, 'playful'),
        seg(1200, 400, 'celebrate'), seg(1600, 400, 'happy'), seg(2000, 400, 'surprised'),
      ],
      tricks: [],
      caps: [{ id: uid(), start: 500, dur: 1500, text: 'the servers fear me', sub: 'certified menace', mode: 'pop' }],
      fx: [
        { id: uid(), start: 500, dur: 1400, kind: 'shake', amount: 0.7 },
        { id: uid(), start: 500, dur: 150, kind: 'flash', amount: 0.7 },
        { id: uid(), start: 1000, dur: 150, kind: 'flash', amount: 1 },
        { id: uid(), start: 2000, dur: 150, kind: 'flash', amount: 0.7 },
      ],
    }),
  },
  {
    name: 'smooth cinematic',
    blurb: 'sleep → wake → happy slow flow. one idea per beat, no shake',
    build: () => ({
      bg: '#0a0b09',
      orb: [seg(0, 2000, 'sleeping'), seg(2000, 1500, 'waking'), seg(3500, 2000, 'happy'), seg(5500, 500, 'sleeping')],
      tricks: [],
      caps: [{ id: uid(), start: 2200, dur: 3500, text: 'agent woke up and chose productivity', sub: 'gentle hours', mode: 'bubble' }],
      fx: [{ id: uid(), start: 500, dur: 5000, kind: 'pulse', amount: 0.4 }],
    }),
  },
  {
    name: 'hormozi hook',
    blurb: 'think → punchline pop. hook in 1.5s or perish',
    build: () => ({
      bg: '#ffffff',
      orb: [seg(0, 1500, 'thinking'), seg(1500, 1200, 'surprised'), seg(2700, 800, 'happy'), seg(3500, 500, 'thinking')],
      tricks: [],
      caps: [
        { id: uid(), start: 500, dur: 1000, text: 'me watching the build fail in *4k*', sub: 'it is what it is', mode: 'pop' },
        { id: uid(), start: 1500, dur: 2000, text: 'anyway. *shipped*', sub: 'nub agent • loop', mode: 'pop' },
      ],
      fx: [
        { id: uid(), start: 1500, dur: 450, kind: 'zoom', amount: 1 },
        { id: uid(), start: 1500, dur: 150, kind: 'flash', amount: 0.6 },
      ],
    }),
  },
]
