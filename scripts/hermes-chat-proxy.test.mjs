import { describe, expect, it } from 'vitest'
import { isAllowedProxyOrigin } from './hermes-chat-proxy.mjs'

describe('isAllowedProxyOrigin', () => {
  it('allows loopback vite / electron-dev origins', () => {
    expect(isAllowedProxyOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isAllowedProxyOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedProxyOrigin('http://[::1]:5173')).toBe(true)
  })

  it('rejects missing, remote, and credentialed origins', () => {
    expect(isAllowedProxyOrigin(undefined)).toBe(false)
    expect(isAllowedProxyOrigin('')).toBe(false)
    expect(isAllowedProxyOrigin('https://evil.example')).toBe(false)
    expect(isAllowedProxyOrigin('http://192.168.1.10:8899')).toBe(false)
    expect(isAllowedProxyOrigin('http://user:pass@127.0.0.1:5173')).toBe(false)
    expect(isAllowedProxyOrigin('file://')).toBe(false)
  })
})
