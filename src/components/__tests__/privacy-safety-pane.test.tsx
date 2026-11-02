import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PrivacySafetyPane } from '../PrivacySafetyPane'
import { ChatRetentionBlock } from '../ChatRetentionBlock'

afterEach(() => { cleanup(); delete window.nubAgent })
describe('local safety fallback', () => {
  it('keeps lead/tail content while approval mode is unavailable', () => {
    render(<PrivacySafetyPane active lead={<p>Lead row</p>} tail={<p>Tail row</p>} />)
    expect(screen.getByText('Lead row')).toBeTruthy()
    expect(screen.getByText('Tail row')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always allow' })).toHaveProperty('disabled', true)
  })
  it('never offers renderer-side deletion of authoritative Hermes transcripts', () => {
    render(<ChatRetentionBlock />)
    expect(screen.getByText(/does not upload or prune transcripts/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /30 days|90 days|forever/i })).toBeNull()
  })
})
