import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
const csp = new Map(policy.split(';').filter((part) => part.trim()).map((part) => {
  const [name, ...sources] = part.trim().split(/\s+/)
  return [name, sources]
}))
describe('local renderer CSP', () => {
  it('allows only self and loopback connections, never hosted services', () => {
    expect(policy).not.toBe('')
    expect(csp.get('connect-src')).toEqual(["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*'])
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('font-src')).toEqual(["'self'"])
  })
  it('keeps scripts, frames, forms, and objects locked down', () => {
    expect(csp.get('script-src')).toEqual(["'self'", 'blob:'])
    expect(csp.get('frame-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'self'"])
    expect(csp.get('form-action')).toEqual(["'self'"])
  })
  it('permits local blob and data media without permitting remote media', () => {
    expect(csp.get('media-src')).toEqual(["'self'", 'blob:', 'data:', 'hd-media:'])
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'hd-avatar:', 'https:'])
  })
})
