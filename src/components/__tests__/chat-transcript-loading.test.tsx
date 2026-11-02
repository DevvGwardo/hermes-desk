import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'

// An unloaded thread is unknown, not empty: on a first open the chat used to
// say "No messages yet. Say hello to this agent." for ~1s before the
// transcript arrived.

beforeEach(() => {
  cleanup()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      addEventListener: () => {},
      removeListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatPanel transcript loading', () => {
  it('shows the loading intro, not the empty state, while the first fetch runs', () => {
    render(<ChatPanel messages={[]} transcriptLoading threadKey="t" onSend={() => {}} />)
    expect(screen.getByTestId('transcript-intro')).toBeTruthy()
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByTestId('chat-starters')).toBeNull()
  })

  it('shows the empty state once loading is done and the thread is empty', () => {
    render(<ChatPanel messages={[]} threadKey="t" onSend={() => {}} />)
    expect(screen.queryByTestId('transcript-intro')).toBeNull()
    expect(screen.getByTestId('chat-starters')).toBeTruthy()
  })

  it('never shows the intro over real messages', () => {
    render(
      <ChatPanel
        messages={[{ id: 'u1', threadId: 't', role: 'user', content: 'hey', createdAt: '2026-09-23T15:00:00Z' }]}
        transcriptLoading
        threadKey="t"
        onSend={() => {}}
      />,
    )
    expect(screen.queryByTestId('transcript-intro')).toBeNull()
  })

  it('fades the list in once when real rows replace the intro', () => {
    const msgs = [{ id: 'u1', threadId: 't', role: 'user' as const, content: 'hey', createdAt: '2026-09-23T15:00:00Z' }]
    const view = render(<ChatPanel messages={[]} transcriptLoading threadKey="t" onSend={() => {}} />)
    expect(view.container.querySelector('.ca-transcript-in')).toBeNull()
    view.rerender(<ChatPanel messages={msgs} threadKey="t" onSend={() => {}} />)
    expect(view.container.querySelector('.ca-transcript-in')).toBeTruthy()
    expect(screen.queryByTestId('transcript-intro')).toBeNull()
  })

  it('opens a cached thread instantly, with no reveal fade', () => {
    const msgs = [{ id: 'u1', threadId: 't', role: 'user' as const, content: 'hey', createdAt: '2026-09-23T15:00:00Z' }]
    const view = render(<ChatPanel messages={msgs} threadKey="t" onSend={() => {}} />)
    expect(view.container.querySelector('.ca-transcript-in')).toBeNull()
  })

  it('the intro is the agent orb and a caption, with no placeholder bubbles', () => {
    render(<ChatPanel messages={[]} transcriptLoading threadKey="t" onSend={() => {}} />)
    const intro = screen.getByTestId('transcript-intro')
    expect(intro.querySelector('svg')).toBeTruthy()
    expect(intro.textContent).toContain('Opening conversation')
    expect(intro.querySelector('.ca-bubble, .skeleton-shine')).toBeNull()
  })
})

describe('ChatPanel transcript load failure', () => {
  // A failed first load left the thread empty and the chat said "Send a
  // message to this local profile." — a false fresh-chat state for a
  // conversation with thousands of server rows, with no way to retry.

  it('shows the retry offer, not the empty state, when the first load failed', () => {
    render(<ChatPanel messages={[]} transcriptError threadKey="t" onSend={() => {}} />)
    expect(screen.getByTestId('transcript-error').textContent).toContain('Couldn’t load this conversation')
    expect(screen.queryByTestId('chat-starters')).toBeNull()
  })

  it('the retry offer re-runs the transcript load', () => {
    const onRetryTranscript = vi.fn()
    render(
      <ChatPanel messages={[]} transcriptError onRetryTranscript={onRetryTranscript} threadKey="t" onSend={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryTranscript).toHaveBeenCalledTimes(1)
  })

  it('a new attempt hides the failure, and arrived rows replace it', () => {
    const view = render(<ChatPanel messages={[]} transcriptError threadKey="t" onSend={() => {}} />)
    view.rerender(<ChatPanel messages={[]} transcriptError transcriptLoading threadKey="t" onSend={() => {}} />)
    expect(screen.queryByTestId('transcript-error')).toBeNull()
    expect(screen.getByTestId('transcript-intro')).toBeTruthy()
    const msgs = [{ id: 'u1', threadId: 't', role: 'user' as const, content: 'hey', createdAt: '2026-09-23T15:00:00Z' }]
    view.rerender(<ChatPanel messages={msgs} transcriptError threadKey="t" onSend={() => {}} />)
    expect(screen.queryByTestId('transcript-error')).toBeNull()
  })
})

describe('ChatPanel catching a cached thread up (2026-10-04)', () => {
  const at = '2026-10-04T10:00:00.000Z'
  const cached = [
    { id: 'u1', threadId: 't', role: 'user' as const, content: 'hey', createdAt: at, turnCreatedAt: at, turnId: 'u1' },
    { id: 'a1', threadId: 't', role: 'agent' as const, content: 'hi', createdAt: at, turnCreatedAt: at, turnId: 'a1' },
  ]

  it('shows "Loading new messages" at once when the thread is known to be behind', () => {
    render(<ChatPanel messages={cached} transcriptSyncing="behind" threadKey="t" onSend={() => {}} />)
    const pill = screen.getByTestId('transcript-sync')
    expect(pill.textContent).toContain('Loading new messages')
    expect(pill.getAttribute('role')).toBe('status')
  })

  it('an unproven re-check only shows its pill if it runs long', () => {
    vi.useFakeTimers()
    try {
      render(<ChatPanel messages={cached} transcriptSyncing="checking" threadKey="t" onSend={() => {}} />)
      expect(screen.queryByTestId('transcript-sync')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(screen.getByTestId('transcript-sync').textContent).toContain('Checking for new messages')
    } finally {
      vi.useRealTimers()
    }
  })

  it('no pill when nothing is syncing, or over the loading intro', () => {
    const view = render(<ChatPanel messages={cached} threadKey="t" onSend={() => {}} />)
    expect(screen.queryByTestId('transcript-sync')).toBeNull()
    view.rerender(<ChatPanel messages={[]} transcriptLoading transcriptSyncing="behind" threadKey="t" onSend={() => {}} />)
    expect(screen.queryByTestId('transcript-sync')).toBeNull()
  })

  it('caught-up rows ease in, and a batch taller than the screen lands on its first row', () => {
    const view = render(<ChatPanel messages={cached} transcriptSyncing="behind" threadKey="t" onSend={() => {}} />)
    const scroller = view.container.querySelector('.overflow-y-auto') as HTMLElement
    let top = 1400
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => (top = v) })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 4000 })
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // Scroller's top at 0; the first new row starts 600px below the
      // current view's top (content y = 1400 + 600 = 2000).
      const y = this === scroller ? 0 : this.getAttribute('data-message-id') === 'u2' ? 600 : 900
      return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON: () => ({}) } as DOMRect
    })
    const later = '2026-10-04T10:05:00.000Z'
    view.rerender(
      <ChatPanel
        messages={[
          ...cached,
          { id: 'u2', threadId: 't', role: 'user', content: 'from phone', createdAt: later, turnCreatedAt: later, turnId: 'u2' },
          { id: 'a2', threadId: 't', role: 'agent', content: 'long reply', createdAt: later, turnCreatedAt: later, turnId: 'a2' },
        ]}
        threadKey="t"
        onSend={() => {}}
      />,
    )
    rect.mockRestore()
    expect(view.container.querySelector('[data-message-id="u2"]')?.className).toContain('ca-row-in')
    expect(view.container.querySelector('[data-message-id="u1"]')?.className).not.toContain('ca-row-in')
    // Reduced motion (matchMedia stub) jumps instead of smooth-scrolling.
    expect(top).toBe(2000 - 16)
    expect(screen.queryByTestId('transcript-sync')).toBeNull()
  })

  it('own sends never anchor: a local row carries no server stamp', () => {
    const view = render(<ChatPanel messages={cached} threadKey="t" onSend={() => {}} />)
    const scroller = view.container.querySelector('.overflow-y-auto') as HTMLElement
    let top = 1400
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => (top = v) })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 4000 })
    view.rerender(
      <ChatPanel
        messages={[...cached, { id: 'msg_x', threadId: 't', role: 'user', content: 'mine', createdAt: at }]}
        threadKey="t"
        onSend={() => {}}
      />,
    )
    // Followed to the bottom (snap path), not anchored mid-thread.
    expect(top === 1400 || top === 4000 - 600 || top === 4000).toBe(true)
    expect(top).not.toBe(2000 - 16)
  })
})
