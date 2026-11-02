/**
 * avatar-intent-hook — pins for the avatar simplification:
 * 1. maybeApplyAvatarIntent: body/eye/reset hits return true with correct
 *    hexes; non-match + free hex return false.
 * 2. Palette single-source: NUBCAT_COLORS (activity.ts) deep-equals
 *    AVATAR_BODY_COLORS (avatar-spec) — fails on future drift.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getState, updateAgent, appendMessage } from '../agents/store'
import { maybeApplyAvatarIntent } from '../avatar-intent'
import { AVATAR_BODY_COLORS, DEFAULT_BODY_COLOR, DEFAULT_EYE_COLOR } from '../avatar-spec'
import { NUBCAT_COLORS } from '../agents/activity'

vi.mock('../agents/store', () => ({
  getState: vi.fn(),
  updateAgent: vi.fn(),
  appendMessage: vi.fn(),
}))
vi.mock('../hermes-agents', () => ({
  syncDesktopAgentToHermes: vi.fn(() => Promise.resolve()),
}))

const AGENT = { id: 'a1', avatarColor: DEFAULT_BODY_COLOR, avatarEyeColor: DEFAULT_EYE_COLOR }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getState).mockReturnValue({ agents: [{ ...AGENT }] } as never)
})

describe('maybeApplyAvatarIntent', () => {
  it('body hit returns true with the palette hex', () => {
    expect(maybeApplyAvatarIntent('a1', 'make my avatar blue', 'c1')).toBe(true)
    expect(updateAgent).toHaveBeenCalledWith('a1', {
      avatarColor: DEFAULT_BODY_COLOR,
      avatarEyeColor: DEFAULT_EYE_COLOR,
    })
    expect(appendMessage).toHaveBeenCalledTimes(1)
  })

  it('eye hit returns true with the eye hex', () => {
    expect(maybeApplyAvatarIntent('a1', 'change eyes to forest', 'c1')).toBe(true)
    expect(updateAgent).toHaveBeenCalledWith('a1', {
      avatarColor: DEFAULT_BODY_COLOR,
      avatarEyeColor: '#14532d',
    })
  })

  it('reset hit returns true with defaults', () => {
    vi.mocked(getState).mockReturnValue({
      agents: [{ ...AGENT, avatarColor: AVATAR_BODY_COLORS[2], avatarEyeColor: '#14532d' }],
    } as never)
    expect(maybeApplyAvatarIntent('a1', 'reset my avatar', 'c1')).toBe(true)
    expect(updateAgent).toHaveBeenCalledWith('a1', {
      avatarColor: DEFAULT_BODY_COLOR,
      avatarEyeColor: DEFAULT_EYE_COLOR,
    })
  })

  it('non-match returns false and touches nothing', () => {
    expect(maybeApplyAvatarIntent('a1', 'hello how are you today', 'c1')).toBe(false)
    expect(updateAgent).not.toHaveBeenCalled()
    expect(appendMessage).not.toHaveBeenCalled()
  })

  it('free hex returns false (closed palettes only)', () => {
    expect(maybeApplyAvatarIntent('a1', 'make my avatar #ff0000', 'c1')).toBe(false)
    expect(updateAgent).not.toHaveBeenCalled()
  })

  it('empty text and unknown agent return false', () => {
    expect(maybeApplyAvatarIntent('a1', '', 'c1')).toBe(false)
    expect(maybeApplyAvatarIntent('nope', 'make my avatar blue', 'c1')).toBe(false)
  })
})

describe('avatar palette single-source', () => {
  it('NUBCAT_COLORS deep-equals AVATAR_BODY_COLORS', () => {
    expect([...NUBCAT_COLORS]).toEqual([...AVATAR_BODY_COLORS])
  })
})
