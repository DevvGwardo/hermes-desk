import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConnectionsPane } from '../ConnectionsPane'

afterEach(cleanup)
describe('no messaging connections', () => {
  it('replaces connection forms with the local-only truth', () => {
    render(<ConnectionsPane active />)
    expect(screen.getByText(/There are no messaging connections/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
