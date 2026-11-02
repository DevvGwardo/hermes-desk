import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ConnectionsPane } from '../ConnectionsPane'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('removed messaging bridge', () => {
  it('does not send messaging API requests even if the old pane is mounted', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<ConnectionsPane active={false} />)
    expect(container.textContent).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })
})
