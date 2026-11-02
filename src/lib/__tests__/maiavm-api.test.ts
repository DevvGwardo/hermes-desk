import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLocalHermesServeUrl, isMockMode } from '../maiavm-api'

vi.mock('../build-env', () => ({ isProdBuild: vi.fn(() => false) }))
import { isProdBuild } from '../build-env'
import { getHermesServeUrl, getHermesTransportMode } from '../maiavm-api'

describe('isLocalHermesServeUrl', () => {
  it('accepts loopback http(s)', () => {
    expect(isLocalHermesServeUrl('http://127.0.0.1:9119')).toBe(true)
    expect(isLocalHermesServeUrl('http://localhost:9119/')).toBe(true)
    expect(isLocalHermesServeUrl('https://127.0.0.1')).toBe(true)
    expect(isLocalHermesServeUrl('http://[::1]:9119')).toBe(true)
  })

  it('rejects remote, credentialed, and non-http URLs', () => {
    expect(isLocalHermesServeUrl('https://evil.example')).toBe(false)
    expect(isLocalHermesServeUrl('http://192.168.1.10:9119')).toBe(false)
    expect(isLocalHermesServeUrl('http://user:pass@127.0.0.1:9119')).toBe(false)
    expect(isLocalHermesServeUrl('file:///etc/passwd')).toBe(false)
    expect(isLocalHermesServeUrl('javascript:alert(1)')).toBe(false)
    expect(isLocalHermesServeUrl('not a url')).toBe(false)
  })
})


describe('isMockMode in Electron', () => {
  afterEach(() => {
    delete window.nubAgent
  })

  it('is not mock when the desktop bridge is present and the flag is unset/false', () => {
    window.nubAgent = { platform: 'darwin' } as Window['nubAgent']
    if (import.meta.env.VITE_MAIAVM_MOCK === 'true') return
    expect(isMockMode()).toBe(false)
  })
})

describe('prod build gates (deploy-only)', () => {
  afterEach(() => {
    vi.mocked(isProdBuild).mockReturnValue(false)
  })

  it('isMockMode is always false in a prod build', () => {
    vi.mocked(isProdBuild).mockReturnValue(true)
    expect(isMockMode()).toBe(false)
  })

  it('only accepts a loopback build-time serve URL, even in production', () => {
    vi.mocked(isProdBuild).mockReturnValue(true)
    vi.stubEnv('VITE_HERMES_SERVE_URL', 'http://127.0.0.1:19120')
    expect(getHermesServeUrl()).toBe('http://127.0.0.1:19120')
    vi.unstubAllEnvs()
  })

  it('getHermesTransportMode is serve regardless of stored overrides or production', () => {
    vi.mocked(isProdBuild).mockReturnValue(true)
    window.localStorage.setItem('maia:hermesTransport', 'mock')
    expect(getHermesTransportMode()).toBe('serve')
    window.localStorage.removeItem('maia:hermesTransport')
  })
})
