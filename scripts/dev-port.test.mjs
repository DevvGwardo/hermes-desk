import { describe, expect, it } from 'vitest'
import { DEFAULT_DEV_PORT, DEV_PORT_SPAN, pickDevPort } from './dev-port.mjs'

const busySet = (...ports) => (p) => ports.includes(p)

describe('pickDevPort — electron:dev never dies on a port another app holds', () => {
  it('uses 5173 when it is free', () => {
    expect(pickDevPort({ env: {}, busy: busySet() })).toEqual({ ok: true, port: 5173, pinned: false })
  })

  it('moves to the next free port when another project holds 5173 (the nubcat-studio case)', () => {
    expect(pickDevPort({ env: {}, busy: busySet(5173, 5174) })).toEqual({ ok: true, port: 5175, pinned: false })
  })

  it('NUB_DEV_PORT pins the port', () => {
    expect(pickDevPort({ env: { NUB_DEV_PORT: '5300' }, busy: busySet(5173) })).toEqual({
      ok: true,
      port: 5300,
      pinned: true,
    })
  })

  it('a pinned port that is busy fails loudly instead of silently moving', () => {
    const r = pickDevPort({ env: { NUB_DEV_PORT: '5300' }, busy: busySet(5300) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/NUB_DEV_PORT=5300 is in use/)
  })

  it('rejects a junk NUB_DEV_PORT', () => {
    for (const bad of ['abc', '80', '70000', '5173.5']) {
      const r = pickDevPort({ env: { NUB_DEV_PORT: bad }, busy: busySet() })
      expect(r.ok).toBe(false)
    }
  })

  it('reports when the whole range is taken', () => {
    const all = Array.from({ length: DEV_PORT_SPAN }, (_, i) => DEFAULT_DEV_PORT + i)
    const r = pickDevPort({ env: {}, busy: busySet(...all) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Set NUB_DEV_PORT/)
  })
})
