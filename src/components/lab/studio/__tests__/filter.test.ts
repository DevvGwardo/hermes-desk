import { describe, expect, it } from 'vitest'
import { filterKind, TEMPLATES } from '../templates'
import type { RegistryEntry } from '../templates'
const mk = (id: string, kind: any): RegistryEntry => ({ id, name: id, blurb: id, kind, build: () => null as any })
const entries = [mk('a', 'hook'), mk('b', 'meme'), mk('c', 'hook')]
describe('filterKind', () => {
it('all returns every entry in order as a new array', () => {
const out = filterKind(entries, 'all')
expect(out).toEqual(entries)
expect(out).not.toBe(entries)
})
it('hook returns only hook entries', () => {
expect(filterKind(entries, 'hook').map((e) => e.id)).toEqual(['a', 'c'])
})
it('unknown kind returns []', () => {
expect(filterKind(entries, 'nope' as any)).toEqual([])
})
it('does not mutate input', () => {
const snap = [...entries]
filterKind(entries, 'hook')
expect(entries).toEqual(snap)
})
it('every registry kind has >=1 entry', () => {
if (!TEMPLATES?.length) return
for (const k of new Set(TEMPLATES.map((e) => e.kind))) expect(filterKind(TEMPLATES, k).length).toBeGreaterThan(0)
})
})
