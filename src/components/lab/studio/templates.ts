import type { Mascot, Timeline } from './types'
import { uid } from './types'

/** Hollywood template registry. Every entry is loop-clean (opening pose ==
 *  closing pose), all fx/trick times snap to the 500ms BEAT grid, caps are
 *  1..12 words, totalDur lands 3000..4000ms. build() is pure. */
export type TemplateKind =
  | 'hook' | 'explainer' | 'tutorial' | 'promo'
  | 'meme' | 'cinematic' | 'quote' | 'hype'

export interface RegistryEntry {
  id: string
  name: string
  blurb: string
  kind: TemplateKind
  build: () => Timeline
  /** mascot direction. optional — entries without it keep the classic
   *  cat #b7d9ff/#1a3d6b via the stage fallback. */
  orb?: Mascot
}

/** Fitting shape+palette per template kind. Classic nub blue stays the
 *  default (hook/quote); cinematic goes moodier, hype runs hotter. */
const ORB: Record<TemplateKind, Mascot> = {
  hook: { shape: 'cat', fg: '#b7d9ff', bg: '#1a3d6b' },
  explainer: { shape: 'cat', fg: '#9fc4ee', bg: '#274e7d' },
  tutorial: { shape: 'cat', fg: '#a8c8e8', bg: '#1e4a73' },
  promo: { shape: 'cat', fg: '#cfe6ff', bg: '#163a5e' },
  meme: { shape: 'cat', fg: '#ffe08a', bg: '#4a2d12' },
  cinematic: { shape: 'cat', fg: '#7fa8d6', bg: '#0a1628' },
  quote: { shape: 'cat', fg: '#b7d9ff', bg: '#2b4a6f' },
  hype: { shape: 'cat', fg: '#ffc46b', bg: '#5e1a1a' },
}
const mascot = (kind: TemplateKind): Mascot => ({ ...ORB[kind] })

type OrbState = Timeline['orb'][number]['state']
const seg = (start: number, dur: number, state: OrbState) => ({
  id: uid(), start, dur, state,
})
const fx = (start: number, dur: number, kind: Timeline['fx'][number]['kind'], amount: number) => ({
  id: uid(), start, dur, kind, amount,
})
const cap = (start: number, dur: number, text: string, sub: string, mode: Timeline['caps'][number]['mode']) => ({
  id: uid(), start, dur, text, sub, mode,
})

/** Pure kind filter for the templates tab. 'all' returns every entry. */
export function filterKind(entries: RegistryEntry[], kind: TemplateKind | 'all'): RegistryEntry[] {
  if (kind === 'all') return [...entries]
  return entries.filter((e) => e.kind === kind)
}

export const TEMPLATES: RegistryEntry[] = [
  {
    id: 'hook-ugc', name: 'hook / ugc', kind: 'hook',
    blurb: 'pop hook with zoom punch and flash hit for retention',
    orb: { ...ORB.hook },
    build: () => ({
      bg: '#0a0b09',
      mascot: mascot('hook'),
      orb: [seg(0, 1500, 'happy'), seg(1500, 1000, 'excited'), seg(2500, 500, 'happy')],
      tricks: [],
      caps: [cap(500, 2000, 'pov: your agent actually shipped', 'watch it work', 'pop')],
      fx: [fx(500, 500, 'zoom', 1), fx(1500, 500, 'zoom', 1), fx(1500, 150, 'flash', 0.8)],
    }),
  },
  {
    id: 'explainer', name: 'explainer', kind: 'explainer',
    blurb: 'bubble intro with pop beats over ambient pulse',
    orb: { ...ORB.explainer },
    build: () => ({
      bg: '#ffffff',
      mascot: mascot('explainer'),
      orb: [seg(0, 2000, 'idle'), seg(2000, 1000, 'curious'), seg(3000, 1000, 'idle')],
      tricks: [],
      caps: [
        cap(200, 1600, 'small orb big dreams', 'nub agent • loop', 'bubble'),
        cap(2000, 1500, 'tap through every step slowly', 'gentle hours', 'pop'),
      ],
      fx: [fx(500, 3000, 'pulse', 0.6)],
    }),
  },
  {
    id: 'tutorial', name: 'tutorial', kind: 'tutorial',
    blurb: 'bottom bar steps with pulse and no strobes',
    orb: { ...ORB.tutorial },
    build: () => ({
      bg: '#ffffff',
      mascot: mascot('tutorial'),
      orb: [seg(0, 2000, 'working'), seg(2000, 1000, 'curious'), seg(3000, 1000, 'working')],
      tricks: [],
      caps: [cap(500, 3000, 'follow along step by step', '', 'bar')],
      fx: [fx(500, 3000, 'pulse', 0.5)],
    }),
  },
  {
    id: 'promo-launch', name: 'promo / launch', kind: 'promo',
    blurb: 'pop with zoom punches and burst hit',
    orb: { ...ORB.promo },
    build: () => ({
      bg: '#0a0b09',
      mascot: mascot('promo'),
      orb: [seg(0, 1000, 'excited'), seg(1000, 1500, 'celebrate'), seg(2500, 500, 'excited')],
      tricks: [],
      caps: [cap(500, 2000, '*shipped* it anyway watch', 'nub agent • loop', 'pop')],
      fx: [fx(500, 500, 'zoom', 1), fx(1000, 500, 'zoom', 1), fx(1000, 150, 'flash', 0.8)],
    }),
  },
  {
    id: 'meme-loop', name: 'meme loop', kind: 'meme',
    blurb: 'pop caption with shake groove and bounce',
    orb: { ...ORB.meme },
    build: () => ({
      bg: '#b7d9ff',
      mascot: mascot('meme'),
      orb: [seg(0, 1000, 'playful'), seg(1000, 1000, 'surprised'), seg(2000, 1000, 'playful')],
      tricks: [],
      caps: [cap(500, 2000, 'no thoughts just shipping', 'certified menace', 'pop')],
      fx: [fx(500, 2000, 'shake', 0.7), fx(1000, 150, 'flash', 0.5)],
    }),
  },
  {
    id: 'cinematic', name: 'cinematic', kind: 'cinematic',
    blurb: 'slow sleep wake flow with bubble and pulse only',
    orb: { ...ORB.cinematic },
    build: () => ({
      bg: '#0a0b09',
      mascot: mascot('cinematic'),
      orb: [seg(0, 2000, 'sleeping'), seg(2000, 1500, 'waking'), seg(3500, 500, 'sleeping')],
      tricks: [],
      caps: [cap(200, 3600, 'agent woke up and chose productivity', 'gentle hours', 'bubble')],
      fx: [fx(500, 3000, 'pulse', 0.4)],
    }),
  },
  {
    id: 'quote', name: 'quote', kind: 'quote',
    blurb: 'static card with no motion fx',
    orb: { ...ORB.quote },
    build: () => ({
      bg: '#ffffff',
      mascot: mascot('quote'),
      orb: [seg(0, 4000, 'idle')],
      tricks: [],
      caps: [cap(500, 3000, 'my code works dont touch it', 'it is what it is', 'bar')],
      fx: [],
    }),
  },
  {
    id: 'hype-countdown', name: 'hype / countdown', kind: 'hype',
    blurb: 'bar countdown with flash strobes and a zoom hit',
    orb: { ...ORB.hype },
    build: () => ({
      bg: '#0a0b09',
      mascot: mascot('hype'),
      orb: [seg(0, 500, 'excited'), seg(500, 500, 'surprised'), seg(1000, 500, 'excited'), seg(1500, 1000, 'celebrate'), seg(2500, 500, 'excited')],
      tricks: [],
      caps: [cap(100, 2900, 'three two one ship it', 'nub agent • loop', 'bar')],
      fx: [fx(0, 150, 'flash', 0.7), fx(1000, 150, 'flash', 0.7), fx(2000, 500, 'zoom', 1), fx(2000, 150, 'flash', 1)],
    }),
  },
]
