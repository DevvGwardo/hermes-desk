import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '../CommandPalette'
import type { TranscriptTailHit } from '../../lib/hermes-rest'
import type { Agent, ChatMessage, Conversation } from '../../lib/agents'

const probeTranscriptTail = vi.fn()
const readTranscriptTails = vi.fn()

vi.mock('../../lib/hermes-rest', () => ({
  probeTranscriptTail: (...a: unknown[]) => probeTranscriptTail(...(a as [])),
  readTranscriptTails: (...a: unknown[]) => readTranscriptTails(...(a as [])),
}))

const qa: Agent = {
  id: 'qa',
  name: 'QA Engineer',
  status: 'running',
  region: 'fsn1',
  createdAt: '2026-08-14T00:00:00Z',
  summary: 'Clicks through every new GitHub deploy.',
  persona: { title: 'QA', description: 'Clicks through every new GitHub deploy.' },
}

const conv: Conversation = {
  id: 'c1',
  title: 'Deploy check',
  target: { type: 'agent', agentId: 'qa' },
  createdAt: '2026-08-14T00:00:00Z',
  lastUsedAt: '2026-08-14T00:00:00Z',
  hermesSessionId: 's1',
}

const localMsg: ChatMessage = {
  id: 'm1',
  threadId: 'c1',
  role: 'agent',
  content: 'Deploy retina pass confirmed on staging.',
  createdAt: '2026-08-14T00:00:00Z',
}

function typeQuery(q: string): void {
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: q } })
}

function messagesTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
}

/**
 * Deterministic time: the palette debounces at 150ms and the mocked probe
 * resolves on microtasks, so advancing past the debounce flushes every
 * pending fetch + state update. Absence assertions (no fetch after N ms of
 * virtual time) are proofs here, not sleep-and-hope.
 */
async function settle(ms = 250): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function renderPalette(extra?: {
  onJumpToMessage?: (conversationId: string, messageId: string) => void
  transcriptSearchInstanceId?: string | null
}): void {
  render(
    <CommandPalette
      open
      onClose={() => {}}
      commands={[]}
      agents={[qa]}
      conversations={[conv]}
      messagesByThreadId={{ c1: [localMsg] }}
      onJumpToAgent={() => {}}
      onJumpToMessage={extra?.onJumpToMessage ?? (() => {})}
      transcriptSearchInstanceId={extra?.transcriptSearchInstanceId ?? 'inst-1'}
    />,
  )
}

beforeEach(() => {
  cleanup()
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  probeTranscriptTail.mockReset().mockResolvedValue(true)
  readTranscriptTails.mockReset().mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CommandPalette cross-session search (#18)', () => {
  it('merges server transcript hits with conversation attribution and opens the conversation on click', async () => {
    const hit: TranscriptTailHit = {
      sessionId: 's1',
      rowId: 7,
      text: 'transcript-only zebra quorum note',
      at: '2026-08-22T22:00:00Z',
    }
    readTranscriptTails.mockResolvedValue([hit])
    const onJumpToMessage = vi.fn()
    renderPalette({ onJumpToMessage })
    messagesTab()
    typeQuery('zebra quorum')
    await settle()
    // Attribution: conversation title + transcript mark in the subtitle.
    expect(screen.getByText('transcript-only zebra quorum note')).toBeTruthy()
    expect(screen.getByText('Deploy check · agent transcript')).toBeTruthy()
    fireEvent.click(screen.getByText('transcript-only zebra quorum note'))
    expect(onJumpToMessage).toHaveBeenCalledWith('c1', '')
  })

  it('server loses dedupe when identical text already exists locally', async () => {
    readTranscriptTails.mockResolvedValue([
      { sessionId: 's1', rowId: 8, text: 'deploy retina pass confirmed on staging' },
    ])
    renderPalette()
    messagesTab()
    typeQuery('retina pass')
    await settle()
    expect(readTranscriptTails).toHaveBeenCalled()
    // One row only: the local message. The normalized-identical server hit is dropped.
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Deploy retina pass confirmed on staging.')).toBeTruthy()
  })

  it('skips hits from sessions with no mapped conversation', async () => {
    readTranscriptTails.mockResolvedValue([
      { sessionId: 'ghost', rowId: 9, text: 'orphan zebra quorum note' },
    ])
    renderPalette()
    messagesTab()
    typeQuery('zebra quorum')
    await settle()
    expect(readTranscriptTails).toHaveBeenCalled()
    expect(screen.getByText('No matches for “zebra quorum”')).toBeTruthy()
    expect(screen.queryByText('orphan zebra quorum note')).toBeNull()
  })

  it('excludes server hits missing a query token', async () => {
    readTranscriptTails.mockResolvedValue([
      { sessionId: 's1', rowId: 10, text: 'zebra migration checklist' },
    ])
    renderPalette()
    messagesTab()
    typeQuery('zebra quorum')
    await settle()
    expect(readTranscriptTails).toHaveBeenCalled()
    expect(screen.getByText('No matches for “zebra quorum”')).toBeTruthy()
    expect(screen.queryByText('zebra migration checklist')).toBeNull()
  })

  it('falls back to local-only results when the probe fails', async () => {
    probeTranscriptTail.mockResolvedValue(false)
    renderPalette()
    messagesTab()
    typeQuery('retina pass')
    await settle()
    expect(screen.getByText('Deploy retina pass confirmed on staging.')).toBeTruthy()
    expect(probeTranscriptTail).toHaveBeenCalled()
    expect(readTranscriptTails).not.toHaveBeenCalled()
  })

  it('never probes when no transcript instance is paired', async () => {
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[]}
        agents={[qa]}
        conversations={[conv]}
        messagesByThreadId={{ c1: [localMsg] }}
        onJumpToAgent={() => {}}
        onJumpToMessage={() => {}}
      />,
    )
    messagesTab()
    typeQuery('retina pass')
    await settle(500)
    expect(screen.getByText('Deploy retina pass confirmed on staging.')).toBeTruthy()
    // 500ms of virtual time with zero network intent — deterministic absence.
    expect(probeTranscriptTail).not.toHaveBeenCalled()
    expect(readTranscriptTails).not.toHaveBeenCalled()
  })

  it('fetches once, capped, after rapid typing settles', async () => {
    renderPalette()
    messagesTab()
    typeQuery('zeb')
    typeQuery('zebr')
    typeQuery('zebra')
    await settle()
    expect(readTranscriptTails).toHaveBeenCalledTimes(1)
    // Capped page, not a full-history pull.
    expect(readTranscriptTails).toHaveBeenCalledWith('inst-1', { limit: 300 })
    await settle(2000)
    expect(readTranscriptTails).toHaveBeenCalledTimes(1)
  })
})
