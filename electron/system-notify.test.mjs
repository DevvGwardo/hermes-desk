import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sanitizeNotification } = require('./system-notify.cjs')

describe('sanitizeNotification', () => {
  it('keeps a bounded title, body and a known click target', () => {
    expect(sanitizeNotification({ title: 'Phoenix', body: 'Done.\nHere it is', target: { kind: 'conversation', id: 'conv_1' } })).toEqual({
      title: 'Phoenix',
      body: 'Done. Here it is',
      target: { kind: 'conversation', id: 'conv_1' },
      force: false,
    })
    const long = sanitizeNotification({ title: 'x'.repeat(200), body: 'y'.repeat(1000) })
    expect(long.title.length).toBe(80)
    expect(long.body.length).toBe(240)
  })

  it('drops unknown targets and refuses an empty title', () => {
    expect(sanitizeNotification({ title: 'a', target: { kind: 'shell', id: 'rm' } }).target).toBeNull()
    expect(sanitizeNotification({ title: 'a', target: { kind: 'conversation', id: '../x y' } }).target).toBeNull()
    expect(sanitizeNotification({ title: 'a', target: { kind: 'routines' } }).target).toEqual({ kind: 'routines' })
    expect(sanitizeNotification({ title: '  ' })).toBeNull()
    expect(sanitizeNotification(null)).toBeNull()
  })
})
