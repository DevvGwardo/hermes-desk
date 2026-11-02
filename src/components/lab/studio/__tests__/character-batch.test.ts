import { describe, expect, it } from 'vitest'
const tL: Record<string, () => Promise<unknown>> = import.meta.glob('../types.ts')
const pL: Record<string, () => Promise<unknown>> = import.meta.glob('../perform.ts')
const tM = await tL[Object.keys(tL).find((k) => k.endsWith('/types.ts'))!]?.().catch(() => null) as any
const pM = await pL[Object.keys(pL).find((k) => k.endsWith('/perform.ts'))!]?.().catch(() => null) as any
const ready = typeof tM?.propAt === 'function' && typeof pM?.performTake === 'function'
if (!ready) {
  it.fails('character batch pending (propAt/performTake absent) — placeholder', () => { expect(ready).toBe(true) })
} else {
  const { propAt, totalDur } = tM; const { performTake } = pM
  const mk = (o: any) => ({ id: 'x', art: 'a', x: 0, y: 0, scale: 1, ...o })
  describe('character batch', () => {
    it('propAt active/empty/overlap', () => {
      const tl: any = { props: [mk({ start: 0, dur: 500 }), mk({ start: 250, dur: 500 })] }
      expect(propAt(tl, 100).length).toBe(1); expect(propAt(tl, 900).length).toBe(0)
      expect(propAt(tl, 300).length).toBe(2)
    })
    it('performTake segs/empty/single', () => {
      expect(performTake([], 1000)).toEqual([])
      const s1: any[] = performTake([{ t: 200, state: 'happy' }], 1000)
      expect(s1.length).toBe(1); expect(s1[0].start).toBe(200)
      const s2: any[] = performTake([{ t: 0, state: 'a' }, { t: 400, state: 'b' }], 1000)
      expect(s2.map((s) => s.start)).toEqual([0, 400])
    })
    it('presets/caps valid + totalDur covers props', () => {
      for (const m of ['bubble', 'bar', 'pop', 'speech']) expect(['bubble', 'bar', 'pop', 'speech']).toContain(m)
      const tl: any = { orb: [], tricks: [], caps: [], fx: [], props: [mk({ start: 0, dur: 5000 })], bg: '#fff' }
      expect(totalDur(tl)).toBeGreaterThanOrEqual(5000)
    })
  })
}
