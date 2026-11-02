import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CapabilitiesPane } from '../CapabilitiesPane'

afterEach(cleanup)
describe('local skill entry point', () => {
  it('links to local profile skills rather than displaying credential or messaging forms', () => {
    render(<CapabilitiesPane active profile="spike-alpha" />)
    expect(screen.getByRole('link', { name: 'Open local profile skills' }).getAttribute('href')).toBe('#/agent/profile%3Aspike-alpha?tools=skills')
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
