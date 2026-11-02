import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMascot } from '../AgentMascot'
import * as engine from '../../lib/mascot/engine'
import { registerMascot } from '../../lib/mascot/cues'
import { ManualFrameClock } from '../../lib/mascot/frame-clock'
import type { MascotHandle } from '../../lib/mascot/types'

vi.mock('../../lib/mascot/cues', () => ({
  registerMascot: vi.fn(() => vi.fn()),
}))

let clock: ManualFrameClock
let controllers: Array<{ handle: MascotHandle; destroyed: boolean }>

beforeEach(() => {
  vi.mocked(registerMascot).mockClear()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  clock = new ManualFrameClock()
  controllers = []
  const original = engine.createMascot
  vi.spyOn(engine, 'createMascot').mockImplementation((element, options) => {
    const actual = original(element, { ...options, clock })
    const controller = { handle: actual, destroyed: false }
    controller.handle = {
      ...actual,
      destroy() {
        controller.destroyed = true
        actual.destroy()
      },
    }
    controllers.push(controller)
    return controller.handle
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function registration() {
  const calls = vi.mocked(registerMascot).mock.calls
  const [agentId, instance] = calls.at(-1)!
  const unregister = vi.mocked(registerMascot).mock.results.at(-1)!.value
  return { agentId, instance, unregister }
}

async function expectLiveRegistration() {
  await waitFor(() => {
    expect(registerMascot).toHaveBeenCalled()
    expect(registration().instance.handle).toBe(controllers.at(-1)!.handle)
    expect(controllers.at(-1)!.destroyed).toBe(false)
  })
  return registration()
}

describe('AgentMascot flight controller ownership', () => {
  // First mount keeps the real lazy load cold: only the child engine's
  // effects replay once the already-mounted parent receives the chunk.
  it('registers the live controller after a lazy StrictMode mount and can fly', async () => {
    const view = render(<StrictMode><AgentMascot agentId="fixture-cold" flight /></StrictMode>)
    await waitFor(() => expect(controllers.length).toBeGreaterThan(1))
    const { instance } = await expectLiveRegistration()
    expect(controllers.filter(controller => !controller.destroyed)).toHaveLength(1)
    expect(instance.canFly).toBe(true)
    expect(clock.subscribers).toBe(1)

    const target = document.createElement('div')
    view.container.append(target)
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
    Object.defineProperty(instance.element()!, 'getBoundingClientRect', { value: () => box(10, 100, 40, 40) })
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => box(400, 300, 200, 80) })
    const flight = instance.handle.flyTo(target, { speed: 1000 })
    expect(instance.handle.location()).toBe('flying')
    clock.advance(6000)
    await expect(flight).resolves.toBe('arrived')
  })

  it('replaces the registration when the engine is recreated for cursor tracking', async () => {
    const view = render(<StrictMode><AgentMascot agentId="fixture-cursor" flight /></StrictMode>)
    const previous = await expectLiveRegistration()
    view.rerender(<StrictMode><AgentMascot agentId="fixture-cursor" flight lookAtCursor /></StrictMode>)
    const current = await expectLiveRegistration()
    expect(current.instance.handle).not.toBe(previous.instance.handle)
    expect(controllers.find(controller => controller.handle === previous.instance.handle)!.destroyed).toBe(true)
    expect(previous.unregister).toHaveBeenCalledTimes(1)
    expect(current.unregister).not.toHaveBeenCalled()
  })

  it('moves registration ownership when the agent identity changes', async () => {
    const view = render(<StrictMode><AgentMascot agentId="fixture-before" flight /></StrictMode>)
    const previous = await expectLiveRegistration()
    view.rerender(<StrictMode><AgentMascot agentId="fixture-after" flight /></StrictMode>)
    const current = await expectLiveRegistration()
    expect(previous.agentId).toBe('fixture-before')
    expect(current.agentId).toBe('fixture-after')
    expect(previous.unregister).toHaveBeenCalledTimes(1)
    expect(current.unregister).not.toHaveBeenCalled()
  })

  it('updates flight eligibility without retaining the previous registration', async () => {
    const view = render(<StrictMode><AgentMascot agentId="fixture-eligibility" flight /></StrictMode>)
    const previous = await expectLiveRegistration()
    view.rerender(<StrictMode><AgentMascot agentId="fixture-eligibility" flight={false} /></StrictMode>)
    const current = await expectLiveRegistration()
    expect(previous.instance.canFly).toBe(true)
    expect(current.instance.canFly).toBe(false)
    expect(previous.unregister).toHaveBeenCalledTimes(1)
    expect(current.unregister).not.toHaveBeenCalled()
  })

  it('keeps the current engine registered across presence and size updates, then cleans up', async () => {
    const view = render(<StrictMode><AgentMascot agentId="fixture-stable" flight /></StrictMode>)
    const previous = await expectLiveRegistration()
    const created = controllers.length
    view.rerender(<StrictMode><AgentMascot agentId="fixture-stable" flight presence="happy" size={84} /></StrictMode>)
    const current = await expectLiveRegistration()
    expect(controllers).toHaveLength(created)
    expect(current.instance.handle).toBe(previous.instance.handle)
    expect(previous.unregister).not.toHaveBeenCalled()
    view.unmount()
    expect(current.unregister).toHaveBeenCalledTimes(1)
    expect(controllers.every(controller => controller.destroyed)).toBe(true)
    expect(clock.subscribers).toBe(0)
    for (const result of vi.mocked(registerMascot).mock.results) expect(result.value).toHaveBeenCalledTimes(1)
  })
})
