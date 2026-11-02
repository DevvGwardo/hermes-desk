import { describe, expect, it } from 'vitest'
import { parseAvatarIntent } from '../src/lib/avatar-intent'
describe('parseAvatarIntent pins', () => {
  it('make yourself blue -> body #b7d9ff', () => {
    expect(parseAvatarIntent('make yourself blue')).toEqual({ bodyColor: '#b7d9ff' })
  })
  it('change your avatar to pink -> body', () => {
    expect(parseAvatarIntent('change your avatar to pink')?.bodyColor).toBeDefined()
  })
  it('make your eyes navy -> eye #1a3d6b', () => {
    expect(parseAvatarIntent('make your eyes navy')).toEqual({ eyeColor: '#1a3d6b' })
  })
  it('reset your avatar -> reset', () => {
    expect(parseAvatarIntent('reset your avatar')).toEqual({ reset: true })
  })
  it('non-avatar + free hex + destructive -> null', () => {
    expect(parseAvatarIntent("what's the weather")).toBeNull()
    expect(parseAvatarIntent('make yourself #ff0000')).toBeNull()
    expect(parseAvatarIntent('delete everything')).toBeNull()
  })
})
