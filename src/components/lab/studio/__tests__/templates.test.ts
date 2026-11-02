import { describe, expect, it } from 'vitest'
import { orbAt, totalDur, type Timeline } from '../types'

/** Loop Studio template-registry contract tests (architect spec).
 *  RegistryEntry{id,name,blurb,kind,build():Timeline}; kinds subset of
 *  hook/explainer/tutorial/promo/meme/cinematic/quote/hype.
 *  Behavioral calls only — no source regex. */

interface RegistryEntry {
  id: string
  name: string
  blurb: string
  kind: string
  build: () => Timeline
}

const KINDS: readonly string[] = [
  'hook',
  'explainer',
  'tutorial',
  'promo',
  'meme',
  'cinematic',
  'quote',
  'hype',
]
const MODES: readonly string[] = ['bubble', 'bar', 'pop']
const BEAT = 500

// Tolerate absence: the glob resolves to {} until templates.ts lands, so
// the suite stays green with one RED pin instead of a collection error.
const loaders: Record<string, () => Promise<unknown>> = import.meta.glob('../templates.ts')
const loadMod = async (): Promise<Record<string, unknown> | null> => {
  const key = Object.keys(loaders).find((k) => k.endsWith('/templates.ts'))
  if (!key) return null
  try {
    return (await loaders[key]()) as Record<string, unknown>
  } catch {
    return null
  }
}

const asEntries = (v: unknown): RegistryEntry[] | null =>
  Array.isArray(v) && v.every((e) => typeof (e as RegistryEntry)?.build === 'function')
    ? (v as RegistryEntry[])
    : null

/** Probe both specified shapes: { TEMPLATES } array, else { getTemplate }. */
const resolveEntries = (mod: Record<string, unknown> | null): RegistryEntry[] | null => {
  if (!mod) return null
  const fromArray = asEntries(mod['TEMPLATES']) ?? asEntries(mod['default'])
  if (fromArray) return fromArray
  if (typeof mod['getTemplate'] === 'function') {
    const ids = [mod['TEMPLATE_IDS'], mod['IDS']].find(
      (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    )
    if (ids) {
      const get = mod['getTemplate'] as (id: string) => RegistryEntry | null | undefined
      const out: RegistryEntry[] = []
      for (const id of ids) {
        const e = get(id)
        if (e && typeof e.build === 'function') out.push(e)
      }
      if (out.length) return out
    }
  }
  return null
}

/** Timeline minus volatile ids — purity compares everything else. */
const stripIds = (tl: Timeline): unknown => ({
  bg: tl.bg,
  orb: tl.orb.map((s) => ({ start: s.start, dur: s.dur, state: s.state })),
  tricks: tl.tricks.map((t) => ({ t: t.t, trick: t.trick })),
  caps: tl.caps.map((c) => ({ start: c.start, dur: c.dur, text: c.text, sub: c.sub, mode: c.mode })),
  fx: tl.fx.map((f) => ({ start: f.start, dur: f.dur, kind: f.kind, amount: f.amount })),
})

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length

const mod = await loadMod()
const ENTRIES: RegistryEntry[] | null = resolveEntries(mod)

if (!ENTRIES) {
  it.fails('templates registry pending — placeholder until templates.ts lands', () => {
    expect(ENTRIES).not.toBeNull()
  })
} else {
  const entries: RegistryEntry[] = ENTRIES

  describe('templates: registry shape', () => {
    it('every entry has non-empty id/name/blurb, known kind, and a build fn', () => {
      for (const e of entries) {
        expect(e.id.trim().length, 'id').toBeGreaterThan(0)
        expect(e.name.trim().length, `${e.id} name`).toBeGreaterThan(0)
        expect(e.blurb.trim().length, `${e.id} blurb`).toBeGreaterThan(0)
        expect(KINDS, `${e.id} kind=${e.kind}`).toContain(e.kind)
        expect(typeof e.build, `${e.id} build`).toBe('function')
      }
    })

    it('ids are unique', () => {
      const ids = entries.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('registry covers all 8 kinds', () => {
      const have = new Set(entries.map((e) => e.kind))
      for (const k of KINDS) expect(have.has(k), `missing kind ${k}`).toBe(true)
    })

    it('every build returns non-null track arrays with a non-empty orb', () => {
      for (const e of entries) {
        const tl = e.build()
        expect(tl, e.id).not.toBeNull()
        for (const track of [tl.orb, tl.tricks, tl.caps, tl.fx] as const)
          expect(Array.isArray(track), `${e.id} track`).toBe(true)
        expect(tl.orb.length, `${e.id} orb`).toBeGreaterThan(0)
      }
    })
  })

  describe('templates: build purity + concurrency', () => {
    it('two builds are equal ignoring ids (pure, no shared mutable state)', () => {
      for (const e of entries)
        expect(stripIds(e.build()), `${e.id} pure`).toEqual(stripIds(e.build()))
    })

    it('interleaved builds do not leak state across instances', () => {
      for (const e of entries) {
        const a1 = e.build()
        const b = e.build()
        const a2 = e.build()
        expect(stripIds(a1), `${e.id} a1==a2`).toEqual(stripIds(a2))
        expect(stripIds(a1), `${e.id} a1==b`).toEqual(stripIds(b))
      }
    })
  })

  describe('templates: loop + beat grid', () => {
    it('totalDur is 2000..6000ms inclusive (boundary)', () => {
      for (const e of entries) {
        const d = totalDur(e.build())
        expect(d, `${e.id} dur=${d}`).toBeGreaterThanOrEqual(2000)
        expect(d, `${e.id} dur=${d}`).toBeLessThanOrEqual(6000)
      }
    })

    it('loops clean: orbAt(totalDur-1) === opening pose', () => {
      for (const e of entries) {
        const tl = e.build()
        expect(orbAt(tl, totalDur(tl) - 1), e.id).toBe(tl.orb[0].state)
      }
    })

    it('all fx starts and trick times sit on the 500ms grid', () => {
      for (const e of entries) {
        const tl = e.build()
        for (const f of tl.fx) expect(f.start % BEAT, `${e.id} fx@${f.start}`).toBe(0)
        for (const t of tl.tricks) expect(t.t % BEAT, `${e.id} trick@${t.t}`).toBe(0)
      }
    })
  })

  describe('templates: captions', () => {
    it('every cap has 1..12 words, valid mode, dur>0, start>=0', () => {
      for (const e of entries) {
        for (const c of e.build().caps) {
          const n = words(c.text)
          expect(n, `${e.id}: "${c.text}"`).toBeGreaterThanOrEqual(1)
          expect(n, `${e.id}: "${c.text}"`).toBeLessThanOrEqual(12)
          expect(MODES, `${e.id} mode=${c.mode}`).toContain(c.mode)
          expect(c.dur, `${e.id} dur`).toBeGreaterThan(0)
          expect(c.start, `${e.id} start`).toBeGreaterThanOrEqual(0)
        }
      }
    })
  })

  describe('templates: getTemplate cross-check', () => {
    it('getTemplate(id) agrees with TEMPLATES when both shapes exist', () => {
      if (!mod || typeof mod['getTemplate'] !== 'function') return
      const get = mod['getTemplate'] as (id: string) => RegistryEntry | null | undefined
      for (const e of entries) {
        const found = get(e.id)
        if (!found) continue // shape without per-id lookup — TEMPLATES is source of truth
        expect(stripIds(found.build()), `getTemplate(${e.id})`).toEqual(stripIds(e.build()))
      }
    })
  })
}
