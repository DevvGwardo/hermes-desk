import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

const useBrowserJobsSupported = vi.fn()

vi.mock('../../lib/use-browser-jobs', () => ({
  useBrowserJobsSupported: (...a: unknown[]) => useBrowserJobsSupported(...(a as [])),
}))

// jsdom stubs required by the component tree (see STATE.md).
beforeAll(() => {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
})

afterEach(() => {
  cleanup()
})

const baseProps = {
  messages: [] as ChatMessage[],
  disabled: false,
  sending: false,
  threadKey: 't1',
  liveSubagents: [],
  conversationSubagents: [],
  agentName: () => 'agent',
  onSend: vi.fn(),
  onReact: vi.fn(),
  onChoice: vi.fn(),
  onOpenKanban: vi.fn(),
  onOpenPreview: vi.fn(),
  onOpenHost: vi.fn(),
  onDownloadProject: vi.fn(),
  onOpenFile: vi.fn(),
  onSaveFileToMac: vi.fn(),
  onCopyToBox: vi.fn(),
  onAttachLocalFiles: vi.fn(),
  cwd: '',
  onOpenSettings: vi.fn(),
  onOpenPlugins: vi.fn(),
  onNewAgent: vi.fn(),
  onNewConversation: vi.fn(),
  onSpawnSubagent: vi.fn(),
  onCancelSubagent: vi.fn(),
  onMessageSubagent: vi.fn(),
  agents: [],
  permissionAsk: null,
  onPermission: vi.fn(),
  parentAgentName: 'agent',
  showAgentSpeaker: false,
}

function typeSpawn(): void {
  fireEvent.change(screen.getByPlaceholderText(/message|Send|prompt/i), {
    target: { value: '/spawn ' },
  })
}

describe('ChatPanel local browser controller blocker', () => {
  it('hides the Browser suggestion and never probes a hosted instance', () => {
    useBrowserJobsSupported.mockReturnValue(false)
    render(<ChatPanel {...baseProps} />)
    expect(useBrowserJobsSupported).not.toHaveBeenCalled()
    typeSpawn()
    expect(screen.queryByText('browserUse')).toBeNull()
    // Other kinds still offered — the gate is surgical.
    expect(screen.getByText('computerUse')).toBeTruthy()
  })

  it('does not claim a hosted route fixes the local controller blockers', () => {
    useBrowserJobsSupported.mockReturnValue(true)
    render(<ChatPanel {...baseProps} />)
    typeSpawn()
    expect(screen.queryByText('browserUse')).toBeNull()
  })
})

describe('ChatPanel browser screenshot rendering (#25)', () => {
  it('keeps a screenshot ref reachable as a file without VM media', async () => {
    useBrowserJobsSupported.mockReturnValue(false)
    const shot: ChatMessage = {
      id: 'm-shot',
      threadId: 't1',
      role: 'agent',
      content: 'Browsing https://example.com/y…\nscreenshot: /opt/data/browser/jobs/j1/shot-1.png',
      createdAt: '2026-09-05T00:00:00Z',
    }
    render(<ChatPanel {...baseProps} messages={[shot]} />)
    // No VM bridge in tests: VmShot lands on its honest fallback copy,
    // which proves the ref was extracted and routed (not dropped).
    const failed = await screen.findByText(/Couldn't load this picture/)
    expect(failed.closest('[title]')?.getAttribute('title')).toBe('/opt/data/browser/jobs/j1/shot-1.png')
  })
})

describe('ChatPanel slashes Hermes commands through', () => {
  it('offers /loop without claiming the desktop runs it', () => {
    useBrowserJobsSupported.mockReturnValue(false)
    render(<ChatPanel {...baseProps} />)
    const box = screen.getByPlaceholderText(/message|Send|prompt/i)
    fireEvent.change(box, { target: { value: '/loop' } })
    // /loop is a Hermes command: the composer scaffolds the text and the
    // agent parses the interval/prompt, so the desktop only advertises it.
    expect(screen.getByText('Loop a prompt on an interval')).toBeTruthy()
  })
})
