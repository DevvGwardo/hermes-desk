import { describe, expect, it } from 'vitest'
import {
  AVATAR_BODY_COLORS,
  AVATAR_EYE_COLORS,
  COLOR_NAME_MAP,
  DEFAULT_AVATAR_SPEC,
  DEFAULT_BODY_COLOR,
  DEFAULT_EYE_COLOR,
  colorName,
  resolveAvatarSpec,
  validateAvatar,
} from '../src/lib/avatar-spec'

describe('validateAvatar: closed 4-palette body+eye', () => {
  it('accepts every body palette hex', () => {
    expect(AVATAR_BODY_COLORS).toHaveLength(4)
    for (const body of AVATAR_BODY_COLORS) {
      expect(validateAvatar({ bodyColor: body, eyeColor: DEFAULT_EYE_COLOR }).bodyColor).toBe(body)
    }
  })

  it('accepts every eye palette hex', () => {
    expect(AVATAR_EYE_COLORS).toHaveLength(4)
    for (const eye of AVATAR_EYE_COLORS) {
      expect(validateAvatar({ bodyColor: DEFAULT_BODY_COLOR, eyeColor: eye }).eyeColor).toBe(eye)
    }
  })

  it('accepts legacy avatarColor/avatarEyeColor keys', () => {
    const out = validateAvatar({ avatarColor: AVATAR_BODY_COLORS[1], avatarEyeColor: AVATAR_EYE_COLORS[1] })
    expect(out.bodyColor).toBe(AVATAR_BODY_COLORS[1])
    expect(out.eyeColor).toBe(AVATAR_EYE_COLORS[1])
  })

  it('handles case variants (uppercase hex still matches palette)', () => {
    const out = validateAvatar({ bodyColor: AVATAR_BODY_COLORS[0].toUpperCase(), eyeColor: AVATAR_EYE_COLORS[0].toUpperCase() })
    expect(out.bodyColor).toBe(AVATAR_BODY_COLORS[0])
    expect(out.eyeColor).toBe(AVATAR_EYE_COLORS[0])
  })

  it('rejects free-form hex to the default (never passes through)', () => {
    expect(validateAvatar({ bodyColor: '#ff0000', eyeColor: DEFAULT_EYE_COLOR }).bodyColor).toBe(DEFAULT_BODY_COLOR)
    expect(validateAvatar({ bodyColor: DEFAULT_BODY_COLOR, eyeColor: '#00ff00' }).eyeColor).toBe(DEFAULT_EYE_COLOR)
  })

  it('rejects URL / injection strings to the default', () => {
    const evil = 'https://evil.example/x.png'
    expect(validateAvatar({ bodyColor: evil, eyeColor: evil })).toEqual(DEFAULT_AVATAR_SPEC)
    expect(validateAvatar({ bodyColor: 'red; background:url(javascript:x)', eyeColor: '"><img' })).toEqual(
      DEFAULT_AVATAR_SPEC,
    )
  })

  it('falls back to defaults for null/empty/garbage', () => {
    expect(validateAvatar(null)).toEqual(DEFAULT_AVATAR_SPEC)
    expect(validateAvatar(undefined)).toEqual(DEFAULT_AVATAR_SPEC)
    expect(validateAvatar({})).toEqual(DEFAULT_AVATAR_SPEC)
    expect(validateAvatar({ bodyColor: '', eyeColor: '' })).toEqual(DEFAULT_AVATAR_SPEC)
  })

  it('shape is always cat regardless of input', () => {
    expect(validateAvatar({ shape: 'dog', bodyColor: DEFAULT_BODY_COLOR, eyeColor: DEFAULT_EYE_COLOR }).shape).toBe('cat')
    expect(validateAvatar({ shape: 'blob' }).shape).toBe('cat')
  })

  it('resolveAvatarSpec maps agent rows onto the same contract', () => {
    expect(resolveAvatarSpec(null)).toEqual(DEFAULT_AVATAR_SPEC)
    expect(
      resolveAvatarSpec({ avatarColor: AVATAR_BODY_COLORS[2], avatarEyeColor: AVATAR_EYE_COLORS[2] }),
    ).toEqual({ shape: 'cat', bodyColor: AVATAR_BODY_COLORS[2], eyeColor: AVATAR_EYE_COLORS[2] })
    // off-palette agent row falls back, never passes through
    expect(resolveAvatarSpec({ avatarColor: '#ff0000', avatarEyeColor: 'https://x/y.png' })).toEqual(
      DEFAULT_AVATAR_SPEC,
    )
  })
})

describe('avatar-name map', () => {
  it('names every palette hex (body + eye)', () => {
    for (const hex of [...AVATAR_BODY_COLORS, ...AVATAR_EYE_COLORS]) {
      expect(typeof COLOR_NAME_MAP[hex]).toBe('string')
      expect(COLOR_NAME_MAP[hex]!.length).toBeGreaterThan(0)
    }
  })

  it('colorName resolves case-insensitively, passes unknown through', () => {
    const hex = AVATAR_BODY_COLORS[0]
    expect(colorName(hex.toUpperCase())).toBe(COLOR_NAME_MAP[hex])
    expect(colorName('#ff0000')).toBe('#ff0000')
  })

  it('resolves plain color names to palette hex (blue -> hex etc)', async () => {
    const spec = (await import('../src/lib/avatar-spec')) as Record<string, unknown>
    const nameToHex = spec['nameToHex'] as ((name: string) => string | undefined) | undefined
    expect(typeof nameToHex, 'expected nameToHex(name) export on avatar-spec').toBe('function')
    expect(nameToHex!('blue')).toBe(AVATAR_BODY_COLORS[0])
    expect(nameToHex!('Blue')).toBe(AVATAR_BODY_COLORS[0])
    expect(nameToHex!('pink')).toBe(AVATAR_BODY_COLORS[1])
    expect(nameToHex!('purple')).toBe(AVATAR_BODY_COLORS[2])
    expect(nameToHex!('green')).toBe(AVATAR_BODY_COLORS[3])
    expect(nameToHex!('not-a-color')).toBeUndefined()
  })

  it('eye palette agrees with NUBCAT_EYE_COLORS (no drift)', async () => {
    const spec = (await import('../src/lib/avatar-spec')) as Record<string, readonly string[] | undefined>
    const nubcat = spec['NUBCAT_EYE_COLORS'] ?? []
    expect([...nubcat].sort()).toEqual([...AVATAR_EYE_COLORS].sort())
  })
})
