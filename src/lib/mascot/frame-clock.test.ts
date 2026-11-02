import { expect, it, vi } from 'vitest'
import { ManualFrameClock, SharedFrameClock } from './frame-clock'

it('uses one rAF for all subscribers and cancels the last one', () => {
  let callback: (t: number) => void
  let time = 0
  const request = vi.fn((cb: (t: number) => void) => { callback = cb; return 7 })
  const cancel = vi.fn()
  const clock = new SharedFrameClock({ now: () => time, request, cancel })
  const a = vi.fn(() => { time += 0.25 })
  const b = vi.fn(() => { time += 0.5 })
  const stopA = clock.subscribe(a)
  const stopB = clock.subscribe(b)
  expect(request).toHaveBeenCalledOnce()
  callback!(16)
  expect(a).toHaveBeenCalledWith(16)
  expect(b).toHaveBeenCalledWith(16)
  expect(clock.stats().meanMs).toBe(0.75)
  stopA()
  expect(cancel).not.toHaveBeenCalled()
  stopB()
  expect(cancel).toHaveBeenCalledWith(7)
  expect(clock.stats().subscribers).toBe(0)
})

it('manual clock has no timers and does not step unsubscribed instances', () => {
  const clock = new ManualFrameClock()
  const callback = vi.fn()
  const stop = clock.subscribe(callback)
  clock.advance(100, 20)
  expect(callback).toHaveBeenCalledTimes(5)
  stop()
  clock.advance(100)
  expect(callback).toHaveBeenCalledTimes(5)
  expect(clock.now()).toBe(200)
  expect(() => clock.advance(-1)).toThrow()
})
