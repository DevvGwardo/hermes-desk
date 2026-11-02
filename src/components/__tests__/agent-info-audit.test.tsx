import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AgentInfo } from '../AgentInfo'
import { listServeCronJobs } from '../../lib/hermes-rest'
import { clearAuditLog, appendAuditRows, type AuditRow } from '../../lib/agents/audit-log'
import type { Agent } from '../../lib/agents'
vi.mock('../../lib/hermes-rest', () => ({
  listServeCronJobs: vi.fn(),
  serveGet: vi.fn(async () => null),
  // B2 row probes these on mount for VM agents — unsupported ⇒ row stays hidden.
  probeResize: vi.fn(async () => false),
  getResizeStatus: vi.fn(async () => null),
  // AgentInfo imports these too; stubbed so a VM-agent render can't hit undefined.
  cancelResize: vi.fn(async () => true),
  scheduleResize: vi.fn(async () => true),
}))

const agent: Agent = {
  id: 'a1',
  name: 'AlienNub',
  status: 'running',
  region: 'remote',
  createdAt: '2026-08-15T00:00:00Z',
  summary: 'Just an alien nub',
  persona: { title: 'Alien', description: 'x' },
}

/** Seed through the module's real storage path (window.localStorage). */
function seedRows(rows: AuditRow[]): void {
  appendAuditRows(rows)
}

beforeEach(() => {
  cleanup()
  clearAuditLog()
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
  vi.mocked(listServeCronJobs).mockResolvedValue(null)
})

describe('AgentInfo Activity section (A5)', () => {
  it('shows an honest empty state with zero events', async () => {
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeTruthy()
    })
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy()
    // Read-only: no editor chrome beyond the empty state.
    expect(screen.queryByText('Confirm clear?')).toBeNull()
  })

  it('hides tool rows but shows workers and approvals, with no Tools filter', async () => {
    seedRows([
      {
        ts: '2026-08-22T10:00:00.000Z',
        conversationId: 'c1',
        verb: 'tool',
        target: 'web_search',
        outcome: 'completed',
        origin: 'vm',
      },
      {
        ts: '2026-08-22T10:30:00.000Z',
        conversationId: 'c1',
        verb: 'subagent',
        target: 'Scout',
        outcome: 'running',
        origin: 'vm',
      },
      {
        ts: '2026-08-22T11:00:00.000Z',
        conversationId: 'c1',
        verb: 'permission',
        target: 'rm -rf build',
        outcome: 'pending',
        origin: 'mac',
      },
    ])
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Scout')).toBeTruthy()
    })
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    // Tool rows are hidden from the timeline even though stored.
    expect(screen.queryByText('web_search')).toBeNull()
    // Humanized statuses replace the old verb·outcome + origin pills.
    expect(screen.getByText('Running…')).toBeTruthy()
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    expect(screen.queryByText('On the VM')).toBeNull()
    // Filter chips are All / Helpers / Needs you — no Tools option.
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Helpers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Needs you' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tools' })).toBeNull()

    // Filter chips narrow the timeline.
    fireEvent.click(screen.getByRole('button', { name: 'Needs you' }))
    await waitFor(() => {
      expect(screen.queryByText('Scout')).toBeNull()
    })
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.queryByText('web_search')).toBeNull()
  })

  it('uses plain-English info copy with tech details tucked away', async () => {
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    // Status is one line under the avatar, not its own card.
    await waitFor(() => {
      expect(screen.getByTestId('agent-status').textContent).toMatch(/· Helper/)
    })
    expect(screen.queryByText('Status')).toBeNull()
    // Jargon gone from the visible copy.
    expect(screen.queryByText('specialist file')).toBeNull()
    expect(screen.queryByText(/HERMES_HOME/)).toBeNull()
    expect(screen.queryByText(/delegate_task/)).toBeNull()
    // No empty boxes: Helpers only appears while one is running.
    expect(screen.queryByText('Helpers')).toBeNull()
    expect(screen.queryByText('Live subagents')).toBeNull()
    // Everything else sits under More settings.
    const more = screen.getByTestId('agent-info-more')
    expect(more.querySelector('summary')?.textContent).toMatch(/More settings/)
    expect(within(more).getByText('Chats')).toBeTruthy()
    expect(within(more).getByText('Activity')).toBeTruthy()
    expect(screen.queryByText('Connectors')).toBeNull()
    // In a browser tab Extra tools can't work, so it isn't shown at all.
    await waitFor(() => {
      expect(screen.queryByText('Extra tools')).toBeNull()
    })
    expect(screen.queryByText(/Extra tools need the desktop app/)).toBeNull()
  })

  it('lists running helpers', () => {
    render(
      <AgentInfo
        agent={agent}
        open
        onClose={() => {}}
        onCancelSubagent={() => {}}
        onUpdateProfile={() => {}}
        liveSubagents={[
          {
            id: 'h1',
            kind: 'subagent',
            title: 'Check the logs',
            status: 'running',
            createdAt: new Date().toISOString(),
          } as never,
        ]}
      />,
    )
    expect(screen.getByText('Helpers')).toBeTruthy()
    expect(screen.getByText(/Check the logs/)).toBeTruthy()
  })

  it('clear-all requires confirmation and then empties the log', async () => {
    seedRows([
      {
        ts: '2026-08-22T10:00:00.000Z',
        conversationId: 'c1',
        verb: 'subagent',
        target: 'Scout',
        outcome: 'running',
        origin: 'vm',
      },
    ])
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Scout')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByRole('button', { name: 'Confirm clear?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear?' }))
    await waitFor(() => {
      expect(screen.getByText(/Nothing here yet/)).toBeTruthy()
    })
    expect(screen.queryByText('Scout')).toBeNull()
  })

  it('survives a component remount from persisted storage', async () => {
    seedRows([
      {
        ts: '2026-08-21T09:30:00.000Z',
        conversationId: 'c1',
        verb: 'subagent',
        target: 'Scout',
        outcome: 'running',
        origin: 'mac',
      },
    ])
    const view = render(
      <AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />,
    )
    await waitFor(() => {
      expect(screen.getByText('Scout')).toBeTruthy()
    })
    act(() => view.unmount())
    // "Restart": remount reads the same localStorage envelope.
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('Scout')).toBeTruthy()
    })
    clearAuditLog()
  })
})
