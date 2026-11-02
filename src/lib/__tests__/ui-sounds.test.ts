import { beforeEach, describe, expect, it } from 'vitest'
import {
  DONE_CUE_MIN_MS,
  claimCue,
  setUiSoundsEnabled,
  markTurnStopped,
  takeTurnStopped,
  turnCue,
  uiSoundsEnabled,
  type TurnCueInput,
} from '../ui-sounds'

const base: TurnCueInput = {
  lastRole: 'assistant',
  stoppedByUser: false,
  queued: false,
  elapsedMs: DONE_CUE_MIN_MS,
  away: false,
}

describe('turnCue', () => {
  it('chimes for a reply long enough that attention drifted', () => {
    expect(turnCue(base)).toBe('done')
  })

  it('stays quiet for a short reply the viewer watched', () => {
    expect(turnCue({ ...base, elapsedMs: DONE_CUE_MIN_MS - 1 })).toBeNull()
  })

  it('chimes for a short reply when the tab is in the background', () => {
    expect(turnCue({ ...base, elapsedMs: 200, away: true })).toBe('done')
  })

  it('always cues an error, however short', () => {
    expect(turnCue({ ...base, lastRole: 'error', elapsedMs: 100 })).toBe('error')
    expect(turnCue({ ...base, lastRole: 'error', queued: true })).toBe('error')
  })

  it('is silent when the viewer pressed Stop', () => {
    expect(turnCue({ ...base, stoppedByUser: true })).toBeNull()
    expect(turnCue({ ...base, lastRole: 'error', stoppedByUser: true })).toBeNull()
  })

  it('holds the done cue while queued messages are about to send', () => {
    expect(turnCue({ ...base, queued: true, away: true })).toBeNull()
  })

  it('is silent when the turn left no reply row (transient disconnect)', () => {
    expect(turnCue({ ...base, lastRole: 'user' })).toBeNull()
    expect(turnCue({ ...base, lastRole: undefined })).toBeNull()
  })
})

describe('claimCue', () => {
  beforeEach(() => localStorage.clear())

  it('lets one mount claim a turn; the dock and page share it', () => {
    expect(claimCue('s1:turn-a')).toBe(true)
    expect(claimCue('s1:turn-a')).toBe(false)
    expect(claimCue('s1:turn-b')).toBe(true)
  })

  it('skips a turn another tab already chimed for', () => {
    localStorage.setItem('nub.ui-sounds.last', 's1:turn-c')
    expect(claimCue('s1:turn-c')).toBe(false)
  })
})

describe('preference', () => {
  beforeEach(() => localStorage.clear())

  it('defaults on and persists a mute', () => {
    expect(uiSoundsEnabled()).toBe(true)
    setUiSoundsEnabled(false)
    expect(uiSoundsEnabled()).toBe(false)
    expect(localStorage.getItem('nub.ui-sounds.v1')).toBe('off')
  })
})

describe('takeTurnStopped', () => {
  it('silences the next settle after Stop, once', () => {
    markTurnStopped('c1')
    expect(takeTurnStopped('c1')).toBe(true)
    expect(takeTurnStopped('c1')).toBe(false)
  })

  it('expires a Stop that never settled', () => {
    markTurnStopped('c2')
    expect(takeTurnStopped('c2', Date.now() + 60_000)).toBe(false)
  })
})
