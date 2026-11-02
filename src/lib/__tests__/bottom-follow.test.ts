import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBottomFollower } from '../bottom-follow'

let frames: Array<(t: number) => void> = []
let t = 0
function frame() {
  t += 16
  const q = frames
  frames = []
  for (const cb of q) cb(t)
}

function scroller(scrollHeight: number, clientHeight = 600) {
  const el = { scrollHeight, clientHeight, _top: 0 } as unknown as HTMLElement & { _top: number }
  Object.defineProperty(el, 'scrollTop', {
    get: () => el._top,
    set: (v: number) => {
      el._top = Math.round(Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)))
    },
  })
  return el
}

beforeEach(() => {
  frames = []
  t = 0
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('bottom follower', () => {
  it('glides to new bottom over several frames instead of hopping', () => {
    const el = scroller(1000)
    el.scrollTop = 400 // at bottom
    ;(el as unknown as { scrollHeight: number }).scrollHeight = 1120 // a message landed
    const f = createBottomFollower(el, { canFollow: () => true, instant: () => false })
    f.follow()
    frame()
    const first = el.scrollTop
    expect(first).toBeGreaterThan(400)
    expect(first).toBeLessThan(520)
    for (let i = 0; i < 30; i++) frame()
    expect(el.scrollTop).toBe(520)
  })

  it('snaps when told to (thread open / reduced motion) or the jump is huge', () => {
    const el = scroller(1000)
    createBottomFollower(el, { canFollow: () => true, instant: () => true }).follow()
    expect(el.scrollTop).toBe(400)
    const big = scroller(5000)
    const f = createBottomFollower(big, { canFollow: () => true, instant: () => false })
    f.follow()
    frame()
    expect(big.scrollTop).toBe(4400)
  })

  it('stops following the moment the reader scrolls away', () => {
    const el = scroller(1200)
    el.scrollTop = 400
    let armed = true
    const f = createBottomFollower(el, { canFollow: () => armed, instant: () => false })
    f.follow()
    frame()
    armed = false
    const at = el.scrollTop
    frame()
    frame()
    expect(el.scrollTop).toBe(at)
  })
})
