import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../../lib/hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

vi.mock('../MessageBody', () => ({ MessageBody: ({ content }: { content: string }) => <div>{content}</div> }))

import { ChatHistoryPanel } from '../ChatHistoryPanel'

const list = {
  sessions: [
    { id: 's1', title: 'Weekend plans', source: 'telegram', last_active: 1_700_000_000, message_count: 3 },
    { id: 's2', title: 'Daily summary', source: 'cron', last_active: 1_700_000_100, message_count: 2 },
  ],
  total: 2,
}

beforeEach(() => {
  cleanup()
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  serveGetDetailed.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/sessions/search')) {
      return { data: { results: [{ id: 's9', title: 'Paris trip', snippet: 'flights to >>>paris<<<', source: 'discord' }] } }
    }
    if (path.endsWith('/mutation-snapshot')) return { data: { exists: true, runtime_revision: 2, runtime_generation: 0 } }
    if (path.startsWith('/api/sessions')) return { data: list }
    return { data: null, status: 404 }
  })
})
afterEach(() => cleanup())

describe('ChatHistoryPanel', () => {
  it('opens a chat that lives in the sidebar there', async () => {
    const onOpenSession = vi.fn(() => true)
    render(<ChatHistoryPanel open onClose={() => {}} onOpenSession={onOpenSession} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Weekend plans' }))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    expect(screen.queryByTestId('chat-transcript')).toBeNull()
  })

  it('reads any other chat right here, then goes back to the list', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/sessions/s1/messages')) {
        return {
          data: {
            messages: [
              { role: 'user', content: 'Plan my weekend' },
              { role: 'tool', content: '{"x":1}' },
              { role: 'assistant', content: [{ type: 'text', text: 'Hike on Saturday.' }] },
            ],
          },
        }
      }
      if (path.startsWith('/api/sessions')) return { data: list }
      return { data: null, status: 404 }
    })
    render(<ChatHistoryPanel open onClose={() => {}} onOpenSession={() => false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Weekend plans' }))
    expect(await screen.findByText('Hike on Saturday.')).toBeTruthy()
    expect(screen.getByText('Plan my weekend')).toBeTruthy()
    expect(screen.queryByText('{"x":1}')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '‹ All chats' }))
    expect(await screen.findByText('Daily summary')).toBeTruthy()
  })

  it('lists chats with where they came from', async () => {
    render(<ChatHistoryPanel open onClose={() => {}} />)
    expect(await screen.findByText('Weekend plans')).toBeTruthy()
    expect(screen.getByText('Telegram')).toBeTruthy()
    expect(screen.getByText('Routine')).toBeTruthy()
  })

  it('a failed Show more keeps the chats already shown, and can try again', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.includes('offset=2')) return { data: null, status: 503 }
      return { data: { ...list, total: 5 } }
    })
    render(<ChatHistoryPanel open onClose={() => {}} />)
    await screen.findByText('Weekend plans')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Weekend plans')).toBeTruthy()
    expect(screen.getByText('Daily summary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('a failed first load offers Retry', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 503 })
    render(<ChatHistoryPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Weekend plans')).toBeTruthy()
  })

  it('searches', async () => {
    render(<ChatHistoryPanel open onClose={() => {}} />)
    await screen.findByText('Weekend plans')
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'paris' } })
    expect(await screen.findByText('Paris trip')).toBeTruthy()
    expect(screen.getByText('flights to paris')).toBeTruthy()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions/search?q=paris&limit=50')
  })

  it('reopens with an empty search and the full list, not the last query', async () => {
    // Desktop keeps the panel mounted after its first open.
    const { rerender } = render(<ChatHistoryPanel open onClose={() => {}} />)
    await screen.findByText('Weekend plans')
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'paris' } })
    expect(await screen.findByText('Paris trip')).toBeTruthy()
    const searches = () => serveGetDetailed.mock.calls.filter(([p]) => String(p).startsWith('/api/sessions/search')).length
    const before = searches()
    rerender(<ChatHistoryPanel open={false} onClose={() => {}} />)
    rerender(<ChatHistoryPanel open onClose={() => {}} />)
    expect(await screen.findByText('Weekend plans')).toBeTruthy()
    expect((screen.getByLabelText('Search chats') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('Paris trip')).toBeNull()
    // The stale query's debounced search never fires.
    await new Promise((r) => setTimeout(r, 300))
    expect(searches()).toBe(before)
  })

  it('renames a chat', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { title: 'Weekend trip' } })
    render(<ChatHistoryPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Weekend plans' }))
    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: 'Weekend trip' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Weekend trip')).toBeTruthy()
    expect(serveSend).toHaveBeenCalledWith('PATCH', '/api/sessions/s1', expect.objectContaining({ title: 'Weekend trip', expected_revision: 2 }))
  })

  it('deletes only after confirming', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    render(<ChatHistoryPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Daily summary' }))
    expect(serveSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    await waitFor(() => expect(screen.queryByText('Daily summary')).toBeNull())
    expect(serveSend).toHaveBeenCalledWith('DELETE', expect.stringMatching(/^\/api\/sessions\/s2\?request_id=.+&expected_revision=2&expected_generation=0$/))
  })

  it('shows the update notice for older agents', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: '' } })
    render(<ChatHistoryPanel open onClose={() => {}} />)
    expect(await screen.findByText(/needs an update/)).toBeTruthy()
  })
})
