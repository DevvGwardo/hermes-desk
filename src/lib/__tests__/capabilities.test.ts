import { describe, expect, it } from 'vitest'
import { caps, shell } from '../capabilities'

describe('caps (jsdom / web shell)', () => {
  it('is not electron', () => {
    expect(shell).not.toBe('electron')
  })

  it('hides host-only surfaces', () => {
    expect(caps.vmPreview).toBe(false)
    expect(caps.vmFs).toBe(false)
    expect(caps.hostFs).toBe(false)
    expect(caps.stt).toBe(false)
    expect(caps.localTasks).toBe(false)
    expect(caps.updates).toBe(false)
    expect(caps.plugins).toBe(false)
  })
})
