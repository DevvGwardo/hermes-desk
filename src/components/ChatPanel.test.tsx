import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  }))
})

describe('Local messenger ChatPanel', () => {
  it('retains cached transcripts and editable drafts offline without sending', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const onSend = vi.fn()
    render(<ChatPanel threadKey="fixture_offline" messages={[{
      id: 'm_fixture', threadId: 'fixture_offline', role: 'agent', content: 'Cached local reply',
      createdAt: '2026-10-06T00:00:00Z',
    }]} readOnly onSend={onSend} />)
    expect(screen.getByText('Cached local reply')).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'A local draft while reconnecting' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(input.value).toBe('A local draft while reconnecting')
  })
  it('shows the transport status without a VM update or billing banner', () => {
    render(<ChatPanel threadKey="fixture_status" messages={[]} statusLine="Searching local notes…" onSend={vi.fn()} />)
    expect(screen.getByText('Searching local notes…')).toBeTruthy()
    expect(screen.queryByText(/usage limit|reset|updating VM/i)).toBeNull()
  })
})
