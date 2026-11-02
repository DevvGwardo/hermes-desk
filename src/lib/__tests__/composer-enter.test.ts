import { describe, expect, it } from 'vitest'
import { enterSends, TOUCH_KEYBOARD_MQ } from '../composer-enter'

function mockMedia(touch: boolean) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (q: string) => ({ matches: touch && q === TOUCH_KEYBOARD_MQ }) })
}

describe('enterSends', () => {
  it('sends on Enter with a real keyboard', () => {
    mockMedia(false)
    expect(enterSends()).toBe(true)
  })

  it('makes Enter a new line on a phone keyboard', () => {
    mockMedia(true)
    expect(enterSends()).toBe(false)
  })
})
