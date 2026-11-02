import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeActiveTransportSync, getActiveTransport, resetActiveTransport, setStoredTransportMode } from '../active-transport'
import { HermesLocalTransport } from '../hermes-local-transport'
import { resolveNubApiConnection } from '../../maiavm-api'

beforeEach(() => {
  resetActiveTransport()
  window.localStorage.clear()
})
afterEach(() => {
  resetActiveTransport()
  window.localStorage.clear()
  vi.unstubAllEnvs()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('Hermes Desk active transport', () => {
  it('always chooses local serve, ignoring legacy pairing, stored modes, and build flags', async () => {
    window.localStorage.setItem('maia:hermesTransport', 'mock')
    window.localStorage.setItem('nub:mobile-session', JSON.stringify({ host: 'https://fake.example', instanceId: 'fake-instance', desktopToken: 'FAKE_TOKEN_NOT_REAL' }))
    vi.stubEnv('VITE_HERMES_TRANSPORT', 'api')
    vi.stubEnv('PROD', true)
    const nubConnection = vi.fn()
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { nubConnection }
    const active = await getActiveTransport()
    expect(active.transport).toBeInstanceOf(HermesLocalTransport)
    expect(active).toMatchObject({ mode: 'serve', source: 'local:hermes-serve' })
    expect(await resolveNubApiConnection()).toBeNull()
    expect(nubConnection).not.toHaveBeenCalled()
  })

  it('uses one singleton and disposes it before reset', async () => {
    const first = await getActiveTransport()
    expect(await getActiveTransport()).toBe(first)
    const dispose = vi.spyOn(first.transport as HermesLocalTransport, 'dispose')
    resetActiveTransport()
    expect(dispose).toHaveBeenCalledOnce()
    expect((await getActiveTransport()).transport).not.toBe(first.transport)
  })

  it('old Settings mode writes cannot persist a transport override', async () => {
    setStoredTransportMode('mock')
    expect(window.localStorage.getItem('maia:hermesTransport')).toBeNull()
    expect(describeActiveTransportSync()).toEqual({ mode: 'serve', source: 'local:hermes-serve' })
    expect((await getActiveTransport()).transport).toBeInstanceOf(HermesLocalTransport)
  })
})
