import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AgentInfo } from '../AgentInfo'
import { listServeCronJobs } from '../../lib/hermes-rest'
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
  serveGetDetailed: vi.fn(async (path: string) =>
    path === '/api/cron/blueprints'
      ? { data: { blueprints: [{ key: 'morning-brief', title: 'Morning briefing', fields: [] }] }, status: 200 }
      : { data: null, status: 404 },
  ),
  serveSend: vi.fn(async () => ({ ok: true, data: { id: 'bp' } })),
}))

const remoteAgent: Agent = {
  id: 'a1',
  name: 'AlienNub',
  status: 'running',
  region: 'remote',
  createdAt: '2026-08-15T00:00:00Z',
  summary: 'Just an alien nub',
  persona: { title: 'Alien', description: 'x' },
}

const localAgent: Agent = { ...remoteAgent, id: 'a2', name: 'Agent 6', region: 'fsn1' }

const hostJob = {
  id: 'h1',
  name: 'cheeksbase-maintenance',
  prompt: '',
  schedule: '0 4 * * *',
  enabled: true,
  origin: 'hermes' as const,
}

const vmJob = {
  id: 'v1',
  name: 'VM Nightly',
  prompt: '',
  schedule: '0 2 * * *',
  enabled: true,
  origin: 'remote' as const,
}

beforeEach(() => {
  cleanup()
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

describe('AgentInfo routines summary', () => {

  it('counts host routines and drops VM routines for a local agent', () => {
    render(
      <AgentInfo
        agent={localAgent}
        open
        onClose={() => {}}
        onCancelSubagent={() => {}}
        onUpdateProfile={() => {}}
        routines={[hostJob, vmJob]}
      />,
    )
    expect(screen.getByTestId('agent-routines-summary').textContent).toBe('1 routine · 1 active')
  })

  it('says nothing is scheduled when the list is empty', async () => {
    vi.mocked(listServeCronJobs).mockResolvedValue([])
    render(
      <AgentInfo agent={remoteAgent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('agent-routines-summary').textContent).toBe('Nothing scheduled yet'),
    )
  })

  it('Manage opens the Routines page and + New creates one', async () => {
    vi.mocked(listServeCronJobs).mockResolvedValue([])
    const onManageRoutines = vi.fn()
    const onCreateRoutine = vi.fn()
    render(
      <AgentInfo
        agent={localAgent}
        open
        onClose={() => {}}
        onCancelSubagent={() => {}}
        onUpdateProfile={() => {}}
        onManageRoutines={onManageRoutines}
        onCreateRoutine={onCreateRoutine}
      />,
    )
    const card = screen.getByTestId('agent-routines')
    fireEvent.click(within(card).getByRole('button', { name: 'Manage' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Create Routine' }))
    expect(onManageRoutines).toHaveBeenCalledTimes(1)
    expect(onCreateRoutine).toHaveBeenCalledTimes(1)
  })
})
