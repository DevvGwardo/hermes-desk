import { describe, expect, it } from 'vitest'
import { CATCH_UP_TOP_PAD_PX, catchUpScrollTarget } from '../catch-up-scroll'

describe('catchUpScrollTarget', () => {
  it('lands a batch taller than the screen on its first row', () => {
    // Viewport 600 at the old bottom (scrollTop 1400); the new rows start
    // at 2000 and run to 3500.
    expect(
      catchUpScrollTarget({ rowTop: 2000, scrollHeight: 3500, clientHeight: 600, scrollTop: 1400 }),
    ).toBe(2000 - CATCH_UP_TOP_PAD_PX)
  })

  it('leaves a batch that fits to normal following', () => {
    expect(catchUpScrollTarget({ rowTop: 2000, scrollHeight: 2400, clientHeight: 600, scrollTop: 1400 })).toBeNull()
  })

  it('never scrolls the reader backward', () => {
    expect(catchUpScrollTarget({ rowTop: 900, scrollHeight: 3500, clientHeight: 600, scrollTop: 1400 })).toBeNull()
  })
})
