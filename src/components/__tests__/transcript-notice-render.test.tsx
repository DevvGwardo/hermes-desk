import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ChatPanel } from '../ChatPanel'
import { parseTranscriptMessages } from '../../lib/agents/hermes-sessions'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  }))
  Element.prototype.scrollIntoView = vi.fn()
})

it('renders a hydrated process notice in the actual chat, not a user bubble', () => {
  const raw = '[IMPORTANT: Background process proc_fixture completed normally.\nOutput:\nfixture raw output]'
  const messages = parseTranscriptMessages('fixture-session', JSON.stringify({
    messages: [
      {
        id: 12, role: 'user', content: raw, display_kind: 'process_complete',
        display_metadata: { display_text: 'Background Process Finished' },
      },
      { id: 13, role: 'assistant', content: 'Here is the actual result.' },
    ],
  }))
  const { container } = render(<ChatPanel threadKey="fixture-notice" messages={messages} onSend={vi.fn()} />)
  const disclosure = container.querySelector('details')!
  expect(disclosure.open).toBe(false)
  expect(screen.getByText(/fixture raw output/)).not.toBeVisible()
  expect(screen.getByText('Here is the actual result.')).toBeVisible()
  expect(container.querySelector('[data-message-id="hermes_fixture-session_12"] .ca-bubble')).toBeNull()
  fireEvent.click(disclosure.querySelector('summary')!)
  expect(disclosure.open).toBe(true)
  expect(screen.getByText(/fixture raw output/)).toBeVisible()
})
